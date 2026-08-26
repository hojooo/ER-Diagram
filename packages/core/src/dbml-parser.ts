import { Parser, type Database, type TablePartial, type Token } from "@dbml/core";
import type { Diagnostic } from "@er-diagram/contracts";
import { sha256Utf8 } from "./hash.js";
import {
  DBML_PARSER_VERSION,
  type DiagramViewNode,
  type EnumNode,
  type ReferenceEdge,
  type SchemaGraph,
  type SourceRange,
  type TableGroupNode,
  type TableNode,
  type TablePartialNode,
  qualifiedElementKey,
} from "./schema-graph.js";

export const DBML_PARSE_MODE = "dbmlv2" as const;
const DEFAULT_SCHEMA = "public";
const DEFAULT_FILEPATH = "/main.dbml";

export interface DbmlParseSuccess {
  ok: true;
  sourceHash: string;
  parserInputHash: string;
  graph: SchemaGraph;
}

export interface DbmlParseFailure {
  ok: false;
  sourceHash: string;
  parserInputHash: string;
  diagnostics: Diagnostic[];
}

export type DbmlParseResult = DbmlParseSuccess | DbmlParseFailure;

export interface DbmlProjectParseSuccess {
  ok: true;
  sourceHashes: Record<string, string>;
  parserInputHashes: Record<string, string>;
  graph: SchemaGraph;
}

export interface DbmlProjectParseFailure {
  ok: false;
  sourceHashes: Record<string, string>;
  parserInputHashes: Record<string, string>;
  diagnostics: Diagnostic[];
}

export type DbmlProjectParseResult = DbmlProjectParseSuccess | DbmlProjectParseFailure;

interface CompilerDiagnosticLike {
  code?: string | number;
  message?: string;
  location?: {
    start?: { line?: number; column?: number };
    end?: { line?: number; column?: number };
  };
}

interface CompilerFailureLike {
  diags?: CompilerDiagnosticLike[];
  message?: string;
}

type DatabaseWithV2Elements = Database & { tablePartials: TablePartial[] };

export async function parseDbmlV2(
  source: string,
  filepath = DEFAULT_FILEPATH,
): Promise<DbmlParseResult> {
  const sourceHash = await sha256Utf8(source);
  const parserInput = source;
  const parserInputHash = await sha256Utf8(parserInput);

  try {
    const database = Parser.parse(parserInput, DBML_PARSE_MODE);
    return {
      ok: true,
      sourceHash,
      parserInputHash,
      graph: await buildSchemaGraph(database, filepath),
    };
  } catch (error) {
    return {
      ok: false,
      sourceHash,
      parserInputHash,
      diagnostics: normalizeDiagnostics(error, source),
    };
  }
}

export async function parseDbmlProjectV2(input: {
  entrypoint: string;
  files: Record<string, string>;
}): Promise<DbmlProjectParseResult> {
  const sourceHashes = await hashSources(input.files);
  const parser = new Parser();
  const parserInputHashes: Record<string, string> = {};

  for (const [filepath, source] of Object.entries(input.files)) {
    const parserInput = source;
    parser.setDbmlSource(filepath, parserInput);
    parserInputHashes[filepath] = await sha256Utf8(parserInput);
  }

  if (!(input.entrypoint in input.files)) {
    return {
      ok: false,
      sourceHashes,
      parserInputHashes,
      diagnostics: [
        {
          code: "DBML_ENTRYPOINT_NOT_FOUND",
          message: `DBML entrypoint was not provided: ${input.entrypoint}`,
          severity: "ERROR",
        },
      ],
    };
  }

  try {
    const database = parser.parseDbmlProject(input.entrypoint);
    return {
      ok: true,
      sourceHashes,
      parserInputHashes,
      graph: await buildSchemaGraph(database, input.entrypoint),
    };
  } catch (error) {
    return {
      ok: false,
      sourceHashes,
      parserInputHashes,
      diagnostics: normalizeDiagnostics(error, input.files[input.entrypoint] ?? ""),
    };
  }
}

