import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

import { createControlledLayoutApi } from "./controlled-layout-api.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-8123456789ab";
const CREATED_AT = "2026-08-30T01:02:03.004Z";
const INITIAL_SOURCE = `Table public.users {
  id bigint [pk]
}

Table public.teams {
  id bigint [pk]
}
`;
const SOURCE_WITH_EMAIL = `Table public.users {
  id bigint [pk]
  email varchar
}

Table public.teams {
  id bigint [pk]
}
`;
const SOURCE_WITH_PHONE = `Table public.users {
  id bigint [pk]
  email varchar
  phone varchar
}

Table public.teams {
  id bigint [pk]
}
`;
const INVALID_SOURCE = `Table public.users {
  id bigint [pk]
  email varchar
`;

test("unifies source and visual revisions while keeping restore durable", async ({ page }) => {
  test.setTimeout(180_000);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const api = await installHistoryApi(page);

  await page.goto(`/projects/${PROJECT_ID}`);
  await waitForWorkspace(page);
  const undo = page.getByRole("button", { name: /Undo schema change/ });
  const redo = page.getByRole("button", { name: /Redo schema change/ });
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();

  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const editor = page.getByRole("textbox", { name: "DBML source editor" });
  await replaceEditorSource(page, SOURCE_WITH_EMAIL, false);
  await editor.press(`${modifier}+z`);
  await expect.poll(() => api.draftWrites.length).toBe(2);
  await expect.poll(() => api.currentSource()).toBe(INITIAL_SOURCE);
  await expect(redo).toHaveAttribute("aria-label", "Redo schema change, 1 step available");
  await redo.click();
  await expect.poll(() => api.currentSource()).toBe(SOURCE_WITH_EMAIL);
  await expect(undo).toHaveAttribute("aria-label", "Undo schema change, 1 step available");

  const usersNode = page.locator('.react-flow__node-table[data-id*="users"]');
  await expect(usersNode).toBeVisible();
  const oldTableKey = await usersNode.getAttribute("data-id");
  if (!oldTableKey) throw new Error("Missing users table stable key.");
  const writesBeforeLayout = api.layouts.writes.length;
  await page.getByRole("button", { name: "Reset layout" }).click();
  const resetDialog = page.getByRole("dialog", { name: "Reset this view layout?" });
  await expect(resetDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await resetDialog.getByRole("button", { name: "Reset this view" }).click();
  await expect
    .poll(
      () =>
        api.layouts.writes
          .slice(writesBeforeLayout)
          .some((write) => layoutPositions(write.command)[oldTableKey] !== undefined),
      { timeout: 10_000 },
    )
    .toBe(true);
  await expect(undo).toHaveAttribute("aria-label", "Undo schema change, 1 step available");
  const oldPosition = [...api.layouts.writes]
    .reverse()
    .map((write) => layoutPositions(write.command)[oldTableKey])
    .find((position) => position !== undefined);
  if (!oldPosition) {
    throw new Error(
      `The dragged table position was not persisted for ${oldTableKey}. Stored keys: ${api.layouts.writes
        .flatMap((write) => Object.keys(layoutPositions(write.command)))
        .join(", ")}`,
    );
  }
  const layoutRevisionBeforeRename = api.layouts.currentRevisionNo;

  await selectTableInOutline(page, "public.users");
  await page.getByRole("button", { name: "Rename table" }).click();
  await page.getByLabel("New table name").fill("accounts");
  await page.getByRole("button", { name: "Apply command" }).click();
  await expect.poll(() => api.visualCommands.length).toBe(1);
  await expect(page.getByRole("region", { name: "Schema outline" })).toContainText(
    "public.accounts",
    { timeout: 20_000 },
  );
  await expect.poll(() => api.currentSource()).toContain("Table public.accounts");
  await expect(undo).toHaveAttribute("aria-label", "Undo schema change, 2 steps available");

  const migratedRow = api.layouts.rows.get("GLOBAL") as
    | { positions?: Record<string, { x: number; y: number }> }
    | undefined;
  const newTableKey = oldTableKey.replace("users", "accounts");
  expect(migratedRow?.positions?.[oldTableKey]).toEqual(oldPosition);
  expect(migratedRow?.positions?.[newTableKey]).toEqual(oldPosition);
  expect(api.layouts.currentRevisionNo).toBe(layoutRevisionBeforeRename + 1);

  const layoutWritesBeforeFirstUndo = api.layouts.writes.length;
  await editor.focus();
  await editor.press(`${modifier}+z`);
  await expect.poll(() => api.currentSource()).toBe(SOURCE_WITH_EMAIL);
  await expect(redo).toHaveAttribute("aria-label", "Redo schema change, 1 step available");
  expect(api.layouts.writes).toHaveLength(layoutWritesBeforeFirstUndo);

  const detailSelector = page.getByRole("combobox", { name: "Detail level" });
  await detailSelector.selectOption("NAME_ONLY");
  await expect.poll(() => api.layouts.writes.length).toBeGreaterThan(layoutWritesBeforeFirstUndo);
  await expect(redo).toHaveAttribute("aria-label", "Redo schema change, 1 step available");
  const writesAfterNameOnly = api.layouts.writes.length;
  await detailSelector.selectOption("FULL");
  await expect.poll(() => api.layouts.writes.length).toBeGreaterThan(writesAfterNameOnly);
  await expect(redo).toHaveAttribute("aria-label", "Redo schema change, 1 step available");
  const layoutWritesBeforeRemainingHistory = api.layouts.writes.length;

  const diagramNode = page.locator(".react-flow__node-table").first();
  await diagramNode.press(`${modifier}+z`);
  await expect.poll(() => api.currentSource()).toBe(INITIAL_SOURCE);
  await expect(undo).toBeDisabled();
  await expect(redo).toHaveAttribute("aria-label", "Redo schema change, 2 steps available");

  await diagramNode.press(`${modifier}+Shift+z`);
  await expect.poll(() => api.currentSource()).toBe(SOURCE_WITH_EMAIL);
  await diagramNode.press(`${modifier}+y`);
  await expect.poll(() => api.currentSource()).toContain("Table public.accounts");
  await expect(redo).toBeDisabled();

  await editor.focus();
  await editor.press(`${modifier}+z`);
  await expect.poll(() => api.currentSource()).toBe(SOURCE_WITH_EMAIL);
  await replaceEditorSource(page, SOURCE_WITH_PHONE);
  await expect.poll(() => api.currentSource()).toBe(SOURCE_WITH_PHONE);
  await expect(redo).toBeDisabled();

  await replaceEditorSource(page, INVALID_SOURCE);
  await expect.poll(() => api.currentValidity()).toBe("INVALID");
  await expect(page.getByText(/Showing last-valid revision/)).toBeVisible({ timeout: 20_000 });
  expect(api.lastValidSource()).toBe(SOURCE_WITH_PHONE);
  await expect(page.getByRole("region", { name: "Schema outline" })).toContainText("phone");
  const invalidRevisionNo = api.revisions[0]?.revisionNo;
  if (!invalidRevisionNo) throw new Error("Missing invalid revision.");
  await undo.click();
  await expect.poll(() => api.currentSource()).toBe(SOURCE_WITH_PHONE);
  await expect(page.getByText("Showing the current valid draft.", { exact: false })).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole("button", { name: "Revision history" }).click();
  const history = page.getByRole("dialog", { name: "Revision history" });
  const invalidRevision = history.getByRole("article", {
    name: `Revision ${invalidRevisionNo}`,
    exact: true,
  });
  await invalidRevision
    .getByRole("button", { name: `Restore revision ${invalidRevisionNo}`, exact: true })
    .click();
  const invalidConfirmation = page.getByRole("dialog", {
    name: `Restore revision ${invalidRevisionNo}?`,
  });
  await expect(invalidConfirmation.getByText(/This revision is invalid/)).toBeVisible();
  await invalidConfirmation
    .getByRole("button", { name: `Restore revision ${invalidRevisionNo}`, exact: true })
    .click();
  await expect.poll(() => api.currentValidity()).toBe("INVALID");
  expect(api.lastValidSource()).toBe(SOURCE_WITH_PHONE);
  await expect(page.getByText(/Showing last-valid revision/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Schema outline" })).toContainText("phone");
  expect(api.revisions[0]?.origin).toBe("RESTORE");
  await history.getByRole("button", { name: "Close history" }).click();
  await undo.click();
  await expect.poll(() => api.currentSource()).toBe(SOURCE_WITH_PHONE);

  await page.getByRole("button", { name: "Revision history" }).click();
  const reopenedHistory = page.getByRole("dialog", { name: "Revision history" });
  await expect(
    reopenedHistory.getByRole("article", { name: "Revision 1", exact: true }),
  ).toBeVisible();
  await reopenedHistory.getByRole("button", { name: "Restore revision 1", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Restore revision 1?" });
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  const beforeModalShortcut = api.currentSource();
  await page.keyboard.press(`${modifier}+z`);
  expect(api.currentSource()).toBe(beforeModalShortcut);
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await reopenedHistory.getByRole("button", { name: "Restore revision 1", exact: true }).click();
  await confirmation.getByRole("button", { name: "Restore revision 1", exact: true }).click();
  await expect.poll(() => api.currentSource()).toBe(INITIAL_SOURCE);
  expect(api.revisions[0]?.origin).toBe("RESTORE");
  await reopenedHistory.getByRole("button", { name: "Close history" }).click();
  await expect(undo).toBeEnabled();

  await page.reload();
  await waitForWorkspace(page);
  await expect(page.getByRole("button", { name: /Undo schema change/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Redo schema change/ })).toBeDisabled();
  await page.getByRole("button", { name: "Revision history" }).click();
  const reloadedHistory = page.getByRole("dialog", { name: "Revision history" });
  const currentRevisionNo = api.revisions[0]?.revisionNo;
  if (!currentRevisionNo) throw new Error("Missing restored revision.");
  await expect(
    reloadedHistory.getByRole("article", { name: `Revision ${currentRevisionNo}` }),
  ).toContainText("RESTORE");
  await expect(
    reloadedHistory
      .getByRole("article", { name: `Revision ${currentRevisionNo}` })
      .getByRole("button", { name: "Current revision" }),
  ).toBeDisabled();

  expect(api.layouts.writes).toHaveLength(layoutWritesBeforeRemainingHistory);
  expect(browserErrors).toEqual([]);
});

async function installHistoryApi(page: Page) {
  const layouts = createControlledLayoutApi(PROJECT_ID);
  const revisions: Revision[] = [revision(INITIAL_SOURCE, 1, "VALID", "SOURCE_EDIT")];
  const draftWrites: Array<Record<string, unknown>> = [];
  const visualCommands: Array<Record<string, unknown>> = [];
  let state = projectState(revisions[0] as Revision, revisions[0] as Revision, 0);

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
      state = withLayoutRevision(state, layouts.currentRevisionNo);
      return;
    }
    if (method === "GET" && pathname === "/api/v1/projects") {
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ projects: [projectSummary(state)] }),
      });
      return;
    }
    if (method === "GET" && pathname === `/api/v1/projects/${PROJECT_ID}`) {
      state = withLayoutRevision(state, layouts.currentRevisionNo);
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ state }) });
      return;
    }
    if (method === "GET" && pathname === `/api/v1/projects/${PROJECT_ID}/revisions`) {
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ revisions: revisions.map(revisionSummary) }),
      });
      return;
    }
    if (method === "PUT" && pathname === `/api/v1/projects/${PROJECT_ID}/draft`) {
      if (!command || typeof command.source !== "string") throw new Error("Missing draft source.");
      assertExpectedRevision(command, state);
      draftWrites.push(structuredClone(command));
      if (command.source === state.project.draftSource) {
        await route.fulfill({
          status: 200,
          headers,
          body: JSON.stringify({ state, diagnostics: [], revisionCreated: false }),
        });
        return;
      }
      state = appendRevision(command.source, "SOURCE_EDIT");
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ state, diagnostics: [], revisionCreated: true }),
      });
      return;
    }
    if (method === "POST" && pathname === `/api/v1/projects/${PROJECT_ID}/visual-commands`) {
      if (!command) throw new Error("Missing visual command.");
      assertExpectedRevision(command, state);
      visualCommands.push(structuredClone(command));
      if (command.kind !== "RENAME_TABLE" || typeof command.newName !== "string") {
        throw new Error(`Unsupported visual command ${String(command.kind)}.`);
      }
      const targetKey = String(command.targetTableKey);
      const nextSource = state.project.draftSource.replace(
        "public.users",
        `public.${command.newName}`,
      );
      const previousHash = state.project.draftHash;
      state = appendRevision(nextSource, "VISUAL_COMMAND");
      const layoutMigrated = migrateLayoutTableKey(
        layouts,
        targetKey,
        targetKey.replace("users", command.newName),
        previousHash,
        state.project.draftHash,
      );
      state = withLayoutRevision(state, layouts.currentRevisionNo);
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({
          state,
          revisionCreated: true,
          layoutMigrated,
          replayed: false,
          appliedSchemaRevisionNo: state.project.schemaRevisionNo,
          appliedLayoutRevisionNo: state.project.layoutRevisionNo,
        }),
      });
      return;
    }
    const restoreMatch = pathname.match(
      new RegExp(`^/api/v1/projects/${PROJECT_ID}/revisions/(\\d+)/restore$`),
    );
    if (method === "POST" && restoreMatch?.[1]) {
      if (!command) throw new Error("Missing restore command.");
      assertExpectedRevision(command, state);
      const target = revisions.find(
        (candidate) => candidate.revisionNo === Number(restoreMatch[1]),
      );
      if (!target) throw new Error("Missing restore target.");
      state = appendRevision(target.source, "RESTORE", target.validity);
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ state, diagnostics: [], revisionCreated: true }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      headers,
      body: JSON.stringify({
        code: "PROJECT_NOT_FOUND",
        message: "Project not found.",
        correlationId: headers["x-correlation-id"],
      }),
    });
  });

  function appendRevision(
    source: string,
    origin: Revision["origin"],
    forcedValidity?: Revision["validity"],
  ) {
    const validity = forcedValidity ?? (source.trimEnd().endsWith("}") ? "VALID" : "INVALID");
    const latestRevision = revisions[0];
    if (!latestRevision) throw new Error("The controlled revision history is empty.");
    const next = revision(source, latestRevision.revisionNo + 1, validity, origin);
    revisions.unshift(next);
    const lastValid = validity === "VALID" ? next : state.lastValidRevision;
    return projectState(next, lastValid, layouts.currentRevisionNo);
  }

  return {
    layouts,
    revisions,
    draftWrites,
    visualCommands,
    currentSource: () => state.project.draftSource,
    currentValidity: () => state.currentRevision.validity,
    lastValidSource: () => state.lastValidRevision?.source ?? null,
  };
}

