import { describe, expect, it } from "vitest";
import {
  prepareSqlImportForApply,
  SQL_DATA_POLICY_VERSION,
  type SqlImportPreparationInput,
} from "../src/index.js";

describe("SQL data exclusion and original source retention", () => {
  it("requires confirmation for every PostgreSQL data statement by default", async () => {
    const source = `CREATE TABLE samples (id bigint);
INSERT INTO samples VALUES (1);
UPDATE samples SET id = 2;
DELETE FROM samples;
COPY samples (id) FROM '/synthetic/samples.csv';
`;

    const prepared = await prepareSqlImportForApply({
      dialect: "POSTGRESQL",
      source,
    });

    expect(prepared.policy).toEqual({
      policyVersion: SQL_DATA_POLICY_VERSION,
      dataStatementNos: [2, 3, 4, 5],
      dataHandling: "CONFIRMATION_REQUIRED",
      applyReadiness: "DATA_EXCLUSION_CONFIRMATION_REQUIRED",
    });
    expect(prepared.artifactSource).toEqual({
      retention: "DISCARD",
      originalHash: prepared.conversion.report.sourceHash,
      originalSql: null,
    });
    expect(prepared.conversion.ok).toBe(true);
    if (!prepared.conversion.ok) return;
    expect(prepared.conversion.report.applyEligible).toBe(false);
    expect(
      prepared.conversion.report.statements.slice(1).map(({ status, code }) => ({ status, code })),
    ).toEqual(
      Array.from({ length: 4 }, () => ({
        status: "UNSUPPORTED",
        code: "SQL_UNSUPPORTED_DATA_STATEMENT",
      })),
    );
    expect(prepared.conversion.candidate.dbml).not.toContain("Records");
  });

  it("unlocks the same record-free candidate only after explicit DDL-only confirmation", async () => {
    const input: SqlImportPreparationInput = {
      dialect: "MYSQL",
      source: `CREATE TABLE samples (id bigint, note text);
INSERT INTO samples VALUES (1, 'synthetic row');
UPDATE samples SET note = 'updated';
DELETE FROM samples;
`,
    };

    const rejected = await prepareSqlImportForApply(input);
    const confirmed = await prepareSqlImportForApply({
      ...input,
      dataStatementHandling: "CONFIRM_DDL_ONLY",
    });

    expect(confirmed.policy).toEqual({
      policyVersion: SQL_DATA_POLICY_VERSION,
      dataStatementNos: [2, 3, 4],
      dataHandling: "CONFIRMED_DDL_ONLY",
      applyReadiness: "READY",
    });
    expect(confirmed.conversion.report.applyEligible).toBe(false);
    expect(confirmed.conversion).toEqual(rejected.conversion);
    expect(confirmed.artifactSource).toEqual(rejected.artifactSource);
    expect(JSON.stringify(confirmed.conversion)).not.toContain("synthetic row");
    expect(JSON.stringify(confirmed.conversion)).not.toContain("updated");
  });

  it("distinguishes DDL-only readiness from data-only input without schema elements", async () => {
    const ddlOnly = await prepareSqlImportForApply({
      dialect: "POSTGRESQL",
      source: "CREATE TABLE samples (id bigint);\n",
    });
    const dataOnly = await prepareSqlImportForApply({
      dialect: "POSTGRESQL",
      source: "INSERT INTO samples VALUES (1);\n",
      dataStatementHandling: "CONFIRM_DDL_ONLY",
    });

    expect(ddlOnly.policy).toEqual({
      policyVersion: SQL_DATA_POLICY_VERSION,
      dataStatementNos: [],
      dataHandling: "NOT_PRESENT",
      applyReadiness: "READY",
    });
    expect(ddlOnly.conversion.report.applyEligible).toBe(true);
    expect(dataOnly.policy).toEqual({
      policyVersion: SQL_DATA_POLICY_VERSION,
      dataStatementNos: [1],
      dataHandling: "CONFIRMED_DDL_ONLY",
      applyReadiness: "NO_SCHEMA_ELEMENTS",
    });
    expect(dataOnly.conversion.report.applyEligible).toBe(false);
  });

  it("does not expose a large synthetic row value unless original SQL retention is explicit", async () => {
    const sensitiveMarker = "SYNTHETIC_SENSITIVE_ROW_VALUE";
    const largeValue = `${sensitiveMarker}_${"x".repeat(256 * 1024)}`;
    const source = `CREATE TABLE samples (id bigint, payload text);
INSERT INTO samples VALUES (1, '${largeValue}');
`;

    const discarded = await prepareSqlImportForApply({
      dialect: "POSTGRESQL",
      source,
      dataStatementHandling: "CONFIRM_DDL_ONLY",
    });

    expect(discarded.policy.applyReadiness).toBe("READY");
    expect(discarded.artifactSource.originalSql).toBeNull();
    expect(JSON.stringify(discarded)).not.toContain(sensitiveMarker);
    expect(discarded.conversion.report.sourceHash).toBe(
      discarded.conversion.report.parserInputHash,
    );
    expect(discarded.artifactSource.originalHash).toBe(discarded.conversion.report.sourceHash);
  });

  it("preserves schema defaults while excluding row literals", async () => {
    const prepared = await prepareSqlImportForApply({
      dialect: "POSTGRESQL",
      source:
        "CREATE TABLE samples (note text DEFAULT 'SCHEMA_DEFAULT_SENTINEL'); " +
        "INSERT INTO samples VALUES ('ROW_DATA_SENTINEL');",
      dataStatementHandling: "CONFIRM_DDL_ONLY",
    });

    expect(prepared.conversion.ok).toBe(true);
    if (!prepared.conversion.ok) return;
    expect(prepared.conversion.candidate.dbml).toContain("SCHEMA_DEFAULT_SENTINEL");
    expect(JSON.stringify(prepared)).not.toContain("ROW_DATA_SENTINEL");
  });

  it("retains the exact original source only when explicitly selected", async () => {
    const source = `CREATE TABLE "자료" (id bigint, note text);\r\nINSERT INTO "자료" VALUES (1, '비밀 😀');\r\n`;
    const discarded = await prepareSqlImportForApply({
      dialect: "POSTGRESQL",
      source,
      dataStatementHandling: "CONFIRM_DDL_ONLY",
    });
    const retained = await prepareSqlImportForApply({
      dialect: "POSTGRESQL",
      source,
      dataStatementHandling: "CONFIRM_DDL_ONLY",
      originalSqlRetention: "RETAIN",
    });

    expect(retained.artifactSource).toEqual({
      retention: "RETAIN",
      originalHash: retained.conversion.report.sourceHash,
      originalSql: source,
    });
    expect(retained.conversion).toEqual(discarded.conversion);
    expect(JSON.stringify(retained.conversion)).not.toContain("비밀 😀");
  });

  it("retains an explicitly selected failed source but never exposes a candidate", async () => {
    const source = "CREATE TABLE broken (id bigint";
    const prepared = await prepareSqlImportForApply({
      dialect: "POSTGRESQL",
      source,
      originalSqlRetention: "RETAIN",
    });

    expect(prepared.policy).toEqual({
      policyVersion: SQL_DATA_POLICY_VERSION,
      dataStatementNos: [],
      dataHandling: "NOT_PRESENT",
      applyReadiness: "CONVERSION_FAILED",
    });
    expect(prepared.conversion.ok).toBe(false);
    expect(prepared.conversion.candidate).toBeNull();
    expect(prepared.artifactSource.originalSql).toBe(source);
  });

  it("fails closed for COPY FROM STDIN inline payload without rewriting parser input", async () => {
    const source = `CREATE TABLE samples (id bigint);
COPY samples (id) FROM STDIN;
1
\\.
`;
    const prepared = await prepareSqlImportForApply({
      dialect: "POSTGRESQL",
      source,
      dataStatementHandling: "CONFIRM_DDL_ONLY",
    });

    expect(prepared.conversion.ok).toBe(false);
    expect(prepared.conversion.candidate).toBeNull();
    expect(prepared.conversion.report.sourceHash).toBe(prepared.conversion.report.parserInputHash);
    expect(prepared.policy).toMatchObject({
      dataStatementNos: [2],
      dataHandling: "CONFIRMED_DDL_ONLY",
      applyReadiness: "CONVERSION_FAILED",
    });
    expect(prepared.artifactSource.originalSql).toBeNull();
  });

  it("returns deterministic plain data", async () => {
    const input: SqlImportPreparationInput = {
      dialect: "POSTGRESQL",
      source: "CREATE TABLE samples (id bigint); INSERT INTO samples VALUES (1);",
      dataStatementHandling: "CONFIRM_DDL_ONLY",
    };

    const first = await prepareSqlImportForApply(input);
    const second = await prepareSqlImportForApply(input);

    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(structuredClone(first)).toEqual(first);
  });
});
