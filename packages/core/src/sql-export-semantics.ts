import type { PrimaryDialect } from "@er-diagram/contracts";
import { sha256Utf8 } from "./hash.js";
import {
  qualifiedElementKey,
  type ColumnDefaultNode,
  type ColumnNode,
  type IndexNode,
  type ReferenceEdge,
  type SchemaElementKey,
  type SchemaElementKind,
  type SchemaGraph,
  type TableNode,
} from "./schema-graph.js";
import {
  canonicalStringify,
  diffSemanticDocuments,
  SCHEMA_SEMANTICS_VERSION,
  semanticElement,
  semanticOrder,
  type CanonicalObject,
  type CanonicalValue,
  type SchemaElementChange,
  type SemanticDocument,
  type SemanticElementRecord,
  type SemanticOrderRecord,
} from "./schema-semantics.js";

export const SQL_EXPORT_SEMANTICS_VERSION = 1 as const;

export type SqlExportSemanticVerification =
  | {
      readonly status: "NOT_RUN";
      readonly sourceExportableHash: null;
      readonly generatedExportableHash: null;
      readonly changes: [];
    }
  | {
      readonly status: "VERIFIED";
      readonly sourceExportableHash: string;
      readonly generatedExportableHash: string;
      readonly changes: [];
    }
  | {
      readonly status: "FAILED";
      readonly sourceExportableHash: string;
      readonly generatedExportableHash: string;
      readonly changes: SchemaElementChange[];
    };

interface ProjectionOptions {
  readonly sourceGraph?: SchemaGraph;
}

interface PhysicalReference {
  readonly source: ReferenceEdge;
  readonly fkTableKey: SchemaElementKey;
  readonly fkColumnKeys: readonly SchemaElementKey[];
  readonly referencedTableKey: SchemaElementKey;
  readonly referencedColumnKeys: readonly SchemaElementKey[];
  readonly onDelete: string | null;
  readonly onUpdate: string | null;
}

interface JunctionCollapse {
  readonly tableKey: SchemaElementKey;
  readonly referenceKeys: ReadonlySet<SchemaElementKey>;
  readonly manyToManyReference: ReferenceEdge;
}

interface ReferenceDraft {
  readonly value: CanonicalObject;
  readonly signature: CanonicalObject;
}

const DEFAULT_INDEX_TYPE = "btree";

export async function verifyExportableSchemaGraphs(
  sourceGraph: SchemaGraph,
  generatedGraph: SchemaGraph,
  dialect: PrimaryDialect,
): Promise<SqlExportSemanticVerification> {
  const sourceDocument = exportableSchemaDocument(sourceGraph, dialect);
  const generatedDocument = exportableSchemaDocument(generatedGraph, dialect, {
    sourceGraph,
  });
  const [sourceExportableHash, generatedExportableHash] = await Promise.all([
    hashExportableDocument(sourceDocument),
    hashExportableDocument(generatedDocument),
  ]);
  const changes = diffSemanticDocuments(sourceDocument, generatedDocument);

  return changes.length === 0 && sourceExportableHash === generatedExportableHash
    ? {
        status: "VERIFIED",
        sourceExportableHash,
        generatedExportableHash,
        changes: [],
      }
    : {
        status: "FAILED",
        sourceExportableHash,
        generatedExportableHash,
        changes,
      };
}

export function notRunSqlExportSemanticVerification(): SqlExportSemanticVerification {
  return {
    status: "NOT_RUN",
    sourceExportableHash: null,
    generatedExportableHash: null,
    changes: [],
  };
}

