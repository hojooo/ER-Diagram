import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createLayoutApplication,
  createProjectApplication,
  createVisualCommandApplication,
  type VisualCommandApplicationResult,
  VisualCommandPersistenceInvariantError,
} from "@er-diagram/core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSqliteLayoutRepository,
  createSqliteProjectRepository,
  createSqliteVisualCommandRepository,
  diagramLayouts,
  generateUuidV7,
  openSqliteStorage,
  projects,
  type SqliteStorage,
  schemaRevisions,
  visualCommandReceipts,
} from "../src/index.js";

const VALID_SOURCE = "Table users {\n  id int [pk]\n}\n";
const CHANGED_SOURCE = "Table users {\n  id int [pk]\n  email varchar\n}\n";
const TABLE_KEY = 'table:["public","users"]';
const RENAMED_TABLE_KEY = 'table:["public","accounts"]';
const BEFORE_HASH = "a".repeat(64);
const AFTER_HASH = "b".repeat(64);
const COMMAND_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const directories = new Set<string>();
const storages = new Set<SqliteStorage>();

afterEach(() => {
  for (const storage of storages) storage.close();
  storages.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function databasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-visual-command-"));
  directories.add(directory);
  return path.join(directory, "storage.sqlite");
}

function open(filename: string): SqliteStorage {
  const storage = openSqliteStorage({ filename });
  storages.add(storage);
  return storage;
}

function close(storage: SqliteStorage): void {
  storage.close();
  storages.delete(storage);
}

function clock() {
  let epoch = Date.parse("2026-08-30T01:02:03.000Z");
  return () => new Date(epoch++).toISOString();
}

async function createProject(storage: SqliteStorage) {
  const application = createProjectApplication({
    persistence: createSqliteProjectRepository(storage),
    generateId: generateUuidV7,
    now: clock(),
  });
  const result = await application.createProject({
    name: "Visual schema",
    primaryDialect: "POSTGRESQL",
    source: VALID_SOURCE,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value.state;
}

function createColumnCommand(expectedSchemaRevisionNo = 1, commandId = COMMAND_ID) {
  return {
    commandId,
    expectedSchemaRevisionNo,
    kind: "CREATE_COLUMN" as const,
    targetTableKey: TABLE_KEY,
    column: {
      name: "email",
      type: "varchar",
      primaryKey: false,
      unique: false,
      notNull: false,
      default: null,
      increment: false,
      note: null,
    },
  };
}

function renameTableCommand(expectedSchemaRevisionNo = 1, commandId = COMMAND_ID) {
  return {
    commandId,
    expectedSchemaRevisionNo,
    kind: "RENAME_TABLE" as const,
    targetTableKey: TABLE_KEY,
    newName: "accounts",
  };
}

function changedTransform(kind: "CREATE_COLUMN" | "RENAME_TABLE") {
  if (kind === "RENAME_TABLE") {
    return {
      ok: true as const,
      changed: true,
      source: VALID_SOURCE.replace("users", "accounts"),
      beforeSchemaHash: BEFORE_HASH,
      afterSchemaHash: AFTER_HASH,
      semanticDiff: {
        changes: [
          {
            operation: "DELETE" as const,
            elementKind: "table" as const,
            key: TABLE_KEY,
            parentKey: null,
          },
          {
            operation: "ADD" as const,
            elementKind: "table" as const,
            key: RENAMED_TABLE_KEY,
            parentKey: null,
          },
        ],
        renameCandidates: [
          {
            elementKind: "table" as const,
            beforeKey: TABLE_KEY,
            afterKey: RENAMED_TABLE_KEY,
            beforeParentKey: null,
            afterParentKey: null,
            confidence: "HIGH" as const,
            reason: "UNIQUE_EXACT_STRUCTURE" as const,
          },
        ],
      },
      diagnostics: [],
    };
  }
  return {
    ok: true as const,
    changed: true,
    source: CHANGED_SOURCE,
    beforeSchemaHash: BEFORE_HASH,
    afterSchemaHash: AFTER_HASH,
    semanticDiff: {
      changes: [
        {
          operation: "ADD" as const,
          elementKind: "column" as const,
          key: 'column:["public","users","email"]',
          parentKey: TABLE_KEY,
        },
      ],
      renameCandidates: [],
    },
    diagnostics: [],
  };
}

function visualApplication(storage: SqliteStorage, transform = changedTransform("CREATE_COLUMN")) {
  return createVisualCommandApplication({
    persistence: createSqliteVisualCommandRepository(storage),
    transform: async () => transform,
    generateId: generateUuidV7,
    now: clock(),
  });
}

function success<T>(result: VisualCommandApplicationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe("SQLite visual command repository", () => {
  it("persists receipts and replays them after close and reopen", async () => {
    const filename = databasePath();
    const first = open(filename);
    const created = await createProject(first);
    const application = visualApplication(first);

    const applied = success(
      await application.apply({
        projectId: created.project.id,
        command: createColumnCommand(),
      }),
    );
    expect(applied).toMatchObject({ revisionCreated: true, replayed: false });
    close(first);

    const reopened = open(filename);
    const replayed = success(
      await visualApplication(reopened).apply({
        projectId: created.project.id,
        command: createColumnCommand(),
      }),
    );
    expect(replayed).toMatchObject({
      replayed: true,
      revisionCreated: true,
      appliedSchemaRevisionNo: 2,
      state: { project: { schemaRevisionNo: 2 } },
    });
    expect(reopened.database.select().from(visualCommandReceipts).all()).toHaveLength(1);
  });

  it("serializes stale writes and command replay across two connections", async () => {
    const filename = databasePath();
    const first = open(filename);
    const created = await createProject(first);
    const second = open(filename);
    success(
      await visualApplication(first).apply({
        projectId: created.project.id,
        command: createColumnCommand(),
      }),
    );

    const stale = await visualApplication(second).apply({
      projectId: created.project.id,
      command: createColumnCommand(1, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "VISUAL_COMMAND_SCHEMA_REVISION_CONFLICT", currentSchemaRevisionNo: 2 },
    });

    const replay = success(
      await visualApplication(second).apply({
        projectId: created.project.id,
        command: createColumnCommand(),
      }),
    );
    expect(replay.replayed).toBe(true);
  });

  it("migrates layout keys atomically and keeps stale keys", async () => {
    const filename = databasePath();
    const storage = open(filename);
    const created = await createProject(storage);
    const layoutApplication = createLayoutApplication({
      persistence: createSqliteLayoutRepository(storage),
    });
    const saved = await layoutApplication.saveLayout({
      projectId: created.project.id,
      viewKey: "GLOBAL",
      expectedLayoutRevisionNo: 0,
      layout: {
        positions: { [TABLE_KEY]: { x: 10, y: 20 } },
        collapsedGroupKeys: ["group:stable"],
        hiddenElementKeys: [TABLE_KEY],
        viewport: { x: 1, y: 2, zoom: 0.75 },
        detailLevel: "KEYS_ONLY",
        baseSchemaHash: BEFORE_HASH,
      },
    });
    if (!saved.ok) throw new Error(JSON.stringify(saved.error));

    const applied = success(
      await visualApplication(storage, changedTransform("RENAME_TABLE")).apply({
        projectId: created.project.id,
        command: renameTableCommand(),
      }),
    );
    expect(applied).toMatchObject({
      layoutMigrated: true,
      appliedLayoutRevisionNo: 2,
      state: { project: { schemaRevisionNo: 2, layoutRevisionNo: 2 } },
    });
    const row = storage.database
      .select()
      .from(diagramLayouts)
      .where(eq(diagramLayouts.projectId, created.project.id))
      .get();
    expect(row).toMatchObject({
      revisionNo: 2,
      baseSchemaHash: AFTER_HASH,
      collapsedGroupKeys: ["group:stable"],
      viewport: { x: 1, y: 2, zoom: 0.75 },
    });
    expect(row?.positions).toEqual({
      [TABLE_KEY]: { x: 10, y: 20 },
      [RENAMED_TABLE_KEY]: { x: 10, y: 20 },
    });
    expect(new Set(row?.hiddenElementKeys)).toEqual(new Set([TABLE_KEY, RENAMED_TABLE_KEY]));
  });

  it("rolls back every write when receipt persistence fails", async () => {
    const filename = databasePath();
    const storage = open(filename);
    const created = await createProject(storage);
    storage.database.run(`
      CREATE TRIGGER reject_visual_receipt
      BEFORE INSERT ON visual_command_receipts
      BEGIN
        SELECT RAISE(ABORT, 'forced receipt failure');
      END
    `);

    await expect(
      visualApplication(storage).apply({
        projectId: created.project.id,
        command: createColumnCommand(),
      }),
    ).rejects.toThrow("forced receipt failure");
    expect(
      storage.database.select().from(projects).where(eq(projects.id, created.project.id)).get(),
    ).toMatchObject({ schemaRevisionNo: 1, draftSource: VALID_SOURCE });
    expect(storage.database.select().from(visualCommandReceipts).all()).toEqual([]);
    expect(
      storage.database
        .select()
        .from(schemaRevisions)
        .where(eq(schemaRevisions.projectId, created.project.id))
        .all(),
    ).toHaveLength(1);
  });

  it("fails closed for malformed receipts and cascades valid receipts with projects", async () => {
    const filename = databasePath();
    const storage = open(filename);
    const created = await createProject(storage);
    success(
      await visualApplication(storage).apply({
        projectId: created.project.id,
        command: createColumnCommand(),
      }),
    );
    storage.database.run("PRAGMA ignore_check_constraints = ON");
    storage.database
      .update(visualCommandReceipts)
      .set({ commandHash: "broken" })
      .where(eq(visualCommandReceipts.projectId, created.project.id))
      .run();
    storage.database.run("PRAGMA ignore_check_constraints = OFF");

    expect(() =>
      createSqliteVisualCommandRepository(storage).getVisualCommandReceipt(
        created.project.id,
        COMMAND_ID,
      ),
    ).toThrow(VisualCommandPersistenceInvariantError);

    storage.database.delete(projects).where(eq(projects.id, created.project.id)).run();
    expect(storage.database.select().from(visualCommandReceipts).all()).toEqual([]);
  });
});
