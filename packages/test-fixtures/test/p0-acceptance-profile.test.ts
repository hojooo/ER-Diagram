import { describe, expect, it } from "vitest";

import {
  fixtureInventory,
  generateFidelityFixture,
  P0_ACCEPTANCE_PROFILE_HASH,
  P0_ACCEPTANCE_PROFILE_VERSION,
  p0AcceptanceProfile,
  sha256FixtureSource,
} from "../src/index.js";

const EXPECTED_PROFILE_HASH = "2ca56fd5688bc86467d04030e7d6fd9891ed1849fc7fb48ed7e1149727e3a95c";

describe("versioned complete P0 acceptance profile", () => {
  it("publishes deterministic dependency-free plain data", () => {
    expect(P0_ACCEPTANCE_PROFILE_VERSION).toBe(1);
    expect(P0_ACCEPTANCE_PROFILE_HASH).toBe(EXPECTED_PROFILE_HASH);
    expect(structuredClone(p0AcceptanceProfile)).toEqual(p0AcceptanceProfile);
    expect(JSON.parse(JSON.stringify(p0AcceptanceProfile))).toEqual(p0AcceptanceProfile);
  });

  it("binds the journey to the default public fidelity fixture", () => {
    const source = generateFidelityFixture();

    expect(p0AcceptanceProfile.fixture).toEqual({
      dialect: "POSTGRESQL",
      sourceHash: sha256FixtureSource(source),
      utf8Bytes: Buffer.byteLength(source, "utf8"),
      inventory: fixtureInventory.fidelity,
    });
    expect(p0AcceptanceProfile.fixture.inventory).toEqual({
      tables: 143,
      enums: 86,
      tablePartials: 4,
      tableGroups: 15,
      diagramViews: 7,
      references: 573,
    });
  });

  it("pins every group, view, journey assertion, and release-gate command", () => {
    expect(p0AcceptanceProfile.journey.groupNames).toEqual(
      Array.from(
        { length: 15 },
        (_, index) => `public.domain_${index.toString().padStart(2, "0")}`,
      ),
    );
    expect(p0AcceptanceProfile.journey.viewNames).toEqual([
      "full_schema",
      "focus_01",
      "focus_02",
      "focus_03",
      "focus_04",
      "focus_05",
      "focus_06",
    ]);
    expect(p0AcceptanceProfile.journey.visualTarget).toEqual({
      tableName: "core.entity_142",
      tableKey: 'table:["core","entity_142"]',
      columnName: "p0_acceptance_marker",
      columnType: "varchar",
    });

    const assertionIds = p0AcceptanceProfile.journey.assertions;
    expect(assertionIds).toEqual([...assertionIds].sort(compareCodeUnits));
    expect(new Set(assertionIds).size).toBe(assertionIds.length);

    expect(p0AcceptanceProfile.releaseGates.map(({ gate }) => gate)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
    ]);
    expect(p0AcceptanceProfile.releaseGates.flatMap(({ commands }) => commands)).toEqual(
      expect.arrayContaining([
        "pnpm ci:verify",
        "pnpm test:m1-gate",
        "pnpm test:m2-gate",
        "pnpm test:m3-gate",
        "pnpm test:accessibility",
        "pnpm test:container",
        "pnpm test:perf",
        "pnpm test:release",
        "pnpm test:runtime-lifecycle",
        "pnpm licenses:check",
        "pnpm sbom:check",
      ]),
    );
  });
});

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
