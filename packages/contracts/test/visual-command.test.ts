import { describe, expect, it } from "vitest";

import { type VisualCommand, visualCommandKindSchema, visualCommandSchema } from "../src/index.js";

const COMMAND_ID = "123e4567-e89b-42d3-a456-426614174000";
const TABLE_KEY = 'table:["public","users"]';
const OTHER_TABLE_KEY = 'table:["public","accounts"]';
const COLUMN_KEY = 'column:["public","users","id"]';
const OTHER_COLUMN_KEY = 'column:["public","users","email"]';
const REFERENCE_KEY = 'reference:["public","users_accounts"]';
const INDEX_KEY = 'index:["public","users",{"name":"users_email_idx"}]';
const CHECK_KEY = 'check:["public","users",{"name":"users_email_check"}]';
const GROUP_KEY = 'group:["public","identity"]';
const VIEW_KEY = 'view:[null,"identity_overview"]';
const NOTE_KEY = 'note:["identity_note"]';

const base = {
  commandId: COMMAND_ID,
  expectedSchemaRevisionNo: 7,
};

const validCommands = [
  {
    ...base,
    kind: "CREATE_TABLE",
    table: {
      schemaName: "서비스.스키마",
      name: "사용자 테이블 😀",
      note: "첫 줄\n둘째 줄",
      color: "#12AbEf",
      columns: [
        {
          name: "식별자",
          type: "bigint",
          primaryKey: true,
          unique: false,
          notNull: true,
          default: null,
          increment: true,
          note: "초기 컬럼",
        },
      ],
    },
  },
  {
    ...base,
    kind: "UPDATE_TABLE",
    targetTableKey: TABLE_KEY,
    changes: { note: null, color: "#112233" },
  },
  { ...base, kind: "RENAME_TABLE", targetTableKey: TABLE_KEY, newName: "members" },
  { ...base, kind: "DELETE_TABLE", targetTableKey: TABLE_KEY },
  {
    ...base,
    kind: "CREATE_COLUMN",
    targetTableKey: TABLE_KEY,
    column: {
      name: "가입 시각",
      type: '"custom schema"."timestamp type"(6)',
      primaryKey: false,
      unique: false,
      notNull: true,
      default: { type: "expression", value: "now()" },
      increment: false,
      note: "UTC 기준",
    },
  },
  {
    ...base,
    kind: "UPDATE_COLUMN",
    targetTableKey: TABLE_KEY,
    targetColumnKey: COLUMN_KEY,
    changes: {
      type: "bigint",
      primaryKey: true,
      unique: true,
      notNull: true,
      default: null,
      increment: true,
      note: null,
    },
  },
  {
    ...base,
    kind: "RENAME_COLUMN",
    targetTableKey: TABLE_KEY,
    targetColumnKey: COLUMN_KEY,
    newName: "user id",
  },
  {
    ...base,
    kind: "REORDER_COLUMN",
    targetTableKey: TABLE_KEY,
    targetColumnKey: COLUMN_KEY,
    beforeColumnKey: OTHER_COLUMN_KEY,
  },
  {
    ...base,
    kind: "DELETE_COLUMN",
    targetTableKey: TABLE_KEY,
    targetColumnKey: COLUMN_KEY,
  },
  {
    ...base,
    kind: "CREATE_REFERENCE",
    reference: {
      schemaName: "public",
      name: "users_accounts",
      endpoints: [
        {
          tableKey: TABLE_KEY,
          columnKeys: [COLUMN_KEY, OTHER_COLUMN_KEY],
          multiplicity: { min: 0, max: null },
        },
        {
          tableKey: OTHER_TABLE_KEY,
          columnKeys: [
            'column:["public","accounts","user_id"]',
            'column:["public","accounts","email"]',
          ],
          multiplicity: { min: 1, max: 1 },
        },
      ],
      onDelete: "cascade",
      onUpdate: "no action",
      color: "#334455",
      inactive: false,
    },
  },
  {
    ...base,
    kind: "UPDATE_REFERENCE",
    targetReferenceKey: REFERENCE_KEY,
    changes: { name: null, onDelete: "set null", color: null, inactive: true },
  },
  { ...base, kind: "DELETE_REFERENCE", targetReferenceKey: REFERENCE_KEY },
  {
    ...base,
    kind: "CREATE_INDEX",
    targetTableKey: TABLE_KEY,
    index: {
      name: "users_email_idx",
      terms: [
        { kind: "COLUMN", columnKey: OTHER_COLUMN_KEY },
        { kind: "EXPRESSION", expression: "lower(email)" },
      ],
      type: "btree",
      unique: true,
      primaryKey: false,
      note: "로그인 조회",
    },
  },
  {
    ...base,
    kind: "UPDATE_INDEX",
    targetTableKey: TABLE_KEY,
    targetIndexKey: INDEX_KEY,
    changes: { name: null, terms: [{ kind: "COLUMN", columnKey: COLUMN_KEY }] },
  },
  {
    ...base,
    kind: "DELETE_INDEX",
    targetTableKey: TABLE_KEY,
    targetIndexKey: INDEX_KEY,
  },
  {
    ...base,
    kind: "CREATE_CHECK",
    targetTableKey: TABLE_KEY,
    ownerColumnKey: OTHER_COLUMN_KEY,
    check: { name: "users_email_check", expression: "length(email) > 3" },
  },
  {
    ...base,
    kind: "UPDATE_CHECK",
    targetTableKey: TABLE_KEY,
    ownerColumnKey: null,
    targetCheckKey: CHECK_KEY,
    changes: { name: null, expression: "id > 0" },
  },
  {
    ...base,
    kind: "DELETE_CHECK",
    targetTableKey: TABLE_KEY,
    ownerColumnKey: null,
    targetCheckKey: CHECK_KEY,
  },
  {
    ...base,
    kind: "UPDATE_GROUP_MEMBERSHIP",
    targetGroupKey: GROUP_KEY,
    addTableKeys: [TABLE_KEY],
    removeTableKeys: [OTHER_TABLE_KEY],
  },
  {
    ...base,
    kind: "UPDATE_DIAGRAM_VIEW",
    targetViewKey: VIEW_KEY,
    changes: {
      visibleTableKeys: [],
      visibleNoteKeys: [NOTE_KEY],
      visibleGroupKeys: null,
      visibleSchemaNames: ["public", "서비스.스키마"],
    },
  },
] satisfies VisualCommand[];

