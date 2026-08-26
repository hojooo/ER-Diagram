import {
  type ColumnNode,
  parseDbmlV2,
  qualifiedElementKey,
  type SchemaGraph,
  type TableNode,
} from "@er-diagram/core";
import { applyTextEdits } from "./text-edits.js";
import type { SourceTransformDiagnostic, TextEdit } from "./types.js";

export interface CreateColumnCommand {
  kind: "CREATE_COLUMN";
  expectedSchemaHash: string;
  targetTableKey: string;
  column: {
    /** Semantic identifier without DBML quote delimiters. */
    name: string;
    /** DBML type fragment, for example `bigint`, `varchar(255)`, or a custom type. */
    type: string;
  };
}

export interface CreateColumnSuccess {
  ok: true;
  source: string;
  edits: TextEdit[];
  beforeSchemaHash: string;
  afterSchemaHash: string;
}

export interface CreateColumnFailure {
  ok: false;
  /** The unchanged canonical source. */
  source: string;
  diagnostics: SourceTransformDiagnostic[];
}

export type CreateColumnResult = CreateColumnSuccess | CreateColumnFailure;

export interface SemanticDiffSuccess {
  ok: true;
}

export interface SemanticDiffFailure {
  ok: false;
  diagnostics: SourceTransformDiagnostic[];
}

export type SemanticDiffResult = SemanticDiffSuccess | SemanticDiffFailure;

export async function createColumnInDbmlSource(
  source: string,
  command: CreateColumnCommand,
): Promise<CreateColumnResult> {
  const commandDiagnostic = validateCommand(command);
  if (commandDiagnostic) return failure(source, commandDiagnostic);

  const before = await parseDbmlV2(source);
  if (!before.ok) {
    return {
      ok: false,
      source,
      diagnostics: [
        error(
          "CREATE_COLUMN_SOURCE_INVALID",
          "CreateColumn requires a valid canonical DBML source.",
        ),
        ...copyParserDiagnostics(before.diagnostics),
      ],
    };
  }

  if (before.graph.schemaHash !== command.expectedSchemaHash) {
    return failure(
      source,
      error(
        "SOURCE_SCHEMA_STALE",
        `Expected schema hash ${command.expectedSchemaHash}, but current source has ${before.graph.schemaHash}.`,
      ),
    );
  }

  const target = before.graph.tables.find((table) => table.key === command.targetTableKey);
  if (!target) {
    return failure(
      source,
      error(
        "CREATE_COLUMN_TARGET_NOT_FOUND",
        `CreateColumn target table was not found: ${command.targetTableKey}`,
      ),
    );
  }

  if (target.columns.some((column) => column.name === command.column.name)) {
    return failure(
      source,
      error(
        "CREATE_COLUMN_ALREADY_EXISTS",
        `Column already exists in ${command.targetTableKey}: ${command.column.name}`,
      ),
    );
  }

  const editResult = buildCreateColumnEdit(source, target, command);
  if (!editResult.ok) return failure(source, editResult.diagnostic);

  const edits = [editResult.edit];
  const applied = applyTextEdits(source, edits);
  if (!applied.ok) return { ok: false, source, diagnostics: applied.diagnostics };

  const after = await parseDbmlV2(applied.source);
  if (!after.ok) {
    return {
      ok: false,
      source,
      diagnostics: [
        error(
          "CREATE_COLUMN_REPARSE_FAILED",
          "The generated CreateColumn edit did not produce valid DBML v2.",
        ),
        ...copyParserDiagnostics(after.diagnostics),
      ],
    };
  }

  const semanticVerification = verifyCreateColumnSemanticDiff(before.graph, after.graph, command);
  if (!semanticVerification.ok) {
    return { ok: false, source, diagnostics: semanticVerification.diagnostics };
  }

  return {
    ok: true,
    source: applied.source,
    edits,
    beforeSchemaHash: before.graph.schemaHash,
    afterSchemaHash: after.graph.schemaHash,
  };
}

