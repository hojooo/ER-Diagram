import {
  type UpdateTableCommand,
  type VisualCommand,
  visualCommandSchema,
} from "@er-diagram/contracts";
import {
  diffSchemaGraphs,
  parseDbmlV2,
  qualifiedElementKey,
  type SchemaGraphDiff,
} from "@er-diagram/core";
import {
  fixtureInventory,
  generateFidelityFixture,
  sha256FixtureSource,
  type VisualCommandGateSemanticSummary,
  visualCommandGateFixture,
} from "@er-diagram/test-fixtures";
import { describe, expect, it } from "vitest";

import { applyTextEdits, transformVisualCommand } from "../src/index.js";
import { runVerifiedVisualTransform } from "../src/verified-transform.js";

describe("M3 visual command source-fidelity gate", () => {
  it("applies all 20 command kinds with exact source, reparse, and semantic evidence", async () => {
    let source = visualCommandGateFixture.initialSource;
    const observed: Array<{
      id: string;
      beforeSourceHash: string;
      afterSourceHash: string;
      beforeSchemaHash: string;
      afterSchemaHash: string;
      semanticSummary: VisualCommandGateSemanticSummary;
    }> = [];

    for (const step of visualCommandGateFixture.steps) {
      const before = await parseOrThrow(source);
      const command = visualCommandSchema.parse(step.command);
      const result = await transformVisualCommand(
        source,
        command,
        visualCommandGateFixture.filepath,
      );

      expect(result.ok, `${step.id}: ${JSON.stringify(result)}`).toBe(true);
      if (!result.ok) throw new Error(`${step.id}: ${JSON.stringify(result.diagnostics)}`);
      expect(result.changed, step.id).toBe(true);
      expect(applyTextEdits(source, result.edits), step.id).toEqual({
        ok: true,
        source: result.source,
      });

      const after = await parseOrThrow(result.source);
      const independentDiff = diffSchemaGraphs(before, after);
      expect(result.semanticDiff, step.id).toEqual(independentDiff);
      expect(result.beforeSchemaHash, step.id).toBe(before.schemaHash);
      expect(result.afterSchemaHash, step.id).toBe(after.schemaHash);
      expect(
        result.diagnostics.some(({ severity }) => severity === "ERROR"),
        step.id,
      ).toBe(false);
      expect(result.source.replaceAll("\r\n", ""), step.id).not.toContain("\n");
      for (const sentinel of visualCommandGateFixture.sentinels) {
        expect(result.source, `${step.id}: ${sentinel}`).toContain(sentinel);
      }
      if (step.id === "rename-column") {
        expect(result.source).toContain(
          "public.accounts.(backup_user_id, display_order) ?> public.users.(id, sort_order)",
        );
        expect(result.source).toContain("(backup_user_id, display_order)");
      }
      if (step.id === "create-column") {
        expect(result.edits).toContainEqual(
          expect.objectContaining({
            newText: expect.stringMatching(/^ {2}sort_order integer/u),
          }),
        );
      }

      observed.push({
        id: step.id,
        beforeSourceHash: sha256FixtureSource(source),
        afterSourceHash: sha256FixtureSource(result.source),
        beforeSchemaHash: before.schemaHash,
        afterSchemaHash: after.schemaHash,
        semanticSummary: summarizeDiff(independentDiff),
      });
      source = result.source;
    }

    expect(observed).toEqual(
      visualCommandGateFixture.steps.map((step) => ({
        id: step.id,
        beforeSourceHash: step.beforeSourceHash,
        afterSourceHash: step.afterSourceHash,
        beforeSchemaHash: step.beforeSchemaHash,
        afterSchemaHash: step.afterSchemaHash,
        semanticSummary: step.semanticSummary,
      })),
    );
  });

  it("returns explicit no-ops and rolls every rejected command back to the original source", async () => {
    const before = await parseOrThrow(visualCommandGateFixture.initialSource);
    const cases = [...visualCommandGateFixture.noOpCases, ...visualCommandGateFixture.failureCases];

    for (const fixtureCase of cases) {
      const command = visualCommandSchema.parse(fixtureCase.command);
      const result = await transformVisualCommand(
        visualCommandGateFixture.initialSource,
        command,
        visualCommandGateFixture.filepath,
      );

      expect(result.source, fixtureCase.id).toBe(visualCommandGateFixture.initialSource);
      if (fixtureCase.outcome === "NO_OP") {
        expect(result.ok, fixtureCase.id).toBe(true);
        if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
        expect(result).toMatchObject({
          changed: false,
          edits: [],
          beforeSchemaHash: before.schemaHash,
          afterSchemaHash: before.schemaHash,
          semanticDiff: { changes: [], renameCandidates: [] },
        });
      } else {
        expect(result.ok, fixtureCase.id).toBe(false);
        if (result.ok) throw new Error(`${fixtureCase.id}: expected failure`);
        expect(result.diagnostics[0]?.code, fixtureCase.id).toBe(
          fixtureCase.expectedDiagnosticCode,
        );
      }

      expect(fixtureCase.beforeSourceHash, fixtureCase.id).toBe(
        sha256FixtureSource(visualCommandGateFixture.initialSource),
      );
      expect(fixtureCase.afterSourceHash, fixtureCase.id).toBe(fixtureCase.beforeSourceHash);
      expect(fixtureCase.beforeSchemaHash, fixtureCase.id).toBe(before.schemaHash);
      expect(fixtureCase.afterSchemaHash, fixtureCase.id).toBe(before.schemaHash);
    }
  });

  it("rolls back a valid reparse when the independent semantic allowlist rejects it", async () => {
    const command = visualCommandSchema.parse(
      visualCommandGateFixture.noOpCases[0]?.command,
    ) as UpdateTableCommand;
    const source = visualCommandGateFixture.initialSource;
    const target = "email varchar [unique]";
    const startOffset = source.indexOf(target);
    expect(startOffset).toBeGreaterThanOrEqual(0);

    const result = await runVerifiedVisualTransform<UpdateTableCommand>(
      source,
      command,
      visualCommandGateFixture.filepath,
      {
        supportedKinds: new Set<VisualCommand["kind"]>(["UPDATE_TABLE"]),
        unsupportedKindMessage: "test-only gate",
        preflight: () => ({ ok: true, edits: [] }),
        isSemanticNoOp: () => false,
        planEdits: () => ({
          ok: true,
          edits: [
            {
              startOffset: startOffset + "email ".length,
              endOffset: startOffset + "email varchar".length,
              newText: "integer",
            },
          ],
        }),
        verifySemantics: () => false,
      },
    );

    expect(result).toEqual({
      ok: false,
      source,
      diagnostics: [
        {
          code: "VISUAL_SEMANTIC_MISMATCH",
          message: "Reparsed DBML changed schema semantics beyond the requested visual command.",
          severity: "ERROR",
        },
      ],
    });
  });

  it("preserves the default 143-table fidelity fixture outside one verified column insertion", async () => {
    const source = generateFidelityFixture();
    const before = await parseOrThrow(source);
    const target = before.tables[0];
    if (!target) throw new Error("Default fidelity fixture must contain a target table.");
    expect(inventory(before)).toEqual(fixtureInventory.fidelity);

    const command = visualCommandSchema.parse({
      commandId: "123e4567-e89b-42d3-a456-426614174099",
      expectedSchemaRevisionNo: 1,
      kind: "CREATE_COLUMN",
      targetTableKey: target.key,
      column: {
        name: "m3_gate_verified_column",
        type: "varchar(64)",
        primaryKey: false,
        unique: false,
        notNull: true,
        default: null,
        increment: false,
        note: "M3 gate synthetic column",
      },
    });
    const result = await transformVisualCommand(source, command);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    for (const edit of result.edits) {
      expect(edit.startOffset).toBeGreaterThanOrEqual(target.range.startOffset);
      expect(edit.endOffset).toBeLessThanOrEqual(target.range.endOffset);
    }
    expect(applyTextEdits(source, result.edits)).toEqual({ ok: true, source: result.source });
    const after = await parseOrThrow(result.source);
    expect(result.semanticDiff).toEqual(diffSchemaGraphs(before, after));
    expect(inventory(after)).toEqual(fixtureInventory.fidelity);
    expect(
      after.tables
        .find(({ key }) => key === target.key)
        ?.columns.some(
          ({ key }) =>
            key ===
            qualifiedElementKey(
              "column",
              target.schemaName,
              target.name,
              "m3_gate_verified_column",
            ),
        ),
    ).toBe(true);
    expect(result.source).toContain("// Deterministic public synthetic fixture");
    expect(result.source).toContain("TablePartial audit_fields");
    expect(result.source).toContain("DiagramView full_schema");
    const targetLengthDelta = result.edits.reduce(
      (delta, edit) => delta + edit.newText.length - (edit.endOffset - edit.startOffset),
      0,
    );
    expect(result.source.slice(0, target.range.startOffset)).toBe(
      source.slice(0, target.range.startOffset),
    );
    expect(result.source.slice(target.range.endOffset + targetLengthDelta)).toBe(
      source.slice(target.range.endOffset),
    );
    expect(result.source).not.toBe(source);
  });
});

async function parseOrThrow(source: string) {
  const parsed = await parseDbmlV2(source, visualCommandGateFixture.filepath);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.graph;
}

function summarizeDiff(diff: SchemaGraphDiff): VisualCommandGateSemanticSummary {
  return {
    changeCount: diff.changes.length,
    added: diff.changes.filter(({ operation }) => operation === "ADD").length,
    updated: diff.changes.filter(({ operation }) => operation === "UPDATE").length,
    deleted: diff.changes.filter(({ operation }) => operation === "DELETE").length,
    renameCandidates: diff.renameCandidates.length,
    elementKinds: [...new Set(diff.changes.map(({ elementKind }) => elementKind))].toSorted(),
  };
}

function inventory(graph: Awaited<ReturnType<typeof parseOrThrow>>) {
  return {
    tables: graph.tables.length,
    enums: graph.enums.length,
    tablePartials: graph.partials.length,
    tableGroups: graph.groups.length,
    diagramViews: graph.views.length,
    references: graph.references.length,
  };
}
