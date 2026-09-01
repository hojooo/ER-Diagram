type CompilerRecord = Record<string, unknown>;

interface PreparedSchema extends CompilerRecord {
  name: string;
  tables: CompilerRecord[];
  enums: CompilerRecord[];
  refs: CompilerRecord[];
  tableGroups: CompilerRecord[];
}

interface PartialInjection extends CompilerRecord {
  name: string;
  order: number;
  token: unknown;
}

const DEFAULT_SCHEMA = "public";

/**
 * Adapts the DBML v2 compiler's plain result to the parser-model shape consumed by graph
 * normalization. This intentionally mirrors @dbml/core's DBML-only model preparation without
 * loading its SQL dialect parsers into the browser worker.
 */
export function prepareCompilerDatabase(input: unknown): unknown {
  const raw = record(input, "database");
  const partials = records(raw.tablePartials, "tablePartials");
  const enumNames = collectEnumNames(raw);
  const partialByName = new Map(
    partials.map((partial) => [requiredString(partial.name, "tablePartial.name"), partial]),
  );
  const schemas: PreparedSchema[] = [];
  const schemaByName = new Map<string, PreparedSchema>();
  const injectedReferences: CompilerRecord[] = [];

  const ensureSchema = (nameValue: unknown): PreparedSchema => {
    const name = optionalString(nameValue) ?? DEFAULT_SCHEMA;
    const existing = schemaByName.get(name);
    if (existing) return existing;
    const schema: PreparedSchema = {
      name,
      tables: [],
      enums: [],
      refs: [],
      tableGroups: [],
    };
    schemas.push(schema);
    schemaByName.set(name, schema);
    return schema;
  };

  for (const sourceSchema of records(raw.schemas, "schemas")) {
    const name = requiredString(sourceSchema.name, "schema.name");
    const schema = ensureSchema(name);
    Object.assign(schema, sourceSchema, {
      name,
      enums: records(sourceSchema.enums, `schema.${name}.enums`),
      tables: records(sourceSchema.tables, `schema.${name}.tables`).map((table) =>
        prepareTable(table, partialByName, injectedReferences, enumNames),
      ),
      refs: records(sourceSchema.refs, `schema.${name}.refs`),
      tableGroups: records(sourceSchema.tableGroups, `schema.${name}.tableGroups`),
    });
  }

  // @dbml/core constructs schemas in this order. Keeping it preserves graph array ordering and
  // anonymous constraint ordinals while the semantic hash remains parser-version compatible.
  for (const item of records(raw.enums, "enums")) {
    ensureSchema(item.schemaName).enums.push(item);
  }
  for (const item of records(raw.tables, "tables")) {
    ensureSchema(item.schemaName).tables.push(
      prepareTable(item, partialByName, injectedReferences, enumNames),
    );
  }
  for (const item of records(raw.refs, "refs")) {
    ensureSchema(item.schemaName).refs.push(item);
  }
  for (const item of records(raw.tableGroups, "tableGroups")) {
    ensureSchema(item.schemaName).tableGroups.push(item);
  }

  const publicReferences = ensureSchema(DEFAULT_SCHEMA).refs;
  for (const reference of injectedReferences) {
    if (!publicReferences.some((current) => sameReferenceEndpoints(current, reference))) {
      publicReferences.push(reference);
    }
  }

  const project = optionalRecord(raw.project, "project") ?? {};
  const projectNote = optionalRecord(project.note, "project.note");
  return {
    token: project.token,
    name: project.name,
    databaseType: project.database_type,
    note: project.note,
    noteToken: projectNote?.token ?? null,
    notes: records(raw.notes, "notes"),
    schemas,
    tablePartials: partials,
    diagramViews: records(raw.diagramViews, "diagramViews"),
  };
}

