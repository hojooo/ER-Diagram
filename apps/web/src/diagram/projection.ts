import type { DiagramViewNode, ReferenceEdge, SchemaGraph, TableNode } from "@er-diagram/core";
import type {
  DiagramLod,
  DiagramProjection,
  DiagramViewKey,
  DiagramViewOption,
  GroupDiagramNode,
  ReferenceDiagramEdgeData,
  SchemaDiagramEdge,
  TableDiagramNode,
} from "./types.js";

export const GLOBAL_VIEW_KEY = "GLOBAL" as const;

const TABLE_WIDTH = 260;
const TABLE_HEADER_HEIGHT = 48;
const TABLE_ROW_HEIGHT = 24;
const GROUP_WIDTH = 340;
const GROUP_HEADER_HEIGHT = 56;
const GROUP_PADDING = 24;

export interface DiagramProjectionOptions {
  viewKey: DiagramViewKey;
  collapsedGroupKeys: ReadonlySet<string>;
  lod: DiagramLod;
}

export function listDiagramViews(graph: SchemaGraph): DiagramViewOption[] {
  return [
    { key: GLOBAL_VIEW_KEY, label: "Global" },
    ...graph.views.map((view) => ({ key: view.key, label: view.name })),
  ];
}

export function createDiagramProjection(
  graph: SchemaGraph,
  options: DiagramProjectionOptions,
): DiagramProjection {
  const view = resolveView(graph, options.viewKey);
  const { visibleTableKeys, visibleGroupKeys } = selectViewVisibility(graph, view);
  const groupByTable = selectDisplayParentByTable(graph, visibleGroupKeys);
  const foreignColumnKeys = collectForeignColumnKeys(graph.references, graph.tables);
  const groupNodes = createGroupNodes(
    graph,
    visibleTableKeys,
    visibleGroupKeys,
    options.collapsedGroupKeys,
    options.lod,
  );
  const tableNodes = createTableNodes(
    graph,
    visibleTableKeys,
    groupByTable,
    options.collapsedGroupKeys,
    foreignColumnKeys,
    options.lod,
  );
  const edges = createReferenceEdges(
    graph.references,
    visibleTableKeys,
    groupByTable,
    options.collapsedGroupKeys,
  );

  return {
    viewKey: options.viewKey,
    lod: options.lod,
    // React Flow requires parent nodes to precede their children.
    nodes: [...groupNodes, ...tableNodes],
    edges,
  };
}

function resolveView(graph: SchemaGraph, viewKey: DiagramViewKey): DiagramViewNode | null {
  if (viewKey === GLOBAL_VIEW_KEY) return null;
  const view = graph.views.find((candidate) => candidate.key === viewKey);
  if (!view) {
    throw new Error(`Unknown diagram view: ${viewKey}`);
  }
  return view;
}

function selectViewVisibility(
  graph: SchemaGraph,
  view: DiagramViewNode | null,
): { visibleTableKeys: Set<string>; visibleGroupKeys: Set<string> } {
  if (!view) {
    return {
      visibleTableKeys: new Set(graph.tables.map((table) => table.key)),
      visibleGroupKeys: new Set(graph.groups.map((group) => group.key)),
    };
  }

  const existingTableKeys = new Set(graph.tables.map((table) => table.key));
  const existingGroupKeys = new Set(graph.groups.map((group) => group.key));
  const visibleTableKeys = selectFilterKeys(view.visibleTableKeys, existingTableKeys);
  const visibleGroupKeys = selectFilterKeys(view.visibleGroupKeys, existingGroupKeys);
  const visibleSchemaNames = selectFilterKeys(
    view.visibleSchemaNames,
    new Set([
      ...graph.tables.map((table) => table.schemaName),
      ...graph.groups.map((group) => group.schemaName),
    ]),
  );

  for (const table of graph.tables) {
    if (visibleSchemaNames.has(table.schemaName)) visibleTableKeys.add(table.key);
  }
  for (const group of graph.groups) {
    if (visibleSchemaNames.has(group.schemaName)) visibleGroupKeys.add(group.key);
  }
  for (const group of graph.groups) {
    if (!visibleGroupKeys.has(group.key)) continue;
    for (const tableKey of group.tableKeys) {
      if (existingTableKeys.has(tableKey)) visibleTableKeys.add(tableKey);
    }
  }

  return { visibleTableKeys, visibleGroupKeys };
}

function selectFilterKeys(
  filter: readonly string[] | null,
  allKeys: ReadonlySet<string>,
): Set<string> {
  if (filter === null) return new Set();
  if (filter.length === 0) return new Set(allKeys);
  return new Set(filter.filter((key) => allKeys.has(key)));
}

function selectDisplayParentByTable(
  graph: SchemaGraph,
  visibleGroupKeys: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const group of graph.groups) {
    if (!visibleGroupKeys.has(group.key)) continue;
    for (const tableKey of group.tableKeys) {
      // React Flow has one parentId. The first source-ordered visible group is deterministic.
      if (!result.has(tableKey)) result.set(tableKey, group.key);
    }
  }
  return result;
}

function collectForeignColumnKeys(
  references: readonly ReferenceEdge[],
  tables: readonly TableNode[],
): ReadonlySet<string> {
  const tableByKey = new Map(tables.map((table) => [table.key, table]));
  const result = new Set<string>();
  for (const reference of references) {
    for (const endpoint of reference.endpoints) {
      const table = tableByKey.get(endpoint.tableKey);
      if (!table) continue;
      for (const fieldName of endpoint.fieldNames) {
        const column = table.columns.find((candidate) => candidate.name === fieldName);
        if (column) result.add(column.key);
      }
    }
  }
  return result;
}

