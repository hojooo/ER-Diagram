import type { Database, RelationCardinality } from "@dbml/core";
import { parseCardinality } from "@dbml/parse";
import {
  qualifiedElementKey,
  type ColumnDefaultNode,
  type SchemaElementKey,
  type SchemaElementKind,
  type SchemaGraph,
  type SchemaKeySegment,
} from "./schema-graph.js";
import {
  canonicalStringify,
  compareCodeUnits,
  diffSemanticDocuments,
  hashSemanticDocument,
  SCHEMA_SEMANTICS_VERSION,
  schemaGraphSemanticDocument,
  semanticElement,
  semanticOrder,
  type CanonicalObject,
  type CanonicalValue,
  type SemanticDocument,
  type SemanticElementRecord,
  type SemanticOrderRecord,
} from "./schema-semantics.js";
import type { SqlSemanticVerification } from "./sql-import.js";

const DEFAULT_SCHEMA = "public";

type SqlSchema = Database["schemas"][number];
type SqlTable = SqlSchema["tables"][number];
type SqlField = SqlTable["fields"][number];
type SqlIndex = SqlTable["indexes"][number];
type SqlCheck = SqlTable["checks"][number];
type SqlReference = SqlSchema["refs"][number];

interface ConstraintCandidate {
  readonly name: string | null;
  readonly signature: SchemaKeySegment;
  readonly path?: readonly SchemaKeySegment[];
}

interface SqlIndexDraft {
  readonly key: SchemaElementKey;
  readonly name: string | null;
  readonly value: CanonicalObject;
}

interface SqlCheckDraft {
  readonly key: SchemaElementKey;
  readonly name: string | null;
  readonly value: CanonicalObject;
}

interface SqlReferenceDraft {
  readonly schemaName: string;
  readonly name: string | null;
  readonly value: CanonicalObject;
  readonly signature: SchemaKeySegment;
}

export async function verifySqlModelToGraph(
  database: Database,
  graph: SchemaGraph,
): Promise<SqlSemanticVerification> {
  const sourceDocument = sqlModelSemanticDocument(database);
  const candidateDocument = schemaGraphSemanticDocument(graph);
  const [sourceModelHash, candidateSchemaHash] = await Promise.all([
    hashSemanticDocument(sourceDocument),
    hashSemanticDocument(candidateDocument),
  ]);
  const changes = diffSemanticDocuments(sourceDocument, candidateDocument);
  return changes.length === 0 && sourceModelHash === candidateSchemaHash
    ? {
        status: "VERIFIED",
        sourceModelHash,
        candidateSchemaHash,
        changes: [],
      }
    : {
        status: "FAILED",
        sourceModelHash,
        candidateSchemaHash,
        changes,
      };
}

export function sqlModelSemanticDocument(database: Database): SemanticDocument {
  const elements: SemanticElementRecord[] = [];
  const orders: SemanticOrderRecord[] = [];

  for (const schema of database.schemas) {
    const schemaName = schemaNameOrDefault(schema.name);
    for (const table of schema.tables) {
      addTable(elements, orders, schemaName, table);
    }
    for (const dbEnum of schema.enums) {
      const enumKey = qualifiedElementKey("enum", schemaName, dbEnum.name);
      elements.push(
        semanticElement("enum", enumKey, null, {
          schemaName,
          name: dbEnum.name,
          note: semanticNote(dbEnum.note),
        }),
      );
      const valueKeys = dbEnum.values.map((value) =>
        qualifiedElementKey("enumValue", schemaName, dbEnum.name, value.name),
      );
      orders.push(semanticOrder("enum", enumKey, "valueOrder", valueKeys));
      for (const [index, value] of dbEnum.values.entries()) {
        const key = valueKeys[index];
        if (!key) continue;
        elements.push(
          semanticElement("enumValue", key, enumKey, {
            name: value.name,
            note: semanticNote(value.note),
          }),
        );
      }
    }
  }

  addReferences(elements, database);
  elements.sort(compareSemanticElements);
  orders.sort(compareSemanticOrders);
  return { version: SCHEMA_SEMANTICS_VERSION, elements, orders };
}

