import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_RUNTIME_RESOURCE_LIMITS } from "@er-diagram/contracts";
import {
  createLayoutApplication,
  createProjectApplication,
  createProjectBundleApplication,
  createSqlImportApplication,
  parseDbmlV2,
  type ProjectBundleApplicationResult,
  type ProjectBundleStagedEntries,
  type ProjectBundleStagingSink,
} from "@er-diagram/core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSqliteLayoutRepository,
  createSqliteProjectBundleRepository,
  createSqliteProjectRepository,
  createSqliteSqlImportRepository,
  diagramLayouts,
  generateUuidV7,
  importArtifacts,
  openSqliteStorage,
  projects,
  schemaRevisions,
  type SqliteStorage,
  toUtcIsoTimestamp,
  visualCommandReceipts,
} from "../src/index.js";

const VALID_SOURCE = "Table 사용자 {\r\n  id int [pk]\r\n}\r\n";
const INVALID_SOURCE = `${VALID_SOURCE}Table broken {`;
const SQL = "CREATE TABLE imported (id bigint PRIMARY KEY);";
const directories = new Set<string>();
const storages = new Set<SqliteStorage>();

class MemoryStaging implements ProjectBundleStagedEntries {
  readonly entries = new Map<string, Uint8Array>();
  readonly sink: ProjectBundleStagingSink = {
    writeEntry: async (entryPath, content) => {
      this.entries.set(entryPath, new Uint8Array(content));
    },
  };

  async listPaths(): Promise<readonly string[]> {
    return [...this.entries.keys()].sort();
  }

  async readEntry(entryPath: string): Promise<Uint8Array> {
    return this.readEntrySync(entryPath);
  }

  readEntrySync(entryPath: string): Uint8Array {
    const value = this.entries.get(entryPath);
    if (!value) throw new Error("missing staged entry");
    return new Uint8Array(value);
  }
}

function databasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-project-bundle-"));
  directories.add(directory);
  return path.join(directory, "studio.sqlite");
}

function openTracked(filename: string): SqliteStorage {
  const storage = openSqliteStorage({ filename });
  storages.add(storage);
  return storage;
}

function applications(storage: SqliteStorage) {
  let time = Date.parse("2026-08-31T01:02:03.000Z");
  const now = () => toUtcIsoTimestamp(time++);
  return {
    projects: createProjectApplication({
      persistence: createSqliteProjectRepository(storage),
      generateId: generateUuidV7,
      now,
    }),
    layouts: createLayoutApplication({ persistence: createSqliteLayoutRepository(storage) }),
    imports: createSqlImportApplication({
      persistence: createSqliteSqlImportRepository(storage),
      generateId: generateUuidV7,
      now,
    }),
    bundles: createProjectBundleApplication({
      persistence: createSqliteProjectBundleRepository(storage),
      parseSource: parseDbmlV2,
      resourceLimits: DEFAULT_RUNTIME_RESOURCE_LIMITS,
      generateId: generateUuidV7,
      now,
    }),
  };
}