async function hashSources(files: Record<string, string>): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const [filepath, source] of Object.entries(files)) {
    hashes[filepath] = await sha256Utf8(source);
  }
  return hashes;
}

async function buildSchemaGraph(
  database: Database,
  fallbackFilepath: string,
): Promise<SchemaGraph> {
  const sourceMap: Record<string, SourceRange> = {};
  const tables: TableNode[] = database.schemas.flatMap((schema) =>
    schema.tables.map((table) => {
      const schemaName = schema.name || DEFAULT_SCHEMA;
      const key = qualifiedElementKey("table", schemaName, table.name);
      const range = toSourceRange(table.token, fallbackFilepath);
      sourceMap[key] = range;

      const columns = table.fields.map((field) => {
        const fieldKey = qualifiedElementKey("column", schemaName, table.name, field.name);
        const fieldRange = toSourceRange(field.token, fallbackFilepath);
        sourceMap[fieldKey] = fieldRange;
        const typeSchema = field.type?.schemaName ? `${field.type.schemaName}.` : "";
        const typeArgs = field.type?.args ?? "";

        return {
          key: fieldKey,
          name: field.name,
          type: `${typeSchema}${field.type?.type_name ?? "unknown"}${typeArgs}`,
          primaryKey: Boolean(field.pk),
          unique: Boolean(field.unique),
          notNull: Boolean(field.not_null),
          ...(field.injectedPartial ? { injectedFromPartial: field.injectedPartial.name } : {}),
          range: fieldRange,
        };
      });

      return {
        key,
        schemaName,
        name: table.name,
        columns,
        partialNames: table.partials.map((partial) => partial.name),
        metadata: { ...table.metadata },
        range,
      };
    }),
  );

  const enums: EnumNode[] = database.schemas.flatMap((schema) =>
    schema.enums.map((dbEnum) => {
      const schemaName = schema.name || DEFAULT_SCHEMA;
      const key = qualifiedElementKey("enum", schemaName, dbEnum.name);
      const range = toSourceRange(dbEnum.token, fallbackFilepath);
      sourceMap[key] = range;
      return {
        key,
        schemaName,
        name: dbEnum.name,
        values: dbEnum.values.map((value) => value.name),
        range,
      };
    }),
  );

  const references: ReferenceEdge[] = database.schemas.flatMap((schema) =>
    schema.refs.map((reference, index) => {
      const schemaName = schema.name || DEFAULT_SCHEMA;
      const key = qualifiedElementKey(
        "reference",
        schemaName,
        reference.name ?? `anonymous-${index}`,
        String(reference.id),
      );
      const range = toSourceRange(reference.token, fallbackFilepath);
      sourceMap[key] = range;
      const [left, right] = reference.endpoints;
      if (!left || !right) {
        throw new Error(`Reference ${reference.name ?? reference.id} does not have two endpoints.`);
      }

      return {
        key,
        name: reference.name ?? null,
        endpoints: [left, right].map((endpoint) => ({
          tableKey: qualifiedElementKey(
            "table",
            endpoint.schemaName ?? DEFAULT_SCHEMA,
            endpoint.tableName,
          ),
          fieldNames: [...endpoint.fieldNames],
          relation: String(endpoint.relation),
        })) as ReferenceEdge["endpoints"],
        ...(reference.onDelete ? { onDelete: String(reference.onDelete) } : {}),
        ...(reference.onUpdate ? { onUpdate: String(reference.onUpdate) } : {}),
        range,
      };
    }),
  );

  const groups: TableGroupNode[] = database.schemas.flatMap((schema) =>
    schema.tableGroups.map((group) => {
      const schemaName = schema.name || DEFAULT_SCHEMA;
      const key = qualifiedElementKey("group", schemaName, group.name);
      const range = toSourceRange(group.token, fallbackFilepath);
      sourceMap[key] = range;
      return {
        key,
        schemaName,
        name: group.name,
        tableKeys: group.tables.map((table) =>
          qualifiedElementKey("table", table.schema.name || DEFAULT_SCHEMA, table.name),
        ),
        metadata: { ...group.metadata },
        range,
      };
    }),
  );

  const partials: TablePartialNode[] = (database as DatabaseWithV2Elements).tablePartials.map(
    (partial) => {
      const key = qualifiedElementKey("partial", partial.name);
      const range = toSourceRange(partial.token, fallbackFilepath);
      sourceMap[key] = range;
      return {
        key,
        name: partial.name,
        fieldNames: partial.fields.map((field) => field.name),
        range,
      };
    },
  );

  const views: DiagramViewNode[] = database.diagramViews.map((view) => {
    const key = qualifiedElementKey("view", view.schemaName, view.name);
    const range = toSourceRange(view.token, fallbackFilepath);
    sourceMap[key] = range;
    return {
      key,
      schemaName: view.schemaName,
      name: view.name,
      visibleTableKeys: view.visibleEntities.tables
        ? view.visibleEntities.tables.map((table) =>
            qualifiedElementKey("table", table.schemaName || DEFAULT_SCHEMA, table.name),
          )
        : null,
      visibleGroupKeys: view.visibleEntities.tableGroups
        ? view.visibleEntities.tableGroups.map((group) =>
            qualifiedElementKey("group", view.schemaName ?? DEFAULT_SCHEMA, group.name),
          )
        : null,
      visibleSchemaNames: view.visibleEntities.schemas
        ? view.visibleEntities.schemas.map((schema) => schema.name)
        : null,
      range,
    };
  });

  const semanticModel = {
    tables: tables.map(({ range: _range, ...table }) => table),
    enums: enums.map(({ range: _range, ...dbEnum }) => dbEnum),
    references: references.map(({ range: _range, ...reference }) => reference),
    groups: groups.map(({ range: _range, ...group }) => group),
    partials: partials.map(({ range: _range, ...partial }) => partial),
    views: views.map(({ range: _range, ...view }) => view),
  };

  return {
    parserVersion: DBML_PARSER_VERSION,
    schemaHash: await sha256Utf8(JSON.stringify(semanticModel)),
    tables,
    enums,
    references,
    groups,
    partials,
    views,
    diagnostics: [],
    sourceMap,
  };
}

