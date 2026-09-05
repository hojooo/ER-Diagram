import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createLayoutApplication,
  createProjectApplication,
  type LayoutApplicationResult,
  type ProjectApplicationResult,
} from "@er-diagram/core";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSqliteLayoutRepository,
  createSqliteProjectRepository,
  generateUuidV7,
  openSqliteStorage,
  type SqliteStorage,
  toUtcIsoTimestamp,
} from "../src/index.js";

const SOURCE = "Table 사용자 {\r\n  id int [pk]\r\n}\r\n// 🚀";
const HASH = "a".repeat(64);
const temporaryDirectories = new Set<string>();
const openStorages = new Set<SqliteStorage>();

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-layout-repository-test-"));
  temporaryDirectories.add(directory);
  return path.join(directory, "er-diagram.sqlite");
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

function projectApplication(storage: SqliteStorage) {
  return createProjectApplication({
    persistence: createSqliteProjectRepository(storage),
    generateId: generateUuidV7,
    now: () => toUtcIsoTimestamp(Date.parse("2026-08-27T01:02:03.000Z")),
  });
}

function layoutValue() {
  return {
    positions: {
      'table:["public","사용자🚀"]': { x: 12.5, y: -30, width: 384, height: 252 },
    },
    collapsedGroupKeys: ['group:["public","핵심"]'],
    hiddenElementKeys: ['column:["public","사용자🚀","비밀"]'],
    viewport: { x: 20, y: 30, zoom: 0.75 },
    detailLevel: "KEYS_ONLY" as const,
    baseSchemaHash: HASH,
  };
}

function success<T>(result: ProjectApplicationResult<T> | LayoutApplicationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

afterEach(() => {
  for (const storage of openStorages) storage.close();
  openStorages.clear();
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true });
  temporaryDirectories.clear();
});

describe("SQLite layout repository", () => {
  it("persists independent view layouts and restores exact JSON after restart", async () => {
    const filename = temporaryDatabasePath();
    const first = trackedOpen(filename);
    const created = success(
      await projectApplication(first).createProject({
        name: "Layout",
        primaryDialect: "POSTGRESQL",
        source: SOURCE,
      }),
    );
    const projectId = created.state.project.id;
    const layouts = createLayoutApplication({ persistence: createSqliteLayoutRepository(first) });
    success(
      await layouts.saveLayout({
        projectId,
        viewKey: "GLOBAL",
        expectedLayoutRevisionNo: 0,
        layout: layoutValue(),
      }),
    );
    success(
      await layouts.saveLayout({
        projectId,
        viewKey: 'view:["public","집중"]',
        expectedLayoutRevisionNo: 1,
        layout: { ...layoutValue(), viewport: { x: 99, y: 88, zoom: 1.25 } },
      }),
    );
    trackedClose(first);

    const reopened = trackedOpen(filename);
    const restored = createLayoutApplication({
      persistence: createSqliteLayoutRepository(reopened),
    });
    expect(success(await restored.getLayout(projectId, "GLOBAL"))).toEqual({
      layout: { projectId, viewKey: "GLOBAL", revisionNo: 1, ...layoutValue() },
      currentLayoutRevisionNo: 2,
    });
    expect(success(await restored.getLayout(projectId, 'view:["public","집중"]'))).toMatchObject({
      layout: { revisionNo: 2, viewport: { x: 99, y: 88, zoom: 1.25 } },
      currentLayoutRevisionNo: 2,
    });
  });

  it("rejects stale writes across two connections without changing either view", async () => {
    const filename = temporaryDatabasePath();
    const first = trackedOpen(filename);
    const second = trackedOpen(filename);
    const created = success(
      await projectApplication(first).createProject({
        name: "Concurrent layout",
        primaryDialect: "MYSQL",
        source: SOURCE,
      }),
    );
    const projectId = created.state.project.id;
    const firstApplication = createLayoutApplication({
      persistence: createSqliteLayoutRepository(first),
    });
    const secondApplication = createLayoutApplication({
      persistence: createSqliteLayoutRepository(second),
    });
    success(
      await firstApplication.saveLayout({
        projectId,
        viewKey: "GLOBAL",
        expectedLayoutRevisionNo: 0,
        layout: layoutValue(),
      }),
    );

    const stale = await secondApplication.saveLayout({
      projectId,
      viewKey: "other",
      expectedLayoutRevisionNo: 0,
      layout: layoutValue(),
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "LAYOUT_REVISION_CONFLICT", currentLayoutRevisionNo: 1 },
    });
    expect(success(await secondApplication.getLayout(projectId, "other")).layout).toBeNull();
  });

  it("fails closed for malformed persisted layout JSON", async () => {
    const storage = trackedOpen(temporaryDatabasePath());
    const created = success(
      await projectApplication(storage).createProject({
        name: "Corrupt layout",
        primaryDialect: "POSTGRESQL",
        source: SOURCE,
      }),
    );
    const projectId = created.state.project.id;
    const application = createLayoutApplication({
      persistence: createSqliteLayoutRepository(storage),
    });
    success(
      await application.saveLayout({
        projectId,
        viewKey: "GLOBAL",
        expectedLayoutRevisionNo: 0,
        layout: layoutValue(),
      }),
    );
    storage.database.run(
      sql.raw(
        `UPDATE diagram_layouts SET viewport_json = '{"x":"bad","y":0,"zoom":1}' WHERE project_id = '${projectId}'`,
      ),
    );

    expect(await application.getLayout(projectId, "GLOBAL")).toMatchObject({
      ok: false,
      error: { code: "LAYOUT_STORAGE_INVARIANT_VIOLATION" },
    });
  });

  it("does not mutate schema state or project updatedAt", async () => {
    const storage = trackedOpen(temporaryDatabasePath());
    const projects = projectApplication(storage);
    const created = success(
      await projects.createProject({
        name: "Independent revisions",
        primaryDialect: "POSTGRESQL",
        source: SOURCE,
      }),
    );
    const before = created.state.project;
    const layouts = createLayoutApplication({ persistence: createSqliteLayoutRepository(storage) });
    success(
      await layouts.saveLayout({
        projectId: before.id,
        viewKey: "GLOBAL",
        expectedLayoutRevisionNo: 0,
        layout: layoutValue(),
      }),
    );

    const after = success(await projects.getProject(before.id)).project;
    expect(after).toMatchObject({
      schemaRevisionNo: before.schemaRevisionNo,
      draftSource: before.draftSource,
      updatedAt: before.updatedAt,
      layoutRevisionNo: 1,
    });
  });
});
