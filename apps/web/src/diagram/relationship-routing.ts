import { collectAbsolutePositions, diagramNodeSize } from "./interactive-layout.js";
import type { DiagramEdgeRoute, DiagramProjection, DiagramRoutePoint } from "./types.js";

const ROUTE_CLEARANCE = 12;
const NEARBY_CHANNELS_PER_ANCHOR = 8;
const MAX_DETOUR_STEPS = 256;
const MAX_EXTERIOR_SEARCH_STATES = 65_536;
const EPSILON = 0.001;
const EXPANDED_GROUP_HEADER_HEIGHT = 56;

interface DiagramRectangle {
  nodeId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface RoutingContext {
  nodeRectangles: ReadonlyMap<string, DiagramRectangle>;
  obstacles: readonly DiagramRectangle[];
  xChannels: readonly number[];
  yChannels: readonly number[];
}

/**
 * Computes source-free, projection-local edge geometry. Routes are never persisted: moving or
 * resizing a node simply derives them again from the current visible rectangles.
 */
export function createRelationshipRoutes(
  projection: DiagramProjection,
): ReadonlyMap<string, DiagramEdgeRoute> {
  if (projection.edges.length === 0 || projection.nodes.length === 0) return new Map();
  const context = createRoutingContext(projection);
  const routes = new Map<string, DiagramEdgeRoute>();
  const routeByEndpoints = new Map<string, DiagramEdgeRoute>();

  for (const edge of projection.edges) {
    const endpointKey = JSON.stringify([edge.source, edge.target]);
    const existing = routeByEndpoints.get(endpointKey);
    if (existing) {
      routes.set(edge.id, existing);
      continue;
    }
    const route = createRelationshipRoute(edge.source, edge.target, context);
    if (!route) continue;
    routeByEndpoints.set(endpointKey, route);
    routes.set(edge.id, route);
  }

  return routes;
}

export function applyRelationshipRoutes(projection: DiagramProjection): DiagramProjection {
  const routes = createRelationshipRoutes(projection);
  if (routes.size === 0) return projection;
  return {
    ...projection,
    edges: projection.edges.map((edge) => {
      const route = routes.get(edge.id);
      return route ? { ...edge, data: { ...edge.data, route } } : edge;
    }),
  };
}

function createRoutingContext(projection: DiagramProjection): RoutingContext {
  const absolutePositions = collectAbsolutePositions(projection);
  const nodeRectangles = new Map<string, DiagramRectangle>();
  const obstacles: DiagramRectangle[] = [];

  for (const node of [...projection.nodes].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  )) {
    const position = absolutePositions.get(node.id);
    if (!position) continue;
    const size = diagramNodeSize(node);
    const rectangle = {
      nodeId: node.id,
      left: position.x,
      top: position.y,
      right: position.x + size.width,
      bottom: position.y + size.height,
    };
    nodeRectangles.set(node.id, rectangle);

    // Expanded groups are containers, not obstacles. Only their header band carries content that
    // a relationship must avoid; child table cards are represented by their own rectangles.
    const obstacleRectangle =
      node.type === "group" && !node.data.collapsed
        ? {
            ...rectangle,
            bottom: Math.min(rectangle.bottom, rectangle.top + EXPANDED_GROUP_HEADER_HEIGHT),
          }
        : rectangle;
    obstacles.push(expandRectangle(obstacleRectangle, ROUTE_CLEARANCE));
  }

  return {
    nodeRectangles,
    obstacles,
    xChannels: uniqueSorted(obstacles.flatMap((obstacle) => [obstacle.left, obstacle.right])),
    yChannels: uniqueSorted(obstacles.flatMap((obstacle) => [obstacle.top, obstacle.bottom])),
  };
}

function createRelationshipRoute(
  sourceId: string,
  targetId: string,
  context: RoutingContext,
): DiagramEdgeRoute | null {
  const source = context.nodeRectangles.get(sourceId);
  const target = context.nodeRectangles.get(targetId);
  if (!source || !target) return null;

  const sourcePort = { x: source.right, y: (source.top + source.bottom) / 2 };
  const targetPort = { x: target.left, y: (target.top + target.bottom) / 2 };
  const forwardGap = target.left - source.right;
  const endpointClearance =
    forwardGap > 0 ? Math.min(ROUTE_CLEARANCE, forwardGap / 3) : ROUTE_CLEARANCE;
  const sourceEscape = { x: source.right + endpointClearance, y: sourcePort.y };
  const targetEscape = { x: target.left - endpointClearance, y: targetPort.y };
  const edgeObstacles = context.obstacles.map((obstacle) =>
    obstacle.nodeId === sourceId || obstacle.nodeId === targetId
      ? (context.nodeRectangles.get(obstacle.nodeId) ?? obstacle)
      : obstacle,
  );
  const middle = findClearOrthogonalRoute(sourceEscape, targetEscape, {
    ...context,
    obstacles: edgeObstacles,
  });
  if (!middle) return null;

  const points = simplifyPoints([sourcePort, ...middle, targetPort]);
  const label = longestSegmentMidpoint(points);
  return {
    path: orthogonalPath(points),
    labelX: label.x,
    labelY: label.y,
    points,
  };
}

