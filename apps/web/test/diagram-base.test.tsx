// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { parseDbmlV2 } from "@er-diagram/core";
import { fixtureInventory, generateFidelityFixture } from "@er-diagram/test-fixtures";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const flowSpies = vi.hoisted(() => ({
  fitView: vi.fn(async () => true),
  setViewport: vi.fn(async () => true),
  getViewport: vi.fn(() => ({ x: 10, y: 20, zoom: 0.75 })),
}));

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  interface MockNode {
    id: string;
    position: { x: number; y: number };
    data: { name?: string };
  }
  interface MockEdge {
    id: string;
  }
  return {
    applyNodeChanges: (
      changes: Array<{ id: string; position?: { x: number; y: number } }>,
      nodes: MockNode[],
    ) =>
      nodes.map((node) => {
        const change = changes.find((candidate) => candidate.id === node.id);
        return change?.position ? { ...node, position: change.position } : node;
      }),
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    BaseEdge: () => null,
    Controls: () => null,
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => children,
    Handle: () => null,
    Position: { Left: "left", Right: "right" },
    getSmoothStepPath: () => ["", 0, 0],
    ReactFlow: (props: Record<string, unknown>) => {
      const nodes = (props.nodes ?? []) as MockNode[];
      const edges = (props.edges ?? []) as MockEdge[];
      const onInit = props.onInit as
        | ((instance: {
            fitView: typeof flowSpies.fitView;
            setViewport: typeof flowSpies.setViewport;
            getViewport: typeof flowSpies.getViewport;
          }) => void)
        | undefined;
      const onNodeClick = props.onNodeClick as
        | ((event: unknown, node: MockNode) => void)
        | undefined;
      const onEdgeClick = props.onEdgeClick as
        | ((event: unknown, edge: MockEdge) => void)
        | undefined;
      const onNodesChange = props.onNodesChange as
        | ((
            changes: Array<{ type: "position"; id: string; position: { x: number; y: number } }>,
          ) => void)
        | undefined;
      const onNodeDragStop = props.onNodeDragStop as
        | ((event: unknown, node: MockNode) => void)
        | undefined;
      const onMoveEnd = props.onMoveEnd as
        | ((event: unknown, viewport: { x: number; y: number; zoom: number }) => void)
        | undefined;
      React.useEffect(
        () =>
          onInit?.({
            fitView: flowSpies.fitView,
            setViewport: flowSpies.setViewport,
            getViewport: flowSpies.getViewport,
          }),
        [onInit],
      );
      const firstNode = nodes[0];
      return (
        <div role="application" aria-label={String(props["aria-label"])}>
          {nodes.map((node) => (
            <button
              type="button"
              key={node.id}
              aria-label={`Canvas table ${node.data.name ?? node.id}`}
              data-position={`${node.position.x},${node.position.y}`}
              onClick={(event) => onNodeClick?.(event, node)}
            >
              {node.data.name ?? node.id}
            </button>
          ))}
          {edges.map((edge) => (
            <button
              type="button"
              key={edge.id}
              aria-label={`Canvas relationship ${edge.id}`}
              onClick={(event) => onEdgeClick?.(event, edge)}
            >
              {edge.id}
            </button>
          ))}
          {firstNode ? (
            <button
              type="button"
              aria-label="Simulate node drag"
              onClick={() => {
                const moved: MockNode = { ...firstNode, position: { x: 700, y: 800 } };
                onNodesChange?.([{ type: "position", id: moved.id, position: moved.position }]);
                onNodeDragStop?.({}, moved);
              }}
            >
              Drag
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Simulate user pan"
            onClick={() => onMoveEnd?.({}, { x: 30, y: 40, zoom: 1.2 })}
          >
            Pan
          </button>
          <button
            type="button"
            aria-label="Simulate programmatic pan"
            onClick={() => onMoveEnd?.(null, { x: 50, y: 60, zoom: 1 })}
          >
            Programmatic pan
          </button>
        </div>
      );
    },
  };
});

import { BaseSchemaDiagram } from "../src/diagram/base-schema-diagram.js";
import { demoSchemaGraph } from "../src/diagram/demo-schema.js";
import {
  createBaseDiagramProjection,
  createDiagramProjection,
  createDiagramVisibility,
} from "../src/diagram/projection.js";
import { SchemaOutline } from "../src/diagram/schema-outline.js";
import { createDiagramSelectionStore } from "../src/diagram/selection-store.js";
import {
  createDiagramNavigationIndex,
  findDiagramSelectionAtCursor,
} from "../src/diagram/source-navigation.js";
import type { DiagramProjection, TableDiagramNode } from "../src/diagram/types.js";

