import type {
  VisualColumnDefault,
  VisualCommandKind,
  VisualIndexTerm,
  VisualReferenceAction,
} from "@er-diagram/contracts";
import type {
  CheckNode,
  ColumnNode,
  IndexNode,
  PartialInjectionProvenance,
  ReferenceEdge,
  SchemaElementKey,
  SchemaGraph,
  TableNode,
} from "@er-diagram/core";

import { GLOBAL_VIEW_KEY } from "../diagram/projection.js";
import type { DiagramSelection } from "../diagram/source-navigation.js";
import type { VisualCommandDraft } from "./visual-command-session.js";

export interface VisualEditorAction {
  readonly id: string;
  readonly kind: VisualCommandKind;
  readonly label: string;
  readonly targetElementKey?: SchemaElementKey;
  readonly ownerColumnKey?: SchemaElementKey | null;
}

export interface NormalizedVisualDraft {
  readonly draft: VisualCommandDraft | null;
  readonly error: string | null;
}

export function listVisualEditorActions(
  graph: SchemaGraph,
  selection: DiagramSelection | null,
  currentViewKey: string,
): VisualEditorAction[] {
  const actions: VisualEditorAction[] = [
    action("CREATE_TABLE", "Create table"),
    ...(graph.tables.some((table) => table.columns.some((column) => !column.injectedFrom))
      ? [action("CREATE_REFERENCE", "Create relationship")]
      : []),
  ];
  if (
    currentViewKey !== GLOBAL_VIEW_KEY &&
    graph.views.some((view) => view.key === currentViewKey)
  ) {
    actions.push(action("UPDATE_DIAGRAM_VIEW", "Update current DiagramView", currentViewKey));
  }
  if (!selection) return actions;

  if (selection.kind === "table") {
    const table = graph.tables.find((candidate) => candidate.key === selection.elementKey);
    if (!table) return actions;
    actions.push(
      action("UPDATE_TABLE", "Update table", table.key),
      action("RENAME_TABLE", "Rename table", table.key),
      action("DELETE_TABLE", "Delete table", table.key),
      action("CREATE_COLUMN", "Create column", table.key),
      action("CREATE_INDEX", "Create index", table.key),
      action("CREATE_CHECK", "Create table check", table.key, null),
    );
    for (const index of table.indexes) {
      if (index.injectedFrom) continue;
      actions.push(
        action("UPDATE_INDEX", `Update index ${index.name ?? "anonymous"}`, index.key),
        action("DELETE_INDEX", `Delete index ${index.name ?? "anonymous"}`, index.key),
      );
    }
    for (const check of table.checks) {
      if (check.injectedFrom) continue;
      actions.push(
        action("UPDATE_CHECK", `Update check ${check.name ?? "anonymous"}`, check.key, null),
        action("DELETE_CHECK", `Delete check ${check.name ?? "anonymous"}`, check.key, null),
      );
    }
  } else if (selection.kind === "column") {
    const resolved = findColumn(graph, selection.elementKey);
    if (!resolved) return actions;
    const { table, column } = resolved;
    if (!column.injectedFrom) {
      actions.push(
        action("ALTER_COLUMN", "Edit column", column.key),
        action("DELETE_COLUMN", "Delete column", column.key),
        action("CREATE_CHECK", "Create column check", table.key, column.key),
        action("CREATE_REFERENCE", "Create relationship from column", column.key),
      );
      for (const check of column.checks) {
        if (check.injectedFrom) continue;
        actions.push(
          action("UPDATE_CHECK", "Update column check", check.key, column.key),
          action("DELETE_CHECK", "Delete column check", check.key, column.key),
        );
      }
    }
  } else if (selection.kind === "reference") {
    const reference = graph.references.find((candidate) => candidate.key === selection.elementKey);
    if (reference && !reference.injectedFrom) {
      actions.push(
        action("UPDATE_REFERENCE", "Update relationship", reference.key),
        action("DELETE_REFERENCE", "Delete relationship", reference.key),
      );
    }
  } else if (selection.kind === "group") {
    actions.push(
      action("UPDATE_GROUP_MEMBERSHIP", "Update group membership", selection.elementKey),
    );
  }
  return actions;
}

