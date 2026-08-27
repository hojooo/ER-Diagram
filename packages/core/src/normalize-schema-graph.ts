import type { Database } from "@dbml/core";
import { parseCardinality, type RelationCardinality } from "@dbml/parse";
import { isSourceRangeValid, resolvePublicFilepath } from "./dbml-source-range.js";
import { sha256Utf8 } from "./hash.js";
import {
  type CheckNode,
  type ColumnDefaultNode,
  type ColumnNode,
  type ColumnTypeNode,
  DBML_PARSER_VERSION,
  type DiagramViewNode,
  type EnumNode,
  type IndexNode,
  type IndexTermNode,
  type PartialInjectionProvenance,
  type ProjectNode,
  qualifiedElementKey,
  type ReferenceEdge,
  type ReferenceEndpoint,
  type SchemaElementKey,
  type SchemaElementKind,
  type SchemaGraph,
  type SchemaKeySegment,
  type SourceRange,
  type StickyNoteNode,
  type TableGroupNode,
  type TableNode,
  type TablePartialNode,
  type TextNote,
} from "./schema-graph.js";
import { sourceOwnerKey, type SourceTextIndex } from "./source-text-index.js";

const DEFAULT_SCHEMA = "public";
const SOURCE_LOCATION_KEYS = new Set(["range", "contentRange", "injectionRange"]);

interface PositionLike {
  offset: number;
  line: number;
  column: number;
}

interface FilepathLike {
  absolute?: string;
  path?: string;
}

interface TokenLike {
  start: PositionLike;
  end: PositionLike;
  filepath?: FilepathLike | string;
}

interface NoteObjectLike {
  value: string;
  token: TokenLike;
}

type NoteLike = string | NoteObjectLike | null | undefined;

interface PartialReferenceLike {
  name: string;
  token: TokenLike;
}

interface ColumnTypeLike {
  schemaName?: string | null;
  type_name?: string;
  args?: string | null;
}

interface DefaultLike {
  type?: unknown;
  value?: unknown;
}

interface CheckLike {
  name?: string | null;
  expression?: string;
  token: TokenLike;
  injectedPartial?: PartialReferenceLike | null;
}

interface FieldLike {
  name: string;
  type?: ColumnTypeLike | null;
  token: TokenLike;
  pk?: boolean;
  unique?: boolean;
  not_null?: boolean;
  dbdefault?: DefaultLike | null;
  increment?: boolean;
  note?: NoteLike;
  noteToken?: TokenLike | null;
  metadata?: Record<string, unknown>;
  checks?: CheckLike[];
  injectedPartial?: PartialReferenceLike | null;
  injectedToken?: TokenLike | null;
}

interface IndexTermLike {
  type?: string;
  value?: unknown;
  token: TokenLike;
}

interface IndexLike {
  name?: string | null;
  columns?: IndexTermLike[];
  type?: string | null;
  unique?: boolean;
  pk?: boolean | string;
  note?: NoteLike;
  noteToken?: TokenLike | null;
  token: TokenLike;
  injectedPartial?: PartialReferenceLike | null;
}

interface TablePartialInjectionLike {
  name: string;
  token: TokenLike;
}

interface SchemaReferenceLike {
  name: string;
}

interface TableLike {
  name: string;
  alias?: string | null;
  note?: NoteLike;
  noteToken?: TokenLike | null;
  headerColor?: string | null;
  metadata?: Record<string, unknown>;
  fields?: FieldLike[];
  indexes?: IndexLike[];
  checks?: CheckLike[];
  partials?: TablePartialInjectionLike[];
  token: TokenLike;
  schema?: SchemaReferenceLike;
}

interface EnumValueLike {
  name: string;
  note?: NoteLike;
  noteToken?: TokenLike | null;
  token: TokenLike;
}

interface EnumLike {
  name: string;
  note?: NoteLike;
  noteToken?: TokenLike | null;
  values?: EnumValueLike[];
  token: TokenLike;
}

interface ReferenceEndpointLike {
  schemaName?: string | null;
  tableName: string;
  fieldNames?: string[];
  relation: string;
  token: TokenLike;
  fields?: FieldLike[];
}

