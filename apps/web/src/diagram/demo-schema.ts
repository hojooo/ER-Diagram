import {
  type ColumnNode,
  type DiagramViewNode,
  qualifiedElementKey,
  type ReferenceEdge,
  type SchemaGraph,
  type SourceRange,
  type TableGroupNode,
  type TableNode,
} from "@er-diagram/core";

const range: SourceRange = {
  startOffset: 0,
  endOffset: 1,
  startLine: 1,
  startColumn: 1,
  endLine: 1,
  endColumn: 2,
  filepath: "/demo.dbml",
};

const tables = [
  table("identity", "user", [
    column("identity", "user", "id", true),
    column("identity", "user", "email"),
  ]),
  table("identity", "profile", [
    column("identity", "profile", "id", true),
    column("identity", "profile", "user_id"),
    column("identity", "profile", "display_name"),
  ]),
  table("commerce", "product", [
    column("commerce", "product", "id", true),
    column("commerce", "product", "name"),
  ]),
  table("commerce", "order", [
    column("commerce", "order", "id", true),
    column("commerce", "order", "user_id"),
    column("commerce", "order", "product_id"),
  ]),
  table("commerce", "payment", [
    column("commerce", "payment", "id", true),
    column("commerce", "payment", "order_id"),
  ]),
] satisfies TableNode[];

const tableByName = new Map(tables.map((entry) => [entry.name, entry]));

const identityGroup = group("identity", "Identity", [keyOfTable("user"), keyOfTable("profile")]);
const commerceGroup = group("commerce", "Commerce", [
  keyOfTable("product"),
  keyOfTable("order"),
  keyOfTable("payment"),
]);

const references = [
  reference("profile_user", "profile", "user_id", "user", "id"),
  reference("order_user", "order", "user_id", "user", "id"),
  reference("order_product", "order", "product_id", "product", "id"),
  reference("payment_order", "payment", "order_id", "order", "id"),
] satisfies ReferenceEdge[];

const views = [
  view("full_schema", [], [], []),
  view("identity_only", ["user", "profile"], [identityGroup.key]),
  view("commerce_only", ["product", "order", "payment"], [commerceGroup.key]),
  view("orders", ["user", "product", "order"], [commerceGroup.key]),
  view("catalog", ["product"], [commerceGroup.key]),
  view("payments", ["order", "payment"], [commerceGroup.key]),
  view("operations", ["profile", "order", "payment"], null),
] satisfies DiagramViewNode[];

export const demoSchemaGraph: SchemaGraph = {
  parserVersion: "9.1.1",
  schemaHash: "demo-layout-spike-v1",
  project: null,
  notes: [],
  tables,
  enums: [],
  references,
  groups: [identityGroup, commerceGroup],
  partials: [],
  views,
  diagnostics: [],
  sourceMap: Object.fromEntries(
    [
      ...tables,
      ...tables.flatMap((entry) => entry.columns),
      ...references,
      identityGroup,
      commerceGroup,
      ...views,
    ].map((entry) => [entry.key, entry.range]),
  ),
};

function table(schemaName: string, name: string, columns: ColumnNode[]): TableNode {
  return {
    key: qualifiedElementKey("table", schemaName, name),
    schemaName,
    name,
    alias: null,
    note: null,
    color: null,
    columns,
    metadata: {},
    indexes: [],
    checks: [],
    partialKeys: [],
    range,
  };
}

function column(
  schemaName: string,
  tableName: string,
  name: string,
  primaryKey = false,
): ColumnNode {
  return {
    key: qualifiedElementKey("column", schemaName, tableName, name),
    name,
    type: columnType(
      name === "email" || name === "display_name" || name === "name" ? "varchar" : "bigint",
    ),
    primaryKey,
    unique: false,
    notNull: primaryKey,
    default: null,
    increment: false,
    note: null,
    metadata: {},
    checks: [],
    injectedFrom: null,
    range,
  };
}

function columnType(name: string): ColumnNode["type"] {
  return {
    schemaName: null,
    name,
    arguments: null,
    display: name,
  };
}

function group(schemaName: string, name: string, tableKeys: string[]): TableGroupNode {
  return {
    key: qualifiedElementKey("group", schemaName, name),
    schemaName,
    name,
    tableKeys,
    note: null,
    color: null,
    metadata: {},
    range,
  };
}

function reference(
  name: string,
  sourceTableName: string,
  sourceFieldName: string,
  targetTableName: string,
  targetFieldName: string,
): ReferenceEdge {
  return {
    key: qualifiedElementKey("reference", "public", name),
    schemaName: "public",
    name,
    endpoints: [
      {
        tableKey: keyOfTable(sourceTableName),
        columnKeys: [keyOfColumn(sourceTableName, sourceFieldName)],
        multiplicity: { min: 0, max: null },
        range,
      },
      {
        tableKey: keyOfTable(targetTableName),
        columnKeys: [keyOfColumn(targetTableName, targetFieldName)],
        multiplicity: { min: 1, max: 1 },
        range,
      },
    ],
    onDelete: null,
    onUpdate: null,
    color: null,
    inactive: false,
    injectedFrom: null,
    range,
  };
}

function view(
  name: string,
  visibleTableNames: string[] | null,
  visibleGroupKeys: string[] | null,
  visibleNoteKeys: string[] | null = null,
): DiagramViewNode {
  return {
    key: qualifiedElementKey("view", null, name),
    schemaName: null,
    name,
    visibleTableKeys: visibleTableNames?.map(keyOfTable) ?? null,
    visibleNoteKeys,
    visibleGroupKeys,
    visibleSchemaNames: null,
    range,
  };
}

function keyOfColumn(tableName: string, columnName: string): string {
  const table = tableByName.get(tableName);
  const column = table?.columns.find((candidate) => candidate.name === columnName);
  if (!column) throw new Error(`Unknown demo column: ${tableName}.${columnName}`);
  return column.key;
}

function keyOfTable(name: string): string {
  const found = tableByName.get(name);
  if (!found) throw new Error(`Unknown demo table: ${name}`);
  return found.key;
}
