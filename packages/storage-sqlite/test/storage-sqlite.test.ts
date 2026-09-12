import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, describe, expect, it } from "vitest";

import {
  APP_METADATA_STORAGE_SCHEMA_VERSION_KEY,
  appMetadata,
  diagramLayouts,
  generateUuidV7,
  importArtifacts,
  openSqliteStorage,
  projects,
  SQLITE_STORAGE_SCHEMA_VERSION,
  type SqliteStorage,
  SqliteStorageError,
  schemaRevisions,
  toUtcIsoTimestamp,
  visualCommandReceipts,
} from "../src/index.js";
import { initializeSqliteStorage } from "../src/sqlite-storage.js";
import { encodeUuidV7 } from "../src/uuid-v7.js";

const PRODUCT_TABLE_NAMES = [
  "app_metadata",
  "diagram_layouts",
  "import_artifacts",
  "projects",
  "schema_revisions",
  "visual_command_receipts",
] as const;
const FIXED_NOW = "2026-08-27T01:02:03.004Z";
const HASH = "a".repeat(64);
const EXPECTED_COLUMNS = {
  app_metadata: ["key", "value"],
  diagram_layouts: [
    "project_id",
    "view_key",
    "positions_json",
    "collapsed_group_keys_json",
    "hidden_element_keys_json",
    "viewport_json",
    "detail_level",
    "base_schema_hash",
    "revision_no",
  ],
  import_artifacts: [
    "id",
    "project_id",
    "dialect",
    "original_sql",
    "original_hash",
    "generated_dbml",
    "parser_version",
    "report_json",
    "status",
    "created_at",
    "applied_at",
  ],
  projects: [
    "id",
    "name",
    "primary_dialect",
    "draft_source",
    "draft_hash",
    "last_valid_revision_id",
    "parser_version",
    "schema_revision_no",
    "layout_revision_no",
    "created_at",
    "updated_at",
  ],
  schema_revisions: [
    "id",
    "project_id",
    "revision_no",
    "source",
    "source_hash",
    "validity",
    "origin",
    "parser_version",
    "diagnostic_summary_json",
    "created_at",
  ],
  visual_command_receipts: [
    "project_id",
    "command_id",
    "command_kind",
    "command_hash",
    "expected_schema_revision_no",
    "applied_schema_revision_no",
    "applied_layout_revision_no",
    "revision_created",
    "layout_migrated",
    "created_at",
  ],
} as const;

const temporaryDirectories = new Set<string>();
const openStorages = new Set<SqliteStorage>();

function temporaryDatabasePath(name = "er-diagram.sqlite"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-storage-test-"));
  temporaryDirectories.add(directory);
  return path.join(directory, name);
}

function trackedOpen(filename: string): SqliteStorage {
  const storage = openSqliteStorage({ filename });
  openStorages.add(storage);
  return storage;
}

function trackedClose(storage: SqliteStorage): void {
  storage.close();
  openStorages.delete(storage);
}

function fixtureUuid(sequence: number, epochMs = 1_700_000_000_000): string {
  return encodeUuidV7(epochMs, new Uint8Array(10).fill(sequence));
}

function projectFixture(
  id: string,
  overrides: Partial<typeof projects.$inferInsert> = {},
): typeof projects.$inferInsert {
  return {
    id,
    name: `Project ${id.slice(-4)}`,
    primaryDialect: "POSTGRESQL",
    draftSource: "",
    draftHash: HASH,
    lastValidRevisionId: null,
    parserVersion: "9.1.1",
    schemaRevisionNo: 0,
    layoutRevisionNo: 0,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

function insertProject(
  storage: SqliteStorage,
  id: string,
  overrides: Partial<typeof projects.$inferInsert> = {},
): void {
  storage.database.insert(projects).values(projectFixture(id, overrides)).run();
}

function expectStorageError(operation: () => unknown, code: SqliteStorageError["code"]): void {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SqliteStorageError);
    expect((error as SqliteStorageError).code).toBe(code);
  }
}

