import { createHash } from "node:crypto";
import { type Diagnostic, type VisualCommand, visualCommandSchema } from "@er-diagram/contracts";
import { parseDbmlV2 } from "@er-diagram/core";
import { transformVisualCommand } from "@er-diagram/source-transform";
import { expect, type Page, type Route, test } from "./test-fixture.js";

import { createControlledLayoutApi } from "./controlled-layout-api.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-9123456789ab";
const CREATED_AT = "2026-08-30T03:04:05.006Z";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const SOURCE_SENTINEL = "M3_GATE_UNRELATED_SENTINEL 😀";
const INITIAL_SOURCE = `// ${SOURCE_SENTINEL}
Project m3_gate {
  database_type: 'PostgreSQL'
  Note: 'M3 browser gate'
}

TablePartial audit_fields {
  created_at timestamp [not null]
}

Table public.users {
  ~audit_fields
  id bigint [pk]
  name varchar
  Note: 'keep users note'
}

Table public.posts {
  ~audit_fields
  id bigint [pk]
  user_id bigint
  title varchar
}

Table public.teams {
  id bigint [pk]
  label varchar
}

TableGroup Identity [color: #778899] {
  public.users
}

DiagramView focused {
  Tables {
    public.users
    public.posts
    public.teams
  }
  TableGroups {
    Identity
  }
  Schemas {
    public
  }
}
`;

test("M3-GATE applies representative source-preserving visual commands", async ({ page }) => {
  test.setTimeout(180_000);
  const browserErrors = collectBrowserErrors(page);
  const api = await installMilestoneThreeApi(page);

  await page.goto(`/projects/${PROJECT_ID}`);
  await waitForWorkspace(page);

  await page.getByRole("button", { name: "Create table" }).click();
  await page.getByLabel("Table name", { exact: true }).fill("audit_log");
  await page.getByLabel("Column name", { exact: true }).fill("id");
  await page.getByLabel("DBML column type", { exact: true }).fill("bigint");
  await page.getByLabel("Primary key", { exact: true }).check();
  await applyCommandAndWait(page, api, "CREATE_TABLE");
  await expect(page.getByText("Selected table public.audit_log")).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole("button", { name: "Create column" }).click();
  await page.getByLabel("Column name", { exact: true }).fill("event_name");
  await page.getByLabel("DBML column type", { exact: true }).fill("varchar(120)");
  await applyCommandAndWait(page, api, "CREATE_COLUMN");

  await page.getByRole("button", { name: "Rename column" }).click();
  await page.getByLabel("New column name").fill("event_type");
  await applyCommandAndWait(page, api, "RENAME_COLUMN");

  await page.getByRole("button", { name: "Create relationship from column" }).click();
  await page.getByLabel("Reference name").fill("audit_owner");
  await expect(page.getByRole("group", { name: "Endpoint 2" })).toContainText("public.users");
  await applyCommandAndWait(page, api, "CREATE_REFERENCE");

  await selectTableInDiagram(page, "public.audit_log");
  await page.getByRole("button", { name: "Create index" }).click();
  await page.getByLabel("Index name", { exact: true }).fill("audit_event_idx");
  await applyCommandAndWait(page, api, "CREATE_INDEX");

  await selectTableInDiagram(page, "public.audit_log");
  await page.getByRole("button", { name: "Create table check" }).click();
  await page.getByLabel("Check name", { exact: true }).fill("audit_positive");
  await page.getByLabel("Check expression", { exact: true }).fill("id > 0");
  await applyCommandAndWait(page, api, "CREATE_CHECK");

  const outline = page.getByRole("region", { name: "Schema outline" });
  const groupFocus = outline.getByRole("button", {
    name: "Focus group public.Identity in diagram",
  });
  await expect(groupFocus).toBeVisible({ timeout: 20_000 });
  await groupFocus.click();
  await page.getByRole("button", { name: "Update group membership" }).click();
  const membership = page.getByRole("group", { name: "Group member tables" });
  await membership.getByLabel("public.teams").check();
  await applyCommandAndWait(page, api, "UPDATE_GROUP_MEMBERSHIP");

  await selectViewContaining(page, "focused");
  await page.getByRole("button", { name: "Update current DiagramView" }).click();
  const tableVisibility = page.getByRole("group", { name: "Table visibility" });
  await tableVisibility.getByLabel("All").check();
  await applyCommandAndWait(page, api, "UPDATE_DIAGRAM_VIEW");

  expect(api.visualCommands.map((command) => command.kind)).toEqual([
    "CREATE_TABLE",
    "CREATE_COLUMN",
    "RENAME_COLUMN",
    "CREATE_REFERENCE",
    "CREATE_INDEX",
    "CREATE_CHECK",
    "UPDATE_GROUP_MEMBERSHIP",
    "UPDATE_DIAGRAM_VIEW",
  ]);
  expect(api.draftWrites).toEqual([]);
  expect(api.currentSource()).toContain(`// ${SOURCE_SENTINEL}`);
  expect(api.currentSource()).toContain("Note: 'keep users note'");
  expect(api.currentSource()).toContain("TablePartial audit_fields");
  expect(api.currentSource()).toContain("Table public.audit_log");
  expect(api.currentSource()).toContain("event_type varchar(120)");
  expect(api.currentSource()).toContain("audit_owner");
  expect(api.currentSource()).toContain("audit_event_idx");
  expect(api.currentSource()).toContain("audit_positive");

  await selectViewContaining(page, "Global");
  await selectColumnInOutline(page, "public.posts", "created_at");
  await expect(page.getByText("Partial audit_fields owns this element")).toBeVisible();
  const affectedTables = page.getByRole("list", { name: "Affected partial tables" });
  await expect(affectedTables.getByRole("button", { name: "Open table injection" })).toHaveCount(2);
  await affectedTables.getByRole("button", { name: "Open table injection" }).first().click();
  await expect(page.getByRole("textbox", { name: "DBML source editor" })).toBeFocused();
  await selectColumnInOutline(page, "public.posts", "created_at");
  await page.getByRole("button", { name: "Open partial definition" }).click();
  await expect(page.getByRole("textbox", { name: "DBML source editor" })).toBeFocused();

  expect(browserErrors).toEqual([]);
});