const BASE_SOURCE = `TablePartial audit_fields {
  tenant_id int
}

TableGroup domain {
  accounts
  posts
}

Table accounts {
  tenant_id int
  id int

  indexes {
    (tenant_id, id) [pk]
  }
}

Table posts {
  ~audit_fields
  id int [pk]
  account_id int
  parent_account_id int
  inactive_account_id int
}

Table profiles {
  id int [pk]
  account_id int
}

Table tags {
  id int [pk]
}

Ref many_to_one: posts.account_id > accounts.id
Ref one_to_many: accounts.id < posts.parent_account_id
Ref one_to_one: accounts.id - profiles.account_id
Ref many_to_many: posts.id <> tags.id
Ref inactive_ref: posts.inactive_account_id > accounts.tenant_id [inactive]
`;

beforeAll(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  cleanup();
  flowSpies.fitView.mockClear();
  flowSpies.setViewport.mockClear();
  flowSpies.getViewport.mockClear();
});

describe("base schema diagram projection", () => {
  it("projects flat tables, complete PK/FK traits, partial provenance and reference direction", async () => {
    const graph = await parseGraph(BASE_SOURCE);
    const projection = createBaseDiagramProjection(graph);
    const tables = projection.nodes.filter(
      (node): node is TableDiagramNode => node.type === "table",
    );

    expect(tables).toHaveLength(4);
    expect(tables.every((table) => table.parentId === undefined)).toBe(true);
    expect(projection.nodes.some((node) => node.type === "group")).toBe(false);
    expect(projection.edges).toHaveLength(5);

    const accounts = tableByName(tables, "accounts");
    expect(columnByName(accounts, "tenant_id")).toMatchObject({
      primaryKey: true,
      foreignKey: false,
    });
    expect(columnByName(accounts, "id")).toMatchObject({
      primaryKey: true,
      foreignKey: false,
    });

    const posts = tableByName(tables, "posts");
    expect(columnByName(posts, "tenant_id")).toMatchObject({
      partialName: "audit_fields",
    });
    expect(columnByName(posts, "id")).toMatchObject({
      primaryKey: true,
      foreignKey: false,
    });
    expect(columnByName(posts, "account_id")).toMatchObject({ foreignKey: true });
    expect(columnByName(posts, "parent_account_id")).toMatchObject({ foreignKey: true });
    expect(columnByName(posts, "inactive_account_id")).toMatchObject({ foreignKey: false });

    const profiles = tableByName(tables, "profiles");
    expect(columnByName(profiles, "account_id")).toMatchObject({ foreignKey: true });

    expect(edgeByName(projection.edges, "many_to_one")).toMatchObject({
      source: posts.id,
      target: accounts.id,
      data: { inactive: false },
    });
    expect(edgeByName(projection.edges, "one_to_many")).toMatchObject({
      source: posts.id,
      target: accounts.id,
    });
    expect(edgeByName(projection.edges, "one_to_one")).toMatchObject({
      source: profiles.id,
      target: accounts.id,
    });
    expect(edgeByName(projection.edges, "many_to_many")).toMatchObject({
      source: posts.id,
      target: tableByName(tables, "tags").id,
    });
    expect(edgeByName(projection.edges, "inactive_ref")).toMatchObject({
      data: { inactive: true },
      style: { strokeDasharray: "6 4" },
    });
    expect(edgeByName(projection.edges, "many_to_one").ariaLabel).toContain("posts.account_id");
    expect(edgeByName(projection.edges, "many_to_one").ariaLabel).toContain("accounts.id");
  });

  it("matches the public fidelity fixture inventory without product group nodes", async () => {
    const graph = await parseGraph(generateFidelityFixture());
    const projection = createBaseDiagramProjection(graph);
    const tables = projection.nodes.filter((node) => node.type === "table");

    expect(tables).toHaveLength(fixtureInventory.fidelity.tables);
    expect(projection.edges).toHaveLength(fixtureInventory.fidelity.references);
    expect(projection.nodes.some((node) => node.type === "group")).toBe(false);
    expect(
      tables.reduce(
        (count, table) => count + (table.type === "table" ? table.data.columns.length : 0),
        0,
      ),
    ).toBe(graph.tables.reduce((count, table) => count + table.columns.length, 0));
  });
});