interface ReferenceLike {
  name?: string | null;
  endpoints?: ReferenceEndpointLike[];
  onDelete?: string | null;
  onUpdate?: string | null;
  color?: string | null;
  inactive?: boolean;
  injectedPartial?: PartialReferenceLike | null;
  token: TokenLike;
}

interface GroupTableLike {
  name: string;
  schema?: SchemaReferenceLike;
  schemaName?: string | null;
}

interface TableGroupLike {
  name: string;
  tables?: GroupTableLike[];
  note?: NoteLike;
  noteToken?: TokenLike | null;
  color?: string | null;
  metadata?: Record<string, unknown>;
  token: TokenLike;
}

interface SchemaLike {
  name?: string | null;
  tables?: TableLike[];
  enums?: EnumLike[];
  refs?: ReferenceLike[];
  tableGroups?: TableGroupLike[];
}

interface TablePartialLike {
  name: string;
  note?: NoteLike;
  noteToken?: TokenLike | null;
  headerColor?: string | null;
  fields?: FieldLike[];
  indexes?: IndexLike[];
  checks?: CheckLike[];
  token: TokenLike;
}

interface StickyNoteLike {
  name: string;
  content?: string;
  noteToken?: TokenLike | null;
  color?: string | null;
  metadata?: Record<string, unknown>;
  token: TokenLike;
}

interface ViewTableLike {
  name: string;
  schemaName?: string | null;
}

interface ViewNameLike {
  name: string;
}

interface DiagramViewLike {
  name: string;
  schemaName?: string | null;
  visibleEntities?: {
    tables?: ViewTableLike[] | null;
    stickyNotes?: ViewNameLike[] | null;
    tableGroups?: ViewNameLike[] | null;
    schemas?: ViewNameLike[] | null;
  };
  token: TokenLike;
}

interface DatabaseLike {
  token?: TokenLike;
  name?: string | null;
  databaseType?: string | null;
  note?: NoteLike;
  noteToken?: TokenLike | null;
  notes?: StickyNoteLike[];
  schemas?: SchemaLike[];
  tablePartials?: TablePartialLike[];
  diagramViews?: DiagramViewLike[];
}

export interface NormalizeSchemaGraphOptions {
  fallbackFilepath: string;
  forceFilepath: boolean;
  publicFilepathByCompilerPath?: ReadonlyMap<string, string> | undefined;
  sourceByPublicFilepath?: ReadonlyMap<string, string> | undefined;
  sourceText?: SourceTextIndex;
}

export class SchemaGraphNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaGraphNormalizationError";
  }
}

interface OwnerContext {
  kind: "table" | "partial";
  key: SchemaElementKey;
  schemaName: string | null;
  name: string;
  tableKey: SchemaElementKey | null;
  injectionByPartialName: ReadonlyMap<string, SourceRange>;
}

interface CheckDraft extends Omit<CheckNode, "key"> {
  sourceName: string | null;
}

interface IndexDraft extends Omit<IndexNode, "key"> {
  sourceName: string | null;
}

interface ReferenceDraft extends Omit<ReferenceEdge, "key"> {
  sourceName: string | null;
}

export async function normalizeSchemaGraph(
  database: Database,
  options: NormalizeSchemaGraphOptions,
): Promise<SchemaGraph> {
  return new SchemaGraphNormalizer(database as unknown as DatabaseLike, options).normalize();
}

class SchemaGraphNormalizer {
  private readonly sourceMap: Record<SchemaElementKey, SourceRange> = {};
  private readonly partialElementByRange = new Map<string, SchemaElementKey>();
  private readonly partialByName = new Map<string, TablePartialNode>();

  constructor(
    private readonly database: DatabaseLike,
    private readonly options: NormalizeSchemaGraphOptions,
  ) {}

