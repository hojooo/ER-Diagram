import { describe, expect, it } from "vitest";

import {
  conversionReportSchema,
  sqlImportApplyRequestSchema,
  sqlImportApplyResponseSchema,
  sqlImportArtifactEnvelopeSchema,
  sqlImportPreviewRequestSchema,
  sqlImportPreviewResponseSchema,
} from "../src/index.js";

const PROJECT_ID = "018f0f87-7b5a-7cc0-8000-000000000001";
const ARTIFACT_ID = "018f0f87-7b5a-7cc0-8000-000000000002";
const REVISION_ID = "018f0f87-7b5a-7cc0-8000-000000000003";
const COMMAND_ID = "123e4567-e89b-42d3-a456-426614174000";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const CREATED_AT = "2026-08-28T01:02:03.000Z";

function report() {
  return {
    reportVersion: 1 as const,
    dialect: "POSTGRESQL" as const,
    sourceFilepath: "/import.sql",
    sourceHash: HASH,
    parserInputHash: HASH,
    parserVersions: { dbmlCore: "9.1.1" as const, dbmlParse: "9.1.1" as const },
    capabilityMatrixVersion: 1 as const,
    schemaSemanticsVersion: 1 as const,
    overallStatus: "EXACT" as const,
    applyEligible: true,
    candidateDbmlHash: OTHER_HASH,
    statements: [
      {
        statementNo: 1,
        kind: "CREATE_TABLE" as const,
        capabilityId: "CREATE_TABLE" as const,
        status: "EXACT" as const,
        code: "SQL_EXACT_CREATE_TABLE",
        message: "Table definition is preserved.",
        range: {
          filepath: "/import.sql",
          startOffset: 0,
          endOffset: 31,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 32,
        },
        clauses: [],
      },
    ],
    diagnostics: [],
    semanticVerification: {
      status: "VERIFIED" as const,
      sourceModelHash: OTHER_HASH,
      candidateSchemaHash: OTHER_HASH,
      changes: [] as const,
    },
  };
}

function policy() {
  return {
    policyVersion: 1 as const,
    dataStatementNos: [] as number[],
    dataHandling: "NOT_PRESENT" as const,
    applyReadiness: "READY" as const,
  };
}

