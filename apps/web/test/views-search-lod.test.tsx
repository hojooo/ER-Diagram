import type { DiagramViewNode, SchemaGraph } from "@er-diagram/core";
import { describe, expect, it } from "vitest";

import { demoSchemaGraph } from "../src/diagram/demo-schema.js";
import {
  createDiagramProjection,
  createDiagramVisibility,
  GLOBAL_VIEW_KEY,
  listDiagramViews,
} from "../src/diagram/projection.js";
import { searchDiagramVisibility } from "../src/diagram/search-index.js";

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

    const limited = searchDiagramVisibility(demoSchemaGraph, visibility, "i", 2);
    expect(limited.results).toHaveLength(2);
    expect(limited.total).toBeGreaterThan(limited.results.length);
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
