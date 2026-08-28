import type { SchemaElementKey, SchemaGraph, SourceRange } from "@er-diagram/core";

export type DiagramNavigableKind = "table" | "column" | "reference";

export interface DiagramSelection {
  elementKey: SchemaElementKey;
  kind: DiagramNavigableKind;
  tableKeys: SchemaElementKey[];
}

export interface SourceCursorPosition {
  filepath: string;
  offset: number;
}

export interface DiagramNavigationEntry {
  selection: DiagramSelection;
  range: SourceRange;
}

export interface DiagramNavigationIndex {
  entries: DiagramNavigationEntry[];
  byKey: ReadonlyMap<SchemaElementKey, DiagramNavigationEntry>;
}

const kindPriority: Record<DiagramNavigableKind, number> = {
  reference: 0,
  column: 1,
  table: 2,
};

export function createDiagramNavigationIndex(graph: SchemaGraph): DiagramNavigationIndex {
  const entries: DiagramNavigationEntry[] = [];

  for (const table of graph.tables) {
    addEntry(entries, graph, {
      elementKey: table.key,
      kind: "table",
      tableKeys: [table.key],
    });
    for (const column of table.columns) {
      addEntry(entries, graph, {
        elementKey: column.key,
        kind: "column",
        tableKeys: [table.key],
      });
    }
  }

  for (const reference of graph.references) {
    addEntry(entries, graph, {
      elementKey: reference.key,
      kind: "reference",
      tableKeys: unique(reference.endpoints.map((endpoint) => endpoint.tableKey)),
    });
  }

  entries.sort(compareEntries);
  return {
    entries,
    byKey: new Map(entries.map((entry) => [entry.selection.elementKey, entry])),
  };
}

export function findDiagramSelectionAtCursor(
  index: DiagramNavigationIndex,
  cursor: SourceCursorPosition,
): DiagramSelection | null {
  const match = index.entries.find(
    ({ range }) =>
      range.filepath === cursor.filepath &&
      range.startOffset <= cursor.offset &&
      cursor.offset < range.endOffset,
  );
  return match?.selection ?? null;
}

function addEntry(
  entries: DiagramNavigationEntry[],
  graph: SchemaGraph,
  selection: DiagramSelection,
): void {
  const range = graph.sourceMap[selection.elementKey];
  if (!range) return;
  entries.push({ selection, range });
}

function compareEntries(left: DiagramNavigationEntry, right: DiagramNavigationEntry): number {
  const lengthDifference = rangeLength(left.range) - rangeLength(right.range);
  if (lengthDifference !== 0) return lengthDifference;
  const kindDifference = kindPriority[left.selection.kind] - kindPriority[right.selection.kind];
  if (kindDifference !== 0) return kindDifference;
  return compareCodeUnits(left.selection.elementKey, right.selection.elementKey);
}

function rangeLength(range: SourceRange): number {
  return range.endOffset - range.startOffset;
}

function unique(values: SchemaElementKey[]): SchemaElementKey[] {
  return [...new Set(values)];
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
