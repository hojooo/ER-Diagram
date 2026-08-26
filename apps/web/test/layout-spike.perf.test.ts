import { performance } from "node:perf_hooks";
import { parseDbmlV2 } from "@er-diagram/core";
import { fixtureInventory, generateScaleFixture } from "@er-diagram/test-fixtures";
import { describe, expect, it } from "vitest";
import { layoutDiagram } from "../src/diagram/elk-layout.js";
import { createDiagramProjection, GLOBAL_VIEW_KEY } from "../src/diagram/projection.js";

const M0_LAYOUT_TIMEOUT_MS = 10_000;

describe("layout-spike performance", () => {
  it("lays out the 200-table and 1,000-reference fixture within the M0 timeout", async () => {
    const parsed = await parseDbmlV2(generateScaleFixture());
    if (!parsed.ok) {
      throw new Error(`scale fixture parse failed: ${JSON.stringify(parsed.diagnostics)}`);
    }
    const projection = createDiagramProjection(parsed.graph, {
      viewKey: GLOBAL_VIEW_KEY,
      collapsedGroupKeys: new Set(),
      lod: "NAME_ONLY",
    });
    expect(projection.nodes).toHaveLength(fixtureInventory.scale.tables);
    expect(projection.edges).toHaveLength(fixtureInventory.scale.references);

    const startedAt = performance.now();
    const laidOut = await Promise.race([
      layoutDiagram(projection),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("layout exceeded the M0 timeout")), M0_LAYOUT_TIMEOUT_MS);
      }),
    ]);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(M0_LAYOUT_TIMEOUT_MS);
    expect(laidOut.nodes).toHaveLength(fixtureInventory.scale.tables);
    expect(laidOut.edges).toHaveLength(fixtureInventory.scale.references);
    expect(
      laidOut.nodes.every(
        (node) => Number.isFinite(node.position.x) && Number.isFinite(node.position.y),
      ),
    ).toBe(true);
  }, 15_000);
});