function findClearOrthogonalRoute(
  start: DiagramRoutePoint,
  end: DiagramRoutePoint,
  context: RoutingContext,
): DiagramRoutePoint[] | null {
  const candidates = candidateRoutes(start, end, context);
  for (const candidate of candidates) {
    if (routeIsClear(candidate.points, context.obstacles)) return candidate.points;
  }

  const detourSeeds = candidates.slice(0, 8).map(({ points }) => points);
  for (const seed of detourSeeds) {
    const detoured = resolveRouteCollisions(seed, context.obstacles);
    if (detoured && routeIsClear(detoured, context.obstacles)) return detoured;
  }
  return findExteriorCorridorRoute(start, end, context.obstacles);
}

/**
 * Exhausts both sides of each collision for the four routes outside the complete obstacle set.
 * The normal channel planner stays intentionally small for interactive updates; this bounded
 * fallback is only used when those fast candidates cannot reach a clear exterior corridor.
 */
function findExteriorCorridorRoute(
  start: DiagramRoutePoint,
  end: DiagramRoutePoint,
  obstacles: readonly DiagramRectangle[],
): DiagramRoutePoint[] | null {
  if (obstacles.length === 0) return simplifyPoints([start, { x: end.x, y: start.y }, end]);
  const outerLeft = Math.min(...obstacles.map((obstacle) => obstacle.left)) - ROUTE_CLEARANCE;
  const outerRight = Math.max(...obstacles.map((obstacle) => obstacle.right)) + ROUTE_CLEARANCE;
  const outerTop = Math.min(...obstacles.map((obstacle) => obstacle.top)) - ROUTE_CLEARANCE;
  const outerBottom = Math.max(...obstacles.map((obstacle) => obstacle.bottom)) + ROUTE_CLEARANCE;
  const pending = [
    [start, { x: outerLeft, y: start.y }, { x: outerLeft, y: end.y }, end],
    [start, { x: outerRight, y: start.y }, { x: outerRight, y: end.y }, end],
    [start, { x: start.x, y: outerTop }, { x: end.x, y: outerTop }, end],
    [start, { x: start.x, y: outerBottom }, { x: end.x, y: outerBottom }, end],
  ]
    .map(simplifyPoints)
    .sort(compareRouteCandidates);
  const seen = new Set<string>();

  for (let stateCount = 0; pending.length > 0 && stateCount < MAX_EXTERIOR_SEARCH_STATES; ) {
    const route = pending.shift();
    if (!route) break;
    const signature = routeSignature(route);
    if (seen.has(signature)) continue;
    seen.add(signature);
    stateCount += 1;

    const collision = firstRouteCollision(route, obstacles);
    if (!collision) return route;
    const alternatives = detourSegment(route, collision.segmentIndex, collision.obstacle)
      .map(simplifyPoints)
      .filter(isOrthogonal)
      .filter((candidate) => !seen.has(routeSignature(candidate)));
    pending.push(...alternatives);
    pending.sort(compareRouteCandidates);
  }
  return null;
}

function compareRouteCandidates(
  left: readonly DiagramRoutePoint[],
  right: readonly DiagramRoutePoint[],
): number {
  return (
    routeScore(left) - routeScore(right) ||
    compareCodeUnits(routeSignature(left), routeSignature(right))
  );
}