export function verifyCreateColumnSemanticDiff(
  before: SchemaGraph,
  after: SchemaGraph,
  command: CreateColumnCommand,
): SemanticDiffResult {
  const beforeTarget = before.tables.find((table) => table.key === command.targetTableKey);
  const afterTarget = after.tables.find((table) => table.key === command.targetTableKey);

  if (!beforeTarget || !afterTarget) return semanticMismatch();
  if (
    !sameValue(
      before.tables.map((table) => table.key),
      after.tables.map((table) => table.key),
    )
  ) {
    return semanticMismatch();
  }

  for (const beforeTable of before.tables) {
    const afterTable = after.tables.find((table) => table.key === beforeTable.key);
    if (!afterTable) return semanticMismatch();

    if (beforeTable.key !== command.targetTableKey) {
      if (!sameValue(tableSemantics(beforeTable), tableSemantics(afterTable))) {
        return semanticMismatch();
      }
      continue;
    }

    if (!sameValue(tableIdentitySemantics(beforeTable), tableIdentitySemantics(afterTable))) {
      return semanticMismatch();
    }
  }

  if (!sameValue(nonTableSemantics(before), nonTableSemantics(after))) {
    return semanticMismatch();
  }

  if (afterTarget.columns.length !== beforeTarget.columns.length + 1) {
    return semanticMismatch();
  }

  const existingAfterColumns = afterTarget.columns.slice(0, beforeTarget.columns.length);
  if (
    !sameValue(beforeTarget.columns.map(columnSemantics), existingAfterColumns.map(columnSemantics))
  ) {
    return semanticMismatch();
  }

  const addedColumn = afterTarget.columns.at(-1);
  const expectedColumn = {
    key: qualifiedElementKey(
      "column",
      beforeTarget.schemaName,
      beforeTarget.name,
      command.column.name,
    ),
    name: command.column.name,
    type: command.column.type.trim(),
    primaryKey: false,
    unique: false,
    notNull: false,
    injectedFromPartial: null,
  };
  if (!addedColumn || !sameValue(columnSemantics(addedColumn), expectedColumn)) {
    return semanticMismatch();
  }

  return { ok: true };
}

interface EditBuildSuccess {
  ok: true;
  edit: TextEdit;
}

interface EditBuildFailure {
  ok: false;
  diagnostic: SourceTransformDiagnostic;
}

type EditBuildResult = EditBuildSuccess | EditBuildFailure;

function buildCreateColumnEdit(
  source: string,
  target: TableNode,
  command: CreateColumnCommand,
): EditBuildResult {
  const closingBraceOffset = target.range.endOffset - 1;
  if (
    target.range.startOffset < 0 ||
    closingBraceOffset < target.range.startOffset ||
    target.range.endOffset > source.length ||
    source[closingBraceOffset] !== "}"
  ) {
    return {
      ok: false,
      diagnostic: error(
        "CREATE_COLUMN_TARGET_RANGE_INVALID",
        `The source range for ${target.key} does not end at its closing brace.`,
      ),
    };
  }

  const newline = source.slice(target.range.startOffset, target.range.endOffset).includes("\r\n")
    ? "\r\n"
    : "\n";
  const closingLineStart = lineStartOffset(source, closingBraceOffset);
  const closingPrefix = source.slice(closingLineStart, closingBraceOffset);
  const tableIndent = lineIndentAt(source, target.range.startOffset) ?? "";
  const columnIndent = inferColumnIndent(source, target, closingBraceOffset) ?? `${tableIndent}  `;
  const declaration = `${renderIdentifier(command.column.name)} ${command.column.type.trim()}`;

  if (/^[\t ]*$/.test(closingPrefix)) {
    return {
      ok: true,
      edit: {
        startOffset: closingLineStart,
        endOffset: closingLineStart,
        newText: `${columnIndent}${declaration}${newline}`,
      },
    };
  }

  return {
    ok: true,
    edit: {
      startOffset: closingBraceOffset,
      endOffset: closingBraceOffset,
      newText: `${newline}${columnIndent}${declaration}${newline}${tableIndent}`,
    },
  };
}

