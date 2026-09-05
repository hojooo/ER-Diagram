import { describe, expect, it } from "vitest";

import {
  errorResponseSchema,
  layoutMutationResponseSchema,
  layoutParamsSchema,
  layoutResponseSchema,
  saveLayoutRequestSchema,
} from "../src/index.js";

const PROJECT_ID = "018f0f87-7b5a-7cc0-8000-000000000001";
const COMMAND_ID = "123e4567-e89b-42d3-a456-426614174000";
const HASH = "a".repeat(64);

function layout() {
  return {
    positions: {
      'table:["public","사용자🚀"]': { x: 10.5, y: -20, width: 360, height: 224 },
    },
    collapsedGroupKeys: ['group:["public","핵심"]'],
    hiddenElementKeys: [],
    viewport: { x: 1, y: 2, zoom: 0.75 },
    detailLevel: "FULL" as const,
    baseSchemaHash: HASH,
  };
}

describe("layout HTTP contracts", () => {
  it("accepts strict JSON-safe request and response envelopes", () => {
    const request = saveLayoutRequestSchema.parse({
      commandId: COMMAND_ID,
      expectedLayoutRevisionNo: 0,
      layout: layout(),
    });
    const response = layoutMutationResponseSchema.parse({
      state: {
        layout: { projectId: PROJECT_ID, viewKey: "GLOBAL", revisionNo: 1, ...layout() },
        currentLayoutRevisionNo: 1,
      },
      layoutUpdated: true,
    });

    const clone = Reflect.get(globalThis, "structuredClone");
    expect(clone).toBeTypeOf("function");
    if (typeof clone === "function") {
      expect(clone(JSON.parse(JSON.stringify(request)))).toEqual(request);
      expect(clone(JSON.parse(JSON.stringify(response)))).toEqual(response);
    }
    expect(layoutParamsSchema.parse({ projectId: PROJECT_ID, viewKey: "GLOBAL" })).toEqual({
      projectId: PROJECT_ID,
      viewKey: "GLOBAL",
    });
  });

  it("represents an unpersisted view and revision zero", () => {
    expect(layoutResponseSchema.parse({ layout: null, currentLayoutRevisionNo: 0 })).toEqual({
      layout: null,
      currentLayoutRevisionNo: 0,
    });
    expect(
      errorResponseSchema.parse({
        code: "LAYOUT_REVISION_CONFLICT",
        message: "Conflict",
        correlationId: COMMAND_ID,
        currentRevisionNo: 0,
      }).currentRevisionNo,
    ).toBe(0);
  });

  it("rejects unknown fields, invalid numbers, hashes, and duplicate keys", () => {
    const base = {
      commandId: COMMAND_ID,
      expectedLayoutRevisionNo: 0,
      layout: layout(),
    };
    expect(saveLayoutRequestSchema.safeParse({ ...base, extra: true }).success).toBe(false);
    expect(
      saveLayoutRequestSchema.safeParse({
        ...base,
        layout: { ...layout(), viewport: { x: 0, y: 0, zoom: Number.NaN } },
      }).success,
    ).toBe(false);
    expect(
      saveLayoutRequestSchema.safeParse({
        ...base,
        layout: { ...layout(), baseSchemaHash: "ABC" },
      }).success,
    ).toBe(false);
    expect(
      saveLayoutRequestSchema.safeParse({
        ...base,
        layout: { ...layout(), collapsedGroupKeys: ["same", "same"] },
      }).success,
    ).toBe(false);
    expect(layoutParamsSchema.safeParse({ projectId: PROJECT_ID, viewKey: "   " }).success).toBe(
      false,
    );
    expect(
      saveLayoutRequestSchema.safeParse({
        ...base,
        layout: {
          ...layout(),
          positions: { 'table:["public","users"]': { x: 0, y: 0, width: 320 } },
        },
      }).success,
    ).toBe(false);
    expect(
      saveLayoutRequestSchema.safeParse({
        ...base,
        layout: {
          ...layout(),
          positions: {
            'group:["public","identity"]': { x: 0, y: 0, width: 320, height: 240 },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      saveLayoutRequestSchema.safeParse({
        ...base,
        layout: {
          ...layout(),
          positions: {
            'table:["public","users"]': { x: 0, y: 0, width: 320.5, height: -1 },
          },
        },
      }).success,
    ).toBe(false);
  });
});
