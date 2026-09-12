import { parseDbmlV2, qualifiedElementKey, type SchemaElementKey } from "@er-diagram/core";
import { describe, expect, it } from "vitest";
import type { TableColumnVisualCommand } from "../src/index.js";
import { applyTextEdits, transformTableColumnCommand } from "../src/index.js";

const COMMAND_ID = "123e4567-e89b-42d3-a456-426614174000";
const TABLE_KEY = qualifiedElementKey("table", "catalog", "users");
const ID_COLUMN_KEY = qualifiedElementKey("column", "catalog", "users", "id");
const EMAIL_COLUMN_KEY = qualifiedElementKey("column", "catalog", "users", "email");
const DISPLAY_COLUMN_KEY = qualifiedElementKey("column", "catalog", "users", "display name");

const source = `// leading table comment must stay here
Table catalog.users as U [headercolor: #112233, owner: "identity"] {
  id bigint [pk, note: "identifier", classification: "synthetic"]
  email varchar [unique]
  "display name" varchar [default: "guest"] // attached inline comment

  indexes {
    email [name: "users_email_idx"]
  }

  Note: "Users"
}

Table catalog.accounts {
  id bigint [pk]
  user_id bigint [ref: > catalog.users.id]
}

Ref account_email: catalog.accounts.user_id > catalog.users.email

TableGroup identity {
  catalog.users
  catalog.accounts
}

DiagramView identity_view {
  Tables {
    catalog.users
    catalog.accounts
  }
  TableGroups {
    identity
  }
}
`;

type TableColumnCommandInput = TableColumnVisualCommand extends infer Command
  ? Command extends TableColumnVisualCommand
    ? Omit<Command, "commandId" | "expectedSchemaRevisionNo">
    : never
  : never;

function command(value: TableColumnCommandInput): TableColumnVisualCommand {
  return {
    commandId: COMMAND_ID,
    expectedSchemaRevisionNo: 7,
    ...value,
  } as TableColumnVisualCommand;
}

async function expectSuccess(
  dbml: string,
  visualCommand: TableColumnVisualCommand,
): Promise<Extract<Awaited<ReturnType<typeof transformTableColumnCommand>>, { ok: true }>> {
  const result = await transformTableColumnCommand(dbml, visualCommand);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const applied = applyTextEdits(dbml, result.edits);
  expect(applied).toEqual({ ok: true, source: result.source });
  const reparsed = await parseDbmlV2(result.source);
  expect(reparsed.ok).toBe(true);
  return result;
}

async function expectFailureCode(
  dbml: string,
  visualCommand: TableColumnVisualCommand,
  code: string,
) {
  const result = await transformTableColumnCommand(dbml, visualCommand);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected visual command failure");
  expect(result.source).toBe(dbml);
  expect(result.diagnostics[0]).toMatchObject({ code, severity: "ERROR" });
  return result;
}

function tableByKey(
  graph: Extract<Awaited<ReturnType<typeof parseDbmlV2>>, { ok: true }>["graph"],
  key: SchemaElementKey,
) {
  return graph.tables.find((table) => table.key === key);
}

