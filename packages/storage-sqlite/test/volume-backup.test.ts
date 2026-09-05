import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { createSqlImportApplication } from "@er-diagram/core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  APP_METADATA_STORAGE_SCHEMA_VERSION_KEY,
  applySqliteVolumeMigration,
  applySqliteVolumeRestore,
  appMetadata,
  canonicalSqliteVolumeJsonFile,
  createSqliteLayoutRepository,
  createSqliteSqlImportRepository,
  createSqliteVisualCommandRepository,
  createSqliteVolumeBackup,
  diagramLayouts,
  generateUuidV7,
  openSqliteStorage,
  projects,
  planSqliteVolumeMigration,
  planSqliteVolumeRestore,
  schemaRevisions,
  type SqliteStorage,
  SqliteVolumeRecoveryError,
  validateSqliteVolumeBackup,
  validateSqliteVolumeDatabase,
  visualCommandReceipts,
  toUtcIsoTimestamp,
} from "../src/index.js";

const FIXED_NOW = "2026-08-31T01:02:03.000Z";
const PROJECT_ID = "018f0f87-7b5a-7cc0-8000-000000000001";
const REVISION_ID = "018f0f87-7b5a-7cc0-8000-000000000002";
const COMMAND_ID = "018f0f87-7b5a-4cc0-8000-000000000003";
const SOURCE = 'Table "users 🚀" {\r\n  id bigint [pk]\r\n}\r\n';
const directories = new Set<string>();
const storages = new Set<SqliteStorage>();

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-volume-test-"));
  directories.add(directory);
  return directory;
}

function createPopulatedDatabase(
  filename: string,
  options: { source?: string; name?: string } = {},
): SqliteStorage {
  const source = options.source ?? SOURCE;
  const sourceHash = sha256(source);
  const storage = openSqliteStorage({ filename });
  storages.add(storage);
  storage.transaction((tx) => {
    tx.insert(projects)
      .values({
        id: PROJECT_ID,
        name: options.name ?? "Recovery fixture",
        primaryDialect: "POSTGRESQL",
        draftSource: source,
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
        source,
        sourceHash,
        validity: "VALID",
        origin: "SOURCE_EDIT",
        parserVersion: "9.1.1",
        diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
        createdAt: FIXED_NOW,
      })
      .run();
    tx.update(projects)
      .set({ lastValidRevisionId: REVISION_ID })
      .where(eq(projects.id, PROJECT_ID))
      .run();
    tx.insert(visualCommandReceipts)
      .values({
        projectId: PROJECT_ID,
        commandId: COMMAND_ID,
        commandKind: "UPDATE_TABLE",
        commandHash: "a".repeat(64),
        expectedSchemaRevisionNo: 1,
        appliedSchemaRevisionNo: 1,
        appliedLayoutRevisionNo: 0,
        revisionCreated: false,
        layoutMigrated: false,
        createdAt: FIXED_NOW,
      })
      .run();
    tx.insert(appMetadata).values({ key: "operator_fixture", value: "preserve-me" }).run();
  });
  return storage;
}

afterEach(() => {
  for (const storage of storages) storage.close();
  storages.clear();
  for (const directory of directories) rmSync(directory, { force: true, recursive: true });
  directories.clear();
});

