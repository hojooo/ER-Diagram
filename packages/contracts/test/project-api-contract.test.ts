import { describe, expect, it } from "vitest";

import {
  createProjectRequestSchema,
  deleteProjectRequestSchema,
  errorResponseSchema,
  projectMutationResponseSchema,
  projectParamsSchema,
  projectResponseSchema,
  projectRevisionsResponseSchema,
  renameProjectRequestSchema,
  restoreRevisionRequestSchema,
  revisionParamsSchema,
  saveDraftRequestSchema,
} from "../src/index.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const REVISION_ID = "019d3f4e-7b6c-7def-9abc-0123456789ab";
const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-08-27T01:02:03.004Z";
const cloneStructured = (globalThis as unknown as { structuredClone<T>(value: T): T })
  .structuredClone;

const diagnosticSummary = {
  errors: 0,
  warnings: 1,
  infos: 0,
  parserVersion: "9.1.1",
};

const revision = {
  id: REVISION_ID,
  projectId: PROJECT_ID,
  revisionNo: 1,
  source: "Table users { id int [pk] }",
  sourceHash: "source-hash",
  validity: "VALID",
  origin: "SOURCE_EDIT",
  parserVersion: "9.1.1",
  diagnosticSummary,
  createdAt: CREATED_AT,
};

const project = {
  id: PROJECT_ID,
  name: "Schema",
  primaryDialect: "POSTGRESQL",
  draftSource: revision.source,
  draftHash: revision.sourceHash,
  lastValidRevisionId: REVISION_ID,
  parserVersion: "9.1.1",
  schemaRevisionNo: 1,
  layoutRevisionNo: 0,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

describe("project HTTP request contracts", () => {
  it("accepts strict CREATE and DUPLICATE requests", () => {
    expect(
      createProjectRequestSchema.parse({
        operation: "CREATE",
        commandId: COMMAND_ID,
        name: "Schema",
        primaryDialect: "POSTGRESQL",
        source: revision.source,
      }),
    ).toEqual({
      operation: "CREATE",
      commandId: COMMAND_ID,
      name: "Schema",
      primaryDialect: "POSTGRESQL",
      source: revision.source,
    });

    expect(
      createProjectRequestSchema.parse({
        operation: "DUPLICATE",
        commandId: COMMAND_ID,
        sourceProjectId: PROJECT_ID,
        name: "Schema copy",
        expectedSchemaRevisionNo: 1,
      }),
    ).toEqual({
      operation: "DUPLICATE",
      commandId: COMMAND_ID,
      sourceProjectId: PROJECT_ID,
      name: "Schema copy",
      expectedSchemaRevisionNo: 1,
    });

    expect(
      createProjectRequestSchema.safeParse({
        operation: "CREATE",
        commandId: "not-a-uuid",
        name: "Schema",
        primaryDialect: "SQLITE",
        source: "",
      }).success,
    ).toBe(false);
    expect(
      createProjectRequestSchema.safeParse({
        operation: "CREATE",
        commandId: COMMAND_ID,
        name: "Schema",
        primaryDialect: "MYSQL",
        source: "",
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it("validates route params and every project write request", () => {
    expect(projectParamsSchema.parse({ projectId: PROJECT_ID })).toEqual({
      projectId: PROJECT_ID,
    });
    expect(revisionParamsSchema.parse({ projectId: PROJECT_ID, revisionNo: "2" })).toEqual({
      projectId: PROJECT_ID,
      revisionNo: 2,
    });
    expect(revisionParamsSchema.safeParse({ projectId: PROJECT_ID, revisionNo: "0" }).success).toBe(
      false,
    );

    for (const schema of [renameProjectRequestSchema, deleteProjectRequestSchema]) {
      const request = {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        ...(schema === renameProjectRequestSchema ? { name: "Renamed" } : {}),
      };
      expect(schema.safeParse(request).success).toBe(true);
      expect(schema.safeParse({ ...request, commandId: undefined }).success).toBe(false);
    }

    expect(
      saveDraftRequestSchema.safeParse({
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        source: "",
      }).success,
    ).toBe(true);
    expect(
      restoreRevisionRequestSchema.safeParse({
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
      }).success,
    ).toBe(true);
  });
});

describe("project HTTP response contracts", () => {
  it("validates project state and mutation responses as plain JSON data", () => {
    const state = {
      project,
      currentRevision: revision,
      lastValidRevision: revision,
    };
    const response = projectMutationResponseSchema.parse({
      state,
      diagnostics: [
        {
          code: "DBML_SEMANTIC_CARDINALITY",
          message: "Relationship cardinality was normalized.",
          severity: "WARNING",
        },
      ],
      revisionCreated: true,
    });

    expect(projectResponseSchema.parse({ state })).toEqual({ state });
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    expect(cloneStructured(response)).toEqual(response);
  });

  it("returns revision summaries without historical source", () => {
    const summary = {
      id: revision.id,
      projectId: revision.projectId,
      revisionNo: revision.revisionNo,
      sourceHash: revision.sourceHash,
      validity: revision.validity,
      origin: revision.origin,
      parserVersion: revision.parserVersion,
      diagnosticSummary: revision.diagnosticSummary,
      createdAt: revision.createdAt,
    };

    expect(projectRevisionsResponseSchema.parse({ revisions: [summary] })).toEqual({
      revisions: [summary],
    });
    expect(
      projectRevisionsResponseSchema.safeParse({
        revisions: [{ ...summary, source: revision.source }],
      }).success,
    ).toBe(false);
  });

  it("keeps the public error response strict and correlation-aware", () => {
    expect(
      errorResponseSchema.parse({
        code: "PROJECT_SCHEMA_REVISION_CONFLICT",
        message: "The project revision is stale.",
        correlationId: CORRELATION_ID,
        currentRevisionNo: 2,
        diagnostics: [],
      }),
    ).toEqual({
      code: "PROJECT_SCHEMA_REVISION_CONFLICT",
      message: "The project revision is stale.",
      correlationId: CORRELATION_ID,
      currentRevisionNo: 2,
      diagnostics: [],
    });
    expect(
      errorResponseSchema.safeParse({
        code: "INTERNAL_SERVER_ERROR",
        message: "Unexpected failure.",
        correlationId: CORRELATION_ID,
        stack: "secret",
      }).success,
    ).toBe(false);
  });
});
