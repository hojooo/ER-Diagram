// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { type DiagramViewNode, parseDbmlV2, type SchemaGraph } from "@er-diagram/core";
import { fixtureInventory, generateFidelityFixture } from "@er-diagram/test-fixtures";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { demoSchemaGraph } from "../src/diagram/demo-schema.js";
import { DiagramWorkspaceControls } from "../src/diagram/diagram-workspace-controls.js";
import {
  createDiagramProjection,
  createDiagramVisibility,
  GLOBAL_VIEW_KEY,
  listDiagramViews,
} from "../src/diagram/projection.js";
import { SchemaOutline } from "../src/diagram/schema-outline.js";
import { searchDiagramVisibility } from "../src/diagram/search-index.js";
import { createDiagramSelectionStore } from "../src/diagram/selection-store.js";
import {
  reconcileDiagramViewSessions,
  resolveDiagramViewKey,
  updateDiagramViewSession,
} from "../src/diagram/view-session-state.js";

afterEach(cleanup);

describe("DiagramView visibility", () => {
  it("lists Global and schema-qualified source views without ambiguous labels", () => {
    const template = requiredView(demoSchemaGraph, "identity_only");
    const qualifiedView: DiagramViewNode = {
      ...template,
      key: 'view:["identity","overview"]',
      schemaName: "identity",
      name: "overview",
    };
    const globalOverview: DiagramViewNode = {
      ...template,
      key: 'view:[null,"overview"]',
      schemaName: null,
      name: "overview",
    };

    const options = listDiagramViews({
      ...demoSchemaGraph,
      views: [qualifiedView, globalOverview],
    });

    expect(options).toEqual([
      { key: GLOBAL_VIEW_KEY, label: "Global" },
      { key: qualifiedView.key, label: "identity.overview" },
      { key: globalOverview.key, label: "overview" },
    ]);
  });

  it("uses one tri-state union for visible tables, groups, schemas, and relationships", () => {
    const identityView = requiredView(demoSchemaGraph, "identity_only");
    const visibility = createDiagramVisibility(demoSchemaGraph, identityView.key);

    expect(namesForTables(demoSchemaGraph, visibility.tableKeys)).toEqual(["profile", "user"]);
    expect(namesForGroups(demoSchemaGraph, visibility.groupKeys)).toEqual(["Identity"]);
    expect(namesForReferences(demoSchemaGraph, visibility.referenceKeys)).toEqual(["profile_user"]);
    expect([...visibility.schemaNames]).toEqual(["identity"]);

    const fullView = requiredView(demoSchemaGraph, "full_schema");
    const fullVisibility = createDiagramVisibility(demoSchemaGraph, fullView.key);
    expect(fullVisibility.tableKeys.size).toBe(demoSchemaGraph.tables.length);
    expect(fullVisibility.groupKeys.size).toBe(demoSchemaGraph.groups.length);
    expect(fullVisibility.referenceKeys.size).toBe(demoSchemaGraph.references.length);

    const emptyView: DiagramViewNode = {
      ...fullView,
      key: 'view:[null,"empty"]',
      name: "empty",
      visibleTableKeys: null,
      visibleGroupKeys: null,
      visibleSchemaNames: null,
    };
    const emptyGraph = { ...demoSchemaGraph, views: [...demoSchemaGraph.views, emptyView] };
    const emptyVisibility = createDiagramVisibility(emptyGraph, emptyView.key);
    expect(emptyVisibility.tableKeys.size).toBe(0);
    expect(emptyVisibility.groupKeys.size).toBe(0);
    expect(emptyVisibility.referenceKeys.size).toBe(0);
    expect(emptyVisibility.schemaNames.size).toBe(0);
  });

  it("renders an explicitly visible table at the root when its group is hidden", () => {
    const template = requiredView(demoSchemaGraph, "identity_only");
    const product = requiredTable(demoSchemaGraph, "product");
    const tableOnlyView: DiagramViewNode = {
      ...template,
      key: 'view:[null,"product-only"]',
      name: "product-only",
      visibleTableKeys: [product.key],
      visibleGroupKeys: null,
      visibleSchemaNames: null,
    };
    const graph = { ...demoSchemaGraph, views: [...demoSchemaGraph.views, tableOnlyView] };

    const projection = createDiagramProjection(graph, {
      viewKey: tableOnlyView.key,
      collapsedGroupKeys: new Set(),
      lod: "FULL",
    });

    expect(projection.nodes).toHaveLength(1);
    expect(projection.nodes[0]).toMatchObject({ id: product.key, type: "table" });
    expect(projection.nodes[0]?.parentId).toBeUndefined();
    expect(projection.edges).toHaveLength(0);
  });
});