function inferColumnIndent(
  source: string,
  target: TableNode,
  closingBraceOffset: number,
): string | null {
  const sourceOwnedColumns = target.columns
    .filter(
      (column) =>
        column.range.startOffset > target.range.startOffset &&
        column.range.startOffset < closingBraceOffset,
    )
    .sort((left, right) => left.range.startOffset - right.range.startOffset);

  for (const column of sourceOwnedColumns) {
    const indent = lineIndentAt(source, column.range.startOffset);
    if (indent !== null) return indent;
  }
  return null;
}

function lineStartOffset(source: string, offset: number): number {
  return source.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

function lineIndentAt(source: string, offset: number): string | null {
  const start = lineStartOffset(source, offset);
  const prefix = source.slice(start, offset);
  return /^[\t ]*$/.test(prefix) ? prefix : null;
}

function renderIdentifier(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function validateCommand(command: CreateColumnCommand): SourceTransformDiagnostic | null {
  const candidate = command as unknown;
  if (!candidate || typeof candidate !== "object") return invalidCommand();

  const value = candidate as Partial<CreateColumnCommand>;
  if (
    value.kind !== "CREATE_COLUMN" ||
    typeof value.expectedSchemaHash !== "string" ||
    value.expectedSchemaHash.length === 0 ||
    typeof value.targetTableKey !== "string" ||
    value.targetTableKey.length === 0 ||
    !value.column ||
    typeof value.column.name !== "string" ||
    value.column.name.trim().length === 0 ||
    /[\0\r\n]/.test(value.column.name) ||
    typeof value.column.type !== "string" ||
    value.column.type.trim().length === 0 ||
    /[\0\r\n{};]/.test(value.column.type) ||
    value.column.type.includes("//") ||
    value.column.type.includes("/*") ||
    value.column.type.includes("*/")
  ) {
    return invalidCommand();
  }
  return null;
}

function invalidCommand(): SourceTransformDiagnostic {
  return error(
    "CREATE_COLUMN_COMMAND_INVALID",
    "CreateColumn requires a kind, expected schema hash, target table key, column name, and single-line type.",
  );
}

function tableSemantics(table: TableNode) {
  return {
    ...tableIdentitySemantics(table),
    columns: table.columns.map(columnSemantics),
  };
}

function tableIdentitySemantics(table: TableNode) {
  return {
    key: table.key,
    schemaName: table.schemaName,
    name: table.name,
    partialNames: table.partialNames,
    metadata: table.metadata,
  };
}

function columnSemantics(column: ColumnNode): unknown {
  return {
    key: column.key,
    name: column.name,
    type: column.type,
    primaryKey: column.primaryKey,
    unique: column.unique,
    notNull: column.notNull,
    injectedFromPartial: column.injectedFromPartial ?? null,
  };
}

function nonTableSemantics(graph: SchemaGraph): unknown {
  return {
    parserVersion: graph.parserVersion,
    enums: graph.enums.map(({ range: _range, ...item }) => item),
    references: graph.references.map(({ range: _range, key: _key, ...item }) => item),
    groups: graph.groups.map(({ range: _range, ...item }) => item),
    partials: graph.partials.map(({ range: _range, ...item }) => item),
    views: graph.views.map(({ range: _range, ...item }) => item),
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function semanticMismatch(): SemanticDiffFailure {
  return {
    ok: false,
    diagnostics: [
      error(
        "CREATE_COLUMN_SEMANTIC_MISMATCH",
        "Reparsed DBML changed schema semantics beyond the requested column addition.",
      ),
    ],
  };
}

function copyParserDiagnostics(
  diagnostics: ReadonlyArray<{
    code: string;
    message: string;
    severity: "ERROR" | "WARNING" | "INFO";
    range?: SourceTransformDiagnostic["range"];
  }>,
): SourceTransformDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    ...(diagnostic.range ? { range: diagnostic.range } : {}),
  }));
}

function error(code: string, message: string): SourceTransformDiagnostic {
  return { code, message, severity: "ERROR" };
}

function failure(source: string, diagnostic: SourceTransformDiagnostic): CreateColumnFailure {
  return { ok: false, source, diagnostics: [diagnostic] };
}