  async normalize(): Promise<SchemaGraph> {
    const project = this.normalizeProject();
    const notes = (this.database.notes ?? []).map((note) => this.normalizeStickyNote(note));
    const partials = (this.database.tablePartials ?? []).map((partial) =>
      this.normalizePartial(partial),
    );
    const tables = (this.database.schemas ?? []).flatMap((schema) =>
      (schema.tables ?? []).map((table) => this.normalizeTable(schema, table)),
    );
    const enums = (this.database.schemas ?? []).flatMap((schema) =>
      (schema.enums ?? []).map((dbEnum) => this.normalizeEnum(schema, dbEnum)),
    );
    const references = this.normalizeReferences();
    const groups = (this.database.schemas ?? []).flatMap((schema) =>
      (schema.tableGroups ?? []).map((group) => this.normalizeGroup(schema, group)),
    );
    const views = (this.database.diagramViews ?? []).map((view) => this.normalizeView(view));

    const semanticModel = {
      project,
      notes,
      tables,
      enums,
      references,
      groups,
      partials,
      views,
    };

    return {
      parserVersion: DBML_PARSER_VERSION,
      schemaHash: await sha256Utf8(JSON.stringify(withoutSourceLocations(semanticModel))),
      project,
      notes,
      tables,
      enums,
      references,
      groups,
      partials,
      views,
      diagnostics: [],
      sourceMap: this.sourceMap,
    };
  }

  private normalizeProject(): ProjectNode | null {
    if (!this.database.token || typeof this.database.name !== "string") return null;

    const key = qualifiedElementKey("project", this.database.name);
    const range = this.range(this.database.token);
    const project: ProjectNode = {
      key,
      name: this.database.name,
      databaseType: nullableString(this.database.databaseType),
      note: this.note(this.database.note, this.database.noteToken, this.database.token),
      range,
    };
    this.register(key, range);
    return project;
  }

  private normalizeStickyNote(note: StickyNoteLike): StickyNoteNode {
    const key = qualifiedElementKey("note", note.name);
    const range = this.range(note.token);
    const sourceContent = this.sourceTextFor(note.token, "sticky");
    const node: StickyNoteNode = {
      key,
      name: note.name,
      content: sourceContent?.value ?? note.content ?? "",
      contentRange: sourceContent?.range ?? this.range(note.noteToken ?? note.token),
      color: nullableString(note.color),
      metadata: metadata(note.metadata),
      range,
    };
    this.register(key, range);
    return node;
  }

  private normalizePartial(partial: TablePartialLike): TablePartialNode {
    const key = qualifiedElementKey("partial", partial.name);
    const range = this.range(partial.token);
    this.register(key, range);

    const owner: OwnerContext = {
      kind: "partial",
      key,
      schemaName: null,
      name: partial.name,
      tableKey: null,
      injectionByPartialName: new Map(),
    };
    const columns = this.normalizeColumns(partial.fields ?? [], owner);
    const indexes = this.normalizeIndexes(partial.indexes ?? [], owner);
    const checks = this.normalizeChecks(partial.checks ?? [], owner, null, null);
    const node: TablePartialNode = {
      key,
      name: partial.name,
      note: this.note(partial.note, partial.noteToken, partial.token),
      color: nullableString(partial.headerColor),
      columns,
      indexes,
      checks,
      range,
    };
    this.partialByName.set(partial.name, node);
    return node;
  }

  private normalizeTable(schema: SchemaLike, table: TableLike): TableNode {
    const schemaName = schemaNameOrDefault(schema.name);
    const key = qualifiedElementKey("table", schemaName, table.name);
    const range = this.range(table.token);
    this.register(key, range);

    const injectionByPartialName = new Map<string, SourceRange>();
    for (const injection of table.partials ?? []) {
      if (injectionByPartialName.has(injection.name)) {
        throw new SchemaGraphNormalizationError(
          `Table ${schemaName}.${table.name} injects partial ${injection.name} more than once.`,
        );
      }
      injectionByPartialName.set(injection.name, this.range(injection.token));
    }

    const owner: OwnerContext = {
      kind: "table",
      key,
      schemaName,
      name: table.name,
      tableKey: key,
      injectionByPartialName,
    };

    return {
      key,
      schemaName,
      name: table.name,
      alias: nullableString(table.alias),
      note: this.note(table.note, table.noteToken, table.token),
      color: nullableString(table.headerColor),
      metadata: metadata(table.metadata),
      columns: this.normalizeColumns(table.fields ?? [], owner),
      indexes: this.normalizeIndexes(table.indexes ?? [], owner),
      checks: this.normalizeChecks(table.checks ?? [], owner, key, null),
      partialKeys: (table.partials ?? []).map((partial) =>
        qualifiedElementKey("partial", partial.name),
      ),
      range,
    };
  }

