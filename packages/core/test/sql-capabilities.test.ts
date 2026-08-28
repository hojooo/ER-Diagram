import { Parser, importer } from "@dbml/core";
import {
  sqlCapabilityFixtures,
  sqlParserErrorFixtures,
  type SqlFixtureDialect,
} from "@er-diagram/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  DBML_PARSER_VERSION,
  getSqlCapabilityAssessment,
  parseDbmlV2,
  sha256Utf8,
  type SqlCapabilityId,
  SQL_CAPABILITY_MATRIX_VERSION,
  sqlCapabilityMatrix,
} from "../src/index.js";

describe("versioned SQL capability matrix", () => {
  it("publishes parser provenance, dialect baselines, and deterministic plain data", () => {
    expect(SQL_CAPABILITY_MATRIX_VERSION).toBe(1);
    expect(sqlCapabilityMatrix).toMatchObject({
      matrixVersion: 1,
      parserVersions: {
        dbmlCore: DBML_PARSER_VERSION,
        dbmlParse: DBML_PARSER_VERSION,
      },
      dialectBaselines: {
        POSTGRESQL: {
          minimumVersion: "14",
          parserFormat: "postgres",
          versionDetection: "BASELINE_ONLY",
        },
        MYSQL: {
          minimumVersion: "8.0",
          parserFormat: "mysql",
          versionDetection: "BASELINE_ONLY",
        },
      },
    });
    expect(JSON.parse(JSON.stringify(sqlCapabilityMatrix))).toEqual(sqlCapabilityMatrix);
    expect(structuredClone(sqlCapabilityMatrix)).toEqual(sqlCapabilityMatrix);

    const ids = sqlCapabilityMatrix.entries.map((entry) => entry.id);
    expect(ids).toEqual([...ids].sort(compareCodeUnits));
    expect(new Set(ids).size).toBe(ids.length);

    for (const entry of sqlCapabilityMatrix.entries) {
      expect(Object.keys(entry.dialects).sort(compareCodeUnits), entry.id).toEqual([
        "MYSQL",
        "POSTGRESQL",
      ]);
      for (const assessment of Object.values(entry.dialects)) {
        expect(assessment.targetStatus).not.toBe("ERROR");
        expect(assessment.observedStatus).not.toBe("ERROR");
      }
    }
  });

  it("keeps P0 targets separate from the two observed PostgreSQL gaps", () => {
    expect(getSqlCapabilityAssessment("IDENTITY", "POSTGRESQL")).toEqual({
      targetStatus: "NORMALIZED",
      observedStatus: "PARTIAL",
      observedOutcome: "PARTIALLY_PRESERVED",
    });
    expect(getSqlCapabilityAssessment("ARRAY_SCHEMA_ENUM", "POSTGRESQL")).toEqual({
      targetStatus: "EXACT",
      observedStatus: "PARTIAL",
      observedOutcome: "PARTIALLY_PRESERVED",
    });
    expect(getSqlCapabilityAssessment("AUTO_INCREMENT", "POSTGRESQL")).toEqual({
      targetStatus: "NOT_APPLICABLE",
      observedStatus: "NOT_APPLICABLE",
      observedOutcome: "NOT_APPLICABLE",
    });
    expect(getSqlCapabilityAssessment("SERIAL", "MYSQL")).toEqual({
      targetStatus: "NOT_APPLICABLE",
      observedStatus: "NOT_APPLICABLE",
      observedOutcome: "NOT_APPLICABLE",
    });
    expect(() =>
      getSqlCapabilityAssessment("UNKNOWN_CAPABILITY" as SqlCapabilityId, "POSTGRESQL"),
    ).toThrowError("Unknown SQL capability: UNKNOWN_CAPABILITY");
  });

  it("maps every executable fixture to the public target and observed assessment", async () => {
    const covered = new Set<string>();

    for (const fixture of sqlCapabilityFixtures) {
      const assessment = getSqlCapabilityAssessment(fixture.capabilityId, fixture.dialect);
      expect(assessment, fixture.id).toEqual({
        targetStatus: fixture.targetStatus,
        observedStatus: fixture.observedStatus,
        observedOutcome: fixture.observedOutcome,
      });
      covered.add(`${fixture.capabilityId}:${fixture.dialect}`);
      expect(await sha256Utf8(fixture.source), fixture.id).toBe(fixture.sourceHash);

      const format = parserFormat(fixture.dialect);
      expect(() => Parser.parse(fixture.source, format), fixture.id).not.toThrow();
      const generatedDbml = importer.import(fixture.source, format);
      expect(await sha256Utf8(generatedDbml), fixture.id).toBe(fixture.expectedGeneratedDbmlHash);

      for (const fragment of fixture.preservedDbmlFragments) {
        expect(generatedDbml, `${fixture.id} preserves ${fragment}`).toContain(fragment);
      }
      for (const fragment of fixture.droppedDbmlFragments) {
        expect(generatedDbml, `${fixture.id} drops ${fragment}`).not.toContain(fragment);
      }

      const parsed = await parseDbmlV2(generatedDbml, `/${fixture.id}.dbml`);
      expect(parsed.ok, fixture.id).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.graph.schemaHash, fixture.id).toBe(fixture.expectedSchemaHash);
      expect(
        {
          tables: parsed.graph.tables.length,
          enums: parsed.graph.enums.length,
          references: parsed.graph.references.length,
        },
        fixture.id,
      ).toEqual(fixture.expectedInventory);
    }

    const expectedCoverage = sqlCapabilityMatrix.entries.flatMap((entry) =>
      (["POSTGRESQL", "MYSQL"] as const)
        .filter((dialect) => entry.dialects[dialect].targetStatus !== "NOT_APPLICABLE")
        .map((dialect) => `${entry.id}:${dialect}`),
    );
    expect([...covered].sort(compareCodeUnits)).toEqual(expectedCoverage.sort(compareCodeUnits));
  });

  it("captures wrong-dialect errors without treating ERROR as static capability status", () => {
    for (const fixture of sqlParserErrorFixtures) {
      expect(() => Parser.parse(fixture.source, parserFormat(fixture.dialect))).toThrowError(
        expect.objectContaining({
          diags: expect.arrayContaining([
            expect.objectContaining({
              text: expect.stringContaining(fixture.expectedError.messageIncludes),
              location: {
                start: {
                  line: fixture.expectedError.startLine,
                  column: fixture.expectedError.startColumn,
                },
              },
            }),
          ]),
        }),
      );
    }
  });
});

function parserFormat(dialect: SqlFixtureDialect): "postgres" | "mysql" {
  return dialect === "POSTGRESQL" ? "postgres" : "mysql";
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