export function createInitialVisualDraft(
  graph: SchemaGraph,
  selection: DiagramSelection | null,
  action: VisualEditorAction,
): VisualCommandDraft | null {
  const selectedTable = selection ? resolveSelectionTable(graph, selection) : null;
  switch (action.kind) {
    case "CREATE_TABLE":
      return {
        kind: "CREATE_TABLE",
        table: {
          schemaName: selectedTable?.schemaName ?? graph.tables[0]?.schemaName ?? "public",
          name: "new_table",
          note: null,
          color: null,
          columns: [defaultColumn("id")],
        },
      };
    case "UPDATE_TABLE": {
      const table = findTable(graph, action.targetElementKey);
      return table
        ? {
            kind: "UPDATE_TABLE",
            targetTableKey: table.key,
            changes: { note: table.note?.value ?? null, color: table.color },
          }
        : null;
    }
    case "RENAME_TABLE": {
      const table = findTable(graph, action.targetElementKey);
      return table
        ? { kind: "RENAME_TABLE", targetTableKey: table.key, newName: table.name }
        : null;
    }
    case "DELETE_TABLE": {
      const table = findTable(graph, action.targetElementKey);
      return table ? { kind: "DELETE_TABLE", targetTableKey: table.key } : null;
    }
    case "CREATE_COLUMN": {
      const table = findTable(graph, action.targetElementKey) ?? selectedTable;
      return table
        ? { kind: "CREATE_COLUMN", targetTableKey: table.key, column: defaultColumn("new_column") }
        : null;
    }
    case "ALTER_COLUMN": {
      const resolved = findColumn(graph, action.targetElementKey);
      if (!resolved) return null;
      const currentIndex = resolved.table.columns.findIndex(
        (column) => column.key === resolved.column.key,
      );
      return {
        kind: "ALTER_COLUMN",
        targetTableKey: resolved.table.key,
        targetColumnKey: resolved.column.key,
        newName: resolved.column.name,
        changes: columnEditableValue(resolved.column),
        beforeColumnKey: resolved.table.columns[currentIndex + 1]?.key ?? null,
      };
    }
    case "DELETE_COLUMN": {
      const resolved = findColumn(graph, action.targetElementKey);
      return resolved
        ? {
            kind: "DELETE_COLUMN",
            targetTableKey: resolved.table.key,
            targetColumnKey: resolved.column.key,
          }
        : null;
    }
    case "CREATE_REFERENCE": {
      const selectedColumn =
        selection?.kind === "column" ? findColumn(graph, selection.elementKey) : null;
      const first = selectedColumn ?? firstColumn(graph);
      const second =
        graph.tables
          .flatMap((table) =>
            table.columns
              .filter((column) => !column.injectedFrom)
              .map((column) => ({ table, column })),
          )
          .find(({ column }) => column.key !== first?.column.key) ?? first;
      if (!first || !second) return null;
      return {
        kind: "CREATE_REFERENCE",
        reference: {
          schemaName: "public",
          name: null,
          endpoints: [endpoint(first.table, first.column), endpoint(second.table, second.column)],
          onDelete: null,
          onUpdate: null,
          color: null,
          inactive: false,
        },
      };
    }
    case "UPDATE_REFERENCE": {
      const reference = findReference(graph, action.targetElementKey);
      return reference
        ? {
            kind: "UPDATE_REFERENCE",
            targetReferenceKey: reference.key,
            changes: referenceEditableValue(reference),
          }
        : null;
    }
    case "DELETE_REFERENCE": {
      const reference = findReference(graph, action.targetElementKey);
      return reference ? { kind: "DELETE_REFERENCE", targetReferenceKey: reference.key } : null;
    }
    case "CREATE_INDEX": {
      const table = findTable(graph, action.targetElementKey) ?? selectedTable;
      const column = table?.columns.find((candidate) => !candidate.injectedFrom);
      return table && column
        ? {
            kind: "CREATE_INDEX",
            targetTableKey: table.key,
            index: {
              name: null,
              terms: [{ kind: "COLUMN", columnKey: column.key }],
              type: null,
              unique: false,
              primaryKey: false,
              note: null,
            },
          }
        : null;
    }
    case "UPDATE_INDEX": {
      const resolved = findIndex(graph, action.targetElementKey);
      return resolved
        ? {
            kind: "UPDATE_INDEX",
            targetTableKey: resolved.table.key,
            targetIndexKey: resolved.index.key,
            changes: indexEditableValue(resolved.index),
          }
        : null;
    }
    case "DELETE_INDEX": {
      const resolved = findIndex(graph, action.targetElementKey);
      return resolved
        ? {
            kind: "DELETE_INDEX",
            targetTableKey: resolved.table.key,
            targetIndexKey: resolved.index.key,
          }
        : null;
    }
    case "CREATE_CHECK": {
      const ownerColumn = action.ownerColumnKey ? findColumn(graph, action.ownerColumnKey) : null;
      const table =
        ownerColumn?.table ?? findTable(graph, action.targetElementKey) ?? selectedTable;
      return table
        ? {
            kind: "CREATE_CHECK",
            targetTableKey: table.key,
            ownerColumnKey: ownerColumn?.column.key ?? null,
            check: { name: null, expression: "true" },
          }
        : null;
    }
    case "UPDATE_CHECK": {
      const resolved = findCheck(graph, action.targetElementKey);
      return resolved
        ? {
            kind: "UPDATE_CHECK",
            targetTableKey: resolved.table.key,
            ownerColumnKey: resolved.check.columnKey,
            targetCheckKey: resolved.check.key,
            changes: { name: resolved.check.name, expression: resolved.check.expression },
          }
        : null;
    }
    case "DELETE_CHECK": {
      const resolved = findCheck(graph, action.targetElementKey);
      return resolved
        ? {
            kind: "DELETE_CHECK",
            targetTableKey: resolved.table.key,
            ownerColumnKey: resolved.check.columnKey,
            targetCheckKey: resolved.check.key,
          }
        : null;
    }
    case "UPDATE_GROUP_MEMBERSHIP": {
      const group = graph.groups.find((candidate) => candidate.key === action.targetElementKey);
      return group
        ? {
            kind: "UPDATE_GROUP_MEMBERSHIP",
            targetGroupKey: group.key,
            addTableKeys: [],
            removeTableKeys: [],
          }
        : null;
    }
    case "UPDATE_DIAGRAM_VIEW": {
      const view = graph.views.find((candidate) => candidate.key === action.targetElementKey);
      return view
        ? {
            kind: "UPDATE_DIAGRAM_VIEW",
            targetViewKey: view.key,
            changes: {
              visibleTableKeys: cloneNullable(view.visibleTableKeys),
              visibleNoteKeys: cloneNullable(view.visibleNoteKeys),
              visibleGroupKeys: cloneNullable(view.visibleGroupKeys),
              visibleSchemaNames: cloneNullable(view.visibleSchemaNames),
            },
          }
        : null;
    }
  }
}