  private normalizeColumns(fields: FieldLike[], owner: OwnerContext): ColumnNode[] {
    return fields.map((field) => {
      const key =
        owner.kind === "table"
          ? qualifiedElementKey("column", owner.schemaName, owner.name, field.name)
          : qualifiedElementKey("partialColumn", owner.name, field.name);
      const range = this.range(field.token);
      const injectedFrom = this.provenance(field.injectedPartial, field.token, owner, field.name);
      const column: ColumnNode = {
        key,
        name: field.name,
        type: normalizeColumnType(field.type),
        primaryKey: Boolean(field.pk),
        unique: Boolean(field.unique),
        notNull: Boolean(field.not_null),
        default: normalizeDefault(field.dbdefault),
        increment: Boolean(field.increment),
        note: this.note(field.note, field.noteToken, field.token),
        metadata: metadata(field.metadata),
        checks: [],
        injectedFrom,
        range,
      };
      this.register(key, range, owner.kind === "partial");
      column.checks = this.normalizeChecks(
        field.checks ?? [],
        owner,
        owner.tableKey,
        key,
        injectedFrom,
      );
      return column;
    });
  }

  private normalizeIndexes(indexes: IndexLike[], owner: OwnerContext): IndexNode[] {
    const drafts = indexes.map((index): IndexDraft => {
      const injectedFrom = this.provenance(index.injectedPartial, index.token, owner);
      const sourceName = nullableString(index.name);
      const definition = injectedFrom
        ? this.findPartialIndex(injectedFrom.partialKey, injectedFrom.partialElementKey)
        : null;
      return {
        sourceName: definition?.name ?? sourceName,
        name: definition?.name ?? sourceName,
        terms: (index.columns ?? []).map((term) => this.normalizeIndexTerm(term, owner)),
        type: nullableString(index.type),
        unique: Boolean(index.unique),
        primaryKey: Boolean(index.pk),
        note: this.note(index.note, index.noteToken, index.token),
        injectedFrom,
        range: this.range(index.token),
      };
    });
    const keys = allocateConstraintKeys(
      owner.kind === "table" ? "index" : "partialIndex",
      owner,
      drafts.map((draft) => ({
        name: draft.sourceName,
        signature: indexSignature(draft),
      })),
    );

    return drafts.map((draft, index) => {
      const key = requiredKey(keys[index]);
      const { sourceName: _sourceName, ...node } = draft;
      const result: IndexNode = { key, ...node };
      this.register(key, result.range, owner.kind === "partial");
      return result;
    });
  }

  private normalizeIndexTerm(term: IndexTermLike, owner: OwnerContext): IndexTermNode {
    const range = this.range(term.token);
    const value = String(term.value ?? "");
    if (term.type === "column") {
      return {
        kind: "COLUMN",
        columnKey:
          owner.kind === "table"
            ? qualifiedElementKey("column", owner.schemaName, owner.name, value)
            : qualifiedElementKey("partialColumn", owner.name, value),
        range,
      };
    }
    return { kind: "EXPRESSION", expression: value, range };
  }

  private normalizeChecks(
    checks: CheckLike[],
    owner: OwnerContext,
    tableKey: SchemaElementKey | null,
    columnKey: SchemaElementKey | null,
    inheritedProvenance: PartialInjectionProvenance | null = null,
  ): CheckNode[] {
    const drafts = checks.map((check): CheckDraft => {
      const directProvenance = this.provenance(check.injectedPartial, check.token, owner);
      const inheritedDefinitionKey = inheritedProvenance
        ? this.partialElementByRange.get(rangeIdentity(this.range(check.token)))
        : null;
      const injectedFrom =
        directProvenance ??
        (inheritedProvenance && inheritedDefinitionKey
          ? { ...inheritedProvenance, partialElementKey: inheritedDefinitionKey }
          : inheritedProvenance);
      const sourceName = nullableString(check.name);
      const definition = injectedFrom
        ? this.findPartialCheck(injectedFrom.partialKey, injectedFrom.partialElementKey)
        : null;
      return {
        sourceName: definition?.name ?? sourceName,
        name: definition?.name ?? sourceName,
        expression: check.expression ?? "",
        tableKey,
        columnKey,
        injectedFrom,
        range: this.range(check.token),
      };
    });
    const kind = owner.kind === "table" ? "check" : "partialCheck";
    const keys = allocateConstraintKeys(
      kind,
      owner,
      drafts.map((draft) => ({
        name: draft.sourceName,
        signature: checkSignature(draft),
        path: columnKey ? [columnKey] : [],
      })),
    );

    return drafts.map((draft, index) => {
      const key = requiredKey(keys[index]);
      const { sourceName: _sourceName, ...node } = draft;
      const result: CheckNode = { key, ...node };
      this.register(key, result.range, owner.kind === "partial");
      return result;
    });
  }