afterEach(() => {
  for (const storage of storages) storage.close();
  storages.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

describe("SQLite project bundle repository", () => {
  it("atomically imports invalid/current history, layout and redacted report across reopen", async () => {
    const filename = databasePath();
    const first = openTracked(filename);
    const firstApps = applications(first);
    const created = success(
      await firstApps.projects.createProject({
        name: "Portable 사용자 🚀",
        primaryDialect: "POSTGRESQL",
        source: VALID_SOURCE,
      }),
    );
    const projectId = created.state.project.id;
    const invalid = success(
      await firstApps.projects.saveDraft({
        projectId,
        source: INVALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      }),
    );
    success(
      await firstApps.layouts.saveLayout({
        projectId,
        viewKey: "GLOBAL",
        expectedLayoutRevisionNo: 0,
        layout: {
          positions: {
            'table:["public","사용자"]': { x: 10, y: 20, width: 360, height: 224 },
          },
          collapsedGroupKeys: [],
          hiddenElementKeys: [],
          viewport: { x: 1, y: 2, zoom: 0.8 },
          detailLevel: "FULL",
          baseSchemaHash: created.state.project.draftHash,
        },
      }),
    );
    success(
      await firstApps.imports.preview({
        projectId,
        expectedSchemaRevisionNo: 2,
        dialect: "POSTGRESQL",
        source: SQL,
        originalSqlRetention: "RETAIN",
      }),
    );

    const staging = new MemoryStaging();
    success(
      await firstApps.bundles.exportBundle({
        projectId,
        expectedSchemaRevisionNo: 2,
        expectedLayoutRevisionNo: 1,
        staging: staging.sink,
      }),
    );
    const imported = success(await firstApps.bundles.importBundle({ staging }));
    const importedId = imported.state.project.id;
    expect(importedId).not.toBe(projectId);
    expect(imported.state).toMatchObject({
      project: {
        name: "Portable 사용자 🚀",
        draftSource: INVALID_SOURCE,
        schemaRevisionNo: 2,
        layoutRevisionNo: 1,
      },
      currentRevision: { revisionNo: 2, validity: "INVALID" },
      lastValidRevision: { revisionNo: 1, source: VALID_SOURCE },
    });
    expect(imported.imported).toEqual({ revisionCount: 2, layoutCount: 1, reportCount: 1 });

    first.close();
    storages.delete(first);
    const reopened = openTracked(filename);
    const repo = createSqliteProjectBundleRepository(reopened);
    expect(repo.getProject(importedId)?.draftSource).toBe(INVALID_SOURCE);
    expect(repo.listRevisions(importedId).map(({ revisionNo }) => revisionNo)).toEqual([2, 1]);
    expect(repo.listLayouts(importedId)).toMatchObject([
      {
        positions: {
          'table:["public","사용자"]': { x: 10, y: 20, width: 360, height: 224 },
        },
      },
    ]);
    expect(repo.listImportArtifacts(importedId)[0]).toMatchObject({
      originalSql: null,
      status: "CANCELLED",
      envelope: { originalSqlRetention: "DISCARD" },
    });
    expect(
      reopened.database
        .select()
        .from(visualCommandReceipts)
        .where(eq(visualCommandReceipts.projectId, importedId))
        .all(),
    ).toEqual([]);
    expect(invalid.state.project.draftSource).toBe(INVALID_SOURCE);
  });

  it("rolls back the new project when a layout insert fails", async () => {
    const storage = openTracked(databasePath());
    const apps = applications(storage);
    const created = success(
      await apps.projects.createProject({
        name: "Rollback",
        primaryDialect: "MYSQL",
        source: VALID_SOURCE,
      }),
    );
    success(
      await apps.layouts.saveLayout({
        projectId: created.state.project.id,
        viewKey: "GLOBAL",
        expectedLayoutRevisionNo: 0,
        layout: {
          positions: {},
          collapsedGroupKeys: [],
          hiddenElementKeys: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          detailLevel: "FULL",
          baseSchemaHash: created.state.project.draftHash,
        },
      }),
    );
    const staging = new MemoryStaging();
    success(
      await apps.bundles.exportBundle({
        projectId: created.state.project.id,
        expectedSchemaRevisionNo: 1,
        expectedLayoutRevisionNo: 1,
        staging: staging.sink,
      }),
    );
    storage.database.run(`CREATE TRIGGER reject_imported_layout
      BEFORE INSERT ON diagram_layouts
      WHEN NEW.project_id <> '${created.state.project.id}'
      BEGIN SELECT RAISE(ABORT, 'forced bundle layout failure'); END`);
    const before = storage.database.select().from(projects).all().length;
    const result = await apps.bundles.importBundle({ staging });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROJECT_BUNDLE_STORAGE_INVARIANT_VIOLATION" },
    });
    expect(storage.database.select().from(projects).all()).toHaveLength(before);
    expect(storage.database.select().from(schemaRevisions).all()).toHaveLength(1);
    expect(storage.database.select().from(diagramLayouts).all()).toHaveLength(1);
    expect(storage.database.select().from(importArtifacts).all()).toHaveLength(0);
  });
});

function success<T>(
  result:
    | ProjectBundleApplicationResult<T>
    | { ok: true; value: T }
    | { ok: false; error: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
