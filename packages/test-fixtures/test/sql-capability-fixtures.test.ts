import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SQL_CAPABILITY_FIXTURE_SET_HASH,
  SQL_CAPABILITY_FIXTURE_VERSION,
  sqlCapabilityFixtures,
  sqlParserErrorFixtures,
} from "../src/index.js";

const EXPECTED_CAPABILITY_IDS = [
  "ALTER_ADD_FOREIGN_KEY",
  "ALTER_ADD_UNIQUE",
  "ALTER_COLUMN_MUTATION",
  "ARRAY_BUILTIN",
  "ARRAY_SCHEMA_ENUM",
  "AUTO_INCREMENT",
  "BASIC_CONSTRAINTS",
  "COMMENTS",
  "COMPOSITE_KEYS",
  "COPY_DATA",
  "CREATE_TABLE",
  "DML",
  "DROP_STATEMENT",
  "ENUM",
  "FOREIGN_KEY_ACTIONS",
  "FUNCTION_INDEX",
  "GENERATED_COLUMN",
  "IDENTITY",
  "INDEX_METHODS",
  "MYSQL_INDEXES",
  "MYSQL_TABLE_OPTIONS",
  "PARTIAL_INDEX",
  "PROCEDURE_OR_FUNCTION_BODY",
  "SCHEMA_QUALIFIED_TABLE",
  "SERIAL",
  "TABLESPACE",
  "TRIGGER",
  "VIEW",
] as const;

const EXPECTED_FIXTURE_SET_HASH =
  "652cf143c583a4369b064de55fba4624020bf53f2dfd5dfa3f08241a07e16832";

describe("versioned SQL capability fixtures", () => {
  it("publishes deterministic version 1 fixture metadata", () => {
    expect(SQL_CAPABILITY_FIXTURE_VERSION).toBe(1);
    expect(SQL_CAPABILITY_FIXTURE_SET_HASH).toBe(EXPECTED_FIXTURE_SET_HASH);
    expect(structuredClone(sqlCapabilityFixtures)).toEqual(sqlCapabilityFixtures);
    expect(structuredClone(sqlParserErrorFixtures)).toEqual(sqlParserErrorFixtures);
  });

  it("covers the complete capability catalog with stable atomic fixtures", () => {
    const fixtureIds = sqlCapabilityFixtures.map((fixture) => fixture.id);
    expect(fixtureIds).toEqual([...fixtureIds].sort(compareCodeUnits));
    expect(new Set(fixtureIds).size).toBe(fixtureIds.length);

    const capabilityIds = [
      ...new Set(sqlCapabilityFixtures.map((fixture) => fixture.capabilityId)),
    ];
    expect(capabilityIds.sort(compareCodeUnits)).toEqual(EXPECTED_CAPABILITY_IDS);

    for (const fixture of sqlCapabilityFixtures) {
      expect(fixture.source.endsWith("\n"), fixture.id).toBe(true);
      expect(fixture.sourceHash, fixture.id).toBe(sha256(fixture.source));
      expect(fixture.expectedGeneratedDbmlHash, fixture.id).toMatch(/^[0-9a-f]{64}$/u);
      expect(fixture.expectedSchemaHash, fixture.id).toMatch(/^[0-9a-f]{64}$/u);
      expect(fixture.expectedGeneratedDbmlHash, fixture.id).not.toBe("0".repeat(64));
      expect(fixture.expectedSchemaHash, fixture.id).not.toBe("0".repeat(64));
      expect(
        fixture.preservedDbmlFragments.length + fixture.droppedDbmlFragments.length,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps wrong-dialect parser failures separate from static capability status", () => {
    expect(sqlParserErrorFixtures.map((fixture) => fixture.id)).toEqual([
      "mysql-with-postgresql-syntax",
      "postgresql-with-mysql-syntax",
    ]);
    for (const fixture of sqlParserErrorFixtures) {
      expect(fixture.source.endsWith("\n"), fixture.id).toBe(true);
      expect(fixture.sourceHash, fixture.id).toBe(sha256(fixture.source));
      expect(fixture.expectedError.startLine).toBeGreaterThan(0);
      expect(fixture.expectedError.startColumn).toBeGreaterThan(0);
    }
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