  private normalizeEnum(schema: SchemaLike, dbEnum: EnumLike): EnumNode {
    const schemaName = schemaNameOrDefault(schema.name);
    const key = qualifiedElementKey("enum", schemaName, dbEnum.name);
    const range = this.range(dbEnum.token);
    this.register(key, range);

    const values = (dbEnum.values ?? []).map((value) => {
      const valueKey = qualifiedElementKey("enumValue", schemaName, dbEnum.name, value.name);
      const valueRange = this.range(value.token);
      this.register(valueKey, valueRange);
      return {
        key: valueKey,
        name: value.name,
        note: this.note(value.note, value.noteToken, value.token),
        range: valueRange,
      };
    });
    return {
      key,
      schemaName,
      name: dbEnum.name,
      note: this.note(dbEnum.note, dbEnum.noteToken, dbEnum.token),
      values,
      range,
    };
  }

  private normalizeReferences(): ReferenceEdge[] {
    const drafts = (this.database.schemas ?? []).flatMap((schema) => {
      const schemaName = schemaNameOrDefault(schema.name);
      return (schema.refs ?? []).map((reference): ReferenceDraft => {
        const endpoints = reference.endpoints ?? [];
        const left = endpoints[0];
        const right = endpoints[1];
        if (!left || !right) {
          throw new SchemaGraphNormalizationError(
            `Reference ${reference.name ?? "<anonymous>"} does not have exactly two endpoints.`,
          );
        }

        return {
          sourceName: nullableString(reference.name),
          schemaName,
          name: nullableString(reference.name),
          endpoints: [this.normalizeEndpoint(left), this.normalizeEndpoint(right)],
          onDelete: nullableString(reference.onDelete),
          onUpdate: nullableString(reference.onUpdate),
          color: nullableString(reference.color),
          inactive: Boolean(reference.inactive),
          injectedFrom: this.referenceProvenance(reference),
          range: this.range(reference.token),
        };
      });
    });

    const baseKeys = drafts.map((draft) =>
      draft.sourceName
        ? qualifiedElementKey("reference", draft.schemaName, draft.sourceName)
        : qualifiedElementKey("reference", draft.schemaName, referenceSignature(draft)),
    );
    const counts = countValues(baseKeys);
    const occurrences = new Map<string, number>();

    return drafts.map((draft, index) => {
      const baseKey = requiredKey(baseKeys[index]);
      const occurrence = occurrences.get(baseKey) ?? 0;
      occurrences.set(baseKey, occurrence + 1);
      const key =
        !draft.sourceName && (counts.get(baseKey) ?? 0) > 1
          ? qualifiedElementKey(
              "reference",
              draft.schemaName,
              referenceSignature(draft),
              occurrence,
            )
          : baseKey;
      const { sourceName: _sourceName, ...node } = draft;
      const result: ReferenceEdge = { key, ...node };
      this.register(key, result.range);
      return result;
    });
  }

  private normalizeEndpoint(endpoint: ReferenceEndpointLike): ReferenceEndpoint {
    const schemaName = schemaNameOrDefault(endpoint.schemaName);
    const tableKey = qualifiedElementKey("table", schemaName, endpoint.tableName);
    const cardinality = parseCardinality(endpoint.relation as RelationCardinality);
    return {
      tableKey,
      columnKeys: (endpoint.fieldNames ?? []).map((fieldName) =>
        qualifiedElementKey("column", schemaName, endpoint.tableName, fieldName),
      ),
      multiplicity: {
        min: cardinality.min,
        max: cardinality.max === "*" ? null : cardinality.max,
      },
      range: this.range(endpoint.token),
    };
  }

