import { createHash } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";

import { createControlledLayoutApi } from "./controlled-layout-api.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-3123456789ab";
const CREATED_AT = "2026-08-28T01:02:03.004Z";
const SOURCE = `TableGroup Identity {
  accounts
  profiles
}

Table accounts {
  id int [pk]
}

Table profiles {
  id int [pk]
  account_id int
}

Table audit_log {
  id int [pk]
}

Ref profile_account: profiles.account_id > accounts.id

DiagramView identity_only {
  Tables {
    accounts
    profiles
  }
  TableGroups {
    Identity
  }
  Schemas {
  }
}
`;

test("persists per-view drag state and supports preview, reset, and explicit conflict recovery", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const browserErrors: string[] = [];
  const expectedConflictErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.text().includes("409 (Conflict)")) {
      expectedConflictErrors.push(message.text());
      return;
    }
    browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const api = await installLayoutApi(page);

  await page.goto(`/projects/${PROJECT_ID}`);
  await expect(page.locator('section[aria-label="DBML source editor"] .monaco-editor')).toBeVisible(
    {
      timeout: 20_000,
    },
  );
  await waitForDiagramLayout(page);
  const auditNode = page.locator('.react-flow__node-table[data-id*="audit_log"]');
  await expect(auditNode).toBeVisible();
  const auditKey = await auditNode.getAttribute("data-id");
  if (!auditKey) throw new Error("Missing stable audit table key.");
  await expect(auditNode).toHaveClass(/draggable/);

  const positionBeforeDrag = await auditNode.getAttribute("style");
  await dragBy(page, auditNode, 90, 70);
  await expect.poll(async () => await auditNode.getAttribute("style")).not.toBe(positionBeforeDrag);
  await expect.poll(() => api.layouts.writes.length).toBe(1);
  const globalWrite = api.layouts.writes[0];
  expect(globalWrite?.viewKey).toBe("GLOBAL");
  const globalPosition = layoutPositions(globalWrite?.command)[auditKey];
  expect(globalPosition).toBeDefined();
  expect(api.draftWrites).toHaveLength(0);

  await page.reload();
  await waitForDiagramLayout(page);
  const restoredAuditNode = page.locator(`.react-flow__node-table[data-id='${auditKey}']`);
  await expect(restoredAuditNode).toBeVisible();
  const restoredPosition = parseNodePosition(await restoredAuditNode.getAttribute("style"));
  expect(restoredPosition.x).toBeCloseTo(globalPosition?.x ?? 0, 2);
  expect(restoredPosition.y).toBeCloseTo(globalPosition?.y ?? 0, 2);

  const viewSelector = page.getByRole("combobox", { name: "Diagram view" });
  const detailSelector = page.getByRole("combobox", { name: "Detail level" });
  await viewSelector.selectOption({ label: "identity_only" });
  const viewKey = await viewSelector.inputValue();
  await waitForDiagramLayout(page);
  await detailSelector.selectOption("NAME_ONLY");
  await page.getByRole("button", { name: "Collapse public.Identity", exact: true }).click();
  await expect.poll(() => api.layouts.writes.some((write) => write.viewKey === viewKey)).toBe(true);
  const viewWriteBeforePreview = api.layouts.writes.findLast((write) => write.viewKey === viewKey);
  expect(viewWriteBeforePreview?.command.layout).toMatchObject({
    detailLevel: "NAME_ONLY",
    collapsedGroupKeys: [expect.any(String)],
  });

  await viewSelector.selectOption("GLOBAL");
  await waitForDiagramLayout(page);
  await expect(detailSelector).toHaveValue("FULL");
  await viewSelector.selectOption(viewKey);
  await waitForDiagramLayout(page);
  await expect(detailSelector).toHaveValue("NAME_ONLY");
  await expect(
    page.getByRole("button", { name: "Expand public.Identity", exact: true }),
  ).toBeVisible();

  const writesBeforePreview = api.layouts.writes.length;
  await page.getByRole("button", { name: "Preview auto layout" }).click();
  await expect(page.getByText("Auto-layout preview ready")).toBeVisible({ timeout: 20_000 });
  expect(api.layouts.writes.length).toBeGreaterThanOrEqual(writesBeforePreview);
  const writesAfterBaseline = api.layouts.writes.length;
  await page.getByRole("button", { name: "Cancel preview" }).click();
  await page.waitForTimeout(700);
  expect(api.layouts.writes).toHaveLength(writesAfterBaseline);

  await page.getByRole("button", { name: "Preview auto layout" }).click();
  await expect(page.getByText("Auto-layout preview ready")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Apply auto layout" }).click();
  await expect.poll(() => api.layouts.writes.length).toBe(writesAfterBaseline + 1);

  const globalRowBeforeReset = structuredClone(api.layouts.rows.get("GLOBAL"));
  await page.getByRole("button", { name: "Reset layout" }).click();
  const resetDialog = page.getByRole("dialog", { name: "Reset this view layout?" });
  await expect(resetDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await resetDialog.getByRole("button", { name: "Reset this view" }).click();
  await expect.poll(() => api.layouts.writes.length).toBe(writesAfterBaseline + 2);
  const resetWrite = api.layouts.writes.at(-1);
  expect(resetWrite).toMatchObject({
    viewKey,
    command: {
      layout: {
        detailLevel: "FULL",
        collapsedGroupKeys: [],
        hiddenElementKeys: [],
      },
    },
  });
  expect(api.layouts.rows.get("GLOBAL")).toEqual(globalRowBeforeReset);

  api.layouts.advanceRevision();
  await viewSelector.selectOption("GLOBAL");
  await waitForDiagramLayout(page);
  await dragBy(page, page.locator(`.react-flow__node-table[data-id='${auditKey}']`), 30, 20);
  await expect(page.getByText("Layout conflict", { exact: true }).first()).toBeVisible();
  const writesBeforeRetry = api.layouts.writes.length;
  await page.getByRole("button", { name: "Retry local layout" }).click();
  await expect.poll(() => api.layouts.writes.length).toBe(writesBeforeRetry + 1);
  await expect(page.getByText("Layout conflict", { exact: true })).toHaveCount(0);

  api.layouts.advanceRevision();
  await dragBy(page, page.locator(`.react-flow__node-table[data-id='${auditKey}']`), 20, 10);
  await expect(page.getByText("Layout conflict", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Load server layout" }).click();
  const conflictDialog = page.getByRole("dialog", { name: "Load server layout?" });
  await expect(conflictDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await conflictDialog.getByRole("button", { name: "Load server layout" }).click();
  await expect(page.getByText("Layout conflict", { exact: true })).toHaveCount(0);

  expect(api.draftWrites).toHaveLength(0);
  expect(expectedConflictErrors).toHaveLength(2);
  expect(browserErrors).toEqual([]);
});

async function waitForDiagramLayout(page: Page): Promise<void> {
  const status = page.getByTestId("base-diagram-layout-status");
  await expect(status).toHaveText(/Diagram layout (ready|failed)/, { timeout: 20_000 });
  if ((await status.textContent())?.includes("failed")) {
    await page.getByRole("button", { name: "Retry layout" }).click();
    await expect(status).toHaveText("Diagram layout ready", { timeout: 10_000 });
  }
}

async function dragBy(page: Page, node: Locator, x: number, y: number): Promise<void> {
  const tableHandle = node.locator(".diagram-table__drag-handle");
  const surface =
    (await tableHandle.count()) > 0 ? tableHandle : node.locator(".diagram-group__header > div");
  await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox();
  if (!box) throw new Error("Diagram node has no draggable header.");
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + x, startY + y, { steps: 8 });
  await page.mouse.up();
}

function layoutPositions(command: Record<string, unknown> | undefined) {
  const layout = command?.layout as
    | { positions?: Record<string, { x: number; y: number }> }
    | undefined;
  return layout?.positions ?? {};
}

function parseNodePosition(style: string | null): { x: number; y: number } {
  const match = style?.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
  if (!match?.[1] || !match[2]) throw new Error(`Missing node translation in ${style ?? "null"}.`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

async function installLayoutApi(page: Page) {
  const state = projectState();
  const layouts = createControlledLayoutApi(PROJECT_ID);
  const draftWrites: Array<Record<string, unknown>> = [];

  await page.route("**/api/v1/projects**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    const command = request.postDataJSON() as Record<string, unknown> | null;
    const commandId = typeof command?.commandId === "string" ? command.commandId : undefined;
    const headers = {
      "content-type": "application/json",
      "x-correlation-id": "123e4567-e89b-42d3-a456-426614174000",
      ...(commandId ? { "x-command-id": commandId } : {}),
    };

    if (await layouts.fulfillIfMatched({ route, pathname, method, command, headers })) return;
    if (method === "GET" && pathname === `/api/v1/projects/${PROJECT_ID}`) {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ state }) });
      return;
    }
    if (method === "PUT" && pathname === `/api/v1/projects/${PROJECT_ID}/draft`) {
      if (command) draftWrites.push(command);
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ state, diagnostics: [], revisionCreated: false }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      headers,
      body: JSON.stringify({
        code: "PROJECT_NOT_FOUND",
        message: "Project not found.",
        correlationId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    });
  });
  return { layouts, draftWrites };
}

function projectState() {
  const currentRevision = revision();
  return {
    project: {
      id: PROJECT_ID,
      name: "Layout workspace",
      primaryDialect: "POSTGRESQL" as const,
      draftSource: SOURCE,
      draftHash: currentRevision.sourceHash,
      lastValidRevisionId: currentRevision.id,
      parserVersion: "9.1.1",
      schemaRevisionNo: 1,
      layoutRevisionNo: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision,
    lastValidRevision: currentRevision,
  };
}

function revision() {
  return {
    id: "019d3f4e-7b6c-7abd-8def-3123456789ab",
    projectId: PROJECT_ID,
    revisionNo: 1,
    source: SOURCE,
    sourceHash: sha256(SOURCE),
    validity: "VALID" as const,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
    createdAt: CREATED_AT,
  };
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
