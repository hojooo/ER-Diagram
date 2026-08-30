import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  VISUAL_COMMAND_GATE_FIXTURE_SET_HASH,
  VISUAL_COMMAND_GATE_FIXTURE_VERSION,
  visualCommandGateFixture,
} from "../src/index.js";

const EXPECTED_FIXTURE_SET_HASH =
  "909e2c737062cc0a67c060ad9d0a78ff7b0690a7d8349112babea6a763487710";
const EXPECTED_COMMAND_KINDS = [
  "CREATE_TABLE",
  "UPDATE_TABLE",
  "RENAME_TABLE",
  "CREATE_COLUMN",
  "UPDATE_COLUMN",
  "CREATE_REFERENCE",
  "CREATE_INDEX",
  "RENAME_COLUMN",
  "UPDATE_REFERENCE",
  "UPDATE_INDEX",
  "CREATE_CHECK",
  "UPDATE_CHECK",
  "DELETE_CHECK",
  "DELETE_REFERENCE",
  "DELETE_INDEX",
  "REORDER_COLUMN",
  "DELETE_COLUMN",
  "UPDATE_GROUP_MEMBERSHIP",
  "UPDATE_DIAGRAM_VIEW",
  "DELETE_TABLE",
] as const;

describe("versioned visual command gate fixture", () => {
  it("publishes dependency-free deterministic plain data", () => {
    expect(VISUAL_COMMAND_GATE_FIXTURE_VERSION).toBe(1);
    expect(VISUAL_COMMAND_GATE_FIXTURE_SET_HASH).toBe(EXPECTED_FIXTURE_SET_HASH);
    expect(structuredClone(visualCommandGateFixture)).toEqual(visualCommandGateFixture);
    expect(JSON.parse(JSON.stringify(visualCommandGateFixture))).toEqual(visualCommandGateFixture);
    expect(visualCommandGateFixture.initialSourceHash).toBe(
      sha256(visualCommandGateFixture.initialSource),
    );
  });

  it("covers every visual command kind exactly once in a successful deterministic sequence", () => {
    expect(visualCommandGateFixture.steps.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(visualCommandGateFixture.steps.map(({ command }) => command.kind)).toEqual(
      EXPECTED_COMMAND_KINDS,
    );
    expect(new Set(visualCommandGateFixture.steps.map(({ command }) => command.kind)).size).toBe(
      20,
    );
    expect(visualCommandGateFixture.steps.every(({ outcome }) => outcome === "SUCCESS")).toBe(true);
    expect(
      visualCommandGateFixture.steps.map(({ command }) => command.expectedSchemaRevisionNo),
    ).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("pins CRLF, Unicode, quoted, comment, metadata, partial, group, and view coverage", () => {
    const { initialSource, sentinels } = visualCommandGateFixture;

    expect(initialSource).toContain("\r\n");
    expect(initialSource.replaceAll("\r\n", "")).not.toContain("\n");
    expect(initialSource).toContain('catalog."고객 😀"');
    expect(initialSource).toContain("TablePartial audit_fields");
    expect(initialSource).toContain('TableGroup "identity 😀"');
    expect(initialSource).toContain('DiagramView "focus 😀"');
    for (const sentinel of sentinels) expect(initialSource).toContain(sentinel);
  });

  it("pins per-case hashes, semantic summaries, and separate no-op/failure evidence", () => {
    const cases = [
      ...visualCommandGateFixture.steps,
      ...visualCommandGateFixture.noOpCases,
      ...visualCommandGateFixture.failureCases,
    ];

    expect(visualCommandGateFixture.noOpCases.map(({ outcome }) => outcome)).toEqual(["NO_OP"]);
    expect(visualCommandGateFixture.failureCases.map(({ outcome }) => outcome)).toEqual([
      "FAILURE",
      "FAILURE",
      "FAILURE",
      "FAILURE",
    ]);
    for (const fixtureCase of cases) {
      for (const hash of [
        fixtureCase.beforeSourceHash,
        fixtureCase.afterSourceHash,
        fixtureCase.beforeSchemaHash,
        fixtureCase.afterSchemaHash,
      ]) {
        expect(hash, fixtureCase.id).toMatch(/^[0-9a-f]{64}$/u);
        expect(hash, fixtureCase.id).not.toBe("0".repeat(64));
      }
      expect(fixtureCase.semanticSummary.elementKinds, fixtureCase.id).toEqual(
        [...fixtureCase.semanticSummary.elementKinds].sort(compareCodeUnits),
      );
    }

    for (let index = 1; index < visualCommandGateFixture.steps.length; index += 1) {
      expect(visualCommandGateFixture.steps[index]?.beforeSourceHash).toBe(
        visualCommandGateFixture.steps[index - 1]?.afterSourceHash,
      );
      expect(visualCommandGateFixture.steps[index]?.beforeSchemaHash).toBe(
        visualCommandGateFixture.steps[index - 1]?.afterSchemaHash,
      );
    }
    for (const fixtureCase of [
      ...visualCommandGateFixture.noOpCases,
      ...visualCommandGateFixture.failureCases,
    ]) {
      expect(fixtureCase.afterSourceHash, fixtureCase.id).toBe(fixtureCase.beforeSourceHash);
      expect(fixtureCase.afterSchemaHash, fixtureCase.id).toBe(fixtureCase.beforeSchemaHash);
      expect(fixtureCase.semanticSummary, fixtureCase.id).toEqual({
        changeCount: 0,
        added: 0,
        updated: 0,
        deleted: 0,
        renameCandidates: 0,
        elementKinds: [],
      });
    }
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
