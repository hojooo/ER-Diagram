import {
  sqlCapabilityFixtures,
  sqlInterchangeGateFixtures,
  sqlParserErrorFixtures,
} from "@er-diagram/test-fixtures";
import { describe, expect, it } from "vitest";

import {
  convertDbmlToSqlExport,
  convertSqlImport,
  type ConversionReport,
  type ConversionStatus,
} from "../src/index.js";
import { verifyExportableSchemaGraphs } from "../src/sql-export-semantics.js";

const STATUS_RANK: Readonly<Record<ConversionStatus, number>> = {
  EXACT: 0,
  NORMALIZED: 1,
  PARTIAL: 2,
  UNSUPPORTED: 3,
  ERROR: 4,
};

describe("M2 same-dialect SQL interchange gate", () => {
  it("round-trips every successful atomic capability without unexplained semantic loss", async () => {
    expect(sqlCapabilityFixtures).toHaveLength(45);
    for (const fixture of sqlCapabilityFixtures) {
      const imported = await convertSqlImport({
        dialect: fixture.dialect,
        source: fixture.source,
        filepath: `/m2-gate/capabilities/${fixture.id}.sql`,
      });

      expect(imported.report.overallStatus, fixture.id).toBe(fixture.observedStatus);
      expect(imported.report.sourceHash, fixture.id).toBe(fixture.sourceHash);
      expect(imported.report.parserInputHash, fixture.id).toBe(fixture.sourceHash);
      assertLossEvidence(imported.report, fixture.id);
      if (!imported.ok) continue;

      const exported = await convertDbmlToSqlExport({
        primaryDialect: fixture.dialect,
        targetDialect: fixture.dialect,
        source: imported.candidate.dbml,
        filepath: `/m2-gate/capabilities/${fixture.id}.dbml`,
      });
      expect(exported.ok, fixture.id).toBe(true);
      expect(exported.report.semanticVerification.status, fixture.id).toBe("VERIFIED");
      expect(exported.report.containsDataStatements, fixture.id).toBe(false);
      assertExportLossEvidence(exported.report.entries, fixture.id);
      if (!exported.ok) continue;

      const reimported = await convertSqlImport({
        dialect: fixture.dialect,
        source: exported.candidate.sql,
        filepath: `/m2-gate/capabilities/${fixture.id}-round-trip.sql`,
      });
      if (
        !reimported.ok &&
        exported.report.entries.some(
          ({ code }) => code === "SQL_EXPORT_PARTIAL_POSTGRESQL_ENUM_ARRAY",
        )
      ) {
        expect(fixture.id).toBe("postgresql-array-schema-enum");
        expect(nonExactCodes(imported.report)).toContain("SQL_PARTIAL_ARRAY_SCHEMA_ENUM");
        expect(exported.report.entries).toContainEqual(
          expect.objectContaining({ code: "SQL_EXPORT_PARTIAL_POSTGRESQL_ENUM_ARRAY" }),
        );
        expect(reimported.candidate).toBeNull();
        expect(reimported.report.overallStatus).toBe("ERROR");
        continue;
      }
      expect(reimported.ok, fixture.id).toBe(true);
      if (!reimported.ok) continue;

      expect(
        reimported.report.statements.filter(({ kind }) => kind === "DML" || kind === "COPY"),
        fixture.id,
      ).toEqual([]);
      const verification = await verifyExportableSchemaGraphs(
        imported.candidate.graph,
        reimported.candidate.graph,
        fixture.dialect,
      );
      expect(verification.status, fixture.id).toBe("VERIFIED");
      expect(verification.changes, fixture.id).toEqual([]);

      if (fixture.id === "postgresql-identity") {
        expect(nonExactCodes(imported.report)).toContain("SQL_PARTIAL_IDENTITY");
      }
    }
  }, 120_000);

  it("fails closed for the versioned wrong-dialect parser corpus", async () => {
    for (const fixture of sqlParserErrorFixtures) {
      const result = await convertSqlImport({
        dialect: fixture.dialect,
        source: fixture.source,
        filepath: `/m2-gate/parser-errors/${fixture.id}.sql`,
      });
      expect(result.ok, fixture.id).toBe(false);
      expect(result.candidate, fixture.id).toBeNull();
      expect(result.report.overallStatus, fixture.id).toBe("ERROR");
      expect(result.report.diagnostics, fixture.id).not.toEqual([]);
    }
  });

  it("pins the representative PostgreSQL and MySQL interchange evidence", async () => {
    for (const fixture of sqlInterchangeGateFixtures) {
      const imported = await convertSqlImport({
        dialect: fixture.dialect,
        source: fixture.source,
        filepath: `/m2-gate/${fixture.id}.sql`,
      });
      expect(imported.ok, fixture.id).toBe(true);
      if (!imported.ok) continue;

      const exported = await convertDbmlToSqlExport({
        primaryDialect: fixture.dialect,
        targetDialect: fixture.dialect,
        source: imported.candidate.dbml,
        filepath: `/m2-gate/${fixture.id}.dbml`,
      });
      expect(exported.ok, fixture.id).toBe(true);
      if (!exported.ok) continue;

      const observed = {
        importOverallStatus: imported.report.overallStatus,
        importNonExactCodes: nonExactCodes(imported.report),
        candidateDbmlHash: imported.candidate.dbmlHash,
        candidateSchemaHash: imported.candidate.graph.schemaHash,
        exportOverallStatus: exported.report.overallStatus,
        exportEntryCodes: exported.report.entries.map(({ code }) => code),
        generatedSqlHash: exported.candidate.sqlHash,
        exportableSchemaHash:
          exported.report.semanticVerification.status === "VERIFIED"
            ? exported.report.semanticVerification.sourceExportableHash
            : null,
        inventory: {
          tables: imported.candidate.graph.tables.length,
          enums: imported.candidate.graph.enums.length,
          references: imported.candidate.graph.references.length,
        },
      };
      expect(observed, fixture.id).toEqual({
        importOverallStatus: fixture.expectedImportOverallStatus,
        importNonExactCodes: fixture.expectedImportNonExactCodes,
        candidateDbmlHash: fixture.expectedCandidateDbmlHash,
        candidateSchemaHash: fixture.expectedCandidateSchemaHash,
        exportOverallStatus: fixture.expectedExportOverallStatus,
        exportEntryCodes: fixture.expectedExportEntryCodes,
        generatedSqlHash: fixture.expectedGeneratedSqlHash,
        exportableSchemaHash: fixture.expectedExportableSchemaHash,
        inventory: fixture.expectedInventory,
      });

      expect(imported.report.sourceHash, fixture.id).toBe(fixture.sourceHash);
      expect(imported.report.parserInputHash, fixture.id).toBe(fixture.sourceHash);
      assertLossEvidence(imported.report, fixture.id);
      expect(exported.report.semanticVerification.status, fixture.id).toBe("VERIFIED");
      expect(exported.report.containsDataStatements, fixture.id).toBe(false);
      assertExportLossEvidence(exported.report.entries, fixture.id);

      const serialized = JSON.stringify({ imported, exported });
      expect(serialized, fixture.id).not.toContain(fixture.rowSentinel);
      expect(exported.candidate.sql, fixture.id).not.toContain(fixture.rowSentinel);
      expect(JSON.parse(JSON.stringify({ imported, exported })), fixture.id).toEqual({
        imported,
        exported,
      });
      expect(structuredClone({ imported, exported }), fixture.id).toEqual({ imported, exported });

      const repeatedImport = await convertSqlImport({
        dialect: fixture.dialect,
        source: fixture.source,
        filepath: `/m2-gate/${fixture.id}.sql`,
      });
      const repeatedExport = await convertDbmlToSqlExport({
        primaryDialect: fixture.dialect,
        targetDialect: fixture.dialect,
        source: imported.candidate.dbml,
        filepath: `/m2-gate/${fixture.id}.dbml`,
      });
      expect(repeatedImport, fixture.id).toEqual(imported);
      expect(repeatedExport, fixture.id).toEqual(exported);

      const reimported = await convertSqlImport({
        dialect: fixture.dialect,
        source: exported.candidate.sql,
        filepath: `/m2-gate/${fixture.id}-round-trip.sql`,
      });
      expect(reimported.ok, fixture.id).toBe(true);
      if (!reimported.ok) continue;
      const verification = await verifyExportableSchemaGraphs(
        imported.candidate.graph,
        reimported.candidate.graph,
        fixture.dialect,
      );
      expect(verification, fixture.id).toMatchObject({ status: "VERIFIED", changes: [] });
    }
  }, 120_000);

  it("blocks cross-dialect export before producing a candidate", async () => {
    for (const fixture of sqlInterchangeGateFixtures) {
      const imported = await convertSqlImport({ dialect: fixture.dialect, source: fixture.source });
      expect(imported.ok, fixture.id).toBe(true);
      if (!imported.ok) continue;

      const otherDialect = fixture.dialect === "POSTGRESQL" ? "MYSQL" : "POSTGRESQL";
      const blocked = await convertDbmlToSqlExport({
        primaryDialect: fixture.dialect,
        targetDialect: otherDialect,
        source: imported.candidate.dbml,
      });
      expect(blocked, fixture.id).toMatchObject({
        ok: false,
        candidate: null,
        report: {
          overallStatus: "ERROR",
          diagnostics: [{ code: "SQL_EXPORT_DIALECT_MISMATCH", severity: "ERROR" }],
        },
      });
    }
  });
});

