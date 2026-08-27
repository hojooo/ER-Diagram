import { describe, expect, it } from "vitest";

import {
  createProjectApplication,
  DBML_PARSER_VERSION,
  NON_CHECKPOINT_REVISION_LIMIT,
  type Project,
  type ProjectApplication,
  type ProjectApplicationResult,
  type ProjectPersistencePort,
  type ProjectPersistenceTransaction,
  type SchemaRevision,
} from "../../src/index.js";

const VALID_SOURCE = "Table users { id int [pk] }";
const OTHER_VALID_SOURCE = "Table users { id int [pk]\n email varchar }";
const INVALID_SOURCE = "Table users {";

class FakeProjectPersistence implements ProjectPersistencePort, ProjectPersistenceTransaction {
  readonly projects = new Map<string, Project>();
  readonly revisions = new Map<string, SchemaRevision>();
  failAfterRevisionInsert = false;

  listProjects(): Project[] {
    return [...this.projects.values()]
      .map(clone)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || compare(left.id, right.id),
      );
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

  listRevisions(projectId: string): SchemaRevision[] {
    return [...this.revisions.values()]
      .filter((revision) => revision.projectId === projectId)
      .map(clone)
      .sort((left, right) => right.revisionNo - left.revisionNo || compare(left.id, right.id));
  }

  transaction<T>(operation: (transaction: ProjectPersistenceTransaction) => T): T {
    const projects = structuredClone(this.projects);
    const revisions = structuredClone(this.revisions);
    try {
      return operation(this);
    } catch (error) {
      this.projects.clear();
      for (const [id, project] of projects) this.projects.set(id, project);
      this.revisions.clear();
      for (const [id, revision] of revisions) this.revisions.set(id, revision);
      throw error;
    }
  }

  insertProject(project: Project): void {
    if (this.projects.has(project.id)) throw new Error("duplicate project");
    this.projects.set(project.id, clone(project));
  }

  insertRevision(revision: SchemaRevision): void {
    if (this.revisions.has(revision.id)) throw new Error("duplicate revision");
    this.revisions.set(revision.id, clone(revision));
    if (this.failAfterRevisionInsert) throw new Error("forced revision failure");
  }

  updateProject(project: Project, expectedSchemaRevisionNo: number): boolean {
    const current = this.projects.get(project.id);
    if (!current || current.schemaRevisionNo !== expectedSchemaRevisionNo) return false;
    this.projects.set(project.id, clone(project));
    return true;
  }