function prepareTable(
  source: CompilerRecord,
  partialByName: ReadonlyMap<string, CompilerRecord>,
  injectedReferences: CompilerRecord[],
  enumNames: ReadonlySet<string>,
): CompilerRecord {
  const table = { ...source };
  const tableName = requiredString(table.name, "table.name");
  const schemaName = optionalString(table.schemaName) ?? DEFAULT_SCHEMA;
  const localFields = records(table.fields, `table.${tableName}.fields`).map((field) =>
    prepareFieldType(field, enumNames),
  );
  const partials = readPartialInjections(table.partials, tableName).sort(
    (left, right) => right.order - left.order,
  );
  const fields: Array<CompilerRecord | { readonly marker: PartialInjection }> = [...localFields];

  for (const injection of [...partials].reverse()) {
    if (injection.order < 0 || injection.order > fields.length) {
      throw new TypeError(`Table partial order is invalid for ${tableName}.`);
    }
    fields.splice(injection.order, 0, { marker: injection });
  }

  const existingFieldNames = new Set(
    localFields.map((field) => requiredString(field.name, `table.${tableName}.field.name`)),
  );
  const injectedIndexes: CompilerRecord[] = [];
  const injectedChecks: CompilerRecord[] = [];
  let note = table.note;
  let noteToken = optionalRecord(table.note, `table.${tableName}.note`)?.token ?? null;
  let headerColor = table.headerColor;

  for (const injection of partials) {
    const partial = partialByName.get(injection.name);
    if (!partial) throw new TypeError(`Table partial was not found: ${injection.name}.`);

    const injectedPartial = {
      name: injection.name,
      token: partial.token,
    };
    const injectedFields = records(partial.fields, `partial.${injection.name}.fields`)
      .filter((field) => {
        const name = requiredString(field.name, `partial.${injection.name}.field.name`);
        if (existingFieldNames.has(name)) return false;
        existingFieldNames.add(name);
        return true;
      })
      .map((field) => {
        const prepared = prepareFieldType(
          {
            ...field,
            noteToken: null,
            injectedPartial,
            injectedToken: injection.token,
          },
          enumNames,
        );
        for (const inlineReference of records(
          field.inline_refs,
          `partial.${injection.name}.field.inline_refs`,
        )) {
          injectedReferences.push(
            prepareInjectedReference({
              tableName,
              schemaName,
              field: prepared,
              inlineReference,
              injectedPartial,
            }),
          );
        }
        return prepared;
      });

    if (injection.order >= fields.length || !("marker" in required(fields[injection.order]))) {
      throw new TypeError(`Table partial marker is invalid for ${tableName}.`);
    }
    fields.splice(injection.order, 1, ...injectedFields);

    if (note == null && partial.note != null) {
      note = readNoteValue(partial.note);
      noteToken = null;
    }
    if (headerColor == null && partial.headerColor != null) headerColor = partial.headerColor;

    injectedIndexes.push(
      ...records(partial.indexes, `partial.${injection.name}.indexes`).map((index) => ({
        ...index,
        injectedPartial,
      })),
    );
    injectedChecks.push(
      ...records(partial.checks, `partial.${injection.name}.checks`).map((check) => ({
        ...check,
        name:
          optionalString(check.name) === null
            ? check.name
            : `${tableName}.${requiredString(check.name, "partial.check.name")}`,
        injectedPartial,
      })),
    );
  }

  return {
    ...table,
    note,
    noteToken,
    headerColor,
    fields: fields.map((field) => {
      if ("marker" in field) throw new TypeError(`Unresolved table partial for ${tableName}.`);
      return field;
    }),
    partials,
    indexes: [...injectedIndexes, ...records(table.indexes, `table.${tableName}.indexes`)],
    checks: [...injectedChecks, ...records(table.checks, `table.${tableName}.checks`)],
  };
}

function collectEnumNames(raw: CompilerRecord): ReadonlySet<string> {
  const names = new Set<string>();
  for (const schema of records(raw.schemas, "schemas")) {
    const schemaName = requiredString(schema.name, "schema.name");
    for (const item of records(schema.enums, `schema.${schemaName}.enums`)) {
      names.add(enumIdentity(schemaName, requiredString(item.name, "enum.name")));
    }
  }
  for (const item of records(raw.enums, "enums")) {
    names.add(
      enumIdentity(
        optionalString(item.schemaName) ?? DEFAULT_SCHEMA,
        requiredString(item.name, "enum.name"),
      ),
    );
  }
  return names;
}

