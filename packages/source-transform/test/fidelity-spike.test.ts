import { parseDbmlV2, qualifiedElementKey, type SchemaGraph } from "@er-diagram/core";
import { describe, expect, it } from "vitest";
import {
  applyTextEdits,
  type CreateColumnCommand,
  createColumnInDbmlSource,
  verifyCreateColumnSemanticDiff,
} from "../src/index.js";

const fidelitySource = `// This comment and every unrelated byte must survive the visual edit.
TablePartial timestamps {
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table catalog."Order Ledger" [owner: "finance"] {
  ~timestamps
  id bigint [pk]
  // keep this table comment exactly
}

Table catalog.customers {
  id bigint [pk]
}

TableGroup finance [color: #3498DB] {
  catalog."Order Ledger"
  catalog.customers
}

DiagramView finance_overview {
  Tables {
    catalog."Order Ledger"
    catalog.customers
  }
  TableGroups {
    finance
  }
}
`;

async function commandFor(
  source: string,
  overrides: Partial<CreateColumnCommand> = {},
): Promise<CreateColumnCommand> {
  const parsed = await parseDbmlV2(source);
  if (!parsed.ok) throw new Error("test fixture must be valid DBML v2");

  return {
    kind: "CREATE_COLUMN",
    expectedSchemaHash: parsed.graph.schemaHash,
    targetTableKey: qualifiedElementKey("table", "catalog", "Order Ledger"),
    column: {
      name: "gross amount",
      type: "money_amount",
    },
    ...overrides,
  };
}

describe("fidelity-spike / TextEdit", () => {
  it("applies UTF-16 half-open edits in reverse-offset order", () => {
    const source = "A😀BCDEF";
    const result = applyTextEdits(source, [
      { startOffset: 1, endOffset: 3, newText: "emoji" },
      { startOffset: 5, endOffset: 8, newText: "ef" },
    ]);

    expect(result).toEqual({ ok: true, source: "AemojiBCef" });
  });

  it("rejects overlapping edits without changing the source", () => {
    const source = "abcdef";
    const result = applyTextEdits(source, [
      { startOffset: 1, endOffset: 4, newText: "B" },
      { startOffset: 3, endOffset: 5, newText: "D" },
    ]);

    expect(result).toMatchObject({
      ok: false,
      source,
      diagnostics: [{ code: "TEXT_EDIT_OVERLAP", severity: "ERROR" }],
    });
  });

  it("rejects a range outside the original UTF-16 source", () => {
    const source = "abc";
    const result = applyTextEdits(source, [{ startOffset: 2, endOffset: 4, newText: "x" }]);

    expect(result).toMatchObject({
      ok: false,
      source,
      diagnostics: [{ code: "TEXT_EDIT_RANGE_INVALID", severity: "ERROR" }],
    });
  });
});

describe("fidelity-spike / CreateColumn", () => {
  it("adds one quoted column with a custom type and preserves every unrelated byte", async () => {
    const command = await commandFor(fidelitySource);
    const result = await createColumnInDbmlSource(fidelitySource, command);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedSource = fidelitySource.replace(
      "  // keep this table comment exactly\n}\n\nTable catalog.customers",
      '  // keep this table comment exactly\n  "gross amount" money_amount\n}\n\nTable catalog.customers',
    );

    expect(result.source).toBe(expectedSource);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]).toMatchObject({
      startOffset: result.edits[0]?.endOffset,
      newText: '  "gross amount" money_amount\n',
    });
    expect(fidelitySource.slice(0, result.edits[0]?.startOffset)).toBe(
      result.source.slice(0, result.edits[0]?.startOffset),
    );
    expect(fidelitySource.slice(result.edits[0]?.endOffset)).toBe(
      result.source.slice(
        (result.edits[0]?.startOffset ?? 0) + (result.edits[0]?.newText.length ?? 0),
      ),
    );

    const reparsed = await parseDbmlV2(result.source);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const target = reparsed.graph.tables.find((table) => table.key === command.targetTableKey);
    expect(target?.columns.at(-1)).toMatchObject({
      name: "gross amount",
      type: "money_amount",
      primaryKey: false,
      unique: false,
      notNull: false,
    });
    expect(reparsed.graph.partials.map((partial) => partial.name)).toEqual(["timestamps"]);
    expect(reparsed.graph.groups.map((group) => group.name)).toEqual(["finance"]);
    expect(reparsed.graph.views.map((view) => view.name)).toEqual(["finance_overview"]);
  });

  it("rejects an invalid command before changing source", async () => {
    const validCommand = await commandFor(fidelitySource);
    const invalidCommand = {
      ...validCommand,
      column: { name: "", type: "money_amount" },
    } as CreateColumnCommand;

    const result = await createColumnInDbmlSource(fidelitySource, invalidCommand);

    expect(result).toMatchObject({
      ok: false,
      source: fidelitySource,
      diagnostics: [{ code: "CREATE_COLUMN_COMMAND_INVALID", severity: "ERROR" }],
    });
  });

  it("rejects a stale schema hash", async () => {
    const command = await commandFor(fidelitySource, { expectedSchemaHash: "stale-hash" });
    const result = await createColumnInDbmlSource(fidelitySource, command);

    expect(result).toMatchObject({
      ok: false,
      source: fidelitySource,
      diagnostics: [{ code: "SOURCE_SCHEMA_STALE", severity: "ERROR" }],
    });
  });

  it("rejects an unknown target table", async () => {
    const command = await commandFor(fidelitySource, {
      targetTableKey: qualifiedElementKey("table", "catalog", "missing"),
    });
    const result = await createColumnInDbmlSource(fidelitySource, command);

    expect(result).toMatchObject({
      ok: false,
      source: fidelitySource,
      diagnostics: [{ code: "CREATE_COLUMN_TARGET_NOT_FOUND", severity: "ERROR" }],
    });
  });

  it("returns the original source when the generated fragment cannot be reparsed", async () => {
    const command = await commandFor(fidelitySource, {
      column: { name: "broken_type", type: "varchar(" },
    });
    const result = await createColumnInDbmlSource(fidelitySource, command);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.source).toBe(fidelitySource);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "CREATE_COLUMN_REPARSE_FAILED",
    );
  });

  it("rejects a graph that contains any semantic change beyond the requested column", async () => {
    const command = await commandFor(fidelitySource);
    const transformed = await createColumnInDbmlSource(fidelitySource, command);
    expect(transformed.ok).toBe(true);
    if (!transformed.ok) return;

    const before = await parseDbmlV2(fidelitySource);
    const after = await parseDbmlV2(transformed.source);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;

    const mismatched = structuredClone(after.graph) as SchemaGraph;
    const unrelatedTable = mismatched.tables.find((table) => table.name === "customers");
    if (!unrelatedTable) throw new Error("test fixture must include the unrelated table");
    unrelatedTable.metadata.owner = "unexpected-change";

    const verification = verifyCreateColumnSemanticDiff(before.graph, mismatched, command);

    expect(verification).toMatchObject({
      ok: false,
      diagnostics: [{ code: "CREATE_COLUMN_SEMANTIC_MISMATCH", severity: "ERROR" }],
    });
  });
});
