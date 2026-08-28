import { describe, expect, it } from "vitest";
import {
  sqlImportApplyResponseSchema,
  sqlImportPreviewResponseSchema,
} from "@er-diagram/contracts";

import {
  createProjectApplication,
  createSqlImportApplication,
  type Project,
  type ProjectPersistenceTransaction,
  type SchemaRevision,
  type SqlImportApplicationResult,
  type SqlImportArtifact,
  type SqlImportPersistencePort,
  type SqlImportPersistenceTransaction,
} from "../../src/index.js";

const INITIAL_SOURCE = "Table legacy { id int [pk] }";
const INVALID_SOURCE = "Table broken {";
const POSTGRESQL_DDL = "CREATE TABLE users (id bigint PRIMARY KEY);";
const MYSQL_DDL = "CREATE TABLE users (id bigint PRIMARY KEY);";

class FakeSqlImportPersistence
  implements SqlImportPersistencePort, SqlImportPersistenceTransaction
{
  readonly projects = new Map<string, Project>();
  readonly revisions = new Map<string, SchemaRevision>();
  readonly artifacts = new Map<string, SqlImportArtifact>();
  failAfterArtifactApplied = false;

  listProjects(): readonly Project[] {
    return [...this.projects.values()].map(clone);
  }

  getProject(projectId: string): Project | null {
    const project = this.projects.get(projectId);
    return project ? clone(project) : null;
  }

  getRevisionById(projectId: string, revisionId: string): SchemaRevision | null {
    const revision = this.revisions.get(revisionId);
    return revision?.projectId === projectId ? clone(revision) : null;
  }

  getRevisionByNumber(projectId: string, revisionNo: number): SchemaRevision | null {
    const revision = [...this.revisions.values()].find(
      (candidate) => candidate.projectId === projectId && candidate.revisionNo === revisionNo,
    );
    return revision ? clone(revision) : null;
  }

  listRevisions(projectId: string): readonly SchemaRevision[] {
    return [...this.revisions.values()]
      .filter((revision) => revision.projectId === projectId)
      .map(clone)
      .sort((left, right) => right.revisionNo - left.revisionNo);
  }

  getImportArtifact(projectId: string, artifactId: string): SqlImportArtifact | null {
    const artifact = this.artifacts.get(artifactId);
    return artifact?.projectId === projectId ? clone(artifact) : null;
  }

  transaction<T>(operation: (transaction: SqlImportPersistenceTransaction) => T): T {
    const projects = structuredClone(this.projects);
    const revisions = structuredClone(this.revisions);
    const artifacts = structuredClone(this.artifacts);
    try {
      return operation(this);
    } catch (error) {
      restoreMap(this.projects, projects);
      restoreMap(this.revisions, revisions);
      restoreMap(this.artifacts, artifacts);
      throw error;
    }
  }

  insertProject(project: Project): void {
    this.projects.set(project.id, clone(project));
  }

  insertRevision(revision: SchemaRevision): void {
    this.revisions.set(revision.id, clone(revision));
  }

  updateProject(project: Project, expectedSchemaRevisionNo: number): boolean {
    const current = this.projects.get(project.id);
    if (!current || current.schemaRevisionNo !== expectedSchemaRevisionNo) return false;
    this.projects.set(project.id, clone(project));
    return true;
  }

  deleteProject(projectId: string, expectedSchemaRevisionNo: number): boolean {
    const project = this.projects.get(projectId);
    if (!project || project.schemaRevisionNo !== expectedSchemaRevisionNo) return false;
    this.projects.delete(projectId);
    return true;
  }

  deleteRevisions(projectId: string, revisionIds: readonly string[]): number {
    let deleted = 0;
    for (const revisionId of revisionIds) {
      const revision = this.revisions.get(revisionId);
      if (revision?.projectId === projectId && this.revisions.delete(revisionId)) deleted += 1;
    }
    return deleted;
  }

  insertImportArtifact(artifact: SqlImportArtifact): void {
    if (this.artifacts.has(artifact.id)) throw new Error("duplicate artifact");
    this.artifacts.set(artifact.id, clone(artifact));
  }

  markImportArtifactApplied(artifact: SqlImportArtifact, expectedStatus: "PREVIEWED"): boolean {
    const current = this.artifacts.get(artifact.id);
    if (!current || current.projectId !== artifact.projectId || current.status !== expectedStatus) {
      return false;
    }
    this.artifacts.set(artifact.id, clone(artifact));
    if (this.failAfterArtifactApplied) throw new Error("forced artifact failure");
    return true;
  }
}

