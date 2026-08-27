import { describe, expect, it } from "vitest";
import {
  computeSchemaHash,
  diffSchemaGraphs,
  parseDbmlV2,
  qualifiedElementKey,
  SCHEMA_SEMANTICS_VERSION,
  type SchemaElementKind,
  type SchemaGraph,
} from "../src/index.js";

const semanticFixture = `Project semantics_fixture {
  database_type: 'PostgreSQL'
  Note: 'Project note'
}

TablePartial audit_fields {
  created_at timestamp [not null, note: 'created', check: \`created_at is not null\`]

  indexes {
    created_at [name: 'audit_created_idx']
  }

  checks {
    \`created_at > '2000-01-01'\` [name: 'audit_epoch']
  }
}

Enum public.order_status {
  pending [note: 'Pending order']
  complete
}

Table public.accounts [owner: 'platform', headercolor: #112233] {
  id bigint [pk]
  region_id bigint [not null]

  indexes {
    (region_id, id) [name: 'accounts_region_idx', unique]
  }
}

Table public.orders [owner: 'commerce'] {
  ~audit_fields
  id bigint [pk, increment]
  account_id bigint [not null]
  account_region_id bigint [not null]
  status public.order_status [default: 'pending', note: 'Order status']

  indexes {
    (account_region_id, account_id) [name: 'orders_account_idx']
    (status) [name: 'orders_status_idx']
  }

  checks {
    \`account_id > 0\` [name: 'orders_account_positive']
    \`account_region_id > 0\` [name: 'orders_region_positive']
  }

  Note: 'Orders table'
}

Ref orders_account: public.orders.(account_region_id, account_id) > public.accounts.(region_id, id) [delete: cascade]

Note semantic_note [color: #445566, owner: 'docs'] {
  'Semantic note body'
}

TableGroup commerce [owner: 'platform'] {
  public.orders
  public.accounts
}

DiagramView commerce_view {
  Tables {
    public.orders
    public.accounts
  }
  Notes {
    semantic_note
  }
  TableGroups {
    commerce
  }
  Schemas {
    public
  }
}`;

async function parseGraph(source = semanticFixture, filepath = "/main.dbml"): Promise<SchemaGraph> {
  const result = await parseDbmlV2(source, filepath);
  if (!result.ok) {
    throw new Error(`Expected valid DBML: ${JSON.stringify(result.diagnostics)}`);
  }
  return result.graph;
}

function cloneGraph(graph: SchemaGraph): SchemaGraph {
  return structuredClone(graph) as SchemaGraph;
}

