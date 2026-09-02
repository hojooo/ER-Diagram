import type { DiagramPosition, DiagramViewport } from "@er-diagram/contracts";

import type { DiagramViewportInsets } from "./base-schema-diagram-contract.js";
import type {
  DiagramProjection,
  GroupDiagramNode,
  SchemaDiagramNode,
  TableDiagramNode,
} from "./types.js";

const GROUP_HEADER_HEIGHT = 56;
const GROUP_PADDING = 24;
const CHILD_GAP = 32;
const CHILD_COLUMNS = 2;
const ROOT_GAP = 80;
const ROOT_ROW_WIDTH = 3_200;

interface NodeSize {
  readonly width: number;
  readonly height: number;
}

interface MutablePoint {
  x: number;
  y: number;
}

interface GroupPlacement {
  readonly position: MutablePoint | null;
  readonly childPositions: ReadonlyMap<string, MutablePoint>;
  readonly size: NodeSize;
}

export interface InteractiveLayoutOptions {
  readonly savedPositions?: Readonly<Record<string, DiagramPosition>>;
  readonly previousProjection?: DiagramProjection | null;
}

export interface InteractiveViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface InteractiveViewportOptions {
  readonly padding?: number;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly insets?: DiagramViewportInsets;
  readonly targetNodeIds?: ReadonlySet<string>;
}

/**
 * Produces the final interactive projection without invoking the asynchronous ELK worker.
 * Persisted view coordinates win, then matching absolute coordinates from the prior stable
 * projection, and finally deterministic source-free shelf placement fills missing nodes.
 */
export function deriveInteractiveLayout(
  projection: DiagramProjection,
  options: InteractiveLayoutOptions = {},
): DiagramProjection {
  if (projection.nodes.length === 0) return cloneProjection(projection);

  const savedPositions = options.savedPositions ?? {};
  const previousAbsolute = collectAbsolutePositions(options.previousProjection ?? null);
  const nodeById = new Map(projection.nodes.map((node) => [node.id, node]));
  const childrenByParent = collectChildren(projection.nodes, nodeById);
  const groupPlacements = new Map<string, GroupPlacement>();
  const rootPositions = new Map<string, MutablePoint>();
  const rootSizes = new Map<string, NodeSize>();

  for (const node of projection.nodes) {
    if (node.type !== "group") continue;
    const children = childrenByParent.get(node.id) ?? [];
    const placement = placeGroup(node, children, savedPositions, previousAbsolute);
    groupPlacements.set(node.id, placement);
    rootSizes.set(node.id, placement.size);
    if (placement.position) rootPositions.set(node.id, placement.position);
  }

  for (const node of projection.nodes) {
    if (node.parentId && nodeById.has(node.parentId)) continue;
    if (node.type === "group") continue;
    rootSizes.set(node.id, nodeSize(node));
    const seed = finitePoint(savedPositions[node.id]) ?? previousAbsolute.get(node.id);
    if (seed) rootPositions.set(node.id, { ...seed });
  }

  placeMissingRoots(projection.nodes, nodeById, rootPositions, rootSizes);

  return reuseStableProjectionElements(
    {
      ...projection,
      nodes: projection.nodes.map((node) => {
        if (node.type === "group") {
          const placement = groupPlacements.get(node.id);
          const position = rootPositions.get(node.id);
          if (!placement || !position)
            throw new Error(`Missing interactive group layout: ${node.id}`);
          return {
            ...node,
            position: { ...position },
            style: {
              ...node.style,
              width: placement.size.width,
              height: placement.size.height,
            },
          };
        }

        if (node.parentId && nodeById.has(node.parentId)) {
          const position = groupPlacements.get(node.parentId)?.childPositions.get(node.id);
          if (!position) throw new Error(`Missing interactive child layout: ${node.id}`);
          return { ...node, position: { ...position } };
        }

        const position = rootPositions.get(node.id);
        if (!position) throw new Error(`Missing interactive root layout: ${node.id}`);
        return { ...node, position: { ...position } };
      }),
      edges: projection.edges.map((edge) => ({ ...edge, data: { ...edge.data } })),
    },
    options.previousProjection ?? null,
  );
}