function candidateRoutes(
  start: DiagramRoutePoint,
  end: DiagramRoutePoint,
  context: RoutingContext,
): Array<{ points: DiagramRoutePoint[]; score: number }> {
  const routes = new Map<string, { points: DiagramRoutePoint[]; score: number }>();
  const add = (points: DiagramRoutePoint[]) => {
    const simplified = simplifyPoints(points);
    if (!isOrthogonal(simplified)) return;
    const signature = routeSignature(simplified);
    routes.set(signature, { points: simplified, score: routeScore(simplified) });
  };

  if (nearlyEqual(start.x, end.x) || nearlyEqual(start.y, end.y)) add([start, end]);
  add([start, { x: end.x, y: start.y }, end]);
  add([start, { x: start.x, y: end.y }, end]);

  const middleX = (start.x + end.x) / 2;
  const middleY = (start.y + end.y) / 2;
  for (const x of selectChannels(context.xChannels, [middleX, start.x, end.x])) {
    add([start, { x, y: start.y }, { x, y: end.y }, end]);
  }
  for (const y of selectChannels(context.yChannels, [middleY, start.y, end.y])) {
    add([start, { x: start.x, y }, { x: end.x, y }, end]);
  }

  const outerLeft = (context.xChannels[0] ?? Math.min(start.x, end.x)) - ROUTE_CLEARANCE;
  const outerRight = (context.xChannels.at(-1) ?? Math.max(start.x, end.x)) + ROUTE_CLEARANCE;
  const outerTop = (context.yChannels[0] ?? Math.min(start.y, end.y)) - ROUTE_CLEARANCE;
  const outerBottom = (context.yChannels.at(-1) ?? Math.max(start.y, end.y)) + ROUTE_CLEARANCE;
  add([start, { x: outerLeft, y: start.y }, { x: outerLeft, y: end.y }, end]);
  add([start, { x: outerRight, y: start.y }, { x: outerRight, y: end.y }, end]);
  add([start, { x: start.x, y: outerTop }, { x: end.x, y: outerTop }, end]);
  add([start, { x: start.x, y: outerBottom }, { x: end.x, y: outerBottom }, end]);

  return [...routes.values()].sort(
    (left, right) =>
      left.score - right.score ||
      compareCodeUnits(routeSignature(left.points), routeSignature(right.points)),
  );
}

function selectChannels(
  channels: readonly number[],
  anchors: readonly number[],
): readonly number[] {
  const selected = new Set<number>();
  for (const anchor of anchors) {
    selected.add(anchor);
    const insertionIndex = lowerBound(channels, anchor);
    for (
      let offset = -NEARBY_CHANNELS_PER_ANCHOR;
      offset <= NEARBY_CHANNELS_PER_ANCHOR;
      offset += 1
    ) {
      const channel = channels[insertionIndex + offset];
      if (channel !== undefined) selected.add(channel);
    }
  }
  return [...selected];
}

function resolveRouteCollisions(
  initial: readonly DiagramRoutePoint[],
  obstacles: readonly DiagramRectangle[],
): DiagramRoutePoint[] | null {
  let route = simplifyPoints(initial);
  const seen = new Set<string>();

  for (let step = 0; step < MAX_DETOUR_STEPS; step += 1) {
    const signature = routeSignature(route);
    if (seen.has(signature)) return null;
    seen.add(signature);
    const collision = firstRouteCollision(route, obstacles);
    if (!collision) return route;
    const alternatives = detourSegment(route, collision.segmentIndex, collision.obstacle)
      .map(simplifyPoints)
      .filter(isOrthogonal)
      .filter((candidate) => !seen.has(routeSignature(candidate)))
      .sort((left, right) => {
        const collisionDelta =
          countRouteCollisions(left, obstacles) - countRouteCollisions(right, obstacles);
        return (
          collisionDelta ||
          routeScore(left) - routeScore(right) ||
          compareCodeUnits(routeSignature(left), routeSignature(right))
        );
      });
    const next = alternatives[0];
    if (!next) return null;
    route = next;
  }
  return null;
}

function detourSegment(
  route: readonly DiagramRoutePoint[],
  segmentIndex: number,
  obstacle: DiagramRectangle,
): DiagramRoutePoint[][] {
  const start = route[segmentIndex];
  const end = route[segmentIndex + 1];
  if (!start || !end) return [];
  const prefix = route.slice(0, segmentIndex + 1);
  const suffix = route.slice(segmentIndex + 1);
  if (nearlyEqual(start.y, end.y)) {
    const increasing = end.x > start.x;
    const nearX = increasing ? obstacle.left : obstacle.right;
    const farX = increasing ? obstacle.right : obstacle.left;
    return [obstacle.top, obstacle.bottom].map((y) => [
      ...prefix,
      { x: nearX, y: start.y },
      { x: nearX, y },
      { x: farX, y },
      { x: farX, y: end.y },
      ...suffix,
    ]);
  }
  const increasing = end.y > start.y;
  const nearY = increasing ? obstacle.top : obstacle.bottom;
  const farY = increasing ? obstacle.bottom : obstacle.top;
  return [obstacle.left, obstacle.right].map((x) => [
    ...prefix,
    { x: start.x, y: nearY },
    { x, y: nearY },
    { x, y: farY },
    { x: end.x, y: farY },
    ...suffix,
  ]);
}

