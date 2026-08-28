import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProjectApplication,
  createSqlImportApplication,
  SqlImportPersistenceInvariantError,
  type ProjectApplicationResult,
  type SqlImportApplicationResult,
} from "@er-diagram/core";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSqliteProjectRepository,
  createSqliteSqlImportRepository,
  diagramLayouts,
  generateUuidV7,
  importArtifacts,
  openSqliteStorage,
  type SqliteStorage,
  toUtcIsoTimestamp,
} from "../src/index.js";

const INITIAL_SOURCE = "Table legacy { id int [pk] }";
const INVALID_SOURCE = "Table broken {";
const POSTGRESQL_DDL = "CREATE TABLE users (id bigint PRIMARY KEY);";
const HASH = "a".repeat(64);
const temporaryDirectories = new Set<string>();
const storages = new Set<SqliteStorage>();

function databasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-sql-import-repository-"));
  temporaryDirectories.add(directory);
  return path.join(directory, "er-diagram.sqlite");
}

function trackedOpen(filename: string): SqliteStorage {
  const storage = openSqliteStorage({ filename });
  storages.add(storage);
  return storage;
}

function fixture(storage: SqliteStorage) {
  let epochMs = Date.parse("2026-08-28T01:02:03.000Z");
  const now = () => toUtcIsoTimestamp(epochMs++);
  return {
    projects: createProjectApplication({
      persistence: createSqliteProjectRepository(storage),
      generateId: generateUuidV7,
      now,
    }),
    imports: createSqlImportApplication({
      persistence: createSqliteSqlImportRepository(storage),
      generateId: generateUuidV7,
      now,
    }),
  };
}

