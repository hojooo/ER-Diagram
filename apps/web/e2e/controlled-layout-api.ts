import type { Route } from "@playwright/test";

export interface ControlledLayoutWrite {
  readonly viewKey: string;
  readonly command: Record<string, unknown>;
}

export function createControlledLayoutApi(projectId: string, initialRevisionNo = 0) {
  let currentRevisionNo = initialRevisionNo;
  const rows = new Map<string, Record<string, unknown>>();
  const writes: ControlledLayoutWrite[] = [];

  return {
    rows,
    writes,
    get currentRevisionNo() {
      return currentRevisionNo;
    },
    advanceRevision(): void {
      currentRevisionNo += 1;
    },
    async fulfillIfMatched(input: {
      readonly route: Route;
      readonly pathname: string;
      readonly method: string;
      readonly command: Record<string, unknown> | null;
      readonly headers: Record<string, string>;
    }): Promise<boolean> {
      const prefix = `/api/v1/projects/${projectId}/layouts/`;
      if (!input.pathname.startsWith(prefix)) return false;
      const viewKey = decodeURIComponent(input.pathname.slice(prefix.length));
      if (input.method === "GET") {
        await input.route.fulfill({
          status: 200,
          headers: input.headers,
          body: JSON.stringify({
            layout: rows.get(viewKey) ?? null,
            currentLayoutRevisionNo: currentRevisionNo,
          }),
        });
        return true;
      }
      if (input.method !== "PUT" || !input.command) return false;
      const expected = input.command.expectedLayoutRevisionNo;
      if (expected !== currentRevisionNo) {
        await input.route.fulfill({
          status: 409,
          headers: input.headers,
          body: JSON.stringify({
            code: "LAYOUT_REVISION_CONFLICT",
            message: "The layout revision is stale.",
            correlationId: "123e4567-e89b-42d3-a456-426614174000",
            currentRevisionNo,
          }),
        });
        return true;
      }
      currentRevisionNo += 1;
      const layout = {
        projectId,
        viewKey,
        revisionNo: currentRevisionNo,
        ...(input.command.layout as Record<string, unknown>),
      };
      rows.set(viewKey, layout);
      writes.push({ viewKey, command: structuredClone(input.command) });
      await input.route.fulfill({
        status: 200,
        headers: input.headers,
        body: JSON.stringify({
          state: { layout, currentLayoutRevisionNo: currentRevisionNo },
          layoutUpdated: true,
        }),
      });
      return true;
    },
  };
}
