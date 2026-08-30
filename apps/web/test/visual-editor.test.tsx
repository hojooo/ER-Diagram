// @vitest-environment jsdom

import { visualCommandSchema, type VisualCommand } from "@er-diagram/contracts";
import { parseDbmlV2, type SchemaGraph } from "@er-diagram/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createDiagramSelectionStore } from "../src/diagram/selection-store.js";
import type { DiagramSelection } from "../src/diagram/source-navigation.js";
import {
  createInitialVisualDraft,
  listVisualEditorActions,
} from "../src/visual-editor/visual-editor-model.js";
import { VisualSchemaInspector } from "../src/visual-editor/visual-schema-inspector.js";
import type {
  VisualCommandSessionController,
  VisualCommandSessionSnapshot,
} from "../src/visual-editor/visual-command-session.js";

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
  it("exposes all 20 VisualCommand variants and produces strict contract payloads", () => {
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
        "UPDATE_COLUMN",
        "RENAME_COLUMN",
        "REORDER_COLUMN",
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
    expect(typeInput.getAttribute("list")).toBe("visual-column-types");
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
});

describe("accessible visual schema inspector", () => {
  it("follows selection, exposes typed table actions, and uses a cancel-first delete dialog", () => {
    const posts = requiredTable("posts");
    const store = createDiagramSelectionStore();
    const commandSession = fakeCommandSession();
    renderInspector(store, commandSession.controller);
    expect(screen.getByText("No diagram element selected")).toBeTruthy();

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
    expect(screen.queryByRole("button", { name: "Update column" })).toBeNull();
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
  const snapshot: VisualCommandSessionSnapshot = {
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
  const controller: VisualCommandSessionController = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    submit,
    retrySafely,
    reviewLatestSchema,
    reset,
  };
  return { controller, submit, retrySafely, reviewLatestSchema, reset };
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

function selection(
  kind: DiagramSelection["kind"],
  elementKey: string,
  tableKeys: string[],
): DiagramSelection {
  return { kind, elementKey, tableKeys };
}

type _ContractSmoke = VisualCommand;
