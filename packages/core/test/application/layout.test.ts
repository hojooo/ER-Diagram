import { describe, expect, it } from "vitest";

import {
  createLayoutApplication,
  type DiagramLayout,
  type DiagramLayoutValue,
  type LayoutApplicationResult,
  type LayoutPersistencePort,
  type LayoutPersistenceTransaction,
  recoverLayoutStableKeys,
} from "../../src/index.js";

const PROJECT_ID = "project-1";
const HASH = "a".repeat(64);

class FakeLayoutPersistence implements LayoutPersistencePort, LayoutPersistenceTransaction {
  readonly revisions = new Map([[PROJECT_ID, 0]]);
  readonly layouts = new Map<string, DiagramLayout>();
  failAfterUpsert = false;

  getProjectLayoutRevisionNo(projectId: string): number | null {
    return this.revisions.get(projectId) ?? null;
  }

  getLayout(projectId: string, viewKey: string): DiagramLayout | null {
    const layout = this.layouts.get(`${projectId}:${viewKey}`);
    return layout ? structuredClone(layout) : null;
  }

  transaction<T>(operation: (transaction: LayoutPersistenceTransaction) => T): T {
    const revisions = structuredClone(this.revisions);
    const layouts = structuredClone(this.layouts);
    try {
      return operation(this);
    } catch (error) {
      this.revisions.clear();
      for (const entry of revisions) this.revisions.set(...entry);
      this.layouts.clear();
      for (const entry of layouts) this.layouts.set(...entry);
      throw error;
    }
  }

  upsertLayout(layout: DiagramLayout): void {
    this.layouts.set(`${layout.projectId}:${layout.viewKey}`, structuredClone(layout));
    if (this.failAfterUpsert) throw new Error("forced layout failure");
  }

  updateProjectLayoutRevision(projectId: string, expected: number, next: number): boolean {
    if (this.revisions.get(projectId) !== expected) return false;
    this.revisions.set(projectId, next);
    return true;
  }
}

function layout(overrides: Partial<DiagramLayoutValue> = {}): DiagramLayoutValue {
  return {
    positions: { 'table:["public","users"]': { x: 10, y: 20 } },
    collapsedGroupKeys: [],
    hiddenElementKeys: [],
    viewport: { x: 1, y: 2, zoom: 1 },
    detailLevel: "FULL",
    baseSchemaHash: HASH,
    ...overrides,
  };
}

