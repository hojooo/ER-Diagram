import type { SchemaElementKey, SchemaGraph } from "@er-diagram/core";

import type {
  ColumnSearchResult,
  DiagramSearchResult,
  DiagramVisibility,
  GroupSearchResult,
  SchemaSearchResult,
  TableSearchResult,
} from "./types.js";

export interface DiagramSearchResponse {
  results: DiagramSearchResult[];
  total: number;
}

const resultKindOrder: Record<DiagramSearchResult["kind"], number> = {
  table: 0,
  column: 1,
  group: 2,
  schema: 3,
};

export function searchDiagramVisibility(
  graph: SchemaGraph,
  visibility: DiagramVisibility,
  query: string,
  limit = 50,
): DiagramSearchResponse {
  const normalizedQuery = normalizeSearchText(query.trim());
  if (!normalizedQuery) return { results: [], total: 0 };

  const visibleGroupsByTable = collectVisibleGroupsByTable(graph, visibility);
  const candidates: RankedSearchResult[] = [];

  for (const table of graph.tables) {
    if (!visibility.tableKeys.has(table.key)) continue;
    const qualifiedLabel = `${table.schemaName}.${table.name}`;
    addCandidate(
      candidates,
      {
        resultId: `table:${table.key}`,
        kind: "table",
        elementKey: table.key,
        shortLabel: table.name,
        qualifiedLabel,
        tableKeys: [table.key],
        groupKeys: visibleGroupsByTable.get(table.key) ?? [],
      } satisfies TableSearchResult,
      [table.name, qualifiedLabel],
      normalizedQuery,
    );

    for (const column of table.columns) {
      const columnQualifiedLabel = `${qualifiedLabel}.${column.name}`;
      addCandidate(
        candidates,
        {
          resultId: `column:${column.key}`,
          kind: "column",
          elementKey: column.key,
          shortLabel: column.name,
          qualifiedLabel: columnQualifiedLabel,
          ownerLabel: qualifiedLabel,
          tableKeys: [table.key],
          groupKeys: visibleGroupsByTable.get(table.key) ?? [],
        } satisfies ColumnSearchResult,
        [column.name, columnQualifiedLabel],
        normalizedQuery,
      );
    }
  }

  for (const group of graph.groups) {
    if (!visibility.groupKeys.has(group.key)) continue;
    const qualifiedLabel = `${group.schemaName}.${group.name}`;
    addCandidate(
      candidates,
      {
        resultId: `group:${group.key}`,
        kind: "group",
        elementKey: group.key,
        shortLabel: group.name,
        qualifiedLabel,
        tableKeys: group.tableKeys.filter((tableKey) => visibility.tableKeys.has(tableKey)),
        groupKeys: [group.key],
      } satisfies GroupSearchResult,
      [group.name, qualifiedLabel],
      normalizedQuery,
    );
  }

  for (const schemaName of visibility.schemaNames) {
    const tableKeys = graph.tables
      .filter((table) => table.schemaName === schemaName && visibility.tableKeys.has(table.key))
      .map((table) => table.key);
    const groupKeys = graph.groups
      .filter((group) => group.schemaName === schemaName && visibility.groupKeys.has(group.key))
      .map((group) => group.key);
    addCandidate(
      candidates,
      {
        resultId: `schema:${JSON.stringify(schemaName)}`,
        kind: "schema",
        schemaName,
        shortLabel: schemaName,
        qualifiedLabel: schemaName,
        tableKeys,
        groupKeys,
      } satisfies SchemaSearchResult,
      [schemaName],
      normalizedQuery,
    );
  }

  candidates.sort(compareRankedResults);
  return {
    results: candidates.slice(0, Math.max(0, limit)).map(({ result }) => result),
    total: candidates.length,
  };
}

interface RankedSearchResult {
  result: DiagramSearchResult;
  rank: number;
}

function addCandidate(
  candidates: RankedSearchResult[],
  result: DiagramSearchResult,
  aliases: readonly string[],
  query: string,
): void {
  const rank = aliases.reduce<number | null>((best, alias) => {
    const candidateRank = matchRank(normalizeSearchText(alias), query);
    if (candidateRank === null) return best;
    return best === null ? candidateRank : Math.min(best, candidateRank);
  }, null);
  if (rank !== null) candidates.push({ result, rank });
}

function matchRank(value: string, query: string): number | null {
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  if (value.includes(query)) return 2;
  return null;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function collectVisibleGroupsByTable(
  graph: SchemaGraph,
  visibility: DiagramVisibility,
): ReadonlyMap<SchemaElementKey, SchemaElementKey[]> {
  const result = new Map<SchemaElementKey, SchemaElementKey[]>();
  for (const group of graph.groups) {
    if (!visibility.groupKeys.has(group.key)) continue;
    for (const tableKey of group.tableKeys) {
      if (!visibility.tableKeys.has(tableKey)) continue;
      const groupKeys = result.get(tableKey) ?? [];
      groupKeys.push(group.key);
      result.set(tableKey, groupKeys);
    }
  }
  return result;
}

function compareRankedResults(left: RankedSearchResult, right: RankedSearchResult): number {
  if (left.rank !== right.rank) return left.rank - right.rank;
  const kindDifference = resultKindOrder[left.result.kind] - resultKindOrder[right.result.kind];
  if (kindDifference !== 0) return kindDifference;
  return compareCodeUnits(left.result.qualifiedLabel, right.result.qualifiedLabel);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