/** Package-internal physical-schema projection used only for export verification. */
export function exportableSchemaDocument(
  graph: SchemaGraph,
  dialect: PrimaryDialect,
  options: ProjectionOptions = {},
): SemanticDocument {
  const elements: SemanticElementRecord[] = [];
  const orders: SemanticOrderRecord[] = [];
  const sourceGraph = options.sourceGraph;
  const sourceColumnByKey = new Map(
    sourceGraph?.tables.flatMap((table) => table.columns.map((column) => [column.key, column])) ??
      [],
  );
  const enumByName = enumLookup(graph);
  const sourceEnumByName = sourceGraph ? enumLookup(sourceGraph) : enumByName;
  const collapses = sourceGraph ? findJunctionCollapses(sourceGraph, graph, dialect) : [];
  const consumedTableKeys = new Set(collapses.map(({ tableKey }) => tableKey));
  const consumedReferenceKeys = new Set(
    collapses.flatMap(({ referenceKeys }) => [...referenceKeys]),
  );

  for (const table of graph.tables) {
    if (consumedTableKeys.has(table.key)) continue;
    addTable(elements, orders, table, dialect, enumByName, sourceEnumByName, sourceColumnByKey);
  }

  if (dialect === "POSTGRESQL") {
    for (const dbEnum of graph.enums) {
      elements.push(
        semanticElement("enum", dbEnum.key, null, {
          schemaName: dbEnum.schemaName,
          name: dbEnum.name,
        }),
      );
      orders.push(
        semanticOrder(
          "enum",
          dbEnum.key,
          "valueOrder",
          dbEnum.values.map(({ key }) => key),
        ),
      );
      for (const value of dbEnum.values) {
        elements.push(
          semanticElement("enumValue", value.key, dbEnum.key, {
            name: value.name,
          }),
        );
      }
    }
  }

  addPhysicalReferences(elements, graph, consumedReferenceKeys);
  if (sourceGraph) {
    for (const collapse of collapses) {
      addManyToManyReference(elements, collapse.manyToManyReference);
    }
  } else {
    for (const reference of graph.references.filter(isManyToMany)) {
      addManyToManyReference(elements, reference);
    }
  }

  elements.sort(compareElements);
  orders.sort(compareOrders);
  return { version: SCHEMA_SEMANTICS_VERSION, elements, orders };
}

async function hashExportableDocument(document: SemanticDocument): Promise<string> {
  return sha256Utf8(
    canonicalStringify({
      exportSemanticsVersion: SQL_EXPORT_SEMANTICS_VERSION,
      document,
    }),
  );
}

function addTable(
  elements: SemanticElementRecord[],
  orders: SemanticOrderRecord[],
  table: TableNode,
  dialect: PrimaryDialect,
  enumByName: ReadonlyMap<string, readonly string[]>,
  sourceEnumByName: ReadonlyMap<string, readonly string[]>,
  sourceColumnByKey: ReadonlyMap<SchemaElementKey, ColumnNode>,
): void {
  elements.push(
    semanticElement("table", table.key, null, {
      schemaName: table.schemaName,
      name: table.name,
      note: dialect === "MYSQL" ? null : (table.note?.value ?? null),
    }),
  );
  orders.push(
    semanticOrder(
      "table",
      table.key,
      "columnOrder",
      table.columns.map(({ key }) => key),
    ),
  );

  for (const column of table.columns) {
    const sourceColumn = sourceColumnByKey.get(column.key);
    elements.push(
      semanticElement("column", column.key, table.key, {
        name: column.name,
        type: exportableColumnType(column, dialect, enumByName, sourceColumn, sourceEnumByName),
        primaryKey: column.primaryKey,
        unique: column.unique,
        notNull: column.notNull,
        default: exportableDefault(column.default),
        increment: column.increment,
        note: column.note?.value ?? null,
      }),
    );
  }

  addIndexes(elements, table);
  addChecks(elements, table);
}

function addIndexes(elements: SemanticElementRecord[], table: TableNode): void {
  const drafts = table.indexes.map((index) => ({
    index,
    value: indexValue(index),
  }));
  const keys = allocateSignatureKeys(
    "index",
    table.key,
    drafts.map(({ value }) => value),
  );
  for (const [index, draft] of drafts.entries()) {
    const key = keys[index];
    if (!key) continue;
    elements.push(semanticElement("index", key, table.key, draft.value));
  }
}