describe("SQLite whole-volume backup", () => {
  it("creates a private online WAL snapshot and validates its exact inventory", async () => {
    const directory = temporaryDirectory();
    const source = path.join(directory, "source.sqlite");
    createPopulatedDatabase(source);
    const output = path.join(directory, "backup");

    const result = await createSqliteVolumeBackup({
      database: source,
      output,
      now: () => new Date(FIXED_NOW),
    });
    const validated = await validateSqliteVolumeBackup(output);

    expect(result.manifest).toEqual(validated.manifest);
    expect(validated.manifest.inventory).toEqual({
      projects: 1,
      schemaRevisions: 1,
      diagramLayouts: 0,
      importArtifacts: 0,
      visualCommandReceipts: 1,
      appMetadata: 2,
      drizzleMigrations: 3,
    });
    expect(lstatSync(output).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(output, "database.sqlite")).mode & 0o777).toBe(0o600);
    expect(lstatSync(path.join(output, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(output, "manifest.json"), "utf8")).toBe(
      canonicalSqliteVolumeJsonFile(result.manifest),
    );

    const backup = new BetterSqlite3(path.join(output, "database.sqlite"), {
      readonly: true,
    });
    expect(
      backup.prepare("SELECT draft_source AS source FROM projects").get() as { source: string },
    ).toEqual({ source: SOURCE });
    expect(
      backup.prepare("SELECT value FROM app_metadata WHERE key = 'operator_fixture'").get(),
    ).toEqual({ value: "preserve-me" });
    backup.close();
  });

  it("rejects tampered manifests, databases and unexpected directory entries", async () => {
    const directory = temporaryDirectory();
    const source = path.join(directory, "source.sqlite");
    createPopulatedDatabase(source);

    const extra = path.join(directory, "extra-backup");
    await createSqliteVolumeBackup({ database: source, output: extra });
    writeFileSync(path.join(extra, "unexpected"), "x", { mode: 0o600 });
    await expect(validateSqliteVolumeBackup(extra)).rejects.toMatchObject({
      code: "SQLITE_VOLUME_BACKUP_INVALID",
    });

    const manifest = path.join(directory, "manifest-backup");
    await createSqliteVolumeBackup({ database: source, output: manifest });
    const manifestPath = path.join(manifest, "manifest.json");
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, canonicalSqliteVolumeJsonFile({ ...parsed, createdAt: FIXED_NOW }));
    chmodSync(manifestPath, 0o600);
    await expect(validateSqliteVolumeBackup(manifest)).rejects.toMatchObject({
      code: "SQLITE_VOLUME_CHECKSUM_MISMATCH",
    });

    const database = path.join(directory, "database-backup");
    await createSqliteVolumeBackup({ database: source, output: database });
    writeFileSync(path.join(database, "database.sqlite"), "corrupt", { flag: "a" });
    await expect(validateSqliteVolumeBackup(database)).rejects.toBeInstanceOf(
      SqliteVolumeRecoveryError,
    );
  });

  it("refuses to overwrite an existing output directory", async () => {
    const directory = temporaryDirectory();
    const source = path.join(directory, "source.sqlite");
    createPopulatedDatabase(source);
    const output = path.join(directory, "backup");
    await createSqliteVolumeBackup({ database: source, output });
    await expect(createSqliteVolumeBackup({ database: source, output })).rejects.toMatchObject({
      code: "SQLITE_VOLUME_DESTINATION_EXISTS",
    });
  });

  it("rejects hard-linked and symlinked backup entries", async () => {
    const directory = temporaryDirectory();
    const source = path.join(directory, "source.sqlite");
    createPopulatedDatabase(source);

    const hardlinked = path.join(directory, "hardlinked-backup");
    await createSqliteVolumeBackup({ database: source, output: hardlinked });
    linkSync(path.join(hardlinked, "database.sqlite"), path.join(directory, "database-alias"));
    await expect(validateSqliteVolumeBackup(hardlinked)).rejects.toMatchObject({
      code: "SQLITE_VOLUME_INVALID_PATH",
    });

    const symlinked = path.join(directory, "symlinked-backup");
    await createSqliteVolumeBackup({ database: source, output: symlinked });
    const originalManifest = path.join(directory, "real-manifest.json");
    renameSync(path.join(symlinked, "manifest.json"), originalManifest);
    symlinkSync(originalManifest, path.join(symlinked, "manifest.json"));
    await expect(validateSqliteVolumeBackup(symlinked)).rejects.toMatchObject({
      code: "SQLITE_VOLUME_INVALID_PATH",
    });
  });

  it("preserves a legacy source larger than the interactive source limit", async () => {
    const directory = temporaryDirectory();
    const sourceValue = `Table oversized { note varchar }\n${"x".repeat(5 * 1024 * 1024 + 1)}`;
    const sourcePath = path.join(directory, "legacy-large.sqlite");
    const storage = createPopulatedDatabase(sourcePath, { source: sourceValue });
    storage.close();
    storages.delete(storage);
    const output = path.join(directory, "large-backup");
    await createSqliteVolumeBackup({ database: sourcePath, output });
    const backup = new BetterSqlite3(path.join(output, "database.sqlite"), { readonly: true });
    expect(
      (backup.prepare("SELECT draft_source AS source FROM projects").get() as { source: string })
        .source,
    ).toBe(sourceValue);
    backup.close();
  }, 30_000);
});

