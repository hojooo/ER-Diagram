import { parseDbmlV2 } from "@er-diagram/core";
import { fixtureInventory, generateFidelityFixture } from "@er-diagram/test-fixtures";
import { describe, expect, it } from "vitest";

import {
  collectAbsolutePositions,
  deriveInteractiveLayout,
  diagramNodeSize,
} from "../src/diagram/interactive-layout.js";
import { demoSchemaGraph } from "../src/diagram/demo-schema.js";
import { createBaseDiagramProjection, createDiagramProjection } from "../src/diagram/projection.js";
import {
  applyRelationshipRoutes,
  createRelationshipRoutes,
} from "../src/diagram/relationship-routing.js";
import type {
  DiagramEdgeRoute,
  DiagramProjection,
  SchemaDiagramEdge,
  TableDiagramNode,
} from "../src/diagram/types.js";

describe("relationship routing", () => {
  it("routes an edge around an intervening table without changing its identity", () => {
    const projection = diagram(
      [
        table("table:public.source", 0, 100, 260, 100),
        table("table:public.blocker", 360, 80, 260, 140),
        table("table:public.target", 760, 100, 260, 100),
      ],
      [reference("reference:public.source-target", "table:public.source", "table:public.target")],
    );

    const route = requiredRoute(createRelationshipRoutes(projection), firstEdge(projection).id);

    expect(route.path).toMatch(/^M /);
    expect(route.points[0]).toEqual({ x: 260, y: 150 });
    expect(route.points.at(-1)).toEqual({ x: 760, y: 150 });
    expectOrthogonal(route);
    expectRouteOutsideRectangle(route, { left: 360, top: 80, right: 620, bottom: 220 });
  });

  it("routes a self-reference around the owning table", () => {
    const owner = table("table:public.category", 100, 100, 260, 128);
    const projection = diagram(
      [owner],
      [reference("reference:public.category-parent", owner.id, owner.id)],
    );

    const route = requiredRoute(createRelationshipRoutes(projection), firstEdge(projection).id);

    expect(route.points[0]).toEqual({ x: 360, y: 164 });
    expect(route.points.at(-1)).toEqual({ x: 100, y: 164 });
    expectOrthogonal(route);
    expectRouteOutsideRectangle(route, { left: 100, top: 100, right: 360, bottom: 228 });
  });

  it("uses absolute child positions and produces byte-stable routes", () => {
    const source = table("table:public.source", 24, 80, 260, 100, "group:public.domain");
    const blocker = table("table:public.blocker", 420, 130, 260, 120);
    const target = table("table:public.target", 820, 130, 260, 120);
    const projection: DiagramProjection = {
      viewKey: "GLOBAL",
      lod: "FULL",
      nodes: [
        {
          id: "group:public.domain",
          type: "group",
          position: { x: 80, y: 40 },
          style: { width: 340, height: 300 },
          data: {
            kind: "group",
            groupKey: "group:public.domain",
            schemaName: "public",
            name: "domain",
            tableKeys: [source.id],
            tableCount: 1,
            color: null,
            collapsed: false,
            lod: "FULL",
          },
        },
        source,
        blocker,
        target,
      ],
      edges: [reference("reference:public.source-target", source.id, target.id)],
    };

    const first = requiredRoute(createRelationshipRoutes(projection), firstEdge(projection).id);
    const second = requiredRoute(createRelationshipRoutes(projection), firstEdge(projection).id);

    expect(first).toEqual(second);
    expect(first.points[0]).toEqual({ x: 364, y: 170 });
    expectOrthogonal(first);
    expectRouteOutsideRectangle(first, { left: 420, top: 130, right: 680, bottom: 250 });
  });

  it("reuses geometry for parallel relationships while routing every edge", () => {
    const projection = diagram(
      [table("table:public.a", 0, 0), table("table:public.b", 420, 0)],
      [
        reference("reference:public.a-b-1", "table:public.a", "table:public.b"),
        reference("reference:public.a-b-2", "table:public.a", "table:public.b"),
      ],
    );

    const routes = createRelationshipRoutes(projection);

    expect(routes.size).toBe(2);
    expect(routes.get(projection.edges[0]?.id ?? "")).toEqual(
      routes.get(projection.edges[1]?.id ?? ""),
    );
  });

  it("keeps a narrow source-target gap routable without entering either table", () => {
    const source = table("table:public.left", 0, 0);
    const target = table("table:public.right", 264, 0);
    const projection = diagram(
      [source, target],
      [reference("reference:public.narrow-gap", source.id, target.id)],
    );

    const route = requiredRoute(createRelationshipRoutes(projection), firstEdge(projection).id);

    expectRouteOutsideRectangle(route, { left: 0, top: 0, right: 260, bottom: 100 });
    expectRouteOutsideRectangle(route, { left: 264, top: 0, right: 524, bottom: 100 });
  });

  it("routes relationships between vertically stacked TableGroup members", () => {
    const identityView = demoSchemaGraph.views.find((view) => view.name === "identity_only");
    if (!identityView) throw new Error("Missing identity view fixture");
    const projection = deriveInteractiveLayout(
      createDiagramProjection(demoSchemaGraph, {
        viewKey: identityView.key,
        collapsedGroupKeys: new Set(),
        lod: "FULL",
      }),
    );

    expect(projection.edges).toHaveLength(1);
    expect(createRelationshipRoutes(projection).size).toBe(1);
  });

  it("treats expanded group headers and collapsed groups as routing obstacles", () => {
    const source = table("table:public.source", 0, 120);
    const target = table("table:public.target", 760, 120);
    const projection: DiagramProjection = {
      viewKey: "GLOBAL",
      lod: "FULL",
      nodes: [
        source,
        {
          id: "group:public.expanded",
          type: "group",
          position: { x: 320, y: 100 },
          style: { width: 180, height: 260 },
          data: {
            kind: "group",
            groupKey: "group:public.expanded",
            schemaName: "public",
            name: "expanded",
            tableKeys: [],
            tableCount: 0,
            color: null,
            collapsed: false,
            lod: "FULL",
          },
        },
        {
          id: "group:public.collapsed",
          type: "group",
          position: { x: 540, y: 90 },
          style: { width: 140, height: 140 },
          data: {
            kind: "group",
            groupKey: "group:public.collapsed",
            schemaName: "public",
            name: "collapsed",
            tableKeys: [],
            tableCount: 0,
            color: null,
            collapsed: true,
            lod: "FULL",
          },
        },
        target,
      ],
      edges: [reference("reference:public.source-target", source.id, target.id)],
    };

    const route = requiredRoute(createRelationshipRoutes(projection), firstEdge(projection).id);

    expectRouteOutsideRectangle(route, { left: 320, top: 100, right: 500, bottom: 156 });
    expectRouteOutsideRectangle(route, { left: 540, top: 90, right: 680, bottom: 230 });
  });

  it("attaches a route to every edge with visible endpoints", () => {
    const projection = diagram(
      [
        table("table:public.source", 0, 100),
        table("table:public.blocker", 320, 80, 260, 160),
        table("table:public.target", 700, 100),
      ],
      [
        reference("reference:public.one", "table:public.source", "table:public.target"),
        reference("reference:public.two", "table:public.target", "table:public.source"),
      ],
    );

    const routed = applyRelationshipRoutes(projection);

    expect(routed.edges).toHaveLength(projection.edges.length);
    expect(routed.edges.every((edge) => edge.data.route !== undefined)).toBe(true);
  });

  it("routes the complete fidelity corpus without crossing any table card", async () => {
    const parsed = await parseDbmlV2(generateFidelityFixture());
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    const projection = deriveInteractiveLayout(createBaseDiagramProjection(parsed.graph));
    const routes = createRelationshipRoutes(projection);
    const absolutePositions = collectAbsolutePositions(projection);
    const tableRectangles = projection.nodes.flatMap((node) => {
      if (node.type !== "table") return [];
      const position = absolutePositions.get(node.id);
      if (!position) return [];
      const size = diagramNodeSize(node);
      return [
        {
          left: position.x,
          top: position.y,
          right: position.x + size.width,
          bottom: position.y + size.height,
        },
      ];
    });

    expect(projection.edges).toHaveLength(fixtureInventory.fidelity.references);
    expect(routes.size).toBe(projection.edges.length);
    let crossingCount = 0;
    for (const route of routes.values()) {
      expectOrthogonal(route);
      for (const rectangle of tableRectangles) {
        if (routeCrossesRectangle(route, rectangle)) crossingCount += 1;
      }
    }
    expect(crossingCount).toBe(0);
  });
});