function prepareFieldType(source: CompilerRecord, enumNames: ReadonlySet<string>): CompilerRecord {
  const type = optionalRecord(source.type, "field.type");
  if (!type) return source;
  const schemaName = optionalString(type.schemaName);
  const typeName = optionalString(type.type_name);
  if (!schemaName || !typeName || enumNames.has(enumIdentity(schemaName, typeName))) return source;

  // Field.bindType() in @dbml/core qualifies an unresolved schema type even when the compiler
  // type name is already qualified. Reproducing that pinned behavior keeps existing semantic
  // hashes, including the documented PostgreSQL schema-qualified enum-array gap.
  return {
    ...source,
    type: {
      ...type,
      type_name: `${schemaName}.${typeName}`,
      originalTypeName: typeName,
    },
  };
}

function enumIdentity(schemaName: string, enumName: string): string {
  return JSON.stringify([schemaName, enumName]);
}

function prepareInjectedReference({
  tableName,
  schemaName,
  field,
  inlineReference,
  injectedPartial,
}: {
  tableName: string;
  schemaName: string;
  field: CompilerRecord;
  inlineReference: CompilerRecord;
  injectedPartial: CompilerRecord;
}): CompilerRecord {
  const [localRelation, remoteRelation] = inlineReferenceRelations(inlineReference.relation);
  return {
    token: field.token,
    endpoints: [
      {
        tableName,
        schemaName,
        fieldNames: [requiredString(field.name, "injected field.name")],
        relation: localRelation,
        token: field.token,
        fields: [field],
      },
      {
        tableName: requiredString(inlineReference.tableName, "inline reference.tableName"),
        schemaName: inlineReference.schemaName,
        fieldNames: strings(inlineReference.fieldNames, "inline reference.fieldNames"),
        relation: remoteRelation,
        token: inlineReference.token,
        fields: [],
      },
    ],
    injectedPartial,
  };
}

function inlineReferenceRelations(value: unknown): readonly [string, string] {
  switch (value) {
    case ">":
      return ["*", "1"];
    case "<":
      return ["1", "*"];
    case "-":
      return ["1", "1"];
    case "<>":
      return ["*", "*"];
    default:
      return ["*", "*"];
  }
}

function readPartialInjections(value: unknown, tableName: string): PartialInjection[] {
  return records(value, `table.${tableName}.partials`).map((item) => ({
    ...item,
    name: requiredString(item.name, `table.${tableName}.partial.name`),
    order: requiredSafeInteger(item.order, `table.${tableName}.partial.order`),
    token: item.token,
  }));
}

function sameReferenceEndpoints(left: CompilerRecord, right: CompilerRecord): boolean {
  return (
    JSON.stringify(referenceEndpointIdentity(left)) ===
    JSON.stringify(referenceEndpointIdentity(right))
  );
}

function referenceEndpointIdentity(reference: CompilerRecord): unknown {
  return records(reference.endpoints, "reference.endpoints").map((endpoint) => ({
    schemaName: optionalString(endpoint.schemaName) ?? DEFAULT_SCHEMA,
    tableName: endpoint.tableName,
    fieldNames: endpoint.fieldNames,
  }));
}

function readNoteValue(value: unknown): unknown {
  const note = optionalRecord(value, "note");
  return note?.value ?? value;
}

function records(value: unknown, label: string): CompilerRecord[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function optionalRecord(value: unknown, label: string): CompilerRecord | null {
  if (value == null) return null;
  return record(value, label);
}

function record(value: unknown, label: string): CompilerRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as CompilerRecord;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requiredSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer.`);
  }
  return value;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("A required compiler value is missing.");
  return value;
}
