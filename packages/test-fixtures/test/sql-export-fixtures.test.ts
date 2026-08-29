import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SQL_EXPORT_FIXTURE_SET_HASH,
  SQL_EXPORT_FIXTURE_VERSION,
  sqlExportFixtures,
} from "../src/index.js";

const EXPECTED_FIXTURE_SET_HASH =
  "12a4e8904e432485b727371bc0fefa935f67e2a19428373c9ffbfb20a54ea9e2";

describe("versioned SQL export fixtures", () => {
  it("publishes deterministic synthetic fixtures", () => {
    expect(SQL_EXPORT_FIXTURE_VERSION).toBe(1);
    expect(SQL_EXPORT_FIXTURE_SET_HASH).toBe(EXPECTED_FIXTURE_SET_HASH);
    expect(structuredClone(sqlExportFixtures)).toEqual(sqlExportFixtures);

    const ids = sqlExportFixtures.map((fixture) => fixture.id);
    expect(ids).toEqual([...ids].sort(compareCodeUnits));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("pins source and successful output hashes", () => {
    for (const fixture of sqlExportFixtures) {
      expect(fixture.sourceHash, fixture.id).toBe(sha256(fixture.source));
      expect(fixture.source.endsWith("\n"), fixture.id).toBe(true);

      if (fixture.expectedOverallStatus === "ERROR") {
        expect(fixture.expectedGeneratedSqlHash, fixture.id).toBeNull();
        expect(fixture.expectedExportableSchemaHash, fixture.id).toBeNull();
        continue;
      }

      expect(fixture.expectedGeneratedSqlHash, fixture.id).toMatch(/^[0-9a-f]{64}$/u);
      expect(fixture.expectedExportableSchemaHash, fixture.id).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("keeps report codes ordered and free of duplicate evidence", () => {
    for (const fixture of sqlExportFixtures) {
      expect(fixture.expectedEntryCodes, fixture.id).toEqual(
        [...fixture.expectedEntryCodes].sort(compareCodeUnits),
      );
      expect(new Set(fixture.expectedEntryCodes).size, fixture.id).toBe(
        fixture.expectedEntryCodes.length,
      );
    }
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
