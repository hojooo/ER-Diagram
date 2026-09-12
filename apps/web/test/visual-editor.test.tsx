// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { type VisualCommand, visualCommandSchema } from "@er-diagram/contracts";
import { parseDbmlV2, type SchemaGraph } from "@er-diagram/core";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createDiagramSelectionStore } from "../src/diagram/selection-store.js";
import type { DiagramSelection } from "../src/diagram/source-navigation.js";
import type {
  VisualCommandSessionController,
  VisualCommandSessionSnapshot,
} from "../src/visual-editor/visual-command-session.js";
import {
  CanvasColumnInlineEditor,
  positionInlineColumnEditor,
} from "../src/visual-editor/canvas-column-inline-editor.js";
import {
  createInitialVisualDraft,
  listVisualEditorActions,
} from "../src/visual-editor/visual-editor-model.js";
import { VisualSchemaInspector } from "../src/visual-editor/visual-schema-inspector.js";

const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";
const SOURCE = `TablePartial audit_fields {
  created_at timestamp
}

Table public.users {
  id bigint [pk]
  team_id bigint
  email varchar

  indexes {
    email [name: "users_email_idx", unique]
  }

  checks {
    \`id > 0\` [name: "positive_id"]
  }
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
  Tables { public.users }
  TableGroups { identity }
  Schemas { public }
}
`;

let graph: SchemaGraph;

beforeAll(async () => {
  const parsed = await parseDbmlV2(SOURCE, "/main.dbml");
  if (!parsed.ok) throw new Error("Visual editor fixture did not parse.");
  graph = parsed.graph;
});

afterEach(cleanup);