function migrateLayoutTableKey(
  layouts: ReturnType<typeof createControlledLayoutApi>,
  oldKey: string,
  newKey: string,
  beforeHash: string,
  afterHash: string,
): boolean {
  let changed = false;
  for (const [viewKey, value] of layouts.rows) {
    const row = structuredClone(value) as {
      positions: Record<string, { x: number; y: number }>;
      hiddenElementKeys: string[];
      baseSchemaHash: string;
      revisionNo: number;
    };
    const position = row.positions[oldKey];
    const hidden = row.hiddenElementKeys.includes(oldKey);
    if (!position && !hidden) continue;
    if (position && !row.positions[newKey]) row.positions[newKey] = { ...position };
    if (hidden && !row.hiddenElementKeys.includes(newKey)) row.hiddenElementKeys.push(newKey);
    if (row.baseSchemaHash === beforeHash) row.baseSchemaHash = afterHash;
    layouts.rows.set(viewKey, row);
    changed = true;
  }
  if (!changed) return false;
  layouts.advanceRevision();
  for (const [viewKey, value] of layouts.rows) {
    layouts.rows.set(viewKey, { ...value, revisionNo: layouts.currentRevisionNo });
  }
  return true;
}

async function waitForWorkspace(page: Page): Promise<void> {
  await expect(page.locator('section[aria-label="DBML source editor"] .monaco-editor')).toBeVisible(
    {
      timeout: 20_000,
    },
  );
  const status = page.getByTestId("base-diagram-layout-status");
  await expect(status).toHaveText("Diagram layout ready", { timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Schema history", exact: true })).toBeVisible();
}

async function replaceEditorSource(
  page: Page,
  source: string,
  waitForAutosave = true,
): Promise<void> {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const input = page.getByRole("textbox", { name: "DBML source editor" });
  await input.focus();
  await input.press(`${modifier}+a`);
  await input.evaluate((element, pastedSource) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pastedSource);
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    );
  }, source);
  if (waitForAutosave) await page.waitForTimeout(800);
}

