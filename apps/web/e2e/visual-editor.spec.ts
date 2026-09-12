import { createHash } from "node:crypto";
import { createControlledLayoutApi } from "./controlled-layout-api.js";
import { expect, type Page, test } from "./test-fixture.js";
import { openWorkspaceInspector, openWorkspaceTab } from "./workspace-panels.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-7123456789ab";
const CREATED_AT = "2026-08-30T01:02:03.004Z";
const SOURCE = `TablePartial audit_fields {
  created_at timestamp
}

Table public.users {
  id bigint [pk]
  team_id bigint
}

Table public.teams {
  id bigint [pk]
}

Table public.posts {
  ~audit_fields
  id bigint [pk]
}

Ref users_team: public.users.team_id > public.teams.id

TableGroup identity {
  public.users
  public.teams
}

DiagramView focus {
  Tables {
    public.users
    public.teams
  }
  TableGroups { identity }
  Schemas { public }
}
`;

test("applies inspector commands through authoritative state without a draft PUT", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const api = await installVisualCommandApi(page);

  await page.goto(`/projects/${PROJECT_ID}`);
  await expect(page.getByTestId("base-diagram-layout-status")).toHaveText("Diagram layout ready", {
    timeout: 20_000,
  });
  await openWorkspaceInspector(page);
  await expect(page.getByTestId("workspace-inspector-scroll")).toBeVisible();

  await page.getByRole("button", { name: "Create table" }).click();
  await page.getByLabel("Table name").fill("audit_log");
  await page.getByLabel("Column name").fill("id");
  await page.getByLabel("Primary key").check();
  await page.getByRole("button", { name: "Apply command" }).click();

  await expect.poll(() => api.commands.length).toBe(1);
  expect(api.commands[0]).toMatchObject({
    kind: "CREATE_TABLE",
    expectedSchemaRevisionNo: 1,
  });
  await expect(page.getByText("Selected table public.audit_log")).toBeVisible({ timeout: 20_000 });
  await openWorkspaceTab(page, "Outline");
  await expect(
    page.locator("#workspace-outline-surface").getByRole("button", {
      name: "Focus public.audit_log in diagram",
    }),
  ).toBeVisible();
  await openWorkspaceTab(page, "Source");
  await expectEditorContains(page, "Table public.audit_log");

  await page.getByRole("button", { name: "Create column" }).click();
  await page.getByLabel("Column name").fill("event_name");
  await page.getByLabel("DBML column type").fill("varchar(120)");
  await page.getByRole("button", { name: "Apply command" }).click();
  await expect.poll(() => api.commands.length).toBe(2);
  expect(api.commands[1]).toMatchObject({
    kind: "CREATE_COLUMN",
    expectedSchemaRevisionNo: 2,
    column: { name: "event_name", type: "varchar(120)" },
  });
  await openWorkspaceTab(page, "Outline");
  await expect(
    page.locator("#workspace-outline-surface").getByRole("button", {
      name: "Focus column event_name in diagram",
    }),
  ).toBeVisible({
    timeout: 20_000,
  });

  const outline = page.locator("#workspace-outline-surface");
  await outline.locator("summary").filter({ hasText: "public.posts" }).click();
  await outline.getByRole("button", { name: "Focus public.posts in diagram" }).click();
  await outline.getByRole("button", { name: "Focus column created_at in diagram" }).click();
  await expect(page.getByText("Partial audit_fields owns this element")).toBeVisible();
  await page.getByRole("button", { name: "Open partial definition" }).click();
  await expect(page.getByRole("textbox", { name: "DBML source editor" })).toBeFocused();

  expect(api.draftWrites).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("opens the atomic column editor from the canvas above the workspace tools", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const api = await installVisualCommandApi(page);

  await page.goto(`/projects/${PROJECT_ID}`);
  await expect(page.getByTestId("base-diagram-layout-status")).toHaveText("Diagram layout ready", {
    timeout: 20_000,
  });

  const users = page.getByRole("article", { name: "Table public.users" });
  await users.getByRole("button", { name: /id, bigint, PK/ }).dblclick();

  const editor = page.getByTestId("canvas-column-inline-editor");
  const nameInput = editor.getByLabel("Column name");
  await expect(editor).toBeVisible();
  await expect(nameInput).toBeFocused();
  const [editorBox, toolsBox, inputBox] = await Promise.all([
    editor.boundingBox(),
    page.getByTestId("workspace-right-tool-dock").boundingBox(),
    nameInput.boundingBox(),
  ]);
  expect(editorBox).not.toBeNull();
  expect(toolsBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  if (!editorBox || !toolsBox || !inputBox) throw new Error("Missing workspace geometry.");
  expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(toolsBox.x);
  const inputReceivesPointer = await nameInput.evaluate(
    (input, { x, y }) => document.elementFromPoint(x, y) === input,
    { x: inputBox.x + inputBox.width / 2, y: inputBox.y + inputBox.height / 2 },
  );
  expect(inputReceivesPointer).toBe(true);

  await nameInput.fill("user_id");
  await editor.getByRole("button", { name: "Apply command" }).click();
  await expect.poll(() => api.commands.length).toBe(1);
  expect(api.commands[0]).toMatchObject({
    kind: "ALTER_COLUMN",
    newName: "user_id",
    expectedSchemaRevisionNo: 1,
  });
  await expect(editor).toBeHidden({ timeout: 20_000 });
  await expect(
    page
      .getByRole("article", { name: "Table public.users" })
      .getByRole("button", { name: /user_id, bigint, PK/ }),
  ).toBeVisible({ timeout: 20_000 });
  expect(api.draftWrites).toEqual([]);
  expect(browserErrors).toEqual([]);
});

async function installVisualCommandApi(page: Page) {
  let state = projectState(SOURCE, 1);
  const layouts = createControlledLayoutApi(PROJECT_ID);
  const commands: Array<Record<string, unknown>> = [];
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
    if (method === "GET" && pathname === "/api/v1/projects") {
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ projects: [summary(state)] }),
      });
      return;
    }
    if (method === "GET" && pathname === `/api/v1/projects/${PROJECT_ID}`) {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ state }) });
      return;
    }
    if (method === "PUT" && pathname === `/api/v1/projects/${PROJECT_ID}/draft`) {
      if (command) draftWrites.push(command);
      await route.fulfill({
        status: 500,
        headers,
        body: JSON.stringify({
          code: "UNEXPECTED_DRAFT_WRITE",
          message: "Visual commands must not create a draft PUT.",
          correlationId: headers["x-correlation-id"],
        }),
      });
      return;
    }
    if (method === "POST" && pathname === `/api/v1/projects/${PROJECT_ID}/visual-commands`) {
      if (!command) throw new Error("Missing visual command body.");
      commands.push(structuredClone(command));
      const source = applyControlledCommand(state.project.draftSource, command);
      state = projectState(source, state.project.schemaRevisionNo + 1);
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({
          state,
          revisionCreated: true,
          layoutMigrated: false,
          replayed: false,
          appliedSchemaRevisionNo: state.project.schemaRevisionNo,
          appliedLayoutRevisionNo: state.project.layoutRevisionNo,
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
        correlationId: headers["x-correlation-id"],
      }),
    });
  });
  return { commands, draftWrites };
}