export function normalizeVisualDraft(
  graph: SchemaGraph,
  draft: VisualCommandDraft,
): NormalizedVisualDraft {
  switch (draft.kind) {
    case "UPDATE_TABLE": {
      const table = findTable(graph, draft.targetTableKey);
      if (!table) return missingTarget();
      const changes = compactChanges({
        note: same(draft.changes.note, table.note?.value ?? null) ? undefined : draft.changes.note,
        color: same(draft.changes.color, table.color) ? undefined : draft.changes.color,
      });
      return updateResult(changes, { ...draft, changes });
    }
    case "RENAME_TABLE": {
      const table = findTable(graph, draft.targetTableKey);
      return table && draft.newName === table.name ? unchanged() : ok(draft);
    }
    case "ALTER_COLUMN": {
      const resolved = findColumn(graph, draft.targetColumnKey);
      if (!resolved) return missingTarget();
      const current = columnEditableValue(resolved.column);
      const changes = compactChanges(
        Object.fromEntries(
          Object.entries(draft.changes ?? {}).map(([key, value]) => [
            key,
            same(value, current[key as keyof typeof current]) ? undefined : value,
          ]),
        ),
      );
      const currentIndex = resolved.table.columns.findIndex(
        (column) => column.key === resolved.column.key,
      );
      const currentBefore = resolved.table.columns[currentIndex + 1]?.key ?? null;
      const normalized = {
        ...draft,
        newName: draft.newName === resolved.column.name ? undefined : draft.newName,
        changes: Object.keys(changes).length === 0 ? undefined : changes,
        beforeColumnKey:
          draft.beforeColumnKey === currentBefore ? undefined : draft.beforeColumnKey,
      };
      return normalized.newName === undefined &&
        normalized.changes === undefined &&
        normalized.beforeColumnKey === undefined
        ? unchanged()
        : ok(normalized);
    }
    case "UPDATE_REFERENCE": {
      const reference = findReference(graph, draft.targetReferenceKey);
      if (!reference) return missingTarget();
      const current = referenceEditableValue(reference);
      const changes = compactComparedChanges(draft.changes, current);
      return updateResult(changes, { ...draft, changes });
    }
    case "UPDATE_INDEX": {
      const resolved = findIndex(graph, draft.targetIndexKey);
      if (!resolved) return missingTarget();
      const changes = compactComparedChanges(draft.changes, indexEditableValue(resolved.index));
      return updateResult(changes, { ...draft, changes });
    }
    case "UPDATE_CHECK": {
      const resolved = findCheck(graph, draft.targetCheckKey);
      if (!resolved) return missingTarget();
      const changes = compactComparedChanges(draft.changes, {
        name: resolved.check.name,
        expression: resolved.check.expression,
      });
      return updateResult(changes, { ...draft, changes });
    }
    case "UPDATE_GROUP_MEMBERSHIP":
      return draft.addTableKeys.length === 0 && draft.removeTableKeys.length === 0
        ? unchanged()
        : ok({
            ...draft,
            addTableKeys: sortedUnique(draft.addTableKeys),
            removeTableKeys: sortedUnique(draft.removeTableKeys),
          });
    case "UPDATE_DIAGRAM_VIEW": {
      const view = graph.views.find((candidate) => candidate.key === draft.targetViewKey);
      if (!view) return missingTarget();
      const current = {
        visibleTableKeys: view.visibleTableKeys,
        visibleNoteKeys: view.visibleNoteKeys,
        visibleGroupKeys: view.visibleGroupKeys,
        visibleSchemaNames: view.visibleSchemaNames,
      };
      const changes = compactChanges(
        Object.fromEntries(
          Object.entries(draft.changes).map(([key, value]) => [
            key,
            sameFilter(value, current[key as keyof typeof current]) ? undefined : value,
          ]),
        ),
      );
      return updateResult(changes, { ...draft, changes });
    }
    default:
      return ok(draft);
  }
}