function reuseStableProjectionElements(
  projection: DiagramProjection,
  previousProjection: DiagramProjection | null,
): DiagramProjection {
  if (!previousProjection) return projection;
  const previousNodeById = new Map(previousProjection.nodes.map((node) => [node.id, node]));
  const previousEdgeById = new Map(previousProjection.edges.map((edge) => [edge.id, edge]));
  const nodes = projection.nodes.map((node) => {
    const previous = previousNodeById.get(node.id);
    return previous && sameNode(previous, node) ? previous : node;
  });
  const edges = projection.edges.map((edge) => {
    const previous = previousEdgeById.get(edge.id);
    return previous && sameEdge(previous, edge) ? previous : edge;
  });
  return {
    ...projection,
    // React Flow treats a new collection as a graph update even when every element is the same.
    // Keep the collection identity too when a view changes only its semantic label (for example,
    // Global -> a source-defined full-schema view) so the transition does not re-adopt hundreds
    // of unchanged nodes and edges.
    nodes: sameElementSequence(nodes, previousProjection.nodes) ? previousProjection.nodes : nodes,
    edges: sameElementSequence(edges, previousProjection.edges) ? previousProjection.edges : edges,
  };
}

function sameElementSequence<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNode(left: SchemaDiagramNode, right: SchemaDiagramNode): boolean {
  if (
    left.type !== right.type ||
    left.parentId !== right.parentId ||
    left.extent !== right.extent ||
    left.position.x !== right.position.x ||
    left.position.y !== right.position.y ||
    left.style?.width !== right.style?.width ||
    left.style?.height !== right.style?.height ||
    left.data.kind !== right.data.kind
  ) {
    return false;
  }
  if (left.type === "table" && right.type === "table") {
    return (
      left.data.tableKey === right.data.tableKey &&
      left.data.schemaName === right.data.schemaName &&
      left.data.name === right.data.name &&
      left.data.lod === right.data.lod &&
      sameColumns(left.data.columns, right.data.columns)
    );
  }
  if (left.type !== "group" || right.type !== "group") return false;
  return (
    left.data.groupKey === right.data.groupKey &&
    left.data.schemaName === right.data.schemaName &&
    left.data.name === right.data.name &&
    left.data.tableCount === right.data.tableCount &&
    left.data.color === right.data.color &&
    left.data.collapsed === right.data.collapsed &&
    left.data.lod === right.data.lod &&
    sameStrings(left.data.tableKeys, right.data.tableKeys)
  );
}

function sameColumns(
  left: TableDiagramNode["data"]["columns"],
  right: TableDiagramNode["data"]["columns"],
): boolean {
  return (
    left.length === right.length &&
    left.every((column, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        column.key === candidate.key &&
        column.name === candidate.name &&
        column.type === candidate.type &&
        column.primaryKey === candidate.primaryKey &&
        column.foreignKey === candidate.foreignKey &&
        column.partialName === candidate.partialName
      );
    })
  );
}