function commandOfKind<Kind extends VisualCommand["kind"]>(
  kind: Kind,
): Extract<VisualCommand, { kind: Kind }> {
  const command = validCommands.find((candidate) => candidate.kind === kind);
  if (!command) throw new Error(`Missing VisualCommand fixture: ${kind}`);
  return command as Extract<VisualCommand, { kind: Kind }>;
}

describe("VisualCommand contract", () => {
  it("accepts every strict command variant as JSON-safe plain data", () => {
    expect(visualCommandKindSchema.options).toEqual([
      "CREATE_TABLE",
      "UPDATE_TABLE",
      "RENAME_TABLE",
      "DELETE_TABLE",
      "CREATE_COLUMN",
      "UPDATE_COLUMN",
      "RENAME_COLUMN",
      "REORDER_COLUMN",
      "DELETE_COLUMN",
      "CREATE_REFERENCE",
      "UPDATE_REFERENCE",
      "DELETE_REFERENCE",
      "CREATE_INDEX",
      "UPDATE_INDEX",
      "DELETE_INDEX",
      "CREATE_CHECK",
      "UPDATE_CHECK",
      "DELETE_CHECK",
      "UPDATE_GROUP_MEMBERSHIP",
      "UPDATE_DIAGRAM_VIEW",
    ]);

    for (const command of validCommands) {
      const parsed = visualCommandSchema.parse(command);
      expect(parsed).toEqual(command);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
      const clone = Reflect.get(globalThis, "structuredClone");
      expect(clone).toBeTypeOf("function");
      if (typeof clone === "function") expect(clone(parsed)).toEqual(parsed);
    }
  });

  it("rejects an invalid payload for every command kind", () => {
    const createTable = commandOfKind("CREATE_TABLE");
    const createColumn = commandOfKind("CREATE_COLUMN");
    const createReference = commandOfKind("CREATE_REFERENCE");
    const createIndex = commandOfKind("CREATE_INDEX");
    const invalidCommands: unknown[] = [
      { ...createTable, table: { ...createTable.table, name: " \t " } },
      { ...commandOfKind("UPDATE_TABLE"), changes: {} },
      { ...commandOfKind("RENAME_TABLE"), newName: "bad\nname" },
      { ...commandOfKind("DELETE_TABLE"), targetTableKey: COLUMN_KEY },
      { ...createColumn, column: { ...createColumn.column, type: "text; DROP" } },
      { ...commandOfKind("UPDATE_COLUMN"), changes: {} },
      { ...commandOfKind("RENAME_COLUMN"), newName: "bad\rname" },
      { ...commandOfKind("REORDER_COLUMN"), beforeColumnKey: COLUMN_KEY },
      { ...commandOfKind("DELETE_COLUMN"), targetColumnKey: TABLE_KEY },
      {
        ...createReference,
        reference: {
          ...createReference.reference,
          endpoints: [
            createReference.reference.endpoints[0],
            {
              ...createReference.reference.endpoints[1],
              columnKeys: [createReference.reference.endpoints[1].columnKeys[0]],
            },
          ],
        },
      },
      { ...commandOfKind("UPDATE_REFERENCE"), changes: { onDelete: "explode" } },
      { ...commandOfKind("DELETE_REFERENCE"), targetReferenceKey: TABLE_KEY },
      { ...createIndex, index: { ...createIndex.index, terms: [] } },
      { ...commandOfKind("UPDATE_INDEX"), changes: {} },
      { ...commandOfKind("DELETE_INDEX"), targetIndexKey: CHECK_KEY },
      {
        ...commandOfKind("CREATE_CHECK"),
        check: { name: null, expression: " \n " },
      },
      { ...commandOfKind("UPDATE_CHECK"), changes: { ownerColumnKey: COLUMN_KEY } },
      { ...commandOfKind("DELETE_CHECK"), targetCheckKey: INDEX_KEY },
      {
        ...commandOfKind("UPDATE_GROUP_MEMBERSHIP"),
        addTableKeys: [],
        removeTableKeys: [],
      },
      { ...commandOfKind("UPDATE_DIAGRAM_VIEW"), changes: {} },
    ];

    expect(invalidCommands).toHaveLength(visualCommandKindSchema.options.length);
    for (const command of invalidCommands) {
      expect(visualCommandSchema.safeParse(command).success).toBe(false);
    }
  });

  it("rejects invalid envelopes and unknown fields at every trust boundary", () => {
    const command = commandOfKind("CREATE_TABLE");
    expect(visualCommandSchema.safeParse({ ...command, commandId: "not-a-uuid" }).success).toBe(
      false,
    );
    expect(visualCommandSchema.safeParse({ ...command, expectedSchemaRevisionNo: 0 }).success).toBe(
      false,
    );
    expect(visualCommandSchema.safeParse({ ...command, internalGraph: {} }).success).toBe(false);
    expect(
      visualCommandSchema.safeParse({
        ...command,
        table: { ...command.table, metadata: { owner: "hidden" } },
      }).success,
    ).toBe(false);
  });

  it("validates typed defaults without conflating no default and DEFAULT NULL", () => {
    const createColumn = commandOfKind("CREATE_COLUMN");
    const defaults = [
      { type: "number", value: 1.25 },
      { type: "string", value: "사용자 😀" },
      { type: "boolean", value: true },
      { type: "expression", value: "current_timestamp" },
      { type: "null", value: null },
      null,
    ] as const;

    for (const value of defaults) {
      expect(
        visualCommandSchema.safeParse({
          ...createColumn,
          column: { ...createColumn.column, default: value },
        }).success,
      ).toBe(true);
    }
    expect(
      visualCommandSchema.safeParse({
        ...createColumn,
        column: {
          ...createColumn.column,
          default: { type: "number", value: Number.POSITIVE_INFINITY },
        },
      }).success,
    ).toBe(false);
  });

  it("requires one or more uniquely named initial columns for CREATE_TABLE", () => {
    const createTable = commandOfKind("CREATE_TABLE");
    expect(
      visualCommandSchema.safeParse({
        ...createTable,
        table: { ...createTable.table, columns: [] },
      }).success,
    ).toBe(false);
    expect(
      visualCommandSchema.safeParse({
        ...createTable,
        table: {
          ...createTable.table,
          columns: [createTable.table.columns[0], createTable.table.columns[0]],
        },
      }).success,
    ).toBe(false);
  });

  it("enforces unique keys, disjoint membership deltas, and view tri-state filters", () => {
    const groupCommand = commandOfKind("UPDATE_GROUP_MEMBERSHIP");
    expect(
      visualCommandSchema.safeParse({
        ...groupCommand,
        addTableKeys: [TABLE_KEY, TABLE_KEY],
      }).success,
    ).toBe(false);
    expect(
      visualCommandSchema.safeParse({
        ...groupCommand,
        addTableKeys: [TABLE_KEY],
        removeTableKeys: [TABLE_KEY],
      }).success,
    ).toBe(false);

    const viewCommand = commandOfKind("UPDATE_DIAGRAM_VIEW");
    for (const visibleTableKeys of [[], [TABLE_KEY], null] as const) {
      expect(
        visualCommandSchema.safeParse({
          ...viewCommand,
          changes: { visibleTableKeys },
        }).success,
      ).toBe(true);
    }
    expect(
      visualCommandSchema.safeParse({
        ...viewCommand,
        changes: { visibleTableKeys: [TABLE_KEY, TABLE_KEY] },
      }).success,
    ).toBe(false);
  });
});
