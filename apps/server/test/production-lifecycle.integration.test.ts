import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEVELOPMENT_RUNTIME_RELEASE_IDENTITY } from "@er-diagram/contracts";
import {
  APP_METADATA_STORAGE_SCHEMA_VERSION_KEY,
  acquireSqliteVolumeLock,
  openSqliteStorage,
  SQLITE_STORAGE_SCHEMA_VERSION,
  validateSqliteVolumeDatabase,
} from "@er-diagram/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { OperationalLogEvent, OperationalLogSink } from "../src/operational-logging.js";
import {
  DEFAULT_PRODUCTION_CONFIGURATION,
  type ProductionConfiguration,
} from "../src/production-config.js";
import {
  createProductionRuntime,
  type ProductionServerStartupError,
} from "../src/production-entrypoint.js";

const runtimes = new Set<Awaited<ReturnType<typeof createProductionRuntime>>>();
const directories = new Set<string>();

afterEach(async () => {
  await Promise.all([...runtimes].map((runtime) => runtime.shutdown("TEST_CLEANUP")));
  runtimes.clear();
  for (const directory of directories) rmSync(directory, { force: true, recursive: true });
  directories.clear();
});

describe("production SQLite lifecycle", () => {
  it("reports ready only while it owns a readable current-schema volume", async () => {
    const fixture = createFixture();
    const events: OperationalLogEvent[] = [];
    let flushes = 0;
    const sink: OperationalLogSink = {
      write: (event) => {
        events.push(event);
      },
      flush: () => {
        flushes += 1;
      },
    };
    const runtime = await createProductionRuntime({ ...fixture, operationalLogSink: sink });
    runtimes.add(runtime);

    expect(runtime.state).toBe("READY");
    await expect(
      runtime.server.inject({ method: "GET", url: "/health/ready" }),
    ).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(() => acquireSqliteVolumeLock(fixture.databaseFilename)).toThrowError(
      expect.objectContaining({ code: "SQLITE_VOLUME_LOCKED" }),
    );
    await expect(createProductionRuntime(fixture)).rejects.toMatchObject({
      code: "SERVER_STORAGE_LOCKED",
    });

    await runtime.shutdown("TEST");
    runtimes.delete(runtime);
    expect(runtime.state).toBe("STOPPED");
    const replacement = acquireSqliteVolumeLock(fixture.databaseFilename);
    replacement.release();
    expect(
      events.filter((event) => event.event === "SERVER_LIFECYCLE").map((event) => event.state),
    ).toEqual(["STARTING", "READY", "SHUTTING_DOWN", "STOPPED"]);
    expect(events.filter((event) => event.event === "SERVER_RELEASE_IDENTITY")).toEqual([
      expect.objectContaining({
        channel: "DEVELOPMENT",
        version: "development",
        sourceRevision: null,
        parserVersion: "9.1.1",
        bundleSchemaVersion: 1,
      }),
    ]);
    expect(flushes).toBe(1);
    expect(JSON.stringify(events)).not.toContain(fixture.databaseFilename);
  });

  it("fails readiness while retaining liveness when the SQLite metadata probe fails", async () => {
    const fixture = createFixture();
    const runtime = await createProductionRuntime(fixture);
    runtimes.add(runtime);
    const conflictingWriter = openSqliteStorage({ filename: fixture.databaseFilename });
    conflictingWriter.database.run(
      `UPDATE app_metadata SET value = '999' WHERE key = '${APP_METADATA_STORAGE_SCHEMA_VERSION_KEY}'`,
    );
    conflictingWriter.close();

    const readiness = await runtime.server.inject({ method: "GET", url: "/health/ready" });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.headers["cache-control"]).toBe("no-store");
    expect(readiness.headers["retry-after"]).toBe("1");
    expect(readiness.json()).toMatchObject({ code: "SERVER_NOT_READY" });
    await expect(
      runtime.server.inject({ method: "GET", url: "/health/live" }),
    ).resolves.toMatchObject({
      statusCode: 200,
    });
  });

  it("keeps older storage unchanged in MANUAL mode", async () => {
    const fixture = createFixture();
    createVersionOneDatabase(fixture.databaseFilename);

    await expect(createProductionRuntime(fixture)).rejects.toEqual(
      expect.objectContaining<Partial<ProductionServerStartupError>>({
        code: "SERVER_STORAGE_MIGRATION_REQUIRED",
      }),
    );
    expect(
      (await validateSqliteVolumeDatabase(fixture.databaseFilename)).storageSchemaVersion,
    ).toBe(1);
  });

  it("applies an explicitly backed-up supported migration before readiness", async () => {
    const fixture = createFixture();
    createVersionOneDatabase(fixture.databaseFilename);
    const backupOutput = path.join(path.dirname(fixture.databaseFilename), "pre-migration");
    const runtime = await createProductionRuntime({
      ...fixture,
      configuration: configuration({
        startupMigration: { mode: "APPLY_WITH_BACKUP", backupOutput },
      }),
    });
    runtimes.add(runtime);

    expect(runtime.state).toBe("READY");
    expect(existsSync(path.join(backupOutput, "manifest.json"))).toBe(true);
    expect(
      (await validateSqliteVolumeDatabase(fixture.databaseFilename)).storageSchemaVersion,
    ).toBe(SQLITE_STORAGE_SCHEMA_VERSION);
  });
});

function createFixture(): {
  readonly databaseFilename: string;
  readonly staticWebRoot: string;
  readonly releaseManifestFilename: string;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-production-lifecycle-"));
  directories.add(directory);
  const staticWebRoot = path.join(directory, "web");
  mkdirSync(staticWebRoot);
  writeFileSync(
    path.join(staticWebRoot, "index.html"),
    "<!doctype html><html><body>production lifecycle fixture</body></html>\n",
  );
  const releaseManifestFilename = path.join(directory, "release.json");
  writeFileSync(
    releaseManifestFilename,
    `${JSON.stringify(DEVELOPMENT_RUNTIME_RELEASE_IDENTITY)}\n`,
  );
  return {
    databaseFilename: path.join(directory, "database.sqlite"),
    staticWebRoot,
    releaseManifestFilename,
  };
}

function createVersionOneDatabase(filename: string): void {
  const storage = openSqliteStorage({ filename });
  try {
    storage.database.run("DROP TABLE visual_command_receipts");
    storage.database.run(
      `UPDATE app_metadata SET value = '1' WHERE key = '${APP_METADATA_STORAGE_SCHEMA_VERSION_KEY}'`,
    );
    storage.database.run(
      "DELETE FROM __drizzle_migrations WHERE created_at > (SELECT min(created_at) FROM __drizzle_migrations)",
    );
  } finally {
    storage.close();
  }
}

function configuration(overrides: Partial<ProductionConfiguration>): ProductionConfiguration {
  return {
    ...DEFAULT_PRODUCTION_CONFIGURATION,
    ...overrides,
    resourceLimits: DEFAULT_PRODUCTION_CONFIGURATION.resourceLimits,
  };
}
