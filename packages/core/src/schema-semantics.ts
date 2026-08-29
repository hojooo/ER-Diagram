import { sha256Utf8 } from "./hash.js";
import type {
  CheckNode,
  ColumnNode,
  IndexNode,
  PartialInjectionProvenance,
  SchemaElementKey,
  SchemaElementKind,
  SchemaGraph,
  TableNode,
  TextNote,
} from "./schema-graph.js";

export const SCHEMA_SEMANTICS_VERSION = 1 as const;

export type SchemaElementChange =
  | {
      operation: "ADD" | "DELETE";
      elementKind: SchemaElementKind;
      key: SchemaElementKey;
      parentKey: SchemaElementKey | null;
    }
  | {
      operation: "UPDATE";
      elementKind: SchemaElementKind;
      key: SchemaElementKey;
      parentKey: SchemaElementKey | null;
      changedFields: string[];
    };

export interface SchemaRenameCandidate {
  elementKind: "table" | "column";
  beforeKey: SchemaElementKey;
  afterKey: SchemaElementKey;
  beforeParentKey: SchemaElementKey | null;
  afterParentKey: SchemaElementKey | null;
  confidence: "HIGH";
  reason: "UNIQUE_EXACT_STRUCTURE";
}

export interface SchemaGraphDiff {
  changes: SchemaElementChange[];
  renameCandidates: SchemaRenameCandidate[];
}

export type CanonicalScalar = null | boolean | number | string;
export type CanonicalValue = CanonicalScalar | CanonicalValue[] | { [key: string]: CanonicalValue };
export type CanonicalObject = { [key: string]: CanonicalValue };

export interface SemanticElementRecord {
  elementKind: SchemaElementKind;
  key: SchemaElementKey;
  parentKey: SchemaElementKey | null;
  value: CanonicalObject;
}

export interface SemanticOrderRecord {
  ownerKind: "table" | "partial" | "enum";
  ownerKey: SchemaElementKey;
  field: "columnOrder" | "valueOrder";
  elementKeys: SchemaElementKey[];
}

export interface SemanticDocument {
  version: typeof SCHEMA_SEMANTICS_VERSION;
  elements: SemanticElementRecord[];
  orders: SemanticOrderRecord[];
}

export async function computeSchemaHash(graph: SchemaGraph): Promise<string> {
  return hashSemanticDocument(schemaGraphSemanticDocument(graph));
}

export function diffSchemaGraphs(before: SchemaGraph, after: SchemaGraph): SchemaGraphDiff {
  const beforeDocument = schemaGraphSemanticDocument(before);
  const afterDocument = schemaGraphSemanticDocument(after);
  const changes = diffSemanticDocuments(beforeDocument, afterDocument);

  return {
    changes,
    renameCandidates: findRenameCandidates(before, after, changes),
  };
}

/** Package-internal semantic-document hash used by non-DBML adapters. */
export async function hashSemanticDocument(document: SemanticDocument): Promise<string> {
  return sha256Utf8(canonicalStringify(document));
}

/** Package-internal stable-key diff used by non-DBML adapters. */
export function diffSemanticDocuments(
  beforeDocument: SemanticDocument,
  afterDocument: SemanticDocument,
): SchemaElementChange[] {
  const beforeElements = new Map(beforeDocument.elements.map((element) => [element.key, element]));
  const afterElements = new Map(afterDocument.elements.map((element) => [element.key, element]));
  const changes: SchemaElementChange[] = [];
  const updates = new Map<SchemaElementKey, Set<string>>();

  for (const element of beforeDocument.elements) {
    const afterElement = afterElements.get(element.key);
    if (!afterElement) {
      changes.push(changeWithoutFields("DELETE", element));
      continue;
    }
    for (const field of changedObjectFields(element.value, afterElement.value)) {
      addUpdateField(updates, element.key, field);
    }
  }

  for (const element of afterDocument.elements) {
    if (!beforeElements.has(element.key)) {
      changes.push(changeWithoutFields("ADD", element));
    }
  }

  const beforeOrders = new Map(
    beforeDocument.orders.map((order) => [semanticOrderIdentity(order), order]),
  );
  const afterOrders = new Map(
    afterDocument.orders.map((order) => [semanticOrderIdentity(order), order]),
  );
  for (const [identity, beforeOrder] of beforeOrders) {
    const afterOrder = afterOrders.get(identity);
    if (
      afterOrder &&
      beforeElements.has(beforeOrder.ownerKey) &&
      afterElements.has(beforeOrder.ownerKey) &&
      !sameCanonicalValue(beforeOrder.elementKeys, afterOrder.elementKeys)
    ) {
      addUpdateField(updates, beforeOrder.ownerKey, beforeOrder.field);
    }
  }

  for (const [key, fields] of updates) {
    const element = afterElements.get(key) ?? beforeElements.get(key);
    if (!element) continue;
    changes.push({
      operation: "UPDATE",
      elementKind: element.elementKind,
      key,
      parentKey: element.parentKey,
      changedFields: [...fields].sort(compareCodeUnits),
    });
  }

  changes.sort(compareChanges);

  return changes;
}

