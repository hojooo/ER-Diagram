import type { ColumnNode, SchemaElementKey } from "@er-diagram/core";
import type { Edge, Node } from "@xyflow/react";

export type DiagramLod = "NAME_ONLY" | "KEYS_ONLY" | "FULL";
export type DiagramViewKey = "GLOBAL" | string;

export type DiagramColumn = Pick<ColumnNode, "key" | "name" | "primaryKey"> & {
  type: string;
  foreignKey: boolean;
  partialName: string | null;
};

export type TableDiagramNodeData = {
  kind: "table";
  tableKey: string;
  schemaName: string;
  name: string;
  columns: DiagramColumn[];
  lod: DiagramLod;
  selectedElementKey?: string | null;
} & Record<string, unknown>;

export type GroupDiagramNodeData = {
  kind: "group";
  groupKey: string;
  schemaName: string;
  name: string;
  tableKeys: string[];
  tableCount: number;
  color: string | null;
  collapsed: boolean;
  lod: DiagramLod;
  selectedElementKey?: string | null;
} & Record<string, unknown>;

export type ReferenceDiagramEdgeData = {
  kind: "reference";
  aggregate: boolean;
  count: number;
  referenceKeys: string[];
  referenceName?: string | null;
  inactive: boolean;
  sourceMultiplicity?: string;
  targetMultiplicity?: string;
} & Record<string, unknown>;

export type TableDiagramNode = Node<TableDiagramNodeData, "table"> & {
  type: "table";
};

export type GroupDiagramNode = Node<GroupDiagramNodeData, "group"> & {
  type: "group";
};

export type SchemaDiagramNode = GroupDiagramNode | TableDiagramNode;

export type SchemaDiagramEdge = Edge<ReferenceDiagramEdgeData, "reference"> & {
  type: "reference";
  data: ReferenceDiagramEdgeData;
};

export interface DiagramProjection {
  viewKey: DiagramViewKey;
  lod: DiagramLod;
  nodes: SchemaDiagramNode[];
  edges: SchemaDiagramEdge[];
}

export interface DiagramViewOption {
  key: DiagramViewKey;
  label: string;
}

export interface DiagramVisibility {
  viewKey: DiagramViewKey;
  tableKeys: ReadonlySet<SchemaElementKey>;
  groupKeys: ReadonlySet<SchemaElementKey>;
  referenceKeys: ReadonlySet<SchemaElementKey>;
  schemaNames: ReadonlySet<string>;
}

export type DiagramSearchElementKind = "table" | "column" | "group";

interface DiagramElementSearchResult {
  resultId: string;
  kind: DiagramSearchElementKind;
  elementKey: SchemaElementKey;
  shortLabel: string;
  qualifiedLabel: string;
  tableKeys: SchemaElementKey[];
  groupKeys: SchemaElementKey[];
}

export interface TableSearchResult extends DiagramElementSearchResult {
  kind: "table";
}

export interface ColumnSearchResult extends DiagramElementSearchResult {
  kind: "column";
  ownerLabel: string;
}

export interface GroupSearchResult extends DiagramElementSearchResult {
  kind: "group";
}

export interface SchemaSearchResult {
  resultId: string;
  kind: "schema";
  schemaName: string;
  shortLabel: string;
  qualifiedLabel: string;
  tableKeys: SchemaElementKey[];
  groupKeys: SchemaElementKey[];
}

export type DiagramSearchResult =
  | TableSearchResult
  | ColumnSearchResult
  | GroupSearchResult
  | SchemaSearchResult;

export interface DiagramFocusRequest {
  requestId: number;
  tableKeys: SchemaElementKey[];
  groupKeys: SchemaElementKey[];
}

export interface DiagramViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
