import { getRelationshipOp } from "@dbml/core";
import { parseDbmlV2, qualifiedElementKey, type SchemaGraph } from "@er-diagram/core";
import { describe, expect, it } from "vitest";
import {
  applyTextEdits,
  transformRelationshipIndexCheckCommand,
  type RelationshipIndexCheckVisualCommand,
} from "../src/index.js";

const COMMAND_ID = "123e4567-e89b-42d3-a456-426614174000";
const USERS_KEY = qualifiedElementKey("table", "public", "users");
const ACCOUNTS_KEY = qualifiedElementKey("table", "public", "accounts");
const USERS_ID_KEY = qualifiedElementKey("column", "public", "users", "id");
const USERS_TENANT_KEY = qualifiedElementKey("column", "public", "users", "tenant_id");
const ACCOUNT_ID_KEY = qualifiedElementKey("column", "public", "accounts", "id");
const ACCOUNT_TENANT_KEY = qualifiedElementKey("column", "public", "accounts", "tenant_id");
const ACCOUNT_USER_KEY = qualifiedElementKey("column", "public", "accounts", "user_id");

const baseSource = `// synthetic source fidelity marker
Table public.users {
  tenant_id bigint
  id bigint
  email varchar [check: \`length(email) > 3\`, check: \`email <> ''\`, note: "login"]

  indexes {
    (tenant_id, id) [pk, name: "users_pk"] // composite key
    email [unique, name: "users_email_idx", note: "lookup"]
  }

  checks {
    \`id > 0\` [name: "positive_id"]
  }
}

Table public.accounts {
  tenant_id bigint
  id bigint
  user_id bigint [ref: > public.users.id, note: "inline owner"]
}

Ref account_tenant: public.accounts.tenant_id > public.users.tenant_id

Ref account_owner {
  public.accounts.user_id > public.users.email [delete: restrict, color: #112233]
}
`;

type CommandInput = RelationshipIndexCheckVisualCommand extends infer Command
  ? Command extends RelationshipIndexCheckVisualCommand
    ? Omit<Command, "commandId" | "expectedSchemaRevisionNo">
    : never
  : never;

function command(value: CommandInput): RelationshipIndexCheckVisualCommand {
  return {
    commandId: COMMAND_ID,
    expectedSchemaRevisionNo: 7,
    ...value,
  } as RelationshipIndexCheckVisualCommand;
}