afterEach(() => {
  for (const storage of openStorages) {
    storage.close();
  }
  openStorages.clear();

  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

describe("SQLite migration and connection", () => {
  it("migrates the six strict product tables and records every schema migration once", () => {
    const filename = temporaryDatabasePath();
    const first = trackedOpen(filename);

    const tables = first.database.all<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    expect(tables.map(({ name }) => name)).toEqual([
      "__drizzle_migrations",
      ...PRODUCT_TABLE_NAMES,
    ]);
    expect(
      tables
        .filter(({ name }) =>
          PRODUCT_TABLE_NAMES.includes(name as (typeof PRODUCT_TABLE_NAMES)[number]),
        )
        .every(({ sql }) => sql.trimEnd().toUpperCase().endsWith("STRICT")),
    ).toBe(true);
    for (const [tableName, expectedColumns] of Object.entries(EXPECTED_COLUMNS)) {
      const columns = first.database.all<{ name: string }>(`PRAGMA table_info("${tableName}")`);
      expect(
        columns.map(({ name }) => name),
        tableName,
      ).toEqual(expectedColumns);
    }
    const indexes = first.database.all<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
    );
    expect(indexes.map(({ name }) => name)).toEqual([
      "import_artifacts_project_created_idx",
      "schema_revisions_non_checkpoint_idx",
    ]);
    expect(
      indexes.find(({ name }) => name === "schema_revisions_non_checkpoint_idx")?.sql,
    ).toContain("WHERE \"origin\" IN ('SOURCE_EDIT', 'VISUAL_COMMAND')");
    expect(
      first.database
        .select()
        .from(appMetadata)
        .where(eq(appMetadata.key, APP_METADATA_STORAGE_SCHEMA_VERSION_KEY))
        .get(),
    ).toEqual({
      key: APP_METADATA_STORAGE_SCHEMA_VERSION_KEY,
      value: String(SQLITE_STORAGE_SCHEMA_VERSION),
    });
    expect(
      first.database.get<{ count: number }>("SELECT count(*) AS count FROM __drizzle_migrations")
        .count,
    ).toBe(3);
    const migrationsFolder = path.resolve(import.meta.dirname, "../drizzle");
    const expectedMigrations = readMigrationFiles({ migrationsFolder });
    expect(
      first.database.all<{ hash: string; created_at: number }>(
        "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at",
      ),
    ).toEqual(
      expectedMigrations.map((migration) => ({
        hash: migration.hash,
        created_at: migration.folderMillis,
      })),
    );
    expect(
      first.database
        .select()
        .from(appMetadata)
        .where(eq(appMetadata.key, "__er_diagram_write_probe__"))
        .get(),
    ).toBeUndefined();

    trackedClose(first);
    const reopened = trackedOpen(filename);
    expect(
      reopened.database.get<{ count: number }>("SELECT count(*) AS count FROM __drizzle_migrations")
        .count,
    ).toBe(3);
  });

  it("sets and reads back foreign keys, WAL, busy timeout, and database integrity", () => {
    const storage = trackedOpen(temporaryDatabasePath());

    expect(storage.database.get<{ foreign_keys: number }>("PRAGMA foreign_keys").foreign_keys).toBe(
      1,
    );
    expect(storage.database.get<{ journal_mode: string }>("PRAGMA journal_mode").journal_mode).toBe(
      "wal",
    );
    expect(storage.database.get<{ timeout: number }>("PRAGMA busy_timeout").timeout).toBe(5_000);
    expect(storage.database.get<{ quick_check: string }>("PRAGMA quick_check").quick_check).toBe(
      "ok",
    );
    expect(storage.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("upgrades a version 1 database to version 3 without changing existing product data", () => {
    const filename = temporaryDatabasePath();
    const storage = trackedOpen(filename);
    const projectId = fixtureUuid(40);
    const revisionId = fixtureUuid(41);
    const artifactId = fixtureUuid(42);
    storage.transaction((tx) => {
      tx.insert(projects).values(projectFixture(projectId)).run();
      tx.insert(schemaRevisions)
        .values({
          id: revisionId,
          projectId,
          revisionNo: 1,
          source: "Table users { id int [pk] }",
          sourceHash: HASH,
          validity: "VALID",
          origin: "SOURCE_EDIT",
          parserVersion: "9.1.1",
          diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
          createdAt: FIXED_NOW,
        })
        .run();
      tx.update(projects)
        .set({ lastValidRevisionId: revisionId, schemaRevisionNo: 1, layoutRevisionNo: 1 })
        .where(eq(projects.id, projectId))
        .run();
      tx.insert(diagramLayouts)
        .values({
          projectId,
          viewKey: "GLOBAL",
          positions: { table: { x: 1, y: 2 } },
          collapsedGroupKeys: [],
          hiddenElementKeys: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          detailLevel: "FULL",
          baseSchemaHash: HASH,
          revisionNo: 1,
        })
        .run();
      tx.insert(importArtifacts)
        .values({
          id: artifactId,
          projectId,
          dialect: "POSTGRESQL",
          originalSql: null,
          originalHash: HASH,
          generatedDbml: null,
          parserVersion: "9.1.1",
          report: { version: 1 },
          status: "FAILED",
          createdAt: FIXED_NOW,
          appliedAt: null,
        })
        .run();
    });
    trackedClose(storage);

    const versionOne = new BetterSqlite3(filename);
    versionOne.pragma("foreign_keys = ON");
    versionOne.exec("DROP TABLE visual_command_receipts");
    versionOne
      .prepare("UPDATE app_metadata SET value = '1' WHERE key = ?")
      .run(APP_METADATA_STORAGE_SCHEMA_VERSION_KEY);
    versionOne.exec(
      "DELETE FROM __drizzle_migrations WHERE created_at > (SELECT min(created_at) FROM __drizzle_migrations)",
    );
    versionOne.close();

    const upgraded = trackedOpen(filename);
    expect(
      upgraded.database
        .select()
        .from(appMetadata)
        .where(eq(appMetadata.key, APP_METADATA_STORAGE_SCHEMA_VERSION_KEY))
        .get()?.value,
    ).toBe("3");
    expect(upgraded.database.select().from(projects).all()).toHaveLength(1);
    expect(upgraded.database.select().from(schemaRevisions).all()).toHaveLength(1);
    expect(upgraded.database.select().from(diagramLayouts).all()).toHaveLength(1);
    expect(upgraded.database.select().from(importArtifacts).all()).toHaveLength(1);
    expect(upgraded.database.select().from(visualCommandReceipts).all()).toEqual([]);
    expect(
      upgraded.database.get<{ count: number }>("SELECT count(*) AS count FROM __drizzle_migrations")
        .count,
    ).toBe(3);
  });

  it("upgrades a version 2 database while preserving legacy column command receipts", () => {
    const filename = temporaryDatabasePath();
    const storage = trackedOpen(filename);
    const projectId = fixtureUuid(43);
    const commandId = fixtureUuid(44);
    insertProject(storage, projectId, { schemaRevisionNo: 1 });
    storage.database
      .insert(visualCommandReceipts)
      .values({
        projectId,
        commandId,
        commandKind: "RENAME_COLUMN",
        commandHash: HASH,
        expectedSchemaRevisionNo: 1,
        appliedSchemaRevisionNo: 1,
        appliedLayoutRevisionNo: 0,
        revisionCreated: false,
        layoutMigrated: false,
        createdAt: FIXED_NOW,
      })
      .run();
    trackedClose(storage);

    const versionTwo = new BetterSqlite3(filename);
    versionTwo
      .prepare("UPDATE app_metadata SET value = '2' WHERE key = ?")
      .run(APP_METADATA_STORAGE_SCHEMA_VERSION_KEY);
    versionTwo.exec(
      "DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)",
    );
    versionTwo.close();

    const upgraded = trackedOpen(filename);
    expect(upgraded.database.select().from(visualCommandReceipts).all()).toEqual([
      expect.objectContaining({
        projectId,
        commandId,
        commandKind: "RENAME_COLUMN",
        commandHash: HASH,
      }),
    ]);
    expect(
      upgraded.database
        .select()
        .from(appMetadata)
        .where(eq(appMetadata.key, APP_METADATA_STORAGE_SCHEMA_VERSION_KEY))
        .get()?.value,
    ).toBe("3");
  });

  it.each(["", "   ", ":memory:", "file::memory:", "file:memory?mode=memory"])(
    "rejects non-durable database path %j",
    (filename) => {
      expectStorageError(() => openSqliteStorage({ filename }), "SQLITE_INVALID_PATH");
    },
  );

  it("classifies native database open failures", () => {
    const databasePath = temporaryDatabasePath();
    expectStorageError(
      () => openSqliteStorage({ filename: path.dirname(databasePath) }),
      "SQLITE_OPEN_FAILED",
    );
  });

  it("fails closed for a read-only connection and closes it", () => {
    const filename = temporaryDatabasePath();
    trackedClose(trackedOpen(filename));
    const readonly = new BetterSqlite3(filename, { fileMustExist: true, readonly: true });

    expectStorageError(() => initializeSqliteStorage(readonly), "SQLITE_NOT_WRITABLE");
    expect(readonly.open).toBe(false);
  });

  it("classifies an invalid migration directory and closes the connection", () => {
    const filename = temporaryDatabasePath("broken.sqlite");
    const migrationDirectory = path.join(path.dirname(filename), "broken-migrations");
    mkdirSync(migrationDirectory);
    const native = new BetterSqlite3(filename);

    expectStorageError(
      () => initializeSqliteStorage(native, { migrationsFolder: migrationDirectory }),
      "SQLITE_MIGRATION_FAILED",
    );
    expect(native.open).toBe(false);
  });

  it("rejects a database created by a newer storage schema", () => {
    const filename = temporaryDatabasePath();
    const storage = trackedOpen(filename);
    storage.database
      .update(appMetadata)
      .set({ value: String(SQLITE_STORAGE_SCHEMA_VERSION + 1) })
      .where(eq(appMetadata.key, APP_METADATA_STORAGE_SCHEMA_VERSION_KEY))
      .run();
    trackedClose(storage);

    expectStorageError(() => openSqliteStorage({ filename }), "SQLITE_SCHEMA_VERSION_UNSUPPORTED");
  });
});

describe("SQLite schema invariants", () => {
  it("enforces project ownership for last-valid revisions and cascades project children", () => {
    const storage = trackedOpen(temporaryDatabasePath());
    const projectId = fixtureUuid(1);
    const otherProjectId = fixtureUuid(2);
    const revisionId = fixtureUuid(3);
    const artifactId = fixtureUuid(4);

    storage.transaction((tx) => {
      tx.insert(projects).values(projectFixture(projectId)).run();
      tx.insert(projects).values(projectFixture(otherProjectId)).run();
      tx.insert(schemaRevisions)
        .values({
          id: revisionId,
          projectId,
          revisionNo: 1,
          source: "Table 사용자 { id int [pk] }\r\n// 🚀",
          sourceHash: HASH,
          validity: "VALID",
          origin: "SOURCE_EDIT",
          parserVersion: "9.1.1",
          diagnosticSummary: { errors: 0, warnings: 0, parserVersion: "9.1.1" },
          createdAt: FIXED_NOW,
        })
        .run();
      tx.update(projects)
        .set({ lastValidRevisionId: revisionId, schemaRevisionNo: 1 })
        .where(eq(projects.id, projectId))
        .run();
      tx.insert(diagramLayouts)
        .values({
          projectId,
          viewKey: "GLOBAL",
          positions: { table: { x: 1, y: 2 } },
          collapsedGroupKeys: [],
          hiddenElementKeys: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          detailLevel: "FULL",
          baseSchemaHash: HASH,
          revisionNo: 1,
        })
        .run();
      tx.insert(importArtifacts)
        .values({
          id: artifactId,
          projectId,
          dialect: "POSTGRESQL",
          originalSql: null,
          originalHash: HASH,
          generatedDbml: null,
          parserVersion: "9.1.1",
          report: { statements: [] },
          status: "FAILED",
          createdAt: FIXED_NOW,
          appliedAt: null,
        })
        .run();
      tx.insert(visualCommandReceipts)
        .values({
          projectId,
          commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          commandKind: "CREATE_COLUMN",
          commandHash: HASH,
          expectedSchemaRevisionNo: 1,
          appliedSchemaRevisionNo: 1,
          appliedLayoutRevisionNo: 0,
          revisionCreated: false,
          layoutMigrated: false,
          createdAt: FIXED_NOW,
        })
        .run();
    });

    expect(() =>
      storage.database
        .update(projects)
        .set({ lastValidRevisionId: revisionId })
        .where(eq(projects.id, otherProjectId))
        .run(),
    ).toThrow();
    expect(() =>
      storage.database.delete(schemaRevisions).where(eq(schemaRevisions.id, revisionId)).run(),
    ).toThrow();

    storage.database.delete(projects).where(eq(projects.id, projectId)).run();
    expect(
      storage.database
        .select()
        .from(schemaRevisions)
        .where(eq(schemaRevisions.projectId, projectId))
        .all(),
    ).toEqual([]);
    expect(
      storage.database
        .select()
        .from(diagramLayouts)
        .where(eq(diagramLayouts.projectId, projectId))
        .all(),
    ).toEqual([]);
    expect(
      storage.database
        .select()
        .from(importArtifacts)
        .where(eq(importArtifacts.projectId, projectId))
        .all(),
    ).toEqual([]);
    expect(
      storage.database
        .select()
        .from(visualCommandReceipts)
        .where(eq(visualCommandReceipts.projectId, projectId))
        .all(),
    ).toEqual([]);
  });

  it("rejects invalid UUID, timestamp, enum, revision, JSON, and import state", () => {
    const storage = trackedOpen(temporaryDatabasePath());
    const projectId = fixtureUuid(5);
    insertProject(storage, projectId);

    expect(() => insertProject(storage, "not-a-uuid")).toThrow();
    expect(() => insertProject(storage, `${fixtureUuid(6).slice(0, -1)}-`)).toThrow();
    expect(() =>
      insertProject(storage, fixtureUuid(15), { createdAt: "2026-08-27 01:02:03" }),
    ).toThrow();
    expect(() =>
      storage.database.run(
        `UPDATE projects SET primary_dialect = 'SQLITE' WHERE id = '${projectId}'`,
      ),
    ).toThrow();
    expect(() =>
      storage.database.run(`UPDATE projects SET schema_revision_no = -1 WHERE id = '${projectId}'`),
    ).toThrow();

    storage.database
      .insert(diagramLayouts)
      .values({
        projectId,
        viewKey: "GLOBAL",
        positions: {},
        collapsedGroupKeys: [],
        hiddenElementKeys: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        detailLevel: "FULL",
        baseSchemaHash: HASH,
        revisionNo: 0,
      })
      .run();
    expect(() =>
      storage.database.run(
        `UPDATE diagram_layouts SET positions_json = '{' WHERE project_id = '${projectId}'`,
      ),
    ).toThrow();
    expect(() =>
      storage.database.run(
        `UPDATE diagram_layouts SET detail_level = 'UNKNOWN' WHERE project_id = '${projectId}'`,
      ),
    ).toThrow();

    const artifactId = fixtureUuid(7);
    storage.database
      .insert(importArtifacts)
      .values({
        id: artifactId,
        projectId,
        dialect: "MYSQL",
        originalSql: null,
        originalHash: HASH,
        generatedDbml: null,
        parserVersion: "9.1.1",
        report: {},
        status: "FAILED",
        createdAt: FIXED_NOW,
        appliedAt: null,
      })
      .run();
    expect(() =>
      storage.database.run(
        `UPDATE import_artifacts SET status = 'PREVIEWED' WHERE id = '${artifactId}'`,
      ),
    ).toThrow();
    expect(() =>
      storage.database.run(
        `UPDATE import_artifacts SET report_json = '{' WHERE id = '${artifactId}'`,
      ),
    ).toThrow();
    expect(() =>
      storage.database.run(
        `UPDATE import_artifacts SET generated_dbml = '', status = 'APPLIED' WHERE id = '${artifactId}'`,
      ),
    ).toThrow();
  });

  it("rejects orphan rows", () => {
    const storage = trackedOpen(temporaryDatabasePath());
    const missingProjectId = fixtureUuid(8);

    expect(() =>
      storage.database
        .insert(schemaRevisions)
        .values({
          id: fixtureUuid(9),
          projectId: missingProjectId,
          revisionNo: 1,
          source: "",
          sourceHash: HASH,
          validity: "INVALID",
          origin: "SOURCE_EDIT",
          parserVersion: "9.1.1",
          diagnosticSummary: { errors: 1 },
          createdAt: FIXED_NOW,
        })
        .run(),
    ).toThrow();
  });
});

describe("SQLite transactions and restart recovery", () => {
  it("commits synchronous work and rolls back thrown and asynchronous operations", () => {
    const storage = trackedOpen(temporaryDatabasePath());
    const committedId = fixtureUuid(10);
    const rolledBackId = fixtureUuid(11);
    const asyncId = fixtureUuid(12);

    storage.transaction((tx) => tx.insert(projects).values(projectFixture(committedId)).run());
    expect(() =>
      storage.transaction((tx) => {
        tx.insert(projects).values(projectFixture(rolledBackId)).run();
        throw new Error("rollback");
      }),
    ).toThrowError("rollback");
    expectStorageError(
      () =>
        storage.transaction(async (tx) => {
          tx.insert(projects).values(projectFixture(asyncId)).run();
        }),
      "SQLITE_ASYNC_TRANSACTION_UNSUPPORTED",
    );

    expect(storage.database.select({ id: projects.id }).from(projects).all()).toEqual([
      { id: committedId },
    ]);
  });

  it("acquires the writer lock when the transaction begins", () => {
    const filename = temporaryDatabasePath();
    const first = trackedOpen(filename);
    const second = trackedOpen(filename);
    second.database.run("PRAGMA busy_timeout = 1");

    first.transaction(() => {
      expect(() => second.transaction(() => "unused")).toThrow();
    });
    expect(second.transaction(() => "available")).toBe("available");
  });

  it("recovers canonical source and sidecars byte-for-byte after restart", () => {
    const filename = temporaryDatabasePath();
    const projectId = fixtureUuid(13);
    const revisionId = fixtureUuid(14);
    const source = "Table 사용자 {\r\n  id int [pk, note: '🚀']\r\n}\r\n";
    const storage = trackedOpen(filename);

    storage.transaction((tx) => {
      tx.insert(projects)
        .values({
          id: projectId,
          name: "Unicode project 🚀",
          primaryDialect: "MYSQL",
          draftSource: source,
          draftHash: HASH,
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
          id: revisionId,
          projectId,
          revisionNo: 1,
          source,
          sourceHash: HASH,
          validity: "VALID",
          origin: "SOURCE_EDIT",
          parserVersion: "9.1.1",
          diagnosticSummary: { errors: 0, warnings: 0 },
          createdAt: FIXED_NOW,
        })
        .run();
      tx.update(projects)
        .set({ lastValidRevisionId: revisionId })
        .where(eq(projects.id, projectId))
        .run();
    });
    trackedClose(storage);

    const reopened = trackedOpen(filename);
    expect(
      reopened.database.select().from(projects).where(eq(projects.id, projectId)).get(),
    ).toMatchObject({ draftSource: source, lastValidRevisionId: revisionId });
    expect(
      reopened.database
        .select()
        .from(schemaRevisions)
        .where(eq(schemaRevisions.id, revisionId))
        .get(),
    ).toMatchObject({ source });
  });
});

describe("UUIDv7 and UTC timestamp adapters", () => {
  it("encodes the RFC UUIDv7 example deterministically", () => {
    expect(
      encodeUuidV7(
        0x017f_22e2_79b0,
        Uint8Array.from([0x0c, 0xc3, 0x18, 0xc4, 0xdc, 0x0c, 0x0c, 0x07, 0x39, 0x8f]),
      ),
    ).toBe("017f22e2-79b0-7cc3-98c4-dc0c0c07398f");
  });

  it("generates lowercase UUIDv7 values with the current millisecond prefix", () => {
    const before = Date.now();
    const value = generateUuidV7();
    const after = Date.now();
    const timestamp = Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16);

    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it("sorts values from different milliseconds and rejects invalid encoder input", () => {
    const random = new Uint8Array(10);
    expect(encodeUuidV7(1_000, random) < encodeUuidV7(1_001, random)).toBe(true);
    expect(() => encodeUuidV7(-1, random)).toThrow();
    expect(() => encodeUuidV7(1, new Uint8Array(9))).toThrow();
  });

  it("formats canonical UTC timestamps and rejects unsupported epoch values", () => {
    expect(toUtcIsoTimestamp(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(toUtcIsoTimestamp(Date.UTC(2026, 7, 27, 1, 2, 3, 4))).toBe(FIXED_NOW);
    expect(() => toUtcIsoTimestamp(Number.NaN)).toThrow();
    expect(() => toUtcIsoTimestamp(1.5)).toThrow();
    expect(() => toUtcIsoTimestamp(Date.UTC(10_000, 0, 1))).toThrow();
  });
});