function success<T>(result: LayoutApplicationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe("layout application", () => {
  it("returns an empty state and creates project-global layout revisions", async () => {
    const persistence = new FakeLayoutPersistence();
    const application = createLayoutApplication({ persistence });

    expect(success(await application.getLayout(PROJECT_ID, "GLOBAL"))).toEqual({
      layout: null,
      currentLayoutRevisionNo: 0,
    });

    const global = success(
      await application.saveLayout({
        projectId: PROJECT_ID,
        viewKey: "GLOBAL",
        expectedLayoutRevisionNo: 0,
        layout: layout(),
      }),
    );
    expect(global).toMatchObject({
      layoutUpdated: true,
      state: { currentLayoutRevisionNo: 1, layout: { revisionNo: 1, viewKey: "GLOBAL" } },
    });

    const view = success(
      await application.saveLayout({
        projectId: PROJECT_ID,
        viewKey: 'view:["public","focus"]',
        expectedLayoutRevisionNo: 1,
        layout: layout({ viewport: { x: 30, y: 40, zoom: 0.75 } }),
      }),
    );
    expect(view.state.currentLayoutRevisionNo).toBe(2);
    expect(view.state.layout?.revisionNo).toBe(2);
    expect(success(await application.getLayout(PROJECT_ID, "GLOBAL")).layout).toMatchObject({
      revisionNo: 1,
      viewport: { x: 1, y: 2, zoom: 1 },
    });
  });

  it("normalizes unordered values and treats identical writes as no-ops", async () => {
    const persistence = new FakeLayoutPersistence();
    const application = createLayoutApplication({ persistence });
    success(
      await application.saveLayout({
        projectId: PROJECT_ID,
        viewKey: "GLOBAL",
        expectedLayoutRevisionNo: 0,
        layout: layout({
          positions: { z: { x: 1, y: 2 }, a: { x: 3, y: 4 } },
          collapsedGroupKeys: ["z", "a"],
          hiddenElementKeys: ["b", "a"],
        }),
      }),
    );
    const result = success(
      await application.saveLayout({
        projectId: PROJECT_ID,
        viewKey: "GLOBAL",
        expectedLayoutRevisionNo: 1,
        layout: layout({
          positions: { a: { x: 3, y: 4 }, z: { x: 1, y: 2 } },
          collapsedGroupKeys: ["a", "z"],
          hiddenElementKeys: ["a", "b"],
        }),
      }),
    );

    expect(result.layoutUpdated).toBe(false);
    expect(result.state.currentLayoutRevisionNo).toBe(1);
    expect(result.state.layout?.collapsedGroupKeys).toEqual(["a", "z"]);
  });

  it("rejects stale writes across views before applying a no-op", async () => {
    const persistence = new FakeLayoutPersistence();
    const application = createLayoutApplication({ persistence });
    success(
      await application.saveLayout({
        projectId: PROJECT_ID,
        viewKey: "GLOBAL",
        expectedLayoutRevisionNo: 0,
        layout: layout(),
      }),
    );

    const result = await application.saveLayout({
      projectId: PROJECT_ID,
      viewKey: "other",
      expectedLayoutRevisionNo: 0,
      layout: layout(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "LAYOUT_REVISION_CONFLICT", currentLayoutRevisionNo: 1 },
    });
    expect(persistence.layouts.size).toBe(1);
  });

  it("validates input and rolls back partial persistence failures", async () => {
    const persistence = new FakeLayoutPersistence();
    const application = createLayoutApplication({ persistence });
    const invalid = await application.saveLayout({
      projectId: PROJECT_ID,
      viewKey: "GLOBAL",
      expectedLayoutRevisionNo: 0,
      layout: layout({ viewport: { x: 0, y: 0, zoom: Number.NaN } }),
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "LAYOUT_INPUT_INVALID" } });

    persistence.failAfterUpsert = true;
    await expect(
      application.saveLayout({
        projectId: PROJECT_ID,
        viewKey: "GLOBAL",
        expectedLayoutRevisionNo: 0,
        layout: layout(),
      }),
    ).rejects.toThrow("forced layout failure");
    expect(persistence.layouts.size).toBe(0);
    expect(persistence.revisions.get(PROJECT_ID)).toBe(0);
  });

  it("recovers exact rename positions without deleting stale keys", () => {
    const recovered = recoverLayoutStableKeys(
      layout({
        positions: { before: { x: 12, y: 34, width: 360, height: 224 } },
        hiddenElementKeys: ["before"],
      }),
      [
        {
          elementKind: "table",
          beforeKey: "before",
          afterKey: "after",
          beforeParentKey: null,
          afterParentKey: null,
          confidence: "HIGH",
          reason: "UNIQUE_EXACT_STRUCTURE",
        },
      ],
    );

    expect(recovered.recoveredKeys).toEqual(["after"]);
    expect(recovered.layout.positions).toEqual({
      before: { x: 12, y: 34, width: 360, height: 224 },
      after: { x: 12, y: 34, width: 360, height: 224 },
    });
    expect(new Set(recovered.layout.hiddenElementKeys)).toEqual(new Set(["before", "after"]));
  });

  it("treats table dimensions as part of layout identity", async () => {
    const persistence = new FakeLayoutPersistence();
    const application = createLayoutApplication({ persistence });
    success(
      await application.saveLayout({
        projectId: PROJECT_ID,
        viewKey: "GLOBAL",
        expectedLayoutRevisionNo: 0,
        layout: layout({
          positions: {
            'table:["public","users"]': { x: 10, y: 20, width: 320, height: 180 },
          },
        }),
      }),
    );

    const changed = success(
      await application.saveLayout({
        projectId: PROJECT_ID,
        viewKey: "GLOBAL",
        expectedLayoutRevisionNo: 1,
        layout: layout({
          positions: {
            'table:["public","users"]': { x: 10, y: 20, width: 360, height: 180 },
          },
        }),
      }),
    );

    expect(changed.layoutUpdated).toBe(true);
    expect(changed.state.currentLayoutRevisionNo).toBe(2);
    expect(changed.state.layout?.positions['table:["public","users"]']).toEqual({
      x: 10,
      y: 20,
      width: 360,
      height: 180,
    });
  });
});