async function expectEditorContains(page: Page, text: string): Promise<void> {
  const editor = page.getByRole("textbox", { name: "DBML source editor" });
  await editor.focus();
  await editor.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
  const findInput = page.getByRole("textbox", { name: "Find" });
  await findInput.fill(text);
  await expect(page.locator(".find-widget .matchesCount")).toHaveText("1 of 1");
  await page.keyboard.press("Escape");
}

function applyControlledCommand(source: string, command: Record<string, unknown>): string {
  if (command.kind === "CREATE_TABLE") {
    const table = command.table as {
      schemaName: string;
      name: string;
      columns: Array<{ name: string; type: string; primaryKey: boolean }>;
    };
    const columns = table.columns
      .map((column) => `  ${column.name} ${column.type}${column.primaryKey ? " [pk]" : ""}`)
      .join("\n");
    return `${source.trimEnd()}\n\nTable ${table.schemaName}.${table.name} {\n${columns}\n}\n`;
  }
  if (command.kind === "CREATE_COLUMN") {
    const column = command.column as { name: string; type: string };
    const marker = "Table public.audit_log {\n";
    return source.replace(marker, `${marker}  ${column.name} ${column.type}\n`);
  }
  if (command.kind === "ALTER_COLUMN") {
    const newName = typeof command.newName === "string" ? command.newName : "id";
    const changes = command.changes as { type?: string } | undefined;
    return source.replace("  id bigint [pk]", `  ${newName} ${changes?.type ?? "bigint"} [pk]`);
  }
  throw new Error(`Unsupported controlled visual command ${String(command.kind)}.`);
}

function projectState(source: string, revisionNo: number) {
  const currentRevision = revision(source, revisionNo);
  return {
    project: {
      id: PROJECT_ID,
      name: "Visual editor",
      primaryDialect: "POSTGRESQL" as const,
      draftSource: source,
      draftHash: sha256(source),
      lastValidRevisionId: currentRevision.id,
      parserVersion: "9.1.1",
      schemaRevisionNo: revisionNo,
      layoutRevisionNo: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision,
    lastValidRevision: currentRevision,
  };
}

function revision(source: string, revisionNo: number) {
  return {
    id: `019d3f4e-7b6c-7def-9abc-${String(revisionNo).padStart(12, "0")}`,
    projectId: PROJECT_ID,
    revisionNo,
    source,
    sourceHash: sha256(source),
    validity: "VALID" as const,
    origin: revisionNo === 1 ? ("SOURCE_EDIT" as const) : ("VISUAL_COMMAND" as const),
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
    createdAt: CREATED_AT,
  };
}

function summary(state: ReturnType<typeof projectState>) {
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
