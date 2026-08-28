import { parseDbmlV2, type SchemaGraph } from "@er-diagram/core";
import { fixtureInventory, generateFidelityFixture } from "@er-diagram/test-fixtures";
import { beforeAll, describe, expect, it } from "vitest";

import { createGroupedDiagramProjection } from "../src/diagram/projection.js";
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

  it("preserves the fidelity fixture group and expanded relationship inventory", async () => {
    const fidelityGraph = await parseGraph(generateFidelityFixture());
    const projection = createGroupedDiagramProjection(fidelityGraph, new Set());

    expect(groupNodes(projection)).toHaveLength(fixtureInventory.fidelity.tableGroups);
    expect(tableNodes(projection)).toHaveLength(fixtureInventory.fidelity.tables);
    expect(projection.edges).toHaveLength(fixtureInventory.fidelity.references);
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