  private referenceProvenance(reference: ReferenceLike): PartialInjectionProvenance | null {
    const partialReference = reference.injectedPartial;
    if (!partialReference) return null;

    const partialKey = qualifiedElementKey("partial", partialReference.name);
    const definitionRange = this.range(reference.token);
    const partialElementKey = this.partialElementByRange.get(rangeIdentity(definitionRange));
    if (!partialElementKey) {
      throw new SchemaGraphNormalizationError(
        `Injected reference cannot be linked to partial ${partialReference.name}.`,
      );
    }

    const injectedField = (reference.endpoints ?? [])
      .flatMap((endpoint) => endpoint.fields ?? [])
      .find(
        (field) => field.injectedPartial?.name === partialReference.name && field.injectedToken,
      );
    if (!injectedField?.injectedToken) {
      throw new SchemaGraphNormalizationError(
        `Injected reference is missing the table injection for partial ${partialReference.name}.`,
      );
    }

    return {
      partialKey,
      partialElementKey,
      injectionRange: this.range(injectedField.injectedToken),
    };
  }

  private normalizeGroup(schema: SchemaLike, group: TableGroupLike): TableGroupNode {
    const schemaName = schemaNameOrDefault(schema.name);
    const key = qualifiedElementKey("group", schemaName, group.name);
    const range = this.range(group.token);
    const node: TableGroupNode = {
      key,
      schemaName,
      name: group.name,
      tableKeys: (group.tables ?? []).map((table) =>
        qualifiedElementKey(
          "table",
          schemaNameOrDefault(table.schema?.name ?? table.schemaName),
          table.name,
        ),
      ),
      note: this.note(group.note, group.noteToken, group.token),
      color: nullableString(group.color),
      metadata: metadata(group.metadata),
      range,
    };
    this.register(key, range);
    return node;
  }

  private normalizeView(view: DiagramViewLike): DiagramViewNode {
    const schemaName = view.schemaName ?? null;
    const key = qualifiedElementKey("view", schemaName, view.name);
    const range = this.range(view.token);
    const visible = view.visibleEntities;
    const node: DiagramViewNode = {
      key,
      schemaName,
      name: view.name,
      visibleTableKeys: mapTriState(visible?.tables, (table) =>
        qualifiedElementKey("table", schemaNameOrDefault(table.schemaName), table.name),
      ),
      visibleNoteKeys: mapTriState(visible?.stickyNotes, (note) =>
        qualifiedElementKey("note", note.name),
      ),
      visibleGroupKeys: mapTriState(visible?.tableGroups, (group) =>
        qualifiedElementKey("group", schemaName ?? DEFAULT_SCHEMA, group.name),
      ),
      visibleSchemaNames: mapTriState(visible?.schemas, (item) => item.name),
      range,
    };
    this.register(key, range);
    return node;
  }

  private provenance(
    partialReference: PartialReferenceLike | null | undefined,
    definitionToken: TokenLike,
    owner: OwnerContext,
    partialColumnName?: string,
  ): PartialInjectionProvenance | null {
    if (owner.kind !== "table" || !partialReference) return null;
    const partialKey = qualifiedElementKey("partial", partialReference.name);
    const injectionRange = owner.injectionByPartialName.get(partialReference.name);
    if (!injectionRange) {
      throw new SchemaGraphNormalizationError(
        `Injected element refers to missing partial injection ${partialReference.name} in ${owner.key}.`,
      );
    }

    const definitionRange = this.range(definitionToken);
    const partialElementKey = this.partialElementByRange.get(rangeIdentity(definitionRange));
    if (!partialElementKey) {
      throw new SchemaGraphNormalizationError(
        `Injected element cannot be linked to partial ${partialReference.name}.`,
      );
    }
    if (
      partialColumnName &&
      partialElementKey !==
        qualifiedElementKey("partialColumn", partialReference.name, partialColumnName)
    ) {
      throw new SchemaGraphNormalizationError(
        `Injected column ${partialColumnName} cannot be linked to partial ${partialReference.name}.`,
      );
    }
    return { partialKey, partialElementKey, injectionRange };
  }

  private findPartialIndex(
    partialKey: SchemaElementKey,
    elementKey: SchemaElementKey,
  ): IndexNode | null {
    const partial = [...this.partialByName.values()].find((item) => item.key === partialKey);
    return partial?.indexes.find((index) => index.key === elementKey) ?? null;
  }