/** Package-internal projection used to verify adapter models against SchemaGraph. */
export function schemaGraphSemanticDocument(graph: SchemaGraph): SemanticDocument {
  const elements: SemanticElementRecord[] = [];
  const orders: SemanticOrderRecord[] = [];

  if (graph.project) {
    elements.push(
      semanticElement("project", graph.project.key, null, {
        name: graph.project.name,
        databaseType: graph.project.databaseType,
        note: semanticNote(graph.project.note),
      }),
    );
  }

  for (const note of graph.notes) {
    elements.push(
      semanticElement("note", note.key, null, {
        name: note.name,
        content: note.content,
        color: note.color,
        metadata: note.metadata,
      }),
    );
  }

  for (const table of graph.tables) {
    elements.push(
      semanticElement("table", table.key, null, {
        schemaName: table.schemaName,
        name: table.name,
        alias: table.alias,
        note: semanticNote(table.note),
        color: table.color,
        metadata: table.metadata,
        partialKeys: sortedStrings(table.partialKeys),
      }),
    );
    orders.push(semanticOrder("table", table.key, "columnOrder", table.columns.map(keyOf)));
    addColumns(elements, table.columns, "column", "check", table.key);
    addIndexes(elements, table.indexes, "index", table.key);
    addChecks(elements, table.checks, "check", table.key);
  }

  for (const dbEnum of graph.enums) {
    elements.push(
      semanticElement("enum", dbEnum.key, null, {
        schemaName: dbEnum.schemaName,
        name: dbEnum.name,
        note: semanticNote(dbEnum.note),
      }),
    );
    orders.push(semanticOrder("enum", dbEnum.key, "valueOrder", dbEnum.values.map(keyOf)));
    for (const value of dbEnum.values) {
      elements.push(
        semanticElement("enumValue", value.key, dbEnum.key, {
          name: value.name,
          note: semanticNote(value.note),
        }),
      );
    }
  }

  for (const reference of graph.references) {
    elements.push(
      semanticElement("reference", reference.key, null, {
        schemaName: reference.schemaName,
        name: reference.name,
        endpoints: reference.endpoints.map((endpoint) => ({
          tableKey: endpoint.tableKey,
          columnKeys: endpoint.columnKeys,
          multiplicity: {
            min: endpoint.multiplicity.min,
            max: endpoint.multiplicity.max,
          },
        })),
        onDelete: reference.onDelete,
        onUpdate: reference.onUpdate,
        color: reference.color,
        inactive: reference.inactive,
        injectedFrom: semanticProvenance(reference.injectedFrom),
      }),
    );
  }

  for (const group of graph.groups) {
    elements.push(
      semanticElement("group", group.key, null, {
        schemaName: group.schemaName,
        name: group.name,
        tableKeys: sortedStrings(group.tableKeys),
        note: semanticNote(group.note),
        color: group.color,
        metadata: group.metadata,
      }),
    );
  }

  for (const partial of graph.partials) {
    elements.push(
      semanticElement("partial", partial.key, null, {
        name: partial.name,
        note: semanticNote(partial.note),
        color: partial.color,
      }),
    );
    orders.push(semanticOrder("partial", partial.key, "columnOrder", partial.columns.map(keyOf)));
    addColumns(elements, partial.columns, "partialColumn", "partialCheck", partial.key);
    addIndexes(elements, partial.indexes, "partialIndex", partial.key);
    addChecks(elements, partial.checks, "partialCheck", partial.key);
  }

  for (const view of graph.views) {
    elements.push(
      semanticElement("view", view.key, null, {
        schemaName: view.schemaName,
        name: view.name,
        visibleTableKeys: sortedNullableStrings(view.visibleTableKeys),
        visibleNoteKeys: sortedNullableStrings(view.visibleNoteKeys),
        visibleGroupKeys: sortedNullableStrings(view.visibleGroupKeys),
        visibleSchemaNames: sortedNullableStrings(view.visibleSchemaNames),
      }),
    );
  }

  elements.sort(compareElements);
  orders.sort(compareOrders);
  return { version: SCHEMA_SEMANTICS_VERSION, elements, orders };
}

