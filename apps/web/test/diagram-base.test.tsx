// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { parseDbmlV2 } from "@er-diagram/core";
import { fixtureInventory, generateFidelityFixture } from "@er-diagram/test-fixtures";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const flowSpies = vi.hoisted(() => ({ fitView: vi.fn() }));

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  interface MockNode {
    id: string;
    data: { name?: string };
  }
  interface MockEdge {
    id: string;
  }
  return {
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
        | ((instance: { fitView: typeof flowSpies.fitView }) => void)
        | undefined;
      const onNodeClick = props.onNodeClick as
        | ((event: unknown, node: MockNode) => void)
        | undefined;
      const onEdgeClick = props.onEdgeClick as
        | ((event: unknown, edge: MockEdge) => void)
        | undefined;
      React.useEffect(() => onInit?.({ fitView: flowSpies.fitView }), [onInit]);
      return (
        <div role="application" aria-label={String(props["aria-label"])}>
          {nodes.map((node) => (
            <button
              type="button"
              key={node.id}
              aria-label={`Canvas table ${node.data.name ?? node.id}`}
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
        </div>
      );
    },
  };
});

import { BaseSchemaDiagram } from "../src/diagram/base-schema-diagram.js";
import { createBaseDiagramProjection } from "../src/diagram/projection.js";
import { SchemaOutline } from "../src/diagram/schema-outline.js";
import { createDiagramSelectionStore } from "../src/diagram/selection-store.js";
import {
  createDiagramNavigationIndex,
  findDiagramSelectionAtCursor,
} from "../src/diagram/source-navigation.js";
import type { TableDiagramNode } from "../src/diagram/types.js";

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
  flowSpies.fitView.mockReset();
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
  it("skips worker layout for an empty valid graph", async () => {
    const graph = await parseGraph("");
    const requestLayout = vi.fn();
    render(
      <BaseSchemaDiagram
        graph={graph}
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
        collapsedGroupKeys={new Set()}
        selectionStore={selectionStore}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={onNavigateSource}
        requestLayout={requestLayout}
      />,
    );

    rendered.rerender(
      <BaseSchemaDiagram
        graph={secondGraph}
        collapsedGroupKeys={new Set()}
        selectionStore={selectionStore}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={onNavigateSource}
        requestLayout={requestLayout}
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

    fireEvent.click(screen.getByRole("button", { name: "Canvas table second" }));
    expect(selectionStore.getState().selection).toMatchObject({ kind: "table" });
    expect(onNavigateSource).toHaveBeenCalledOnce();
    await waitFor(() => expect(flowSpies.fitView).toHaveBeenCalled());
  });

  it("keeps deterministic fallback positions private and retries a failed layout", async () => {
    const graph = await parseGraph("Table fallback { id int [pk] }");
    const projection = createBaseDiagramProjection(graph);
    const requestLayout = vi
      .fn()
      .mockRejectedValueOnce(new Error("source contents must stay private"))
      .mockResolvedValueOnce(projection);

    render(
      <BaseSchemaDiagram
        graph={graph}
        collapsedGroupKeys={new Set()}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled={false}
        onToggleGroup={vi.fn()}
        onNavigateSource={vi.fn()}
        requestLayout={requestLayout}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Automatic layout failed. Fallback positions are shown.",
    );
    expect(screen.queryByText(/source contents/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry layout" }));
    expect(await screen.findByTestId("base-diagram-layout-status")).toHaveTextContent(
      "Diagram layout ready",
    );
    expect(requestLayout).toHaveBeenCalledTimes(2);
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
