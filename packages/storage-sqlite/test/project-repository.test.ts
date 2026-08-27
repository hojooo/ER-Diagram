import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProjectApplication,
  type ProjectApplication,
  type ProjectApplicationResult,
} from "@er-diagram/core";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSqliteProjectRepository,
  diagramLayouts,
  generateUuidV7,
  importArtifacts,
  openSqliteStorage,
  projects,
  type SqliteStorage,
  type SqliteStorageError,
  schemaRevisions,
  toUtcIsoTimestamp,
} from "../src/index.js";

const VALID_SOURCE = "Table 사용자 {\r\n  id int [pk]\r\n}\r\n// 🚀";
const OTHER_VALID_SOURCE = "Table 사용자 { id int [pk]\n email varchar }";
const INVALID_SOURCE = "Table 사용자 {";
const HASH = "a".repeat(64);

const temporaryDirectories = new Set<string>();
const openStorages = new Set<SqliteStorage>();

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-project-repository-test-"));
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

function applicationFor(storage: SqliteStorage): ProjectApplication {
  let epochMs = Date.parse("2026-08-27T01:02:03.000Z");
  return createProjectApplication({
    persistence: createSqliteProjectRepository(storage),
    generateId: generateUuidV7,
    now: () => toUtcIsoTimestamp(epochMs++),
  });
}

function success<T>(result: ProjectApplicationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}

afterEach(() => {
  for (const storage of openStorages) storage.close();
  openStorages.clear();
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true });
  temporaryDirectories.clear();
});

