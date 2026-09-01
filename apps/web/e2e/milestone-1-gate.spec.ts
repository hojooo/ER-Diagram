import { expect, type Locator, type Page, test } from "./test-fixture.js";
import {
  fixtureInventory,
  generateFidelityFixture,
  sha256FixtureSource,
} from "@er-diagram/test-fixtures";

import { createControlledLayoutApi } from "./controlled-layout-api.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-4123456789ab";
const CREATED_AT = "2026-08-28T01:02:03.004Z";
const SOURCE = generateFidelityFixture();
const INVALID_SUFFIX = "Table gate_broken {";
const INVALID_SOURCE = `${SOURCE}${INVALID_SUFFIX}`;
const GLOBAL_INVENTORY = `${fixtureInventory.fidelity.tables} tables · ${fixtureInventory.fidelity.tableGroups} groups · ${fixtureInventory.fidelity.references} relationships`;

test("M1-GATE explores the fidelity workspace without source loss and recovers an invalid draft", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const api = await installMilestoneOneApi(page);

  await page.goto(`/projects/${PROJECT_ID}`);
  const sourcePanel = page.getByText("Canonical DBML source").locator("xpath=ancestor::section[1]");
  const editor = page.getByRole("textbox", { name: "DBML source editor" });
  const outline = page.getByRole("region", { name: "Schema outline" });
  await expect(page.locator('section[aria-label="DBML source editor"] .monaco-editor')).toBeVisible(
    {
      timeout: 20_000,
    },
  );
  await expect(sourcePanel.getByTestId("validation-status")).toHaveText(/Draft valid/);
  await waitForLayoutReady(page);
  await expect(outline.getByText(GLOBAL_INVENTORY, { exact: true })).toBeVisible();

  const viewSelector = page.getByRole("combobox", { name: "Diagram view" });
  await expect(viewSelector.locator("option")).toHaveCount(
    fixtureInventory.fidelity.diagramViews + 1,
  );
  for (const viewName of [
    "full_schema",
    "focus_01",
    "focus_02",
    "focus_03",
    "focus_04",
    "focus_05",
    "focus_06",
  ]) {
    await expect(viewSelector.getByRole("option", { name: viewName })).toBeAttached();
  }

  await viewSelector.selectOption({ label: "full_schema" });
  await waitForLayoutReady(page);
  await expect(outline.getByText(GLOBAL_INVENTORY, { exact: true })).toBeVisible();
  await viewSelector.selectOption({ label: "focus_01" });
  await waitForLayoutReady(page);
  await expect(outline.getByRole("heading", { name: "Schema outline · focus_01" })).toBeVisible();
  await viewSelector.selectOption("GLOBAL");
  await waitForLayoutReady(page);

  const detailSelector = page.getByRole("combobox", { name: "Detail level" });
  for (const detailLevel of ["KEYS_ONLY", "NAME_ONLY", "FULL"] as const) {
    await detailSelector.selectOption(detailLevel);
    await expect(detailSelector).toHaveValue(detailLevel);
    await waitForLayoutReady(page);
  }

  const search = page.getByRole("combobox", { name: "Search current view" });
  await activateSearchResult(page, search, "entity_142", "table core.entity_142");
  await expect(
    outline.getByRole("button", { name: "Focus core.entity_142 in diagram" }),
  ).toHaveAttribute("aria-current", "true");
  await activateSearchResult(
    page,
    search,
    "parent_tenant_id",
    "column core.entity_002.parent_tenant_id in core.entity_002",
  );
  await expect(
    outline.getByRole("button", { name: "Focus column parent_tenant_id in diagram" }),
  ).toHaveAttribute("aria-current", "true");
  await activateSearchResult(page, search, "domain_14", "group public.domain_14");
  await expect(
    outline.getByRole("button", { name: "Focus group public.domain_14 in diagram" }),
  ).toHaveAttribute("aria-current", "true");
  await activateSearchResult(page, search, "catalog", "schema catalog");
  await expect(search).toHaveAttribute("aria-expanded", "false");

  for (let groupIndex = 0; groupIndex < fixtureInventory.fidelity.tableGroups; groupIndex += 1) {
    const groupName = `public.domain_${groupIndex.toString().padStart(2, "0")}`;
    await outline
      .locator(`button[aria-label="Collapse ${groupName} in diagram"]`)
      .click({ timeout: 10_000 });
  }
  for (let groupIndex = 0; groupIndex < fixtureInventory.fidelity.tableGroups; groupIndex += 1) {
    const groupName = `public.domain_${groupIndex.toString().padStart(2, "0")}`;
    await expect(
      outline.locator(`button[aria-label="Expand ${groupName} in diagram"]`),
    ).toHaveAttribute("aria-expanded", "false");
  }
  await waitForLayoutReady(page);
  for (let groupIndex = 0; groupIndex < fixtureInventory.fidelity.tableGroups; groupIndex += 1) {
    const groupName = `public.domain_${groupIndex.toString().padStart(2, "0")}`;
    await outline
      .locator(`button[aria-label="Expand ${groupName} in diagram"]`)
      .click({ timeout: 10_000 });
  }
  await waitForLayoutReady(page);

  await activateSearchResult(page, search, "entity_142", "table core.entity_142");
  const selectedTable = outline
    .getByRole("button", { name: "Focus core.entity_142 in diagram" })
    .locator("xpath=ancestor::details[1]");
  await selectedTable
    .locator('button[aria-label^="Open source for table at line"]')
    .click({ timeout: 10_000 });
  await expect(editor).toBeFocused();
  await page.waitForTimeout(700);
  expect(api.draftWrites).toHaveLength(0);
  expect(api.state.project.draftHash).toBe(sha256FixtureSource(SOURCE));
  expect(api.state.project.schemaRevisionNo).toBe(1);

  await appendEditorSource(editor, INVALID_SUFFIX);
  await expect.poll(() => api.draftWrites.length).toBe(1);
  expect(api.draftWrites[0]).toMatchObject({
    source: INVALID_SOURCE,
    expectedSchemaRevisionNo: 1,
  });
  await expect(sourcePanel.getByTestId("validation-status")).toHaveText(/Draft invalid/);
  await expect(page.getByText(/Showing last-valid revision 1/)).toBeVisible();
  await expect(outline.getByText(GLOBAL_INVENTORY, { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.locator('section[aria-label="DBML source editor"] .monaco-editor')).toBeVisible(
    {
      timeout: 20_000,
    },
  );
  await expect(sourcePanel.getByTestId("validation-status")).toHaveText(/Draft invalid/);
  await expect(page.getByText(/Showing last-valid revision 1/)).toBeVisible();
  await waitForLayoutReady(page);
  await expect(outline.getByText(GLOBAL_INVENTORY, { exact: true })).toBeVisible();
  await expect(
    outline.locator('button[aria-label^="Open source for table at line"]').first(),
  ).toBeDisabled();
  expect(api.state.project.draftSource).toBe(INVALID_SOURCE);
  expect(api.state.project.draftHash).toBe(sha256FixtureSource(INVALID_SOURCE));

  await replaceEditorSource(editor, SOURCE);
  await expect.poll(() => api.draftWrites.length).toBe(2);
  expect(api.draftWrites[1]).toMatchObject({
    source: SOURCE,
    expectedSchemaRevisionNo: 2,
  });
  await expect(sourcePanel.getByTestId("validation-status")).toHaveText(/Draft valid/);
  await expect(page.getByText(/Showing the current valid draft/)).toBeVisible();
  await waitForLayoutReady(page);
  expect(api.state.project.draftSource).toBe(SOURCE);
  expect(api.state.project.draftHash).toBe(sha256FixtureSource(SOURCE));
  expect(api.state.project.schemaRevisionNo).toBe(3);
  expect(browserErrors).toEqual([]);
});

async function activateSearchResult(
  page: Page,
  search: Locator,
  query: string,
  accessibleName: string,
): Promise<void> {
  await search.fill(query);
  const option = page.getByRole("option", { name: accessibleName, exact: true });
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click({ timeout: 10_000 });
}

async function waitForLayoutReady(page: Page): Promise<void> {
  await expect(page.getByTestId("base-diagram-layout-status")).toHaveText("Diagram layout ready", {
    timeout: 30_000,
  });
}

async function appendEditorSource(editor: Locator, source: string): Promise<void> {
  await editor.focus();
  await editor.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await pasteSource(editor, source);
  await editor.page().waitForTimeout(800);
}

async function replaceEditorSource(editor: Locator, source: string): Promise<void> {
  await editor.focus();
  await editor.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await pasteSource(editor, source);
  await editor.page().waitForTimeout(800);
}

async function pasteSource(editor: Locator, source: string): Promise<void> {
  await editor.evaluate((element, pastedSource) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pastedSource);
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    );
  }, source);
}

