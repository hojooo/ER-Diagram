import { parseDbmlV2 } from "@er-diagram/core";
import { fixtureInventory, generateFidelityFixture } from "@er-diagram/test-fixtures";
import { describe, expect, it } from "vitest";

import { createBaseDiagramProjection } from "../src/diagram/projection.js";
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