test("M3-GATE keeps source and visual history safe across replay, conflict, and reload", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const browserErrors = collectBrowserErrors(page, [
    /^Failed to load resource: the server responded with a status of 409 \(Conflict\)$/u,
  ]);
  const api = await installMilestoneThreeApi(page);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";

  await page.goto(`/projects/${PROJECT_ID}`);
  await waitForWorkspace(page);
  const undo = page.getByRole("button", { name: /Undo schema change/ });
  const redo = page.getByRole("button", { name: /Redo schema change/ });

  const sourceWithEmail = INITIAL_SOURCE.replace(
    "  name varchar\n",
    "  name varchar\n  email varchar\n",
  );
  await replaceEditorSource(page, sourceWithEmail);
  await expect.poll(api.currentSource).toBe(sourceWithEmail);

  await selectTableInOutline(page, "public.users");
  await page.getByRole("button", { name: "Update table" }).click();
  await page.getByLabel("Table note", { exact: true }).fill("visual history step");
  const commandsBeforeVisual = api.visualCommands.length;
  const draftsBeforeVisual = api.draftWrites.length;
  await applyCommandAndWait(page, api, "UPDATE_TABLE");
  expect(api.visualCommands).toHaveLength(commandsBeforeVisual + 1);
  expect(api.draftWrites).toHaveLength(draftsBeforeVisual);
  const sourceAfterVisual = api.currentSource();
  expect(sourceAfterVisual).toContain("visual history step");

  await undo.click();
  await expect.poll(api.currentSource).toBe(sourceWithEmail);
  await undo.click();
  await expect.poll(api.currentSource).toBe(INITIAL_SOURCE);
  await redo.click();
  await expect.poll(api.currentSource).toBe(sourceWithEmail);

  const layoutWritesBefore = api.layouts.writes.length;
  await page.getByRole("combobox", { name: "Detail level" }).selectOption("NAME_ONLY");
  await expect.poll(() => api.layouts.writes.length).toBeGreaterThan(layoutWritesBefore);
  await expect(redo).toHaveAttribute("aria-label", "Redo schema change, 1 step available");
  await redo.click();
  await expect.poll(api.currentSource).toBe(sourceAfterVisual);

  const invalidSource = `${api.currentSource()}\nTable public.broken {\n`;
  await replaceEditorSource(page, invalidSource);
  await expect.poll(api.currentValidity).toBe("INVALID");
  await expect(page.getByText(/Showing last-valid revision/)).toBeVisible({ timeout: 20_000 });
  const invalidRevisionNo = api.currentRevisionNo();
  await undo.click();
  await expect.poll(api.currentValidity).toBe("VALID");

  await selectTableInOutline(page, "public.users");
  await page.getByRole("button", { name: "Update table" }).click();
  await page.getByLabel("Table note", { exact: true }).fill("receipt replay step");
  api.loseNextVisualResponse();
  await page.getByRole("button", { name: "Apply command" }).click();
  await expect(page.getByRole("button", { name: "Retry safely" })).toBeVisible({
    timeout: 20_000,
  });
  const committedRevisionNo = api.currentRevisionNo();
  const firstAttempt = api.visualAttempts.at(-1);
  await page.getByRole("button", { name: "Retry safely" }).click();
  await expect(page.getByText(/receipt was replayed/i)).toBeVisible({ timeout: 20_000 });
  const replayAttempt = api.visualAttempts.at(-1);
  expect(firstAttempt?.commandId).toBe(replayAttempt?.commandId);
  expect(api.currentRevisionNo()).toBe(committedRevisionNo);

  await selectTableInOutline(page, "public.users");
  await page.getByRole("button", { name: "Update table" }).click();
  const note = page.getByLabel("Table note", { exact: true });
  const noteBeforeNativeUndo = await note.inputValue();
  await note.fill("native field draft");
  await note.press(`${modifier}+z`);
  await expect(note).toHaveValue(noteBeforeNativeUndo);
  const revisionBeforeConflict = api.currentRevisionNo();
  await note.fill("preserved after conflict");
  await api.commitExternalRevision();
  expect(api.currentSource()).toContain("receipt replay step");
  await page.getByRole("button", { name: "Apply command" }).click();
  await expect(page.getByRole("button", { name: "Review latest schema" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(note).toHaveValue("preserved after conflict");
  await expect(undo).toBeDisabled();
  const conflictAttempt = api.visualAttempts.at(-1);
  await page.getByRole("button", { name: "Review latest schema" }).click();
  await expect(note).toHaveValue("preserved after conflict");
  await page.getByRole("button", { name: "Apply command" }).click();
  await expect.poll(api.currentRevisionNo).toBeGreaterThan(revisionBeforeConflict + 1);
  const reviewedAttempt = api.visualAttempts.at(-1);
  expect(reviewedAttempt?.commandId).not.toBe(conflictAttempt?.commandId);

  await page.getByRole("button", { name: "Revision history" }).click();
  const history = page.getByRole("dialog", { name: "Revision history" });
  const invalidRow = history.getByRole("article", {
    name: `Revision ${invalidRevisionNo}`,
    exact: true,
  });
  await invalidRow
    .getByRole("button", { name: `Restore revision ${invalidRevisionNo}`, exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: `Restore revision ${invalidRevisionNo}?`,
  });
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(confirmation).toContainText("last-valid diagram remains available");
  await confirmation
    .getByRole("button", { name: `Restore revision ${invalidRevisionNo}`, exact: true })
    .click();
  await expect.poll(api.currentValidity).toBe("INVALID");
  expect(api.currentOrigin()).toBe("RESTORE");
  await history.getByRole("button", { name: "Close history" }).click();

  await page.reload();
  await waitForWorkspace(page);
  await expect(page.getByRole("button", { name: /Undo schema change/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Redo schema change/ })).toBeDisabled();
  await page.getByRole("button", { name: "Revision history" }).click();
  const durableHistory = page.getByRole("dialog", { name: "Revision history" });
  const currentNo = api.currentRevisionNo();
  const currentRow = durableHistory.getByRole("article", {
    name: `Revision ${currentNo}`,
    exact: true,
  });
  await expect(currentRow).toContainText("RESTORE");
  await expect(currentRow.getByRole("button", { name: "Current revision" })).toBeDisabled();
  await expect(durableHistory).not.toContainText(api.currentSource());

  expect(browserErrors).toEqual([]);
});

async function installMilestoneThreeApi(page: Page) {
  const layouts = createControlledLayoutApi(PROJECT_ID);
  const initialRevision = await createRevision(INITIAL_SOURCE, 1, "SOURCE_EDIT");
  if (initialRevision.validity !== "VALID") {
    throw new Error("The M3 browser gate fixture must be valid DBML.");
  }
  const revisions: Revision[] = [initialRevision];
  const receipts = new Map<string, VisualReceipt>();
  const visualCommands: VisualCommand[] = [];
  const visualAttempts: VisualCommand[] = [];
  const draftWrites: Array<Record<string, unknown>> = [];
  let state = projectState(initialRevision, initialRevision, 0);
  let dropNextVisualResponse = false;
  let externalRevisionCommitted = false;

  await page.route("**/api/v1/projects**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postDataJSON() as Record<string, unknown> | null;
    const commandId = typeof body?.commandId === "string" ? body.commandId : undefined;
    const headers = responseHeaders(commandId);

    if (await layouts.fulfillIfMatched({ route, pathname, method, command: body, headers })) {
      state = withLayoutRevision(state, layouts.currentRevisionNo);
      return;
    }
    if (method === "GET" && pathname === "/api/v1/projects") {
      await fulfillJson(route, 200, headers, { projects: [projectSummary(state)] });
      return;
    }
    if (method === "GET" && pathname === `/api/v1/projects/${PROJECT_ID}`) {
      state = withLayoutRevision(state, layouts.currentRevisionNo);
      await fulfillJson(route, 200, headers, { state });
      return;
    }
    if (method === "GET" && pathname === `/api/v1/projects/${PROJECT_ID}/revisions`) {
      await fulfillJson(route, 200, headers, {
        revisions: revisions.map(revisionSummary),
      });
      return;
    }
    if (method === "PUT" && pathname === `/api/v1/projects/${PROJECT_ID}/draft`) {
      if (!body || typeof body.source !== "string") {
        await fulfillError(route, headers, 400, "INVALID_DRAFT", "A draft source is required.");
        return;
      }
      if (!(await requireExpectedRevision(route, headers, body, state))) return;
      draftWrites.push(structuredClone(body));
      if (body.source === state.project.draftSource) {
        await fulfillJson(route, 200, headers, {
          state,
          diagnostics: [],
          revisionCreated: false,
        });
        return;
      }
      const mutation = await appendRevision(body.source, "SOURCE_EDIT");
      await fulfillJson(route, 200, headers, {
        state,
        diagnostics: mutation.diagnostics,
        revisionCreated: true,
      });
      return;
    }
    if (method === "POST" && pathname === `/api/v1/projects/${PROJECT_ID}/visual-commands`) {
      const parsed = visualCommandSchema.safeParse(body);
      if (!parsed.success) {
        await fulfillError(
          route,
          headers,
          400,
          "VISUAL_COMMAND_INVALID",
          "The visual command request is invalid.",
        );
        return;
      }
      const command = parsed.data;
      visualAttempts.push(structuredClone(command));
      const normalizedCommandId = command.commandId.toLowerCase();
      const serializedCommand = JSON.stringify(command);
      const receipt = receipts.get(normalizedCommandId);
      if (receipt) {
        if (receipt.serializedCommand !== serializedCommand) {
          await fulfillError(
            route,
            headers,
            409,
            "VISUAL_COMMAND_IDEMPOTENCY_CONFLICT",
            "This command ID was already used with a different payload.",
          );
          return;
        }
        await fulfillJson(route, 200, headers, {
          state,
          revisionCreated: receipt.revisionCreated,
          layoutMigrated: receipt.layoutMigrated,
          replayed: true,
          appliedSchemaRevisionNo: receipt.appliedSchemaRevisionNo,
          appliedLayoutRevisionNo: receipt.appliedLayoutRevisionNo,
        });
        return;
      }
      if (!(await requireExpectedRevision(route, headers, command, state))) return;
      if (state.currentRevision.validity !== "VALID") {
        await fulfillError(
          route,
          headers,
          422,
          "VISUAL_COMMAND_DRAFT_INVALID",
          "Visual commands require the current draft to be valid.",
        );
        return;
      }

      const transformed = await transformVisualCommand(
        state.project.draftSource,
        command,
        "/main.dbml",
      );
      if (!transformed.ok) {
        await fulfillJson(route, 422, headers, {
          code: "VISUAL_COMMAND_TRANSFORM_FAILED",
          message: "The visual command could not be applied safely.",
          correlationId: CORRELATION_ID,
          diagnostics: transformed.diagnostics.map(toPublicDiagnostic),
          ...(transformed.partialImpact
            ? { partialImpact: toPublicPartialImpact(transformed.partialImpact) }
            : {}),
        });
        return;
      }

      const appliedSchemaRevisionNo = transformed.changed
        ? state.project.schemaRevisionNo + 1
        : state.project.schemaRevisionNo;
      if (transformed.changed) {
        await appendRevision(transformed.source, "VISUAL_COMMAND", transformed.diagnostics);
      }
      state = withLayoutRevision(state, layouts.currentRevisionNo);
      const storedReceipt: VisualReceipt = {
        serializedCommand,
        revisionCreated: transformed.changed,
        layoutMigrated: false,
        appliedSchemaRevisionNo,
        appliedLayoutRevisionNo: state.project.layoutRevisionNo,
      };
      receipts.set(normalizedCommandId, storedReceipt);
      visualCommands.push(structuredClone(command));
      const response = {
        state,
        revisionCreated: storedReceipt.revisionCreated,
        layoutMigrated: storedReceipt.layoutMigrated,
        replayed: false,
        appliedSchemaRevisionNo: storedReceipt.appliedSchemaRevisionNo,
        appliedLayoutRevisionNo: storedReceipt.appliedLayoutRevisionNo,
      };
      if (dropNextVisualResponse) {
        dropNextVisualResponse = false;
        await fulfillJson(route, 200, headers, {});
      } else {
        await fulfillJson(route, 200, headers, response);
      }
      return;
    }

    const restoreMatch = pathname.match(
      new RegExp(`^/api/v1/projects/${PROJECT_ID}/revisions/(\\d+)/restore$`),
    );
    if (method === "POST" && restoreMatch?.[1]) {
      if (!body || !(await requireExpectedRevision(route, headers, body, state))) return;
      const target = revisions.find(
        (candidate) => candidate.revisionNo === Number(restoreMatch[1]),
      );
      if (!target) {
        await fulfillError(
          route,
          headers,
          404,
          "PROJECT_REVISION_NOT_FOUND",
          "The requested revision was not found.",
        );
        return;
      }
      const mutation = await appendRevision(target.source, "RESTORE");
      await fulfillJson(route, 200, headers, {
        state,
        diagnostics: mutation.diagnostics,
        revisionCreated: true,
      });
      return;
    }

    await fulfillError(route, headers, 404, "PROJECT_NOT_FOUND", "Project not found.");
  });

  async function appendRevision(
    source: string,
    origin: RevisionOrigin,
    knownDiagnostics?: Diagnostic[],
  ): Promise<{ diagnostics: Diagnostic[] }> {
    const latest = revisions[0];
    if (!latest) throw new Error("The controlled revision history is empty.");
    const next = await createRevision(source, latest.revisionNo + 1, origin, knownDiagnostics);
    revisions.unshift(next);
    const lastValid =
      next.validity === "VALID"
        ? next
        : (revisions.find((candidate) => candidate.id === state.project.lastValidRevisionId) ??
          null);
    state = projectState(next, lastValid, layouts.currentRevisionNo);
    return { diagnostics: next.diagnostics };
  }

  return {
    layouts,
    revisions,
    receipts,
    visualCommands,
    visualAttempts,
    draftWrites,
    currentSource: () => state.project.draftSource,
    currentValidity: () => state.currentRevision.validity,
    currentRevisionNo: () => state.project.schemaRevisionNo,
    currentOrigin: () => state.currentRevision.origin,
    loseNextVisualResponse: () => {
      dropNextVisualResponse = true;
    },
    commitExternalRevision: async () => {
      if (externalRevisionCommitted)
        throw new Error("The external revision was already committed.");
      externalRevisionCommitted = true;
      // A concurrent SQL import is allowed to create a checkpoint even when its candidate is
      // byte-identical. It advances the project CAS while preserving every stable graph key.
      await appendRevision(state.project.draftSource, "SQL_IMPORT");
    },
  };
}

async function createRevision(
  source: string,
  revisionNo: number,
  origin: RevisionOrigin,
  knownDiagnostics?: Diagnostic[],
) {
  const parsed = await parseDbmlV2(source, "/main.dbml");
  const diagnostics = knownDiagnostics ?? (parsed.ok ? [] : parsed.diagnostics);
  const validity = parsed.ok ? ("VALID" as const) : ("INVALID" as const);
  return {
    id: `019d3f4e-7b6c-7def-8abc-${revisionNo.toString(16).padStart(12, "0")}`,
    projectId: PROJECT_ID,
    revisionNo,
    source,
    sourceHash: sha256(source),
    validity,
    origin,
    parserVersion: "9.1.1",
    diagnosticSummary: summarizeDiagnostics(diagnostics),
    diagnostics,
    createdAt: revisionTimestamp(revisionNo),
  };
}

type Revision = Awaited<ReturnType<typeof createRevision>>;
type RevisionOrigin = "SOURCE_EDIT" | "VISUAL_COMMAND" | "SQL_IMPORT" | "RESTORE";

interface VisualReceipt {
  readonly serializedCommand: string;
  readonly revisionCreated: boolean;
  readonly layoutMigrated: boolean;
  readonly appliedSchemaRevisionNo: number;
  readonly appliedLayoutRevisionNo: number;
}

function projectState(
  currentRevision: Revision,
  lastValidRevision: Revision | null,
  layoutNo: number,
) {
  return {
    project: {
      id: PROJECT_ID,
      name: "M3 visual mutation gate",
      primaryDialect: "POSTGRESQL" as const,
      draftSource: currentRevision.source,
      draftHash: currentRevision.sourceHash,
      lastValidRevisionId: lastValidRevision?.id ?? null,
      parserVersion: "9.1.1",
      schemaRevisionNo: currentRevision.revisionNo,
      layoutRevisionNo: layoutNo,
      createdAt: CREATED_AT,
      updatedAt: currentRevision.createdAt,
    },
    currentRevision: withoutDiagnostics(currentRevision),
    lastValidRevision: lastValidRevision ? withoutDiagnostics(lastValidRevision) : null,
  };
}

function withoutDiagnostics(revision: Revision) {
  const { diagnostics: _diagnostics, ...publicRevision } = revision;
  return publicRevision;
}

function withLayoutRevision(state: ReturnType<typeof projectState>, layoutRevisionNo: number) {
  return { ...state, project: { ...state.project, layoutRevisionNo } };
}

function revisionSummary(revision: Revision) {
  const { source: _source, diagnostics: _diagnostics, ...summary } = revision;
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

async function requireExpectedRevision(
  route: Route,
  headers: Record<string, string>,
  command: Record<string, unknown> | VisualCommand,
  state: ReturnType<typeof projectState>,
): Promise<boolean> {
  if (command.expectedSchemaRevisionNo === state.project.schemaRevisionNo) return true;
  await fulfillJson(route, 409, headers, {
    code: "VISUAL_COMMAND_SCHEMA_REVISION_CONFLICT",
    message: "The schema changed after this operation was prepared.",
    correlationId: CORRELATION_ID,
    currentRevisionNo: state.project.schemaRevisionNo,
  });
  return false;
}

function toPublicDiagnostic(
  diagnostic: Awaited<ReturnType<typeof transformVisualCommand>> extends infer _Result
    ? { code: string; message: string; severity: "ERROR" | "WARNING" | "INFO"; range?: Range }
    : never,
) {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    ...(diagnostic.range ? { range: { filepath: "/main.dbml", ...diagnostic.range } } : {}),
  };
}

interface Range {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

function toPublicPartialImpact(impact: {
  partialKey: string;
  partialName: string;
  partialElementKey: string;
  definitionRange: Range;
  affectedTables: Array<{ tableKey: string; injectionRange: Range }>;
}) {
  return {
    partialKey: impact.partialKey,
    partialName: impact.partialName,
    partialElementKey: impact.partialElementKey,
    definitionRange: { filepath: "/main.dbml", ...impact.definitionRange },
    affectedTables: impact.affectedTables.map((table) => ({
      tableKey: table.tableKey,
      injectionRange: { filepath: "/main.dbml", ...table.injectionRange },
    })),
  };
}

function summarizeDiagnostics(diagnostics: readonly Diagnostic[]) {
  return {
    errors: diagnostics.filter((diagnostic) => diagnostic.severity === "ERROR").length,
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === "WARNING").length,
    infos: diagnostics.filter((diagnostic) => diagnostic.severity === "INFO").length,
    parserVersion: "9.1.1",
  };
}

function revisionTimestamp(revisionNo: number): string {
  return `2026-08-30T03:${String(Math.floor(revisionNo / 60)).padStart(2, "0")}:${String(
    revisionNo % 60,
  ).padStart(2, "0")}.006Z`;
}

function responseHeaders(commandId?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-correlation-id": CORRELATION_ID,
    ...(commandId ? { "x-command-id": commandId } : {}),
  };
}

