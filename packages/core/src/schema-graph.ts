import type { Diagnostic } from "@er-diagram/contracts";

export const DBML_PARSER_VERSION = "9.1.1" as const;

export interface SourceRange {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  filepath: string;
}

export interface ColumnNode {
  key: string;
  name: string;
  type: string;
  primaryKey: boolean;
  unique: boolean;
  notNull: boolean;
  injectedFromPartial?: string;
  range: SourceRange;
}

export interface TableNode {
  key: string;
  schemaName: string;
  name: string;
  columns: ColumnNode[];
  partialNames: string[];
  metadata: Record<string, string>;
  range: SourceRange;
}

export interface EnumNode {
  key: string;
  schemaName: string;
  name: string;
  values: string[];
  range: SourceRange;
}

export interface ReferenceEndpoint {
  tableKey: string;
  fieldNames: string[];
  relation: string;
}

export interface ReferenceEdge {
  key: string;
  name: string | null;
  endpoints: [ReferenceEndpoint, ReferenceEndpoint];
  onDelete?: string;
  onUpdate?: string;
  range: SourceRange;
}

export interface TableGroupNode {
  key: string;
  schemaName: string;
  name: string;
  tableKeys: string[];
  metadata: Record<string, string>;
  range: SourceRange;
}

export interface TablePartialNode {
  key: string;
  name: string;
  fieldNames: string[];
  range: SourceRange;
}

export interface DiagramViewNode {
  key: string;
  schemaName: string | null;
  name: string;
  visibleTableKeys: string[] | null;
  visibleGroupKeys: string[] | null;
  visibleSchemaNames: string[] | null;
  range: SourceRange;
}

export interface SchemaGraph {
  parserVersion: typeof DBML_PARSER_VERSION;
  schemaHash: string;
  tables: TableNode[];
  enums: EnumNode[];
  references: ReferenceEdge[];
  groups: TableGroupNode[];
  partials: TablePartialNode[];
  views: DiagramViewNode[];
  diagnostics: Diagnostic[];
  sourceMap: Record<string, SourceRange>;
}

export function qualifiedElementKey(
  kind: "table" | "column" | "enum" | "reference" | "group" | "partial" | "view",
  ...segments: Array<string | null>
): string {
  return `${kind}:${JSON.stringify(segments)}`;
}
