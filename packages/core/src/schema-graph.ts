import type { Diagnostic, SourceRange } from "@er-diagram/contracts";

export type { SourceRange } from "@er-diagram/contracts";

export const DBML_PARSER_VERSION = "9.1.1" as const;

/** Stable parser-neutral identity encoded as `<kind>:<canonical JSON segments>`. */
export type SchemaElementKey = string;

export type SchemaElementKind =
  | "project"
  | "note"
  | "table"
  | "column"
  | "index"
  | "check"
  | "enum"
  | "enumValue"
  | "reference"
  | "group"
  | "partial"
  | "partialColumn"
  | "partialIndex"
  | "partialCheck"
  | "view";

export type SchemaKeySegment =
  | string
  | number
  | boolean
  | null
  | SchemaKeySegment[]
  | { [key: string]: SchemaKeySegment };

/** Stable source lookup for every normalized schema element. */
export type SourceMap = Record<SchemaElementKey, SourceRange>;

export interface TextNote {
  value: string;
  range: SourceRange;
}

export interface ProjectNode {
  key: SchemaElementKey;
  name: string;
  databaseType: string | null;
  note: TextNote | null;
  range: SourceRange;
}

export interface StickyNoteNode {
  key: SchemaElementKey;
  name: string;
  content: string;
  contentRange: SourceRange;
  color: string | null;
  metadata: Record<string, string>;
  range: SourceRange;
}

export interface ColumnTypeNode {
  schemaName: string | null;
  name: string;
  arguments: string | null;
  display: string;
}

export type ColumnDefaultNode =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "expression"; value: string }
  | { type: "null"; value: null };

export interface PartialInjectionProvenance {
  partialKey: SchemaElementKey;
  /** Stable key of the partial element responsible for the injected schema element. */
  partialElementKey: SchemaElementKey;
  injectionRange: SourceRange;
}

export interface ColumnNode {
  key: SchemaElementKey;
  name: string;
  type: ColumnTypeNode;
  primaryKey: boolean;
  unique: boolean;
  notNull: boolean;
  default: ColumnDefaultNode | null;
  increment: boolean;
  note: TextNote | null;
  metadata: Record<string, string>;
  checks: CheckNode[];
  injectedFrom: PartialInjectionProvenance | null;
  range: SourceRange;
}

export interface IndexColumnTermNode {
  kind: "COLUMN";
  columnKey: SchemaElementKey;
  range: SourceRange;
}

export interface IndexExpressionTermNode {
  kind: "EXPRESSION";
  expression: string;
  range: SourceRange;
}

export type IndexTermNode = IndexColumnTermNode | IndexExpressionTermNode;

export interface IndexNode {
  key: SchemaElementKey;
  name: string | null;
  terms: IndexTermNode[];
  type: string | null;
  unique: boolean;
  primaryKey: boolean;
  note: TextNote | null;
  injectedFrom: PartialInjectionProvenance | null;
  range: SourceRange;
}

export interface CheckNode {
  key: SchemaElementKey;
  name: string | null;
  expression: string;
  tableKey: SchemaElementKey | null;
  columnKey: SchemaElementKey | null;
  injectedFrom: PartialInjectionProvenance | null;
  range: SourceRange;
}

export interface TableNode {
  key: SchemaElementKey;
  schemaName: string;
  name: string;
  alias: string | null;
  note: TextNote | null;
  color: string | null;
  metadata: Record<string, string>;
  columns: ColumnNode[];
  indexes: IndexNode[];
  checks: CheckNode[];
  partialKeys: SchemaElementKey[];
  range: SourceRange;
}

export interface EnumValueNode {
  key: SchemaElementKey;
  name: string;
  note: TextNote | null;
  range: SourceRange;
}

export interface EnumNode {
  key: SchemaElementKey;
  schemaName: string;
  name: string;
  note: TextNote | null;
  values: EnumValueNode[];
  range: SourceRange;
}

export interface MultiplicityNode {
  min: number;
  /** `null` represents an unbounded maximum. */
  max: number | null;
}

export interface ReferenceEndpoint {
  tableKey: SchemaElementKey;
  columnKeys: SchemaElementKey[];
  multiplicity: MultiplicityNode;
  range: SourceRange;
}

export interface ReferenceEdge {
  key: SchemaElementKey;
  schemaName: string;
  name: string | null;
  endpoints: [ReferenceEndpoint, ReferenceEndpoint];
  onDelete: string | null;
  onUpdate: string | null;
  color: string | null;
  inactive: boolean;
  injectedFrom: PartialInjectionProvenance | null;
  range: SourceRange;
}

export interface TableGroupNode {
  key: SchemaElementKey;
  schemaName: string;
  name: string;
  tableKeys: SchemaElementKey[];
  note: TextNote | null;
  color: string | null;
  metadata: Record<string, string>;
  range: SourceRange;
}

export interface TablePartialNode {
  key: SchemaElementKey;
  name: string;
  note: TextNote | null;
  color: string | null;
  columns: ColumnNode[];
  indexes: IndexNode[];
  checks: CheckNode[];
  range: SourceRange;
}

/**
 * DiagramView filters are tri-state: `[]` shows all, a non-empty list selects items,
 * and `null` hides all items of that kind.
 */
export interface DiagramViewNode {
  key: SchemaElementKey;
  schemaName: string | null;
  name: string;
  visibleTableKeys: SchemaElementKey[] | null;
  visibleNoteKeys: SchemaElementKey[] | null;
  visibleGroupKeys: SchemaElementKey[] | null;
  visibleSchemaNames: string[] | null;
  range: SourceRange;
}

export interface SchemaGraph {
  parserVersion: typeof DBML_PARSER_VERSION;
  schemaHash: string;
  project: ProjectNode | null;
  notes: StickyNoteNode[];
  tables: TableNode[];
  enums: EnumNode[];
  references: ReferenceEdge[];
  groups: TableGroupNode[];
  partials: TablePartialNode[];
  views: DiagramViewNode[];
  diagnostics: Diagnostic[];
  sourceMap: SourceMap;
}

export interface SchemaGraphMetrics {
  readonly tables: number;
  readonly references: number;
  readonly totalElements: number;
}

export function measureSchemaGraph(graph: SchemaGraph): SchemaGraphMetrics {
  let columns = 0;
  let indexes = 0;
  let checks = 0;
  for (const table of graph.tables) {
    columns += table.columns.length;
    indexes += table.indexes.length;
    checks += table.checks.length;
    for (const column of table.columns) checks += column.checks.length;
  }

  let enumValues = 0;
  for (const schemaEnum of graph.enums) enumValues += schemaEnum.values.length;

  let partialElements = 0;
  for (const partial of graph.partials) {
    partialElements += partial.columns.length + partial.indexes.length + partial.checks.length;
    for (const column of partial.columns) partialElements += column.checks.length;
  }

  return {
    tables: graph.tables.length,
    references: graph.references.length,
    totalElements:
      graph.tables.length +
      columns +
      indexes +
      checks +
      graph.enums.length +
      enumValues +
      graph.references.length +
      graph.groups.length +
      graph.partials.length +
      partialElements +
      graph.views.length +
      graph.notes.length,
  };
}

export function qualifiedElementKey(
  kind: SchemaElementKind,
  ...segments: SchemaKeySegment[]
): SchemaElementKey {
  return `${kind}:${JSON.stringify(canonicalizeKeyValue(segments))}`;
}

function canonicalizeKeyValue(value: SchemaKeySegment): SchemaKeySegment {
  if (Array.isArray(value)) return value.map(canonicalizeKeyValue);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalizeKeyValue(child)]),
  );
}