function addColumns(
  elements: SemanticElementRecord[],
  columns: readonly ColumnNode[],
  columnKind: "column" | "partialColumn",
  checkKind: "check" | "partialCheck",
  parentKey: SchemaElementKey,
): void {
  for (const column of columns) {
    elements.push(
      semanticElement(columnKind, column.key, parentKey, {
        name: column.name,
        type: semanticColumnType(column),
        primaryKey: column.primaryKey,
        unique: column.unique,
        notNull: column.notNull,
        default: column.default,
        increment: column.increment,
        note: semanticNote(column.note),
        metadata: column.metadata,
        injectedFrom: semanticProvenance(column.injectedFrom),
      }),
    );
    addChecks(elements, column.checks, checkKind, column.key);
  }
}

function addIndexes(
  elements: SemanticElementRecord[],
  indexes: readonly IndexNode[],
  kind: "index" | "partialIndex",
  parentKey: SchemaElementKey,
): void {
  for (const index of indexes) {
    elements.push(
      semanticElement(kind, index.key, parentKey, {
        name: index.name,
        terms: semanticIndexTerms(index),
        type: index.type,
        unique: index.unique,
        primaryKey: index.primaryKey,
        note: semanticNote(index.note),
        injectedFrom: semanticProvenance(index.injectedFrom),
      }),
    );
  }
}

function addChecks(
  elements: SemanticElementRecord[],
  checks: readonly CheckNode[],
  kind: "check" | "partialCheck",
  parentKey: SchemaElementKey,
): void {
  for (const check of checks) {
    elements.push(
      semanticElement(kind, check.key, parentKey, {
        name: check.name,
        expression: check.expression,
        tableKey: check.tableKey,
        columnKey: check.columnKey,
        injectedFrom: semanticProvenance(check.injectedFrom),
      }),
    );
  }
}

function semanticColumnType(column: ColumnNode): CanonicalObject {
  return {
    schemaName: column.type.schemaName,
    name: column.type.name,
    arguments: column.type.arguments,
  };
}

function semanticIndexTerms(index: IndexNode): CanonicalValue[] {
  return index.terms.map((term) =>
    term.kind === "COLUMN"
      ? { kind: term.kind, columnKey: term.columnKey }
      : { kind: term.kind, expression: term.expression },
  );
}

function semanticNote(note: TextNote | null): CanonicalValue {
  return note ? { value: note.value } : null;
}

function semanticProvenance(provenance: PartialInjectionProvenance | null): CanonicalValue {
  return provenance
    ? {
        partialKey: provenance.partialKey,
        partialElementKey: provenance.partialElementKey,
      }
    : null;
}

export function semanticElement(
  elementKind: SchemaElementKind,
  key: SchemaElementKey,
  parentKey: SchemaElementKey | null,
  value: CanonicalObject,
): SemanticElementRecord {
  return {
    elementKind,
    key,
    parentKey,
    value: canonicalize(value) as CanonicalObject,
  };
}

export function semanticOrder(
  ownerKind: SemanticOrderRecord["ownerKind"],
  ownerKey: SchemaElementKey,
  field: SemanticOrderRecord["field"],
  elementKeys: SchemaElementKey[],
): SemanticOrderRecord {
  return { ownerKind, ownerKey, field, elementKeys };
}

function keyOf(value: { key: SchemaElementKey }): SchemaElementKey {
  return value.key;
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort(compareCodeUnits);
}

function sortedNullableStrings(values: readonly string[] | null): string[] | null {
  return values === null ? null : sortedStrings(values);
}

function changedObjectFields(before: CanonicalObject, after: CanonicalObject): string[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...fields]
    .filter((field) => !sameCanonicalValue(before[field], after[field]))
    .sort(compareCodeUnits);
}

function changeWithoutFields(
  operation: "ADD" | "DELETE",
  element: SemanticElementRecord,
): SchemaElementChange {
  return {
    operation,
    elementKind: element.elementKind,
    key: element.key,
    parentKey: element.parentKey,
  };
}

function addUpdateField(
  updates: Map<SchemaElementKey, Set<string>>,
  key: SchemaElementKey,
  field: string,
): void {
  const fields = updates.get(key) ?? new Set<string>();
  fields.add(field);
  updates.set(key, fields);
}

function semanticOrderIdentity(orderRecord: SemanticOrderRecord): string {
  return `${orderRecord.ownerKey}\u0000${orderRecord.field}`;
}

