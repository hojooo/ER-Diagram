import {
  sqlExportRequestSchema,
  sqlExportResponseSchema,
  type SqlExportResponse,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const HASH = "a".repeat(64);

function response(candidate: SqlExportResponse["candidate"]): SqlExportResponse {
  return {
    sourceSelection: "CURRENT_DRAFT",
    revisionNo: 2,
    sourceHash: HASH,
    report: {
      reportVersion: 1,
      exportSemanticsVersion: 1,
      sourceFilepath: "/main.dbml",
      sourceHash: HASH,
      parserInputHash: HASH,
      primaryDialect: "POSTGRESQL",
      targetDialect: "POSTGRESQL",
      parserVersions: { dbmlCore: "9.1.1", dbmlParse: "9.1.1" },
      schemaSemanticsVersion: 1,
      ddlKind: "EMPTY_SCHEMA_CREATE",
      overallStatus: candidate ? "PARTIAL" : "ERROR",
      acknowledgementRequired: candidate !== null,
      generatedSqlHash: candidate?.sqlHash ?? null,
      containsDataStatements: false,
      entries: candidate
        ? [
            {
              code: "SQL_EXPORT_OMITS_TABLE_GROUP",
              status: "PARTIAL",
              message: "TableGroup definitions are not represented in SQL DDL.",
              occurrences: [
                {
                  elementKind: "group",
                  elementKey: "group-key",
                  range: {
                    filepath: "/main.dbml",
                    startOffset: 0,
                    endOffset: 10,
                    startLine: 1,
                    startColumn: 1,
                    endLine: 1,
                    endColumn: 11,
                  },
                },
              ],
            },
          ]
        : [],
      diagnostics: [],
      semanticVerification: candidate
        ? {
            status: "VERIFIED",
            sourceExportableHash: HASH,
            generatedExportableHash: HASH,
            changes: [],
          }
        : {
            status: "NOT_RUN",
            sourceExportableHash: null,
            generatedExportableHash: null,
            changes: [],
          },
    },
    candidate,
  };
}

describe("SQL export API contract", () => {
  it("accepts strict source selection requests", () => {
    const request = {
      expectedSchemaRevisionNo: 2,
      sourceSelection: "LAST_VALID" as const,
    };
    expect(sqlExportRequestSchema.parse(request)).toEqual(request);
    expect(
      sqlExportRequestSchema.safeParse({
        ...request,
        commandId: "550e8400-e29b-41d4-a716-446655440000",
      }).success,
    ).toBe(false);
    expect(
      sqlExportRequestSchema.safeParse({ ...request, sourceSelection: "AUTOMATIC" }).success,
    ).toBe(false);
  });

  it("validates successful and fatal response variants as plain data", () => {
    for (const value of [
      response({ sql: "CREATE TABLE users (id int);", sqlHash: HASH }),
      response(null),
    ]) {
      const parsed = sqlExportResponseSchema.parse(value);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
      const structuredCloneValue = (
        globalThis as unknown as { structuredClone<T>(input: T): T }
      ).structuredClone(parsed);
      expect(structuredCloneValue).toEqual(parsed);
    }
  });

  it("rejects mismatched hashes and unknown response fields", () => {
    const valid = response({ sql: "CREATE TABLE users (id int);", sqlHash: HASH });
    expect(sqlExportResponseSchema.safeParse({ ...valid, internalGraph: {} }).success).toBe(false);
    expect(
      sqlExportResponseSchema.safeParse({
        ...valid,
        candidate: { ...valid.candidate, sqlHash: "invalid" },
      }).success,
    ).toBe(false);
  });
});
