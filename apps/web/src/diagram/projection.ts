import type {
  DiagramViewNode,
  ReferenceEdge,
  ReferenceEndpoint,
  SchemaGraph,
  TableNode,
} from "@er-diagram/core";
import type {
  DiagramLod,
  DiagramProjection,
  DiagramViewKey,
  DiagramViewOption,
  DiagramVisibility,
  GroupDiagramNode,
  ReferenceDiagramEdgeData,
  SchemaDiagramEdge,
  TableDiagramNode,
} from "./types.js";

export const GLOBAL_VIEW_KEY = "GLOBAL" as const;

const TABLE_WIDTH = 260;
const TABLE_HEADER_HEIGHT = 48;
const TABLE_ROW_HEIGHT = 28;
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
    ...graph.views.map((view) => ({
      key: view.key,
      label: view.schemaName ? `${view.schemaName}.${view.name}` : view.name,
    })),
  ];
}

export function createDiagramVisibility(
  graph: SchemaGraph,
  viewKey: DiagramViewKey,
): DiagramVisibility {
  const view = resolveView(graph, viewKey);
  const existingTableKeys = new Set(graph.tables.map((table) => table.key));
  const existingGroupKeys = new Set(graph.groups.map((group) => group.key));
  const tableKeys = view ? new Set<string>() : new Set(existingTableKeys);
  const groupKeys = view
    ? selectFilterKeys(view.visibleGroupKeys, existingGroupKeys)
    : new Set(existingGroupKeys);
  for (const group of graph.groups) {
    if (!groupKeys.has(group.key)) continue;
    for (const tableKey of group.tableKeys) {
      if (existingTableKeys.has(tableKey)) tableKeys.add(tableKey);
    }
  }

  const referenceKeys = new Set(
    graph.references
      .filter((reference) =>
        reference.endpoints.every((endpoint) => tableKeys.has(endpoint.tableKey)),
      )
      .map((reference) => reference.key),
  );
  const schemaNames = new Set<string>();
  for (const table of graph.tables) {
    if (tableKeys.has(table.key)) schemaNames.add(table.schemaName);
  }
  for (const group of graph.groups) {
    if (groupKeys.has(group.key)) schemaNames.add(group.schemaName);
  }

  return { viewKey, tableKeys, groupKeys, referenceKeys, schemaNames };
}

export function createBaseDiagramProjection(graph: SchemaGraph): DiagramProjection {
  const visibleTableKeys = new Set(graph.tables.map((table) => table.key));
  return {
    viewKey: GLOBAL_VIEW_KEY,
    lod: "FULL",
    nodes: createTableNodes(
      graph,
      visibleTableKeys,
      new Map(),
      new Set(),
      collectForeignColumnKeys(graph.references),
      "FULL",
    ),
    edges: createBaseReferenceEdges(graph),
  };
}

export function createGroupedDiagramProjection(
  graph: SchemaGraph,
  collapsedGroupKeys: ReadonlySet<string>,
): DiagramProjection {
  return createDiagramProjection(graph, {
    viewKey: GLOBAL_VIEW_KEY,
    collapsedGroupKeys,
    lod: "FULL",
  });
}

