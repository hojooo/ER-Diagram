import { Parser } from "@dbml/core";
import {
  sqlCapabilityFixtures,
  sqlImportReportFixtures,
  sqlParserErrorFixtures,
} from "@er-diagram/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  convertSqlImport,
  type SqlCapabilityId,
  type SqlClauseConversion,
  type SqlStatementConversion,
  SQL_CONVERSION_REPORT_VERSION,
} from "../src/index.js";
import { verifySqlModelToGraph } from "../src/sql-import-semantics.js";

describe("SQL import conversion report", () => {
  it("maps every atomic capability fixture to its observed runtime status", async () => {
    for (const fixture of sqlCapabilityFixtures) {
      const result = await convertSqlImport({
        dialect: fixture.dialect,
        source: fixture.source,
        filepath: `/fixtures/${fixture.id}.sql`,
      });

      expect(result.ok, fixture.id).toBe(true);
      if (!result.ok) continue;
      const subject = findCapability(result.report.statements, fixture.capabilityId);
      expect(subject, fixture.id).toBeDefined();
      expect(subject?.status, fixture.id).toBe(fixture.observedStatus);
      expect(result.report.semanticVerification.status, fixture.id).toBe("VERIFIED");
      expect(result.report.sourceHash, fixture.id).toBe(fixture.sourceHash);
      expect(result.report.parserInputHash, fixture.id).toBe(fixture.sourceHash);
      if (fixture.capabilityId !== "DML") {
        expect(result.report.candidateDbmlHash, fixture.id).toBe(fixture.expectedGeneratedDbmlHash);
        expect(result.candidate.dbmlHash, fixture.id).toBe(fixture.expectedGeneratedDbmlHash);
      }
      expect(result.candidate.graph.schemaHash, fixture.id).toBe(fixture.expectedSchemaHash);

      if (fixture.capabilityId === "DML" || fixture.capabilityId === "COPY_DATA") {
        expect(result.report.applyEligible, fixture.id).toBe(false);
        expect(result.candidate.dbml, fixture.id).not.toContain("Records");
      }
    }
  });

  it("publishes nested statement and clause evidence with exact source ranges", async () => {
    for (const fixture of sqlImportReportFixtures) {
      const result = await convertSqlImport({
        dialect: fixture.dialect,
        source: fixture.source,
        filepath: fixture.filepath,
      });

      expect(result.ok, fixture.id).toBe(true);
      if (!result.ok) continue;
      expect(result.report.reportVersion).toBe(SQL_CONVERSION_REPORT_VERSION);
      expect(result.report.overallStatus, fixture.id).toBe(fixture.expectedOverallStatus);
      expect(result.report.applyEligible, fixture.id).toBe(fixture.expectedApplyEligible);
      expect(result.report.statements).toHaveLength(fixture.expectedStatements.length);

      for (const [index, expected] of fixture.expectedStatements.entries()) {
        const statement = result.report.statements[index];
        expect(statement, `${fixture.id}:statement:${index + 1}`).toBeDefined();
        if (!statement) continue;
        expect(statement.statementNo).toBe(index + 1);
        expect(statement.kind).toBe(expected.kind);
        expect(statement.status).toBe(expected.status);
        expect(sliceRange(fixture.source, statement.range)).toBe(expected.sourceFragment);

        for (const expectedClause of expected.clauses) {
          const clause = statement.clauses.find(
            (candidate) =>
              candidate.capabilityId === expectedClause.capabilityId &&
              sliceRange(fixture.source, candidate.range) === expectedClause.sourceFragment,
          );
          expect(
            clause,
            `${fixture.id}:${expectedClause.capabilityId}:${expectedClause.sourceFragment}`,
          ).toBeDefined();
          expect(clause?.status).toBe(expectedClause.status);
        }
      }

      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      expect(structuredClone(result)).toEqual(result);

      const repeated = await convertSqlImport({
        dialect: fixture.dialect,
        source: fixture.source,
        filepath: fixture.filepath,
      });
      expect(repeated).toEqual(result);
    }
  });

  it("returns redacted stable diagnostics for wrong-dialect and EOF errors", async () => {
    for (const fixture of sqlParserErrorFixtures) {
      const result = await convertSqlImport({
        dialect: fixture.dialect,
        source: fixture.source,
        filepath: `custom/${fixture.id}.sql`,
      });

      expect(result.ok, fixture.id).toBe(false);
      expect(result.candidate, fixture.id).toBeNull();
      expect(result.report.overallStatus, fixture.id).toBe("ERROR");
      expect(result.report.semanticVerification.status, fixture.id).toBe("NOT_RUN");
      expect(result.report.diagnostics[0], fixture.id).toMatchObject({
        code: `SQL_PARSE_${fixture.dialect}_SYNTAX`,
        severity: "ERROR",
        range: {
          filepath: `custom/${fixture.id}.sql`,
          startLine: fixture.expectedError.startLine,
          startColumn: fixture.expectedError.startColumn + 1,
        },
      });
      expect(JSON.stringify(result.report), fixture.id).not.toContain(
        fixture.expectedError.messageIncludes,
      );
    }

    const eof = await convertSqlImport({
      dialect: "POSTGRESQL",
      source: "CREATE TABLE broken (id bigint",
    });
    expect(eof.ok).toBe(false);
    expect(eof.report.diagnostics[0]?.range).toMatchObject({
      startOffset: 30,
      endOffset: 30,
      startLine: 1,
      startColumn: 31,
      endLine: 1,
      endColumn: 31,
    });
  });

  it("keeps semicolons inside comments, strings, dollar quotes, and routines", async () => {
    const postgresql = await convertSqlImport({
      dialect: "POSTGRESQL",
      source: `CREATE TABLE first_table (value text DEFAULT ';');
-- ignored ; delimiter
/* outer comment ; /* nested ; */ still comment ; */
CREATE FUNCTION synthetic_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
CREATE TABLE second_table (id bigint);
`,
    });
    expect(postgresql.report.statements.map((statement) => statement.kind)).toEqual([
      "CREATE_TABLE",
      "ROUTINE",
      "CREATE_TABLE",
    ]);

    const mysql = await convertSqlImport({
      dialect: "MYSQL",
      source: `CREATE TABLE first_table (value varchar(255) DEFAULT 'quoted\\';still');
CREATE PROCEDURE synthetic_proc() BEGIN SELECT ';'; SELECT 2; END;
CREATE TABLE second_table (id bigint);
`,
    });
    expect(mysql.report.statements.map((statement) => statement.kind)).toEqual([
      "CREATE_TABLE",
      "ROUTINE",
      "CREATE_TABLE",
    ]);

    const mysqlTrigger = await convertSqlImport({
      dialect: "MYSQL",
      source: `CREATE TABLE trigger_table (id bigint);
CREATE TRIGGER synthetic_trigger BEFORE INSERT ON trigger_table FOR EACH ROW BEGIN SET NEW.id = 1; SET NEW.id = 2; END;
CREATE TABLE after_trigger (id bigint);
`,
    });
    expect(mysqlTrigger.report.statements.map((statement) => statement.kind)).toEqual([
      "CREATE_TABLE",
      "TRIGGER",
      "CREATE_TABLE",
    ]);
  });

  it("fails closed for empty input and unknown accepted syntax", async () => {
    const empty = await convertSqlImport({
      dialect: "POSTGRESQL",
      source: " -- comment only\r\n ; /* and trivia */ ",
    });
    expect(empty).toMatchObject({
      ok: false,
      candidate: null,
      report: {
        overallStatus: "ERROR",
        applyEligible: false,
        statements: [],
        diagnostics: [{ code: "SQL_PARSE_EMPTY_INPUT", severity: "ERROR" }],
      },
    });

    const unknownStatement = await convertSqlImport({
      dialect: "POSTGRESQL",
      source: "VACUUM synthetic_table;",
    });
    expect(unknownStatement.report.statements[0]).toMatchObject({
      kind: "UNKNOWN",
      status: "UNSUPPORTED",
      code: "SQL_UNSUPPORTED_UNKNOWN_STATEMENT",
    });
    expect(unknownStatement.report.applyEligible).toBe(false);

    const unknownClause = await convertSqlImport({
      dialect: "POSTGRESQL",
      source: "CREATE TABLE samples(id bigint) WITH (fillfactor=70);",
    });
    expect(unknownClause.ok).toBe(true);
    expect(unknownClause.report.statements[0]?.clauses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: null,
          status: "UNSUPPORTED",
          code: "SQL_UNSUPPORTED_UNKNOWN_CLAUSE",
        }),
      ]),
    );

    const unknownIndexClause = await convertSqlImport({
      dialect: "POSTGRESQL",
      source:
        "CREATE TABLE samples(id bigint, value text); CREATE INDEX samples_ix ON samples(id) INCLUDE (value);",
    });
    expect(unknownIndexClause.ok).toBe(true);
    expect(unknownIndexClause.report.statements[1]).toMatchObject({
      kind: "CREATE_INDEX",
      status: "UNSUPPORTED",
      clauses: [
        expect.objectContaining({
          capabilityId: null,
          status: "UNSUPPORTED",
          code: "SQL_UNSUPPORTED_UNKNOWN_CLAUSE",
        }),
      ],
    });
  });

  it("excludes every data statement from schema apply and candidate records", async () => {
    const result = await convertSqlImport({
      dialect: "POSTGRESQL",
      source: `CREATE TABLE samples (id bigint);
INSERT INTO samples VALUES (1);
UPDATE samples SET id = 2;
DELETE FROM samples;
COPY samples (id) FROM '/synthetic/samples.csv';
`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.statements.map(({ kind }) => kind)).toEqual([
      "CREATE_TABLE",
      "DML",
      "DML",
      "DML",
      "COPY",
    ]);
    expect(result.report.statements.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "UNSUPPORTED",
          code: "SQL_UNSUPPORTED_DATA_STATEMENT",
        }),
      ]),
    );
    expect(result.report.applyEligible).toBe(false);
    expect(result.candidate.dbml).not.toContain("Records");
  });

  it("uses UTF-16 half-open ranges and preserves the caller filepath", async () => {
    const source = `-- 😀 synthetic\r\nCREATE TABLE "테이블" ("열" bigint GENERATED ALWAYS AS IDENTITY);\r\n`;
    const result = await convertSqlImport({
      dialect: "POSTGRESQL",
      source,
      filepath: "relative/스키마.sql",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const identity = findCapability(result.report.statements, "IDENTITY");
    expect(identity?.range.filepath).toBe("relative/스키마.sql");
    expect(identity?.range.startOffset).toBe(source.indexOf("GENERATED"));
    expect(identity?.range.startLine).toBe(2);
    expect(identity?.range.startColumn).toBe(32);
    expect(sliceRange(source, identity?.range)).toBe("GENERATED ALWAYS AS IDENTITY");
  });

  it("detects an unexpected SQL-model to candidate semantic mutation", async () => {
    const source = "CREATE TABLE samples(id bigint PRIMARY KEY, value text);\n";
    const database = Parser.parse(source, "postgres");
    const converted = await convertSqlImport({ dialect: "POSTGRESQL", source });
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;

    const mutated = structuredClone(converted.candidate.graph);
    mutated.tables[0]?.columns.pop();
    const verification = await verifySqlModelToGraph(database, mutated);
    expect(verification.status).toBe("FAILED");
    expect(verification.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "DELETE", elementKind: "column" }),
      ]),
    );
  });
});

type ConversionSubject = SqlStatementConversion | SqlClauseConversion;

function findCapability(
  statements: readonly SqlStatementConversion[],
  capabilityId: SqlCapabilityId,
): ConversionSubject | undefined {
  for (const statement of statements) {
    if (statement.capabilityId === capabilityId) return statement;
    const clause = statement.clauses.find((candidate) => candidate.capabilityId === capabilityId);
    if (clause) return clause;
  }
  return undefined;
}

function sliceRange(
  source: string,
  range: { startOffset: number; endOffset: number } | null | undefined,
): string | undefined {
  return range ? source.slice(range.startOffset, range.endOffset) : undefined;
}