async function installMilestoneOneApi(page: Page) {
  let state = projectState(SOURCE, 1, "VALID", null, 0);
  const draftWrites: Array<Record<string, unknown>> = [];
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

    if (await layouts.fulfillIfMatched({ route, pathname, method, command, headers })) {
      state = {
        ...state,
        project: { ...state.project, layoutRevisionNo: layouts.currentRevisionNo },
      };
      return;
    }
    if (method === "GET" && pathname === `/api/v1/projects/${PROJECT_ID}`) {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ state }) });
      return;
    }
    if (method === "PUT" && pathname === `/api/v1/projects/${PROJECT_ID}/draft`) {
      if (!command || typeof command.source !== "string") throw new Error("Missing source.");
      draftWrites.push(structuredClone(command));
      const validity = command.source === SOURCE ? "VALID" : "INVALID";
      const previousLastValid = state.lastValidRevision;
      state = projectState(
        command.source,
        state.project.schemaRevisionNo + 1,
        validity,
        previousLastValid,
        layouts.currentRevisionNo,
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

  return {
    draftWrites,
    layouts,
    get state() {
      return state;
    },
  };
}

function projectState(
  source: string,
  revisionNo: number,
  validity: "VALID" | "INVALID",
  previousLastValid: ReturnType<typeof revision> | null,
  layoutRevisionNo: number,
) {
  const currentRevision = revision(source, revisionNo, validity);
  const lastValidRevision = validity === "VALID" ? currentRevision : previousLastValid;
  return {
    project: {
      id: PROJECT_ID,
      name: "M1 fidelity gate",
      primaryDialect: "POSTGRESQL" as const,
      draftSource: source,
      draftHash: sha256FixtureSource(source),
      lastValidRevisionId: lastValidRevision?.id ?? null,
      parserVersion: "9.1.1",
      schemaRevisionNo: revisionNo,
      layoutRevisionNo,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision,
    lastValidRevision,
  };
}

function revision(source: string, revisionNo: number, validity: "VALID" | "INVALID") {
  return {
    id: `019d3f4e-7b6c-7a${revisionNo.toString().padStart(2, "0")}-8def-4123456789ab`,
    projectId: PROJECT_ID,
    revisionNo,
    source,
    sourceHash: sha256FixtureSource(source),
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
