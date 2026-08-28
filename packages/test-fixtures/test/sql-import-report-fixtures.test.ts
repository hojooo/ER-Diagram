import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SQL_IMPORT_REPORT_FIXTURE_SET_HASH,
  SQL_IMPORT_REPORT_FIXTURE_VERSION,
  sqlImportReportFixtures,
} from "../src/index.js";

describe("versioned SQL import report fixtures", () => {
  it("publishes deterministic synthetic fixtures", () => {
    expect(SQL_IMPORT_REPORT_FIXTURE_VERSION).toBe(1);
    expect(SQL_IMPORT_REPORT_FIXTURE_SET_HASH).toMatch(/^[0-9a-f]{64}$/u);
    expect(structuredClone(sqlImportReportFixtures)).toEqual(sqlImportReportFixtures);

    const ids = sqlImportReportFixtures.map((fixture) => fixture.id);
    expect(ids).toEqual([...ids].sort(compareCodeUnits));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps statement and clause evidence inside its source", () => {
    for (const fixture of sqlImportReportFixtures) {
      expect(fixture.sourceHash).toBe(sha256(fixture.source));
      expect(fixture.source.endsWith("\n")).toBe(true);
      for (const statement of fixture.expectedStatements) {
        expect(fixture.source, `${fixture.id}:${statement.kind}`).toContain(
          statement.sourceFragment,
        );
        expect(statement.sourceFragment.endsWith(";")).toBe(true);
        for (const clause of statement.clauses) {
          expect(statement.sourceFragment, `${fixture.id}:${clause.capabilityId}`).toContain(
            clause.sourceFragment,
          );
        }
      }
    }
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
