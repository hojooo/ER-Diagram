import type {
  ColumnNode,
  DiagramViewNode,
  ReferenceEdge,
  SchemaGraph,
  SourceRange,
  TableGroupNode,
  TableNode,
} from "@er-diagram/core";

const range: SourceRange = {
  startOffset: 0,
  endOffset: 0,
  startLine: 1,
  startColumn: 1,
  endLine: 1,
  endColumn: 1,
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
  view("full_schema", [], []),
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
  tables,
  enums: [],
  references,
  groups: [identityGroup, commerceGroup],
  partials: [],
  views,
  diagnostics: [],
  sourceMap: {},
};

function table(schemaName: string, name: string, columns: ColumnNode[]): TableNode {
  return {
    key: demoElementKey("table", schemaName, name),
    schemaName,
    name,
    columns,
    partialNames: [],
    metadata: {},
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
    key: demoElementKey("column", schemaName, tableName, name),
    name,
    type: name === "email" || name === "display_name" || name === "name" ? "varchar" : "bigint",
    primaryKey,
    unique: false,
    notNull: primaryKey,
    range,
  };
}

function group(schemaName: string, name: string, tableKeys: string[]): TableGroupNode {
  return {
    key: demoElementKey("group", schemaName, name),
    schemaName,
    name,
    tableKeys,
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
    key: demoElementKey("reference", "demo", name),
    name,
    endpoints: [
      {
        tableKey: keyOfTable(sourceTableName),
        fieldNames: [sourceFieldName],
        relation: "many",
      },
      {
        tableKey: keyOfTable(targetTableName),
        fieldNames: [targetFieldName],
        relation: "one",
      },
    ],
    range,
  };
}

function view(
  name: string,
  visibleTableNames: string[] | null,
  visibleGroupKeys: string[] | null,
): DiagramViewNode {
  return {
    key: demoElementKey("view", null, name),
    schemaName: null,
    name,
    visibleTableKeys: visibleTableNames?.map(keyOfTable) ?? null,
    visibleGroupKeys,
    visibleSchemaNames: null,
    range,
  };
}

function keyOfTable(name: string): string {
  const found = tableByName.get(name);
  if (!found) throw new Error(`Unknown demo table: ${name}`);
  return found.key;
}

function demoElementKey(kind: string, ...segments: Array<string | null>): string {
  return `${kind}:${JSON.stringify(segments)}`;
}