function state() {
  const revision = {
    id: REVISION_ID,
    projectId: PROJECT_ID,
    revisionNo: 2,
    source: "Table users { id bigint [pk] }\n",
    sourceHash: OTHER_HASH,
    validity: "VALID" as const,
    origin: "SQL_IMPORT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
    createdAt: CREATED_AT,
  };
  return {
    project: {
      id: PROJECT_ID,
      name: "Import project",
      primaryDialect: "POSTGRESQL" as const,
      draftSource: revision.source,
      draftHash: revision.sourceHash,
      lastValidRevisionId: REVISION_ID,
      parserVersion: "9.1.1",
      schemaRevisionNo: 2,
      layoutRevisionNo: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision: revision,
    lastValidRevision: revision,
  };
}

describe("SQL import preview and apply HTTP contracts", () => {
  it("accepts strict JSON-safe preview and apply envelopes", () => {
    const previewRequest = sqlImportPreviewRequestSchema.parse({
      commandId: COMMAND_ID,
      expectedSchemaRevisionNo: 1,
      dialect: "POSTGRESQL",
      source: "CREATE TABLE users (id bigint PRIMARY KEY);",
      originalSqlRetention: "RETAIN",
    });
    const previewResponse = sqlImportPreviewResponseSchema.parse({
      artifactId: ARTIFACT_ID,
      artifactStatus: "PREVIEWED",
      createdAt: CREATED_AT,
      baseSchemaRevisionNo: 1,
      previewHash: HASH,
      originalSqlRetention: "RETAIN",
      report: report(),
      policy: policy(),
      candidate: { dbml: "Table users { id bigint [pk] }\n", dbmlHash: OTHER_HASH },
    });
    const applyRequest = sqlImportApplyRequestSchema.parse({
      commandId: COMMAND_ID,
      expectedSchemaRevisionNo: 1,
      artifactId: ARTIFACT_ID,
      previewHash: HASH,
      source: previewRequest.source,
      dataStatementHandling: "CONFIRM_DDL_ONLY",
    });
    const applyResponse = sqlImportApplyResponseSchema.parse({
      artifactId: ARTIFACT_ID,
      artifactStatus: "APPLIED",
      previewHash: HASH,
      appliedAt: CREATED_AT,
      policy: policy(),
      state: state(),
      diagnostics: [],
      revisionCreated: true,
    });

    const clone = Reflect.get(globalThis, "structuredClone") as
      | ((value: unknown) => unknown)
      | undefined;
    expect(clone).toBeTypeOf("function");
    if (clone) {
      expect(clone(JSON.parse(JSON.stringify(previewRequest)))).toEqual(previewRequest);
      expect(clone(JSON.parse(JSON.stringify(previewResponse)))).toEqual(previewResponse);
      expect(clone(JSON.parse(JSON.stringify(applyRequest)))).toEqual(applyRequest);
      expect(clone(JSON.parse(JSON.stringify(applyResponse)))).toEqual(applyResponse);
    }
  });

  it("represents failed previews without exposing a candidate", () => {
    const failedReport = {
      ...report(),
      overallStatus: "ERROR" as const,
      applyEligible: false,
      candidateDbmlHash: null,
      statements: [],
      diagnostics: [
        {
          code: "SQL_PARSE_POSTGRESQL_SYNTAX",
          message: "Invalid SQL.",
          severity: "ERROR" as const,
        },
      ],
      semanticVerification: {
        status: "NOT_RUN" as const,
        sourceModelHash: null,
        candidateSchemaHash: null,
        changes: [] as const,
      },
    };
    const parsed = sqlImportPreviewResponseSchema.parse({
      artifactId: ARTIFACT_ID,
      artifactStatus: "FAILED",
      createdAt: CREATED_AT,
      baseSchemaRevisionNo: 1,
      previewHash: HASH,
      originalSqlRetention: "DISCARD",
      report: failedReport,
      policy: { ...policy(), applyReadiness: "CONVERSION_FAILED" },
      candidate: null,
    });

    expect(parsed.candidate).toBeNull();
    expect(conversionReportSchema.parse(failedReport)).toEqual(failedReport);
  });

  it("validates the versioned persisted preview evidence", () => {
    const envelope = sqlImportArtifactEnvelopeSchema.parse({
      previewVersion: 1,
      evidence: {
        projectId: PROJECT_ID,
        baseSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        sourceHash: HASH,
        candidateDbmlHash: OTHER_HASH,
        report: report(),
      },
      previewHash: HASH,
      previewPolicy: policy(),
      appliedPolicy: null,
      originalSqlRetention: "DISCARD",
    });

    const clone = Reflect.get(globalThis, "structuredClone") as
      | ((value: unknown) => unknown)
      | undefined;
    expect(clone).toBeTypeOf("function");
    if (clone) expect(clone(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
  });

  it("rejects unknown fields, invalid identifiers, hashes, enum values, and inconsistent variants", () => {
    const preview = {
      commandId: COMMAND_ID,
      expectedSchemaRevisionNo: 1,
      dialect: "POSTGRESQL",
      source: "CREATE TABLE users (id bigint);",
    };
    expect(sqlImportPreviewRequestSchema.safeParse({ ...preview, extra: true }).success).toBe(
      false,
    );
    expect(
      sqlImportPreviewRequestSchema.safeParse({ ...preview, commandId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(sqlImportPreviewRequestSchema.safeParse({ ...preview, dialect: "SQLITE" }).success).toBe(
      false,
    );
    expect(
      sqlImportApplyRequestSchema.safeParse({
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        artifactId: ARTIFACT_ID,
        previewHash: "ABC",
        source: preview.source,
      }).success,
    ).toBe(false);
    expect(
      conversionReportSchema.safeParse({
        ...report(),
        statements: [{ ...report().statements[0], capabilityId: "UNKNOWN_CAPABILITY" }],
      }).success,
    ).toBe(false);
    expect(
      conversionReportSchema.safeParse({
        ...report(),
        semanticVerification: {
          status: "FAILED",
          sourceModelHash: HASH,
          candidateSchemaHash: OTHER_HASH,
          changes: [
            {
              operation: "ADD",
              elementKind: "unknown-kind",
              key: "table:[]",
              parentKey: null,
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      sqlImportPreviewResponseSchema.safeParse({
        artifactId: ARTIFACT_ID,
        artifactStatus: "FAILED",
        createdAt: CREATED_AT,
        baseSchemaRevisionNo: 1,
        previewHash: HASH,
        originalSqlRetention: "DISCARD",
        report: report(),
        policy: policy(),
        candidate: { dbml: "Table users {}", dbmlHash: OTHER_HASH },
      }).success,
    ).toBe(false);
  });
});
