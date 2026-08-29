import { describe, expect, it, vi } from "vitest";

import {
  createSqlExportApplication,
  type Project,
  type ProjectPersistenceReader,
  type SchemaRevision,
  type SqlExportConversionResult,
} from "../../src/index.js";

const PROJECT_ID = "project-1";
const SOURCE_HASH = "a".repeat(64);
const GENERATED_HASH = "b".repeat(64);

class FakeReader implements ProjectPersistenceReader {
  project: Project | null;
  revisions: SchemaRevision[];

  constructor(validity: "VALID" | "INVALID", withLastValid = true) {
    const valid = revision(1, "VALID", "Table users { id int [pk] }");
    const current = validity === "VALID" ? valid : revision(2, "INVALID", "Table users {");
    this.revisions = validity === "VALID" ? [valid] : [current, ...(withLastValid ? [valid] : [])];
    this.project = {
      id: PROJECT_ID,
      name: "Schema",
      primaryDialect: "POSTGRESQL",
      draftSource: current.source,
      draftHash: current.sourceHash,
      lastValidRevisionId: withLastValid ? valid.id : null,
      parserVersion: "9.1.1",
      schemaRevisionNo: current.revisionNo,
      layoutRevisionNo: 2,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
  }

  listProjects(): readonly Project[] {
    return this.project ? [this.project] : [];
  }
  getProject(projectId: string): Project | null {
    return projectId === PROJECT_ID ? this.project : null;
  }
  getRevisionById(projectId: string, revisionId: string): SchemaRevision | null {
    return projectId === PROJECT_ID
      ? (this.revisions.find(({ id }) => id === revisionId) ?? null)
      : null;
  }
  getRevisionByNumber(projectId: string, revisionNo: number): SchemaRevision | null {
    return projectId === PROJECT_ID
      ? (this.revisions.find((revision) => revision.revisionNo === revisionNo) ?? null)
      : null;
  }
  listRevisions(projectId: string): readonly SchemaRevision[] {
    return projectId === PROJECT_ID ? this.revisions : [];
  }
}

function revision(
  revisionNo: number,
  validity: "VALID" | "INVALID",
  source: string,
): SchemaRevision {
  return {
    id: `revision-${revisionNo}`,
    projectId: PROJECT_ID,
    revisionNo,
    source,
    sourceHash: revisionNo === 1 ? SOURCE_HASH : "c".repeat(64),
    validity,
    origin: "SOURCE_EDIT",
    parserVersion: "9.1.1",
    diagnosticSummary: {
      errors: validity === "INVALID" ? 1 : 0,
      warnings: 0,
      infos: 0,
      parserVersion: "9.1.1",
    },
    createdAt: "2026-08-29T00:00:00.000Z",
  };
}

function conversion(): SqlExportConversionResult {
  return {
    ok: true,
    candidate: { sql: "CREATE TABLE users (id int);", sqlHash: GENERATED_HASH },
    report: {
      reportVersion: 1,
      exportSemanticsVersion: 1,
      sourceFilepath: "/main.dbml",
      sourceHash: SOURCE_HASH,
      parserInputHash: SOURCE_HASH,
      primaryDialect: "POSTGRESQL",
      targetDialect: "POSTGRESQL",
      parserVersions: { dbmlCore: "9.1.1", dbmlParse: "9.1.1" },
      schemaSemanticsVersion: 1,
      ddlKind: "EMPTY_SCHEMA_CREATE",
      overallStatus: "EXACT",
      acknowledgementRequired: false,
      generatedSqlHash: GENERATED_HASH,
      containsDataStatements: false,
      entries: [],
      diagnostics: [],
      semanticVerification: {
        status: "VERIFIED",
        sourceExportableHash: SOURCE_HASH,
        generatedExportableHash: SOURCE_HASH,
        changes: [],
      },
    },
  };
}

describe("SQL export application", () => {
  it("exports a valid current draft in the primary dialect with layout provenance", async () => {
    const reader = new FakeReader("VALID");
    const convert = vi.fn(async () => conversion());
    const application = createSqlExportApplication({ persistence: reader, convert });

    const result = await application.exportProject({
      projectId: PROJECT_ID,
      expectedSchemaRevisionNo: 1,
      sourceSelection: "CURRENT_DRAFT",
    });

    expect(result).toMatchObject({
      ok: true,
      value: { sourceSelection: "CURRENT_DRAFT", revisionNo: 1, sourceHash: SOURCE_HASH },
    });
    expect(convert).toHaveBeenCalledWith({
      primaryDialect: "POSTGRESQL",
      targetDialect: "POSTGRESQL",
      source: reader.revisions[0]?.source,
      filepath: "/main.dbml",
      hasPersistedLayout: true,
    });
  });

  it("requires explicit last-valid selection for an invalid draft", async () => {
    const reader = new FakeReader("INVALID");
    const convert = vi.fn(async () => conversion());
    const application = createSqlExportApplication({ persistence: reader, convert });

    await expect(
      application.exportProject({
        projectId: PROJECT_ID,
        expectedSchemaRevisionNo: 2,
        sourceSelection: "CURRENT_DRAFT",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "SQL_EXPORT_CURRENT_DRAFT_INVALID" },
    });
    const exported = await application.exportProject({
      projectId: PROJECT_ID,
      expectedSchemaRevisionNo: 2,
      sourceSelection: "LAST_VALID",
    });
    expect(exported).toMatchObject({
      ok: true,
      value: { sourceSelection: "LAST_VALID", revisionNo: 1, sourceHash: SOURCE_HASH },
    });
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("rejects stale revisions, missing projects, and missing last-valid revisions", async () => {
    const reader = new FakeReader("INVALID", false);
    const application = createSqlExportApplication({
      persistence: reader,
      convert: async () => conversion(),
    });
    await expect(
      application.exportProject({
        projectId: PROJECT_ID,
        expectedSchemaRevisionNo: 1,
        sourceSelection: "LAST_VALID",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "SQL_EXPORT_SCHEMA_REVISION_CONFLICT", currentSchemaRevisionNo: 2 },
    });
    await expect(
      application.exportProject({
        projectId: PROJECT_ID,
        expectedSchemaRevisionNo: 2,
        sourceSelection: "LAST_VALID",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "SQL_EXPORT_LAST_VALID_NOT_FOUND" },
    });
    await expect(
      application.exportProject({
        projectId: "missing",
        expectedSchemaRevisionNo: 1,
        sourceSelection: "CURRENT_DRAFT",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "SQL_EXPORT_PROJECT_NOT_FOUND" },
    });
  });

  it("returns fatal converter reports without mutating project state", async () => {
    const reader = new FakeReader("VALID");
    const before = structuredClone(reader.project);
    const fatal = conversion();
    const application = createSqlExportApplication({
      persistence: reader,
      convert: async () => ({
        ok: false,
        candidate: null,
        report: { ...fatal.report, overallStatus: "ERROR", generatedSqlHash: null },
      }),
    });
    const result = await application.exportProject({
      projectId: PROJECT_ID,
      expectedSchemaRevisionNo: 1,
      sourceSelection: "CURRENT_DRAFT",
    });
    expect(result).toMatchObject({ ok: true, value: { candidate: null } });
    expect(reader.project).toEqual(before);
  });
});
