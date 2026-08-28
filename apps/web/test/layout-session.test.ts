import type { DiagramLayoutValue, LayoutResponse } from "@er-diagram/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createDefaultLayoutValue,
  createLayoutSession,
  LAYOUT_AUTOSAVE_DEBOUNCE_MS,
} from "../src/diagram/layout-session.js";
import { ProjectApiError } from "../src/projects/project-api.js";

const PROJECT_ID = "018f0f87-7b5a-7cc0-8000-000000000001";
const HASH = "a".repeat(64);

function layout(overrides: Partial<DiagramLayoutValue> = {}): DiagramLayoutValue {
  return {
    ...createDefaultLayoutValue(HASH),
    positions: { table: { x: 1, y: 2 } },
    ...overrides,
  };
}

function response(
  currentLayoutRevisionNo: number,
  viewKey: string,
  value: DiagramLayoutValue | null,
): LayoutResponse {
  return {
    currentLayoutRevisionNo,
    layout: value
      ? { projectId: PROJECT_ID, viewKey, revisionNo: currentLayoutRevisionNo, ...value }
      : null,
  };
}

describe("layout session", () => {
  it("hydrates views independently and autosaves after exactly 500 ms", async () => {
    vi.useFakeTimers();
    const saveLayout = vi.fn(async (input) => ({
      state: response(input.expectedLayoutRevisionNo + 1, input.viewKey, input.layout),
      layoutUpdated: true,
    }));
    const session = createLayoutSession({
      projectId: PROJECT_ID,
      initialLayoutRevisionNo: 0,
      loadLayout: async (viewKey) => response(0, viewKey, null),
      saveLayout,
    });
    await session.hydrate("GLOBAL", layout());
    await session.hydrate("view", layout({ viewport: { x: 10, y: 20, zoom: 0.5 } }));

    session.edit("GLOBAL", layout({ positions: { table: { x: 30, y: 40 } } }));
    await vi.advanceTimersByTimeAsync(LAYOUT_AUTOSAVE_DEBOUNCE_MS - 1);
    expect(saveLayout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(saveLayout).toHaveBeenCalledTimes(1);
    expect(saveLayout.mock.calls[0]?.[0]).toMatchObject({
      viewKey: "GLOBAL",
      expectedLayoutRevisionNo: 0,
      layout: { positions: { table: { x: 30, y: 40 } } },
    });
    expect(session.getSnapshot().views.get("view")?.layout.viewport).toEqual({
      x: 10,
      y: 20,
      zoom: 0.5,
    });
    expect(session.getSnapshot().currentLayoutRevisionNo).toBe(1);
    vi.useRealTimers();
  });

  it("serializes cross-view writes and coalesces edits made in flight", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: Array<{ viewKey: string; expected: number; x: number }> = [];
    const session = createLayoutSession({
      projectId: PROJECT_ID,
      initialLayoutRevisionNo: 0,
      loadLayout: async (viewKey) => response(0, viewKey, null),
      saveLayout: async (input) => {
        calls.push({
          viewKey: input.viewKey,
          expected: input.expectedLayoutRevisionNo,
          x: input.layout.positions.table?.x ?? 0,
        });
        if (calls.length === 1) await firstGate;
        return {
          state: response(input.expectedLayoutRevisionNo + 1, input.viewKey, input.layout),
          layoutUpdated: true,
        };
      },
    });
    await session.hydrate("GLOBAL", layout());
    await session.hydrate("view", layout());
    session.edit("GLOBAL", layout({ positions: { table: { x: 10, y: 2 } } }));
    const flushing = session.flush();
    await Promise.resolve();
    session.edit("GLOBAL", layout({ positions: { table: { x: 20, y: 2 } } }));
    session.edit("view", layout({ positions: { table: { x: 30, y: 2 } } }));
    releaseFirst?.();
    await flushing;

    expect(calls).toEqual([
      { viewKey: "GLOBAL", expected: 0, x: 10 },
      { viewKey: "GLOBAL", expected: 1, x: 20 },
      { viewKey: "view", expected: 2, x: 30 },
    ]);
    expect(session.getSnapshot().currentLayoutRevisionNo).toBe(3);
  });

  it("pauses on conflict and supports explicit retry or server load", async () => {
    let conflict = true;
    const serverLayout = layout({ positions: { table: { x: 99, y: 2 } } });
    const session = createLayoutSession({
      projectId: PROJECT_ID,
      initialLayoutRevisionNo: 0,
      loadLayout: async (viewKey) => response(conflict ? 1 : 2, viewKey, serverLayout),
      saveLayout: async (input) => {
        if (conflict) {
          throw new ProjectApiError("Conflict", {
            status: 409,
            code: "LAYOUT_REVISION_CONFLICT",
            currentRevisionNo: 1,
          });
        }
        return {
          state: response(input.expectedLayoutRevisionNo + 1, input.viewKey, input.layout),
          layoutUpdated: true,
        };
      },
    });
    await session.hydrate("GLOBAL", layout());
    session.edit("GLOBAL", layout({ positions: { table: { x: 50, y: 2 } } }));
    await session.flush();
    expect(session.getSnapshot()).toMatchObject({
      currentLayoutRevisionNo: 1,
      conflict: { viewKey: "GLOBAL" },
      hasUnsavedChanges: true,
    });
    expect(session.getSnapshot().views.get("GLOBAL")?.layout.positions.table?.x).toBe(50);

    conflict = false;
    await session.retryLocalLayout();
    expect(session.getSnapshot().conflict).toBeNull();
    expect(session.getSnapshot().currentLayoutRevisionNo).toBe(2);

    conflict = true;
    session.edit("GLOBAL", layout({ positions: { table: { x: 60, y: 2 } } }));
    await session.flush();
    await session.loadServerLayout();
    expect(session.getSnapshot().views.get("GLOBAL")?.layout.positions.table?.x).toBe(99);
    expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
  });

  it("does not save layouts that differ only by deterministic key ordering", async () => {
    const saveLayout = vi.fn();
    const persisted = layout({
      positions: { z: { x: 1, y: 2 }, a: { x: 3, y: 4 } },
      collapsedGroupKeys: ["z", "a"],
      hiddenElementKeys: ["b", "a"],
    });
    const session = createLayoutSession({
      projectId: PROJECT_ID,
      initialLayoutRevisionNo: 4,
      loadLayout: async (viewKey) => response(4, viewKey, persisted),
      saveLayout,
    });
    await session.hydrate("GLOBAL", layout());
    session.edit(
      "GLOBAL",
      layout({
        positions: { a: { x: 3, y: 4 }, z: { x: 1, y: 2 } },
        collapsedGroupKeys: ["a", "z"],
        hiddenElementKeys: ["a", "b"],
      }),
    );
    await session.flush();

    expect(saveLayout).not.toHaveBeenCalled();
    expect(session.getSnapshot().hasUnsavedChanges).toBe(false);
  });

  it("fails closed when conflict recovery cannot reload the server layout", async () => {
    let loadCalls = 0;
    const session = createLayoutSession({
      projectId: PROJECT_ID,
      initialLayoutRevisionNo: 0,
      loadLayout: async (viewKey) => {
        loadCalls += 1;
        if (loadCalls > 1) throw new Error("private load failure");
        return response(0, viewKey, null);
      },
      saveLayout: async () => {
        throw new ProjectApiError("Conflict", {
          status: 409,
          code: "LAYOUT_REVISION_CONFLICT",
          currentRevisionNo: 1,
        });
      },
    });
    await session.hydrate("GLOBAL", layout());
    session.edit("GLOBAL", layout({ positions: { table: { x: 50, y: 60 } } }));
    await session.flush();

    expect(session.getSnapshot().conflict).toBeNull();
    expect(session.getSnapshot().views.get("GLOBAL")).toMatchObject({
      status: "ERROR",
      error: { code: "CLIENT_LAYOUT_ERROR" },
    });
    expect(session.getSnapshot().hasUnsavedChanges).toBe(true);
  });

  it("distinguishes hydration failure from a save failure and prunes deleted views", async () => {
    let failLoad = true;
    const session = createLayoutSession({
      projectId: PROJECT_ID,
      initialLayoutRevisionNo: 0,
      loadLayout: async (viewKey) => {
        if (failLoad && viewKey === "failed") throw new Error("private load failure");
        return response(0, viewKey, null);
      },
      saveLayout: async () => {
        throw new Error("private save failure");
      },
    });

    await session.hydrate("failed", layout());
    expect(session.getSnapshot().views.get("failed")).toMatchObject({
      hydrated: false,
      status: "ERROR",
    });

    failLoad = false;
    await session.hydrate("GLOBAL", layout());
    session.edit("GLOBAL", layout({ positions: { table: { x: 8, y: 9 } } }));
    await session.flush();
    expect(session.getSnapshot().views.get("GLOBAL")).toMatchObject({
      hydrated: true,
      status: "ERROR",
    });

    session.retainViews(new Set(["GLOBAL"]));
    expect(session.getSnapshot().views.has("failed")).toBe(false);
    expect(session.getSnapshot().views.has("GLOBAL")).toBe(true);
  });
});
