import { describe, expect, it } from "vitest";
import type { DiagramProjection } from "../src/diagram/types.js";
import { cullDiagramToViewport } from "../src/diagram/viewport-culling.js";

describe("viewport culling", () => {
  it("keeps intersecting nodes, their parents, and only fully visible edges", () => {
    const projection: DiagramProjection = {
      viewKey: "GLOBAL",
      lod: "FULL",
      nodes: [
        {
          id: "group-a",
          type: "group",
          position: { x: 100, y: 100 },
          style: { width: 400, height: 300 },
          data: {
            kind: "group",
            groupKey: "group-a",
            schemaName: "public",
            name: "A",
            tableKeys: ["table-a"],
            tableCount: 1,
            color: null,
            collapsed: false,
            lod: "FULL",
          },
        },
        {
          id: "table-a",
          type: "table",
          parentId: "group-a",
          extent: "parent",
          position: { x: 40, y: 60 },
          style: { width: 200, height: 120 },
          data: {
            kind: "table",
            tableKey: "table-a",
            schemaName: "public",
            name: "a",
            columns: [],
            lod: "FULL",
          },
        },
        {
          id: "table-b",
          type: "table",
          position: { x: 2_000, y: 2_000 },
          style: { width: 200, height: 120 },
          data: {
            kind: "table",
            tableKey: "table-b",
            schemaName: "public",
            name: "b",
            columns: [],
            lod: "FULL",
          },
        },
      ],
      edges: [
        {
          id: "edge-a-b",
          type: "reference",
          source: "table-a",
          target: "table-b",
          data: {
            kind: "reference",
            aggregate: false,
            count: 1,
            referenceKeys: ["ref-a-b"],
            inactive: false,
          },
        },
      ],
    };

    const culled = cullDiagramToViewport(
      projection,
      { x: 120, y: 120, width: 300, height: 240 },
      0,
    );

    expect(culled.nodes.map((node) => node.id)).toEqual(["group-a", "table-a"]);
    expect(culled.edges).toHaveLength(0);
    expect(projection.nodes).toHaveLength(3);
  });
});