function toSourceRange(token: Token, fallbackFilepath: string): SourceRange {
  return {
    startOffset: token.start.offset,
    endOffset: token.end.offset,
    startLine: token.start.line,
    startColumn: token.start.column,
    endLine: token.end.line,
    endColumn: token.end.column,
    filepath: token.filepath?.absolute ?? fallbackFilepath,
  };
}

function normalizeDiagnostics(error: unknown, source: string): Diagnostic[] {
  const failure = error as CompilerFailureLike;
  if (!Array.isArray(failure?.diags) || failure.diags.length === 0) {
    return [
      {
        code: "DBML_PARSE_ERROR",
        message: failure?.message || "DBML parsing failed.",
        severity: "ERROR",
      },
    ];
  }

  return failure.diags.map((diagnostic) => {
    const startLine = diagnostic.location?.start?.line ?? 1;
    const startColumn = diagnostic.location?.start?.column ?? 1;
    const endLine = diagnostic.location?.end?.line ?? startLine;
    const endColumn = diagnostic.location?.end?.column ?? startColumn;
    return {
      code: `DBML_${diagnostic.code ?? "PARSE_ERROR"}`,
      message: diagnostic.message ?? "DBML parsing failed.",
      severity: "ERROR" as const,
      range: {
        startOffset: offsetAt(source, startLine, startColumn),
        endOffset: offsetAt(source, endLine, endColumn),
        startLine,
        startColumn,
        endLine,
        endColumn,
      },
    };
  });
}

function offsetAt(source: string, line: number, column: number): number {
  if (line <= 1) return Math.min(source.length, Math.max(0, column - 1));
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line && offset < source.length) {
    const newline = source.indexOf("\n", offset);
    if (newline === -1) return source.length;
    offset = newline + 1;
    currentLine += 1;
  }
  return Math.min(source.length, offset + Math.max(0, column - 1));
}