function required<T>(value: T | undefined | null, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

describe("canonical schema hash", () => {
  it("ignores formatting, comments, quote style, filepath, and top-level declaration order", async () => {
    const left = await parseGraph(
      `// formatting does not own semantics
Table public.users {
  id bigint [pk]
}

Enum public.state {
  active
  disabled
}`,
      "/left.dbml",
    );
    const right = await parseGraph(
      `Enum "public"."state" {
  active
  disabled
}

// declarations intentionally reversed
Table "public"."users" { id bigint [pk] }`,
      "schema/right.dbml",
    );

    expect(await computeSchemaHash(left)).toBe(await computeSchemaHash(right));
    expect(left.schemaHash).toBe(right.schemaHash);
    expect(diffSchemaGraphs(left, right)).toEqual({ changes: [], renameCandidates: [] });
  });

  it("ignores unordered memberships and sibling index/check declaration order", async () => {
    const before = await parseGraph();
    const after = cloneGraph(before);
    after.tables.reverse();
    after.notes.reverse();
    after.groups[0]?.tableKeys.reverse();
    after.views[0]?.visibleTableKeys?.reverse();
    after.views[0]?.visibleGroupKeys?.reverse();
    after.views[0]?.visibleNoteKeys?.reverse();
    after.views[0]?.visibleSchemaNames?.reverse();
    after.tables.forEach((table) => {
      table.indexes.reverse();
      table.checks.reverse();
      table.partialKeys.reverse();
    });
    const orders = after.tables.find((table) => table.name === "orders");
    if (!orders) throw new Error("fixture must include orders");
    orders.metadata = { second: "2", ...orders.metadata, first: "1" };
    const sameMetadata = before.tables.find((table) => table.name === "orders");
    if (!sameMetadata) throw new Error("fixture must include orders");
    sameMetadata.metadata = { first: "1", ...sameMetadata.metadata, second: "2" };

    expect(await computeSchemaHash(after)).toBe(await computeSchemaHash(before));
    expect(diffSchemaGraphs(before, after)).toEqual({ changes: [], renameCandidates: [] });
  });

  it("preserves meaningful string whitespace and ordered schema constructs", async () => {
    const graph = await parseGraph();
    const cases: Array<[string, (candidate: SchemaGraph) => void, string]> = [
      [
        "column order",
        (candidate) => {
          candidate.tables.find((table) => table.name === "orders")?.columns.reverse();
        },
        "columnOrder",
      ],
      [
        "enum value order",
        (candidate) => {
          candidate.enums[0]?.values.reverse();
        },
        "valueOrder",
      ],
      [
        "index term order",
        (candidate) => {
          candidate.tables
            .find((table) => table.name === "orders")
            ?.indexes.find((index) => index.name === "orders_account_idx")
            ?.terms.reverse();
        },
        "terms",
      ],
      [
        "reference endpoint order",
        (candidate) => {
          candidate.references[0]?.endpoints.reverse();
        },
        "endpoints",
      ],
      [
        "composite reference column order",
        (candidate) => {
          candidate.references[0]?.endpoints[0].columnKeys.reverse();
        },
        "endpoints",
      ],
      [
        "string whitespace",
        (candidate) => {
          const table = candidate.tables.find((item) => item.name === "orders");
          if (!table?.note) throw new Error("fixture must include a table note");
          table.note.value = "Orders  table";
        },
        "note",
      ],
    ];

    for (const [label, mutate, changedField] of cases) {
      const candidate = cloneGraph(graph);
      mutate(candidate);
      expect(await computeSchemaHash(candidate), label).not.toBe(await computeSchemaHash(graph));
      expect(
        diffSchemaGraphs(graph, candidate).changes.some(
          (change) => change.operation === "UPDATE" && change.changedFields.includes(changedField),
        ),
        label,
      ).toBe(true);
    }
  });

  it("uses semantics version 1 and a fixed lowercase SHA-256 golden hash", async () => {
    const graph = await parseGraph();
    const hash = await computeSchemaHash(graph);

    expect(SCHEMA_SEMANTICS_VERSION).toBe(1);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(graph.schemaHash);
    expect(hash).toBe("96b39a14b2fac6ef591bcf9525b70ea35cbdcc6e9866700aad7a16aa42539a68");
  });
});

describe("schema graph diff", () => {
  it("reports field-level updates for semantic values and ignores source-only data", async () => {
    const before = await parseGraph();
    const ordersKey = qualifiedElementKey("table", "public", "orders");
    const statusKey = qualifiedElementKey("column", "public", "orders", "status");
    const cases: Array<[string, SchemaElementKind, string, (graph: SchemaGraph) => void]> = [
      [
        "type",
        "column",
        statusKey,
        (graph) => {
          const column = graph.tables
            .find((table) => table.key === ordersKey)
            ?.columns.find((item) => item.key === statusKey);
          if (!column) throw new Error("fixture must include status");
          column.type.name = "other_status";
        },
      ],
      [
        "default",
        "column",
        statusKey,
        (graph) => {
          const column = graph.tables
            .find((table) => table.key === ordersKey)
            ?.columns.find((item) => item.key === statusKey);
          if (!column) throw new Error("fixture must include status");
          column.default = { type: "string", value: "complete" };
        },
      ],
      [
        "note",
        "column",
        statusKey,
        (graph) => {
          const column = graph.tables
            .find((table) => table.key === ordersKey)
            ?.columns.find((item) => item.key === statusKey);
          if (!column?.note) throw new Error("fixture must include status note");
          column.note.value = "Changed note";
        },
      ],
      [
        "metadata",
        "table",
        ordersKey,
        (graph) => {
          const table = graph.tables.find((item) => item.key === ordersKey);
          if (!table) throw new Error("fixture must include orders");
          table.metadata.owner = "changed";
        },
      ],
      [
        "unique",
        "index",
        qualifiedElementKey("index", "public", "orders", "orders_account_idx"),
        (graph) => {
          const index = graph.tables
            .find((table) => table.key === ordersKey)
            ?.indexes.find((item) => item.name === "orders_account_idx");
          if (!index) throw new Error("fixture must include orders index");
          index.unique = true;
        },
      ],
      [
        "expression",
        "check",
        qualifiedElementKey("check", "public", "orders", "orders_account_positive"),
        (graph) => {
          const check = graph.tables
            .find((table) => table.key === ordersKey)
            ?.checks.find((item) => item.name === "orders_account_positive");
          if (!check) throw new Error("fixture must include orders check");
          check.expression = "account_id >= 1";
        },
      ],
      [
        "onDelete",
        "reference",
        qualifiedElementKey("reference", "public", "orders_account"),
        (graph) => {
          const reference = graph.references[0];
          if (!reference) throw new Error("fixture must include reference");
          reference.onDelete = "restrict";
        },
      ],
      [
        "injectedFrom",
        "column",
        qualifiedElementKey("column", "public", "orders", "created_at"),
        (graph) => {
          const column = graph.tables
            .find((table) => table.key === ordersKey)
            ?.columns.find((item) => item.name === "created_at");
          if (!column?.injectedFrom) throw new Error("fixture must include partial provenance");
          column.injectedFrom.partialKey = qualifiedElementKey("partial", "other_partial");
        },
      ],
    ];

    for (const [field, kind, key, mutate] of cases) {
      const after = cloneGraph(before);
      mutate(after);
      expect(diffSchemaGraphs(before, after).changes, `${kind}.${field}`).toContainEqual({
        operation: "UPDATE",
        elementKind: kind,
        key,
        parentKey: kind === "column" || kind === "index" || kind === "check" ? ordersKey : null,
        changedFields: [field],
      });
    }

    const sourceOnly = cloneGraph(before);
    sourceOnly.schemaHash = "stale";
    sourceOnly.parserVersion = "9.1.1";
    sourceOnly.diagnostics = [{ code: "IGNORED", message: "source only", severity: "INFO" }];
    sourceOnly.sourceMap = {};
    const sourceOnlyTable = required(sourceOnly.tables[0], "source-only table");
    sourceOnlyTable.range.filepath = "/elsewhere.dbml";
    expect(diffSchemaGraphs(before, sourceOnly)).toEqual({ changes: [], renameCandidates: [] });
  });

  it("assigns every nested element kind to its actual parent", async () => {
    const before = await parseGraph();
    const after = cloneGraph(before);
    after.project = null;
    after.notes = [];
    after.references = [];
    after.groups = [];
    after.views = [];
    after.enums = [];
    after.partials = [];
    after.tables = [];

    const deletes = diffSchemaGraphs(before, after).changes.filter(
      (change) => change.operation === "DELETE",
    );
    const byKey = new Map(deletes.map((change) => [change.key, change]));
    const orders = required(
      before.tables.find((table) => table.name === "orders"),
      "orders",
    );
    const status = required(
      orders.columns.find((column) => column.name === "status"),
      "status",
    );
    const columnCheck = required(
      orders.columns.find((column) => column.name === "created_at")?.checks[0],
      "column check",
    );
    const tableIndex = required(orders.indexes[0], "table index");
    const tableCheck = required(orders.checks[0], "table check");
    const dbEnum = required(before.enums[0], "enum");
    const enumValue = required(dbEnum.values[0], "enum value");
    const partial = required(before.partials[0], "partial");
    const partialColumn = required(partial.columns[0], "partial column");
    const partialColumnCheck = required(partialColumn.checks[0], "partial column check");
    const partialIndex = required(partial.indexes[0], "partial index");
    const partialCheck = required(partial.checks[0], "partial check");

    expect(byKey.get(status.key)?.parentKey).toBe(orders.key);
    expect(byKey.get(columnCheck.key)?.parentKey).toBe(
      orders.columns.find((column) => column.name === "created_at")?.key,
    );
    expect(byKey.get(tableIndex.key)?.parentKey).toBe(orders.key);
    expect(byKey.get(tableCheck.key)?.parentKey).toBe(orders.key);
    expect(byKey.get(enumValue.key)?.parentKey).toBe(dbEnum.key);
    expect(byKey.get(partialColumn.key)?.parentKey).toBe(partial.key);
    expect(byKey.get(partialColumnCheck.key)?.parentKey).toBe(partialColumn.key);
    expect(byKey.get(partialIndex.key)?.parentKey).toBe(partial.key);
    expect(byKey.get(partialCheck.key)?.parentKey).toBe(partial.key);
    for (const element of [
      before.project,
      before.notes[0],
      before.tables[0],
      dbEnum,
      before.references[0],
      before.groups[0],
      partial,
      before.views[0],
    ]) {
      if (element) expect(byKey.get(element.key)?.parentKey).toBeNull();
    }
  });

  it("reports a child addition together with the parent column order update", async () => {
    const before = await parseGraph();
    const after = cloneGraph(before);
    const table = required(
      after.tables.find((item) => item.name === "orders"),
      "orders",
    );
    const template = required(
      table.columns.find((column) => column.name === "account_id"),
      "column",
    );
    const newKey = qualifiedElementKey("column", "public", "orders", "external_id");
    table.columns.push({
      ...structuredClone(template),
      key: newKey,
      name: "external_id",
      checks: [],
    });

    expect(diffSchemaGraphs(before, after).changes).toEqual([
      {
        operation: "ADD",
        elementKind: "column",
        key: newKey,
        parentKey: table.key,
      },
      {
        operation: "UPDATE",
        elementKind: "table",
        key: table.key,
        parentKey: null,
        changedFields: ["columnOrder"],
      },
    ]);

    const enumAfter = cloneGraph(before);
    const dbEnum = required(enumAfter.enums[0], "enum");
    const templateValue = required(dbEnum.values[0], "enum value");
    const newValueKey = qualifiedElementKey("enumValue", "public", "order_status", "cancelled");
    dbEnum.values.push({ ...structuredClone(templateValue), key: newValueKey, name: "cancelled" });
    expect(diffSchemaGraphs(before, enumAfter).changes).toEqual([
      {
        operation: "UPDATE",
        elementKind: "enum",
        key: dbEnum.key,
        parentKey: null,
        changedFields: ["valueOrder"],
      },
      {
        operation: "ADD",
        elementKind: "enumValue",
        key: newValueKey,
        parentKey: dbEnum.key,
      },
    ]);
  });

  it("returns deterministic plain-data changes", async () => {
    const before = await parseGraph();
    const after = cloneGraph(before);
    after.tables.reverse();
    const orders = required(
      after.tables.find((table) => table.name === "orders"),
      "orders",
    );
    orders.color = "#abcdef";
    orders.alias = "o";
    orders.columns.reverse();
    after.enums[0]?.values.reverse();

    const diff = diffSchemaGraphs(before, after);
    expect(structuredClone(diff)).toEqual(diff);
    expect(JSON.parse(JSON.stringify(diff))).toEqual(diff);
    for (const change of diff.changes) {
      if (change.operation === "UPDATE") {
        expect(change.changedFields).toEqual([...change.changedFields].sort());
      }
    }
    expect(diffSchemaGraphs(before, after)).toEqual(diff);
  });
});

describe("advisory rename candidates", () => {
  it("finds unique exact table and column renames without removing ADD/DELETE changes", async () => {
    const tableBefore = await parseGraph(`Table public.users {
  id bigint [pk]
  email varchar(255)

  indexes { email [name: 'email_idx'] }
  checks { \`id > 0\` [name: 'positive_id'] }
}`);
    const tableAfter = await parseGraph(`Table public.members {
  id bigint [pk]
  email varchar(255)

  indexes { email [name: 'email_idx'] }
  checks { \`id > 0\` [name: 'positive_id'] }
}`);
    const tableDiff = diffSchemaGraphs(tableBefore, tableAfter);
    expect(tableDiff.renameCandidates).toEqual([
      {
        elementKind: "table",
        beforeKey: qualifiedElementKey("table", "public", "users"),
        afterKey: qualifiedElementKey("table", "public", "members"),
        beforeParentKey: null,
        afterParentKey: null,
        confidence: "HIGH",
        reason: "UNIQUE_EXACT_STRUCTURE",
      },
    ]);
    expect(tableDiff.changes.some((change) => change.operation === "DELETE")).toBe(true);
    expect(tableDiff.changes.some((change) => change.operation === "ADD")).toBe(true);

    const columnBefore = await parseGraph(`Table public.users {
  id bigint [pk]
  email varchar(255) [not null, note: 'contact']
}`);
    const columnAfter = await parseGraph(`Table public.users {
  id bigint [pk]
  contact_email varchar(255) [not null, note: 'contact']
}`);
    expect(diffSchemaGraphs(columnBefore, columnAfter).renameCandidates).toEqual([
      {
        elementKind: "column",
        beforeKey: qualifiedElementKey("column", "public", "users", "email"),
        afterKey: qualifiedElementKey("column", "public", "users", "contact_email"),
        beforeParentKey: qualifiedElementKey("table", "public", "users"),
        afterParentKey: qualifiedElementKey("table", "public", "users"),
        confidence: "HIGH",
        reason: "UNIQUE_EXACT_STRUCTURE",
      },
    ]);
  });

  it("rejects ambiguous, structurally changed, and moved rename guesses", async () => {
    const ambiguousBefore = await parseGraph(`Table public.users {
  first varchar
  second varchar
}`);
    const ambiguousAfter = await parseGraph(`Table public.users {
  third varchar
  fourth varchar
}`);
    expect(diffSchemaGraphs(ambiguousBefore, ambiguousAfter).renameCandidates).toEqual([]);

    const changedBefore = await parseGraph(`Table public.users { email varchar }`);
    const changedAfter = await parseGraph(`Table public.users { contact_email bigint }`);
    expect(diffSchemaGraphs(changedBefore, changedAfter).renameCandidates).toEqual([]);

    const movedTable = await parseGraph(`Table archive.users { email varchar }`);
    expect(diffSchemaGraphs(changedBefore, movedTable).renameCandidates).toEqual([]);

    const renamedTable = await parseGraph(`Table public.members { email varchar }`);
    expect(
      diffSchemaGraphs(changedBefore, renamedTable).renameCandidates.filter(
        (candidate) => candidate.elementKind === "column",
      ),
    ).toEqual([]);
  });
});