export function findPartialProvenance(
  graph: SchemaGraph,
  selection: DiagramSelection | null,
): PartialInjectionProvenance | null {
  if (!selection) return null;
  if (selection.kind === "column")
    return findColumn(graph, selection.elementKey)?.column.injectedFrom ?? null;
  if (selection.kind === "reference") {
    return findReference(graph, selection.elementKey)?.injectedFrom ?? null;
  }
  return null;
}

export function findTable(graph: SchemaGraph, key?: SchemaElementKey): TableNode | null {
  return key ? (graph.tables.find((table) => table.key === key) ?? null) : null;
}

export function findColumn(
  graph: SchemaGraph,
  key?: SchemaElementKey,
): { readonly table: TableNode; readonly column: ColumnNode } | null {
  if (!key) return null;
  for (const table of graph.tables) {
    const column = table.columns.find((candidate) => candidate.key === key);
    if (column) return { table, column };
  }
  return null;
}

function action(
  kind: VisualCommandKind,
  label: string,
  targetElementKey?: SchemaElementKey,
  ownerColumnKey?: SchemaElementKey | null,
): VisualEditorAction {
  return {
    id: [kind, targetElementKey ?? "global", ownerColumnKey ?? "table"].join(":"),
    kind,
    label,
    ...(targetElementKey ? { targetElementKey } : {}),
    ...(ownerColumnKey === undefined ? {} : { ownerColumnKey }),
  };
}

function defaultColumn(name: string) {
  return {
    name,
    type: "integer",
    primaryKey: false,
    unique: false,
    notNull: false,
    default: null,
    increment: false,
    note: null,
  };
}

function columnEditableValue(column: ColumnNode) {
  return {
    type: column.type.display,
    primaryKey: column.primaryKey,
    unique: column.unique,
    notNull: column.notNull,
    default: cloneDefault(column.default),
    increment: column.increment,
    note: column.note?.value ?? null,
  };
}

function cloneDefault(value: ColumnNode["default"]): VisualColumnDefault | null {
  return value ? ({ ...value } as VisualColumnDefault) : null;
}

function endpoint(table: TableNode, column: ColumnNode) {
  return {
    tableKey: table.key,
    columnKeys: [column.key],
    multiplicity: { min: 0 as const, max: 1 as const },
  };
}

