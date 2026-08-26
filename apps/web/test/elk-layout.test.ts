import { describe, expect, it } from "vitest";
import { demoSchemaGraph } from "../src/diagram/demo-schema.js";
import { layoutDiagram } from "../src/diagram/elk-layout.js";
import { createDiagramProjection, GLOBAL_VIEW_KEY } from "../src/diagram/projection.js";

describe("compound ELK layout", () => {
  it("lays out cross-group references with finite parent-relative positions", async () => {
    const projection = createDiagramProjection(demoSchemaGraph, {
      viewKey: GLOBAL_VIEW_KEY,
      collapsedGroupKeys: new Set(),
      lod: "FULL",
    });
    const originalPositions = projection.nodes.map((node) => ({ ...node.position }));

    const laidOut = await layoutDiagram(projection);

    expect(laidOut.nodes).toHaveLength(projection.nodes.length);
    expect(laidOut.edges).toHaveLength(projection.edges.length);
    expect(
      laidOut.nodes.every(
        (node) => Number.isFinite(node.position.x) && Number.isFinite(node.position.y),
      ),
    ).toBe(true);
    expect(projection.nodes.map((node) => node.position)).toEqual(originalPositions);
    expect(laidOut.nodes.map((node) => node.parentId)).toEqual(
      projection.nodes.map((node) => node.parentId),
    );
  });
});