  private findPartialCheck(
    partialKey: SchemaElementKey,
    elementKey: SchemaElementKey,
  ): CheckNode | null {
    const partial = [...this.partialByName.values()].find((item) => item.key === partialKey);
    if (!partial) return null;
    return (
      partial.checks.find((check) => check.key === elementKey) ??
      partial.columns
        .flatMap((column) => column.checks)
        .find((check) => check.key === elementKey) ??
      null
    );
  }

  private note(
    value: NoteLike,
    noteToken: TokenLike | null | undefined,
    fallbackToken: TokenLike,
  ): TextNote | null {
    const sourceNote = this.sourceTextFor(fallbackToken, "note");
    if (sourceNote) return sourceNote;
    if (isNoteObject(value)) {
      return { value: value.value, range: this.range(value.token) };
    }
    if (typeof value !== "string") return null;
    return { value, range: this.range(noteToken ?? fallbackToken) };
  }

  private sourceTextFor(token: TokenLike, kind: "note" | "sticky"): TextNote | null {
    const ownerRange = this.range(token);
    const map =
      kind === "note"
        ? this.options.sourceText?.noteByOwner
        : this.options.sourceText?.stickyContentByOwner;
    return (
      map?.get(sourceOwnerKey(ownerRange.filepath, ownerRange.startOffset, ownerRange.endOffset)) ??
      null
    );
  }

  private range(token: TokenLike): SourceRange {
    const filepath = this.options.forceFilepath
      ? this.options.fallbackFilepath
      : resolvePublicFilepath(tokenFilepath(token), {
          fallbackPublicFilepath: this.options.fallbackFilepath,
          publicFilepathByCompilerPath: this.options.publicFilepathByCompilerPath,
          sourceByPublicFilepath: this.options.sourceByPublicFilepath,
        });
    if (filepath === null) {
      throw new SchemaGraphNormalizationError(
        `No public filepath mapping exists for compiler token: ${tokenFilepath(token) ?? "<missing>"}`,
      );
    }
    const range: SourceRange = {
      startOffset: token.start.offset,
      endOffset: token.end.offset,
      startLine: token.start.line,
      startColumn: token.start.column,
      endLine: token.end.line,
      endColumn: token.end.column,
      filepath,
    };
    validateRange(range, this.options.sourceByPublicFilepath);
    return range;
  }

  private register(key: SchemaElementKey, range: SourceRange, partialElement = false): void {
    if (Object.hasOwn(this.sourceMap, key)) {
      throw new SchemaGraphNormalizationError(`Duplicate SchemaElementKey: ${key}`);
    }
    this.sourceMap[key] = range;
    if (partialElement) {
      const identity = rangeIdentity(range);
      if (this.partialElementByRange.has(identity)) {
        throw new SchemaGraphNormalizationError(
          `Two partial elements share the same source range: ${identity}`,
        );
      }
      this.partialElementByRange.set(identity, key);
    }
  }
}

function allocateConstraintKeys(
  kind: Extract<SchemaElementKind, "index" | "partialIndex" | "check" | "partialCheck">,
  owner: OwnerContext,
  candidates: Array<{
    name: string | null;
    signature: SchemaKeySegment;
    path?: SchemaKeySegment[];
  }>,
): SchemaElementKey[] {
  const context: SchemaKeySegment[] =
    owner.kind === "table" ? [owner.schemaName, owner.name] : [owner.name];
  const bases = candidates.map((candidate) =>
    candidate.name
      ? qualifiedElementKey(kind, ...context, ...(candidate.path ?? []), candidate.name)
      : qualifiedElementKey(kind, ...context, ...(candidate.path ?? []), candidate.signature),
  );
  const counts = countValues(bases);
  const occurrences = new Map<string, number>();
  return candidates.map((candidate, index) => {
    const base = requiredKey(bases[index]);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    if (candidate.name || (counts.get(base) ?? 0) === 1) return base;
    return qualifiedElementKey(
      kind,
      ...context,
      ...(candidate.path ?? []),
      candidate.signature,
      occurrence,
    );
  });
}

function indexSignature(index: IndexDraft): SchemaKeySegment {
  return {
    terms: index.terms.map((term) =>
      term.kind === "COLUMN"
        ? { kind: term.kind, columnKey: term.columnKey }
        : { kind: term.kind, expression: term.expression },
    ),
    type: index.type,
    unique: index.unique,
    primaryKey: index.primaryKey,
  };
}