function firstRouteCollision(
  points: readonly DiagramRoutePoint[],
  obstacles: readonly DiagramRectangle[],
): { segmentIndex: number; obstacle: DiagramRectangle } | null {
  for (let segmentIndex = 0; segmentIndex < points.length - 1; segmentIndex += 1) {
    const start = points[segmentIndex];
    const end = points[segmentIndex + 1];
    for (const obstacle of obstacles) {
      if (start && end && segmentCrossesRectangleInterior(start, end, obstacle)) {
        return { segmentIndex, obstacle };
      }
    }
  }
  return null;
}

function routeIsClear(
  points: readonly DiagramRoutePoint[],
  obstacles: readonly DiagramRectangle[],
): boolean {
  return firstRouteCollision(points, obstacles) === null;
}

function countRouteCollisions(
  points: readonly DiagramRoutePoint[],
  obstacles: readonly DiagramRectangle[],
): number {
  let count = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    for (const obstacle of obstacles) {
      const start = points[index];
      const end = points[index + 1];
      if (start && end && segmentCrossesRectangleInterior(start, end, obstacle)) count += 1;
    }
  }
  return count;
}

function segmentCrossesRectangleInterior(
  start: DiagramRoutePoint,
  end: DiagramRoutePoint,
  rectangle: DiagramRectangle,
): boolean {
  if (nearlyEqual(start.x, end.x)) {
    return (
      start.x > rectangle.left + EPSILON &&
      start.x < rectangle.right - EPSILON &&
      Math.max(start.y, end.y) > rectangle.top + EPSILON &&
      Math.min(start.y, end.y) < rectangle.bottom - EPSILON
    );
  }
  if (nearlyEqual(start.y, end.y)) {
    return (
      start.y > rectangle.top + EPSILON &&
      start.y < rectangle.bottom - EPSILON &&
      Math.max(start.x, end.x) > rectangle.left + EPSILON &&
      Math.min(start.x, end.x) < rectangle.right - EPSILON
    );
  }
  return true;
}

function orthogonalPath(points: readonly DiagramRoutePoint[]): string {
  return points
    .map(
      (point, index) => `${index === 0 ? "M" : "L"} ${coordinate(point.x)} ${coordinate(point.y)}`,
    )
    .join(" ");
}

function longestSegmentMidpoint(points: readonly DiagramRoutePoint[]): DiagramRoutePoint {
  let bestStart = points[0] ?? { x: 0, y: 0 };
  let bestEnd = points[1] ?? bestStart;
  let bestLength = distance(bestStart, bestEnd);
  for (let index = 1; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (!start || !end) continue;
    const length = distance(start, end);
    if (length > bestLength) {
      bestLength = length;
      bestStart = start;
      bestEnd = end;
    }
  }
  return { x: (bestStart.x + bestEnd.x) / 2, y: (bestStart.y + bestEnd.y) / 2 };
}

function simplifyPoints(points: readonly DiagramRoutePoint[]): DiagramRoutePoint[] {
  const result: DiagramRoutePoint[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (previous && nearlyEqual(previous.x, point.x) && nearlyEqual(previous.y, point.y)) continue;
    const beforePrevious = result.at(-2);
    if (
      previous &&
      beforePrevious &&
      ((nearlyEqual(beforePrevious.x, previous.x) && nearlyEqual(previous.x, point.x)) ||
        (nearlyEqual(beforePrevious.y, previous.y) && nearlyEqual(previous.y, point.y)))
    ) {
      result[result.length - 1] = point;
      continue;
    }
    result.push(point);
  }
  return result;
}

function routeScore(points: readonly DiagramRoutePoint[]): number {
  let length = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (start && end) length += distance(start, end);
  }
  return length + Math.max(0, points.length - 2) * ROUTE_CLEARANCE;
}

function isOrthogonal(points: readonly DiagramRoutePoint[]): boolean {
  return points.every((point, index) => {
    if (index === 0) return Number.isFinite(point.x) && Number.isFinite(point.y);
    const previous = points[index - 1];
    return (
      previous !== undefined &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      (nearlyEqual(previous.x, point.x) || nearlyEqual(previous.y, point.y))
    );
  });
}

function routeSignature(points: readonly DiagramRoutePoint[]): string {
  return points.map((point) => `${coordinate(point.x)},${coordinate(point.y)}`).join(";");
}

function expandRectangle(rectangle: DiagramRectangle, amount: number): DiagramRectangle {
  return {
    nodeId: rectangle.nodeId,
    left: rectangle.left - amount,
    top: rectangle.top - amount,
    right: rectangle.right + amount,
    bottom: rectangle.bottom + amount,
  };
}

function uniqueSorted(values: readonly number[]): readonly number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((values[middle] ?? Number.POSITIVE_INFINITY) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function distance(left: DiagramRoutePoint, right: DiagramRoutePoint): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function coordinate(value: number): string {
  const rounded = Math.round(value * 1_000) / 1_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