function assertLossEvidence(report: ConversionReport, fixtureId: string): void {
  const evidence = report.statements.flatMap((statement) => [statement, ...statement.clauses]);
  for (const item of evidence.filter(({ status }) => STATUS_RANK[status] >= STATUS_RANK.PARTIAL)) {
    expect(item.code, fixtureId).toMatch(/^SQL_(?:PARTIAL|UNSUPPORTED|PARSE)_/u);
    expect(item.range.filepath, fixtureId).not.toBe("");
    expect(item.range.startOffset, fixtureId).toBeLessThanOrEqual(item.range.endOffset);
  }
}

function nonExactCodes(report: ConversionReport): string[] {
  return report.statements
    .flatMap((statement) => [statement, ...statement.clauses])
    .filter(({ status }) => status !== "EXACT")
    .map(({ code }) => code);
}

function assertExportLossEvidence(
  entries: readonly {
    status: ConversionStatus;
    code: string;
    occurrences: readonly { range: { filepath: string } | null }[];
  }[],
  fixtureId: string,
): void {
  for (const entry of entries.filter(
    ({ status }) => STATUS_RANK[status] >= STATUS_RANK.PARTIAL,
  )) {
    expect(entry.code, fixtureId).toMatch(/^SQL_EXPORT_(?:PARTIAL|OMITS|UNSUPPORTED)_/u);
    expect(entry.occurrences.length, `${fixtureId}:${entry.code}`).toBeGreaterThan(0);
    for (const occurrence of entry.occurrences) {
      expect(occurrence.range, `${fixtureId}:${entry.code}`).not.toBeNull();
      expect(occurrence.range?.filepath, `${fixtureId}:${entry.code}`).not.toBe("");
    }
  }
}
