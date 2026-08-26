import type { ElkExtendedEdge, ElkNode } from "elkjs";
import type { CSSProperties } from "react";
import type { DiagramLayoutDirection } from "./layout-worker-contract.js";
import type { DiagramProjection, SchemaDiagramNode } from "./types.js";

export interface ElkLayoutEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
}

export interface DiagramLayoutOptions {
  direction?: DiagramLayoutDirection;
  engine?: ElkLayoutEngine;
}

interface LayoutNodeResult {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function layoutDiagram(
  projection: DiagramProjection,
  options: DiagramLayoutOptions = {},
): Promise<DiagramProjection> {
  const graph = toElkGraph(projection, options.direction ?? "RIGHT");
  const engine = options.engine ?? (await createDefaultElkEngine());
  const result = await engine.layout(graph);
  const layoutByNodeId = collectLayoutResults(result);

  return {
    ...projection,
    nodes: projection.nodes.map((node) => applyLayout(node, layoutByNodeId)),
    // Edge routing is deliberately not persisted in M0. It is always derived by React Flow.
    edges: projection.edges.map((edge) => ({ ...edge, data: { ...edge.data } })),
  };
}

async function createDefaultElkEngine(): Promise<ElkLayoutEngine> {
  // Node-based tests use ELK's bundled fake worker. Browser code injects the API worker engine.
  const { default: ElkConstructor } = await import("elkjs/lib/elk.bundled.js");
  return new ElkConstructor();
}

export function toElkGraph(
  projection: DiagramProjection,
  direction: DiagramLayoutDirection = "RIGHT",
): ElkNode {
  const nodeById = new Map(projection.nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, SchemaDiagramNode[]>();

  for (const node of projection.nodes) {
    if (!node.parentId) continue;
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }

  const children = projection.nodes
    .filter((node) => !node.parentId || !nodeById.has(node.parentId))
    .map((node) => toElkNode(node, childrenByParent));
  const edges: ElkExtendedEdge[] = projection.edges.map((edge) => ({
    id: edge.id,
    sources: [edge.source],
    targets: [edge.target],
  }));

  return {
    id: "diagram-root",
    children,
    edges,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.spacing.nodeNode": "56",
      "elk.spacing.edgeNode": "28",
    },
  };
}

function toElkNode(
  node: SchemaDiagramNode,
  childrenByParent: ReadonlyMap<string, readonly SchemaDiagramNode[]>,
): ElkNode {
  const children = childrenByParent.get(node.id);
  const width = numericNodeDimension(node, "width");
  const height = numericNodeDimension(node, "height");

  if (!children || children.length === 0) {
    return { id: node.id, width, height };
  }

  return {
    id: node.id,
    children: children.map((child) => toElkNode(child, childrenByParent)),
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.padding": "[top=72,left=28,bottom=28,right=28]",
      "elk.spacing.nodeNode": "32",
    },
  };
}

function collectLayoutResults(root: ElkNode): ReadonlyMap<string, LayoutNodeResult> {
  const result = new Map<string, LayoutNodeResult>();

  function visit(node: ElkNode): void {
    if (node.id !== root.id) {
      const x = finiteCoordinate(node.x, node.id, "x");
      const y = finiteCoordinate(node.y, node.id, "y");
      const width = finiteCoordinate(node.width, node.id, "width");
      const height = finiteCoordinate(node.height, node.id, "height");
      result.set(node.id, { x, y, width, height });
    }
    for (const child of node.children ?? []) visit(child);
  }

  visit(root);
  return result;
}

function applyLayout(
  node: SchemaDiagramNode,
  layoutByNodeId: ReadonlyMap<string, LayoutNodeResult>,
): SchemaDiagramNode {
  const layout = layoutByNodeId.get(node.id);
  if (!layout) throw new Error(`ELK did not return a position for node ${node.id}`);
  const style: CSSProperties = {
    ...node.style,
    width: layout.width,
    height: layout.height,
  };
  return {
    ...node,
    position: { x: layout.x, y: layout.y },
    style,
  };
}

function numericNodeDimension(node: SchemaDiagramNode, dimension: "height" | "width"): number {
  const value = node.style?.[dimension];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return dimension === "width" ? 260 : 80;
}

function finiteCoordinate(
  value: number | undefined,
  nodeId: string,
  coordinate: "height" | "width" | "x" | "y",
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`ELK returned a non-finite ${coordinate} for node ${nodeId}`);
  }
  return value;
}