function createFixture(primaryDialect: "POSTGRESQL" | "MYSQL" = "POSTGRESQL") {
  const persistence = new FakeSqlImportPersistence();
  let id = 0;
  let epochMs = Date.parse("2026-08-28T01:02:03.000Z");
  const generateId = () =>
    `018f0f87-7b5a-7cc0-8000-${(++id).toString(16).padStart(12, "0")}`;
  const now = () => new Date(epochMs++).toISOString();
  const projects = createProjectApplication({ persistence, generateId, now });
  const imports = createSqlImportApplication({ persistence, generateId, now });

  return {
    persistence,
    projects,
    imports,
    async create(source = INITIAL_SOURCE) {
      const created = success(
        await projects.createProject({ name: "Import", primaryDialect, source }),
      );
      return created.state;
    },
  };
}

describe("SQL import preview application", () => {
  it("persists a successful preview without mutating project state", async () => {
    const fixture = createFixture();
    const before = await fixture.create();

    const preview = success(
      await fixture.imports.preview({
        projectId: before.project.id,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
        originalSqlRetention: "DISCARD",
      }),
    );

    expect(preview).toMatchObject({
      artifactStatus: "PREVIEWED",
      baseSchemaRevisionNo: 1,
      originalSqlRetention: "DISCARD",
      policy: { applyReadiness: "READY" },
      candidate: { dbmlHash: preview.report.candidateDbmlHash },
    });
    expect(preview.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sqlImportPreviewResponseSchema.parse(preview)).toEqual(preview);
    expect(fixture.persistence.getProject(before.project.id)).toEqual(before.project);
    expect(fixture.persistence.listRevisions(before.project.id)).toHaveLength(1);
    expect(
      fixture.persistence.getImportArtifact(before.project.id, preview.artifactId),
    ).toMatchObject({
      originalSql: null,
      status: "PREVIEWED",
      generatedDbml: preview.candidate?.dbml,
      envelope: { previewHash: preview.previewHash, appliedPolicy: null },
    });
  });

  it("stores failed preview evidence and opt-in original SQL while returning no candidate", async () => {
    const fixture = createFixture();
    const before = await fixture.create();
    const source = "CREATE TABLE broken (id bigint";

    const preview = success(
      await fixture.imports.preview({
        projectId: before.project.id,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source,
        originalSqlRetention: "RETAIN",
      }),
    );

    expect(preview).toMatchObject({
      artifactStatus: "FAILED",
      candidate: null,
      policy: { applyReadiness: "CONVERSION_FAILED" },
    });
    expect(
      fixture.persistence.getImportArtifact(before.project.id, preview.artifactId),
    ).toMatchObject({
      originalSql: source,
      generatedDbml: null,
      status: "FAILED",
    });
    expect(fixture.persistence.getProject(before.project.id)).toEqual(before.project);
  });

  it("rejects stale revisions and primary-dialect mismatches before storing artifacts", async () => {
    const fixture = createFixture("MYSQL");
    const state = await fixture.create();

    const mismatch = failure(
      await fixture.imports.preview({
        projectId: state.project.id,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
      }),
    );
    const stale = failure(
      await fixture.imports.preview({
        projectId: state.project.id,
        expectedSchemaRevisionNo: 2,
        dialect: "MYSQL",
        source: MYSQL_DDL,
      }),
    );

    expect(mismatch.error.code).toBe("SQL_IMPORT_DIALECT_MISMATCH");
    expect(stale.error).toMatchObject({
      code: "SQL_IMPORT_SCHEMA_REVISION_CONFLICT",
      currentSchemaRevisionNo: 1,
    });
    expect(fixture.persistence.artifacts.size).toBe(0);
  });

  it("computes deterministic preview hashes over retention and conversion evidence", async () => {
    const first = createFixture();
    const second = createFixture();
    const firstState = await first.create();
    const secondState = await second.create();

    const command = {
      expectedSchemaRevisionNo: 1,
      dialect: "POSTGRESQL" as const,
      source: POSTGRESQL_DDL,
    };
    const firstPreview = success(
      await first.imports.preview({ projectId: firstState.project.id, ...command }),
    );
    const secondPreview = success(
      await second.imports.preview({ projectId: secondState.project.id, ...command }),
    );
    const retained = success(
      await second.imports.preview({
        projectId: secondState.project.id,
        ...command,
        originalSqlRetention: "RETAIN",
      }),
    );

    expect(firstPreview.previewHash).toBe(secondPreview.previewHash);
    expect(retained.previewHash).not.toBe(secondPreview.previewHash);
    expect(structuredClone(JSON.parse(JSON.stringify(firstPreview)))).toEqual(firstPreview);
  });
});

