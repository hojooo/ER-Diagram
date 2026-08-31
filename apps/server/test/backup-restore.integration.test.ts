import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  appMetadata,
  openSqliteStorage,
  projects,
  schemaRevisions,
  validateSqliteVolumeBackup,
} from "@er-diagram/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

const FIXED_NOW = "2026-08-31T01:02:03.000Z";
const PROJECT_ID = "018f0f87-7b5a-7cc0-8000-000000000001";
const REVISION_ID = "018f0f87-7b5a-7cc0-8000-000000000002";
const SOURCE_SENTINEL = "Table cli_recovery { id bigint [pk] }\n-- PRIVATE_SQL_SENTINEL";
const directories = new Set<string>();
const cliPath = path.resolve(import.meta.dirname, "../dist/volume-recovery-cli.js");

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-recovery-cli-"));
  directories.add(directory);
  return directory;
}

function createFixtureDatabase(filename: string): void {
  const sourceHash = createHash("sha256").update(SOURCE_SENTINEL, "utf8").digest("hex");
  const storage = openSqliteStorage({ filename });
  storage.transaction((tx) => {
    tx.insert(projects)
      .values({
        id: PROJECT_ID,
        name: "CLI recovery fixture",
        primaryDialect: "POSTGRESQL",
        draftSource: SOURCE_SENTINEL,
        draftHash: sourceHash,
        lastValidRevisionId: null,
        parserVersion: "9.1.1",
        schemaRevisionNo: 1,
        layoutRevisionNo: 0,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      })
      .run();
    tx.insert(schemaRevisions)
      .values({
        id: REVISION_ID,
        projectId: PROJECT_ID,
        revisionNo: 1,
        source: SOURCE_SENTINEL,
        sourceHash,
        validity: "VALID",
        origin: "SOURCE_EDIT",
        parserVersion: "9.1.1",
        diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
        createdAt: FIXED_NOW,
      })
      .run();
    tx.update(projects).set({ lastValidRevisionId: REVISION_ID }).run();
    tx.insert(appMetadata).values({ key: "cli_fixture", value: "preserved" }).run();
  });
  storage.close();
}

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
  });
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

describe("built SQLite recovery CLI", () => {
  it("drills backup, restore dry-run, apply, and close/reopen without source leakage", async () => {
    const directory = temporaryDirectory();
    const source = path.join(directory, "source.sqlite");
    const backup = path.join(directory, "backup");
    const restored = path.join(directory, "restored.sqlite");
    createFixtureDatabase(source);

    const backupRun = runCli(["backup", "--database", source, "--output", backup]);
    expect(backupRun.status, backupRun.stderr).toBe(0);
    expect(backupRun.stderr).toBe("");
    expect(backupRun.stdout).not.toContain(SOURCE_SENTINEL);
    expect((await validateSqliteVolumeBackup(backup)).manifest.inventory).toMatchObject({
      projects: 1,
      schemaRevisions: 1,
      appMetadata: 2,
    });

    const dryRun = runCli(["restore", "--backup", backup, "--database", restored]);
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(existsSync(restored)).toBe(false);
    const dryRunBody = JSON.parse(dryRun.stdout) as { plan: { planHash: string } };

    const apply = runCli([
      "restore",
      "--backup",
      backup,
      "--database",
      restored,
      "--apply",
      "--plan-hash",
      dryRunBody.plan.planHash,
    ]);
    expect(apply.status, apply.stderr).toBe(0);
    expect(apply.stdout).not.toContain(SOURCE_SENTINEL);
    const reopened = openSqliteStorage({ filename: restored });
    expect(
      reopened.database.get<{ source: string }>("SELECT draft_source AS source FROM projects"),
    ).toEqual({
      source: SOURCE_SENTINEL,
    });
    expect(
      reopened.database.get<{ value: string }>(
        "SELECT value FROM app_metadata WHERE key = 'cli_fixture'",
      ),
    ).toEqual({ value: "preserved" });
    reopened.close();
  }, 30_000);

  it("emits stable redacted errors for invalid arguments and stale plan hashes", () => {
    const directory = temporaryDirectory();
    const source = path.join(directory, "source.sqlite");
    const backup = path.join(directory, "backup");
    const target = path.join(directory, "target.sqlite");
    createFixtureDatabase(source);
    expect(runCli(["backup", "--database", source, "--output", backup]).status).toBe(0);

    const invalid = runCli(["backup", "--database", source]);
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stderr)).toMatchObject({
      error: { code: "SQLITE_VOLUME_CLI_INVALID_ARGUMENT" },
    });

    const stale = runCli([
      "restore",
      "--backup",
      backup,
      "--database",
      target,
      "--apply",
      "--plan-hash",
      "0".repeat(64),
    ]);
    expect(stale.status).toBe(1);
    expect(JSON.parse(stale.stderr)).toMatchObject({
      error: { code: "SQLITE_VOLUME_RECOVERY_PLAN_CONFLICT" },
    });
    expect(stale.stderr).not.toContain(SOURCE_SENTINEL);
    expect(stale.stderr).not.toContain(directory);
    expect(stale.stderr).not.toContain("better-sqlite3");
  }, 30_000);
});