function referenceEditableValue(reference: ReferenceEdge) {
  return {
    name: reference.name,
    endpoints: reference.endpoints.map((value) => ({
      tableKey: value.tableKey,
      columnKeys: [...value.columnKeys],
      multiplicity: {
        min: value.multiplicity.min as 0 | 1,
        max: value.multiplicity.max === null ? null : (value.multiplicity.max as 1),
      },
    })) as [
      { tableKey: string; columnKeys: string[]; multiplicity: { min: 0 | 1; max: 1 | null } },
      { tableKey: string; columnKeys: string[]; multiplicity: { min: 0 | 1; max: 1 | null } },
    ],
    onDelete: normalizeReferenceAction(reference.onDelete),
    onUpdate: normalizeReferenceAction(reference.onUpdate),
    color: reference.color,
    inactive: reference.inactive,
  };
}

function normalizeReferenceAction(value: string | null): VisualReferenceAction | null {
  const normalized = value?.toLowerCase();
  return normalized === "cascade" ||
    normalized === "restrict" ||
    normalized === "set null" ||
    normalized === "set default" ||
    normalized === "no action"
    ? normalized
    : null;
}

function indexEditableValue(index: IndexNode) {
  return {
    name: index.name,
    terms: index.terms.map(
      (term): VisualIndexTerm =>
        term.kind === "COLUMN"
          ? { kind: "COLUMN", columnKey: term.columnKey }
          : { kind: "EXPRESSION", expression: term.expression },
    ),
    type: index.type,
    unique: index.unique,
    primaryKey: index.primaryKey,
    note: index.note?.value ?? null,
  };
}

function findReference(graph: SchemaGraph, key?: SchemaElementKey): ReferenceEdge | null {
  return key ? (graph.references.find((reference) => reference.key === key) ?? null) : null;
}

function findIndex(
  graph: SchemaGraph,
  key?: SchemaElementKey,
): { readonly table: TableNode; readonly index: IndexNode } | null {
  if (!key) return null;
  for (const table of graph.tables) {
    const index = table.indexes.find((candidate) => candidate.key === key);
    if (index) return { table, index };
  }
  return null;
}

function findCheck(
  graph: SchemaGraph,
  key?: SchemaElementKey,
): { readonly table: TableNode; readonly check: CheckNode } | null {
  if (!key) return null;
  for (const table of graph.tables) {
    const check = [...table.checks, ...table.columns.flatMap((column) => column.checks)].find(
      (candidate) => candidate.key === key,
    );
    if (check) return { table, check };
  }
  return null;
}

function firstColumn(graph: SchemaGraph) {
  for (const table of graph.tables) {
    const column = table.columns.find((candidate) => !candidate.injectedFrom);
    if (column) return { table, column };
  }
  return null;
}

function resolveSelectionTable(graph: SchemaGraph, selection: DiagramSelection): TableNode | null {
  if (selection.kind === "table") return findTable(graph, selection.elementKey);
  if (selection.kind === "column") return findColumn(graph, selection.elementKey)?.table ?? null;
  return findTable(graph, selection.tableKeys[0]);
}

function cloneNullable<T>(value: readonly T[] | null): T[] | null {
  return value === null ? null : [...value];
}

function compactComparedChanges<T extends Record<string, unknown>>(
  next: T,
  current: Record<string, unknown>,
): Partial<T> {
  return compactChanges(
    Object.fromEntries(
      Object.entries(next).map(([key, value]) => [
        key,
        same(value, current[key]) ? undefined : value,
      ]),
    ),
  ) as Partial<T>;
}

function compactChanges<T extends Record<string, unknown>>(changes: T): T {
  return Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  ) as T;
}

function updateResult(
  changes: Record<string, unknown>,
  draft: VisualCommandDraft,
): NormalizedVisualDraft {
  return Object.keys(changes).length === 0 ? unchanged() : ok(draft);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameFilter(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  if (!Array.isArray(left) || !Array.isArray(right)) return same(left, right);
  return same(sortedUnique(left), sortedUnique(right));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ok(draft: VisualCommandDraft): NormalizedVisualDraft {
  return { draft, error: null };
}

function unchanged(): NormalizedVisualDraft {
  return { draft: null, error: "Change at least one field before applying the command." };
}

function missingTarget(): NormalizedVisualDraft {
  return { draft: null, error: "The selected schema element no longer exists." };
}