describe("SQLite whole-volume restore and migration", () => {
  it("preserves all six product tables, retained SQL, and custom metadata exactly", async () => {
    const directory = temporaryDirectory();
    const databasePath = path.join(directory, "complete.sqlite");
    const storage = openSqliteStorage({ filename: databasePath });
    storages.add(storage);
    let epoch = Date.parse(FIXED_NOW);
    const imports = createSqlImportApplication({
      persistence: createSqliteSqlImportRepository(storage),
      generateId: generateUuidV7,
      now: () => toUtcIsoTimestamp(epoch++),
    });
    const retainedSql = "CREATE TABLE retained_secret (id bigint PRIMARY KEY);";
    const preview = success(
      await imports.previewStandalone({
        dialect: "POSTGRESQL",
        source: retainedSql,
        originalSqlRetention: "RETAIN",
      }),
    );
    const created = success(
      await imports.createProjectFromPreview({
        name: "Complete recovery",
        primaryDialect: "POSTGRESQL",
        source: retainedSql,
        previewHash: preview.previewHash,
        originalSqlRetention: "RETAIN",
      }),
    );
    const projectId = created.state.project.id;
    const commandId = "018f0f87-7b5a-4cc0-8000-000000000099";
    storage.transaction((tx) => {
      tx.update(projects).set({ layoutRevisionNo: 1 }).where(eq(projects.id, projectId)).run();
      tx.insert(diagramLayouts)
        .values({
          projectId,
          viewKey: "GLOBAL",
          positions: {
            'table:["public","retained_secret"]': {
              x: 10,
              y: 20,
              width: 360,
              height: 224,
            },
          },
          collapsedGroupKeys: [],
          hiddenElementKeys: [],
          viewport: { x: 1, y: 2, zoom: 0.75 },
          detailLevel: "FULL",
          baseSchemaHash: created.state.project.draftHash,
          revisionNo: 1,
        })
        .run();
      tx.insert(visualCommandReceipts)
        .values({
          projectId,
          commandId,
          commandKind: "UPDATE_TABLE",
          commandHash: "b".repeat(64),
          expectedSchemaRevisionNo: 1,
          appliedSchemaRevisionNo: 1,
          appliedLayoutRevisionNo: 1,
          revisionCreated: false,
          layoutMigrated: false,
          createdAt: FIXED_NOW,
        })
        .run();
      tx.insert(appMetadata).values({ key: "complete_fixture", value: "exact" }).run();
    });
    storage.close();
    storages.delete(storage);

    const backup = path.join(directory, "complete-backup");
    const target = path.join(directory, "complete-restored.sqlite");
    const backupResult = await createSqliteVolumeBackup({ database: databasePath, output: backup });
    expect(backupResult.manifest.inventory).toEqual({
      projects: 1,
      schemaRevisions: 1,
      diagramLayouts: 1,
      importArtifacts: 1,
      visualCommandReceipts: 1,
      appMetadata: 2,
      drizzleMigrations: 3,
    });
    const plan = await planSqliteVolumeRestore({ backup, database: target });
    await applySqliteVolumeRestore({ backup, database: target, planHash: plan.planHash });

    const restored = openSqliteStorage({ filename: target });
    expect(
      createSqliteSqlImportRepository(restored).getImportArtifact(projectId, created.artifactId),
    ).toMatchObject({ originalSql: retainedSql, status: "APPLIED" });
    expect(createSqliteLayoutRepository(restored).getLayout(projectId, "GLOBAL")).toMatchObject({
      revisionNo: 1,
      viewport: { x: 1, y: 2, zoom: 0.75 },
      positions: {
        'table:["public","retained_secret"]': { x: 10, y: 20, width: 360, height: 224 },
      },
    });
    expect(
      createSqliteVisualCommandRepository(restored).getVisualCommandReceipt(projectId, commandId),
    ).toMatchObject({ commandHash: "b".repeat(64), appliedLayoutRevisionNo: 1 });
    expect(
      restored.database.get<{ value: string }>(
        "SELECT value FROM app_metadata WHERE key = 'complete_fixture'",
      ),
    ).toEqual({ value: "exact" });
    restored.close();
  }, 30_000);

  it("requires a dry-run hash and atomically replaces an existing target after a safety backup", async () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, "source.sqlite");
    const source = createPopulatedDatabase(sourcePath);
    source.close();
    storages.delete(source);
    const backup = path.join(directory, "source-backup");
    await createSqliteVolumeBackup({ database: sourcePath, output: backup });

    const targetPath = path.join(directory, "target.sqlite");
    const target = openSqliteStorage({ filename: targetPath });
    target.close();
    const plan = await planSqliteVolumeRestore({ backup, database: targetPath });
    const safetyBackupOutput = path.join(directory, "target-safety");

    await expect(
      applySqliteVolumeRestore({
        backup,
        database: targetPath,
        planHash: "0".repeat(64),
        safetyBackupOutput,
      }),
    ).rejects.toMatchObject({ code: "SQLITE_VOLUME_RECOVERY_PLAN_CONFLICT" });

    const result = await applySqliteVolumeRestore({
      backup,
      database: targetPath,
      planHash: plan.planHash,
      safetyBackupOutput,
    });
    expect(result.applied).toBe(true);
    expect(result.safetyBackup?.inventory.projects).toBe(0);
    const restored = await validateSqliteVolumeBackup(backup);
    const targetDatabase = new BetterSqlite3(targetPath, { readonly: true });
    expect(targetDatabase.prepare("SELECT draft_source AS source FROM projects").get()).toEqual({
      source: SOURCE,
    });
    expect(
      targetDatabase.prepare("SELECT count(*) AS count FROM visual_command_receipts").get(),
    ).toEqual({ count: 1 });
    targetDatabase.close();
    expect(restored.manifest.database.sha256).toBe(plan.candidateDatabaseSha256);
    await expect(validateSqliteVolumeBackup(safetyBackupOutput)).resolves.toBeDefined();
  });

  it("restores into a new target and rejects a target created after dry-run", async () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, "source.sqlite");
    const source = createPopulatedDatabase(sourcePath);
    source.close();
    storages.delete(source);
    const backup = path.join(directory, "backup");
    await createSqliteVolumeBackup({ database: sourcePath, output: backup });

    const newTarget = path.join(directory, "new.sqlite");
    const newPlan = await planSqliteVolumeRestore({ backup, database: newTarget });
    await applySqliteVolumeRestore({
      backup,
      database: newTarget,
      planHash: newPlan.planHash,
    });
    expect((await validateSqliteVolumeBackup(backup)).manifest.inventory.projects).toBe(1);
    const reopenedNewTarget = new BetterSqlite3(newTarget, { readonly: true });
    expect(reopenedNewTarget.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({
      count: 1,
    });
    reopenedNewTarget.close();

    const staleTarget = path.join(directory, "stale.sqlite");
    const stalePlan = await planSqliteVolumeRestore({ backup, database: staleTarget });
    const created = openSqliteStorage({ filename: staleTarget });
    created.close();
    await expect(
      applySqliteVolumeRestore({
        backup,
        database: staleTarget,
        planHash: stalePlan.planHash,
        safetyBackupOutput: path.join(directory, "stale-safety"),
      }),
    ).rejects.toMatchObject({ code: "SQLITE_VOLUME_RECOVERY_PLAN_CONFLICT" });
  });

  it("stages a version 1 database migration and preserves the pre-migration backup", async () => {
    const directory = temporaryDirectory();
    const databasePath = path.join(directory, "legacy.sqlite");
    const storage = createPopulatedDatabase(databasePath);
    storage.close();
    storages.delete(storage);
    const legacy = new BetterSqlite3(databasePath);
    legacy.pragma("foreign_keys = ON");
    legacy.exec("DROP TABLE visual_command_receipts");
    legacy
      .prepare("UPDATE app_metadata SET value = '1' WHERE key = ?")
      .run(APP_METADATA_STORAGE_SCHEMA_VERSION_KEY);
    legacy.exec(
      "DELETE FROM __drizzle_migrations WHERE created_at > (SELECT min(created_at) FROM __drizzle_migrations)",
    );
    legacy.close();
    const backupOutput = path.join(directory, "pre-migration");

    const plan = await planSqliteVolumeMigration({
      database: databasePath,
      backupOutput,
    });
    expect(plan.requiresMigration).toBe(true);
    expect(
      (await validateSqliteVolumeBackup(backupOutput)).manifest.database.storageSchemaVersion,
    ).toBe(1);

    const result = await applySqliteVolumeMigration({
      database: databasePath,
      backupOutput,
      planHash: plan.planHash,
    });
    expect(result.applied).toBe(true);
    const reopened = openSqliteStorage({ filename: databasePath });
    expect(
      reopened.database.get<{ value: string }>(
        `SELECT value FROM app_metadata WHERE key = '${APP_METADATA_STORAGE_SCHEMA_VERSION_KEY}'`,
      ).value,
    ).toBe("3");
    expect(
      reopened.database.get<{ count: number }>(
        "SELECT count(*) AS count FROM visual_command_receipts",
      ).count,
    ).toBe(0);
    reopened.close();
  });

  it("restores a version 2 backup through the staged version 3 migration without rewriting legacy receipts", async () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, "version-two.sqlite");
    const storage = createPopulatedDatabase(sourcePath);
    storage.close();
    storages.delete(storage);

    const versionTwo = new BetterSqlite3(sourcePath);
    versionTwo.prepare("UPDATE visual_command_receipts SET command_kind = 'RENAME_COLUMN'").run();
    versionTwo
      .prepare("UPDATE app_metadata SET value = '2' WHERE key = ?")
      .run(APP_METADATA_STORAGE_SCHEMA_VERSION_KEY);
    versionTwo.exec(
      "DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)",
    );
    versionTwo.close();

    const backup = path.join(directory, "version-two-backup");
    const backupResult = await createSqliteVolumeBackup({ database: sourcePath, output: backup });
    expect(backupResult.manifest.database.storageSchemaVersion).toBe(2);
    expect(backupResult.manifest.inventory.drizzleMigrations).toBe(2);

    const target = path.join(directory, "restored.sqlite");
    const plan = await planSqliteVolumeRestore({ backup, database: target });
    expect(plan).toMatchObject({
      sourceStorageSchemaVersion: 2,
      resultStorageSchemaVersion: 3,
      requiresMigration: true,
    });
    await applySqliteVolumeRestore({ backup, database: target, planHash: plan.planHash });

    const restored = openSqliteStorage({ filename: target });
    expect(
      restored.database
        .select()
        .from(visualCommandReceipts)
        .where(eq(visualCommandReceipts.commandId, COMMAND_ID))
        .get(),
    ).toMatchObject({
      commandId: COMMAND_ID,
      commandKind: "RENAME_COLUMN",
      commandHash: "a".repeat(64),
    });
    restored.close();
  });

  it("returns a no-op migration plan for current storage without creating a backup", async () => {
    const directory = temporaryDirectory();
    const databasePath = path.join(directory, "current.sqlite");
    const storage = createPopulatedDatabase(databasePath);
    storage.close();
    storages.delete(storage);
    const backupOutput = path.join(directory, "unused-backup");
    const plan = await planSqliteVolumeMigration({ database: databasePath, backupOutput });
    expect(plan.requiresMigration).toBe(false);
    expect(lstatSync(directory).isDirectory()).toBe(true);
    expect(() => lstatSync(backupOutput)).toThrow();
    await expect(
      applySqliteVolumeMigration({
        database: databasePath,
        backupOutput,
        planHash: plan.planHash,
      }),
    ).resolves.toMatchObject({ applied: false });
  });

  it("blocks apply while the target has an active writer", async () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, "source.sqlite");
    const source = createPopulatedDatabase(sourcePath);
    source.close();
    storages.delete(source);
    const backup = path.join(directory, "backup");
    await createSqliteVolumeBackup({ database: sourcePath, output: backup });
    const targetPath = path.join(directory, "target.sqlite");
    const target = openSqliteStorage({ filename: targetPath });
    target.close();
    const plan = await planSqliteVolumeRestore({ backup, database: targetPath });
    const locker = new BetterSqlite3(targetPath);
    locker.exec("BEGIN IMMEDIATE");
    try {
      await expect(
        applySqliteVolumeRestore({
          backup,
          database: targetPath,
          planHash: plan.planHash,
          safetyBackupOutput: path.join(directory, "busy-safety"),
        }),
      ).rejects.toMatchObject({ code: "SQLITE_VOLUME_TARGET_BUSY" });
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
  });

  it("fails closed for future versions and non-prefix migration history", async () => {
    const directory = temporaryDirectory();
    const futurePath = path.join(directory, "future.sqlite");
    const futureStorage = createPopulatedDatabase(futurePath);
    futureStorage.close();
    storages.delete(futureStorage);
    const future = new BetterSqlite3(futurePath);
    future
      .prepare("UPDATE app_metadata SET value = '4' WHERE key = ?")
      .run(APP_METADATA_STORAGE_SCHEMA_VERSION_KEY);
    future.close();
    await expect(validateSqliteVolumeDatabase(futurePath)).rejects.toMatchObject({
      code: "SQLITE_VOLUME_SCHEMA_UNSUPPORTED",
    });

    const divergedPath = path.join(directory, "diverged.sqlite");
    const divergedStorage = createPopulatedDatabase(divergedPath);
    divergedStorage.close();
    storages.delete(divergedStorage);
    const diverged = new BetterSqlite3(divergedPath);
    diverged
      .prepare(
        "UPDATE __drizzle_migrations SET hash = ? WHERE created_at = (SELECT min(created_at) FROM __drizzle_migrations)",
      )
      .run("c".repeat(64));
    diverged.close();
    await expect(validateSqliteVolumeDatabase(divergedPath)).rejects.toMatchObject({
      code: "SQLITE_VOLUME_SCHEMA_UNSUPPORTED",
    });
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function success<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error("Expected successful fixture application result.");
  return result.value;
}