function diagram(nodes: TableDiagramNode[], edges: SchemaDiagramEdge[]): DiagramProjection {
  return { viewKey: "GLOBAL", lod: "FULL", nodes, edges };
}

function table(
  id: string,
  x: number,
  y: number,
  width = 260,
  height = 100,
  parentId?: string,
): TableDiagramNode {
  return {
    id,
    type: "table",
    position: { x, y },
    style: { width, height },
    data: {
      kind: "table",
      tableKey: id,
      schemaName: "public",
      name: id,
      columns: [],
      lod: "FULL",
    },
    ...(parentId ? { parentId } : {}),
  };
}

function reference(id: string, source: string, target: string): SchemaDiagramEdge {
  return {
    id,
    type: "reference",
    source,
    target,
    data: {
      kind: "reference",
      aggregate: false,
      count: 1,
      referenceKeys: [id],
      inactive: false,
    },
  };
}

function requiredRoute(
  routes: ReadonlyMap<string, DiagramEdgeRoute>,
  edgeId: string,
): DiagramEdgeRoute {
  const route = routes.get(edgeId);
  expect(route).toBeDefined();
  return route as DiagramEdgeRoute;
}

function firstEdge(projection: DiagramProjection): SchemaDiagramEdge {
  const edge = projection.edges[0];
  if (!edge) throw new Error("Expected a relationship edge");
  return edge;
}