async function selectTableInOutline(page: Page, name: string): Promise<void> {
  const outline = page.getByRole("region", { name: "Schema outline" });
  const details = outline.locator("details").filter({ hasText: name }).first();
  if (!(await details.getAttribute("open"))) await details.locator("summary").click();
  await details.getByRole("button", { name: `Focus ${name} in diagram` }).click();
}

function layoutPositions(command: Record<string, unknown> | undefined) {
  const layout = command?.layout as
    | { positions?: Record<string, { x: number; y: number }> }
    | undefined;
  return layout?.positions ?? {};
}

type Revision = ReturnType<typeof revision>;

function revision(
  source: string,
  revisionNo: number,
  validity: "VALID" | "INVALID",
  origin: "SOURCE_EDIT" | "VISUAL_COMMAND" | "RESTORE",
) {
  return {
    id: `019d3f4e-7b6c-7def-8abc-${revisionNo.toString(16).padStart(12, "0")}`,
    projectId: PROJECT_ID,
    revisionNo,
    source,
    sourceHash: sha256(source),
    validity,
    origin,
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

function projectState(
  currentRevision: Revision,
  lastValidRevision: Revision | null,
  layoutNo: number,
) {
  return {
    project: {
      id: PROJECT_ID,
      name: "Schema history workspace",
      primaryDialect: "POSTGRESQL" as const,
      draftSource: currentRevision.source,
      draftHash: currentRevision.sourceHash,
      lastValidRevisionId: lastValidRevision?.id ?? null,
      parserVersion: "9.1.1",
      schemaRevisionNo: currentRevision.revisionNo,
      layoutRevisionNo: layoutNo,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision,
    lastValidRevision,
  };
}

function withLayoutRevision(state: ReturnType<typeof projectState>, layoutRevisionNo: number) {
  return {
    ...state,
    project: { ...state.project, layoutRevisionNo },
  };
}

function revisionSummary(value: Revision) {
  const { source: _source, ...summary } = value;
  return summary;
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

function assertExpectedRevision(
  command: Record<string, unknown>,
  state: ReturnType<typeof projectState>,
) {
  if (command.expectedSchemaRevisionNo !== state.project.schemaRevisionNo) {
    throw new Error(
      `Expected revision ${String(command.expectedSchemaRevisionNo)}, current ${state.project.schemaRevisionNo}.`,
    );
  }
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