describe("visual editor command model", () => {
  it("exposes all 18 VisualCommand variants and produces strict contract payloads", () => {
    const users = requiredTable("users");
    const userId = requiredColumn(users, "id");
    const reference = graph.references[0];
    const group = graph.groups[0];
    const view = graph.views[0];
    if (!reference || !group || !view) throw new Error("Missing visual fixture elements.");
    const contexts: Array<{ selection: DiagramSelection | null; viewKey: string }> = [
      { selection: null, viewKey: view.key },
      { selection: selection("table", users.key, [users.key]), viewKey: view.key },
      { selection: selection("column", userId.key, [users.key]), viewKey: view.key },
      {
        selection: selection(
          "reference",
          reference.key,
          reference.endpoints.map((endpoint) => endpoint.tableKey),
        ),
        viewKey: view.key,
      },
      { selection: selection("group", group.key, group.tableKeys), viewKey: view.key },
    ];
    const actions = contexts.flatMap(({ selection: currentSelection, viewKey }) =>
      listVisualEditorActions(graph, currentSelection, viewKey).map((action) => ({
        action,
        selection: currentSelection,
      })),
    );
    const uniqueActions = new Map(actions.map((entry) => [entry.action.kind, entry]));
    expect([...uniqueActions.keys()].sort()).toEqual(
      [
        "CREATE_TABLE",
        "UPDATE_TABLE",
        "RENAME_TABLE",
        "DELETE_TABLE",
        "CREATE_COLUMN",
        "ALTER_COLUMN",
        "DELETE_COLUMN",
        "CREATE_REFERENCE",
        "UPDATE_REFERENCE",
        "DELETE_REFERENCE",
        "CREATE_INDEX",
        "UPDATE_INDEX",
        "DELETE_INDEX",
        "CREATE_CHECK",
        "UPDATE_CHECK",
        "DELETE_CHECK",
        "UPDATE_GROUP_MEMBERSHIP",
        "UPDATE_DIAGRAM_VIEW",
      ].sort(),
    );

    for (const { action, selection: currentSelection } of uniqueActions.values()) {
      let draft = createInitialVisualDraft(graph, currentSelection, action);
      if (!draft) throw new Error(`Missing draft for ${action.kind}`);
      if (draft.kind === "UPDATE_GROUP_MEMBERSHIP") {
        const outside = graph.tables.find(
          (table) => !graph.groups[0]?.tableKeys.includes(table.key),
        );
        if (!outside) throw new Error("Missing outside table.");
        draft = { ...draft, addTableKeys: [outside.key] };
      }
      expect(
        visualCommandSchema.safeParse({
          ...draft,
          commandId: COMMAND_ID,
          expectedSchemaRevisionNo: 1,
        }).success,
        action.kind,
      ).toBe(true);
    }
  });

  it("offers dialect and graph enum types without rejecting a raw custom type", () => {
    const users = requiredTable("users");
    const store = createDiagramSelectionStore();
    store.getState().setSelection(selection("table", users.key, [users.key]));
    const commandSession = fakeCommandSession();
    renderInspector(store, commandSession.controller);

    fireEvent.click(screen.getByRole("button", { name: "Create column" }));
    const typeInput = screen.getByLabelText("DBML column type");
    const typeListId = typeInput.getAttribute("list");
    expect(typeListId).toBeTruthy();
    expect(document.getElementById(typeListId ?? "")).toBeInstanceOf(HTMLDataListElement);
    fireEvent.change(typeInput, { target: { value: "vector(1536)" } });
    fireEvent.change(screen.getByLabelText("Column name"), { target: { value: "embedding" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply command" }));

    expect(commandSession.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "CREATE_COLUMN",
        column: expect.objectContaining({ name: "embedding", type: "vector(1536)" }),
      }),
      graph.schemaHash,
    );
  });

  it("keeps an empty string column default valid", () => {
    const users = requiredTable("users");
    const store = createDiagramSelectionStore();
    store.getState().setSelection(selection("table", users.key, [users.key]));
    const commandSession = fakeCommandSession();
    renderInspector(store, commandSession.controller);

    fireEvent.click(screen.getByRole("button", { name: "Create column" }));
    fireEvent.change(screen.getByLabelText("Column name"), { target: { value: "nickname" } });
    fireEvent.change(screen.getByLabelText("Default kind"), { target: { value: "string" } });
    const defaultInput = screen.getByLabelText("Default string");
    expect(defaultInput).not.toBeRequired();
    fireEvent.click(screen.getByRole("button", { name: "Apply command" }));

    expect(commandSession.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "CREATE_COLUMN",
        column: expect.objectContaining({ default: { type: "string", value: "" } }),
      }),
      graph.schemaHash,
    );
  });

  it("submits name, attributes, and order as one atomic ALTER_COLUMN draft", () => {
    const users = requiredTable("users");
    const userId = requiredColumn(users, "id");
    const store = createDiagramSelectionStore();
    store.getState().setSelection(selection("column", userId.key, [users.key]));
    const commandSession = fakeCommandSession();
    renderInspector(store, commandSession.controller);

    fireEvent.click(screen.getByRole("button", { name: "Edit column" }));
    fireEvent.change(screen.getByLabelText("Column name"), { target: { value: "user_id" } });
    fireEvent.change(screen.getByLabelText("DBML column type"), { target: { value: "uuid" } });
    fireEvent.click(screen.getByLabelText("Not null"));
    fireEvent.change(screen.getByLabelText("Move before"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply command" }));

    expect(commandSession.submit).toHaveBeenCalledTimes(1);
    expect(commandSession.submit).toHaveBeenCalledWith(
      {
        kind: "ALTER_COLUMN",
        targetTableKey: users.key,
        targetColumnKey: userId.key,
        newName: "user_id",
        changes: { type: "uuid", notNull: true },
        beforeColumnKey: null,
      },
      graph.schemaHash,
    );
  });
});

describe("accessible visual schema inspector", () => {
  it("labels every control in all 18 VisualCommand forms", () => {
    const actions = visualActionContexts();
    expect(actions.size).toBe(18);

    for (const { action, currentSelection } of actions.values()) {
      cleanup();
      const store = createDiagramSelectionStore();
      if (currentSelection) store.getState().setSelection(currentSelection);
      const commandSession = fakeCommandSession();
      renderInspector(store, commandSession.controller);

      fireEvent.click(screen.getByRole("button", { name: action.label }));
      const form = screen.getByRole("form", { name: action.label });
      for (const control of form.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("input, select, textarea")) {
        const labelText = [...(control.labels ?? [])]
          .map((label) => label.textContent?.trim() ?? "")
          .join(" ");
        expect(
          control.getAttribute("aria-label")?.trim() || labelText,
          `${action.kind} control must have an accessible name`,
        ).not.toBe("");
      }
      for (const fieldset of form.querySelectorAll("fieldset")) {
        expect(
          fieldset.querySelector(":scope > legend")?.textContent?.trim(),
          `${action.kind} fieldset must have a legend`,
        ).toBeTruthy();
      }
    }
  });

  it("uses a roving tab stop for the visual action toolbar", () => {
    const store = createDiagramSelectionStore();
    const commandSession = fakeCommandSession();
    renderInspector(store, commandSession.controller);

    const toolbar = screen.getByRole("toolbar", { name: "Visual schema actions" });
    const actions = within(toolbar).getAllByRole("button");
    expect(actions.length).toBeGreaterThan(1);
    expect(actions[0]).toHaveAttribute("tabindex", "0");
    expect(actions[1]).toHaveAttribute("tabindex", "-1");

    actions[0]?.focus();
    const disabledAction = actions[1] as HTMLButtonElement | undefined;
    if (disabledAction) disabledAction.disabled = true;
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(actions[2]).toHaveFocus();
    fireEvent.keyDown(toolbar, { key: "End" });
    expect(actions.at(-1)).toHaveFocus();
    fireEvent.keyDown(toolbar, { key: "Home" });
    expect(actions[0]).toHaveFocus();
  });

  it("focuses and describes the first invalid field while preserving form input", () => {
    const store = createDiagramSelectionStore();
    const commandSession = fakeCommandSession();
    renderInspector(store, commandSession.controller);

    fireEvent.click(screen.getByRole("button", { name: "Create table" }));
    const tableName = screen.getByLabelText("Table name");
    fireEvent.change(tableName, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply command" }));

    const summary = screen.getByRole("alert");
    expect(tableName).toHaveFocus();
    expect(tableName).toHaveAttribute("aria-invalid", "true");
    expect(tableName).toHaveAttribute("aria-errormessage", summary.id);
    expect(screen.getByRole("form")).toHaveAttribute("aria-describedby", summary.id);
    expect(tableName).toHaveValue("");
    expect(commandSession.submit).not.toHaveBeenCalled();
  });

  it("follows selection, exposes typed table actions, and uses a cancel-first delete dialog", () => {
    const posts = requiredTable("posts");
    const store = createDiagramSelectionStore();
    const commandSession = fakeCommandSession();
    renderInspector(store, commandSession.controller);
    expect(screen.queryByText("No diagram element selected")).toBeNull();

    act(() => store.getState().setSelection(selection("table", posts.key, [posts.key])));
    expect(screen.getByText("Selected table public.posts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete table" }));
    const deleteAction = screen.getAllByRole("button", { name: "Delete table" }).at(-1);
    if (!deleteAction) throw new Error("Expected a delete action in the inspector form.");
    fireEvent.click(deleteAction);
    expect(screen.getByRole("dialog").textContent).toContain("2 owned columns");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(commandSession.submit).not.toHaveBeenCalled();
  });

  it("provides an accessible layout-only table size editor and reset", () => {
    const users = requiredTable("users");
    const store = createDiagramSelectionStore();
    store.getState().setSelection(selection("table", users.key, [users.key]));
    const commandSession = fakeCommandSession();
    const onApplyTableSize = vi.fn();
    const onResetTableSize = vi.fn();

    render(
      <VisualSchemaInspector
        graph={graph}
        primaryDialect="POSTGRESQL"
        currentViewKey="GLOBAL"
        selectionStore={store}
        commandSession={commandSession.controller}
        interactionDisabled={false}
        sourceNavigationEnabled
        onOpenSource={vi.fn()}
        onReloadLayouts={vi.fn()}
        layoutPositions={{
          [users.key]: { x: 20, y: 30, width: 340, height: 200 },
        }}
        detailLevel="FULL"
        onApplyTableSize={onApplyTableSize}
        onResetTableSize={onResetTableSize}
      />,
    );

    expect(screen.getByRole("heading", { name: "Table size in this view" })).toBeVisible();
    expect(screen.getByLabelText("Width (px)")).toHaveValue(340);
    expect(screen.getByLabelText("Height (px)")).toHaveValue(200);
    fireEvent.change(screen.getByLabelText("Width (px)"), { target: { value: "420" } });
    fireEvent.change(screen.getByLabelText("Height (px)"), { target: { value: "260" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply size" }));
    expect(onApplyTableSize).toHaveBeenCalledWith(users.key, 420, 260);

    fireEvent.click(screen.getByRole("button", { name: "Reset size" }));
    expect(onResetTableSize).toHaveBeenCalledWith(users.key);
  });

  it("blocks graph-known structural dependencies before a delete command is sent", () => {
    const users = requiredTable("users");
    const store = createDiagramSelectionStore();
    const commandSession = fakeCommandSession();
    renderInspector(store, commandSession.controller);

    act(() => store.getState().setSelection(selection("table", users.key, [users.key])));
    fireEvent.click(screen.getByRole("button", { name: "Delete table" }));
    expect(screen.getByRole("alert").textContent).toContain("relationship dependencies");
    expect(screen.getByRole("alert").textContent).toContain("TableGroup memberships");
    const blockedDelete = screen.getAllByRole("button", { name: "Delete table" }).at(-1);
    if (!(blockedDelete instanceof HTMLButtonElement)) {
      throw new Error("Expected a disabled delete button for structural dependencies.");
    }
    expect(blockedDelete.disabled).toBe(true);
    expect(commandSession.submit).not.toHaveBeenCalled();
  });

  it("protects injected partial columns and provides definition and injection navigation", () => {
    const posts = requiredTable("posts");
    const injected = requiredColumn(posts, "created_at");
    const store = createDiagramSelectionStore();
    store.getState().setSelection(selection("column", injected.key, [posts.key]));
    const commandSession = fakeCommandSession();
    const onOpenSource = vi.fn();
    render(
      <VisualSchemaInspector
        graph={graph}
        primaryDialect="POSTGRESQL"
        currentViewKey={graph.views[0]?.key ?? "GLOBAL"}
        selectionStore={store}
        commandSession={commandSession.controller}
        interactionDisabled={false}
        sourceNavigationEnabled
        onOpenSource={onOpenSource}
        onReloadLayouts={vi.fn()}
      />,
    );

    expect(screen.getByText(/Partial audit_fields owns this element/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit column" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open partial definition" }));
    fireEvent.click(screen.getByRole("button", { name: "Open table injection" }));
    expect(onOpenSource).toHaveBeenCalledTimes(2);
  });

  it("keeps a stale form for explicit review and shows safe replay/source fallback actions", () => {
    const store = createDiagramSelectionStore();
    const stale = fakeCommandSession({
      status: "STALE_REVIEW",
      error: {
        code: "VISUAL_COMMAND_SCHEMA_REVISION_CONFLICT",
        message: "The schema changed.",
        diagnostics: [],
      },
    });
    const { unmount } = renderInspector(store, stale.controller);
    fireEvent.click(screen.getByRole("button", { name: "Review latest schema" }));
    expect(stale.reviewLatestSchema).toHaveBeenCalledOnce();
    unmount();

    const unknown = fakeCommandSession({
      status: "UNKNOWN_OUTCOME",
      error: {
        code: "CLIENT_VISUAL_COMMAND_OUTCOME_UNKNOWN",
        message: "Outcome unknown.",
        diagnostics: [],
      },
    });
    renderInspector(store, unknown.controller);
    fireEvent.click(screen.getByRole("button", { name: "Retry safely" }));
    expect(unknown.retrySafely).toHaveBeenCalledOnce();
  });

  it("restores a same-graph selection and preserves the form draft for stale review", () => {
    const users = requiredTable("users");
    const store = createDiagramSelectionStore();
    store.getState().setSelection(selection("table", users.key, [users.key]));
    const commandSession = fakeCommandSession();
    renderInspector(store, commandSession.controller);

    fireEvent.click(screen.getByRole("button", { name: "Update table" }));
    fireEvent.change(screen.getByLabelText("Table note"), {
      target: { value: "preserved after conflict" },
    });
    act(() => {
      store.getState().setSelection(null);
      commandSession.setSnapshot({ status: "SUBMITTING" });
    });
    expect((screen.getByLabelText("Table note") as HTMLTextAreaElement).value).toBe(
      "preserved after conflict",
    );
    act(() => {
      commandSession.setSnapshot({
        status: "STALE_REVIEW",
        error: {
          code: "VISUAL_COMMAND_SCHEMA_REVISION_CONFLICT",
          message: "The schema changed.",
          diagnostics: [],
        },
      });
    });

    expect(screen.getByText("Selected table public.users")).toBeTruthy();
    expect((screen.getByLabelText("Table note") as HTMLTextAreaElement).value).toBe(
      "preserved after conflict",
    );
    fireEvent.click(screen.getByRole("button", { name: "Review latest schema" }));
    expect(commandSession.reviewLatestSchema).toHaveBeenCalledOnce();
  });

  it("offers an explicit recovery action when authoritative layout reload fails", () => {
    const store = createDiagramSelectionStore();
    const reloadLayouts = vi.fn();
    const succeeded = fakeCommandSession({
      status: "SUCCEEDED",
      layoutRefreshFailed: true,
    });
    renderInspector(store, succeeded.controller, { onReloadLayouts: reloadLayouts });

    fireEvent.click(screen.getByRole("button", { name: "Reload layouts" }));
    expect(reloadLayouts).toHaveBeenCalledOnce();
  });

  it("uses the current target as diagnostic source fallback and disables it for last-valid", () => {
    const users = requiredTable("users");
    const store = createDiagramSelectionStore();
    act(() => store.getState().setSelection(selection("table", users.key, [users.key])));
    const rejected = fakeCommandSession({
      status: "REJECTED",
      error: {
        code: "VISUAL_COMMAND_TRANSFORM_FAILED",
        message: "The transform was rejected.",
        diagnostics: [
          {
            code: "VISUAL_DEPENDENCY_CONFLICT",
            message: "Resolve dependencies.",
            severity: "ERROR",
          },
        ],
      },
    });
    const onOpenSource = vi.fn();
    const { unmount } = renderInspector(store, rejected.controller, { onOpenSource });

    fireEvent.click(screen.getByRole("button", { name: "Open in source" }));
    expect(onOpenSource).toHaveBeenCalledWith(graph.sourceMap[users.key]);
    unmount();

    renderInspector(store, rejected.controller, {
      onOpenSource,
      sourceNavigationEnabled: false,
    });
    const sourceAction = screen.getByRole("button", { name: "Open in source" });
    if (!(sourceAction instanceof HTMLButtonElement)) throw new Error("Expected source action.");
    expect(sourceAction.disabled).toBe(true);
  });
});

describe("canvas column inline editor", () => {
  it("keeps a fixed draft open and applies it with the explicit keyboard shortcut", () => {
    const users = requiredTable("users");
    const userId = requiredColumn(users, "id");
    const currentSelection = selection("column", userId.key, [users.key]);
    const action = {
      id: `ALTER_COLUMN:${userId.key}:canvas`,
      kind: "ALTER_COLUMN" as const,
      label: "Edit column",
      targetElementKey: userId.key,
    };
    const draft = createInitialVisualDraft(graph, currentSelection, action);
    if (draft?.kind !== "ALTER_COLUMN") throw new Error("Missing ALTER_COLUMN draft.");
    const commandSession = fakeCommandSession();
    const onCancel = vi.fn();

    render(
      <CanvasColumnInlineEditor
        state={{
          request: {
            selection: currentSelection,
            anchor: { top: 40, right: 320, bottom: 68, left: 40 },
          },
          initialDraft: draft,
          openedSchemaHash: graph.schemaHash,
          switchBlocked: true,
        }}
        graph={graph}
        primaryDialect="POSTGRESQL"
        commandSession={commandSession.controller}
        interactionDisabled={false}
        sourceNavigationEnabled
        viewportInsets={{ top: 80, right: 520, bottom: 72, left: 24 }}
        onCancel={onCancel}
        onOpenSource={vi.fn()}
        onReloadLayouts={vi.fn()}
        onReviewLatest={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: /Edit column id/ });
    expect(dialog).toHaveClass("nodrag", "nopan", "nowheel");
    expect(screen.getByLabelText("Column name")).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent(/Apply or cancel this column draft/);
    fireEvent.change(screen.getByLabelText("Column name"), { target: { value: "user_id" } });
    fireEvent.keyDown(screen.getByRole("form"), { key: "Enter", ctrlKey: true });
    expect(commandSession.submit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ALTER_COLUMN", newName: "user_id" }),
      graph.schemaHash,
    );

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps the anchored editor inside the visible diagram safe area", () => {
    expect(
      positionInlineColumnEditor(
        { top: 890, right: 1_420, bottom: 918, left: 1_120 },
        {
          width: 1_440,
          height: 900,
          insets: { top: 80, right: 520, bottom: 72, left: 24 },
        },
      ),
    ).toEqual({ left: 728, top: 236, width: 384, height: 576 });
  });

  it("uses a responsive viewport sheet when the visible diagram area is too small", () => {
    expect(
      positionInlineColumnEditor(
        { top: 120, right: 220, bottom: 148, left: 40 },
        {
          width: 640,
          height: 480,
          insets: { top: 80, right: 280, bottom: 64, left: 24 },
        },
      ),
    ).toEqual({ left: 228, top: 16, width: 384, height: 448 });
  });
});

function renderInspector(
  store: ReturnType<typeof createDiagramSelectionStore>,
  commandSession: VisualCommandSessionController,
  options: {
    readonly onReloadLayouts?: () => void;
    readonly onOpenSource?: (range: import("@er-diagram/contracts").SourceRange | null) => void;
    readonly sourceNavigationEnabled?: boolean;
  } = {},
) {
  return render(
    <VisualSchemaInspector
      graph={graph}
      primaryDialect="POSTGRESQL"
      currentViewKey={graph.views[0]?.key ?? "GLOBAL"}
      selectionStore={store}
      commandSession={commandSession}
      interactionDisabled={false}
      sourceNavigationEnabled={options.sourceNavigationEnabled ?? true}
      onOpenSource={options.onOpenSource ?? vi.fn()}
      onReloadLayouts={options.onReloadLayouts ?? vi.fn()}
    />,
  );
}

function fakeCommandSession(overrides: Partial<VisualCommandSessionSnapshot> = {}) {
  let snapshot: VisualCommandSessionSnapshot = {
    status: "IDLE",
    error: null,
    mutation: null,
    pendingCommand: null,
    lastCommand: null,
    layoutRefreshFailed: false,
    ...overrides,
  };
  const submit = vi.fn();
  const retrySafely = vi.fn();
  const reviewLatestSchema = vi.fn();
  const reset = vi.fn();
  const listeners = new Set<() => void>();
  const controller: VisualCommandSessionController = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit,
    retrySafely,
    reviewLatestSchema,
    reset,
  };
  return {
    controller,
    submit,
    retrySafely,
    reviewLatestSchema,
    reset,
    setSnapshot(patch: Partial<VisualCommandSessionSnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
  };
}

function requiredTable(name: string) {
  const table = graph.tables.find((candidate) => candidate.name === name);
  if (!table) throw new Error(`Missing table ${name}.`);
  return table;
}

function requiredColumn(table: ReturnType<typeof requiredTable>, name: string) {
  const column = table.columns.find((candidate) => candidate.name === name);
  if (!column) throw new Error(`Missing column ${name}.`);
  return column;
}

function visualActionContexts() {
  const users = requiredTable("users");
  const userId = requiredColumn(users, "id");
  const reference = graph.references[0];
  const group = graph.groups[0];
  const view = graph.views[0];
  if (!reference || !group || !view) throw new Error("Missing visual fixture elements.");
  const contexts: Array<{ currentSelection: DiagramSelection | null; viewKey: string }> = [
    { currentSelection: null, viewKey: view.key },
    {
      currentSelection: selection("table", users.key, [users.key]),
      viewKey: view.key,
    },
    {
      currentSelection: selection("column", userId.key, [users.key]),
      viewKey: view.key,
    },
    {
      currentSelection: selection(
        "reference",
        reference.key,
        reference.endpoints.map((endpoint) => endpoint.tableKey),
      ),
      viewKey: view.key,
    },
    {
      currentSelection: selection("group", group.key, group.tableKeys),
      viewKey: view.key,
    },
  ];
  return new Map(
    contexts.flatMap(({ currentSelection, viewKey }) =>
      listVisualEditorActions(graph, currentSelection, viewKey).map(
        (action) => [action.kind, { action, currentSelection }] as const,
      ),
    ),
  );
}

function selection(
  kind: DiagramSelection["kind"],
  elementKey: string,
  tableKeys: string[],
): DiagramSelection {
  return { kind, elementKey, tableKeys };
}

type _ContractSmoke = VisualCommand;