function indexValue(index: IndexNode): CanonicalObject {
  return {
    terms: index.terms.map((term) =>
      term.kind === "COLUMN"
        ? { kind: "COLUMN", columnKey: term.columnKey }
        : { kind: "EXPRESSION", expression: normalizeExpression(term.expression) },
    ),
    type: normalizeIndexType(index.type),
    unique: index.unique,
    primaryKey: index.primaryKey,
  };
}

function addChecks(elements: SemanticElementRecord[], table: TableNode): void {
  const drafts = [...table.checks, ...table.columns.flatMap((column) => column.checks)].map(
    (check) => ({
      expression: normalizeExpression(check.expression),
    }),
  );
  const values: CanonicalObject[] = drafts.map(({ expression }) => ({ expression }));
  const keys = allocateSignatureKeys("check", table.key, values);
  for (const [index, value] of values.entries()) {
    const key = keys[index];
    if (!key) continue;
    elements.push(semanticElement("check", key, table.key, value));
  }
}

function addPhysicalReferences(
  elements: SemanticElementRecord[],
  graph: SchemaGraph,
  consumedReferenceKeys: ReadonlySet<SchemaElementKey>,
): void {
  const drafts: ReferenceDraft[] = graph.references.flatMap((reference) => {
    if (reference.inactive || consumedReferenceKeys.has(reference.key) || isManyToMany(reference)) {
      return [];
    }
    const physical = physicalReference(reference);
    if (!physical) return [];
    const value: CanonicalObject = {
      kind: "FOREIGN_KEY",
      fkTableKey: physical.fkTableKey,
      fkColumnKeys: [...physical.fkColumnKeys],
      referencedTableKey: physical.referencedTableKey,
      referencedColumnKeys: [...physical.referencedColumnKeys],
      onDelete: physical.onDelete,
      onUpdate: physical.onUpdate,
    };
    return [{ value, signature: value }];
  });
  const keys = allocateSignatureKeys(
    "reference",
    "physical",
    drafts.map(({ signature }) => signature),
  );
  for (const [index, draft] of drafts.entries()) {
    const key = keys[index];
    if (!key) continue;
    elements.push(semanticElement("reference", key, null, draft.value));
  }
}

function addManyToManyReference(elements: SemanticElementRecord[], reference: ReferenceEdge): void {
  const value = manyToManyValue(reference);
  const key = qualifiedElementKey("reference", "many-to-many", value);
  elements.push(semanticElement("reference", key, null, value));
}

function manyToManyValue(reference: ReferenceEdge): CanonicalObject {
  return {
    kind: "MANY_TO_MANY",
    endpoints: reference.endpoints.map((endpoint) => ({
      tableKey: endpoint.tableKey,
      columnKeys: endpoint.columnKeys,
    })),
    onDelete: normalizeAction(reference.onDelete),
    onUpdate: normalizeAction(reference.onUpdate),
  };
}

function findJunctionCollapses(
  sourceGraph: SchemaGraph,
  generatedGraph: SchemaGraph,
  dialect: PrimaryDialect,
): JunctionCollapse[] {
  const sourceTableKeys = new Set(sourceGraph.tables.map(({ key }) => key));
  const availableTables = new Set(
    generatedGraph.tables.filter(({ key }) => !sourceTableKeys.has(key)).map(({ key }) => key),
  );
  const availableReferences = new Set(
    generatedGraph.references.filter(({ inactive }) => !inactive).map(({ key }) => key),
  );
  const collapses: JunctionCollapse[] = [];

  for (const reference of sourceGraph.references.filter(isManyToMany)) {
    const candidates = generatedGraph.tables.filter(
      (table) =>
        availableTables.has(table.key) &&
        matchesJunctionTable(
          table,
          reference,
          sourceGraph,
          generatedGraph,
          availableReferences,
          dialect,
        ),
    );
    if (candidates.length !== 1) continue;

    const table = candidates[0];
    if (!table) continue;
    const referenceKeys = new Set(
      generatedGraph.references
        .filter((candidate) => {
          const physical = physicalReference(candidate);
          return (
            physical !== null &&
            physical.fkTableKey === table.key &&
            availableReferences.has(candidate.key)
          );
        })
        .map(({ key }) => key),
    );
    availableTables.delete(table.key);
    for (const key of referenceKeys) availableReferences.delete(key);
    collapses.push({ tableKey: table.key, referenceKeys, manyToManyReference: reference });
  }

  return collapses;
}