describe("diagram source navigation", () => {
  it("selects the narrowest matching UTF-16 range and resolves references", async () => {
    const source = `// 한글 😀\r\n${BASE_SOURCE.replaceAll("\n", "\r\n")}`;
    const graph = await parseGraph(source);
    const index = createDiagramNavigationIndex(graph);
    const accountColumnOffset = source.indexOf("account_id int");
    const referenceOffset = source.indexOf("Ref many_to_one") + 5;

    expect(
      findDiagramSelectionAtCursor(index, {
        filepath: "/main.dbml",
        offset: accountColumnOffset,
      }),
    ).toMatchObject({ kind: "column" });
    expect(
      findDiagramSelectionAtCursor(index, {
        filepath: "/main.dbml",
        offset: referenceOffset,
      }),
    ).toMatchObject({ kind: "reference" });
    expect(
      findDiagramSelectionAtCursor(index, {
        filepath: "/other.dbml",
        offset: accountColumnOffset,
      }),
    ).toBeNull();
  });

  it("provides equivalent diagram and source actions through the accessible outline", async () => {
    const graph = await parseGraph(BASE_SOURCE);
    const selectionStore = createDiagramSelectionStore();
    const onNavigateSource = vi.fn();
    const rendered = render(
      <SchemaOutline
        graph={graph}
        visibility={createDiagramVisibility(graph, "GLOBAL")}
        viewLabel="Global"
        collapsedGroupKeys={new Set()}
        selectionStore={selectionStore}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={onNavigateSource}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Focus public.accounts in diagram" }));
    expect(
      screen.getByRole("button", { name: "Focus public.accounts in diagram" }),
    ).toHaveAttribute("aria-current", "true");

    const accounts = graph.tables.find((table) => table.name === "accounts");
    if (!accounts) throw new Error("Missing accounts table.");
    const tableRange = graph.sourceMap[accounts.key];
    fireEvent.click(
      screen.getByRole("button", {
        name: `Open source for table at line ${tableRange?.startLine}`,
      }),
    );
    expect(onNavigateSource).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "table", elementKey: expect.any(String) }),
    );

    rendered.rerender(
      <SchemaOutline
        graph={graph}
        visibility={createDiagramVisibility(graph, "GLOBAL")}
        viewLabel="Global"
        collapsedGroupKeys={new Set()}
        selectionStore={selectionStore}
        sourceNavigationEnabled={false}
        onToggleGroup={vi.fn()}
        onNavigateSource={onNavigateSource}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: `Open source for table at line ${tableRange?.startLine}`,
      }),
    ).toBeDisabled();
  });

  it("renders quoted and script-like identifiers as inert outline text", async () => {
    const graph = await parseGraph('Table "<script>😀" { "열<id>" int }');
    render(
      <SchemaOutline
        graph={graph}
        visibility={createDiagramVisibility(graph, "GLOBAL")}
        viewLabel="Global"
        collapsedGroupKeys={new Set()}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={vi.fn()}
      />,
    );

    expect(screen.getByText("public.<script>😀", { exact: true })).toBeVisible();
    expect(document.body.querySelector("script")).toBeNull();
  });
});