function checkSignature(check: CheckDraft): SchemaKeySegment {
  return {
    expression: check.expression,
    tableKey: check.tableKey,
    columnKey: check.columnKey,
  };
}

function referenceSignature(reference: ReferenceDraft): SchemaKeySegment {
  return {
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
    inactive: reference.inactive,
  };
}

function normalizeColumnType(type: ColumnTypeLike | null | undefined): ColumnTypeNode {
  const schemaName = nullableString(type?.schemaName);
  const rawName = type?.type_name?.trim() || "unknown";
  const args = nullableString(type?.args);
  const suffix = args ? `(${args})` : "";
  const nameWithNoArguments =
    suffix && rawName.endsWith(suffix) ? rawName.slice(0, -suffix.length) : rawName;
  const schemaPrefix = schemaName ? `${schemaName}.` : "";
  const name =
    schemaPrefix && nameWithNoArguments.startsWith(schemaPrefix)
      ? nameWithNoArguments.slice(schemaPrefix.length)
      : nameWithNoArguments;
  const qualifiedName = schemaName ? `${schemaName}.${name}` : name;
  return {
    schemaName,
    name,
    arguments: args,
    display: `${qualifiedName}${suffix}`,
  };
}

function normalizeDefault(value: DefaultLike | null | undefined): ColumnDefaultNode | null {
  if (!value || typeof value.type !== "string") return null;
  if (value.type === "number" && typeof value.value === "number") {
    return { type: "number", value: value.value };
  }
  if (value.type === "string") return { type: "string", value: String(value.value ?? "") };
  if (value.type === "expression") {
    return { type: "expression", value: String(value.value ?? "") };
  }
  if (value.type === "boolean") {
    if (value.value === null || value.value === "null") return { type: "null", value: null };
    if (value.value === true || value.value === "true") return { type: "boolean", value: true };
    if (value.value === false || value.value === "false") {
      return { type: "boolean", value: false };
    }
  }
  throw new SchemaGraphNormalizationError(
    `Unsupported DBML default value: ${JSON.stringify(value)}`,
  );
}

function metadata(value: Record<string, unknown> | null | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function schemaNameOrDefault(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : DEFAULT_SCHEMA;
}

function isNoteObject(value: NoteLike): value is NoteObjectLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.value === "string" &&
    typeof value.token === "object" &&
    value.token !== null
  );
}

function mapTriState<T, R>(values: T[] | null | undefined, mapper: (value: T) => R): R[] | null {
  if (values == null) return null;
  return values.map(mapper);
}

function tokenFilepath(token: TokenLike): string | null {
  if (typeof token.filepath === "string") return token.filepath;
  if (typeof token.filepath?.absolute === "string") return token.filepath.absolute;
  if (typeof token.filepath?.path === "string") return token.filepath.path;
  return null;
}

function validateRange(
  range: SourceRange,
  sourceByPublicFilepath?: ReadonlyMap<string, string>,
): void {
  if (
    !isSourceRangeValid(range, sourceByPublicFilepath) ||
    range.endOffset <= range.startOffset ||
    (range.endLine === range.startLine && range.endColumn <= range.startColumn)
  ) {
    throw new SchemaGraphNormalizationError(`Invalid source range: ${JSON.stringify(range)}`);
  }
}

function rangeIdentity(range: SourceRange): string {
  return JSON.stringify([range.filepath, range.startOffset, range.endOffset]);
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function requiredKey(value: SchemaElementKey | undefined): SchemaElementKey {
  if (value === undefined) {
    throw new SchemaGraphNormalizationError("Failed to allocate a SchemaElementKey.");
  }
  return value;
}

function withoutSourceLocations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSourceLocations);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !(SOURCE_LOCATION_KEYS.has(key) && isSourceRange(child)))
      .map(([key, child]) => [key, withoutSourceLocations(child)]),
  );
}

function isSourceRange(value: unknown): value is SourceRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<SourceRange>;
  return (
    typeof candidate.startOffset === "number" &&
    typeof candidate.endOffset === "number" &&
    typeof candidate.startLine === "number" &&
    typeof candidate.startColumn === "number" &&
    typeof candidate.endLine === "number" &&
    typeof candidate.endColumn === "number" &&
    typeof candidate.filepath === "string"
  );
}