describe("SQLite project repository", () => {
  it("recovers byte-identical invalid draft and last-valid source after restart", async () => {
    const filename = temporaryDatabasePath();
    const firstStorage = trackedOpen(filename);
    const firstApplication = applicationFor(firstStorage);
    const created = success(
      await firstApplication.createProject({
        name: "Unicode schema",
        primaryDialect: "POSTGRESQL",
        source: VALID_SOURCE,
      }),
    );
    const projectId = created.state.project.id;
    success(
      await firstApplication.saveDraft({
        projectId,
        source: INVALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      }),
    );
    trackedClose(firstStorage);

    const reopenedStorage = trackedOpen(filename);
    const reopenedApplication = applicationFor(reopenedStorage);
    const state = success(await reopenedApplication.getProject(projectId));

    expect(state.project.draftSource).toBe(INVALID_SOURCE);
    expect(state.currentRevision).toMatchObject({
      revisionNo: 2,
      source: INVALID_SOURCE,
      validity: "INVALID",
    });
    expect(state.lastValidRevision).toMatchObject({
      revisionNo: 1,
      source: VALID_SOURCE,
      validity: "VALID",
    });
    expect(
      success(await reopenedApplication.listRevisions(projectId)).map(
        ({ revisionNo }) => revisionNo,
      ),
    ).toEqual([2, 1]);
    expect(success(await reopenedApplication.listProjects())[0]).toMatchObject({
      id: projectId,
      draftValidity: "INVALID",
    });
  });

  it("rejects a stale write from another connection without changing committed state", async () => {
    const filename = temporaryDatabasePath();
    const firstStorage = trackedOpen(filename);
    const secondStorage = trackedOpen(filename);
    const firstApplication = applicationFor(firstStorage);
    const secondApplication = applicationFor(secondStorage);
    const created = success(
      await firstApplication.createProject({
        name: "Shared schema",
        primaryDialect: "MYSQL",
        source: VALID_SOURCE,
      }),
    );
    const projectId = created.state.project.id;

    success(
      await firstApplication.saveDraft({
        projectId,
        source: OTHER_VALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      }),
    );
    const stale = await secondApplication.saveDraft({
      projectId,
      source: INVALID_SOURCE,
      expectedSchemaRevisionNo: 1,
    });

    expect(stale).toMatchObject({
      ok: false,
      error: {
        code: "PROJECT_SCHEMA_REVISION_CONFLICT",
        expectedSchemaRevisionNo: 1,
        currentSchemaRevisionNo: 2,
      },
    });
    expect(success(await secondApplication.getProject(projectId)).project).toMatchObject({
      draftSource: OTHER_VALID_SOURCE,
      schemaRevisionNo: 2,
    });
  });

  it("duplicates only the current draft and last-valid baseline", async () => {
    const storage = trackedOpen(temporaryDatabasePath());
    const application = applicationFor(storage);
    const created = success(
      await application.createProject({
        name: "Source",
        primaryDialect: "POSTGRESQL",
        source: VALID_SOURCE,
      }),
    );
    const sourceProjectId = created.state.project.id;
    success(
      await application.saveDraft({
        projectId: sourceProjectId,
        source: OTHER_VALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      }),
    );
    success(
      await application.saveDraft({
        projectId: sourceProjectId,
        source: INVALID_SOURCE,
        expectedSchemaRevisionNo: 2,
      }),
    );
    storage.database
      .insert(diagramLayouts)
      .values({
        projectId: sourceProjectId,
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
    storage.database
      .insert(importArtifacts)
      .values({
        id: generateUuidV7(),
        projectId: sourceProjectId,
        dialect: "POSTGRESQL",
        originalSql: null,
        originalHash: HASH,
        generatedDbml: null,
        parserVersion: "9.1.1",
        report: {},
        status: "FAILED",
        createdAt: toUtcIsoTimestamp(),
        appliedAt: null,
      })
      .run();

    const duplicate = success(
      await application.duplicateProject({
        sourceProjectId,
        name: "Copy",
        expectedSchemaRevisionNo: 3,
      }),
    );
    const duplicateId = duplicate.state.project.id;

    expect(duplicate.state.project).toMatchObject({
      primaryDialect: "POSTGRESQL",
      draftSource: INVALID_SOURCE,
      schemaRevisionNo: 2,
      layoutRevisionNo: 0,
    });
    expect(success(await application.listRevisions(sourceProjectId))).toHaveLength(3);
    expect(success(await application.listRevisions(duplicateId))).toHaveLength(2);
    expect(
      storage.database
        .select()
        .from(diagramLayouts)
        .where(eq(diagramLayouts.projectId, duplicateId))
        .all(),
    ).toEqual([]);
    expect(
      storage.database
        .select()
        .from(importArtifacts)
        .where(eq(importArtifacts.projectId, duplicateId))
        .all(),
    ).toEqual([]);
  });

  it("keeps retention and checkpoint rules in the same write transaction", async () => {
    const storage = trackedOpen(temporaryDatabasePath());
    const application = applicationFor(storage);
    const created = success(
      await application.createProject({
        name: "Retention",
        primaryDialect: "POSTGRESQL",
        source: VALID_SOURCE,
      }),
    );
    const projectId = created.state.project.id;
    const initialValidId = created.state.currentRevision.id;
    let expectedRevision = 1;
    for (let index = 0; index < 105; index += 1) {
      const saved = success(
        await application.saveDraft({
          projectId,
          source: `Table broken_${index} {`,
          expectedSchemaRevisionNo: expectedRevision,
        }),
      );
      expectedRevision = saved.state.project.schemaRevisionNo;
    }

    const beforeCheckpoint = success(await application.listRevisions(projectId));
    expect(beforeCheckpoint.filter(({ origin }) => origin === "SOURCE_EDIT")).toHaveLength(101);
    expect(beforeCheckpoint.some(({ id }) => id === initialValidId)).toBe(true);

    const checkpoint = success(
      await application.restoreRevision({
        projectId,
        revisionNo: 1,
        expectedSchemaRevisionNo: expectedRevision,
      }),
    );
    const afterCheckpoint = success(await application.listRevisions(projectId));
    expect(afterCheckpoint.filter(({ origin }) => origin === "SOURCE_EDIT")).toHaveLength(100);
    expect(afterCheckpoint.filter(({ origin }) => origin === "RESTORE")).toEqual([
      checkpoint.state.currentRevision,
    ]);
    expect(afterCheckpoint.some(({ id }) => id === initialValidId)).toBe(false);
  });

  it("rolls back the project update when a revision insert fails", async () => {
    const storage = trackedOpen(temporaryDatabasePath());
    const application = applicationFor(storage);
    const created = success(
      await application.createProject({
        name: "Rollback",
        primaryDialect: "MYSQL",
        source: VALID_SOURCE,
      }),
    );
    const projectId = created.state.project.id;
    storage.database.run(`CREATE TRIGGER force_revision_failure
      BEFORE INSERT ON schema_revisions
      WHEN NEW.project_id = '${projectId}' AND NEW.revision_no = 2
      BEGIN SELECT RAISE(ABORT, 'forced revision failure'); END`);

    await expect(
      application.saveDraft({
        projectId,
        source: OTHER_VALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      }),
    ).rejects.toThrow("forced revision failure");

    expect(success(await application.getProject(projectId))).toEqual(created.state);
    expect(success(await application.listRevisions(projectId))).toHaveLength(1);
  });

  it("fails closed for malformed diagnostic JSON and an invalid last-valid pointer", async () => {
    const storage = trackedOpen(temporaryDatabasePath());
    const repository = createSqliteProjectRepository(storage);
    const application = applicationFor(storage);
    const created = success(
      await application.createProject({
        name: "Invariant",
        primaryDialect: "POSTGRESQL",
        source: VALID_SOURCE,
      }),
    );
    const projectId = created.state.project.id;

    storage.database.run(
      `UPDATE schema_revisions SET diagnostic_summary_json = '{}' WHERE project_id = '${projectId}'`,
    );
    expect(() => repository.listRevisions(projectId)).toThrowError(
      expect.objectContaining<Partial<SqliteStorageError>>({
        code: "SQLITE_PROJECT_DATA_INVALID",
      }),
    );

    storage.database
      .update(schemaRevisions)
      .set({
        validity: "INVALID",
        diagnosticSummary: {
          errors: 1,
          warnings: 0,
          infos: 0,
          parserVersion: "9.1.1",
        },
      })
      .where(eq(schemaRevisions.projectId, projectId))
      .run();
    const invalidPointer = await application.getProject(projectId);
    expect(invalidPointer).toMatchObject({
      ok: false,
      error: { code: "PROJECT_STORAGE_INVARIANT_VIOLATION" },
    });
  });

  it("deletes project children through the application transaction", async () => {
    const storage = trackedOpen(temporaryDatabasePath());
    const application = applicationFor(storage);
    const created = success(
      await application.createProject({
        name: "Delete",
        primaryDialect: "MYSQL",
        source: VALID_SOURCE,
      }),
    );
    const projectId = created.state.project.id;
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
    storage.database
      .insert(importArtifacts)
      .values({
        id: generateUuidV7(),
        projectId,
        dialect: "MYSQL",
        originalSql: null,
        originalHash: HASH,
        generatedDbml: null,
        parserVersion: "9.1.1",
        report: {},
        status: "FAILED",
        createdAt: toUtcIsoTimestamp(),
        appliedAt: null,
      })
      .run();

    expect(await application.deleteProject({ projectId, expectedSchemaRevisionNo: 1 })).toEqual({
      ok: true,
      value: { projectId },
    });
    expect(storage.database.select().from(projects).all()).toEqual([]);
    expect(storage.database.select().from(schemaRevisions).all()).toEqual([]);
    expect(storage.database.select().from(diagramLayouts).all()).toEqual([]);
    expect(storage.database.select().from(importArtifacts).all()).toEqual([]);
  });
});