function compareElements(left: SemanticElementRecord, right: SemanticElementRecord): number {
  return (
    compareCodeUnits(left.elementKind, right.elementKind) || compareCodeUnits(left.key, right.key)
  );
}

function compareOrders(left: SemanticOrderRecord, right: SemanticOrderRecord): number {
  return (
    compareCodeUnits(left.ownerKind, right.ownerKind) ||
    compareCodeUnits(left.ownerKey, right.ownerKey) ||
    compareCodeUnits(left.field, right.field)
  );
}

function compareChanges(left: SchemaElementChange, right: SchemaElementChange): number {
  return (
    compareCodeUnits(left.elementKind, right.elementKind) ||
    compareCodeUnits(left.key, right.key) ||
    compareCodeUnits(left.operation, right.operation)
  );
}

function compareRenameCandidates(
  left: SchemaRenameCandidate,
  right: SchemaRenameCandidate,
): number {
  return (
    compareCodeUnits(left.elementKind, right.elementKind) ||
    compareCodeUnits(left.beforeKey, right.beforeKey) ||
    compareCodeUnits(left.afterKey, right.afterKey)
  );
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalize(value: unknown): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Schema semantics require finite numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") {
    throw new TypeError(`Schema semantics cannot canonicalize ${typeof value}.`);
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function findRenameCandidates(
  before: SchemaGraph,
  after: SchemaGraph,
  changes: readonly SchemaElementChange[],
): SchemaRenameCandidate[] {
  const deletedKeys = new Set(
    changes.filter((change) => change.operation === "DELETE").map((change) => change.key),
  );
  const addedKeys = new Set(
    changes.filter((change) => change.operation === "ADD").map((change) => change.key),
  );
  const candidates = [
    ...findTableRenameCandidates(before, after, deletedKeys, addedKeys),
    ...findColumnRenameCandidates(before, after, deletedKeys, addedKeys),
  ];
  return candidates.sort(compareRenameCandidates);
}

function findTableRenameCandidates(
  before: SchemaGraph,
  after: SchemaGraph,
  deletedKeys: ReadonlySet<SchemaElementKey>,
  addedKeys: ReadonlySet<SchemaElementKey>,
): SchemaRenameCandidate[] {
  const beforeByFingerprint = groupByFingerprint(
    before.tables.filter((table) => deletedKeys.has(table.key)),
    (table) => `${table.schemaName}\u0000${tableRenameFingerprint(table)}`,
  );
  const afterByFingerprint = groupByFingerprint(
    after.tables.filter((table) => addedKeys.has(table.key)),
    (table) => `${table.schemaName}\u0000${tableRenameFingerprint(table)}`,
  );
  const candidates: SchemaRenameCandidate[] = [];

  for (const [fingerprint, beforeTables] of beforeByFingerprint) {
    const afterTables = afterByFingerprint.get(fingerprint);
    if (beforeTables.length !== 1 || afterTables?.length !== 1) continue;
    const beforeTable = beforeTables[0];
    const afterTable = afterTables[0];
    if (!beforeTable || !afterTable || beforeTable.name === afterTable.name) continue;
    candidates.push(renameCandidate("table", beforeTable.key, afterTable.key, null, null));
  }

  return candidates;
}

function findColumnRenameCandidates(
  before: SchemaGraph,
  after: SchemaGraph,
  deletedKeys: ReadonlySet<SchemaElementKey>,
  addedKeys: ReadonlySet<SchemaElementKey>,
): SchemaRenameCandidate[] {
  const afterTableByKey = new Map(after.tables.map((table) => [table.key, table]));
  const candidates: SchemaRenameCandidate[] = [];

  for (const beforeTable of before.tables) {
    const afterTable = afterTableByKey.get(beforeTable.key);
    if (!afterTable) continue;
    const beforeByFingerprint = groupByFingerprint(
      beforeTable.columns.filter((column) => deletedKeys.has(column.key)),
      columnRenameFingerprint,
    );
    const afterByFingerprint = groupByFingerprint(
      afterTable.columns.filter((column) => addedKeys.has(column.key)),
      columnRenameFingerprint,
    );

    for (const [fingerprint, beforeColumns] of beforeByFingerprint) {
      const afterColumns = afterByFingerprint.get(fingerprint);
      if (beforeColumns.length !== 1 || afterColumns?.length !== 1) continue;
      const beforeColumn = beforeColumns[0];
      const afterColumn = afterColumns[0];
      if (!beforeColumn || !afterColumn || beforeColumn.name === afterColumn.name) continue;
      candidates.push(
        renameCandidate(
          "column",
          beforeColumn.key,
          afterColumn.key,
          beforeTable.key,
          afterTable.key,
        ),
      );
    }
  }

  return candidates;
}

function renameCandidate(
  elementKind: SchemaRenameCandidate["elementKind"],
  beforeKey: SchemaElementKey,
  afterKey: SchemaElementKey,
  beforeParentKey: SchemaElementKey | null,
  afterParentKey: SchemaElementKey | null,
): SchemaRenameCandidate {
  return {
    elementKind,
    beforeKey,
    afterKey,
    beforeParentKey,
    afterParentKey,
    confidence: "HIGH",
    reason: "UNIQUE_EXACT_STRUCTURE",
  };
}

function groupByFingerprint<T>(
  values: readonly T[],
  fingerprintOf: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const fingerprint = fingerprintOf(value);
    const group = groups.get(fingerprint) ?? [];
    group.push(value);
    groups.set(fingerprint, group);
  }
  return groups;
}