function expectOrthogonal(route: DiagramEdgeRoute): void {
  for (let index = 1; index < route.points.length; index += 1) {
    const previous = route.points[index - 1] as DiagramEdgeRoute["points"][number];
    const current = route.points[index] as DiagramEdgeRoute["points"][number];
    expect(previous.x === current.x || previous.y === current.y).toBe(true);
  }
}

function expectRouteOutsideRectangle(
  route: DiagramEdgeRoute,
  rectangle: { left: number; top: number; right: number; bottom: number },
): void {
  expect(routeCrossesRectangle(route, rectangle)).toBe(false);
}

function routeCrossesRectangle(
  route: DiagramEdgeRoute,
  rectangle: { left: number; top: number; right: number; bottom: number },
): boolean {
  for (let index = 1; index < route.points.length; index += 1) {
    const start = route.points[index - 1] as DiagramEdgeRoute["points"][number];
    const end = route.points[index] as DiagramEdgeRoute["points"][number];
    if (segmentCrossesRectangleInterior(start, end, rectangle)) return true;
  }
  return false;
}

function segmentCrossesRectangleInterior(
  start: { x: number; y: number },
  end: { x: number; y: number },
  rectangle: { left: number; top: number; right: number; bottom: number },
): boolean {
  if (start.x === end.x) {
    return (
      start.x > rectangle.left &&
      start.x < rectangle.right &&
      Math.max(start.y, end.y) > rectangle.top &&
      Math.min(start.y, end.y) < rectangle.bottom
    );
  }
  return (
    start.y > rectangle.top &&
    start.y < rectangle.bottom &&
    Math.max(start.x, end.x) > rectangle.left &&
    Math.min(start.x, end.x) < rectangle.right
  );
}