async function fulfillJson(
  route: Route,
  status: number,
  headers: Record<string, string>,
  body: unknown,
): Promise<void> {
  await route.fulfill({ status, headers, body: JSON.stringify(body) });
}

async function fulfillError(
  route: Route,
  headers: Record<string, string>,
  status: number,
  code: string,
  message: string,
): Promise<void> {
  await fulfillJson(route, status, headers, { code, message, correlationId: CORRELATION_ID });
}

async function applyCommandAndWait(
  page: Page,
  api: { visualCommands: VisualCommand[] },
  expectedKind: VisualCommand["kind"],
): Promise<void> {
  const previousCount = api.visualCommands.length;
  await page.getByRole("button", { name: "Apply command" }).click();
  await expect.poll(() => api.visualCommands.length, { timeout: 20_000 }).toBe(previousCount + 1);
  expect(api.visualCommands.at(-1)?.kind).toBe(expectedKind);
  await expect(page.getByTestId("base-diagram-layout-status")).toHaveText("Diagram layout ready", {
    timeout: 20_000,
  });
}

async function waitForWorkspace(page: Page): Promise<void> {
  await expect(page.locator('section[aria-label="DBML source editor"] .monaco-editor')).toBeVisible(
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("base-diagram-layout-status")).toHaveText("Diagram layout ready", {
    timeout: 20_000,
  });
  await expect(page.getByRole("complementary", { name: "Visual schema inspector" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Schema history", exact: true })).toBeVisible();
}

async function replaceEditorSource(page: Page, source: string): Promise<void> {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const editor = page.getByRole("textbox", { name: "DBML source editor" });
  await editor.focus();
  await editor.press(`${modifier}+a`);
  await editor.evaluate((element, pastedSource) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pastedSource);
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    );
  }, source);
  await page.waitForTimeout(800);
}