describe("current-view search index", () => {
  it("searches only visible tables, columns, groups, and derived schemas", () => {
    const identityView = requiredView(demoSchemaGraph, "identity_only");
    const visibility = createDiagramVisibility(demoSchemaGraph, identityView.key);

    expect(searchDiagramVisibility(demoSchemaGraph, visibility, "user").results[0]).toMatchObject({
      kind: "table",
      qualifiedLabel: "identity.user",
    });
    expect(
      searchDiagramVisibility(demoSchemaGraph, visibility, "user_id").results.map(
        (result) => result.qualifiedLabel,
      ),
    ).toEqual(["identity.profile.user_id"]);
    expect(
      searchDiagramVisibility(demoSchemaGraph, visibility, "identity").results.map(
        (result) => result.kind,
      ),
    ).toContain("schema");
    expect(searchDiagramVisibility(demoSchemaGraph, visibility, "product")).toEqual({
      results: [],
      total: 0,
    });
  });

  it("normalizes NFKC and ranks exact before prefix before substring deterministically", () => {
    const user = requiredTable(demoSchemaGraph, "user");
    const graph: SchemaGraph = {
      ...demoSchemaGraph,
      tables: demoSchemaGraph.tables.map((table) =>
        table.key === user.key ? { ...table, name: "Ｕser" } : table,
      ),
    };
    const visibility = createDiagramVisibility(graph, GLOBAL_VIEW_KEY);
    const search = searchDiagramVisibility(graph, visibility, "user");

    expect(search.results[0]).toMatchObject({
      kind: "table",
      elementKey: user.key,
      qualifiedLabel: "identity.Ｕser",
    });
    expect(search.results.map((result) => result.qualifiedLabel)).toEqual(
      [...search.results.map((result) => result.qualifiedLabel)].sort((left, right) => {
        if (left === "identity.Ｕser") return -1;
        if (right === "identity.Ｕser") return 1;
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    );
  });

  it("returns a focusable schema result and caps displayed results while preserving total", () => {
    const visibility = createDiagramVisibility(demoSchemaGraph, GLOBAL_VIEW_KEY);
    const schemaResult = searchDiagramVisibility(
      demoSchemaGraph,
      visibility,
      "commerce",
    ).results.find((result) => result.kind === "schema");

    expect(schemaResult).toMatchObject({
      kind: "schema",
      schemaName: "commerce",
    });
    expect(schemaResult?.tableKeys).toHaveLength(3);
    expect(schemaResult?.groupKeys).toHaveLength(1);

    const template = requiredTable(demoSchemaGraph, "user");
    const largeGraph: SchemaGraph = {
      ...demoSchemaGraph,
      tables: Array.from({ length: 60 }, (_, index) => ({
        ...template,
        key: `table:["public","match_${index.toString().padStart(2, "0")}"]`,
        schemaName: "public",
        name: `match_${index.toString().padStart(2, "0")}`,
        columns: [],
      })),
      groups: [],
      references: [],
      views: [],
    };
    const limited = searchDiagramVisibility(
      largeGraph,
      createDiagramVisibility(largeGraph, GLOBAL_VIEW_KEY),
      "match",
    );
    expect(limited.results).toHaveLength(50);
    expect(limited.total).toBe(60);
  });

  it("projects a fidelity view within the 300 ms acceptance boundary without reparsing", async () => {
    const parsed = await parseDbmlV2(generateFidelityFixture());
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    const view = parsed.graph.views[1];
    if (!view) throw new Error("Missing fidelity DiagramView");
    const schemaHash = parsed.graph.schemaHash;

    const startedAt = performance.now();
    const projection = createDiagramProjection(parsed.graph, {
      viewKey: view.key,
      collapsedGroupKeys: new Set(),
      lod: "FULL",
    });
    const elapsedMs = performance.now() - startedAt;

    expect(projection.nodes.length).toBeGreaterThan(0);
    expect(parsed.graph.views).toHaveLength(fixtureInventory.fidelity.diagramViews);
    expect(parsed.graph.schemaHash).toBe(schemaHash);
    expect(elapsedMs).toBeLessThan(300);
  });
});

describe("per-view diagram session state", () => {
  it("keeps detail and collapse state independent for every stable view key", () => {
    const identityView = requiredView(demoSchemaGraph, "identity_only");
    const identityGroup = demoSchemaGraph.groups.find((group) => group.name === "Identity");
    if (!identityGroup) throw new Error("Missing identity group");

    let sessions = reconcileDiagramViewSessions(demoSchemaGraph, new Map());
    sessions = updateDiagramViewSession(sessions, GLOBAL_VIEW_KEY, {
      detailLevel: "NAME_ONLY",
      collapsedGroupKeys: new Set(),
    });
    sessions = updateDiagramViewSession(sessions, identityView.key, {
      detailLevel: "KEYS_ONLY",
      collapsedGroupKeys: new Set([identityGroup.key]),
    });

    expect(sessions.get(GLOBAL_VIEW_KEY)).toEqual({
      detailLevel: "NAME_ONLY",
      collapsedGroupKeys: new Set(),
    });
    expect(sessions.get(identityView.key)).toEqual({
      detailLevel: "KEYS_ONLY",
      collapsedGroupKeys: new Set([identityGroup.key]),
    });
    expect(sessions.get(requiredView(demoSchemaGraph, "commerce_only").key)).toEqual({
      detailLevel: "FULL",
      collapsedGroupKeys: new Set(),
    });
  });

  it("falls back to Global and prunes deleted views and groups", () => {
    const identityView = requiredView(demoSchemaGraph, "identity_only");
    const [identityGroup, commerceGroup] = demoSchemaGraph.groups;
    if (!identityGroup || !commerceGroup) throw new Error("Missing groups");

    let sessions = reconcileDiagramViewSessions(demoSchemaGraph, new Map());
    sessions = updateDiagramViewSession(sessions, GLOBAL_VIEW_KEY, {
      detailLevel: "FULL",
      collapsedGroupKeys: new Set([commerceGroup.key]),
    });
    sessions = updateDiagramViewSession(sessions, identityView.key, {
      detailLevel: "KEYS_ONLY",
      collapsedGroupKeys: new Set([identityGroup.key, commerceGroup.key]),
    });
    const nextGraph = {
      ...demoSchemaGraph,
      views: demoSchemaGraph.views.filter((view) => view.key !== identityView.key),
      groups: demoSchemaGraph.groups.filter((group) => group.key !== commerceGroup.key),
    };

    const reconciled = reconcileDiagramViewSessions(nextGraph, sessions);
    expect(reconciled.has(identityView.key)).toBe(false);
    expect(
      [...(reconciled.get(GLOBAL_VIEW_KEY)?.collapsedGroupKeys ?? [])].includes(commerceGroup.key),
    ).toBe(false);
    expect(resolveDiagramViewKey(nextGraph, identityView.key)).toBe(GLOBAL_VIEW_KEY);
  });
});

describe("accessible view, search, and detail controls", () => {
  it("switches source-defined views and detail levels without schema mutations", () => {
    const identityView = requiredView(demoSchemaGraph, "identity_only");
    const visibility = createDiagramVisibility(demoSchemaGraph, identityView.key);
    const onViewChange = vi.fn();
    const onDetailLevelChange = vi.fn();

    render(
      <DiagramWorkspaceControls
        graph={demoSchemaGraph}
        visibility={visibility}
        viewKey={identityView.key}
        detailLevel="FULL"
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        onActivateSearchResult={vi.fn()}
        onViewChange={onViewChange}
        onDetailLevelChange={onDetailLevelChange}
      />,
    );

    const viewSelector = screen.getByRole("combobox", { name: "Diagram view" });
    expect(viewSelector).toHaveValue(identityView.key);
    expect(viewSelector.querySelectorAll("option")).toHaveLength(demoSchemaGraph.views.length + 1);
    fireEvent.change(viewSelector, { target: { value: GLOBAL_VIEW_KEY } });
    expect(onViewChange).toHaveBeenCalledWith(GLOBAL_VIEW_KEY);

    fireEvent.change(screen.getByRole("combobox", { name: "Detail level" }), {
      target: { value: "KEYS_ONLY" },
    });
    expect(onDetailLevelChange).toHaveBeenCalledWith("KEYS_ONLY");
    expect(screen.getByText("2 tables · 1 group · 1 relationship")).toBeVisible();
  });

  it("activates current-view results with an accessible keyboard-only combobox", () => {
    const identityView = requiredView(demoSchemaGraph, "identity_only");
    const visibility = createDiagramVisibility(demoSchemaGraph, identityView.key);
    const onSearchQueryChange = vi.fn();
    const onActivateSearchResult = vi.fn();

    const { rerender } = render(
      <DiagramWorkspaceControls
        graph={demoSchemaGraph}
        visibility={visibility}
        viewKey={identityView.key}
        detailLevel="FULL"
        searchQuery=""
        onSearchQueryChange={onSearchQueryChange}
        onActivateSearchResult={onActivateSearchResult}
        onViewChange={vi.fn()}
        onDetailLevelChange={vi.fn()}
      />,
    );
    const search = screen.getByRole("combobox", { name: "Search current view" });
    fireEvent.change(search, { target: { value: "user" } });
    expect(onSearchQueryChange).toHaveBeenCalledWith("user");

    rerender(
      <DiagramWorkspaceControls
        graph={demoSchemaGraph}
        visibility={visibility}
        viewKey={identityView.key}
        detailLevel="FULL"
        searchQuery="user"
        onSearchQueryChange={onSearchQueryChange}
        onActivateSearchResult={onActivateSearchResult}
        onViewChange={vi.fn()}
        onDetailLevelChange={vi.fn()}
      />,
    );

    expect(search).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("option", { name: /table identity\.user/i })).toBeVisible();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const activeOption = screen.getByRole("option", { name: /table identity\.user/i });
    expect(activeOption).toHaveAttribute("aria-selected", "true");
    expect(search).toHaveAttribute("aria-activedescendant", activeOption.id);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onActivateSearchResult).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "table", qualifiedLabel: "identity.user" }),
    );

    fireEvent.keyDown(search, { key: "Escape" });
    expect(onSearchQueryChange).toHaveBeenLastCalledWith("");
  });

  it("filters the accessible outline with the same visibility inventory", () => {
    const identityView = requiredView(demoSchemaGraph, "identity_only");
    const visibility = createDiagramVisibility(demoSchemaGraph, identityView.key);

    render(
      <SchemaOutline
        graph={demoSchemaGraph}
        visibility={visibility}
        viewLabel="identity_only"
        collapsedGroupKeys={new Set()}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Schema outline · identity_only" })).toBeVisible();
    expect(screen.getByText("2 tables · 1 group · 1 relationship")).toBeVisible();
    expect(screen.getByText("identity.user", { exact: true })).toBeVisible();
    expect(screen.getByText("identity.profile", { exact: true })).toBeVisible();
    expect(screen.queryByText("commerce.product", { exact: true })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Focus relationship profile_user in diagram" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Focus relationship order_product in diagram" }),
    ).not.toBeInTheDocument();
  });

  it("renders script-like search labels as inert text", () => {
    const user = requiredTable(demoSchemaGraph, "user");
    const graph: SchemaGraph = {
      ...demoSchemaGraph,
      tables: demoSchemaGraph.tables.map((table) =>
        table.key === user.key ? { ...table, name: "<script>😀" } : table,
      ),
    };
    const visibility = createDiagramVisibility(graph, GLOBAL_VIEW_KEY);

    render(
      <DiagramWorkspaceControls
        graph={graph}
        visibility={visibility}
        viewKey={GLOBAL_VIEW_KEY}
        detailLevel="FULL"
        searchQuery="script"
        onSearchQueryChange={vi.fn()}
        onActivateSearchResult={vi.fn()}
        onViewChange={vi.fn()}
        onDetailLevelChange={vi.fn()}
      />,
    );
    fireEvent.focus(screen.getByRole("combobox", { name: "Search current view" }));

    expect(screen.getByRole("option", { name: "table identity.<script>😀" })).toBeVisible();
    expect(document.body.querySelector("script")).toBeNull();
  });

  it("assigns unique option ids when stable keys contain colliding punctuation", () => {
    const user = requiredTable(demoSchemaGraph, "user");
    const profile = requiredTable(demoSchemaGraph, "profile");
    const graph: SchemaGraph = {
      ...demoSchemaGraph,
      tables: [
        { ...user, key: "collision/a", name: "alpha" },
        { ...profile, key: "collision.a", name: "alpine" },
      ],
      groups: [],
      references: [],
      views: [],
    };

    render(
      <DiagramWorkspaceControls
        graph={graph}
        visibility={createDiagramVisibility(graph, GLOBAL_VIEW_KEY)}
        viewKey={GLOBAL_VIEW_KEY}
        detailLevel="FULL"
        searchQuery="al"
        onSearchQueryChange={vi.fn()}
        onActivateSearchResult={vi.fn()}
        onViewChange={vi.fn()}
        onDetailLevelChange={vi.fn()}
      />,
    );
    fireEvent.focus(screen.getByRole("combobox", { name: "Search current view" }));

    const optionIds = screen
      .getAllByRole("option", { name: /^table identity\.al/ })
      .map((option) => option.id);
    expect(optionIds).toHaveLength(2);
    expect(new Set(optionIds).size).toBe(optionIds.length);
  });
});

function requiredView(graph: SchemaGraph, name: string): DiagramViewNode {
  const view = graph.views.find((candidate) => candidate.name === name);
  if (!view) throw new Error(`Missing view ${name}`);
  return view;
}

function requiredTable(graph: SchemaGraph, name: string): SchemaGraph["tables"][number] {
  const table = graph.tables.find((candidate) => candidate.name === name);
  if (!table) throw new Error(`Missing table ${name}`);
  return table;
}

function namesForTables(graph: SchemaGraph, keys: ReadonlySet<string>): string[] {
  return graph.tables
    .filter((table) => keys.has(table.key))
    .map((table) => table.name)
    .sort();
}

function namesForGroups(graph: SchemaGraph, keys: ReadonlySet<string>): string[] {
  return graph.groups.filter((group) => keys.has(group.key)).map((group) => group.name);
}

function namesForReferences(graph: SchemaGraph, keys: ReadonlySet<string>): string[] {
  return graph.references
    .filter((reference) => keys.has(reference.key))
    .map((reference) => reference.name ?? "")
    .sort();
}