describe("SQL import apply application", () => {
  it("reparses preview evidence and creates one valid SQL_IMPORT checkpoint", async () => {
    const fixture = createFixture();
    const before = await fixture.create();
    const preview = success(
      await fixture.imports.preview({
        projectId: before.project.id,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
      }),
    );

    const applied = success(
      await fixture.imports.apply({
        projectId: before.project.id,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source: POSTGRESQL_DDL,
      }),
    );

    expect(applied).toMatchObject({
      artifactId: preview.artifactId,
      artifactStatus: "APPLIED",
      previewHash: preview.previewHash,
      policy: { applyReadiness: "READY" },
      revisionCreated: true,
      state: {
        project: { schemaRevisionNo: 2, layoutRevisionNo: 0 },
        currentRevision: { validity: "VALID", origin: "SQL_IMPORT", revisionNo: 2 },
      },
    });
    expect(applied.state.project.lastValidRevisionId).toBe(applied.state.currentRevision.id);
    expect(sqlImportApplyResponseSchema.parse(applied)).toEqual(applied);
    expect(
      fixture.persistence.listRevisions(before.project.id).map(({ revisionNo }) => revisionNo),
    ).toEqual([2, 1]);
    expect(
      fixture.persistence.getImportArtifact(before.project.id, preview.artifactId),
    ).toMatchObject({
      status: "APPLIED",
      appliedAt: applied.appliedAt,
      envelope: { appliedPolicy: applied.policy },
    });
  });

  it("requires explicit DDL-only confirmation without changing the original preview hash", async () => {
    const fixture = createFixture();
    const state = await fixture.create();
    const source = `${POSTGRESQL_DDL} INSERT INTO users VALUES (1);`;
    const preview = success(
      await fixture.imports.preview({
        projectId: state.project.id,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source,
      }),
    );

    expect(preview.report.applyEligible).toBe(false);
    expect(
      failure(
        await fixture.imports.apply({
          projectId: state.project.id,
          expectedSchemaRevisionNo: 1,
          artifactId: preview.artifactId,
          previewHash: preview.previewHash,
          source,
        }),
      ).error.code,
    ).toBe("SQL_IMPORT_DATA_CONFIRMATION_REQUIRED");

    const applied = success(
      await fixture.imports.apply({
        projectId: state.project.id,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source,
        dataStatementHandling: "CONFIRM_DDL_ONLY",
      }),
    );
    expect(applied.previewHash).toBe(preview.previewHash);
    expect(applied.policy).toMatchObject({
      dataHandling: "CONFIRMED_DDL_ONLY",
      applyReadiness: "READY",
    });
    expect(applied.state.project.draftSource).not.toContain("Records");
  });

  it("rejects source, hash, status, and evidence mismatches without changing project state", async () => {
    const fixture = createFixture();
    const before = await fixture.create();
    const preview = success(
      await fixture.imports.preview({
        projectId: before.project.id,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
      }),
    );

    const wrongHash = failure(
      await fixture.imports.apply({
        projectId: before.project.id,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: "f".repeat(64),
        source: POSTGRESQL_DDL,
      }),
    );
    const wrongSource = failure(
      await fixture.imports.apply({
        projectId: before.project.id,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source: "CREATE TABLE changed (id bigint);",
      }),
    );

    expect(wrongHash.error.code).toBe("SQL_IMPORT_PREVIEW_MISMATCH");
    expect(wrongSource.error.code).toBe("SQL_IMPORT_PREVIEW_MISMATCH");
    expect(fixture.persistence.getProject(before.project.id)).toEqual(before.project);

    success(
      await fixture.imports.apply({
        projectId: before.project.id,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source: POSTGRESQL_DDL,
      }),
    );
    expect(
      failure(
        await fixture.imports.apply({
          projectId: before.project.id,
          expectedSchemaRevisionNo: 2,
          artifactId: preview.artifactId,
          previewHash: preview.previewHash,
          source: POSTGRESQL_DDL,
        }),
      ).error.code,
    ).toBe("SQL_IMPORT_ARTIFACT_ALREADY_APPLIED");
  });

  it("rolls back revision, project, and artifact writes together", async () => {
    const fixture = createFixture();
    const before = await fixture.create(INVALID_SOURCE);
    const preview = success(
      await fixture.imports.preview({
        projectId: before.project.id,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
      }),
    );
    fixture.persistence.failAfterArtifactApplied = true;

    await expect(
      fixture.imports.apply({
        projectId: before.project.id,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source: POSTGRESQL_DDL,
      }),
    ).rejects.toThrow("forced artifact failure");

    expect(fixture.persistence.getProject(before.project.id)).toEqual(before.project);
    expect(fixture.persistence.listRevisions(before.project.id)).toHaveLength(1);
    expect(
      fixture.persistence.getImportArtifact(before.project.id, preview.artifactId)?.status,
    ).toBe("PREVIEWED");
  });
});

function success<T>(
  result:
    | SqlImportApplicationResult<T>
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}

function failure<T>(result: SqlImportApplicationResult<T>): Extract<typeof result, { ok: false }> {
  if (result.ok) throw new Error(`Expected failure: ${JSON.stringify(result.value)}`);
  return result;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function restoreMap<TKey, TValue>(target: Map<TKey, TValue>, source: Map<TKey, TValue>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}