async function selectTableInOutline(page: Page, qualifiedName: string): Promise<void> {
  const outline = page.getByRole("region", { name: "Schema outline" });
  const summary = outline.locator("summary").filter({ hasText: qualifiedName }).first();
  await expect(summary).toBeVisible({ timeout: 20_000 });
  const details = summary.locator("..");
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await summary.click();
  }
  const focus = details.getByRole("button", { name: `Focus ${qualifiedName} in diagram` });
  await expect(focus).toBeVisible({ timeout: 20_000 });
  await focus.click();
}

async function selectColumnInOutline(
  page: Page,
  qualifiedTableName: string,
  columnName: string,
): Promise<void> {
  const outline = page.getByRole("region", { name: "Schema outline" });
  const summary = outline.locator("summary").filter({ hasText: qualifiedTableName }).first();
  await expect(summary).toBeVisible({ timeout: 20_000 });
  const details = summary.locator("..");
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await summary.click();
  }
  const focus = details.getByRole("button", {
    name: `Focus column ${columnName} in diagram`,
    exact: true,
  });
  await expect(focus).toBeVisible({ timeout: 20_000 });
  await focus.click();
}

async function selectTableInDiagram(page: Page, qualifiedName: string): Promise<void> {
  const table = page.getByRole("article", { name: `Table ${qualifiedName}` });
  const buttonName = qualifiedName.replace(".", " ");
  const select = table.getByRole("button", { name: buttonName, exact: true });
  await expect(select).toBeVisible({ timeout: 20_000 });
  await select.click();
}

async function selectViewContaining(page: Page, labelFragment: string): Promise<void> {
  const select = page.getByRole("combobox", { name: "Diagram view" });
  const options = await select.locator("option").evaluateAll((elements) =>
    elements.map((element) => ({
      label: element.textContent ?? "",
      value: (element as HTMLOptionElement).value,
    })),
  );
  const match = options.find((option) => option.label.includes(labelFragment));
  if (!match) throw new Error(`Missing diagram view containing ${labelFragment}.`);
  await select.selectOption(match.value);
  await expect(page.getByTestId("base-diagram-layout-status")).toHaveText("Diagram layout ready", {
    timeout: 20_000,
  });
}

function collectBrowserErrors(page: Page, expectedNetworkErrors: readonly RegExp[] = []): string[] {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !expectedNetworkErrors.some((pattern) => pattern.test(message.text()))
    ) {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  return browserErrors;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