describe("base schema diagram canvas", () => {
  it("projects the selected view and LOD while keeping stable element identity", async () => {
    const identityView = demoSchemaGraph.views.find((view) => view.name === "identity_only");
    const identityGroup = demoSchemaGraph.groups.find((group) => group.name === "Identity");
    if (!identityView || !identityGroup) throw new Error("Missing identity view fixture.");
    const requestLayout = vi.fn(async (projection: DiagramProjection) => projection);
    const fullProjection = createDiagramProjection(demoSchemaGraph, {
      viewKey: identityView.key,
      collapsedGroupKeys: new Set(),
      lod: "FULL",
    });
    const rendered = render(
      <BaseSchemaDiagram
        graph={demoSchemaGraph}
        viewKey={identityView.key}
        detailLevel="FULL"
        collapsedGroupKeys={new Set()}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={vi.fn()}
        requestLayout={requestLayout}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("base-diagram-layout-status")).toHaveTextContent(
        "Diagram layout ready",
      ),
    );
    expect(requestLayout).not.toHaveBeenCalled();
    expect(fullProjection.nodes.filter((node) => node.type === "table")).toHaveLength(2);
    expect(fullProjection.edges).toHaveLength(1);

    rendered.rerender(
      <BaseSchemaDiagram
        graph={demoSchemaGraph}
        viewKey={identityView.key}
        detailLevel="NAME_ONLY"
        collapsedGroupKeys={new Set()}
        focusRequest={{
          requestId: 1,
          tableKeys: identityGroup.tableKeys,
          groupKeys: [identityGroup.key],
        }}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={vi.fn()}
        requestLayout={requestLayout}
      />,
    );
    const nameProjection = createDiagramProjection(demoSchemaGraph, {
      viewKey: identityView.key,
      collapsedGroupKeys: new Set(),
      lod: "NAME_ONLY",
    });
    await waitFor(() =>
      expect(screen.getByTestId("base-diagram-layout-status")).toHaveTextContent(
        "Diagram layout ready",
      ),
    );
    expect(requestLayout).not.toHaveBeenCalled();
    expect(nameProjection.nodes.map((node) => node.id)).toEqual(
      fullProjection.nodes.map((node) => node.id),
    );
    expect(nameProjection.edges.map((edge) => edge.id)).toEqual(
      fullProjection.edges.map((edge) => edge.id),
    );
    expect(
      nameProjection.nodes
        .filter((node) => node.type === "table")
        .every((node) => node.data.lod === "NAME_ONLY"),
    ).toBe(true);
    await waitFor(() =>
      expect(flowSpies.fitView).toHaveBeenCalledWith(
        expect.objectContaining({
          nodes: expect.arrayContaining([expect.objectContaining({ id: identityGroup.key })]),
        }),
      ),
    );
  });

  it("distinguishes an empty DiagramView from an empty Global schema", () => {
    const template = demoSchemaGraph.views[0];
    if (!template) throw new Error("Missing view fixture.");
    const emptyView = {
      ...template,
      key: 'view:[null,"empty"]',
      name: "empty",
      visibleTableKeys: null,
      visibleGroupKeys: null,
      visibleSchemaNames: null,
    };
    const graph = { ...demoSchemaGraph, views: [...demoSchemaGraph.views, emptyView] };
    const requestLayout = vi.fn();

    render(
      <BaseSchemaDiagram
        graph={graph}
        viewKey={emptyView.key}
        detailLevel="FULL"
        collapsedGroupKeys={new Set()}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={vi.fn()}
        requestLayout={requestLayout}
      />,
    );

    expect(screen.getByText("No tables are visible in empty")).toBeVisible();
    expect(requestLayout).not.toHaveBeenCalled();
  });

  it("skips worker layout for an empty valid graph", async () => {
    const graph = await parseGraph("");
    const requestLayout = vi.fn();
    render(
      <BaseSchemaDiagram
        graph={graph}
        viewKey="GLOBAL"
        detailLevel="FULL"
        collapsedGroupKeys={new Set()}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={vi.fn()}
        requestLayout={requestLayout}
      />,
    );

    expect(screen.getByText("No tables in this valid draft")).toBeVisible();
    expect(requestLayout).not.toHaveBeenCalled();
  });

  it("discards stale layout results and focuses stable-key selections", async () => {
    const firstGraph = await parseGraph("Table first { id int [pk] }");
    const secondGraph = await parseGraph("Table second { id int [pk] }");
    const firstLayout = deferred<ReturnType<typeof createBaseDiagramProjection>>();
    const secondLayout = deferred<ReturnType<typeof createBaseDiagramProjection>>();
    const requestLayout = vi
      .fn()
      .mockImplementationOnce(() => firstLayout.promise)
      .mockImplementationOnce(() => secondLayout.promise);
    const selectionStore = createDiagramSelectionStore();
    const onNavigateSource = vi.fn();
    const rendered = render(
      <BaseSchemaDiagram
        graph={firstGraph}
        viewKey="GLOBAL"
        detailLevel="FULL"
        collapsedGroupKeys={new Set()}
        selectionStore={selectionStore}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={onNavigateSource}
        requestLayout={requestLayout}
        layoutRequest={{ requestId: 1, mode: "PREVIEW" }}
      />,
    );

    rendered.rerender(
      <BaseSchemaDiagram
        graph={secondGraph}
        viewKey="GLOBAL"
        detailLevel="FULL"
        collapsedGroupKeys={new Set()}
        selectionStore={selectionStore}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={onNavigateSource}
        requestLayout={requestLayout}
        layoutRequest={{ requestId: 2, mode: "PREVIEW" }}
      />,
    );
    await act(() => {
      secondLayout.resolve(createBaseDiagramProjection(secondGraph));
      return secondLayout.promise;
    });
    await act(() => {
      firstLayout.resolve(createBaseDiagramProjection(firstGraph));
      return firstLayout.promise;
    });

    expect(screen.getByRole("button", { name: "Canvas table second" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Canvas table first" })).not.toBeInTheDocument();
    expect(requestLayout).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Canvas table second" }));
    expect(selectionStore.getState().selection).toMatchObject({ kind: "table" });
    expect(onNavigateSource).toHaveBeenCalledOnce();
    await waitFor(() => expect(flowSpies.fitView).toHaveBeenCalled());
  });

  it("derives deterministic positions without invoking the layout worker", async () => {
    const graph = await parseGraph("Table fallback { id int [pk] }");
    const requestLayout = vi.fn().mockRejectedValue(new Error("must not be called"));

    render(
      <BaseSchemaDiagram
        graph={graph}
        viewKey="GLOBAL"
        detailLevel="FULL"
        collapsedGroupKeys={new Set()}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled={false}
        onToggleGroup={vi.fn()}
        onNavigateSource={vi.fn()}
        requestLayout={requestLayout}
      />,
    );

    expect(await screen.findByTestId("base-diagram-layout-status")).toHaveTextContent(
      "Diagram layout ready",
    );
    expect(screen.getByRole("button", { name: "Canvas table fallback" })).toHaveAttribute(
      "data-position",
      "0,0",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(requestLayout).not.toHaveBeenCalled();
  });

  it("overlays saved positions, restores viewport, and emits only user layout changes", async () => {
    const graph = await parseGraph("Table positioned { id int [pk] }");
    const table = graph.tables[0];
    if (!table) throw new Error("Missing positioned table.");
    const requestLayout = vi.fn(async (projection: DiagramProjection) => projection);
    const onPositionsCommit = vi.fn();
    const onViewportCommit = vi.fn();
    const onRenderedLayoutReady = vi.fn();

    render(
      <BaseSchemaDiagram
        graph={graph}
        viewKey="GLOBAL"
        detailLevel="FULL"
        collapsedGroupKeys={new Set()}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={vi.fn()}
        requestLayout={requestLayout}
        layoutPositions={{ [table.key]: { x: 400, y: 500 } }}
        layoutViewport={{ x: 5, y: 6, zoom: 0.8 }}
        onPositionsCommit={onPositionsCommit}
        onViewportCommit={onViewportCommit}
        onRenderedLayoutReady={onRenderedLayoutReady}
      />,
    );

    const tableButton = await screen.findByRole("button", { name: "Canvas table positioned" });
    await waitFor(() => expect(tableButton).toHaveAttribute("data-position", "400,500"));
    expect(requestLayout).not.toHaveBeenCalled();
    expect(flowSpies.setViewport).toHaveBeenCalledWith({ x: 5, y: 6, zoom: 0.8 });
    await waitFor(() =>
      expect(onRenderedLayoutReady).toHaveBeenCalledWith(
        expect.objectContaining({ [table.key]: { x: 400, y: 500 } }),
        { x: 10, y: 20, zoom: 0.75 },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Simulate node drag" }));
    expect(onPositionsCommit).toHaveBeenCalledWith(
      expect.objectContaining({ [table.key]: { x: 700, y: 800 } }),
    );
    expect(onViewportCommit).toHaveBeenCalledWith({ x: 10, y: 20, zoom: 0.75 });
    onViewportCommit.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Simulate programmatic pan" }));
    expect(onViewportCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Simulate user pan" }));
    expect(onViewportCommit).toHaveBeenCalledWith({ x: 30, y: 40, zoom: 1.2 });
  });

  it("reports failed preview layout without treating fallback positions as applicable", async () => {
    const graph = await parseGraph("Table preview_failure { id int [pk] }");
    const onLayoutRequestReady = vi.fn();
    render(
      <BaseSchemaDiagram
        graph={graph}
        viewKey="GLOBAL"
        detailLevel="FULL"
        collapsedGroupKeys={new Set()}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled={false}
        onToggleGroup={vi.fn()}
        onNavigateSource={vi.fn()}
        requestLayout={vi.fn().mockRejectedValue(new Error("private graph"))}
        layoutRequest={{ requestId: 7, mode: "PREVIEW" }}
        onLayoutRequestReady={onLayoutRequestReady}
      />,
    );

    await waitFor(() =>
      expect(onLayoutRequestReady).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 7, mode: "PREVIEW", succeeded: false }),
      ),
    );
  });
});

async function parseGraph(source: string) {
  const result = await parseDbmlV2(source);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.graph;
}

function tableByName(tables: TableDiagramNode[], name: string): TableDiagramNode {
  const table = tables.find((candidate) => candidate.data.name === name);
  if (!table) throw new Error(`Missing table ${name}`);
  return table;
}

function columnByName(table: TableDiagramNode, name: string) {
  const column = table.data.columns.find((candidate) => candidate.name === name);
  if (!column) throw new Error(`Missing column ${table.data.name}.${name}`);
  return column;
}

function edgeByName(edges: ReturnType<typeof createBaseDiagramProjection>["edges"], name: string) {
  const edge = edges.find((candidate) => candidate.data.referenceName === name);
  if (!edge) throw new Error(`Missing reference ${name}`);
  return edge;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
