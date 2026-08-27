import { fixtureInventory, generateFidelityFixture } from "@er-diagram/test-fixtures";
import { describe, expect, it } from "vitest";
import { parseDbmlProjectV2, parseDbmlV2 } from "../src/index.js";
import { normalizeSchemaGraph } from "../src/normalize-schema-graph.js";

interface TestRange {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  filepath: string;
}

interface TestElement {
  key: string;
  range: TestRange;
}

interface TestGraph {
  project: (TestElement & Record<string, unknown>) | null;
  notes: Array<TestElement & Record<string, unknown>>;
  tables: Array<
    TestElement & {
      name: string;
      note?: unknown;
      columns: Array<TestElement & Record<string, unknown>>;
      indexes: Array<TestElement & Record<string, unknown>>;
      checks: Array<TestElement & Record<string, unknown>>;
    }
  >;
  enums: Array<
    TestElement & {
      values: Array<TestElement & Record<string, unknown>>;
    }
  >;
  references: Array<
    TestElement & {
      name: string | null;
      endpoints: Array<TestElement & { tableKey: string }>;
    }
  >;
  groups: TestElement[];
  partials: Array<
    TestElement & {
      columns: Array<TestElement & Record<string, unknown>>;
      indexes: Array<TestElement & Record<string, unknown>>;
      checks: Array<TestElement & Record<string, unknown>>;
    }
  >;
  views: Array<TestElement & { name: string }>;
  sourceMap: Record<string, TestRange>;
}

const fullContractSource = `Project "ERD 🚀" {
  database_type: "PostgreSQL"
  Note: "프로젝트 📐"
}

TablePartial audit_fields {
  created_at timestamp [not null, note: "생성 🚀", check: \`extract(year from created_at) > 2000\`]
  deleted_at timestamp

  indexes {
    created_at [name: "audit_created_idx", type: btree, note: "audit idx"]
    (\`lower(deleted_at::text)\`) [name: "audit_expr_idx"]
  }

  checks {
    \`created_at <= deleted_at\` [name: "audit_order"]
  }

  Note: "partial note"
}

Enum "catalog.v1"."상태.enum" {
  "진행.중" [note: "enum note 🚀"]
  done
}

Table "catalog.v1"."사용자.테이블" as U [headercolor: #112233, owner: "테스트"] {
  ~audit_fields
  "식별.자" bigint [pk, increment, note: "식별자 🚀", classification: "synthetic", check: \`id > 0\`]
  status "catalog.v1"."상태.enum" [default: "진행.중"]
  email varchar(255) [unique]

  indexes {
    email [name: "users_email_idx", unique, note: "email idx"]
    (\`lower(email)\`) [name: "users_lower_email_idx"]
  }

  checks {
    \`length(email) > 3\` [name: "email_length"]
  }

  Note: "table note 🚀"
}

Table catalog.posts {
  tenant_id bigint [not null]
  id bigint [pk]
  author_id bigint [not null]
}

Table catalog.accounts {
  tenant_id bigint [not null]
  id bigint [pk]

  indexes {
    (tenant_id, id) [pk]
  }
}

Ref post_author: catalog.posts.(tenant_id, author_id) > catalog.accounts.(tenant_id, id) [delete: cascade, update: no action]

Note "sticky.note" [color: #445566, owner: "docs"] {
  "sticky 🚀 body"
}

TableGroup "group.one" [color: #778899, owner: "platform"] {
  "catalog.v1"."사용자.테이블"
  catalog.posts
}

DiagramView full_view {
  Tables { * }
  Notes { * }
  TableGroups { * }
  Schemas { * }
}

DiagramView focused_view {
  Tables { "catalog.v1"."사용자.테이블" }
  Notes { "sticky.note" }
  TableGroups { "group.one" }
  Schemas { "catalog.v1" }
}

DiagramView hidden_view {
  Tables { }
  Notes { }
  TableGroups { }
  Schemas { }
}`;

function asTestGraph(graph: unknown): TestGraph {
  return graph as TestGraph;
}

