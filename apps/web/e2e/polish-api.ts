import { createHash } from "node:crypto";
import type { ProjectState } from "@er-diagram/contracts";
import type { Page } from "@playwright/test";
import { createControlledLayoutApi } from "./controlled-layout-api.js";

export const POLISH_PROJECT_ID = "019d3f4e-7b6c-7abc-8def-9123456789ab";
export const POLISH_SOURCE = `Table accounts {
  id bigint [pk]
  account_display_name_for_review varchar(255)
}
Table posts {
  id bigint [pk]
  account_id bigint
  title varchar(255)
}
Ref: posts.account_id > accounts.id
`;

// Public synthetic data; the UI and workers are real, only the HTTP boundary is controlled.
export async function installPolishApi(page: Page, source = POLISH_SOURCE, empty = false) {
  const createdAt = "2026-09-05T00:00:00.000Z";
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const revision = {
    id: "019d3f4e-7b6c-7def-9abc-9123456789ab",
    projectId: POLISH_PROJECT_ID,
    revisionNo: 1,
    source,
    sourceHash,
    validity: "VALID" as const,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
    createdAt,
  };
  const state = {
    project: {
      id: POLISH_PROJECT_ID,
      name: "Order management · synthetic review project",
      primaryDialect: "POSTGRESQL",
      draftSource: source,
      draftHash: sourceHash,
      lastValidRevisionId: revision.id,
      parserVersion: "9.1.1",
      schemaRevisionNo: 1,
      layoutRevisionNo: 0,
      createdAt,
      updatedAt: createdAt,
    },
    currentRevision: revision,
    lastValidRevision: revision,
  } satisfies ProjectState;
  const {
    draftSource: _source,
    draftHash: _hash,
    lastValidRevisionId: _revision,
    ...summary
  } = state.project;
  const layouts = createControlledLayoutApi(POLISH_PROJECT_ID);
  await page.route("**/api/v1/projects**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    const command = request.postDataJSON() as Record<string, unknown> | null;
    const headers = { "content-type": "application/json" };
    if (await layouts.fulfillIfMatched({ route, pathname, method, command, headers })) return;
    if (method === "GET" && pathname === "/api/v1/projects") {
      await route.fulfill({
        json: {
          projects: empty
            ? []
            : [
                {
                  ...summary,
                  draftValidity: "VALID",
                  diagnosticSummary: revision.diagnosticSummary,
                },
              ],
        },
      });
      return;
    }
    if (method === "GET" && pathname === `/api/v1/projects/${POLISH_PROJECT_ID}`) {
      await route.fulfill({ json: { state } });
      return;
    }
    throw new Error(`Unexpected polish fixture request: ${method} ${pathname}`);
  });
  return { state, layouts };
}
