import type { ColumnNode } from "@er-diagram/core";
import type { Edge, Node } from "@xyflow/react";

export type DiagramLod = "NAME_ONLY" | "KEYS_ONLY" | "FULL";
export type DiagramViewKey = "GLOBAL" | string;

export type DiagramColumn = Pick<ColumnNode, "key" | "name" | "type" | "primaryKey"> & {
  foreignKey: boolean;
};

export type TableDiagramNodeData = {
  kind: "table";
  tableKey: string;
  schemaName: string;
  name: string;
  columns: DiagramColumn[];
  lod: DiagramLod;
} & Record<string, unknown>;

export type GroupDiagramNodeData = {
  kind: "group";
  groupKey: string;
  name: string;
  tableCount: number;
  collapsed: boolean;
  lod: DiagramLod;
} & Record<string, unknown>;

export type ReferenceDiagramEdgeData = {
  kind: "reference";
  count: number;
  referenceKeys: string[];
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

export interface DiagramViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
