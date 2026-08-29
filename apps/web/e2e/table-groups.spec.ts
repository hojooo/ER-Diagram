import { createHash } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";

import { createControlledLayoutApi } from "./controlled-layout-api.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-1123456789ab";
const CREATED_AT = "2026-08-28T01:02:03.004Z";
const INITIAL_SOURCE = `TableGroup Identity [color: #778899] {
  accounts
  profiles
}

TableGroup Content [color: #112233] {
  posts
}

Table accounts {
  id int [pk]
}

Table profiles {
  id int [pk]
  account_id int
}

Table posts {
  id int [pk]
  account_id int
  owner_account_id int
}

Ref profile_account: profiles.account_id > accounts.id
Ref post_account: posts.account_id > accounts.id
Ref post_owner: posts.owner_account_id > accounts.id
`;
const INVALID_SOURCE = `${INITIAL_SOURCE}\nTable broken {`;

test("collapses TableGroups without mutating source and preserves last-valid navigation safety", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const api = await installTableGroupApi(page);

  await page.goto(`/projects/${PROJECT_ID}`);
  const editor = page.getByRole("textbox", { name: "DBML source editor" });
  await expect(page.locator('section[aria-label="DBML source editor"] .monaco-editor')).toBeVisible(
    { timeout: 20_000 },
  );
  const layoutStatus = page.getByTestId("base-diagram-layout-status");
  await expect(layoutStatus).toHaveText(/Diagram layout (ready|failed)/, { timeout: 20_000 });
  if ((await layoutStatus.textContent())?.includes("failed")) {
    await page.getByRole("button", { name: "Retry layout" }).click();
    await expect(layoutStatus).toHaveText("Diagram layout ready", { timeout: 10_000 });
  }

  await expect(page.locator(".react-flow__node-group")).toHaveCount(2);
  await expect(page.locator(".react-flow__node-table")).toHaveCount(3);
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await expect(page.getByText("Color #778899", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Collapse public.Identity", exact: true }).click();
  await expect(page.locator(".react-flow__node-table")).toHaveCount(1);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.getByText("×2 relationships", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Collapse public.Content", exact: true }).click();
  await expect(page.locator(".react-flow__node-table")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Expand public.Identity", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Expand public.Content", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(900);
  expect(api.writes).toHaveLength(0);
  const layoutWritesBeforeInvalid = api.layouts.writes.length;

  await page.getByRole("button", { name: "Focus relationship post_account in diagram" }).click();
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Expand public.Identity", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Open source for group at line 1" }).click();
  await expect(editor).toBeFocused();

  await replaceEditorSource(editor, INVALID_SOURCE);
  await expect.poll(() => api.writes.length).toBe(1);
  await expect(page.getByText(/Showing last-valid revision 1/)).toBeVisible();
  const identityOutlineToggle = page.getByRole("button", {
    name: "Expand public.Identity in diagram",
    exact: true,
  });
  await expect(identityOutlineToggle).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Expand public.Content in diagram", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open source for group at line 1" }),
  ).toBeDisabled();

  await identityOutlineToggle.click();
  await expect(
    page.getByRole("button", { name: "Collapse public.Identity in diagram", exact: true }),
  ).toBeVisible();
  await expect.poll(() => api.layouts.writes.length).toBe(layoutWritesBeforeInvalid + 1);
  expect(api.writes).toHaveLength(1);

  expect(browserErrors).toEqual([]);
});

async function replaceEditorSource(editor: Locator, source: string): Promise<void> {
  await editor.focus();
  await editor.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await editor.evaluate((element, pastedSource) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pastedSource);
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    );
  }, source);
  await editor.page().waitForTimeout(800);
}

async function installTableGroupApi(page: Page) {
  let state = projectState(INITIAL_SOURCE, 1, "VALID", null);
  const writes: Array<Record<string, unknown>> = [];
  const layouts = createControlledLayoutApi(PROJECT_ID);

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
      if (!command || typeof command.source !== "string") throw new Error("Missing source.");
      writes.push(command);
      const validity = command.source === INVALID_SOURCE ? "INVALID" : "VALID";
      const previousLastValid = state.lastValidRevision;
      state = projectState(
        command.source,
        state.project.schemaRevisionNo + 1,
        validity,
        previousLastValid,
      );
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({
          state,
          diagnostics: validity === "INVALID" ? [invalidDiagnostic(command.source)] : [],
          revisionCreated: true,
        }),
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

  return { layouts, writes };
}

function projectState(
  source: string,
  revisionNo: number,
  validity: "VALID" | "INVALID",
  previousLastValid: ReturnType<typeof revision> | null,
) {
  const currentRevision = revision(source, revisionNo, validity);
  const lastValidRevision = validity === "VALID" ? currentRevision : previousLastValid;
  return {
    project: {
      id: PROJECT_ID,
      name: "TableGroup workspace",
      primaryDialect: "POSTGRESQL" as const,
      draftSource: source,
      draftHash: sha256(source),
      lastValidRevisionId: lastValidRevision?.id ?? null,
      parserVersion: "9.1.1",
      schemaRevisionNo: revisionNo,
      layoutRevisionNo: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision,
    lastValidRevision,
  };
}

function revision(source: string, revisionNo: number, validity: "VALID" | "INVALID") {
  return {
    id: `019d3f4e-7b6c-7a${revisionNo.toString().padStart(2, "0")}-8def-1123456789ab`,
    projectId: PROJECT_ID,
    revisionNo,
    source,
    sourceHash: sha256(source),
    validity,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: {
      errors: validity === "INVALID" ? 1 : 0,
      warnings: 0,
      infos: 0,
      parserVersion: "9.1.1",
    },
    createdAt: CREATED_AT,
  };
}

function invalidDiagnostic(source: string) {
  const lines = source.split(/\r\n|\r|\n/);
  return {
    code: "DBML_PARSE_SYNTAX_UNEXPECTED_TOKEN",
    message: "A closing brace is required.",
    severity: "ERROR" as const,
    range: {
      filepath: "/main.dbml",
      startOffset: source.length,
      endOffset: source.length,
      startLine: lines.length,
      startColumn: (lines.at(-1)?.length ?? 0) + 1,
      endLine: lines.length,
      endColumn: (lines.at(-1)?.length ?? 0) + 1,
    },
  };
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
