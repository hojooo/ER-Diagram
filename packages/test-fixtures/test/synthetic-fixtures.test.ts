import { describe, expect, it } from "vitest";

import {
  DEFAULT_FIXTURE_SEED,
  fixtureInventory,
  generateFidelityFixture,
  generateScaleFixture,
  sha256FixtureSource,
} from "../src/index.js";

interface ObservedInventory {
  readonly tables: number;
  readonly enums: number;
  readonly tablePartials: number;
  readonly tableGroups: number;
  readonly diagramViews: number;
  readonly references: number;
}

function countDeclarations(source: string, declaration: string): number {
  return source.match(new RegExp(`^${declaration}(?:\\s|:)`, "gmu"))?.length ?? 0;
}

function observeInventory(source: string): ObservedInventory {
  return {
    tables: countDeclarations(source, "Table"),
    enums: countDeclarations(source, "Enum"),
    tablePartials: countDeclarations(source, "TablePartial"),
    tableGroups: countDeclarations(source, "TableGroup"),
    diagramViews: countDeclarations(source, "DiagramView"),
    references: countDeclarations(source, "Ref"),
  };
}

describe("generateFidelityFixture", () => {
  it("generates the declared fidelity inventory", () => {
    const source = generateFidelityFixture();

    expect(observeInventory(source)).toEqual(fixtureInventory.fidelity);
  });

  it("contains the source-fidelity constructs used by parser and editor spikes", () => {
    const source = generateFidelityFixture();

    expect(source).toContain('Table catalog."Quoted Entity"');
    expect(source).toContain("Table core.entity_001");
    expect(source).toContain("~audit_fields");
    expect(source).toContain("Ref composite_tenant_identity:");
    expect(source).toContain("(parent_tenant_id, parent_id)");
    expect(source).toContain("DiagramView full_schema");
    expect(source).toContain('fixture_seed: "spc29cq"');
    expect(source).toContain("// Deterministic public synthetic fixture");
    expect(source).toContain("Note:");
  });
});

describe("generateScaleFixture", () => {
  it("generates exactly 200 tables and 1,000 references", () => {
    const source = generateScaleFixture();

    expect(observeInventory(source)).toEqual(fixtureInventory.scale);
  });
});

describe("synthetic fixture determinism", () => {
  it("uses the documented default seed", () => {
    expect(generateFidelityFixture()).toBe(generateFidelityFixture(DEFAULT_FIXTURE_SEED));
    expect(generateScaleFixture()).toBe(generateScaleFixture(DEFAULT_FIXTURE_SEED));
  });

  it("is byte-identical for the same seed", () => {
    const first = generateFidelityFixture(17);
    const second = generateFidelityFixture(17);

    expect(first).toBe(second);
    expect(sha256FixtureSource(first)).toBe(sha256FixtureSource(second));
  });

  it("changes safe synthetic metadata without changing inventory for another seed", () => {
    const first = generateFidelityFixture(17);
    const second = generateFidelityFixture(18);

    expect(first).not.toBe(second);
    expect(observeInventory(first)).toEqual(observeInventory(second));
    expect(first).toContain('fixture_seed: "sph"');
    expect(second).toContain('fixture_seed: "spi"');
  });

  it("rejects non-integer and unsafe seeds", () => {
    expect(() => generateFidelityFixture(1.5)).toThrowError("seed must be a safe integer");
    expect(() => generateScaleFixture(Number.MAX_SAFE_INTEGER + 1)).toThrowError(
      "seed must be a safe integer",
    );
  });

  it("returns a lowercase SHA-256 source hash", () => {
    expect(sha256FixtureSource("synthetic fixture")).toMatch(/^[0-9a-f]{64}$/u);
    expect(sha256FixtureSource("synthetic fixture")).not.toBe(
      sha256FixtureSource("synthetic fixture changed"),
    );
  });
});