function addTable(
  elements: SemanticElementRecord[],
  orders: SemanticOrderRecord[],
  schemaName: string,
  table: SqlTable,
): void {
  const tableKey = qualifiedElementKey("table", schemaName, table.name);
  elements.push(
    semanticElement("table", tableKey, null, {
      schemaName,
      name: table.name,
      alias: nullableString(table.alias),
      note: semanticNote(table.note),
      color: nullableString(table.headerColor),
      metadata: metadata(table.metadata),
      partialKeys: [],
    }),
  );

  const columnKeys = table.fields.map((field) =>
    qualifiedElementKey("column", schemaName, table.name, field.name),
  );
  orders.push(semanticOrder("table", tableKey, "columnOrder", columnKeys));

  for (const [index, field] of table.fields.entries()) {
    const columnKey = columnKeys[index];
    if (!columnKey) continue;
    elements.push(
      semanticElement("column", columnKey, tableKey, {
        name: field.name,
        type: semanticColumnType(field),
        primaryKey: Boolean(field.pk),
        unique: Boolean(field.unique),
        notNull: Boolean(field.not_null),
        default: semanticDefault(field.dbdefault),
        increment: Boolean(field.increment),
        note: semanticNote(field.note),
        metadata: metadata(field.metadata),
        injectedFrom: null,
      }),
    );
    addChecks(elements, "check", schemaName, table, field.checks, tableKey, columnKey);
  }

  addIndexes(elements, schemaName, table, tableKey);
  addChecks(elements, "check", schemaName, table, table.checks, tableKey, null);
}

function addIndexes(
  elements: SemanticElementRecord[],
  schemaName: string,
  table: SqlTable,
  tableKey: SchemaElementKey,
): void {
  const values = table.indexes.map((index) => indexSemanticValue(index, schemaName, table.name));
  const keys = allocateConstraintKeys(
    "index",
    [schemaName, table.name],
    values.map(({ name, value }) => ({
      name,
      signature: {
        terms: value.terms as SchemaKeySegment,
        type: value.type as SchemaKeySegment,
        unique: value.unique as SchemaKeySegment,
        primaryKey: value.primaryKey as SchemaKeySegment,
      },
    })),
  );

  const drafts: SqlIndexDraft[] = values.flatMap((value, index) => {
    const key = keys[index];
    return key ? [{ key, ...value }] : [];
  });
  for (const index of drafts) {
    elements.push(semanticElement("index", index.key, tableKey, index.value));
  }
}

function indexSemanticValue(
  index: SqlIndex,
  schemaName: string,
  tableName: string,
): { name: string | null; value: CanonicalObject } {
  const name = nullableString(index.name);
  return {
    name,
    value: {
      name,
      terms: index.columns.map((term) =>
        term.type === "column" || term.type === "string"
          ? {
              kind: "COLUMN",
              columnKey: qualifiedElementKey("column", schemaName, tableName, String(term.value)),
            }
          : { kind: "EXPRESSION", expression: String(term.value ?? "") },
      ),
      type: nullableString(index.type)?.toLowerCase() ?? null,
      unique: Boolean(index.unique),
      primaryKey: Boolean(index.pk),
      note: semanticNote(index.note),
      injectedFrom: null,
    },
  };
}

function addChecks(
  elements: SemanticElementRecord[],
  kind: Extract<SchemaElementKind, "check">,
  schemaName: string,
  table: SqlTable,
  checks: readonly SqlCheck[],
  tableKey: SchemaElementKey,
  columnKey: SchemaElementKey | null,
): void {
  const values = checks.map((check) => checkSemanticValue(check, tableKey, columnKey));
  const keys = allocateConstraintKeys(
    kind,
    [schemaName, table.name],
    values.map(({ name, value }) => ({
      name,
      signature: {
        expression: value.expression as SchemaKeySegment,
        tableKey: value.tableKey as SchemaKeySegment,
        columnKey: value.columnKey as SchemaKeySegment,
      },
      path: columnKey ? [columnKey] : [],
    })),
  );
  const drafts: SqlCheckDraft[] = values.flatMap((value, index) => {
    const key = keys[index];
    return key ? [{ key, ...value }] : [];
  });
  for (const check of drafts) {
    elements.push(semanticElement(kind, check.key, columnKey ?? tableKey, check.value));
  }
}

