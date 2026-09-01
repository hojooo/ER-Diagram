import { describe, expect, it } from "vitest";

import {
  collectAbsolutePositions,
  deriveInteractiveLayout,
  deriveInteractiveViewport,
} from "../src/diagram/interactive-layout.js";
import type {
  DiagramProjection,
  GroupDiagramNode,
  TableDiagramNode,
} from "../src/diagram/types.js";

describe("deterministic interactive diagram layout", () => {
  it("places missing roots in stable-key order without overlap", () => {
    const projection = diagram([
      table('table:["public","z😀"]'),
      table('table:["public","a table"]'),
      table('table:["public","m"]'),
    ]);

    const first = deriveInteractiveLayout(projection);
    const second = deriveInteractiveLayout(projection);

    expect(second).toEqual(first);
    expect(position(first, 'table:["public","a table"]')).toEqual({ x: 0, y: 0 });
    expect(position(first, 'table:["public","m"]')).toEqual({ x: 340, y: 0 });
    expect(position(first, 'table:["public","z😀"]')).toEqual({ x: 680, y: 0 });
    expect(rootRectanglesOverlap(first)).toBe(false);
  });

  it("uses saved relative positions and expands compound bounds around children", () => {
    const group = groupNode('group:["public","도메인😀"]');
    const child = table('table:["public","quoted table"]', group.id, 180);
    const result = deriveInteractiveLayout(diagram([group, child]), {
      savedPositions: {
        [group.id]: { x: 100, y: 200 },
        [child.id]: { x: 30, y: 90 },
      },
    });

    expect(position(result, group.id)).toEqual({ x: 100, y: 200 });
    expect(position(result, child.id)).toEqual({ x: 30, y: 90 });
    expect(groupSize(result, group.id)).toEqual({ width: 340, height: 294 });
    expect(collectAbsolutePositions(result).get(child.id)).toEqual({ x: 130, y: 290 });
  });

  it("preserves a table absolute position when its visible parent group changes", () => {
    const oldGroup = groupNode('group:["public","old"]');
    const childId = 'table:["public","member"]';
    const previous = diagram([
      { ...oldGroup, position: { x: 100, y: 200 } },
      { ...table(childId, oldGroup.id), position: { x: 40, y: 100 } },
    ]);
    const newGroup = groupNode('group:["public","new"]');
    const target = diagram([newGroup, table(childId, newGroup.id)]);

    const result = deriveInteractiveLayout(target, { previousProjection: previous });
    const absolute = collectAbsolutePositions(result);

    expect(absolute.get(childId)).toEqual({ x: 140, y: 300 });
    expect(position(result, newGroup.id)).toEqual({ x: 116, y: 220 });
    expect(position(result, childId)).toEqual({ x: 24, y: 80 });
  });

  it("keeps seeded roots and appends missing roots below their occupied bounds", () => {
    const savedId = 'table:["public","saved"]';
    const missingId = 'table:["public","missing"]';
    const result = deriveInteractiveLayout(diagram([table(savedId), table(missingId)]), {
      savedPositions: { [savedId]: { x: 500, y: 600 } },
    });

    expect(position(result, savedId)).toEqual({ x: 500, y: 600 });
    expect(position(result, missingId)).toEqual({ x: 0, y: 800 });
    expect(rootRectanglesOverlap(result)).toBe(false);
  });

  it("reuses unchanged node identities across view projections", () => {
    const tableId = 'table:["public","shared"]';
    const previous = deriveInteractiveLayout(diagram([table(tableId)]));
    const next = deriveInteractiveLayout(
      { ...diagram([table(tableId)]), viewKey: 'view:["public","focused"]' },
      { previousProjection: previous },
    );

    expect(next.nodes[0]).toBe(previous.nodes[0]);
    expect(next.nodes).toBe(previous.nodes);
    expect(next.edges).toBe(previous.edges);

    const changed = diagram([table(tableId)]);
    if (changed.nodes[0]?.type !== "table") throw new Error("Expected a table node.");
    changed.nodes[0].data.name = "renamed";
    const changedResult = deriveInteractiveLayout(changed, { previousProjection: previous });
    expect(changedResult.nodes[0]).not.toBe(previous.nodes[0]);
  });

  it("derives a deterministic viewport directly from compound projection bounds", () => {
    const group = { ...groupNode('group:["public","domain"]'), position: { x: 100, y: 200 } };
    const child = {
      ...table('table:["public","member"]', group.id, 120),
      position: { x: 40, y: 80 },
    };
    const projection = diagram([group, child]);

    const first = deriveInteractiveViewport(projection, { width: 1_000, height: 500 });
    const second = deriveInteractiveViewport(projection, { width: 1_000, height: 500 });

    expect(second).toEqual(first);
    expect(first).toEqual({ x: 27.5, y: -275, zoom: 1.75 });
    expect(deriveInteractiveViewport(projection, { width: 0, height: 500 })).toBeNull();
  });
});

function diagram(nodes: Array<GroupDiagramNode | TableDiagramNode>): DiagramProjection {
  return { viewKey: "GLOBAL", lod: "FULL", nodes, edges: [] };
}

function table(id: string, parentId?: string, height = 120): TableDiagramNode {
  return {
    id,
    type: "table",
    position: { x: 0, y: 0 },
    style: { width: 260, height },
    data: {
      kind: "table",
      tableKey: id,
      schemaName: "public",
      name: id,
      columns: [],
      lod: "FULL",
    },
    ...(parentId ? { parentId, extent: "parent" as const } : {}),
  };
}

function groupNode(id: string): GroupDiagramNode {
  return {
    id,
    type: "group",
    position: { x: 0, y: 0 },
    style: { width: 340, height: 180 },
    data: {
      kind: "group",
      groupKey: id,
      schemaName: "public",
      name: id,
      tableKeys: [],
      tableCount: 0,
      color: null,
      collapsed: false,
      lod: "FULL",
    },
  };
}

function position(projection: DiagramProjection, id: string): { x: number; y: number } {
  const node = projection.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`Missing node ${id}`);
  return node.position;
}

function groupSize(projection: DiagramProjection, id: string): { width: unknown; height: unknown } {
  const node = projection.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`Missing group ${id}`);
  return { width: node.style?.width, height: node.style?.height };
}

function rootRectanglesOverlap(projection: DiagramProjection): boolean {
  const roots = projection.nodes.filter((node) => !node.parentId);
  return roots.some((left, index) =>
    roots.slice(index + 1).some((right) => {
      const leftWidth = Number(left.style?.width ?? 0);
      const leftHeight = Number(left.style?.height ?? 0);
      const rightWidth = Number(right.style?.width ?? 0);
      const rightHeight = Number(right.style?.height ?? 0);
      return !(
        left.position.x + leftWidth <= right.position.x ||
        right.position.x + rightWidth <= left.position.x ||
        left.position.y + leftHeight <= right.position.y ||
        right.position.y + rightHeight <= left.position.y
      );
    }),
  );
}
