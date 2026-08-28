// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { createHash } from "node:crypto";
import type {
  DiagramLayout,
  DiagramLayoutValue,
  LayoutResponse,
  ProjectMutationResponse,
  ProjectState,
} from "@er-diagram/contracts";
import { parseDbmlV2 } from "@er-diagram/core";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BaseSchemaDiagramProps } from "../src/diagram/base-schema-diagram-contract.js";
import type { ProjectApi, SaveDraftInput, SaveLayoutInput } from "../src/projects/project-api.js";
import type {
  SourceEditorHandle,
  SourceEditorProps,
} from "../src/source-editor/editor-contract.js";
import type {
  DbmlParserWorkerClient,
  DbmlWorkerParseResult,
} from "../src/source-editor/parser-worker-client.js";
import { ProjectSourceWorkspace } from "../src/source-editor/project-source-workspace.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const REVISION_ID = "019d3f4e-7b6c-7abd-8def-0123456789ab";
const CREATED_AT = "2026-08-28T01:02:03.004Z";
const SOURCE = `TableGroup Identity {
  accounts
}

Table accounts {
  id int [pk]
}

DiagramView focus {
  Tables {
    accounts
  }
}
`;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("workspace layout persistence", () => {
  it("hydrates independent view layouts and debounces drag persistence for 500 ms", async () => {
    const parsed = await graph();
    const tableKey = parsed.tables[0]?.key;
    const groupKey = parsed.groups[0]?.key;
    const viewKey = parsed.views[0]?.key;
    if (!tableKey || !groupKey || !viewKey) throw new Error("Missing layout fixture keys.");
    const api = new LayoutProjectApi(projectState(2));
    api.layouts.set(
      "GLOBAL",
      storedLayout("GLOBAL", 1, parsed.schemaHash, {
        positions: { [tableKey]: { x: 11, y: 12 } },
        collapsedGroupKeys: [groupKey],
        detailLevel: "KEYS_ONLY",
      }),
    );
    api.layouts.set(
      viewKey,
      storedLayout(viewKey, 2, parsed.schemaHash, {
        positions: { [tableKey]: { x: 91, y: 92 } },
        detailLevel: "NAME_ONLY",
      }),
    );
    const { parserClient } = renderWorkspace(api);

    expect(await screen.findByTestId("layout-position")).toHaveTextContent("11,12");
    expect(screen.getByTestId("layout-detail")).toHaveTextContent("KEYS_ONLY");
    expect(screen.getByTestId("layout-collapse-count")).toHaveTextContent("1");

    const viewSelector = screen.getByRole("combobox", { name: "Diagram view" });
    fireEvent.change(viewSelector, { target: { value: viewKey } });
    await waitFor(() => expect(screen.getByTestId("layout-position")).toHaveTextContent("91,92"));
    expect(screen.getByTestId("layout-detail")).toHaveTextContent("NAME_ONLY");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Drag first node" }));
    await act(() => vi.advanceTimersByTimeAsync(499));
    expect(api.saveLayoutInputs).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(1));
    await settleReact();
    expect(api.saveLayoutInputs).toHaveLength(1);
    expect(api.saveLayoutInputs[0]).toMatchObject({
      viewKey,
      expectedLayoutRevisionNo: 2,
      layout: { positions: { [tableKey]: { x: 120, y: 140 } } },
    });
    expect(api.saveDraftInputs).toHaveLength(0);
    expect(parserClient.parseCalls).toBe(1);

    vi.useRealTimers();
    fireEvent.change(viewSelector, { target: { value: "GLOBAL" } });
    await waitFor(() => expect(screen.getByTestId("layout-position")).toHaveTextContent("11,12"));
  });

  it("persists a preview baseline, cancels without another write, applies, and resets only the current view", async () => {
    const parsed = await graph();
    const tableKey = parsed.tables[0]?.key;
    if (!tableKey) throw new Error("Missing table key.");
    const api = new LayoutProjectApi(projectState(0));
    renderWorkspace(api);
    await screen.findByTestId("layout-position");

    fireEvent.click(screen.getByRole("button", { name: "Preview auto layout" }));
    expect(await screen.findByText("Auto-layout preview ready")).toBeVisible();
    expect(api.saveLayoutInputs).toHaveLength(1);
    expect(api.saveLayoutInputs[0]?.layout.positions[tableKey]).toEqual({ x: 10, y: 20 });
    fireEvent.click(screen.getByRole("button", { name: "Cancel preview" }));
    expect(api.saveLayoutInputs).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("layout-position")).toHaveTextContent("10,20"));

    fireEvent.click(screen.getByRole("button", { name: "Preview auto layout" }));
    await screen.findByText("Auto-layout preview ready");
    fireEvent.click(screen.getByRole("button", { name: "Apply auto layout" }));
    await waitFor(() => expect(api.saveLayoutInputs).toHaveLength(2));
    expect(api.saveLayoutInputs[1]?.layout.positions[tableKey]).toEqual({ x: 200, y: 220 });

    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    const firstDialog = await screen.findByRole("dialog", { name: "Reset this view layout?" });
    expect(within(firstDialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(within(firstDialog).getByRole("button", { name: "Cancel" }));
    expect(api.saveLayoutInputs).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    const secondDialog = await screen.findByRole("dialog", { name: "Reset this view layout?" });
    fireEvent.click(within(secondDialog).getByRole("button", { name: "Reset this view" }));
    await waitFor(() => expect(api.saveLayoutInputs).toHaveLength(3));
    expect(api.saveLayoutInputs[2]).toMatchObject({
      viewKey: "GLOBAL",
      layout: {
        positions: { [tableKey]: { x: 300, y: 320 } },
        collapsedGroupKeys: [],
        hiddenElementKeys: [],
        detailLevel: "FULL",
      },
    });
    expect(api.saveDraftInputs).toHaveLength(0);
  });
});

const FakeSourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(
  function FakeSourceEditor({ initialSource }, ref) {
    useImperativeHandle(ref, () => ({
      replaceSource: () => undefined,
      navigateToDiagnostic: () => false,
      revealSourceRange: () => false,
      focus: () => undefined,
    }));
    return <textarea aria-label="DBML source editor" defaultValue={initialSource} readOnly />;
  },
);

function FakeLayoutDiagram(props: BaseSchemaDiagramProps) {
  const emittedRequestRef = useRef<number | null>(null);
  const emittedRenderedRef = useRef<string | null>(null);
  const tableKey = props.graph.tables[0]?.key ?? "missing-table";
  const position = props.layoutPositions?.[tableKey];

  useEffect(() => {
    const identity = `${props.graph.schemaHash}:${props.viewKey}`;
    if (emittedRenderedRef.current === identity) return;
    emittedRenderedRef.current = identity;
    props.onRenderedLayoutReady?.({ [tableKey]: { x: 10, y: 20 } }, { x: 1, y: 2, zoom: 0.8 });
  }, [props, tableKey]);

  useEffect(() => {
    if (!props.layoutRequest || emittedRequestRef.current === props.layoutRequest.requestId) return;
    emittedRequestRef.current = props.layoutRequest.requestId;
    const reset = props.layoutRequest.mode === "RESET";
    props.onLayoutRequestReady?.({
      requestId: props.layoutRequest.requestId,
      mode: props.layoutRequest.mode,
      succeeded: true,
      positions: { [tableKey]: { x: reset ? 300 : 200, y: reset ? 320 : 220 } },
      viewport: { x: reset ? 30 : 20, y: reset ? 32 : 22, zoom: 0.9 },
    });
  }, [props, tableKey]);

  return (
    <div role="application" aria-label="ER diagram canvas">
      <output data-testid="layout-position">
        {position ? `${position.x},${position.y}` : "auto"}
      </output>
      <output data-testid="layout-detail">{props.detailLevel}</output>
      <output data-testid="layout-collapse-count">{props.collapsedGroupKeys.size}</output>
      <button
        type="button"
        onClick={() => props.onPositionsCommit?.({ [tableKey]: { x: 120, y: 140 } })}
      >
        Drag first node
      </button>
      <button type="button" onClick={() => props.onViewportCommit?.({ x: 5, y: 6, zoom: 1.1 })}>
        Pan diagram
      </button>
    </div>
  );
}

class FakeParserClient implements DbmlParserWorkerClient {
  readonly dispose = vi.fn();
  parseCalls = 0;