function checkSemanticValue(
  check: SqlCheck,
  tableKey: SchemaElementKey,
  columnKey: SchemaElementKey | null,
): { name: string | null; value: CanonicalObject } {
  const name = nullableString(check.name);
  return {
    name,
    value: {
      name,
      expression: String(check.expression ?? ""),
      tableKey,
      columnKey,
      injectedFrom: null,
    },
  };
}

function addReferences(elements: SemanticElementRecord[], database: Database): void {
  const values: SqlReferenceDraft[] = database.schemas.flatMap((schema) => {
    const schemaName = schemaNameOrDefault(schema.name);
    return schema.refs.map((reference) => referenceSemanticValue(reference, schemaName));
  });
  const bases = values.map((reference) =>
    reference.name
      ? qualifiedElementKey("reference", reference.schemaName, reference.name)
      : qualifiedElementKey("reference", reference.schemaName, reference.signature),
  );
  const counts = countValues(bases);
  const occurrences = new Map<string, number>();

  for (const [index, reference] of values.entries()) {
    const base = bases[index];
    if (!base) continue;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const key =
      !reference.name && (counts.get(base) ?? 0) > 1
        ? qualifiedElementKey("reference", reference.schemaName, reference.signature, occurrence)
        : base;
    elements.push(semanticElement("reference", key, null, reference.value));
  }
}

function referenceSemanticValue(reference: SqlReference, schemaName: string): SqlReferenceDraft {
  const name = nullableString(reference.name);
  const endpoints = reference.endpoints.map((endpoint) => {
    const endpointSchema = schemaNameOrDefault(endpoint.schemaName);
    const cardinality = parseCardinality(endpoint.relation as RelationCardinality);
    return {
      tableKey: qualifiedElementKey("table", endpointSchema, endpoint.tableName),
      columnKeys: endpoint.fieldNames.map((fieldName) =>
        qualifiedElementKey("column", endpointSchema, endpoint.tableName, fieldName),
      ),
      multiplicity: {
        min: cardinality.min,
        max: cardinality.max === "*" ? null : cardinality.max,
      },
    };
  });
  const referencedIndex = endpoints.findIndex((endpoint) => endpoint.multiplicity.max === 1);
  const referencedEndpoint = referencedIndex > 0 ? endpoints[referencedIndex] : undefined;
  const orderedEndpoints = referencedEndpoint
    ? [referencedEndpoint, ...endpoints.filter((_, index) => index !== referencedIndex)]
    : endpoints;
  const value: CanonicalObject = {
    schemaName,
    name,
    endpoints: orderedEndpoints,
    onDelete: nullableString(reference.onDelete)?.toLowerCase() ?? null,
    onUpdate: nullableString(reference.onUpdate)?.toLowerCase() ?? null,
    color: nullableString(reference.color),
    inactive: Boolean(reference.inactive),
    injectedFrom: null,
  };
  return {
    schemaName,
    name,
    value,
    signature: {
      endpoints: orderedEndpoints,
      onDelete: value.onDelete as SchemaKeySegment,
      onUpdate: value.onUpdate as SchemaKeySegment,
      inactive: value.inactive as SchemaKeySegment,
    },
  };
}