async function graphOf(source: string): Promise<SchemaGraph> {
  const parsed = await parseDbmlV2(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.graph;
}

async function expectSuccess(source: string, visualCommand: RelationshipIndexCheckVisualCommand) {
  const result = await transformRelationshipIndexCheckCommand(source, visualCommand);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(applyTextEdits(source, result.edits)).toEqual({ ok: true, source: result.source });
  expect((await parseDbmlV2(result.source)).ok).toBe(true);
  return result;
}

async function expectFailure(
  source: string,
  visualCommand: RelationshipIndexCheckVisualCommand,
  code: string,
) {
  const result = await transformRelationshipIndexCheckCommand(source, visualCommand);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected visual command failure");
  expect(result.source).toBe(source);
  expect(result.diagnostics[0]).toMatchObject({ code, severity: "ERROR" });
  return result;
}

describe("reference source patches", () => {
  const cardinalities = [
    { min: 1 as const, max: 1 as const },
    { min: 0 as const, max: 1 as const },
    { min: 1 as const, max: null },
    { min: 0 as const, max: null },
  ];

  it.each(cardinalities.flatMap((left) => cardinalities.map((right) => [left, right] as const)))(
    "round-trips multiplicity %j to %j",
    async (left, right) => {
      const expectedOperator = getRelationshipOp(
        left.max === null ? (left.min === 0 ? "0..*" : "*") : left.min === 0 ? "0..1" : "1",
        right.max === null ? (right.min === 0 ? "0..*" : "*") : right.min === 0 ? "0..1" : "1",
      );
      const result = await expectSuccess(
        baseSource,
        command({
          kind: "CREATE_REFERENCE",
          reference: {
            schemaName: "public",
            name: `matrix_${left.min}_${String(left.max)}_${right.min}_${String(right.max)}`,
            endpoints: [
              { tableKey: ACCOUNTS_KEY, columnKeys: [ACCOUNT_ID_KEY], multiplicity: left },
              { tableKey: USERS_KEY, columnKeys: [USERS_ID_KEY], multiplicity: right },
            ],
            onDelete: null,
            onUpdate: null,
            color: null,
            inactive: false,
          },
        }),
      );
      expect(result.source).toContain(` ${expectedOperator} `);
    },
  );

  it("creates a quoted composite inactive reference with actions", async () => {
    const result = await expectSuccess(
      baseSource,
      command({
        kind: "CREATE_REFERENCE",
        reference: {
          schemaName: "public",
          name: "tenant link 😀",
          endpoints: [
            {
              tableKey: ACCOUNTS_KEY,
              columnKeys: [ACCOUNT_TENANT_KEY, ACCOUNT_ID_KEY],
              multiplicity: { min: 0, max: null },
            },
            {
              tableKey: USERS_KEY,
              columnKeys: [USERS_TENANT_KEY, USERS_ID_KEY],
              multiplicity: { min: 0, max: 1 },
            },
          ],
          onDelete: "cascade",
          onUpdate: "no action",
          color: "#AABBCC",
          inactive: true,
        },
      }),
    );
    expect(result.source).toContain('Ref "tenant link 😀":');
    expect(result.source).toContain(
      "public.accounts.(tenant_id, id) ?>? public.users.(tenant_id, id)",
    );
    expect(result.source).toContain(
      "[delete: cascade, update: no action, color: #AABBCC, inactive]",
    );
  });

  it("patches a block reference without replacing its block form", async () => {
    const result = await expectSuccess(
      baseSource,
      command({
        kind: "UPDATE_REFERENCE",
        targetReferenceKey: qualifiedElementKey("reference", "public", "account_owner"),
        changes: { onDelete: "cascade", onUpdate: "set null", color: null, inactive: true },
      }),
    );
    expect(result.source).toContain("Ref account_owner {");
    expect(result.source).toContain(
      "public.accounts.user_id > public.users.email [delete: cascade, update: set null, inactive]",
    );
    expect(result.source).not.toContain("color: #112233");
  });

  it("renames a block reference without flattening it and rejects a named collision", async () => {
    const renamed = await expectSuccess(
      baseSource,
      command({
        kind: "UPDATE_REFERENCE",
        targetReferenceKey: qualifiedElementKey("reference", "public", "account_owner"),
        changes: { name: "renamed owner" },
      }),
    );
    expect(renamed.source).toContain('Ref "renamed owner" {');
    expect(renamed.source).toContain(
      "public.accounts.user_id > public.users.email [delete: restrict, color: #112233]",
    );
    expect(renamed.semanticDiff.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "DELETE", elementKind: "reference" }),
        expect.objectContaining({ operation: "ADD", elementKind: "reference" }),
      ]),
    );

    await expectFailure(
      baseSource,
      command({
        kind: "UPDATE_REFERENCE",
        targetReferenceKey: qualifiedElementKey("reference", "public", "account_owner"),
        changes: { name: "account_tenant" },
      }),
      "VISUAL_NAME_CONFLICT",
    );
  });

  it("keeps a representable inline reference inline", async () => {
    const graph = await graphOf(baseSource);
    const inline = graph.references.find(
      (reference) =>
        reference.name === null &&
        reference.endpoints.some((endpoint) => endpoint.columnKeys.includes(ACCOUNT_USER_KEY)),
    );
    if (!inline) throw new Error("expected inline reference");
    const localIndex = inline.endpoints.findIndex((endpoint) =>
      endpoint.columnKeys.includes(ACCOUNT_USER_KEY),
    );
    const local = inline.endpoints[localIndex];
    const remote = inline.endpoints[localIndex === 0 ? 1 : 0];
    if (!local || !remote) throw new Error("expected inline endpoints");

    const changedLocal = {
      tableKey: local.tableKey,
      columnKeys: [...local.columnKeys],
      multiplicity: { min: 0 as const, max: null },
    };
    const changedRemote = {
      tableKey: remote.tableKey,
      columnKeys: [...remote.columnKeys],
      multiplicity: { min: 0 as const, max: 1 as const },
    };

    const result = await expectSuccess(
      baseSource,
      command({
        kind: "UPDATE_REFERENCE",
        targetReferenceKey: inline.key,
        changes: {
          endpoints:
            localIndex === 0 ? [changedLocal, changedRemote] : [changedRemote, changedLocal],
        },
      }),
    );
    expect(result.source).toContain("user_id bigint [ref: ?>? public.users.id, note:");
  });

  it("materializes an inline reference only when standalone settings are required", async () => {
    const graph = await graphOf(baseSource);
    const inline = graph.references.find(
      (reference) =>
        reference.name === null &&
        reference.endpoints.some((endpoint) => endpoint.columnKeys.includes(ACCOUNT_USER_KEY)),
    );
    if (!inline) throw new Error("expected inline reference");
    const result = await expectSuccess(
      baseSource,
      command({
        kind: "UPDATE_REFERENCE",
        targetReferenceKey: inline.key,
        changes: { name: "materialized", onDelete: "cascade" },
      }),
    );
    expect(result.source).toContain('user_id bigint [note: "inline owner"]');
    expect(result.source).toContain("Ref materialized:");
    expect(result.source).toContain("[delete: cascade]");
  });

  it("deletes only the selected inline ref setting", async () => {
    const source = `Table public.a {\n  id int\n}\nTable public.b {\n  id int\n}\nTable public.c {\n  id int [ref: > public.a.id, ref: > public.b.id, note: "keep"]\n}\n`;
    const graph = await graphOf(source);
    const target = graph.references.find((reference) =>
      reference.endpoints.some(
        (endpoint) => endpoint.tableKey === qualifiedElementKey("table", "public", "a"),
      ),
    );
    if (!target) throw new Error("expected first inline reference");
    const result = await expectSuccess(
      source,
      command({ kind: "DELETE_REFERENCE", targetReferenceKey: target.key }),
    );
    expect(result.source).toContain('id int [ref: > public.b.id, note: "keep"]');
  });

  it("blocks unsupported reference schema and owner mismatch", async () => {
    await expectFailure(
      baseSource,
      command({
        kind: "CREATE_REFERENCE",
        reference: {
          schemaName: "catalog",
          name: "unsupported_schema",
          endpoints: [
            {
              tableKey: ACCOUNTS_KEY,
              columnKeys: [ACCOUNT_ID_KEY],
              multiplicity: { min: 1, max: null },
            },
            {
              tableKey: USERS_KEY,
              columnKeys: [USERS_ID_KEY],
              multiplicity: { min: 1, max: 1 },
            },
          ],
          onDelete: null,
          onUpdate: null,
          color: null,
          inactive: false,
        },
      }),
      "VISUAL_CAPABILITY_UNSUPPORTED",
    );

    await expectFailure(
      baseSource,
      command({
        kind: "CREATE_REFERENCE",
        reference: {
          schemaName: "public",
          name: "bad_owner",
          endpoints: [
            {
              tableKey: ACCOUNTS_KEY,
              columnKeys: [USERS_ID_KEY],
              multiplicity: { min: 1, max: null },
            },
            {
              tableKey: USERS_KEY,
              columnKeys: [USERS_ID_KEY],
              multiplicity: { min: 1, max: 1 },
            },
          ],
          onDelete: null,
          onUpdate: null,
          color: null,
          inactive: false,
        },
      }),
      "VISUAL_TARGET_OWNER_MISMATCH",
    );
  });
});

