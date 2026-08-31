import { createHash } from "node:crypto";
import { expect, type Page, test } from "./test-fixture.js";

import { createControlledLayoutApi } from "./controlled-layout-api.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const CREATED_AT = "2026-08-27T01:02:03.004Z";
const INITIAL_SOURCE = "Table users {\n  id int [pk]\n}\n";
const INVALID_SOURCE = "Table users {\n  id int [pk]\n";
const RECOVERED_SOURCE = "Table users {\n  id int [pk]\n  email varchar\n}\n";

test("validates and autosaves Monaco source with revision-safe recovery", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const api = await installSourceApi(page);

  await page.goto(`/projects/${PROJECT_ID}`);
  const sourcePanel = page.getByText("Canonical DBML source").locator("xpath=ancestor::section[1]");
  const editor = page.locator('section[aria-label="DBML source editor"] .monaco-editor');
  await expect(editor).toBeVisible();
  await expect(sourcePanel.getByTestId("validation-status")).toHaveText(/Draft valid/);
  await expect(sourcePanel.getByTestId("persistence-status")).toHaveText(/Saved/);
  await replaceEditorSource(page, INVALID_SOURCE);
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0]).toMatchObject({
    source: INVALID_SOURCE,
    expectedSchemaRevisionNo: 1,
  });
  await expect(sourcePanel.getByTestId("validation-status")).toHaveText(/Draft invalid/);
  await expect(sourcePanel.getByTestId("persistence-status")).toHaveText(/Saved/);
  await page.getByRole("button", { name: "Go to DBML_PARSE_SYNTAX_UNEXPECTED_TOKEN" }).click();
  await expect(page.getByRole("textbox", { name: "DBML source editor" })).toBeFocused();

  await appendEditorSource(page, "  email varchar\n}\n");
  await expect.poll(() => api.writes.length).toBe(2);
  expect(api.writes[1]).toMatchObject({
    source: RECOVERED_SOURCE,
    expectedSchemaRevisionNo: 2,
  });
  await expect(sourcePanel.getByTestId("validation-status")).toHaveText(/Draft valid/);
  await expect(
    page.getByText("Schema revision", { exact: true }).locator("xpath=following-sibling::dd"),
  ).toHaveText("3");

  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await editor.click();
  await page.keyboard.press(`${modifier}+f`);
  const findInput = page.getByRole("textbox", { name: "Find" });
  await expect(findInput).toBeVisible();
  await findInput.fill("email");
  await page.keyboard.press("Escape");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+f" : "Control+h");
  await expect(page.getByRole("textbox", { name: "Replace" })).toBeVisible();
  await page.keyboard.press("Escape");

  api.holdNextSave();
  await appendEditorSource(page, "// local unsaved note\n", false);
  await page.getByRole("link", { name: "Back to projects" }).click();
  const leaveDialog = page.getByRole("dialog", { name: "Leave schema workspace?" });
  await expect(leaveDialog).toBeVisible();
  await expect(leaveDialog.getByRole("button", { name: "Stay" })).toBeFocused();
  await leaveDialog.getByRole("button", { name: "Stay" }).click();
  await expect(page).toHaveURL(`/projects/${PROJECT_ID}`);
  await expect.poll(() => api.writes.length).toBe(3);
  await api.releaseSave();
  await expect(sourcePanel.getByTestId("persistence-status")).toHaveText(/Saved/, {
    timeout: 10_000,
  });

  await page.getByRole("link", { name: "Back to projects" }).click();
  await expect(page).toHaveURL("/");
  expect(browserErrors).toEqual([]);
});

async function replaceEditorSource(
  page: Page,
  source: string,
  waitForAutosave = true,
): Promise<void> {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const input = page.getByRole("textbox", { name: "DBML source editor" });
  await input.focus();
  await input.press(`${modifier}+a`);
  await pasteSource(input, source);
  if (waitForAutosave) await page.waitForTimeout(800);
}

async function appendEditorSource(
  page: Page,
  source: string,
  waitForAutosave = true,
): Promise<void> {
  const input = page.getByRole("textbox", { name: "DBML source editor" });
  await input.focus();
  await input.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await pasteSource(input, source);
  if (waitForAutosave) await page.waitForTimeout(800);
}

async function pasteSource(input: ReturnType<Page["getByRole"]>, source: string): Promise<void> {
  await input.evaluate((element, pastedSource) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pastedSource);
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    );
  }, source);
}

async function installSourceApi(page: Page) {
  let state = projectState(INITIAL_SOURCE, 1, "VALID", null);
  const writes: Array<Record<string, unknown>> = [];
  const layouts = createControlledLayoutApi(PROJECT_ID);
  let shouldHoldNextSave = false;
  let releasePendingSave: (() => void) | undefined;
  let pendingSaveCompleted: Promise<void> | undefined;
  let completePendingSave: (() => void) | undefined;

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

    if (method === "GET" && pathname === "/api/v1/projects") {
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ projects: [projectSummary(state)] }),
      });
      return;
    }
    if (method === "GET" && pathname === `/api/v1/projects/${PROJECT_ID}`) {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ state }) });
      return;
    }
    if (method === "PUT" && pathname === `/api/v1/projects/${PROJECT_ID}/draft`) {
      if (!command || typeof command.source !== "string") throw new Error("Missing source.");
      writes.push(command);
      if (shouldHoldNextSave) {
        shouldHoldNextSave = false;
        pendingSaveCompleted = new Promise<void>((resolve) => {
          completePendingSave = resolve;
        });
        await new Promise<void>((resolve) => {
          releasePendingSave = resolve;
        });
      }
      const validity = command.source.trimEnd().endsWith("}") ? "VALID" : "INVALID";
      const previousLastValid = state.lastValidRevision;
      state = projectState(
        command.source,
        state.project.schemaRevisionNo + 1,
        validity,
        previousLastValid,
      );
      const diagnostics = validity === "INVALID" ? [invalidDiagnostic(command.source)] : [];
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ state, diagnostics, revisionCreated: true }),
      });
      completePendingSave?.();
      completePendingSave = undefined;
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

  return {
    writes,
    holdNextSave() {
      shouldHoldNextSave = true;
    },
    async releaseSave() {
      const completed = pendingSaveCompleted ?? Promise.resolve();
      releasePendingSave?.();
      releasePendingSave = undefined;
      await completed;
      pendingSaveCompleted = undefined;
    },
  };
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
      name: "Source workspace",
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
    id: `019d3f4e-7b6c-7a${revisionNo.toString().padStart(2, "0")}-8def-0123456789ab`,
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

function projectSummary(state: ReturnType<typeof projectState>) {
  return {
    id: state.project.id,
    name: state.project.name,
    primaryDialect: state.project.primaryDialect,
    parserVersion: state.project.parserVersion,
    schemaRevisionNo: state.project.schemaRevisionNo,
    layoutRevisionNo: state.project.layoutRevisionNo,
    draftValidity: state.currentRevision.validity,
    diagnosticSummary: state.currentRevision.diagnosticSummary,
    createdAt: state.project.createdAt,
    updatedAt: state.project.updatedAt,
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