function semanticColumnType(field: SqlField): CanonicalObject {
  const sourceType = field.type as {
    schemaName?: unknown;
    type_name?: unknown;
    args?: unknown;
  };
  const schemaName = nullableString(sourceType.schemaName);
  const rawName =
    typeof sourceType.type_name === "string" ? sourceType.type_name.trim() : "unknown";
  const explicitArguments = typeof sourceType.args === "string" ? sourceType.args : null;
  const split = splitTrailingArguments(rawName);
  const argumentsValue = explicitArguments ?? split.arguments;
  let nameWithNoArguments = split.name;
  const schemaPrefix = schemaName ? `${schemaName}.` : "";
  if (schemaPrefix && nameWithNoArguments.startsWith(schemaPrefix)) {
    nameWithNoArguments = nameWithNoArguments.slice(schemaPrefix.length);
  }

  // DBML 9.1.1 duplicates the schema segment for schema-qualified enum arrays.
  // The capability report marks this as PARTIAL; verification models the known exporter output.
  const name =
    schemaName && rawName.endsWith("[]") && rawName.startsWith(`${schemaName}.`)
      ? rawName
      : nameWithNoArguments;
  return { schemaName, name, arguments: argumentsValue };
}

function splitTrailingArguments(value: string): { name: string; arguments: string | null } {
  if (!value.endsWith(")")) return { name: value, arguments: null };
  let depth = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const character = value[index];
    if (character === ")") depth += 1;
    if (character === "(") {
      depth -= 1;
      if (depth === 0) {
        return {
          name: value.slice(0, index),
          arguments: value.slice(index + 1, -1),
        };
      }
    }
  }
  return { name: value, arguments: null };
}

function semanticDefault(value: unknown): ColumnDefaultNode | null {
  if (typeof value !== "object" || value === null || !("type" in value)) return null;
  const type = (value as { type?: unknown }).type;
  const raw = (value as { value?: unknown }).value;
  if (type === "number") {
    const numberValue = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(numberValue) ? { type: "number", value: numberValue } : null;
  }
  if (type === "string") return { type: "string", value: String(raw ?? "") };
  if (type === "expression") return { type: "expression", value: String(raw ?? "") };
  if (type === "boolean") {
    if (raw === null || raw === "null") return { type: "null", value: null };
    if (raw === true || raw === "true") return { type: "boolean", value: true };
    if (raw === false || raw === "false") return { type: "boolean", value: false };
  }
  return null;
}

function semanticNote(value: unknown): CanonicalValue {
  return typeof value === "string" ? { value } : null;
}

function metadata(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function allocateConstraintKeys(
  kind: Extract<SchemaElementKind, "index" | "check">,
  context: readonly SchemaKeySegment[],
  candidates: readonly ConstraintCandidate[],
): SchemaElementKey[] {
  const bases = candidates.map((candidate) =>
    candidate.name
      ? qualifiedElementKey(kind, ...context, ...(candidate.path ?? []), candidate.name)
      : qualifiedElementKey(kind, ...context, ...(candidate.path ?? []), candidate.signature),
  );
  const counts = countValues(bases);
  const occurrences = new Map<string, number>();
  return candidates.map((candidate, index) => {
    const base = bases[index];
    if (!base) throw new Error("SQL semantic constraint key allocation failed.");
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return candidate.name || (counts.get(base) ?? 0) === 1
      ? base
      : qualifiedElementKey(
          kind,
          ...context,
          ...(candidate.path ?? []),
          candidate.signature,
          occurrence,
        );
  });
}

function countValues(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function schemaNameOrDefault(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : DEFAULT_SCHEMA;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function compareSemanticElements(
  left: SemanticElementRecord,
  right: SemanticElementRecord,
): number {
  return (
    compareCodeUnits(left.elementKind, right.elementKind) || compareCodeUnits(left.key, right.key)
  );
}

function compareSemanticOrders(left: SemanticOrderRecord, right: SemanticOrderRecord): number {
  return (
    compareCodeUnits(left.ownerKind, right.ownerKind) ||
    compareCodeUnits(left.ownerKey, right.ownerKey) ||
    compareCodeUnits(left.field, right.field)
  );
}

export function sqlSemanticDebugString(document: SemanticDocument): string {
  return canonicalStringify(document);
}