describe("index source patches", () => {
  it("creates an indexes block with ordered column and expression terms", async () => {
    const result = await expectSuccess(
      baseSource,
      command({
        kind: "CREATE_INDEX",
        targetTableKey: ACCOUNTS_KEY,
        index: {
          name: "account_lookup",
          terms: [
            { kind: "EXPRESSION", expression: "lower(user_id)" },
            { kind: "COLUMN", columnKey: ACCOUNT_TENANT_KEY },
          ],
          type: "gin",
          unique: true,
          primaryKey: false,
          note: "lookup 😀",
        },
      }),
    );
    expect(result.source).toContain("indexes {");
    expect(result.source).toContain(
      '(`lower(user_id)`, tenant_id) [unique, name: "account_lookup", type: gin, note: "lookup 😀"]',
    );
  });

  it("preserves CRLF while creating a canonical indexes block", async () => {
    const source = "Table public.events {\r\n  id bigint\r\n  payload text\r\n}\r\n";
    const graph = await graphOf(source);
    const table = graph.tables[0];
    const payload = table?.columns.find((column) => column.name === "payload");
    if (!table || !payload) throw new Error("expected CRLF fixture inventory");

    const result = await expectSuccess(
      source,
      command({
        kind: "CREATE_INDEX",
        targetTableKey: table.key,
        index: {
          name: "payload_idx",
          terms: [{ kind: "COLUMN", columnKey: payload.key }],
          type: null,
          unique: false,
          primaryKey: false,
          note: null,
        },
      }),
    );
    expect(result.source.replaceAll("\r\n", "")).not.toContain("\n");
    expect(result.source).toContain(
      '\r\n  indexes {\r\n    payload [name: "payload_idx"]\r\n  }\r\n',
    );
  });

  it("updates and deletes only the selected index entry", async () => {
    const result = await expectSuccess(
      baseSource,
      command({
        kind: "UPDATE_INDEX",
        targetTableKey: USERS_KEY,
        targetIndexKey: qualifiedElementKey("index", "public", "users", "users_email_idx"),
        changes: { unique: false, type: "hash", note: "changed" },
      }),
    );
    expect(result.source).toContain('email [name: "users_email_idx", note: "changed", type: hash]');
    expect(result.source).toContain('(tenant_id, id) [pk, name: "users_pk"]');

    const deleted = await expectSuccess(
      baseSource,
      command({
        kind: "DELETE_INDEX",
        targetTableKey: USERS_KEY,
        targetIndexKey: qualifiedElementKey("index", "public", "users", "users_email_idx"),
      }),
    );
    expect(deleted.source).not.toContain("users_email_idx");
    expect(deleted.source).toContain("users_pk");
  });

  it("enforces logical primary-key and expression capability guards", async () => {
    await expectFailure(
      baseSource,
      command({
        kind: "CREATE_INDEX",
        targetTableKey: USERS_KEY,
        index: {
          name: "second_pk",
          terms: [{ kind: "COLUMN", columnKey: USERS_ID_KEY }],
          type: null,
          unique: false,
          primaryKey: true,
          note: null,
        },
      }),
      "VISUAL_PRIMARY_KEY_CONFLICT",
    );

    await expectFailure(
      baseSource,
      command({
        kind: "CREATE_INDEX",
        targetTableKey: ACCOUNTS_KEY,
        index: {
          name: "expression_pk",
          terms: [{ kind: "EXPRESSION", expression: "lower(user_id)" }],
          type: null,
          unique: false,
          primaryKey: true,
          note: null,
        },
      }),
      "VISUAL_CAPABILITY_UNSUPPORTED",
    );

    await expectFailure(
      baseSource,
      command({
        kind: "CREATE_INDEX",
        targetTableKey: ACCOUNTS_KEY,
        index: {
          name: "unsafe_expression",
          terms: [{ kind: "EXPRESSION", expression: "`quoted`" }],
          type: null,
          unique: false,
          primaryKey: false,
          note: null,
        },
      }),
      "VISUAL_VALUE_UNREPRESENTABLE",
    );

    await expectFailure(
      baseSource,
      command({
        kind: "CREATE_INDEX",
        targetTableKey: ACCOUNTS_KEY,
        index: {
          name: "unstable_term_order",
          terms: [
            { kind: "COLUMN", columnKey: ACCOUNT_USER_KEY },
            { kind: "EXPRESSION", expression: "lower(user_id)" },
          ],
          type: null,
          unique: false,
          primaryKey: false,
          note: null,
        },
      }),
      "VISUAL_CAPABILITY_UNSUPPORTED",
    );
  });
});