function createGroupNodes(
  graph: SchemaGraph,
  visibleTableKeys: ReadonlySet<string>,
  visibleGroupKeys: ReadonlySet<string>,
  collapsedGroupKeys: ReadonlySet<string>,
  lod: DiagramLod,
): GroupDiagramNode[] {
  return graph.groups
    .filter((group) => visibleGroupKeys.has(group.key))
    .map((group, index) => {
      const visibleMemberCount = group.tableKeys.filter((tableKey) =>
        visibleTableKeys.has(tableKey),
      ).length;
      const collapsed = collapsedGroupKeys.has(group.key);
      return {
        id: group.key,
        type: "group",
        position: { x: index * (GROUP_WIDTH + 80), y: 0 },
        style: {
          width: GROUP_WIDTH,
          height: collapsed
            ? GROUP_HEADER_HEIGHT
            : Math.max(180, GROUP_HEADER_HEIGHT + GROUP_PADDING * 2),
        },
        data: {
          kind: "group",
          groupKey: group.key,
          name: group.name,
          tableCount: visibleMemberCount,
          collapsed,
          lod,
        },
      };
    });
}

function createTableNodes(
  graph: SchemaGraph,
  visibleTableKeys: ReadonlySet<string>,
  groupByTable: ReadonlyMap<string, string>,
  collapsedGroupKeys: ReadonlySet<string>,
  foreignColumnKeys: ReadonlySet<string>,
  lod: DiagramLod,
): TableDiagramNode[] {
  const childIndexByGroup = new Map<string, number>();
  let topLevelIndex = 0;

  return graph.tables.flatMap((table) => {
    if (!visibleTableKeys.has(table.key)) return [];
    const parentId = groupByTable.get(table.key);
    if (parentId && collapsedGroupKeys.has(parentId)) return [];
    const siblingIndex = parentId ? (childIndexByGroup.get(parentId) ?? 0) : topLevelIndex;
    if (parentId) childIndexByGroup.set(parentId, siblingIndex + 1);
    else topLevelIndex += 1;

    const columns = table.columns.map((column) => ({
      key: column.key,
      name: column.name,
      type: column.type,
      primaryKey: column.primaryKey,
      foreignKey: foreignColumnKeys.has(column.key),
    }));
    const visibleRowCount =
      lod === "FULL"
        ? columns.length
        : lod === "KEYS_ONLY"
          ? columns.filter((column) => column.primaryKey || column.foreignKey).length
          : 0;
    const position = parentId
      ? { x: GROUP_PADDING, y: GROUP_HEADER_HEIGHT + GROUP_PADDING + siblingIndex * 170 }
      : { x: (topLevelIndex % 8) * 320, y: Math.floor(topLevelIndex / 8) * 220 };
    const node: TableDiagramNode = {
      id: table.key,
      type: "table",
      position,
      style: {
        width: TABLE_WIDTH,
        height: TABLE_HEADER_HEIGHT + visibleRowCount * TABLE_ROW_HEIGHT,
      },
      data: {
        kind: "table",
        tableKey: table.key,
        schemaName: table.schemaName,
        name: table.name,
        columns,
        lod,
      },
      ...(parentId ? { parentId, extent: "parent" as const } : {}),
    };
    return [node];
  });
}

function createReferenceEdges(
  references: readonly ReferenceEdge[],
  visibleTableKeys: ReadonlySet<string>,
  groupByTable: ReadonlyMap<string, string>,
  collapsedGroupKeys: ReadonlySet<string>,
): SchemaDiagramEdge[] {
  const result: SchemaDiagramEdge[] = [];
  const aggregateByEndpoints = new Map<string, SchemaDiagramEdge>();

  for (const reference of references) {
    const [sourceEndpoint, targetEndpoint] = reference.endpoints;
    if (
      !visibleTableKeys.has(sourceEndpoint.tableKey) ||
      !visibleTableKeys.has(targetEndpoint.tableKey)
    ) {
      continue;
    }

    const source = representativeNodeId(sourceEndpoint.tableKey, groupByTable, collapsedGroupKeys);
    const target = representativeNodeId(targetEndpoint.tableKey, groupByTable, collapsedGroupKeys);
    const collapsedEndpoint =
      source !== sourceEndpoint.tableKey || target !== targetEndpoint.tableKey;

    if (!collapsedEndpoint) {
      result.push(createEdge(reference.key, source, target, [reference.key]));
      continue;
    }

    const endpointKey = JSON.stringify([source, target]);
    const existing = aggregateByEndpoints.get(endpointKey);
    if (existing) {
      existing.data.referenceKeys.push(reference.key);
      existing.data.count += 1;
      existing.label = `×${existing.data.count}`;
      continue;
    }

    const edge = createEdge(`aggregate:${aggregateByEndpoints.size}`, source, target, [
      reference.key,
    ]);
    aggregateByEndpoints.set(endpointKey, edge);
    result.push(edge);
  }

  return result;
}

function representativeNodeId(
  tableKey: string,
  groupByTable: ReadonlyMap<string, string>,
  collapsedGroupKeys: ReadonlySet<string>,
): string {
  const groupKey = groupByTable.get(tableKey);
  return groupKey && collapsedGroupKeys.has(groupKey) ? groupKey : tableKey;
}

function createEdge(
  id: string,
  source: string,
  target: string,
  referenceKeys: string[],
): SchemaDiagramEdge {
  const data: ReferenceDiagramEdgeData = {
    kind: "reference",
    count: referenceKeys.length,
    referenceKeys,
  };
  return {
    id,
    type: "reference",
    source,
    target,
    data,
    ...(data.count > 1 ? { label: `×${data.count}` } : {}),
  };
}