function matchesJunctionTable(
  candidateTable: TableNode,
  sourceReference: ReferenceEdge,
  sourceGraph: SchemaGraph,
  generatedGraph: SchemaGraph,
  availableReferences: ReadonlySet<SchemaElementKey>,
  dialect: PrimaryDialect,
): boolean {
  const incidentReferences = generatedGraph.references.filter(
    (reference) =>
      availableReferences.has(reference.key) &&
      reference.endpoints.some(({ tableKey }) => tableKey === candidateTable.key),
  );
  const physicalReferences = incidentReferences.flatMap((reference) => {
    const physical = physicalReference(reference);
    return physical ? [physical] : [];
  });
  if (
    incidentReferences.length !== 2 ||
    physicalReferences.length !== 2 ||
    physicalReferences.some(({ fkTableKey }) => fkTableKey !== candidateTable.key)
  ) {
    return false;
  }

  const matches = matchJunctionReferences(sourceReference, physicalReferences);
  if (!matches) return false;
  const expectedOnDelete = normalizeAction(sourceReference.onDelete);
  const expectedOnUpdate = normalizeAction(sourceReference.onUpdate);
  if (
    physicalReferences.some(
      ({ onDelete, onUpdate }) => onDelete !== expectedOnDelete || onUpdate !== expectedOnUpdate,
    )
  ) {
    return false;
  }

  const generatedColumnByKey = new Map(
    candidateTable.columns.map((column) => [column.key, column]),
  );
  const sourceColumnByKey = new Map(
    sourceGraph.tables.flatMap((table) => table.columns.map((column) => [column.key, column])),
  );
  const generatedEnumByName = enumLookup(generatedGraph);
  const sourceEnumByName = enumLookup(sourceGraph);

  for (const [endpoint, physical] of matches) {
    if (endpoint.columnKeys.length !== physical.fkColumnKeys.length) return false;
    for (const [index, sourceColumnKey] of endpoint.columnKeys.entries()) {
      const sourceColumn = sourceColumnByKey.get(sourceColumnKey);
      const generatedColumn = generatedColumnByKey.get(physical.fkColumnKeys[index] ?? "");
      if (!sourceColumn || !generatedColumn) return false;
      const sourceType = exportableColumnType(
        sourceColumn,
        dialect,
        sourceEnumByName,
        undefined,
        sourceEnumByName,
      );
      const generatedType = exportableColumnType(
        generatedColumn,
        dialect,
        generatedEnumByName,
        undefined,
        sourceEnumByName,
      );
      if (canonicalStringify(sourceType) !== canonicalStringify(generatedType)) return false;
    }
  }

  const foreignKeyColumns = physicalReferences.flatMap(({ fkColumnKeys }) => [...fkColumnKeys]);
  if (
    new Set(foreignKeyColumns).size !== foreignKeyColumns.length ||
    candidateTable.columns.length !== foreignKeyColumns.length
  ) {
    return false;
  }
  const primaryKeyColumns = tablePrimaryKeyColumns(candidateTable);
  return sameStringSet(primaryKeyColumns, foreignKeyColumns);
}

function matchJunctionReferences(
  sourceReference: ReferenceEdge,
  physicalReferences: readonly PhysicalReference[],
): Array<[ReferenceEdge["endpoints"][number], PhysicalReference]> | null {
  const remaining = [...physicalReferences];
  const result: Array<[ReferenceEdge["endpoints"][number], PhysicalReference]> = [];
  for (const endpoint of sourceReference.endpoints) {
    const index = remaining.findIndex(
      (candidate) =>
        candidate.referencedTableKey === endpoint.tableKey &&
        sameStrings(candidate.referencedColumnKeys, endpoint.columnKeys),
    );
    if (index < 0) return null;
    const matched = remaining[index];
    if (!matched) return null;
    remaining.splice(index, 1);
    result.push([endpoint, matched]);
  }
  return remaining.length === 0 ? result : null;
}