afterEach(() => {
  for (const storage of storages) storage.close();
  storages.clear();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe("SQLite SQL import artifact repository", () => {
  it("round-trips successful and failed preview artifacts across a reopen", async () => {
    const filename = databasePath();
    const firstStorage = trackedOpen(filename);
    const first = fixture(firstStorage);
    const created = success(
      await first.projects.createProject({
        name: "Round trip",
        primaryDialect: "POSTGRESQL",
        source: INITIAL_SOURCE,
      }),
    );
    const projectId = created.state.project.id;
    const successful = success(
      await first.imports.preview({
        projectId,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
      }),
    );
    const failedSource = "CREATE TABLE 자료 (id bigint";
    const failed = success(
      await first.imports.preview({
        projectId,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: failedSource,
        originalSqlRetention: "RETAIN",
      }),
    );
    firstStorage.close();
    storages.delete(firstStorage);

    const reopened = trackedOpen(filename);
    const repository = createSqliteSqlImportRepository(reopened);
    expect(repository.getImportArtifact(projectId, successful.artifactId)).toMatchObject({
      status: "PREVIEWED",
      originalSql: null,
      generatedDbml: successful.candidate?.dbml,
      envelope: { previewHash: successful.previewHash, appliedPolicy: null },
    });
    expect(repository.getImportArtifact(projectId, failed.artifactId)).toMatchObject({
      status: "FAILED",
      originalSql: failedSource,
      generatedDbml: null,
      envelope: { previewHash: failed.previewHash },
    });
  });

  it("atomically applies a checkpoint while preserving layouts and prior revisions", async () => {
    const storage = trackedOpen(databasePath());
    const applications = fixture(storage);
    const created = success(
      await applications.projects.createProject({
        name: "Apply",
        primaryDialect: "POSTGRESQL",
        source: INVALID_SOURCE,
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
    const preview = success(
      await applications.imports.preview({
        projectId,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
      }),
    );

    const applied = success(
      await applications.imports.apply({
        projectId,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source: POSTGRESQL_DDL,
      }),
    );

    expect(applied.state).toMatchObject({
      project: { schemaRevisionNo: 2, layoutRevisionNo: 0 },
      currentRevision: { origin: "SQL_IMPORT", validity: "VALID" },
      lastValidRevision: { id: applied.state.currentRevision.id },
    });
    expect(success(await applications.projects.listRevisions(projectId))).toHaveLength(2);
    expect(storage.database.select().from(diagramLayouts).all()).toHaveLength(1);
    expect(
      createSqliteSqlImportRepository(storage).getImportArtifact(projectId, preview.artifactId),
    ).toMatchObject({
      status: "APPLIED",
      appliedAt: applied.appliedAt,
      envelope: { appliedPolicy: applied.policy },
    });
  });

  it("blocks stale applies after a concurrent project write", async () => {
    const filename = databasePath();
    const firstStorage = trackedOpen(filename);
    const secondStorage = trackedOpen(filename);
    const first = fixture(firstStorage);
    const second = fixture(secondStorage);
    const created = success(
      await first.projects.createProject({
        name: "Concurrent",
        primaryDialect: "POSTGRESQL",
        source: INITIAL_SOURCE,
      }),
    );
    const projectId = created.state.project.id;
    const preview = success(
      await first.imports.preview({
        projectId,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
      }),
    );
    success(
      await second.projects.saveDraft({
        projectId,
        expectedSchemaRevisionNo: 1,
        source: "Table changed { id int [pk] }",
      }),
    );

    const stale = failure(
      await first.imports.apply({
        projectId,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source: POSTGRESQL_DDL,
      }),
    );
    expect(stale.error).toMatchObject({
      code: "SQL_IMPORT_SCHEMA_REVISION_CONFLICT",
      currentSchemaRevisionNo: 2,
    });
    expect(
      createSqliteSqlImportRepository(firstStorage).getImportArtifact(projectId, preview.artifactId)
        ?.status,
    ).toBe("PREVIEWED");
  });

  it("does not persist discarded row data in the artifact row", async () => {
    const storage = trackedOpen(databasePath());
    const applications = fixture(storage);
    const created = success(
      await applications.projects.createProject({
        name: "Discard",
        primaryDialect: "POSTGRESQL",
        source: INITIAL_SOURCE,
      }),
    );
    const marker = `ROW_SENTINEL_${"x".repeat(32 * 1024)}`;
    const source = `${POSTGRESQL_DDL} INSERT INTO users VALUES ('${marker}');`;
    const preview = success(
      await applications.imports.preview({
        projectId: created.state.project.id,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source,
      }),
    );

    const row = storage.database
      .select()
      .from(importArtifacts)
      .where(eq(importArtifacts.id, preview.artifactId))
      .get();
    expect(row?.originalSql).toBeNull();
    expect(JSON.stringify(row)).not.toContain("ROW_SENTINEL_");
    expect(JSON.stringify(preview)).not.toContain("ROW_SENTINEL_");
  });

  it("fails closed for malformed envelope, generated DBML, and retained source hashes", async () => {
    const storage = trackedOpen(databasePath());
    const applications = fixture(storage);
    const created = success(
      await applications.projects.createProject({
        name: "Invariant",
        primaryDialect: "POSTGRESQL",
        source: INITIAL_SOURCE,
      }),
    );
    const projectId = created.state.project.id;
    const preview = success(
      await applications.imports.preview({
        projectId,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
      }),
    );
    const repository = createSqliteSqlImportRepository(storage);

    storage.database.run(
      sql.raw(`UPDATE import_artifacts SET report_json = '{}' WHERE id = '${preview.artifactId}'`),
    );
    expect(() => repository.getImportArtifact(projectId, preview.artifactId)).toThrowError(
      expect.any(SqlImportPersistenceInvariantError),
    );

    const second = success(
      await applications.imports.preview({
        projectId,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
        originalSqlRetention: "RETAIN",
      }),
    );
    storage.database
      .update(importArtifacts)
      .set({ generatedDbml: "tampered", originalSql: "tampered" })
      .where(eq(importArtifacts.id, second.artifactId))
      .run();
    expect(() => repository.getImportArtifact(projectId, second.artifactId)).toThrowError(
      expect.any(SqlImportPersistenceInvariantError),
    );
  });

  it("rolls back revision and project writes when the artifact status transition fails", async () => {
    const storage = trackedOpen(databasePath());
    const applications = fixture(storage);
    const created = success(
      await applications.projects.createProject({
        name: "Rollback",
        primaryDialect: "POSTGRESQL",
        source: INITIAL_SOURCE,
      }),
    );
    const projectId = created.state.project.id;
    const preview = success(
      await applications.imports.preview({
        projectId,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
      }),
    );
    storage.database.run(`CREATE TRIGGER force_artifact_apply_failure
      BEFORE UPDATE ON import_artifacts
      WHEN NEW.id = '${preview.artifactId}' AND NEW.status = 'APPLIED'
      BEGIN SELECT RAISE(ABORT, 'forced artifact apply failure'); END`);

    await expect(
      applications.imports.apply({
        projectId,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source: POSTGRESQL_DDL,
      }),
    ).rejects.toThrow("forced artifact apply failure");

    expect(success(await applications.projects.getProject(projectId))).toEqual(created.state);
    expect(success(await applications.projects.listRevisions(projectId))).toHaveLength(1);
    expect(
      createSqliteSqlImportRepository(storage).getImportArtifact(projectId, preview.artifactId)
        ?.status,
    ).toBe("PREVIEWED");
  });

  it("cascades artifacts with project deletion", async () => {
    const storage = trackedOpen(databasePath());
    const applications = fixture(storage);
    const created = success(
      await applications.projects.createProject({
        name: "Cascade",
        primaryDialect: "POSTGRESQL",
        source: INITIAL_SOURCE,
      }),
    );
    const preview = success(
      await applications.imports.preview({
        projectId: created.state.project.id,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
      }),
    );

    success(
      await applications.projects.deleteProject({
        projectId: created.state.project.id,
        expectedSchemaRevisionNo: 1,
      }),
    );
    expect(
      createSqliteSqlImportRepository(storage).getImportArtifact(
        created.state.project.id,
        preview.artifactId,
      ),
    ).toBeNull();
    expect(storage.database.select().from(importArtifacts).all()).toEqual([]);
  });
});

function success<T>(result: ProjectApplicationResult<T> | SqlImportApplicationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}

function failure<T>(result: SqlImportApplicationResult<T>): Extract<typeof result, { ok: false }> {
  if (result.ok) throw new Error(`Expected failure: ${JSON.stringify(result.value)}`);
  return result;
}