function allElements(graph: TestGraph): TestElement[] {
  return [
    ...(graph.project ? [graph.project] : []),
    ...graph.notes,
    ...graph.tables.flatMap((table) => [
      table,
      ...table.columns,
      ...table.indexes,
      ...table.checks,
      ...table.columns.flatMap((column) => {
        const checks = column.checks;
        return Array.isArray(checks) ? (checks as TestElement[]) : [];
      }),
    ]),
    ...graph.enums.flatMap((dbEnum) => [dbEnum, ...dbEnum.values]),
    ...graph.references,
    ...graph.groups,
    ...graph.partials.flatMap((partial) => [
      partial,
      ...partial.columns,
      ...partial.indexes,
      ...partial.checks,
      ...partial.columns.flatMap((column) => {
        const checks = column.checks;
        return Array.isArray(checks) ? (checks as TestElement[]) : [];
      }),
    ]),
    ...graph.views,
  ];
}

describe("normalized SchemaGraph", () => {
  it("normalizes the P0 DBML contract without exposing parser objects", async () => {
    const result = await parseDbmlV2(fullContractSource);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graph = asTestGraph(result.graph);

    expect(graph.project).toMatchObject({
      key: 'project:["ERD 🚀"]',
      name: "ERD 🚀",
      databaseType: "PostgreSQL",
      note: { value: "프로젝트 📐", range: expect.objectContaining({ filepath: "/main.dbml" }) },
    });
    expect(graph.notes).toEqual([
      expect.objectContaining({
        key: 'note:["sticky.note"]',
        name: "sticky.note",
        content: "sticky 🚀 body",
        color: "#445566",
        metadata: { owner: "docs" },
      }),
    ]);

    const table = graph.tables.find((candidate) => candidate.name === "사용자.테이블");
    expect(table).toMatchObject({
      key: 'table:["catalog.v1","사용자.테이블"]',
      schemaName: "catalog.v1",
      alias: "U",
      color: "#112233",
      note: { value: "table note 🚀", range: expect.objectContaining({ filepath: "/main.dbml" }) },
      metadata: { owner: "테스트" },
      partialKeys: ['partial:["audit_fields"]'],
    });

    const identifier = table?.columns.find((column) => column.name === "식별.자");
    expect(identifier).toMatchObject({
      key: 'column:["catalog.v1","사용자.테이블","식별.자"]',
      type: { schemaName: null, name: "bigint", arguments: null, display: "bigint" },
      primaryKey: true,
      increment: true,
      note: { value: "식별자 🚀" },
      metadata: { classification: "synthetic" },
    });
    expect(identifier?.checks).toEqual([
      expect.objectContaining({
        expression: "id > 0",
        tableKey: table?.key,
        columnKey: identifier?.key,
      }),
    ]);

    const enumColumn = table?.columns.find((column) => column.name === "status");
    expect(enumColumn).toMatchObject({
      type: {
        schemaName: "catalog.v1",
        name: "상태.enum",
        arguments: null,
        display: expect.stringContaining("상태.enum"),
      },
      default: { type: "string", value: "진행.중" },
    });

    const dbEnum = graph.enums[0];
    expect(dbEnum).toMatchObject({
      key: 'enum:["catalog.v1","상태.enum"]',
      schemaName: "catalog.v1",
      name: "상태.enum",
    });
    expect(dbEnum?.values).toEqual([
      expect.objectContaining({
        key: 'enumValue:["catalog.v1","상태.enum","진행.중"]',
        name: "진행.중",
        note: { value: "enum note 🚀", range: expect.objectContaining({ filepath: "/main.dbml" }) },
      }),
      expect.objectContaining({
        key: 'enumValue:["catalog.v1","상태.enum","done"]',
        name: "done",
      }),
    ]);

    const localIndex = table?.indexes.find((index) => index.name === "users_email_idx");
    const email = table?.columns.find((column) => column.name === "email");
    expect(localIndex).toMatchObject({
      unique: true,
      primaryKey: false,
      type: null,
      note: { value: "email idx", range: expect.objectContaining({ filepath: "/main.dbml" }) },
      terms: [{ kind: "COLUMN", columnKey: email?.key }],
    });
    expect(table?.indexes.find((index) => index.name === "users_lower_email_idx")).toMatchObject({
      terms: [{ kind: "EXPRESSION", expression: "lower(email)" }],
    });
    expect(table?.checks.find((check) => check.name === "email_length")).toMatchObject({
      expression: "length(email) > 3",
      tableKey: table?.key,
      columnKey: null,
    });

    const reference = graph.references.find((candidate) => candidate.name === "post_author");
    expect(reference).toMatchObject({
      key: 'reference:["public","post_author"]',
      onDelete: "cascade",
      onUpdate: "no action",
      endpoints: [
        {
          tableKey: 'table:["catalog","posts"]',
          columnKeys: [
            'column:["catalog","posts","tenant_id"]',
            'column:["catalog","posts","author_id"]',
          ],
          multiplicity: { min: 1, max: null },
        },
        {
          tableKey: 'table:["catalog","accounts"]',
          columnKeys: [
            'column:["catalog","accounts","tenant_id"]',
            'column:["catalog","accounts","id"]',
          ],
          multiplicity: { min: 1, max: 1 },
        },
      ],
    });
    expect(reference?.endpoints[0]?.range).toBeDefined();
    expect(reference?.endpoints[1]?.range).toBeDefined();
  });

  it("preserves partial definition ranges separately from table injection ranges", async () => {
    const result = await parseDbmlV2(fullContractSource);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graph = asTestGraph(result.graph);
    const partial = graph.partials[0];
    const table = graph.tables.find((candidate) => candidate.name === "사용자.테이블");
    const partialColumn = partial?.columns.find((column) => column.name === "created_at");
    const partialColumnChecks = partialColumn?.checks as TestElement[] | undefined;
    const injectedColumn = table?.columns.find((column) => column.name === "created_at");

    expect(partial).toMatchObject({
      key: 'partial:["audit_fields"]',
      note: { value: "partial note" },
    });
    expect(partialColumn?.key).not.toBe(injectedColumn?.key);
    expect(partialColumnChecks).toEqual([
      expect.objectContaining({ expression: "extract(year from created_at) > 2000" }),
    ]);
    expect(
      fullContractSource.slice(injectedColumn?.range.startOffset, injectedColumn?.range.endOffset),
    ).toContain("created_at timestamp");
    const injectedFrom = injectedColumn?.injectedFrom as
      | { partialKey: string; injectionRange: TestRange }
      | undefined;
    expect(injectedFrom).toMatchObject({ partialKey: partial?.key });
    if (!injectedFrom) throw new Error("Expected partial injection provenance.");
    const columnInjectionRange = injectedFrom.injectionRange;
    expect(
      fullContractSource.slice(columnInjectionRange.startOffset, columnInjectionRange.endOffset),
    ).toBe("~audit_fields");

    expect(partial?.indexes).toHaveLength(2);
    expect(partial?.checks).toEqual([
      expect.objectContaining({ name: "audit_order", expression: "created_at <= deleted_at" }),
    ]);
    expect(table?.indexes.find((index) => index.name === "audit_created_idx")).toMatchObject({
      injectedFrom: { partialKey: partial?.key, injectionRange: columnInjectionRange },
    });
    expect(
      table?.checks.find((check) => check.expression === "created_at <= deleted_at"),
    ).toMatchObject({
      injectedFrom: { partialKey: partial?.key, injectionRange: columnInjectionRange },
    });
    const injectedColumnChecks = injectedColumn?.checks as
      | Array<Record<string, unknown>>
      | undefined;
    expect(injectedColumnChecks).toEqual([
      expect.objectContaining({
        expression: "extract(year from created_at) > 2000",
        injectedFrom: expect.objectContaining({
          partialKey: partial?.key,
          partialElementKey: partialColumnChecks?.[0]?.key,
          injectionRange: columnInjectionRange,
        }),
      }),
    ]);
  });

  it("preserves DiagramView tri-state filters, including sticky notes", async () => {
    const result = await parseDbmlV2(fullContractSource);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graph = asTestGraph(result.graph);
    const full = graph.views.find((view) => view.name === "full_view");
    const focused = graph.views.find((view) => view.name === "focused_view");
    const hidden = graph.views.find((view) => view.name === "hidden_view");

    expect(full).toMatchObject({
      schemaName: null,
      visibleTableKeys: [],
      visibleNoteKeys: [],
      visibleGroupKeys: [],
      visibleSchemaNames: [],
    });
    expect(focused).toMatchObject({
      visibleTableKeys: ['table:["catalog.v1","사용자.테이블"]'],
      visibleNoteKeys: ['note:["sticky.note"]'],
      visibleGroupKeys: ['group:["public","group.one"]'],
      visibleSchemaNames: ["catalog.v1"],
    });
    expect(hidden).toMatchObject({
      visibleTableKeys: null,
      visibleNoteKeys: null,
      visibleGroupKeys: null,
      visibleSchemaNames: null,
    });
  });

  it("keeps named and anonymous reference keys stable across unrelated insertions", async () => {
    const declarations = `Table users {
  id int [pk]
  external_id int [unique]
}

Table posts {
  id int [pk]
  user_id int
  external_user_id int
}

Ref posts_user: posts.user_id > users.id
Ref: posts.external_user_id > users.external_id`;
    const prefixed = `Table audit_events {
  id int [pk]
  user_id int
}

Table users {
  id int [pk]
  external_id int [unique]
}

Table posts {
  id int [pk]
  user_id int
  external_user_id int
}

Ref: audit_events.user_id > users.id
Ref posts_user: posts.user_id > users.id
Ref: posts.external_user_id > users.external_id`;

    const [before, after] = await Promise.all([parseDbmlV2(declarations), parseDbmlV2(prefixed)]);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;

    const beforeRefs = asTestGraph(before.graph).references;
    const afterRefs = asTestGraph(after.graph).references;
    const namedBefore = beforeRefs.find((reference) => reference.name === "posts_user");
    const namedAfter = afterRefs.find((reference) => reference.name === "posts_user");
    const anonymousBefore = beforeRefs.find(
      (reference) =>
        reference.name === null &&
        reference.endpoints.some((endpoint) => endpoint.tableKey === 'table:["public","posts"]'),
    );
    const anonymousAfter = afterRefs.find(
      (reference) =>
        reference.name === null &&
        reference.endpoints.some((endpoint) => endpoint.tableKey === 'table:["public","posts"]'),
    );

    expect(namedBefore?.key).toBe('reference:["public","posts_user"]');
    expect(namedAfter?.key).toBe(namedBefore?.key);
    expect(anonymousAfter?.key).toBe(anonymousBefore?.key);
    expect(anonymousBefore?.key).toMatch(/^reference:/);
    expect(anonymousBefore?.key).not.toContain("anonymous-");
    expect(anonymousBefore?.key).not.toMatch(/,"\d+"]$/);
  });

  it("allocates duplicate anonymous ordinals only within one semantic signature", async () => {
    const before = await parseDbmlV2(`Table keys {
  a int
  b int

  indexes {
    a
    a
  }

  checks {
    \`a > 0\`
    \`a > 0\`
  }
}`);
    const after = await parseDbmlV2(`Table keys {
  a int
  b int

  indexes {
    b
    a
    a
  }

  checks {
    \`b > 0\`
    \`a > 0\`
    \`a > 0\`
  }
}`);

    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    const columnKey = 'column:["public","keys","a"]';
    const beforeIndexes = before.graph.tables[0]?.indexes
      .filter(
        (index) => index.terms[0]?.kind === "COLUMN" && index.terms[0].columnKey === columnKey,
      )
      .map((index) => index.key);
    const afterIndexes = after.graph.tables[0]?.indexes
      .filter(
        (index) => index.terms[0]?.kind === "COLUMN" && index.terms[0].columnKey === columnKey,
      )
      .map((index) => index.key);
    const beforeChecks = before.graph.tables[0]?.checks
      .filter((check) => check.expression === "a > 0")
      .map((check) => check.key);
    const afterChecks = after.graph.tables[0]?.checks
      .filter((check) => check.expression === "a > 0")
      .map((check) => check.key);

    expect(afterIndexes).toEqual(beforeIndexes);
    expect(afterChecks).toEqual(beforeChecks);
    expect(new Set(beforeIndexes).size).toBe(2);
    expect(new Set(beforeChecks).size).toBe(2);
    expect(beforeIndexes?.some((key) => key.endsWith(",0]"))).toBe(true);
    expect(beforeIndexes?.some((key) => key.endsWith(",1]"))).toBe(true);
  });

  it("allocates repeated anonymous reference signatures independently of unrelated refs", async () => {
    const token = (startOffset: number, endOffset: number) => ({
      start: { offset: startOffset, line: 1, column: startOffset + 1 },
      end: { offset: endOffset, line: 1, column: endOffset + 1 },
      filepath: "/main.dbml",
    });
    const table = (name: string, offset: number) => ({
      name,
      token: token(offset, offset + 10),
      schema: { name: "public" },
      fields: [{ name: "id", type: { type_name: "int" }, token: token(offset + 2, offset + 4) }],
    });
    const reference = (left: string, right: string, offset: number) => ({
      token: token(offset, offset + 2),
      endpoints: [
        {
          schemaName: "public",
          tableName: left,
          fieldNames: ["id"],
          relation: "*",
          token: token(offset, offset + 1),
        },
        {
          schemaName: "public",
          tableName: right,
          fieldNames: ["id"],
          relation: "1",
          token: token(offset + 1, offset + 2),
        },
      ],
    });
    const normalize = (refs: unknown[]) =>
      normalizeSchemaGraph(
        {
          schemas: [
            {
              name: "public",
              tables: [table("a", 0), table("b", 20), table("c", 40)],
              refs,
            },
          ],
        } as never,
        { fallbackFilepath: "/main.dbml", forceFilepath: false },
      );

    const before = await normalize([reference("a", "b", 60), reference("a", "b", 64)]);
    const after = await normalize([
      reference("c", "b", 56),
      reference("a", "b", 60),
      reference("a", "b", 64),
    ]);
    const beforeKeys = before.references.map((reference) => reference.key);
    const afterKeys = after.references
      .filter((reference) => reference.endpoints[0].tableKey === 'table:["public","a"]')
      .map((reference) => reference.key);

    expect(afterKeys).toEqual(beforeKeys);
    expect(new Set(beforeKeys).size).toBe(2);
  });

  it("fails normalization on stable-key collisions and invalid source ranges", async () => {
    const token = (startOffset: number, endOffset: number, startLine = 1, endLine = 1) => ({
      start: { offset: startOffset, line: startLine, column: startOffset + 1 },
      end: { offset: endOffset, line: endLine, column: endOffset + 1 },
      filepath: "/main.dbml",
    });
    const duplicateTables = {
      schemas: [
        {
          name: "public",
          tables: [
            { name: "users", token: token(0, 10), fields: [] },
            { name: "users", token: token(20, 30), fields: [] },
          ],
        },
      ],
    };
    const invalidRange = {
      schemas: [
        {
          name: "public",
          tables: [{ name: "users", token: token(0, 10, 2, 1), fields: [] }],
        },
      ],
    };

    await expect(
      normalizeSchemaGraph(duplicateTables as never, {
        fallbackFilepath: "/main.dbml",
        forceFilepath: false,
      }),
    ).rejects.toThrow(/Duplicate SchemaElementKey/);
    await expect(
      normalizeSchemaGraph(invalidRange as never, {
        fallbackFilepath: "/main.dbml",
        forceFilepath: false,
      }),
    ).rejects.toThrow(/Invalid source range/);
  });

  it("uses UTF-16 half-open ranges and preserves caller and multifile paths", async () => {
    const tableBlock = `Table "catalog.😀"."사용자.📐" {\r\n  "식별.🚀" bigint [pk, note: "메모 😀"]\r\n}`;
    const source = `// 😀 CRLF\r\n${tableBlock}`;
    const direct = await parseDbmlV2(source, "/unicode/custom.dbml");

    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    const directGraph = asTestGraph(direct.graph);
    const table = directGraph.tables[0];
    const column = table?.columns[0];
    expect(table?.key).toBe('table:["catalog.😀","사용자.📐"]');
    expect(table?.range).toMatchObject({
      filepath: "/unicode/custom.dbml",
      startOffset: source.indexOf("Table"),
      endOffset: source.length,
      startLine: 2,
      startColumn: 1,
    });
    expect(source.slice(table?.range.startOffset, table?.range.endOffset)).toBe(tableBlock);
    const columnText = '"식별.🚀" bigint [pk, note: "메모 😀"]';
    expect(column?.range.startOffset).toBe(source.indexOf(columnText));
    expect(source.slice(column?.range.startOffset, column?.range.endOffset)).toBe(columnText);
    expect(column?.range.startColumn).toBe(3);
    expect(column?.range.endColumn).toBe(3 + columnText.length);
    const columnNote = column?.note as { value: string; range: TestRange } | undefined;
    expect(columnNote?.value).toBe("메모 😀");
    expect(source.slice(columnNote?.range.startOffset, columnNote?.range.endOffset)).toBe(
      '"메모 😀"',
    );
    expect(columnNote?.range).toMatchObject({
      filepath: "/unicode/custom.dbml",
      startLine: 3,
      startColumn: columnText.indexOf('"메모 😀"') + 3,
    });
    expect(
      Object.values(directGraph.sourceMap).every(
        (range) => range.filepath === "/unicode/custom.dbml",
      ),
    ).toBe(true);

    const shared = `Enum shared.status {
  active
}

Table shared.users {
  id int [pk]
  status shared.status [note: ""]
  Note: ""
}`;
    const main = `use * from './shared'

DiagramView shared_only {
  Tables { shared.users }
  Notes { }
  TableGroups { }
  Schemas { shared }
}`;
    const project = await parseDbmlProjectV2({
      entrypoint: "/main.dbml",
      files: { "/main.dbml": main, "/shared.dbml": shared },
    });
    expect(project.ok).toBe(true);
    if (!project.ok) return;
    const projectGraph = asTestGraph(project.graph);
    const sharedTable = projectGraph.tables[0];
    const sharedEnum = projectGraph.enums[0];
    const view = projectGraph.views[0];
    expect(sharedTable?.range.filepath).toBe("/shared.dbml");
    expect(shared.slice(sharedTable?.range.startOffset, sharedTable?.range.endOffset)).toContain(
      "Table shared.users",
    );
    expect(sharedEnum?.range.filepath).toBe("/shared.dbml");
    expect(sharedTable?.note).toMatchObject({ value: "", range: { filepath: "/shared.dbml" } });
    expect(sharedTable?.columns[1]?.note).toMatchObject({
      value: "",
      range: { filepath: "/shared.dbml" },
    });
    expect(view?.range.filepath).toBe("/main.dbml");
    expect(main.slice(view?.range.startOffset, view?.range.endOffset)).toContain(
      "DiagramView shared_only",
    );
  });

  it("registers every stable element key exactly once and returns plain cloneable data", async () => {
    const result = await parseDbmlV2(fullContractSource);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graph = asTestGraph(result.graph);
    const elements = allElements(graph);
    const keys = elements.map((element) => element.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(graph.sourceMap).sort()).toEqual([...keys].sort());
    for (const element of elements) {
      expect(graph.sourceMap[element.key]).toEqual(element.range);
      expect(element.range.endOffset).toBeGreaterThan(element.range.startOffset);
      expect(element.range.startLine).toBeGreaterThan(0);
      expect(element.range.startColumn).toBeGreaterThan(0);
    }

    const jsonRoundTrip = JSON.parse(JSON.stringify(result.graph));
    expect(jsonRoundTrip).toEqual(result.graph);
    expect(structuredClone(result.graph)).toEqual(result.graph);
  });

  it("normalizes the complete deterministic fidelity inventory", async () => {
    const result = await parseDbmlV2(generateFidelityFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graph = asTestGraph(result.graph);

    expect({
      tables: graph.tables.length,
      enums: graph.enums.length,
      tablePartials: graph.partials.length,
      tableGroups: graph.groups.length,
      diagramViews: graph.views.length,
      references: graph.references.length,
    }).toEqual(fixtureInventory.fidelity);
    expect(graph.project).toMatchObject({ name: expect.stringMatching(/^fidelity_/) });
    expect(graph.notes).toHaveLength(1);
    expect(graph.enums.flatMap((dbEnum) => dbEnum.values)).toHaveLength(
      fixtureInventory.fidelity.enums * 3,
    );
    expect(graph.tables.flatMap((table) => table.indexes)).toHaveLength(
      fixtureInventory.fidelity.tables,
    );
  });

  it("includes metadata keys named like source locations in the schema hash", async () => {
    const before = await parseDbmlV2('Table users [range: "before"] { id int [pk] }');
    const after = await parseDbmlV2('Table users [range: "after"] { id int [pk] }');

    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(before.graph.tables[0]?.metadata.range).toBe("before");
    expect(after.graph.tables[0]?.metadata.range).toBe("after");
    expect(after.graph.schemaHash).not.toBe(before.graph.schemaHash);
  });

  it("normalizes boolean and explicit null defaults as discriminated plain data", async () => {
    const result = await parseDbmlV2(`Table flags {
  enabled boolean [default: true]
  archived boolean [default: false]
  deleted_at timestamp [default: null]
}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.tables[0]?.columns.map((column) => column.default)).toEqual([
      { type: "boolean", value: true },
      { type: "boolean", value: false },
      { type: "null", value: null },
    ]);
  });

  it("separates schema-qualified custom type names from their display form", async () => {
    const result = await parseDbmlV2(`Table payloads {
  payload public.custom_type
}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.tables[0]?.columns[0]?.type).toEqual({
      schemaName: "public",
      name: "custom_type",
      arguments: null,
      display: "public.custom_type",
    });
  });

  it("preserves explicit empty note values and their literal ranges", async () => {
    const source = `Project empty_notes {
  Note: ""
}

TablePartial audit_fields {
  created_at timestamp [note: ""]

  indexes {
    created_at [name: "audit_created", note: ""]
  }

  Note: ""
}

Enum status {
  active [note: ""]
}

Table users {
  ~audit_fields
  id int [pk, note: ""]

  indexes {
    id [name: "users_id", note: ""]
  }

  Note: ""
}

TableGroup identity {
  users
  Note: ""
}

Note empty_sticky {
  ""
}`;
    const result = await parseDbmlV2(source, "/empty-notes.dbml");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graph = result.graph;
    const notes = [
      graph.project?.note,
      graph.partials[0]?.note,
      graph.partials[0]?.columns[0]?.note,
      graph.partials[0]?.indexes[0]?.note,
      graph.enums[0]?.values[0]?.note,
      graph.tables[0]?.note,
      graph.tables[0]?.columns.find((column) => column.name === "id")?.note,
      graph.tables[0]?.indexes.find((index) => index.name === "users_id")?.note,
      graph.groups[0]?.note,
    ];

    for (const note of notes) {
      expect(note).toMatchObject({ value: "", range: { filepath: "/empty-notes.dbml" } });
      if (note) expect(source.slice(note.range.startOffset, note.range.endOffset)).toBe('""');
    }
    expect(graph.notes[0]).toMatchObject({
      content: "",
      contentRange: { filepath: "/empty-notes.dbml" },
    });
    const sticky = graph.notes[0];
    if (sticky) {
      expect(source.slice(sticky.contentRange.startOffset, sticky.contentRange.endOffset)).toBe(
        '""',
      );
    }
  });

  it("links partial inline references to their definition and table injection", async () => {
    const source = `TablePartial ownership {
  owner_id bigint [ref: > users.id]
}

Table users {
  id bigint [pk]
}

Table posts {
  ~ownership
}`;
    const result = await parseDbmlV2(source);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reference = result.graph.references[0];
    expect(reference?.injectedFrom).toMatchObject({
      partialKey: 'partial:["ownership"]',
      partialElementKey: 'partialColumn:["ownership","owner_id"]',
    });
    if (!reference?.injectedFrom) return;
    expect(source.slice(reference.range.startOffset, reference.range.endOffset)).toContain(
      "owner_id bigint",
    );
    expect(
      source.slice(
        reference.injectedFrom.injectionRange.startOffset,
        reference.injectedFrom.injectionRange.endOffset,
      ),
    ).toBe("~ownership");
  });
});