  deleteProject(projectId: string, expectedSchemaRevisionNo: number): boolean {
    const current = this.projects.get(projectId);
    if (!current || current.schemaRevisionNo !== expectedSchemaRevisionNo) return false;
    this.projects.delete(projectId);
    for (const [id, revision] of this.revisions) {
      if (revision.projectId === projectId) this.revisions.delete(id);
    }
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
}

function createFixture(): {
  application: ProjectApplication;
  persistence: FakeProjectPersistence;
} {
  const persistence = new FakeProjectPersistence();
  let id = 0;
  let timestamp = Date.parse("2026-08-27T01:02:03.000Z");
  return {
    persistence,
    application: createProjectApplication({
      persistence,
      generateId: () => `id-${++id}`,
      now: () => new Date(timestamp++).toISOString(),
    }),
  };
}

function success<T>(result: ProjectApplicationResult<T>): T {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}

function failure<T>(result: ProjectApplicationResult<T>): Extract<typeof result, { ok: false }> {
  if (result.ok) throw new Error(`Expected failure: ${JSON.stringify(result.value)}`);
  return result;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function createProject(
  application: ProjectApplication,
  source = VALID_SOURCE,
  name = "Schema",
) {
  return success(await application.createProject({ name, primaryDialect: "POSTGRESQL", source }));
}

describe("project creation and reads", () => {
  it("creates valid and invalid projects without discarding their exact draft", async () => {
    const { application } = createFixture();

    const valid = await createProject(application, VALID_SOURCE, "  Valid schema  ");
    expect(valid.state.project).toMatchObject({
      name: "Valid schema",
      draftSource: VALID_SOURCE,
      schemaRevisionNo: 1,
      layoutRevisionNo: 0,
      parserVersion: DBML_PARSER_VERSION,
    });
    expect(valid.state.currentRevision).toMatchObject({
      revisionNo: 1,
      validity: "VALID",
      origin: "SOURCE_EDIT",
      diagnosticSummary: { errors: 0, parserVersion: DBML_PARSER_VERSION },
    });
    expect(valid.state.project.lastValidRevisionId).toBe(valid.state.currentRevision.id);
    expect(valid.state.lastValidRevision?.id).toBe(valid.state.currentRevision.id);
    expect(valid.diagnostics.every((diagnostic) => diagnostic.severity !== "ERROR")).toBe(true);

    const invalid = await createProject(application, INVALID_SOURCE, "Invalid schema");
    expect(invalid.state.project.draftSource).toBe(INVALID_SOURCE);
    expect(invalid.state.currentRevision.validity).toBe("INVALID");
    expect(invalid.state.project.lastValidRevisionId).toBeNull();
    expect(invalid.state.lastValidRevision).toBeNull();
    expect(invalid.diagnostics.some((diagnostic) => diagnostic.severity === "ERROR")).toBe(true);

    const listed = success(await application.listProjects());
    expect(listed.map(({ name }) => name)).toEqual(["Invalid schema", "Valid schema"]);
    expect(listed.map(({ draftValidity }) => draftValidity)).toEqual(["INVALID", "VALID"]);
    expect(success(await application.getProject(valid.state.project.id))).toEqual(valid.state);
  });

  it("rejects a blank project name before creating state", async () => {
    const { application, persistence } = createFixture();

    const result = failure(
      await application.createProject({ name: " \n ", primaryDialect: "MYSQL", source: "" }),
    );

    expect(result.error.code).toBe("PROJECT_NAME_INVALID");
    expect(persistence.projects.size).toBe(0);
    expect(persistence.revisions.size).toBe(0);
  });
});

describe("draft and project mutations", () => {
  it("preserves last-valid state across invalid drafts and advances it after recovery", async () => {
    const { application } = createFixture();
    const created = await createProject(application);
    const projectId = created.state.project.id;
    const initialValidId = created.state.currentRevision.id;

    const invalid = success(
      await application.saveDraft({
        projectId,
        source: INVALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      }),
    );
    expect(invalid.revisionCreated).toBe(true);
    expect(invalid.state.project.schemaRevisionNo).toBe(2);
    expect(invalid.state.currentRevision.validity).toBe("INVALID");
    expect(invalid.state.lastValidRevision?.id).toBe(initialValidId);

    const recovered = success(
      await application.saveDraft({
        projectId,
        source: OTHER_VALID_SOURCE,
        expectedSchemaRevisionNo: 2,
      }),
    );
    expect(recovered.state.project.schemaRevisionNo).toBe(3);
    expect(recovered.state.currentRevision.validity).toBe("VALID");
    expect(recovered.state.lastValidRevision?.id).toBe(recovered.state.currentRevision.id);
  });

  it("does not create a revision for an identical draft", async () => {
    const { application } = createFixture();
    const created = await createProject(application);

    const saved = success(
      await application.saveDraft({
        projectId: created.state.project.id,
        source: VALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      }),
    );

    expect(saved.revisionCreated).toBe(false);
    expect(saved.state.project.schemaRevisionNo).toBe(1);
    expect(success(await application.listRevisions(created.state.project.id))).toHaveLength(1);
  });

  it("renames without changing schema history and applies same-version renames last", async () => {
    const { application } = createFixture();
    const created = await createProject(application);
    const projectId = created.state.project.id;

    const first = success(
      await application.renameProject({
        projectId,
        name: "  First name ",
        expectedSchemaRevisionNo: 1,
      }),
    );
    const second = success(
      await application.renameProject({
        projectId,
        name: "Second name",
        expectedSchemaRevisionNo: 1,
      }),
    );

    expect(first.project.name).toBe("First name");
    expect(second.project.name).toBe("Second name");
    expect(second.project.schemaRevisionNo).toBe(1);
    expect(success(await application.listRevisions(projectId))).toHaveLength(1);
  });

  it("rejects stale source-sensitive writes without changing state", async () => {
    const { application } = createFixture();
    const created = await createProject(application);
    const projectId = created.state.project.id;
    success(
      await application.saveDraft({
        projectId,
        source: OTHER_VALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      }),
    );
    const before = success(await application.getProject(projectId));

    const save = failure(
      await application.saveDraft({
        projectId,
        source: INVALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      }),
    );
    const rename = failure(
      await application.renameProject({
        projectId,
        name: "Stale",
        expectedSchemaRevisionNo: 1,
      }),
    );
    const duplicate = failure(
      await application.duplicateProject({
        sourceProjectId: projectId,
        name: "Stale copy",
        expectedSchemaRevisionNo: 1,
      }),
    );
    const deleted = failure(
      await application.deleteProject({ projectId, expectedSchemaRevisionNo: 1 }),
    );

    for (const result of [save, rename, duplicate, deleted]) {
      expect(result.error).toMatchObject({
        code: "PROJECT_SCHEMA_REVISION_CONFLICT",
        expectedSchemaRevisionNo: 1,
        currentSchemaRevisionNo: 2,
      });
    }
    expect(success(await application.getProject(projectId))).toEqual(before);
  });

  it("rolls back a failed source transaction", async () => {
    const { application, persistence } = createFixture();
    const created = await createProject(application);
    const projectId = created.state.project.id;
    const before = success(await application.getProject(projectId));
    persistence.failAfterRevisionInsert = true;

    await expect(
      application.saveDraft({
        projectId,
        source: OTHER_VALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      }),
    ).rejects.toThrow("forced revision failure");
    persistence.failAfterRevisionInsert = false;

    expect(success(await application.getProject(projectId))).toEqual(before);
    expect(success(await application.listRevisions(projectId))).toHaveLength(1);
  });
});

describe("duplicate and restore", () => {
  it("re-baselines valid, invalid-with-last-valid, and invalid-only projects", async () => {
    const { application } = createFixture();

    const validSource = await createProject(application, VALID_SOURCE, "Valid");
    const validCopy = success(
      await application.duplicateProject({
        sourceProjectId: validSource.state.project.id,
        name: "Valid copy",
        expectedSchemaRevisionNo: 1,
      }),
    );
    expect(validCopy.state.project.schemaRevisionNo).toBe(1);
    expect(validCopy.state.currentRevision.validity).toBe("VALID");
    expect(success(await application.listRevisions(validCopy.state.project.id))).toHaveLength(1);

    const invalidDraft = success(
      await application.saveDraft({
        projectId: validSource.state.project.id,
        source: INVALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      }),
    );
    const invalidCopy = success(
      await application.duplicateProject({
        sourceProjectId: validSource.state.project.id,
        name: "Invalid copy",
        expectedSchemaRevisionNo: 2,
      }),
    );
    expect(invalidCopy.state.project.schemaRevisionNo).toBe(2);
    expect(invalidCopy.state.currentRevision).toMatchObject({
      revisionNo: 2,
      source: INVALID_SOURCE,
      validity: "INVALID",
    });
    expect(invalidCopy.state.lastValidRevision).toMatchObject({
      revisionNo: 1,
      source: VALID_SOURCE,
      validity: "VALID",
    });
    expect(invalidCopy.state.lastValidRevision?.id).not.toBe(
      invalidDraft.state.lastValidRevision?.id,
    );

    const invalidOnly = await createProject(application, INVALID_SOURCE, "Invalid only");
    const invalidOnlyCopy = success(
      await application.duplicateProject({
        sourceProjectId: invalidOnly.state.project.id,
        name: "Invalid only copy",
        expectedSchemaRevisionNo: 1,
      }),
    );
    expect(invalidOnlyCopy.state.project.schemaRevisionNo).toBe(1);
    expect(invalidOnlyCopy.state.currentRevision.validity).toBe("INVALID");
    expect(invalidOnlyCopy.state.lastValidRevision).toBeNull();
  });

  it("restores a revision by creating a new checkpoint", async () => {
    const { application } = createFixture();
    const created = await createProject(application);
    const projectId = created.state.project.id;
    success(
      await application.saveDraft({
        projectId,
        source: INVALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      }),
    );

    const restoredValid = success(
      await application.restoreRevision({
        projectId,
        revisionNo: 1,
        expectedSchemaRevisionNo: 2,
      }),
    );
    expect(restoredValid.state.currentRevision).toMatchObject({
      revisionNo: 3,
      source: VALID_SOURCE,
      validity: "VALID",
      origin: "RESTORE",
    });
    expect(restoredValid.state.lastValidRevision?.id).toBe(restoredValid.state.currentRevision.id);

    const restoredInvalid = success(
      await application.restoreRevision({
        projectId,
        revisionNo: 2,
        expectedSchemaRevisionNo: 3,
      }),
    );
    expect(restoredInvalid.state.currentRevision).toMatchObject({
      revisionNo: 4,
      source: INVALID_SOURCE,
      validity: "INVALID",
      origin: "RESTORE",
    });
    expect(restoredInvalid.state.lastValidRevision?.id).toBe(
      restoredValid.state.currentRevision.id,
    );
  });

  it("returns explicit missing project and revision failures", async () => {
    const { application } = createFixture();
    expect(failure(await application.getProject("missing")).error.code).toBe("PROJECT_NOT_FOUND");

    const created = await createProject(application);
    const missingRevision = failure(
      await application.restoreRevision({
        projectId: created.state.project.id,
        revisionNo: 999,
        expectedSchemaRevisionNo: 1,
      }),
    );
    expect(missingRevision.error.code).toBe("PROJECT_REVISION_NOT_FOUND");
  });
});

describe("revision retention and invariants", () => {
  it("keeps 100 recent non-checkpoints, all checkpoints, and an older last-valid revision", async () => {
    const { application, persistence } = createFixture();
    const created = await createProject(application);
    const projectId = created.state.project.id;
    const lastValidRevisionId = created.state.currentRevision.id;

    persistence.transaction((transaction) => {
      let current: SchemaRevision | null = null;
      for (let revisionNo = 2; revisionNo <= 105; revisionNo += 1) {
        current = {
          id: `seed-${revisionNo}`,
          projectId,
          revisionNo,
          source: `invalid ${revisionNo}`,
          sourceHash: `hash-${revisionNo}`,
          validity: "INVALID",
          origin: revisionNo === 3 ? "RESTORE" : "SOURCE_EDIT",
          parserVersion: DBML_PARSER_VERSION,
          diagnosticSummary: {
            errors: 1,
            warnings: 0,
            infos: 0,
            parserVersion: DBML_PARSER_VERSION,
          },
          createdAt: `2026-08-27T01:02:03.${String(revisionNo).padStart(3, "0")}Z`,
        };
        transaction.insertRevision(current);
      }
      if (!current) throw new Error("expected seeded current revision");
      const project = transaction.getProject(projectId);
      if (!project) throw new Error("expected seeded project");
      transaction.updateProject(
        {
          ...project,
          draftSource: current.source,
          draftHash: current.sourceHash,
          lastValidRevisionId,
          schemaRevisionNo: current.revisionNo,
          updatedAt: current.createdAt,
        },
        1,
      );
    });

    const saved = success(
      await application.saveDraft({
        projectId,
        source: "Table still_broken {",
        expectedSchemaRevisionNo: 105,
      }),
    );
    const revisions = success(await application.listRevisions(projectId));
    const nonCheckpoints = revisions.filter((revision) =>
      ["SOURCE_EDIT", "VISUAL_COMMAND"].includes(revision.origin),
    );

    expect(saved.state.lastValidRevision?.id).toBe(lastValidRevisionId);
    expect(nonCheckpoints).toHaveLength(NON_CHECKPOINT_REVISION_LIMIT + 1);
    expect(nonCheckpoints.some(({ id }) => id === lastValidRevisionId)).toBe(true);
    expect(
      revisions.some(({ revisionNo, origin }) => revisionNo === 3 && origin === "RESTORE"),
    ).toBe(true);
    expect(revisions.some(({ revisionNo }) => revisionNo === 2)).toBe(false);
  });

  it("fails closed when the stored last-valid pointer references an invalid revision", async () => {
    const { application, persistence } = createFixture();
    const created = await createProject(application, INVALID_SOURCE);
    const project = created.state.project;
    persistence.projects.set(project.id, {
      ...project,
      lastValidRevisionId: created.state.currentRevision.id,
    });

    const result = failure(await application.getProject(project.id));
    expect(result.error.code).toBe("PROJECT_STORAGE_INVARIANT_VIOLATION");
  });
});
