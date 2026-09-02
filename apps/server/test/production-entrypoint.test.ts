import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVELOPMENT_RUNTIME_RELEASE_IDENTITY } from "@er-diagram/contracts";
import {
  openSqliteStorage,
  SQLITE_STORAGE_SCHEMA_VERSION,
  validateSqliteVolumeDatabase,
} from "@er-diagram/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  createProductionServer,
  type ProductionServerStartupError,
} from "../src/production-entrypoint.js";

const servers = new Set<Awaited<ReturnType<typeof createProductionServer>>>();
const directories = new Set<string>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
  for (const directory of directories) rmSync(directory, { force: true, recursive: true });
  directories.clear();
});

describe("packaged production entrypoint", () => {
  it("initializes a fresh schema-v2 database and serves the packaged Web application", async () => {
    const fixture = createFixture();
    const server = await createProductionServer(fixture);
    servers.add(server);

    const response = await server.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("packaged production app");
    await server.close();
    servers.delete(server);
    await expect(validateSqliteVolumeDatabase(fixture.databaseFilename)).resolves.toMatchObject({
      storageSchemaVersion: SQLITE_STORAGE_SCHEMA_VERSION,
    });
  });

  it("rejects missing Web assets before creating the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "er-diagram-production-missing-web-"));
    directories.add(directory);
    const databaseFilename = join(directory, "database.sqlite");

    await expect(
      createProductionServer({
        databaseFilename,
        staticWebRoot: join(directory, "missing"),
      }),
    ).rejects.toMatchObject({ code: "SERVER_STATIC_ASSETS_INVALID" });
    expect(existsSync(databaseFilename)).toBe(false);
  });

  it("requires explicit migration for an existing non-current storage version", async () => {
    const fixture = createFixture();
    const storage = openSqliteStorage({ filename: fixture.databaseFilename });
    storage.database.run(
      "UPDATE app_metadata SET value = '1' WHERE key = 'storage_schema_version'",
    );
    storage.close();

    await expect(createProductionServer(fixture)).rejects.toEqual(
      expect.objectContaining<Partial<ProductionServerStartupError>>({
        code: "SERVER_STORAGE_MIGRATION_REQUIRED",
      }),
    );
  });
});

function createFixture(): {
  readonly databaseFilename: string;
  readonly staticWebRoot: string;
  readonly releaseManifestFilename: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "er-diagram-production-entrypoint-"));
  directories.add(directory);
  const staticWebRoot = join(directory, "web");
  mkdirSync(staticWebRoot);
  writeFileSync(
    join(staticWebRoot, "index.html"),
    "<!doctype html><html><body>packaged production app</body></html>\n",
  );
  const releaseManifestFilename = join(directory, "release.json");
  writeFileSync(
    releaseManifestFilename,
    `${JSON.stringify(DEVELOPMENT_RUNTIME_RELEASE_IDENTITY)}\n`,
  );
  return {
    databaseFilename: join(directory, "database.sqlite"),
    staticWebRoot,
    releaseManifestFilename,
  };
}