function sameEdge(
  left: DiagramProjection["edges"][number],
  right: DiagramProjection["edges"][number],
): boolean {
  return (
    left.source === right.source &&
    left.target === right.target &&
    left.label === right.label &&
    left.ariaLabel === right.ariaLabel &&
    left.selectable === right.selectable &&
    left.data.aggregate === right.data.aggregate &&
    left.data.count === right.data.count &&
    left.data.referenceName === right.data.referenceName &&
    left.data.inactive === right.data.inactive &&
    left.data.sourceMultiplicity === right.data.sourceMultiplicity &&
    left.data.targetMultiplicity === right.data.targetMultiplicity &&
    sameStrings(left.data.referenceKeys, right.data.referenceKeys)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function collectAbsolutePositions(
  projection: DiagramProjection | null,
): ReadonlyMap<string, DiagramPosition> {
  if (!projection) return new Map();
  const nodeById = new Map(projection.nodes.map((node) => [node.id, node]));
  const result = new Map<string, DiagramPosition>();
  const resolving = new Set<string>();

  const resolve = (node: SchemaDiagramNode): DiagramPosition => {
    const existing = result.get(node.id);
    if (existing) return existing;
    if (resolving.has(node.id)) throw new Error(`Cyclic diagram parent relationship: ${node.id}`);
    resolving.add(node.id);
    const local = finitePoint(node.position) ?? { x: 0, y: 0 };
    const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
    const absolute = parent
      ? (() => {
          const parentPosition = resolve(parent);
          return { x: parentPosition.x + local.x, y: parentPosition.y + local.y };
        })()
      : local;
    resolving.delete(node.id);
    result.set(node.id, absolute);
    return absolute;
  };

  for (const node of projection.nodes) resolve(node);
  return result;
}

/**
 * Fits the already-derived projection without waiting for React Flow to remeasure every node.
 * The projection owns finite positions and dimensions, so the viewport is deterministic and can
 * be applied directly while React Flow reconciles the visible node set.
 */
export function deriveInteractiveViewport(
  projection: DiagramProjection,
  size: InteractiveViewportSize,
  options: InteractiveViewportOptions = {},
): DiagramViewport | null {
  if (
    projection.nodes.length === 0 ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    return null;
  }
  const padding = options.padding ?? 0.15;
  const minZoom = options.minZoom ?? 0.15;
  const maxZoom = options.maxZoom ?? 1.75;
  const insets = options.insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const availableWidth = size.width - insets.left - insets.right;
  const availableHeight = size.height - insets.top - insets.bottom;
  if (
    !Number.isFinite(padding) ||
    padding < 0 ||
    !Number.isFinite(minZoom) ||
    minZoom <= 0 ||
    !Number.isFinite(maxZoom) ||
    maxZoom < minZoom ||
    !validViewportInsets(insets) ||
    availableWidth <= 0 ||
    availableHeight <= 0
  ) {
    return null;
  }

  const absolutePositions = collectAbsolutePositions(projection);
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const node of projection.nodes) {
    if (options.targetNodeIds && !options.targetNodeIds.has(node.id)) continue;
    const position = absolutePositions.get(node.id);
    if (!position) return null;
    const dimensions = nodeSize(node);
    minimumX = Math.min(minimumX, position.x);
    minimumY = Math.min(minimumY, position.y);
    maximumX = Math.max(maximumX, position.x + dimensions.width);
    maximumY = Math.max(maximumY, position.y + dimensions.height);
  }
  if (!Number.isFinite(minimumX)) return null;
  const boundsWidth = Math.max(1, maximumX - minimumX);
  const boundsHeight = Math.max(1, maximumY - minimumY);
  const paddedWidth = boundsWidth * (1 + padding * 2);
  const paddedHeight = boundsHeight * (1 + padding * 2);
  const zoom = Math.min(
    maxZoom,
    Math.max(minZoom, Math.min(availableWidth / paddedWidth, availableHeight / paddedHeight)),
  );
  return {
    x: insets.left + availableWidth / 2 - (minimumX + boundsWidth / 2) * zoom,
    y: insets.top + availableHeight / 2 - (minimumY + boundsHeight / 2) * zoom,
    zoom,
  };
}

function validViewportInsets(insets: DiagramViewportInsets): boolean {
  return [insets.top, insets.right, insets.bottom, insets.left].every(
    (value) => Number.isFinite(value) && value >= 0,
  );
}

function placeGroup(
  group: SchemaDiagramNode,
  children: readonly SchemaDiagramNode[],
  savedPositions: Readonly<Record<string, DiagramPosition>>,
  previousAbsolute: ReadonlyMap<string, DiagramPosition>,
): GroupPlacement {
  const baseSize = nodeSize(group);
  const savedGroupPosition = finitePoint(savedPositions[group.id]);
  const previousGroupPosition = previousAbsolute.get(group.id);
  let groupPosition = savedGroupPosition ?? previousGroupPosition ?? null;
  const childAbsolute = new Map<string, MutablePoint>();
  const localOnly = new Map<string, MutablePoint>();

  for (const child of children) {
    const savedChild = finitePoint(savedPositions[child.id]);
    if (savedChild) {
      if (groupPosition) {
        childAbsolute.set(child.id, {
          x: groupPosition.x + savedChild.x,
          y: groupPosition.y + savedChild.y,
        });
      } else {
        localOnly.set(child.id, { ...savedChild });
      }
      continue;
    }
    const previous = previousAbsolute.get(child.id);
    if (previous) childAbsolute.set(child.id, { ...previous });
  }

  if (!groupPosition && childAbsolute.size > 0) {
    groupPosition = {
      x: minimumCoordinate(childAbsolute.values(), "x") - GROUP_PADDING,
      y: minimumCoordinate(childAbsolute.values(), "y") - GROUP_HEADER_HEIGHT - GROUP_PADDING,
    };
  }

  if (groupPosition && childAbsolute.size > 0) {
    groupPosition = {
      x: Math.min(groupPosition.x, minimumCoordinate(childAbsolute.values(), "x") - GROUP_PADDING),
      y: Math.min(
        groupPosition.y,
        minimumCoordinate(childAbsolute.values(), "y") - GROUP_HEADER_HEIGHT - GROUP_PADDING,
      ),
    };
  }

  const childPositions = new Map<string, MutablePoint>();
  if (groupPosition) {
    for (const [id, absolute] of childAbsolute) {
      childPositions.set(id, {
        x: absolute.x - groupPosition.x,
        y: absolute.y - groupPosition.y,
      });
    }
  }
  for (const [id, position] of localOnly) childPositions.set(id, { ...position });

  placeMissingChildren(children, childPositions);
  normalizeUnseededChildren(childPositions, groupPosition === null);

  const size = groupSize(baseSize, children, childPositions);
  return { position: groupPosition, childPositions, size };
}

function placeMissingChildren(
  children: readonly SchemaDiagramNode[],
  positions: Map<string, MutablePoint>,
): void {
  const missing = children
    .filter((child) => !positions.has(child.id))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  if (missing.length === 0) return;

  const existingBottom = children.reduce(
    (maximum, child) => {
      const position = positions.get(child.id);
      return position ? Math.max(maximum, position.y + nodeSize(child).height) : maximum;
    },
    GROUP_HEADER_HEIGHT + GROUP_PADDING - CHILD_GAP,
  );
  const startY = Math.max(GROUP_HEADER_HEIGHT + GROUP_PADDING, existingBottom + CHILD_GAP);
  const columnWidth = Math.max(...missing.map((child) => nodeSize(child).width)) + CHILD_GAP;
  const rowHeight = Math.max(...missing.map((child) => nodeSize(child).height)) + CHILD_GAP;

  missing.forEach((child, index) => {
    positions.set(child.id, {
      x: GROUP_PADDING + (index % CHILD_COLUMNS) * columnWidth,
      y: startY + Math.floor(index / CHILD_COLUMNS) * rowHeight,
    });
  });
}

function normalizeUnseededChildren(positions: Map<string, MutablePoint>, normalize: boolean): void {
  if (!normalize || positions.size === 0) return;
  const shiftX = Math.max(0, GROUP_PADDING - minimumCoordinate(positions.values(), "x"));
  const shiftY = Math.max(
    0,
    GROUP_HEADER_HEIGHT + GROUP_PADDING - minimumCoordinate(positions.values(), "y"),
  );
  if (shiftX === 0 && shiftY === 0) return;
  for (const position of positions.values()) {
    position.x += shiftX;
    position.y += shiftY;
  }
}

function groupSize(
  base: NodeSize,
  children: readonly SchemaDiagramNode[],
  positions: ReadonlyMap<string, MutablePoint>,
): NodeSize {
  let width = base.width;
  let height = base.height;
  for (const child of children) {
    const position = positions.get(child.id);
    if (!position) continue;
    const childSize = nodeSize(child);
    width = Math.max(width, position.x + childSize.width + GROUP_PADDING);
    height = Math.max(height, position.y + childSize.height + GROUP_PADDING);
  }
  return { width, height };
}

function placeMissingRoots(
  nodes: readonly SchemaDiagramNode[],
  nodeById: ReadonlyMap<string, SchemaDiagramNode>,
  positions: Map<string, MutablePoint>,
  sizes: ReadonlyMap<string, NodeSize>,
): void {
  const roots = nodes.filter((node) => !node.parentId || !nodeById.has(node.parentId));
  const seededBottom = roots.reduce((maximum, node) => {
    const position = positions.get(node.id);
    const size = sizes.get(node.id) ?? nodeSize(node);
    return position ? Math.max(maximum, position.y + size.height) : maximum;
  }, -ROOT_GAP);
  const missing = roots
    .filter((node) => !positions.has(node.id))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  let cursorX = 0;
  let cursorY = seededBottom + ROOT_GAP;
  let rowHeight = 0;

  for (const node of missing) {
    const size = sizes.get(node.id) ?? nodeSize(node);
    if (cursorX > 0 && cursorX + size.width > ROOT_ROW_WIDTH) {
      cursorX = 0;
      cursorY += rowHeight + ROOT_GAP;
      rowHeight = 0;
    }
    positions.set(node.id, { x: cursorX, y: cursorY });
    cursorX += size.width + ROOT_GAP;
    rowHeight = Math.max(rowHeight, size.height);
  }
}

function collectChildren(
  nodes: readonly SchemaDiagramNode[],
  nodeById: ReadonlyMap<string, SchemaDiagramNode>,
): ReadonlyMap<string, readonly SchemaDiagramNode[]> {
  const result = new Map<string, SchemaDiagramNode[]>();
  for (const node of nodes) {
    if (!node.parentId || !nodeById.has(node.parentId)) continue;
    const children = result.get(node.parentId) ?? [];
    children.push(node);
    result.set(node.parentId, children);
  }
  return result;
}

function nodeSize(node: SchemaDiagramNode): NodeSize {
  return {
    width: finiteDimension(node.style?.width, 260),
    height: finiteDimension(node.style?.height, 80),
  };
}

function finiteDimension(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function finitePoint(value: DiagramPosition | undefined): MutablePoint | null {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  return { x: value.x, y: value.y };
}

function minimumCoordinate(
  values: Iterable<Readonly<MutablePoint>>,
  coordinate: "x" | "y",
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const value of values) minimum = Math.min(minimum, value[coordinate]);
  return minimum;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cloneProjection(projection: DiagramProjection): DiagramProjection {
  return {
    ...projection,
    nodes: projection.nodes.map(cloneNode),
    edges: projection.edges.map((edge) => ({ ...edge, data: { ...edge.data } })),
  };
}

function cloneNode(node: SchemaDiagramNode): SchemaDiagramNode {
  const style = node.style ? { style: { ...node.style } } : {};
  if (node.type === "table") {
    return {
      ...node,
      position: { ...node.position },
      ...style,
      data: { ...node.data },
    } satisfies TableDiagramNode;
  }
  return {
    ...node,
    position: { ...node.position },
    ...style,
    data: { ...node.data },
  } satisfies GroupDiagramNode;
}
