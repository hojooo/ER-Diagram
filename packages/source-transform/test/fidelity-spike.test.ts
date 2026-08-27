import { parseDbmlV2, qualifiedElementKey, type SchemaGraph } from "@er-diagram/core";
import { describe, expect, it } from "vitest";
import {
  applyTextEdits,
  type CreateColumnCommand,
  createColumnInDbmlSource,
  verifyCreateColumnSemanticDiff,
} from "../src/index.js";

const fidelitySource = `// This comment and every unrelated byte must survive the visual edit.
Project source_transform_fixture {
  database_type: 'PostgreSQL'
  Note: 'Source transformation fidelity fixture'
}

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
  email varchar [note: 'Customer email']

  indexes {
    email [name: 'customers_email_idx', unique, note: 'Email lookup']
  }

  checks {
    \`length(email) > 3\` [name: 'customers_email_length']
  }

  Note: 'Unrelated customer table'
}

Ref customer_order: catalog.customers.id > catalog."Order Ledger".id

Note source_contract [color: #112233, owner: "fixture"] {
  'Source-transform semantic guard'
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
  Notes {
    source_contract
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
      type: {
        schemaName: null,
        name: "money_amount",
        arguments: null,
        display: "money_amount",
      },
      primaryKey: false,
      unique: false,
      notNull: false,
      default: null,
      increment: false,
      note: null,
      metadata: {},
      checks: [],
      injectedFrom: null,
    });
    const partial = reparsed.graph.partials.find((candidate) => candidate.name === "timestamps");
    const injectedColumn = target?.columns.find((column) => column.name === "created_at");
    expect(injectedColumn?.injectedFrom).toMatchObject({
      partialKey: partial?.key,
      partialElementKey: partial?.columns.find((column) => column.name === "created_at")?.key,
    });
    const injectionRange = injectedColumn?.injectedFrom?.injectionRange;
    if (!injectionRange) throw new Error("expected partial injection provenance");
    expect(result.source.slice(injectionRange.startOffset, injectionRange.endOffset)).toBe(
      "~timestamps",
    );
    expect(reparsed.graph.partials.map((candidate) => candidate.name)).toEqual(["timestamps"]);
    expect(reparsed.graph.groups.map((group) => group.name)).toEqual(["finance"]);
    expect(reparsed.graph.views.map((view) => view.name)).toEqual(["finance_overview"]);
    expect(reparsed.graph.project?.name).toBe("source_transform_fixture");
    expect(reparsed.graph.notes.map((note) => note.name)).toEqual(["source_contract"]);
  });

  it("keeps quoted custom type identifiers distinct in the semantic guard", async () => {
    const command = await commandFor(fidelitySource, {
      column: { name: "quoted_type", type: '"my schema"."two words"(5)' },
    });
    const transformed = await createColumnInDbmlSource(fidelitySource, command);
    expect(transformed.ok).toBe(true);
    if (!transformed.ok) return;

    const [before, after] = await Promise.all([
      parseDbmlV2(fidelitySource),
      parseDbmlV2(transformed.source),
    ]);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(verifyCreateColumnSemanticDiff(before.graph, after.graph, command)).toEqual({
      ok: true,
    });

    const mismatched = structuredClone(after.graph) as SchemaGraph;
    const addedColumn = mismatched.tables
      .find((table) => table.key === command.targetTableKey)
      ?.columns.at(-1);
    if (!addedColumn) throw new Error("test fixture must include the added column");
    addedColumn.type = {
      schemaName: "my schema",
      name: "twowords",
      arguments: "5",
      display: "my schema.twowords(5)",
    };

    expect(verifyCreateColumnSemanticDiff(before.graph, mismatched, command)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "CREATE_COLUMN_SEMANTIC_MISMATCH", severity: "ERROR" }],
    });
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

  it("rejects every unrelated semantic change covered by the normalized graph", async () => {
    const command = await commandFor(fidelitySource);
    const transformed = await createColumnInDbmlSource(fidelitySource, command);
    expect(transformed.ok).toBe(true);
    if (!transformed.ok) return;

    const before = await parseDbmlV2(fidelitySource);
    const after = await parseDbmlV2(transformed.source);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;

    const mutations: Array<[string, (graph: SchemaGraph) => void]> = [
      [
        "project",
        (graph) => {
          if (!graph.project) throw new Error("test fixture must include a project");
          graph.project.name = "unexpected-project";
        },
      ],
      [
        "sticky note",
        (graph) => {
          const note = graph.notes[0];
          if (!note) throw new Error("test fixture must include a sticky note");
          note.content = "unexpected-note";
        },
      ],
      [
        "table note",
        (graph) => {
          const table = graph.tables.find((candidate) => candidate.name === "customers");
          if (!table?.note) throw new Error("test fixture must include an unrelated table note");
          table.note.value = "unexpected-table-note";
        },
      ],
      [
        "metadata key named range",
        (graph) => {
          const table = graph.tables.find((candidate) => candidate.name === "customers");
          if (!table) throw new Error("test fixture must include the unrelated table");
          table.metadata.range = "unexpected-range-metadata";
        },
      ],
      [
        "index",
        (graph) => {
          const index = graph.tables
            .find((table) => table.name === "customers")
            ?.indexes.find((candidate) => candidate.name === "customers_email_idx");
          if (!index) throw new Error("test fixture must include an unrelated index");
          index.unique = false;
        },
      ],
      [
        "check",
        (graph) => {
          const check = graph.tables
            .find((table) => table.name === "customers")
            ?.checks.find((candidate) => candidate.name === "customers_email_length");
          if (!check) throw new Error("test fixture must include an unrelated check");
          check.expression = "length(email) > 100";
        },
      ],
      [
        "stable reference key",
        (graph) => {
          const reference = graph.references[0];
          if (!reference) throw new Error("test fixture must include a reference");
          reference.key = qualifiedElementKey("reference", "public", "unexpected-reference");
        },
      ],
      [
        "partial provenance",
        (graph) => {
          const injectedColumn = graph.tables
            .find((table) => table.name === "Order Ledger")
            ?.columns.find((column) => column.name === "created_at");
          if (!injectedColumn?.injectedFrom) {
            throw new Error("test fixture must include an injected partial column");
          }
          injectedColumn.injectedFrom.partialKey = qualifiedElementKey(
            "partial",
            "unexpected-partial",
          );
        },
      ],
      [
        "structured column type",
        (graph) => {
          const column = graph.tables
            .find((table) => table.name === "Order Ledger")
            ?.columns.find((candidate) => candidate.name === "gross amount");
          if (!column) throw new Error("test fixture must include the added column");
          column.type.name = "unexpected_type";
        },
      ],
    ];

    for (const [label, mutate] of mutations) {
      const mismatched = structuredClone(after.graph) as SchemaGraph;
      mutate(mismatched);

      expect(
        verifyCreateColumnSemanticDiff(before.graph, mismatched, command),
        label,
      ).toMatchObject({
        ok: false,
        diagnostics: [{ code: "CREATE_COLUMN_SEMANTIC_MISMATCH", severity: "ERROR" }],
      });
    }
  });
});
