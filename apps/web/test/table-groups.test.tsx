// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { parseDbmlV2, type SchemaGraph } from "@er-diagram/core";
import { fixtureInventory, generateFidelityFixture } from "@er-diagram/test-fixtures";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const flowSpies = vi.hoisted(() => ({
  fitView: vi.fn(),
}));

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  type MockNode = {
    id: string;
    type: string;
    data: Record<string, unknown>;
  };
  type MockEdge = {
    id: string;
    label?: string;
    selectable?: boolean;
    selected?: boolean;
  };
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
      const nodeTypes = props.nodeTypes as Record<
        string,
        React.ComponentType<Record<string, unknown>>
      >;
      const onInit = props.onInit as
        | ((instance: { fitView: typeof flowSpies.fitView }) => void)
        | undefined;
      const onNodeClick = props.onNodeClick as
        | ((event: React.MouseEvent, node: MockNode) => void)
        | undefined;
      const onEdgeClick = props.onEdgeClick as
        | ((event: React.MouseEvent, edge: MockEdge) => void)
        | undefined;
      React.useEffect(() => onInit?.({ fitView: flowSpies.fitView }), [onInit]);
      return (
        <div role="application" aria-label={String(props["aria-label"])}>
          {nodes.map((node) => {
            const Component = nodeTypes[node.type];
            return (
              <React.Fragment key={node.id}>
                <div data-testid={`canvas-node-${node.id}`}>
                  {Component ? <Component {...node} /> : node.id}
                </div>
                <button
                  type="button"
                  aria-label={`Select canvas node ${node.id}`}
                  onClick={(event) => onNodeClick?.(event, node)}
                >
                  Select
                </button>
              </React.Fragment>
            );
          })}
          {edges.map((edge) => (
            <button
              type="button"
              key={edge.id}
              data-testid={`canvas-edge-${edge.id}`}
              data-selected={edge.selected ? "true" : "false"}
              disabled={edge.selectable === false}
              onClick={(event) => onEdgeClick?.(event, edge)}
            >
              {edge.label ?? edge.id}
            </button>
          ))}
        </div>
      );
    },
  };
});

import { BaseSchemaDiagram } from "../src/diagram/base-schema-diagram.js";
import {
  retainAvailableCollapsedGroups,
  toggleCollapsedGroup,
} from "../src/diagram/collapse-state.js";
import {
  createDiagramVisibility,
  createGroupedDiagramProjection,
} from "../src/diagram/projection.js";
import { SchemaOutline } from "../src/diagram/schema-outline.js";
import { createDiagramSelectionStore } from "../src/diagram/selection-store.js";
import {
  createDiagramNavigationIndex,
  findDiagramSelectionAtCursor,
} from "../src/diagram/source-navigation.js";
import type {
  DiagramProjection,
  GroupDiagramNode,
  TableDiagramNode,
} from "../src/diagram/types.js";