function tablePrimaryKeyColumns(table: TableNode): SchemaElementKey[] {
  const inline = table.columns.filter(({ primaryKey }) => primaryKey).map(({ key }) => key);
  const tableIndex = table.indexes.find(({ primaryKey }) => primaryKey);
  if (!tableIndex) return inline;
  const indexed = tableIndex.terms.flatMap((term) =>
    term.kind === "COLUMN" ? [term.columnKey] : [],
  );
  return indexed.length === tableIndex.terms.length ? indexed : [];
}

function physicalReference(reference: ReferenceEdge): PhysicalReference | null {
  if (reference.inactive || isManyToMany(reference)) return null;
  const referencedIndex = reference.endpoints.findIndex(
    ({ multiplicity }) => multiplicity.max === 1,
  );
  if (referencedIndex < 0) return null;
  const fkIndex = referencedIndex === 0 ? 1 : 0;
  const referenced = reference.endpoints[referencedIndex];
  const foreignKey = reference.endpoints[fkIndex];
  if (!referenced || !foreignKey) return null;
  return {
    source: reference,
    fkTableKey: foreignKey.tableKey,
    fkColumnKeys: foreignKey.columnKeys,
    referencedTableKey: referenced.tableKey,
    referencedColumnKeys: referenced.columnKeys,
    onDelete: normalizeAction(reference.onDelete),
    onUpdate: normalizeAction(reference.onUpdate),
  };
}

function isManyToMany(reference: ReferenceEdge): boolean {
  return reference.endpoints.every(({ multiplicity }) => multiplicity.max === null);
}

function exportableColumnType(
  column: ColumnNode,
  dialect: PrimaryDialect,
  enumByName: ReadonlyMap<string, readonly string[]>,
  sourceColumn: ColumnNode | undefined,
  sourceEnumByName: ReadonlyMap<string, readonly string[]>,
): CanonicalObject {
  if (
    dialect === "POSTGRESQL" &&
    sourceColumn &&
    enumTypeValues(sourceColumn, sourceEnumByName)?.arrayDepth
  ) {
    return exportableColumnType(
      sourceColumn,
      dialect,
      sourceEnumByName,
      undefined,
      sourceEnumByName,
    );
  }

  const enumType = enumTypeValues(column, enumByName);
  if (enumType) {
    return {
      kind: "ENUM",
      enumKey:
        dialect === "POSTGRESQL"
          ? qualifiedElementKey("enum", enumType.schemaName, enumType.name)
          : null,
      values: [...enumType.values],
      arrayDepth: enumType.arrayDepth,
    };
  }

  const rawName = column.type.name.trim();
  const arrayDepth = trailingArrayDepth(rawName);
  const withoutArray = rawName.slice(0, rawName.length - arrayDepth * 2);
  const normalizedName = normalizeTypeName(withoutArray, dialect, column.increment);
  return {
    kind: "TYPE",
    schemaName: column.type.schemaName,
    name: normalizedName,
    arguments: normalizeTypeArguments(column.type.arguments, normalizedName, dialect),
    arrayDepth,
  };
}

function enumTypeValues(
  column: ColumnNode,
  enumByName: ReadonlyMap<string, readonly string[]>,
): {
  readonly schemaName: string;
  readonly name: string;
  readonly values: readonly string[];
  readonly arrayDepth: number;
} | null {
  const rawName = stripIdentifierQuotes(column.type.name.trim());
  const arrayDepth = trailingArrayDepth(rawName);
  const name = stripIdentifierQuotes(rawName.slice(0, rawName.length - arrayDepth * 2));
  const schemaName = stripIdentifierQuotes(column.type.schemaName ?? "public");
  const direct = enumByName.get(enumIdentity(schemaName, name));
  if (direct) return { schemaName, name, values: direct, arrayDepth };

  const qualifiedParts = name.split(".");
  if (qualifiedParts.length >= 2) {
    const qualifiedName = stripIdentifierQuotes(qualifiedParts.at(-1) ?? name);
    const qualifiedSchema = stripIdentifierQuotes(qualifiedParts.at(-2) ?? schemaName);
    const values = enumByName.get(enumIdentity(qualifiedSchema, qualifiedName));
    if (values) {
      return {
        schemaName: qualifiedSchema,
        name: qualifiedName,
        values,
        arrayDepth,
      };
    }
  }
  return null;
}