describe("check source patches", () => {
  it("creates and updates table checks while preserving the checks block", async () => {
    const created = await expectSuccess(
      baseSource,
      command({
        kind: "CREATE_CHECK",
        targetTableKey: ACCOUNTS_KEY,
        ownerColumnKey: null,
        check: { name: "positive_account", expression: "id > 0" },
      }),
    );
    expect(created.source).toContain('`id > 0` [name: "positive_account"]');

    const updated = await expectSuccess(
      baseSource,
      command({
        kind: "UPDATE_CHECK",
        targetTableKey: USERS_KEY,
        ownerColumnKey: null,
        targetCheckKey: qualifiedElementKey("check", "public", "users", "positive_id"),
        changes: { name: "positive_identifier", expression: "id >= 1" },
      }),
    );
    expect(updated.source).toContain('`id >= 1` [name: "positive_identifier"]');
  });

  it("updates and deletes one repeated column check without changing siblings", async () => {
    const graph = await graphOf(baseSource);
    const users = graph.tables.find((table) => table.key === USERS_KEY);
    const email = users?.columns.find((column) => column.name === "email");
    const first = email?.checks[0];
    const second = email?.checks[1];
    if (!email || !first || !second) throw new Error("expected repeated column checks");

    const updated = await expectSuccess(
      baseSource,
      command({
        kind: "UPDATE_CHECK",
        targetTableKey: USERS_KEY,
        ownerColumnKey: email.key,
        targetCheckKey: first.key,
        changes: { expression: "length(email) >= 4" },
      }),
    );
    expect(updated.source).toContain(
      "email varchar [check: `length(email) >= 4`, check: `email <> ''`, note: \"login\"]",
    );

    const deleted = await expectSuccess(
      baseSource,
      command({
        kind: "DELETE_CHECK",
        targetTableKey: USERS_KEY,
        ownerColumnKey: email.key,
        targetCheckKey: second.key,
      }),
    );
    expect(deleted.source).toContain('email varchar [check: `length(email) > 3`, note: "login"]');
  });

  it("blocks named column checks and unsafe expressions", async () => {
    await expectFailure(
      baseSource,
      command({
        kind: "CREATE_CHECK",
        targetTableKey: ACCOUNTS_KEY,
        ownerColumnKey: ACCOUNT_USER_KEY,
        check: { name: "named_inline", expression: "user_id > 0" },
      }),
      "VISUAL_CAPABILITY_UNSUPPORTED",
    );
    await expectFailure(
      baseSource,
      command({
        kind: "CREATE_CHECK",
        targetTableKey: ACCOUNTS_KEY,
        ownerColumnKey: null,
        check: { name: null, expression: "`unsafe`" },
      }),
      "VISUAL_VALUE_UNREPRESENTABLE",
    );
  });

  it("deletes only the selected table check", async () => {
    const deleted = await expectSuccess(
      baseSource,
      command({
        kind: "DELETE_CHECK",
        targetTableKey: USERS_KEY,
        ownerColumnKey: null,
        targetCheckKey: qualifiedElementKey("check", "public", "users", "positive_id"),
      }),
    );
    expect(deleted.source).not.toContain("positive_id");
    expect(deleted.source).toContain("users_email_idx");
  });

  it("protects partial-injected indexes and checks", async () => {
    const source = `TablePartial audit_fields {
  created_at timestamp [check: \`created_at is not null\`]

  indexes {
    created_at [name: "audit_created_idx"]
  }

  checks {
    \`created_at > '2000-01-01'\` [name: "audit_epoch"]
  }
}

Table public.events {
  ~audit_fields
  id bigint
}
`;
    const graph = await graphOf(source);
    const table = graph.tables[0];
    const index = table?.indexes.find((candidate) => candidate.injectedFrom !== null);
    const check = table?.checks.find((candidate) => candidate.injectedFrom !== null);
    if (!table || !index || !check) throw new Error("expected injected index and check");

    await expectFailure(
      source,
      command({
        kind: "DELETE_INDEX",
        targetTableKey: table.key,
        targetIndexKey: index.key,
      }),
      "VISUAL_PARTIAL_TARGET_PROTECTED",
    );
    await expectFailure(
      source,
      command({
        kind: "DELETE_CHECK",
        targetTableKey: table.key,
        ownerColumnKey: null,
        targetCheckKey: check.key,
      }),
      "VISUAL_PARTIAL_TARGET_PROTECTED",
    );
  });

  it("fails closed when duplicate anonymous identities can shift ordinals", async () => {
    const source = `Table public.duplicates {
  id int

  indexes {
    id
    id
  }

  checks {
    \`id > 0\`
    \`id > 0\`
  }
}
`;
    const graph = await graphOf(source);
    const table = graph.tables[0];
    const index = table?.indexes[0];
    const check = table?.checks[0];
    if (!table || !index || !check) throw new Error("expected duplicate anonymous elements");

    await expectFailure(
      source,
      command({
        kind: "UPDATE_INDEX",
        targetTableKey: table.key,
        targetIndexKey: index.key,
        changes: { unique: true },
      }),
      "VISUAL_ANONYMOUS_IDENTITY_AMBIGUOUS",
    );
    await expectFailure(
      source,
      command({
        kind: "UPDATE_CHECK",
        targetTableKey: table.key,
        ownerColumnKey: null,
        targetCheckKey: check.key,
        changes: { expression: "id >= 1" },
      }),
      "VISUAL_ANONYMOUS_IDENTITY_AMBIGUOUS",
    );
  });

  it("returns deterministic JSON-safe success and failure results", async () => {
    const noOp = await expectSuccess(
      baseSource,
      command({
        kind: "UPDATE_CHECK",
        targetTableKey: USERS_KEY,
        ownerColumnKey: null,
        targetCheckKey: qualifiedElementKey("check", "public", "users", "positive_id"),
        changes: { expression: "id > 0" },
      }),
    );
    expect(noOp).toMatchObject({ changed: false, edits: [], semanticDiff: { changes: [] } });
    expect(structuredClone(JSON.parse(JSON.stringify(noOp)))).toEqual(noOp);

    const failure = await expectFailure(
      baseSource,
      command({
        kind: "DELETE_CHECK",
        targetTableKey: ACCOUNTS_KEY,
        ownerColumnKey: null,
        targetCheckKey: qualifiedElementKey("check", "public", "accounts", "missing"),
      }),
      "VISUAL_TARGET_NOT_FOUND",
    );
    expect(structuredClone(JSON.parse(JSON.stringify(failure)))).toEqual(failure);
  });
});