const GROUP_SOURCE = `TableGroup "도메인<script>😀" [color: #778899] {
  alpha
  beta
}

TableGroup external [color: #112233] {
  gamma
}

Table alpha {
  id int [pk]
  beta_id int
  gamma_id int
  second_gamma_id int
  inactive_gamma_id int
}

Table beta {
  id int [pk]
  alpha_id int
}

Table gamma {
  id int [pk]
  beta_id int
}

Table ungrouped {
  id int [pk]
  alpha_id int
}

Ref internal_alpha_beta: alpha.beta_id > beta.id
Ref internal_beta_alpha: beta.alpha_id > alpha.id
Ref alpha_gamma: alpha.gamma_id > gamma.id
Ref alpha_gamma_second: alpha.second_gamma_id > gamma.id
Ref gamma_beta: gamma.beta_id > beta.id
Ref inactive_alpha_gamma: alpha.inactive_gamma_id > gamma.id [inactive]
Ref ungrouped_alpha: ungrouped.alpha_id > alpha.id
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

describe("TableGroup diagram projection", () => {
  let graph: SchemaGraph;

  beforeAll(async () => {
    graph = await parseGraph(GROUP_SOURCE);
  });

  it("projects source groups as compound parents and leaves ungrouped tables at the root", () => {
    const projection = createGroupedDiagramProjection(graph, new Set());
    const groups = groupNodes(projection);
    const tables = tableNodes(projection);
    const domainGroup = groupByName(groups, "도메인<script>😀");
    const externalGroup = groupByName(groups, "external");

    expect(groups).toHaveLength(2);
    expect(tables).toHaveLength(4);
    expect(projection.nodes.slice(0, groups.length).every((node) => node.type === "group")).toBe(
      true,
    );
    expect(domainGroup.data).toMatchObject({
      schemaName: "public",
      tableCount: 2,
      color: "#778899",
      collapsed: false,
    });
    expect(domainGroup.data.tableKeys).toHaveLength(2);
    expect(externalGroup.data.tableKeys).toHaveLength(1);

    expect(tableByName(tables, "alpha")).toMatchObject({
      parentId: domainGroup.id,
      extent: "parent",
    });
    expect(tableByName(tables, "beta")).toMatchObject({
      parentId: domainGroup.id,
      extent: "parent",
    });
    expect(tableByName(tables, "gamma")).toMatchObject({
      parentId: externalGroup.id,
      extent: "parent",
    });
    expect(tableByName(tables, "ungrouped").parentId).toBeUndefined();
    expect(projection.edges).toHaveLength(7);
  });

  it("hides internal relationships and aggregates only directed external relationships", () => {
    const domainGroup = graph.groups.find((group) => group.name === "도메인<script>😀");
    const externalGroup = graph.groups.find((group) => group.name === "external");
    if (!domainGroup || !externalGroup) throw new Error("Expected both groups.");

    const projection = createGroupedDiagramProjection(
      graph,
      new Set([domainGroup.key, externalGroup.key]),
    );
    const tables = tableNodes(projection);

    expect(tables.map((table) => table.data.name)).toEqual(["ungrouped"]);
    expect(projection.edges).toHaveLength(4);
    expect(
      projection.edges.some(
        (edge) => edge.source === domainGroup.key && edge.target === domainGroup.key,
      ),
    ).toBe(false);

    const domainToExternal = projection.edges.find(
      (edge) =>
        edge.source === domainGroup.key &&
        edge.target === externalGroup.key &&
        edge.data.inactive === false,
    );
    expect(domainToExternal).toMatchObject({
      data: {
        aggregate: true,
        count: 2,
      },
      label: "×2 relationships",
      selectable: false,
    });
    expect(new Set(domainToExternal?.data.referenceKeys)).toEqual(
      new Set(
        graph.references
          .filter((reference) =>
            ["alpha_gamma", "alpha_gamma_second"].includes(reference.name ?? ""),
          )
          .map((reference) => reference.key),
      ),
    );

    const externalToDomain = projection.edges.find(
      (edge) => edge.source === externalGroup.key && edge.target === domainGroup.key,
    );
    expect(externalToDomain?.data).toMatchObject({ aggregate: false, count: 1 });

    const inactive = projection.edges.find((edge) => edge.data.inactive === true);
    expect(inactive).toMatchObject({
      source: domainGroup.key,
      target: externalGroup.key,
      data: { aggregate: false, count: 1 },
      style: { strokeDasharray: "6 4" },
    });

    const ungrouped = tableByName(tables, "ungrouped");
    expect(
      projection.edges.some(
        (edge) => edge.source === ungrouped.id && edge.target === domainGroup.key,
      ),
    ).toBe(true);
    expect(projection.edges.reduce((count, edge) => count + edge.data.count, 0)).toBe(5);
  });

  it("creates stable summary edge ids when unrelated references are reordered", () => {
    const collapsedGroupKeys = new Set(graph.groups.map((group) => group.key));
    const projection = createGroupedDiagramProjection(graph, collapsedGroupKeys);
    const reorderedGraph = { ...graph, references: [...graph.references].reverse() };
    const reordered = createGroupedDiagramProjection(reorderedGraph, collapsedGroupKeys);

    expect(summaryEdgeIds(reordered)).toEqual(summaryEdgeIds(projection));
  });

  it("keeps collapse state outside schema semantics and prunes deleted stable group keys", () => {
    const sourceHash = graph.schemaHash;
    const firstGroup = graph.groups[0];
    const secondGroup = graph.groups[1];
    if (!firstGroup || !secondGroup) throw new Error("Expected both groups.");

    const collapsed = toggleCollapsedGroup(new Set(), firstGroup.key);
    createGroupedDiagramProjection(graph, collapsed);
    expect(graph.schemaHash).toBe(sourceHash);

    const retained = retainAvailableCollapsedGroups(
      new Set([firstGroup.key, secondGroup.key]),
      new Set([secondGroup.key]),
    );
    expect([...retained]).toEqual([secondGroup.key]);
  });

  it("preserves the fidelity fixture group and expanded relationship inventory", async () => {
    const fidelityGraph = await parseGraph(generateFidelityFixture());
    const projection = createGroupedDiagramProjection(fidelityGraph, new Set());

    expect(groupNodes(projection)).toHaveLength(fixtureInventory.fidelity.tableGroups);
    expect(tableNodes(projection)).toHaveLength(fixtureInventory.fidelity.tables);
    expect(projection.edges).toHaveLength(fixtureInventory.fidelity.references);
  });
});

describe("TableGroup navigation and collapse interactions", () => {
  let graph: SchemaGraph;

  beforeAll(async () => {
    graph = await parseGraph(GROUP_SOURCE);
  });

  it("indexes the TableGroup source range as a navigable group", () => {
    const group = graph.groups[0];
    if (!group) throw new Error("Expected a group.");
    const index = createDiagramNavigationIndex(graph);

    expect(
      findDiagramSelectionAtCursor(index, {
        filepath: group.range.filepath,
        offset: group.range.startOffset + 1,
      }),
    ).toEqual({
      elementKey: group.key,
      kind: "group",
      tableKeys: group.tableKeys,
    });
  });

  it("toggles a compound group without also navigating to source", async () => {
    const group = graph.groups[0];
    if (!group) throw new Error("Expected a group.");
    const onToggleGroup = vi.fn();
    const onNavigateSource = vi.fn();

    render(
      <BaseSchemaDiagram
        graph={graph}
        viewKey="GLOBAL"
        detailLevel="FULL"
        collapsedGroupKeys={new Set()}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled
        onToggleGroup={onToggleGroup}
        onNavigateSource={onNavigateSource}
        requestLayout={async (projection) => projection}
      />,
    );

    const toggle = await screen.findByRole("button", {
      name: "Collapse public.도메인<script>😀",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(onToggleGroup).toHaveBeenCalledWith(group.key);
    expect(onNavigateSource).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: `Select canvas node ${group.key}` }));
    expect(onNavigateSource).toHaveBeenCalledWith({
      elementKey: group.key,
      kind: "group",
      tableKeys: group.tableKeys,
    });
  });

  it("shows an invalid source color as text without applying it to CSS", async () => {
    const group = graph.groups[0];
    if (!group) throw new Error("Expected a group.");
    const unsafeColorGraph: SchemaGraph = {
      ...graph,
      groups: graph.groups.map((candidate) =>
        candidate.key === group.key
          ? { ...candidate, color: "url(javascript:alert(1))" }
          : candidate,
      ),
    };

    render(
      <BaseSchemaDiagram
        graph={unsafeColorGraph}
        viewKey="GLOBAL"
        detailLevel="FULL"
        collapsedGroupKeys={new Set()}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={vi.fn()}
        requestLayout={async (projection) => projection}
      />,
    );

    const renderedGroup = await screen.findByLabelText(
      /Table group public\.도메인<script>😀, 2 tables, expanded, Color url/,
    );
    expect(renderedGroup).toHaveTextContent("Color url(javascript:alert(1))");
    expect(renderedGroup).not.toHaveAttribute("style");
  });

  it("keeps exact hidden selections while highlighting representative groups and summary edges", async () => {
    const collapsedGroupKeys = new Set(graph.groups.map((group) => group.key));
    const reference = graph.references.find((candidate) => candidate.name === "alpha_gamma");
    if (!reference) throw new Error("Expected alpha_gamma.");
    const selectionStore = createDiagramSelectionStore();
    selectionStore.getState().setSelection({
      elementKey: reference.key,
      kind: "reference",
      tableKeys: reference.endpoints.map((endpoint) => endpoint.tableKey),
    });
    const onNavigateSource = vi.fn();

    render(
      <BaseSchemaDiagram
        graph={graph}
        viewKey="GLOBAL"
        detailLevel="FULL"
        collapsedGroupKeys={collapsedGroupKeys}
        selectionStore={selectionStore}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={onNavigateSource}
        requestLayout={async (projection) => projection}
      />,
    );

    const projection = createGroupedDiagramProjection(graph, collapsedGroupKeys);
    const summary = projection.edges.find((edge) =>
      edge.data.referenceKeys.includes(reference.key),
    );
    if (!summary) throw new Error("Expected a representative edge.");
    await waitFor(() =>
      expect(screen.getByTestId(`canvas-edge-${summary.id}`)).toHaveAttribute(
        "data-selected",
        "true",
      ),
    );
    expect(screen.getByTestId(`canvas-edge-${summary.id}`)).toBeDisabled();
    expect(selectionStore.getState().selection?.elementKey).toBe(reference.key);
    expect(onNavigateSource).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(flowSpies.fitView).toHaveBeenCalledWith(
        expect.objectContaining({
          nodes: expect.arrayContaining([expect.objectContaining({ type: "group" })]),
        }),
      ),
    );
  });

  it("provides group membership, collapse and revision-safe source actions in the outline", () => {
    const group = graph.groups[0];
    if (!group) throw new Error("Expected a group.");
    const onToggleGroup = vi.fn();
    const onNavigateSource = vi.fn();
    const selectionStore = createDiagramSelectionStore();
    const rendered = render(
      <SchemaOutline
        graph={graph}
        visibility={createDiagramVisibility(graph, "GLOBAL")}
        viewLabel="Global"
        collapsedGroupKeys={new Set()}
        selectionStore={selectionStore}
        sourceNavigationEnabled
        onToggleGroup={onToggleGroup}
        onNavigateSource={onNavigateSource}
      />,
    );

    expect(screen.getByRole("heading", { name: "Table groups" })).toBeVisible();
    expect(screen.getByText("public.도메인<script>😀", { exact: true })).toBeVisible();
    expect(screen.getByText(/Color #778899/)).toBeVisible();
    expect(screen.getByText("alpha, beta", { exact: true })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse public.도메인<script>😀 in diagram" }),
    );
    expect(onToggleGroup).toHaveBeenCalledWith(group.key);

    const sourceAction = screen.getByRole("button", {
      name: `Open source for group at line ${group.range.startLine}`,
    });
    fireEvent.click(sourceAction);
    expect(onNavigateSource).toHaveBeenCalledWith({
      elementKey: group.key,
      kind: "group",
      tableKeys: group.tableKeys,
    });

    rendered.rerender(
      <SchemaOutline
        graph={graph}
        visibility={createDiagramVisibility(graph, "GLOBAL")}
        viewLabel="Global"
        collapsedGroupKeys={new Set()}
        selectionStore={selectionStore}
        sourceNavigationEnabled={false}
        onToggleGroup={onToggleGroup}
        onNavigateSource={onNavigateSource}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: `Open source for group at line ${group.range.startLine}`,
      }),
    ).toBeDisabled();
  });

  it("switches collapse projections without invoking implicit worker layout", async () => {
    const group = graph.groups[0];
    if (!group) throw new Error("Expected a group.");
    const requestLayout = vi.fn(async (projection: DiagramProjection) => projection);
    const rendered = render(
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

    rendered.rerender(
      <BaseSchemaDiagram
        graph={graph}
        viewKey="GLOBAL"
        detailLevel="FULL"
        collapsedGroupKeys={new Set([group.key])}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={vi.fn()}
        requestLayout={requestLayout}
      />,
    );

    expect(screen.getByRole("button", { name: "Expand public.도메인<script>😀" })).toBeVisible();
    expect(screen.queryByLabelText("Table public.alpha")).not.toBeInTheDocument();
    expect(requestLayout).not.toHaveBeenCalled();
  });
});

async function parseGraph(source: string): Promise<SchemaGraph> {
  const result = await parseDbmlV2(source);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.graph;
}

function groupNodes(projection: DiagramProjection): GroupDiagramNode[] {
  return projection.nodes.filter((node): node is GroupDiagramNode => node.type === "group");
}

function tableNodes(projection: DiagramProjection): TableDiagramNode[] {
  return projection.nodes.filter((node): node is TableDiagramNode => node.type === "table");
}

function groupByName(groups: GroupDiagramNode[], name: string): GroupDiagramNode {
  const group = groups.find((candidate) => candidate.data.name === name);
  if (!group) throw new Error(`Missing group ${name}`);
  return group;
}

function tableByName(tables: TableDiagramNode[], name: string): TableDiagramNode {
  const table = tables.find((candidate) => candidate.data.name === name);
  if (!table) throw new Error(`Missing table ${name}`);
  return table;
}

function summaryEdgeIds(projection: DiagramProjection): string[] {
  return projection.edges
    .filter((edge) => edge.data.aggregate)
    .map((edge) => edge.id)
    .sort();
}