describe("table visual source patches", () => {
  it("creates the first table in an empty valid DBML source", async () => {
    const result = await expectSuccess(
      "",
      command({
        kind: "CREATE_TABLE",
        table: {
          schemaName: "public",
          name: "first_table",
          note: null,
          color: null,
          columns: [
            {
              name: "id",
              type: "bigint",
              primaryKey: true,
              unique: false,
              notNull: true,
              default: null,
              increment: false,
              note: null,
            },
          ],
        },
      }),
    );

    expect(result.source).toBe("Table public.first_table {\n  id bigint [pk, not null]\n}\n");
  });

  it("creates a canonical table at EOF without changing preceding bytes", async () => {
    const result = await expectSuccess(
      source,
      command({
        kind: "CREATE_TABLE",
        table: {
          schemaName: "catalog",
          name: "감사 로그 😀",
          note: "첫 줄\n둘째 줄",
          color: "#AABBCC",
          columns: [
            {
              name: "id",
              type: "uuid",
              primaryKey: true,
              unique: false,
              notNull: true,
              default: null,
              increment: false,
              note: null,
            },
            {
              name: "생성 시각",
              type: "timestamp(6)",
              primaryKey: false,
              unique: false,
              notNull: true,
              default: { type: "expression", value: "now()" },
              increment: false,
              note: "UTC",
            },
          ],
        },
      }),
    );

    expect(result.changed).toBe(true);
    expect(result.edits).toHaveLength(1);
    expect(result.source.startsWith(source)).toBe(true);
    expect(result.source.slice(source.length)).toContain(
      'Table catalog."감사 로그 😀" [headercolor: #AABBCC]',
    );
    expect(result.source.slice(source.length)).toContain("  id uuid [pk, not null]");
    expect(result.source.slice(source.length)).toContain(
      '  "생성 시각" timestamp(6) [not null, default: `now()`, note: "UTC"]',
    );

    const parsed = await parseDbmlV2(result.source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      tableByKey(parsed.graph, qualifiedElementKey("table", "catalog", "감사 로그 😀")),
    ).toMatchObject({
      note: { value: "첫 줄\n둘째 줄" },
      color: "#AABBCC",
      columns: [
        expect.objectContaining({ name: "id", primaryKey: true, notNull: true }),
        expect.objectContaining({ name: "생성 시각", notNull: true }),
      ],
    });
  });

  it("creates a quoted qualified table without inventing optional values", async () => {
    const result = await expectSuccess(
      source,
      command({
        kind: "CREATE_TABLE",
        table: {
          schemaName: "서비스.스키마",
          name: "감사 로그",
          note: null,
          color: null,
          columns: [
            {
              name: "event id",
              type: "uuid",
              primaryKey: true,
              unique: false,
              notNull: true,
              default: null,
              increment: false,
              note: null,
            },
          ],
        },
      }),
    );

    const addedSource = result.source.slice(source.length);
    expect(addedSource).toContain(
      'Table "서비스.스키마"."감사 로그" {\n  "event id" uuid [pk, not null]\n}',
    );
    expect(addedSource).not.toContain("headercolor:");
    expect(addedSource).not.toContain("Note:");
  });

  it("updates only table note and header color tokens", async () => {
    const result = await expectSuccess(
      source,
      command({
        kind: "UPDATE_TABLE",
        targetTableKey: TABLE_KEY,
        changes: { note: "Renamed users", color: null },
      }),
    );

    expect(result.source).toContain('[owner: "identity"]');
    expect(result.source).toContain('Note: "Renamed users"');
    expect(result.source).not.toContain("headercolor:");
    expect(result.source).toContain("// leading table comment must stay here");
    expect(result.source).toContain('classification: "synthetic"');
  });

  it("adds missing note and color using the dominant CRLF newline", async () => {
    const crlf = "Table catalog.audit {\r\n\tid bigint\r\n}\r\n";
    const tableKey = qualifiedElementKey("table", "catalog", "audit");
    const result = await expectSuccess(
      crlf,
      command({
        kind: "UPDATE_TABLE",
        targetTableKey: tableKey,
        changes: { note: "감사 😀", color: "#ABCDEF" },
      }),
    );

    expect(result.source).toBe(
      'Table catalog.audit [headercolor: #ABCDEF] {\r\n\tid bigint\r\n\tNote: "감사 😀"\r\n}\r\n',
    );
    expect(result.source.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("preserves an existing table note quote style", async () => {
    const quoted = `Table catalog.audit {
  id bigint
  Note: 'Old note'
}
`;
    const result = await expectSuccess(
      quoted,
      command({
        kind: "UPDATE_TABLE",
        targetTableKey: qualifiedElementKey("table", "catalog", "audit"),
        changes: { note: "New note" },
      }),
    );
    expect(result.source).toContain("Note: 'New note'");
    expect(result.source).not.toContain('Note: "New note"');
  });

  it("returns explicit semantic no-ops without source edits", async () => {
    const result = await expectSuccess(
      source,
      command({
        kind: "UPDATE_TABLE",
        targetTableKey: TABLE_KEY,
        changes: { note: "Users", color: "#112233" },
      }),
    );

    expect(result).toMatchObject({
      changed: false,
      source,
      edits: [],
      semanticDiff: { changes: [], renameCandidates: [] },
    });
  });

  it("renames a table through declarations, refs, groups, and views", async () => {
    const result = await expectSuccess(
      source,
      command({ kind: "RENAME_TABLE", targetTableKey: TABLE_KEY, newName: "members" }),
    );

    expect(result.source).toContain("Table catalog.members as U");
    expect(result.source).toContain("catalog.members.id");
    expect(result.source).toContain("catalog.members.email");
    expect(result.source.match(/catalog\.members/g)?.length).toBe(5);
    expect(result.source).toContain('classification: "synthetic"');
    expect(result.semanticDiff.renameCandidates).toEqual([
      expect.objectContaining({
        elementKind: "table",
        beforeKey: TABLE_KEY,
        afterKey: qualifiedElementKey("table", "catalog", "members"),
        confidence: "HIGH",
      }),
    ]);
  });

  it("quotes a renamed table while preserving its alias", async () => {
    const result = await expectSuccess(
      source,
      command({ kind: "RENAME_TABLE", targetTableKey: TABLE_KEY, newName: "member archive" }),
    );

    expect(result.source).toContain('Table catalog."member archive" as U');
    expect(result.source).toContain('catalog."member archive".id');
  });

  it("blocks deleting a table with external structural dependencies", async () => {
    const result = await transformTableColumnCommand(
      source,
      command({ kind: "DELETE_TABLE", targetTableKey: TABLE_KEY }),
    );

    expect(result).toMatchObject({
      ok: false,
      source,
      diagnostics: [{ code: "VISUAL_DEPENDENCY_CONFLICT", severity: "ERROR" }],
    });
  });

  it("distinguishes table name conflicts from missing targets", async () => {
    await expectFailureCode(
      source,
      command({
        kind: "CREATE_TABLE",
        table: {
          schemaName: "catalog",
          name: "users",
          note: null,
          color: null,
          columns: [
            {
              name: "new_id",
              type: "bigint",
              primaryKey: true,
              unique: false,
              notNull: true,
              default: null,
              increment: false,
              note: null,
            },
          ],
        },
      }),
      "VISUAL_NAME_CONFLICT",
    );
    await expectFailureCode(
      source,
      command({
        kind: "UPDATE_TABLE",
        targetTableKey: qualifiedElementKey("table", "catalog", "missing"),
        changes: { note: "missing" },
      }),
      "VISUAL_TARGET_NOT_FOUND",
    );
  });

  it("deletes an isolated table while preserving its leading comment", async () => {
    const isolated = `// keep this comment
Table catalog.audit {
  id bigint
}

Table catalog.remaining {
  id bigint
}
`;
    const result = await expectSuccess(
      isolated,
      command({
        kind: "DELETE_TABLE",
        targetTableKey: qualifiedElementKey("table", "catalog", "audit"),
      }),
    );

    expect(result.source).toBe(`// keep this comment

Table catalog.remaining {
  id bigint
}
`);
  });

  it("blocks table rename when an opaque expression qualifies the table", async () => {
    const opaque = source.replace(
      '  Note: "Users"',
      '  checks {\n    `users.id > 0`\n  }\n\n  Note: "Users"',
    );
    await expectFailureCode(
      opaque,
      command({ kind: "RENAME_TABLE", targetTableKey: TABLE_KEY, newName: "members" }),
      "VISUAL_OPAQUE_EXPRESSION_DEPENDENCY",
    );
  });

  it("rejects a BOM-prefixed source without removing or normalizing it", async () => {
    const bomSource = `\uFEFFTable catalog.audit {\r\n  id bigint\r\n}\r\n`;
    await expectFailureCode(
      bomSource,
      command({
        kind: "UPDATE_TABLE",
        targetTableKey: qualifiedElementKey("table", "catalog", "audit"),
        changes: { note: "unchanged input" },
      }),
      "VISUAL_SOURCE_INVALID",
    );
  });
});

describe("column visual source patches", () => {
  it("creates a full column before non-column blocks", async () => {
    const result = await expectSuccess(
      source,
      command({
        kind: "CREATE_COLUMN",
        targetTableKey: TABLE_KEY,
        column: {
          name: "가입 시각",
          type: "timestamp(6)",
          primaryKey: false,
          unique: false,
          notNull: true,
          default: { type: "expression", value: "now()" },
          increment: false,
          note: "UTC",
        },
      }),
    );

    const declaration = '  "가입 시각" timestamp(6) [not null, default: `now()`, note: "UTC"]';
    expect(result.source).toContain(declaration);
    expect(result.source.indexOf(declaration)).toBeLessThan(result.source.indexOf("  indexes {"));
  });

  it("renders every typed default without conflating no default and DEFAULT NULL", async () => {
    const cases = [
      [
        { type: "number", value: 1.25 },
        { type: "number", value: 1.25 },
      ],
      [
        { type: "string", value: "사용자 😀" },
        { type: "string", value: "사용자 😀" },
      ],
      [
        { type: "boolean", value: true },
        { type: "boolean", value: true },
      ],
      [
        { type: "expression", value: "now()" },
        { type: "expression", value: "now()" },
      ],
      [
        { type: "null", value: null },
        { type: "null", value: null },
      ],
      [null, null],
    ] as const;

    for (const [columnDefault, expected] of cases) {
      const name = `default_${columnDefault?.type ?? "absent"}`;
      const result = await expectSuccess(
        source,
        command({
          kind: "CREATE_COLUMN",
          targetTableKey: TABLE_KEY,
          column: {
            name,
            type: '"custom schema"."two words"(5)',
            primaryKey: false,
            unique: false,
            notNull: false,
            default: columnDefault,
            increment: false,
            note: null,
          },
        }),
      );
      const parsed = await parseDbmlV2(result.source);
      if (!parsed.ok) throw new Error("expected rendered default to parse");
      const added = tableByKey(parsed.graph, TABLE_KEY)?.columns.find(
        (column) => column.name === name,
      );
      expect(added?.type).toMatchObject({
        schemaName: "custom schema",
        name: "two words",
        arguments: "5",
      });
      expect(added?.default).toEqual(expected);
    }
  });

  it("rejects expression defaults that cannot be represented safely", async () => {
    await expectFailureCode(
      source,
      command({
        kind: "CREATE_COLUMN",
        targetTableKey: TABLE_KEY,
        column: {
          name: "unsafe_default",
          type: "text",
          primaryKey: false,
          unique: false,
          notNull: false,
          default: { type: "expression", value: "`nested`" },
          increment: false,
          note: null,
        },
      }),
      "VISUAL_VALUE_UNREPRESENTABLE",
    );
  });

  it("rolls back when a syntactically valid command renders an invalid DBML type", async () => {
    await expectFailureCode(
      source,
      command({
        kind: "CREATE_COLUMN",
        targetTableKey: TABLE_KEY,
        column: {
          name: "broken_type",
          type: "varchar(",
          primaryKey: false,
          unique: false,
          notNull: false,
          default: null,
          increment: false,
          note: null,
        },
      }),
      "VISUAL_REPARSE_FAILED",
    );
  });

  it("updates requested column settings while preserving metadata and checks", async () => {
    const withCheck = source.replace(
      'classification: "synthetic"',
      'classification: "synthetic", check: `id > 0`',
    );
    const result = await expectSuccess(
      withCheck,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: ID_COLUMN_KEY,
        changes: {
          type: "uuid",
          primaryKey: false,
          notNull: true,
          note: "stable id",
        },
      }),
    );

    expect(result.source).toContain(
      'id uuid [note: "stable id", classification: "synthetic", check: `id > 0`, not null]',
    );
  });

  it("preserves existing setting keys, spacing, order, and single-quote style", async () => {
    const quoted = `Table catalog.contacts {
  email varchar [note : 'Old note',default : 'guest',   owner: 'identity']
}
`;
    const result = await expectSuccess(
      quoted,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: qualifiedElementKey("table", "catalog", "contacts"),
        targetColumnKey: qualifiedElementKey("column", "catalog", "contacts", "email"),
        changes: {
          note: "New note",
          default: { type: "string", value: "member" },
        },
      }),
    );

    expect(result.source).toContain(
      "email varchar [note : 'New note',default : 'member',   owner: 'identity']",
    );
  });

  it("renames a column in declaration, inline/composite refs, and index terms", async () => {
    const composite = source.replace(
      "Ref account_email: catalog.accounts.user_id > catalog.users.email",
      "Ref account_email: catalog.accounts.(user_id, id) > catalog.users.(email, id)",
    );
    const result = await expectSuccess(
      composite,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: EMAIL_COLUMN_KEY,
        newName: "email_address",
      }),
    );

    expect(result.source).toContain("email_address varchar [unique]");
    expect(result.source).toContain("email_address [name:");
    expect(result.source).toContain("catalog.users.(email_address, id)");
  });

  it("atomically renames, updates, and reorders one column", async () => {
    const result = await expectSuccess(
      source,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: EMAIL_COLUMN_KEY,
        newName: "primary_email",
        changes: {
          type: "text",
          unique: false,
          notNull: true,
          default: { type: "string", value: "unknown@example.test" },
          note: "Primary contact",
        },
        beforeColumnKey: ID_COLUMN_KEY,
      }),
    );

    expect(result.source.indexOf("primary_email text")).toBeLessThan(
      result.source.indexOf("id bigint"),
    );
    expect(result.source).toContain(
      'primary_email text [not null, default: "unknown@example.test", note: "Primary contact"]',
    );
    expect(result.source).toContain("primary_email [name:");
    expect(result.source).toContain("catalog.users.primary_email");
    expect(result.semanticDiff.renameCandidates).toEqual([
      expect.objectContaining({
        elementKind: "column",
        beforeKey: EMAIL_COLUMN_KEY,
        confidence: "HIGH",
        reason: "UNIQUE_EXACT_STRUCTURE",
      }),
    ]);
  });

  it("quotes a renamed column across structural references", async () => {
    const result = await expectSuccess(
      source,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: DISPLAY_COLUMN_KEY,
        newName: "full name",
      }),
    );

    expect(result.source).toContain('"full name" varchar');
    expect(result.source).not.toContain('"display name" varchar');
  });

  it("moves a source-owned column to the end while preserving its inline comment", async () => {
    const result = await expectSuccess(
      source,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: DISPLAY_COLUMN_KEY,
        beforeColumnKey: EMAIL_COLUMN_KEY,
      }),
    );

    expect(result.source.indexOf('"display name" varchar')).toBeLessThan(
      result.source.indexOf("email varchar"),
    );
    expect(result.source).toContain("// attached inline comment");
  });

  it("returns an explicit no-op for an already satisfied reorder", async () => {
    const result = await expectSuccess(
      source,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: EMAIL_COLUMN_KEY,
        beforeColumnKey: DISPLAY_COLUMN_KEY,
      }),
    );

    expect(result).toMatchObject({
      changed: false,
      source,
      edits: [],
      semanticDiff: { changes: [], renameCandidates: [] },
    });
  });

  it("applies only the changed part of a mixed ALTER_COLUMN payload", async () => {
    const result = await expectSuccess(
      source,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: EMAIL_COLUMN_KEY,
        newName: "email",
        changes: { type: "varchar", unique: true, notNull: true },
        beforeColumnKey: DISPLAY_COLUMN_KEY,
      }),
    );

    expect(result.source).toContain("email varchar [unique, not null]");
    expect(result.source).toContain("catalog.users.email");
    expect(result.semanticDiff.renameCandidates).toEqual([]);
    expect(result.edits).toHaveLength(1);
  });

  it("returns one durable no-op shape when every ALTER_COLUMN field is already satisfied", async () => {
    const result = await expectSuccess(
      source,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: EMAIL_COLUMN_KEY,
        newName: "email",
        changes: { type: "varchar", unique: true },
        beforeColumnKey: DISPLAY_COLUMN_KEY,
      }),
    );

    expect(result).toMatchObject({
      changed: false,
      source,
      edits: [],
      semanticDiff: { changes: [], renameCandidates: [] },
    });
  });

  it("moves columns later and to the last effective-column position", async () => {
    const movedLater = await expectSuccess(
      source,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: ID_COLUMN_KEY,
        beforeColumnKey: DISPLAY_COLUMN_KEY,
      }),
    );
    expect(movedLater.source.indexOf("email varchar")).toBeLessThan(
      movedLater.source.indexOf("id bigint"),
    );
    expect(movedLater.source.indexOf("id bigint")).toBeLessThan(
      movedLater.source.indexOf('"display name" varchar'),
    );

    const movedLast = await expectSuccess(
      source,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: ID_COLUMN_KEY,
        beforeColumnKey: null,
      }),
    );
    expect(movedLast.source.indexOf('"display name" varchar')).toBeLessThan(
      movedLast.source.indexOf("id bigint"),
    );
    expect(movedLast.source.indexOf("id bigint")).toBeLessThan(
      movedLast.source.indexOf("  indexes {"),
    );
  });

  it("preserves CRLF bytes while reordering a complete column line", async () => {
    const crlf = "Table catalog.audit {\r\n  first bigint // keep\r\n  second varchar\r\n}\r\n";
    const result = await expectSuccess(
      crlf,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: qualifiedElementKey("table", "catalog", "audit"),
        targetColumnKey: qualifiedElementKey("column", "catalog", "audit", "first"),
        beforeColumnKey: null,
      }),
    );

    expect(result.source).toBe(
      "Table catalog.audit {\r\n  second varchar\r\n  first bigint // keep\r\n}\r\n",
    );
  });

  it("deletes an unreferenced column but blocks referenced columns", async () => {
    const deleted = await expectSuccess(
      source,
      command({
        kind: "DELETE_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: DISPLAY_COLUMN_KEY,
      }),
    );
    expect(deleted.source).not.toContain('"display name" varchar');
    expect(deleted.source).not.toContain("// attached inline comment");

    const blocked = await transformTableColumnCommand(
      source,
      command({
        kind: "DELETE_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: EMAIL_COLUMN_KEY,
      }),
    );
    expect(blocked).toMatchObject({
      ok: false,
      source,
      diagnostics: [{ code: "VISUAL_DEPENDENCY_CONFLICT", severity: "ERROR" }],
    });
  });

  it("blocks injected partial targets and opaque expression dependencies", async () => {
    const withPartial = `TablePartial audit_fields {
  created_at timestamp
}

Table catalog.events {
  ~audit_fields
  id bigint
}
`;
    const parsed = await parseDbmlV2(withPartial);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const events = parsed.graph.tables[0];
    const injected = events?.columns.find((column) => column.injectedFrom !== null);
    if (!events || !injected) throw new Error("expected injected partial column");

    const partialResult = await transformTableColumnCommand(
      withPartial,
      command({
        kind: "DELETE_COLUMN",
        targetTableKey: events.key,
        targetColumnKey: injected.key,
      }),
    );
    expect(partialResult).toMatchObject({
      ok: false,
      diagnostics: [{ code: "VISUAL_PARTIAL_TARGET_PROTECTED" }],
    });

    const opaque = source.replace(
      '  Note: "Users"',
      '  checks {\n    `length(email) > 3`\n  }\n\n  Note: "Users"',
    );
    const opaqueResult = await transformTableColumnCommand(
      opaque,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: EMAIL_COLUMN_KEY,
        newName: "email_address",
      }),
    );
    expect(opaqueResult).toMatchObject({
      ok: false,
      source: opaque,
      diagnostics: [{ code: "VISUAL_OPAQUE_EXPRESSION_DEPENDENCY" }],
    });
  });

  it("blocks an injected partial reorder anchor", async () => {
    const withPartial = `TablePartial audit_fields {
  created_at timestamp
}

Table catalog.events {
  id bigint
  ~audit_fields
  payload text
}
`;
    const parsed = await parseDbmlV2(withPartial);
    if (!parsed.ok) throw new Error("expected partial fixture to parse");
    const events = parsed.graph.tables[0];
    const id = events?.columns.find((column) => column.name === "id");
    const injected = events?.columns.find((column) => column.injectedFrom !== null);
    if (!events || !id || !injected) throw new Error("expected partial fixture inventory");

    await expectFailureCode(
      withPartial,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: events.key,
        targetColumnKey: id.key,
        beforeColumnKey: injected.key,
      }),
      "VISUAL_PARTIAL_TARGET_PROTECTED",
    );
  });

  it("distinguishes owner mismatch, name collision, and invalid commands", async () => {
    await expectFailureCode(
      source,
      command({
        kind: "DELETE_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: qualifiedElementKey("column", "catalog", "accounts", "id"),
      }),
      "VISUAL_TARGET_OWNER_MISMATCH",
    );
    await expectFailureCode(
      source,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: EMAIL_COLUMN_KEY,
        newName: "id",
      }),
      "VISUAL_NAME_CONFLICT",
    );

    const invalid = {
      ...command({
        kind: "DELETE_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: DISPLAY_COLUMN_KEY,
      }),
      unknown: true,
    } as unknown as TableColumnVisualCommand;
    await expectFailureCode(source, invalid, "VISUAL_COMMAND_INVALID");
  });

  it("does not treat string literals and comments as opaque identifier dependencies", async () => {
    const literals = `Table catalog.messages {
  id bigint
  email varchar
  note varchar [default: \`'email'\`]

  checks {
    \`note = 'email' /* email */\`
  }
}
`;
    const result = await expectSuccess(
      literals,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: qualifiedElementKey("table", "catalog", "messages"),
        targetColumnKey: qualifiedElementKey("column", "catalog", "messages", "email"),
        newName: "email_address",
      }),
    );
    expect(result.source).toContain("email_address varchar");
    expect(result.source).toContain("note = 'email' /* email */");
  });

  it("returns JSON-safe plain data with the original source on every failure", async () => {
    const success = await expectSuccess(
      source,
      command({
        kind: "ALTER_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: EMAIL_COLUMN_KEY,
        changes: { note: "로그인 😀" },
      }),
    );
    expect(structuredClone(JSON.parse(JSON.stringify(success)))).toEqual(success);

    const failure = await expectFailureCode(
      source,
      command({
        kind: "DELETE_COLUMN",
        targetTableKey: TABLE_KEY,
        targetColumnKey: EMAIL_COLUMN_KEY,
      }),
      "VISUAL_DEPENDENCY_CONFLICT",
    );
    expect(structuredClone(JSON.parse(JSON.stringify(failure)))).toEqual(failure);
  });
});
