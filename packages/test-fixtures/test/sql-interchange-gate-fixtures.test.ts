import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SQL_INTERCHANGE_GATE_FIXTURE_SET_HASH,
  SQL_INTERCHANGE_GATE_FIXTURE_VERSION,
  sqlInterchangeGateFixtures,
} from "../src/index.js";

const EXPECTED_FIXTURE_SET_HASH =
  "f6735747bd5a33ab231651d4e52751ddace33ce86cb05b25ec68c432c1583bba";

describe("versioned SQL interchange gate fixtures", () => {
  it("publishes deterministic synthetic fixtures for both P0 dialects", () => {
    expect(SQL_INTERCHANGE_GATE_FIXTURE_VERSION).toBe(1);
    expect(SQL_INTERCHANGE_GATE_FIXTURE_SET_HASH).toBe(EXPECTED_FIXTURE_SET_HASH);
    expect(structuredClone(sqlInterchangeGateFixtures)).toEqual(sqlInterchangeGateFixtures);
    expect(sqlInterchangeGateFixtures.map(({ dialect }) => dialect)).toEqual([
      "MYSQL",
      "POSTGRESQL",
    ]);

    const ids = sqlInterchangeGateFixtures.map(({ id }) => id);
    expect(ids).toEqual([...ids].sort(compareCodeUnits));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("pins source, report, semantic, and generated output evidence", () => {
    for (const fixture of sqlInterchangeGateFixtures) {
      expect(fixture.sourceHash, fixture.id).toBe(sha256(fixture.source));
      expect(fixture.source.endsWith("\n"), fixture.id).toBe(true);
      expect(fixture.source, fixture.id).toContain(fixture.rowSentinel);
      expect(fixture.dataStatementHandling, fixture.id).toBe("CONFIRM_DDL_ONLY");
      expect(fixture.expectedInventory, fixture.id).toEqual({
        tables: 2,
        enums: 1,
        references: 1,
      });

      for (const hash of [
        fixture.expectedCandidateDbmlHash,
        fixture.expectedCandidateSchemaHash,
        fixture.expectedGeneratedSqlHash,
        fixture.expectedExportableSchemaHash,
      ]) {
        expect(hash, fixture.id).toMatch(/^[0-9a-f]{64}$/u);
        expect(hash, fixture.id).not.toBe("0".repeat(64));
      }
      expect(fixture.expectedExportEntryCodes, fixture.id).toEqual(
        [...fixture.expectedExportEntryCodes].sort(compareCodeUnits),
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