export function createDiagramProjection(
  graph: SchemaGraph,
  options: DiagramProjectionOptions,
): DiagramProjection {
  const visibility = createDiagramVisibility(graph, options.viewKey);
  const groupByTable = selectDisplayParentByTable(graph, visibility.groupKeys);
  const foreignColumnKeys = collectForeignColumnKeys(graph.references);
  const groupNodes = createGroupNodes(
    graph,
    visibility.tableKeys,
    visibility.groupKeys,
    options.collapsedGroupKeys,
    options.lod,
  );
  const tableNodes = createTableNodes(
    graph,
    visibility.tableKeys,
    groupByTable,
    options.collapsedGroupKeys,
    foreignColumnKeys,
    options.lod,
  );
  const edges = createReferenceEdges(
    graph,
    visibility.tableKeys,
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

function collectForeignColumnKeys(references: readonly ReferenceEdge[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const reference of references) {
    if (reference.inactive) continue;
    const role = resolveReferenceRole(reference);
    if (!role.foreignEndpoint) continue;
    for (const columnKey of role.foreignEndpoint.columnKeys) result.add(columnKey);
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
      const tableKeys = group.tableKeys.filter((tableKey) => visibleTableKeys.has(tableKey));
      const collapsed = collapsedGroupKeys.has(group.key);
      return {
        id: group.key,
        type: "group",
        position: { x: index * (GROUP_WIDTH + 80), y: 0 },
        style: {
          width: GROUP_WIDTH,
          height: collapsed ? 88 : Math.max(180, GROUP_HEADER_HEIGHT + GROUP_PADDING * 2),
        },
        data: {
          kind: "group",
          groupKey: group.key,
          schemaName: group.schemaName,
          name: group.name,
          tableKeys,
          tableCount: tableKeys.length,
          color: group.color,
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
  const partialNameByKey = new Map(graph.partials.map((partial) => [partial.key, partial.name]));
  let topLevelIndex = 0;

  return graph.tables.flatMap((table) => {
    if (!visibleTableKeys.has(table.key)) return [];
    const parentId = groupByTable.get(table.key);
    if (parentId && collapsedGroupKeys.has(parentId)) return [];
    const siblingIndex = parentId ? (childIndexByGroup.get(parentId) ?? 0) : topLevelIndex;
    if (parentId) childIndexByGroup.set(parentId, siblingIndex + 1);
    else topLevelIndex += 1;

    const primaryColumnKeys = collectPrimaryColumnKeys(table);
    const columns = table.columns.map((column) => ({
      key: column.key,
      name: column.name,
      type: column.type.display,
      primaryKey: primaryColumnKeys.has(column.key),
      foreignKey: foreignColumnKeys.has(column.key),
      partialName: column.injectedFrom
        ? (partialNameByKey.get(column.injectedFrom.partialKey) ?? "Unknown partial")
        : null,
    }));
    const visibleRowCount =
      lod === "FULL"
        ? columns.length
        : lod === "KEYS_ONLY"
          ? columns.filter((column) => column.primaryKey || column.foreignKey).length
          : 0;
    const position = parentId
      ? { x: GROUP_PADDING, y: GROUP_HEADER_HEIGHT + GROUP_PADDING + siblingIndex * 170 }
      : { x: (siblingIndex % 8) * 320, y: Math.floor(siblingIndex / 8) * 220 };
    const node: TableDiagramNode = {
      id: table.key,
      type: "table",
      dragHandle: ".diagram-table__drag-handle",
      focusable: false,
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

function collectPrimaryColumnKeys(table: TableNode): ReadonlySet<string> {
  const result = new Set(
    table.columns.filter((column) => column.primaryKey).map((column) => column.key),
  );
  for (const index of table.indexes) {
    if (!index.primaryKey) continue;
    for (const term of index.terms) {
      if (term.kind === "COLUMN") result.add(term.columnKey);
    }
  }
  return result;
}

function createBaseReferenceEdges(graph: SchemaGraph): SchemaDiagramEdge[] {
  const context = createReferenceRenderingContext(graph);

  return graph.references.map((reference) => {
    const { sourceEndpoint, targetEndpoint } = orderedReferenceEndpoints(reference);
    return createExactReferenceEdge(
      reference,
      sourceEndpoint,
      targetEndpoint,
      sourceEndpoint.tableKey,
      targetEndpoint.tableKey,
      context,
    );
  });
}

interface ReferenceRole {
  foreignEndpoint: ReferenceEndpoint | null;
  referencedEndpoint: ReferenceEndpoint | null;
}

function resolveReferenceRole(reference: ReferenceEdge): ReferenceRole {
  const referencedIndex = reference.endpoints.findIndex(
    (endpoint) => endpoint.multiplicity.max === 1,
  );
  if (referencedIndex < 0) {
    return { foreignEndpoint: null, referencedEndpoint: null };
  }
  return {
    referencedEndpoint: reference.endpoints[referencedIndex] ?? null,
    foreignEndpoint: reference.endpoints[referencedIndex === 0 ? 1 : 0] ?? null,
  };
}

export function formatMultiplicity(endpoint: ReferenceEndpoint): string {
  const { min, max } = endpoint.multiplicity;
  if (min === 1 && max === 1) return "1";
  return `${min}..${max === null ? "*" : max}`;
}

function formatEndpointLabel(
  endpoint: ReferenceEndpoint,
  tableByKey: ReadonlyMap<string, TableNode>,
  columnNameByKey: ReadonlyMap<string, string>,
): string {
  const table = tableByKey.get(endpoint.tableKey);
  const tableName = table
    ? table.schemaName === "public"
      ? table.name
      : `${table.schemaName}.${table.name}`
    : endpoint.tableKey;
  const columns = endpoint.columnKeys.map((key) => columnNameByKey.get(key) ?? key);
  return `${tableName}.${columns.length === 1 ? columns[0] : `(${columns.join(", ")})`}`;
}

function createReferenceEdges(
  graph: SchemaGraph,
  visibleTableKeys: ReadonlySet<string>,
  groupByTable: ReadonlyMap<string, string>,
  collapsedGroupKeys: ReadonlySet<string>,
): SchemaDiagramEdge[] {
  const result: SchemaDiagramEdge[] = [];
  const buckets = new Map<string, CollapsedReferenceBucket>();
  const context = createReferenceRenderingContext(graph);

  for (const reference of graph.references) {
    const { sourceEndpoint, targetEndpoint } = orderedReferenceEndpoints(reference);
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
      result.push(
        createExactReferenceEdge(
          reference,
          sourceEndpoint,
          targetEndpoint,
          source,
          target,
          context,
        ),
      );
      continue;
    }

    // Relationships hidden entirely inside the same collapsed group remain available in the
    // accessible outline but do not create a misleading group self-edge.
    if (source === target) {
      continue;
    }

    const bucketKey = collapsedReferenceBucketKey(source, target, reference.inactive);
    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.references.push({ reference, sourceEndpoint, targetEndpoint });
    } else {
      buckets.set(bucketKey, {
        source,
        target,
        inactive: reference.inactive,
        references: [{ reference, sourceEndpoint, targetEndpoint }],
      });
    }
  }

  for (const bucket of buckets.values()) {
    const onlyReference = bucket.references[0];
    if (bucket.references.length === 1 && onlyReference) {
      result.push(
        createExactReferenceEdge(
          onlyReference.reference,
          onlyReference.sourceEndpoint,
          onlyReference.targetEndpoint,
          bucket.source,
          bucket.target,
          context,
        ),
      );
      continue;
    }
    result.push(createAggregateReferenceEdge(bucket, graph));
  }

  return result.sort((left, right) => compareCodeUnits(left.id, right.id));
}

function representativeNodeId(
  tableKey: string,
  groupByTable: ReadonlyMap<string, string>,
  collapsedGroupKeys: ReadonlySet<string>,
): string {
  const groupKey = groupByTable.get(tableKey);
  return groupKey && collapsedGroupKeys.has(groupKey) ? groupKey : tableKey;
}

interface ReferenceRenderingContext {
  tableByKey: ReadonlyMap<string, TableNode>;
  columnNameByKey: ReadonlyMap<string, string>;
}

interface CollapsedReferenceBucketEntry {
  reference: ReferenceEdge;
  sourceEndpoint: ReferenceEndpoint;
  targetEndpoint: ReferenceEndpoint;
}

interface CollapsedReferenceBucket {
  source: string;
  target: string;
  inactive: boolean;
  references: CollapsedReferenceBucketEntry[];
}

function createReferenceRenderingContext(graph: SchemaGraph): ReferenceRenderingContext {
  return {
    tableByKey: new Map(graph.tables.map((table) => [table.key, table])),
    columnNameByKey: new Map(
      graph.tables.flatMap((table) =>
        table.columns.map((column) => [column.key, column.name] as const),
      ),
    ),
  };
}

function orderedReferenceEndpoints(reference: ReferenceEdge): {
  sourceEndpoint: ReferenceEndpoint;
  targetEndpoint: ReferenceEndpoint;
} {
  const role = resolveReferenceRole(reference);
  return {
    sourceEndpoint: role.foreignEndpoint ?? reference.endpoints[0],
    targetEndpoint: role.referencedEndpoint ?? reference.endpoints[1],
  };
}

function createExactReferenceEdge(
  reference: ReferenceEdge,
  sourceEndpoint: ReferenceEndpoint,
  targetEndpoint: ReferenceEndpoint,
  source: string,
  target: string,
  context: ReferenceRenderingContext,
): SchemaDiagramEdge {
  const sourceMultiplicity = formatMultiplicity(sourceEndpoint);
  const targetMultiplicity = formatMultiplicity(targetEndpoint);
  const sourceLabel = formatEndpointLabel(
    sourceEndpoint,
    context.tableByKey,
    context.columnNameByKey,
  );
  const targetLabel = formatEndpointLabel(
    targetEndpoint,
    context.tableByKey,
    context.columnNameByKey,
  );
  const data: ReferenceDiagramEdgeData = {
    kind: "reference",
    aggregate: false,
    count: 1,
    referenceKeys: [reference.key],
    referenceName: reference.name,
    inactive: reference.inactive,
    sourceMultiplicity,
    targetMultiplicity,
  };
  return {
    id: reference.key,
    type: "reference",
    source,
    target,
    data,
    label: `${reference.name ?? "Ref"} · ${sourceMultiplicity} → ${targetMultiplicity}`,
    ariaLabel: `${reference.name ?? "Anonymous reference"}: ${sourceLabel} ${sourceMultiplicity} to ${targetLabel} ${targetMultiplicity}${reference.inactive ? ", inactive" : ""}`,
    focusable: false,
    selectable: true,
    interactionWidth: 20,
    markerEnd: { type: "arrowclosed" },
    ...(reference.inactive ? { style: { strokeDasharray: "6 4" } } : {}),
  };
}

function createAggregateReferenceEdge(
  bucket: CollapsedReferenceBucket,
  graph: SchemaGraph,
): SchemaDiagramEdge {
  const referenceKeys = bucket.references
    .map(({ reference }) => reference.key)
    .sort(compareCodeUnits);
  const data: ReferenceDiagramEdgeData = {
    kind: "reference",
    aggregate: true,
    count: referenceKeys.length,
    referenceKeys,
    referenceName: null,
    inactive: bucket.inactive,
  };
  const stateLabel = bucket.inactive ? "inactive " : "";
  return {
    id: `aggregate:${collapsedReferenceBucketKey(bucket.source, bucket.target, bucket.inactive)}`,
    type: "reference",
    source: bucket.source,
    target: bucket.target,
    data,
    label: `×${data.count} relationships`,
    ariaLabel: `${data.count} ${stateLabel}relationships from ${formatRepresentativeLabel(bucket.source, graph)} to ${formatRepresentativeLabel(bucket.target, graph)}`,
    focusable: false,
    selectable: false,
    interactionWidth: 20,
    markerEnd: { type: "arrowclosed" },
    ...(bucket.inactive ? { style: { strokeDasharray: "6 4" } } : {}),
  };
}

function collapsedReferenceBucketKey(source: string, target: string, inactive: boolean): string {
  return JSON.stringify([source, target, inactive ? "INACTIVE" : "ACTIVE"]);
}

function formatRepresentativeLabel(nodeId: string, graph: SchemaGraph): string {
  const table = graph.tables.find((candidate) => candidate.key === nodeId);
  if (table) return `${table.schemaName}.${table.name}`;
  const group = graph.groups.find((candidate) => candidate.key === nodeId);
  if (group) return `${group.schemaName}.${group.name}`;
  return nodeId;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