function tableRenameFingerprint(table: TableNode): string {
  const localColumnNames = new Map(table.columns.map((column) => [column.key, column.name]));
  const relativeColumnKey = (key: SchemaElementKey | null): string | null => {
    if (key === null) return null;
    const name = localColumnNames.get(key);
    return name === undefined ? key : `$column:${name}`;
  };
  const relativeTableKey = (key: SchemaElementKey | null): string | null =>
    key === table.key ? "$table" : key;

  return canonicalStringify({
    alias: table.alias,
    note: semanticNote(table.note),
    color: table.color,
    metadata: table.metadata,
    partialKeys: sortedStrings(table.partialKeys),
    columns: table.columns.map((column) =>
      tableColumnRenameValue(column, relativeTableKey, relativeColumnKey),
    ),
    indexes: table.indexes
      .map((index) => tableIndexRenameValue(index, relativeColumnKey))
      .sort(compareCanonicalValues),
    checks: table.checks
      .map((check) => tableCheckRenameValue(check, relativeTableKey, relativeColumnKey))
      .sort(compareCanonicalValues),
  });
}

function tableColumnRenameValue(
  column: ColumnNode,
  relativeTableKey: (key: SchemaElementKey | null) => string | null,
  relativeColumnKey: (key: SchemaElementKey | null) => string | null,
): CanonicalObject {
  return {
    name: column.name,
    ...columnRenameBaseValue(column),
    checks: column.checks
      .map((check) => tableCheckRenameValue(check, relativeTableKey, relativeColumnKey))
      .sort(compareCanonicalValues),
  };
}

function columnRenameFingerprint(column: ColumnNode): string {
  return canonicalStringify({
    ...columnRenameBaseValue(column),
    checks: column.checks
      .map((check) => ({
        name: check.name,
        expression: check.expression,
        tableKey: check.tableKey === null ? null : "$table",
        columnKey: check.columnKey === null ? null : "$column",
        injectedFrom: semanticProvenance(check.injectedFrom),
      }))
      .sort(compareCanonicalValues),
  });
}

function columnRenameBaseValue(column: ColumnNode): CanonicalObject {
  return {
    type: semanticColumnType(column),
    primaryKey: column.primaryKey,
    unique: column.unique,
    notNull: column.notNull,
    default: column.default,
    increment: column.increment,
    note: semanticNote(column.note),
    metadata: column.metadata,
    injectedFrom: semanticProvenance(column.injectedFrom),
  };
}

function tableIndexRenameValue(
  index: IndexNode,
  relativeColumnKey: (key: SchemaElementKey | null) => string | null,
): CanonicalObject {
  return {
    name: index.name,
    terms: index.terms.map((term) =>
      term.kind === "COLUMN"
        ? { kind: term.kind, columnKey: relativeColumnKey(term.columnKey) }
        : { kind: term.kind, expression: term.expression },
    ),
    type: index.type,
    unique: index.unique,
    primaryKey: index.primaryKey,
    note: semanticNote(index.note),
    injectedFrom: semanticProvenance(index.injectedFrom),
  };
}

function tableCheckRenameValue(
  check: CheckNode,
  relativeTableKey: (key: SchemaElementKey | null) => string | null,
  relativeColumnKey: (key: SchemaElementKey | null) => string | null,
): CanonicalObject {
  return {
    name: check.name,
    expression: check.expression,
    tableKey: relativeTableKey(check.tableKey),
    columnKey: relativeColumnKey(check.columnKey),
    injectedFrom: semanticProvenance(check.injectedFrom),
  };
}

function compareCanonicalValues(left: CanonicalValue, right: CanonicalValue): number {
  return compareCodeUnits(canonicalStringify(left), canonicalStringify(right));
}
