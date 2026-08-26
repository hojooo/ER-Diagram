import type { DiagramProjection, DiagramViewportRect, SchemaDiagramNode } from "./types.js";

interface AbsoluteNodeRect extends DiagramViewportRect {
  id: string;
}

export function cullDiagramToViewport(
  projection: DiagramProjection,
  viewport: DiagramViewportRect,
  overscan = 160,
): DiagramProjection {
  if (!Number.isFinite(overscan) || overscan < 0) {
    throw new RangeError("viewport overscan must be a finite non-negative number");
  }
  const expandedViewport = {
    x: viewport.x - overscan,
    y: viewport.y - overscan,
    width: viewport.width + overscan * 2,
    height: viewport.height + overscan * 2,
  };
  const nodeById = new Map(projection.nodes.map((node) => [node.id, node]));
  const absoluteRectById = new Map<string, AbsoluteNodeRect>();
  const keptIds = new Set<string>();

  for (const node of projection.nodes) {
    const rect = absoluteNodeRect(node, nodeById, absoluteRectById, new Set());
    if (rectsIntersect(rect, expandedViewport)) keptIds.add(node.id);
  }

  for (const nodeId of [...keptIds]) {
    let parentId = nodeById.get(nodeId)?.parentId;
    while (parentId) {
      keptIds.add(parentId);
      parentId = nodeById.get(parentId)?.parentId;
    }
  }

  return {
    ...projection,
    nodes: projection.nodes.filter((node) => keptIds.has(node.id)),
    edges: projection.edges.filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target)),
  };
}

function absoluteNodeRect(
  node: SchemaDiagramNode,
  nodeById: ReadonlyMap<string, SchemaDiagramNode>,
  cache: Map<string, AbsoluteNodeRect>,
  visiting: Set<string>,
): AbsoluteNodeRect {
  const cached = cache.get(node.id);
  if (cached) return cached;
  if (visiting.has(node.id)) throw new Error(`Diagram parent cycle detected at ${node.id}`);
  visiting.add(node.id);

  const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
  const parentRect = parent ? absoluteNodeRect(parent, nodeById, cache, visiting) : undefined;
  const rect = {
    id: node.id,
    x: node.position.x + (parentRect?.x ?? 0),
    y: node.position.y + (parentRect?.y ?? 0),
    width: nodeDimension(node, "width"),
    height: nodeDimension(node, "height"),
  };
  visiting.delete(node.id);
  cache.set(node.id, rect);
  return rect;
}

function nodeDimension(node: SchemaDiagramNode, dimension: "width" | "height"): number {
  const measured = node.measured?.[dimension];
  if (typeof measured === "number" && Number.isFinite(measured)) return measured;
  const styled = node.style?.[dimension];
  if (typeof styled === "number" && Number.isFinite(styled)) return styled;
  if (typeof styled === "string") {
    const parsed = Number.parseFloat(styled);
    if (Number.isFinite(parsed)) return parsed;
  }
  return dimension === "width" ? 260 : 80;
}

function rectsIntersect(left: DiagramViewportRect, right: DiagramViewportRect): boolean {
  return (
    left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y
  );
}