function enumLookup(graph: SchemaGraph): Map<string, readonly string[]> {
  return new Map(
    graph.enums.map((dbEnum) => [
      enumIdentity(dbEnum.schemaName, dbEnum.name),
      dbEnum.values.map(({ name }) => name),
    ]),
  );
}

function enumIdentity(schemaName: string, name: string): string {
  return JSON.stringify([schemaName, name]);
}

function exportableDefault(value: ColumnDefaultNode | null): CanonicalValue {
  if (!value) return null;
  return value.type === "expression"
    ? { type: value.type, value: normalizeExpression(value.value) }
    : value;
}

function normalizeTypeName(name: string, dialect: PrimaryDialect, increment: boolean): string {
  const lowered = normalizeWhitespace(stripIdentifierQuotes(name)).toLowerCase();
  if (dialect === "POSTGRESQL" && increment) {
    if (["smallserial", "smallint", "int2"].includes(lowered)) return "smallint";
    if (["bigserial", "bigint", "int8"].includes(lowered)) return "bigint";
    if (["serial", "integer", "int", "int4"].includes(lowered)) return "integer";
  }
  if (dialect === "POSTGRESQL") {
    if (["int", "int4"].includes(lowered)) return "integer";
    if (lowered === "int2") return "smallint";
    if (lowered === "int8") return "bigint";
    if (lowered === "bool") return "boolean";
    if (lowered === "timestamp without time zone") return "timestamp";
  }
  if (dialect === "MYSQL") {
    if (lowered === "integer") return "int";
    if (lowered === "bool") return "boolean";
  }
  return lowered;
}

function normalizeTypeArguments(
  value: string | null,
  typeName: string,
  dialect: PrimaryDialect,
): string | null {
  if (value === null && dialect === "MYSQL") {
    if (typeName === "varchar") return "255";
    if (typeName === "char" || typeName === "binary") return "1";
  }
  return value === null ? null : normalizeWhitespace(value).replace(/\s*,\s*/gu, ",");
}

function normalizeIndexType(value: string | null): string {
  return value?.trim().toLowerCase() || DEFAULT_INDEX_TYPE;
}

function normalizeAction(value: string | null): string | null {
  return value === null ? null : normalizeWhitespace(value).toLowerCase();
}

function normalizeExpression(value: string): string {
  let normalized = normalizeWhitespace(value.trim());
  while (hasBalancedOuterParentheses(normalized)) {
    normalized = normalizeWhitespace(normalized.slice(1, -1).trim());
  }
  return normalized;
}

function hasBalancedOuterParentheses(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function trailingArrayDepth(value: string): number {
  let depth = 0;
  let remaining = value;
  while (remaining.endsWith("[]")) {
    depth += 1;
    remaining = remaining.slice(0, -2);
  }
  return depth;
}

function stripIdentifierQuotes(value: string): string {
  return value.replace(/^["`]([\s\S]*)["`]$/u, "$1");
}

function allocateSignatureKeys(
  kind: Extract<SchemaElementKind, "index" | "check" | "reference">,
  ownerKey: SchemaElementKey,
  signatures: readonly CanonicalObject[],
): SchemaElementKey[] {
  const bases = signatures.map((signature) => qualifiedElementKey(kind, ownerKey, signature));
  const counts = countValues(bases);
  const occurrences = new Map<string, number>();
  return bases.map((base, index) => {
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return (counts.get(base) ?? 0) === 1
      ? base
      : qualifiedElementKey(kind, ownerKey, signatures[index] ?? null, occurrence);
  });
}

function countValues(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort(compareCodeUnits);
  const sortedRight = [...right].sort(compareCodeUnits);
  return sameStrings(sortedLeft, sortedRight);
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
