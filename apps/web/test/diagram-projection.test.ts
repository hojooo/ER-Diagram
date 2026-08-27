import { parseDbmlV2 } from "@er-diagram/core";
import { fixtureInventory, generateFidelityFixture } from "@er-diagram/test-fixtures";
import { beforeAll, describe, expect, it } from "vitest";
import { demoSchemaGraph } from "../src/diagram/demo-schema.js";
import {
  createDiagramProjection,
  GLOBAL_VIEW_KEY,
  listDiagramViews,
} from "../src/diagram/projection.js";
import type {
  DiagramProjection,
  GroupDiagramNode,
  TableDiagramNode,
} from "../src/diagram/types.js";

describe("diagram projection", () => {
  let graph: Awaited<ReturnType<typeof parseDbmlV2>> extends infer _Result
    ? Extract<Awaited<ReturnType<typeof parseDbmlV2>>, { ok: true }>["graph"]
    : never;

  beforeAll(async () => {
    const result = await parseDbmlV2(generateFidelityFixture());
    if (!result.ok) {
      throw new Error(`fixture parse failed: ${JSON.stringify(result.diagnostics)}`);
    }
    graph = result.graph;
  });

  it("exposes GLOBAL plus every source-defined DiagramView", () => {
    const views = listDiagramViews(graph);

    expect(views[0]).toEqual({ key: GLOBAL_VIEW_KEY, label: "Global" });
    expect(views).toHaveLength(fixtureInventory.fidelity.diagramViews + 1);
    expect(new Set(views.map((view) => view.key))).toHaveLength(views.length);
  });

  it("projects normalized type displays and foreign keys from endpoint column keys", () => {
    const projection = createDiagramProjection(demoSchemaGraph, {
      viewKey: GLOBAL_VIEW_KEY,
      collapsedGroupKeys: new Set(),
      lod: "FULL",
    });
    const sourceColumnByKey = new Map(
      demoSchemaGraph.tables.flatMap((table) =>
        table.columns.map((column) => [column.key, column] as const),
      ),
    );
    const endpointColumnKeys = new Set(
      demoSchemaGraph.references.flatMap((reference) =>
        reference.endpoints.flatMap((endpoint) => endpoint.columnKeys),
      ),
    );

    for (const table of tableNodes(projection)) {
      for (const column of table.data.columns) {
        expect(column.type).toBe(sourceColumnByKey.get(column.key)?.type.display);
        expect(column.foreignKey).toBe(endpointColumnKeys.has(column.key));
      }
    }
    expect(
      tableNodes(projection).some((table) =>
        table.data.columns.some((column) => column.type === "varchar"),
      ),
    ).toBe(true);
    expect(endpointColumnKeys.size).toBeGreaterThan(0);
  });

  it("places all 15 group parents before their 143 table children", () => {
    const projection = createDiagramProjection(graph, {
      viewKey: GLOBAL_VIEW_KEY,
      collapsedGroupKeys: new Set(),
      lod: "FULL",
    });
    const groups = groupNodes(projection);
    const tables = tableNodes(projection);
    const expectedParentByTable = new Map(
      graph.groups.flatMap((group) => group.tableKeys.map((tableKey) => [tableKey, group.key])),
    );

    expect(groups).toHaveLength(fixtureInventory.fidelity.tableGroups);
    expect(tables).toHaveLength(fixtureInventory.fidelity.tables);
    expect(projection.edges).toHaveLength(fixtureInventory.fidelity.references);
    expect(projection.nodes.slice(0, groups.length).every((node) => node.type === "group")).toBe(
      true,
    );
    for (const table of tables) {
      expect(table.parentId).toBe(expectedParentByTable.get(table.data.tableKey));
      expect(table.extent).toBe("parent");
      expect(table.data.lod).toBe("FULL");
    }
  });

  it("switches to a focused source view by projection without changing the parsed graph", () => {
    const focusView = graph.views.find((view) => view.name === "focus_01");
    if (!focusView?.visibleTableKeys || !focusView.visibleGroupKeys) {
      throw new Error("focus_01 must define explicit table and group visibility");
    }
    const sourceHash = graph.schemaHash;

    const projection = createDiagramProjection(graph, {
      viewKey: focusView.key,
      collapsedGroupKeys: new Set(),
      lod: "KEYS_ONLY",
    });

    const expectedTableKeys = new Set(focusView.visibleTableKeys);
    const expectedGroupKeys = new Set(focusView.visibleGroupKeys);
    for (const table of graph.tables) {
      if (focusView.visibleSchemaNames?.includes(table.schemaName))
        expectedTableKeys.add(table.key);
    }
    for (const group of graph.groups) {
      if (focusView.visibleSchemaNames?.includes(group.schemaName))
        expectedGroupKeys.add(group.key);
      if (expectedGroupKeys.has(group.key)) {
        for (const tableKey of group.tableKeys) expectedTableKeys.add(tableKey);
      }
    }

    expect(tableNodes(projection)).toHaveLength(expectedTableKeys.size);
    expect(groupNodes(projection)).toHaveLength(expectedGroupKeys.size);
    expect(tableNodes(projection).every((node) => node.data.lod === "KEYS_ONLY")).toBe(true);
    expect(graph.schemaHash).toBe(sourceHash);
  });

  it("treats wildcard arrays as show-all and null filters as hide-all", () => {
    const fullView = graph.views.find((view) => view.name === "full_schema");
    if (!fullView) throw new Error("full_schema view is missing");
    expect(fullView.visibleTableKeys).toEqual([]);
    expect(fullView.visibleGroupKeys).toEqual([]);

    const fullProjection = createDiagramProjection(graph, {
      viewKey: fullView.key,
      collapsedGroupKeys: new Set(),
      lod: "NAME_ONLY",
    });
    expect(tableNodes(fullProjection)).toHaveLength(fixtureInventory.fidelity.tables);
    expect(groupNodes(fullProjection)).toHaveLength(fixtureInventory.fidelity.tableGroups);

    const emptyView = {
      ...fullView,
      key: 'view:[null,"empty"]',
      name: "empty",
      visibleTableKeys: null,
      visibleGroupKeys: null,
      visibleSchemaNames: null,
    };
    const emptyGraph = { ...graph, views: [...graph.views, emptyView] };
    const emptyProjection = createDiagramProjection(emptyGraph, {
      viewKey: emptyView.key,
      collapsedGroupKeys: new Set(),
      lod: "NAME_ONLY",
    });
    expect(emptyProjection.nodes).toHaveLength(0);
    expect(emptyProjection.edges).toHaveLength(0);
  });

  it("unions tables selected through TableGroups and Schemas", () => {
    const template = graph.views[0];
    const selectedGroup = graph.groups[0];
    if (!template || !selectedGroup) throw new Error("fidelity view/group is missing");
    const groupOnlyView = {
      ...template,
      key: 'view:[null,"group-only"]',
      name: "group-only",
      visibleTableKeys: null,
      visibleGroupKeys: [selectedGroup.key],
      visibleSchemaNames: null,
    };
    const schemaOnlyView = {
      ...template,
      key: 'view:[null,"schema-only"]',
      name: "schema-only",
      visibleTableKeys: null,
      visibleGroupKeys: null,
      visibleSchemaNames: ["core"],
    };
    const viewGraph = { ...graph, views: [...graph.views, groupOnlyView, schemaOnlyView] };

    const groupProjection = createDiagramProjection(viewGraph, {
      viewKey: groupOnlyView.key,
      collapsedGroupKeys: new Set(),
      lod: "NAME_ONLY",
    });
    expect(new Set(tableNodes(groupProjection).map((node) => node.id))).toEqual(
      new Set(selectedGroup.tableKeys),
    );
    expect(groupNodes(groupProjection).map((node) => node.id)).toEqual([selectedGroup.key]);

    const schemaProjection = createDiagramProjection(viewGraph, {
      viewKey: schemaOnlyView.key,
      collapsedGroupKeys: new Set(),
      lod: "NAME_ONLY",
    });
    expect(new Set(tableNodes(schemaProjection).map((node) => node.data.schemaName))).toEqual(
      new Set(["core"]),
    );
    expect(
      groupNodes(schemaProjection).every((node) => node.data.groupKey !== selectedGroup.key),
    ).toBe(true);
  });

  it("hides collapsed children and aggregates equivalent reference endpoints with counts", () => {
    const collapsedGroupKeys = new Set(graph.groups.map((group) => group.key));

    const projection = createDiagramProjection(graph, {
      viewKey: GLOBAL_VIEW_KEY,
      collapsedGroupKeys,
      lod: "NAME_ONLY",
    });
    const endpointPairs = projection.edges.map((edge) => `${edge.source}\u0000${edge.target}`);

    expect(groupNodes(projection)).toHaveLength(fixtureInventory.fidelity.tableGroups);
    expect(tableNodes(projection)).toHaveLength(0);
    expect(new Set(endpointPairs)).toHaveLength(endpointPairs.length);
    expect(projection.edges.some((edge) => edge.data.count > 1)).toBe(true);
    expect(projection.edges.reduce((count, edge) => count + edge.data.count, 0)).toBe(
      fixtureInventory.fidelity.references,
    );
    expect(
      projection.edges.every(
        (edge) => collapsedGroupKeys.has(edge.source) && collapsedGroupKeys.has(edge.target),
      ),
    ).toBe(true);
  });
});

function groupNodes(projection: DiagramProjection): GroupDiagramNode[] {
  return projection.nodes.filter((node): node is GroupDiagramNode => node.type === "group");
}

function tableNodes(projection: DiagramProjection): TableDiagramNode[] {
  return projection.nodes.filter((node): node is TableDiagramNode => node.type === "table");
}