  async parse(source: string): Promise<DbmlWorkerParseResult> {
    this.parseCalls += 1;
    const result = await parseDbmlV2(source);
    if (!result.ok) throw new Error("Unexpected invalid layout fixture.");
    return {
      type: "DBML_PARSE_RESULT",
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      ok: true,
      sourceHash: result.sourceHash,
      parserInputHash: result.parserInputHash,
      parserVersion: result.graph.parserVersion,
      diagnostics: result.graph.diagnostics,
      graph: result.graph,
    };
  }
}

class LayoutProjectApi implements ProjectApi {
  readonly layouts = new Map<string, DiagramLayout>();
  readonly saveLayoutInputs: SaveLayoutInput[] = [];
  readonly saveDraftInputs: SaveDraftInput[] = [];
  currentLayoutRevisionNo: number;

  constructor(readonly state: ProjectState) {
    this.currentLayoutRevisionNo = state.project.layoutRevisionNo;
  }

  async getLayout(input: { projectId: string; viewKey: string }): Promise<LayoutResponse> {
    return {
      layout: this.layouts.get(input.viewKey) ?? null,
      currentLayoutRevisionNo: this.currentLayoutRevisionNo,
    };
  }

  async saveLayout(input: SaveLayoutInput) {
    this.saveLayoutInputs.push(structuredClone(input));
    this.currentLayoutRevisionNo += 1;
    const layout: DiagramLayout = {
      projectId: input.projectId,
      viewKey: input.viewKey,
      revisionNo: this.currentLayoutRevisionNo,
      ...structuredClone(input.layout),
    };
    this.layouts.set(input.viewKey, layout);
    return {
      state: { layout, currentLayoutRevisionNo: this.currentLayoutRevisionNo },
      layoutUpdated: true,
    };
  }

  async saveDraft(input: SaveDraftInput): Promise<ProjectMutationResponse> {
    this.saveDraftInputs.push(input);
    throw new Error("Draft save is not expected in layout tests.");
  }

  async getProject() {
    return { state: this.state };
  }
  async listProjects() {
    return { projects: [] };
  }
  async createProject(): Promise<ProjectMutationResponse> {
    throw new Error("Not used.");
  }
  async renameProject() {
    return { state: this.state };
  }
  async duplicateProject(): Promise<ProjectMutationResponse> {
    throw new Error("Not used.");
  }
  async deleteProject(): Promise<void> {}
}

function renderWorkspace(api: LayoutProjectApi) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const parserClient = new FakeParserClient();
  const router = createMemoryRouter(
    [
      {
        path: "/projects/:projectId",
        element: (
          <ProjectSourceWorkspace
            initialState={api.state}
            api={api}
            queryClient={queryClient}
            adapters={{
              SourceEditor: FakeSourceEditor,
              SchemaDiagram: FakeLayoutDiagram,
              createParserClient: () => parserClient,
            }}
          />
        ),
      },
      { path: "/", element: <p>Projects</p> },
    ],
    { initialEntries: [`/projects/${PROJECT_ID}`] },
  );
  return { ...render(<RouterProvider router={router} />), parserClient, router, queryClient };
}

function projectState(layoutRevisionNo: number): ProjectState {
  const sourceHash = sha256(SOURCE);
  const revision = {
    id: REVISION_ID,
    projectId: PROJECT_ID,
    revisionNo: 1,
    source: SOURCE,
    sourceHash,
    validity: "VALID" as const,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
    createdAt: CREATED_AT,
  };
  return {
    project: {
      id: PROJECT_ID,
      name: "Layout test",
      primaryDialect: "POSTGRESQL",
      draftSource: SOURCE,
      draftHash: sourceHash,
      lastValidRevisionId: REVISION_ID,
      parserVersion: "9.1.1",
      schemaRevisionNo: 1,
      layoutRevisionNo,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision: revision,
    lastValidRevision: revision,
  };
}

function storedLayout(
  viewKey: string,
  revisionNo: number,
  baseSchemaHash: string,
  overrides: Partial<DiagramLayoutValue>,
): DiagramLayout {
  return {
    projectId: PROJECT_ID,
    viewKey,
    revisionNo,
    positions: {},
    collapsedGroupKeys: [],
    hiddenElementKeys: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    detailLevel: "FULL",
    baseSchemaHash,
    ...overrides,
  };
}

async function graph() {
  const result = await parseDbmlV2(SOURCE);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.graph;
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

async function settleReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
