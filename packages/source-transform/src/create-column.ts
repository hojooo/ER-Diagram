import {
  type ColumnNode,
  diffSchemaGraphs,
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
  const expectedColumnKey = qualifiedElementKey(
    "column",
    beforeTarget.schemaName,
    beforeTarget.name,
    command.column.name,
  );
  const semanticDiff = diffSchemaGraphs(before, after);
  if (
    semanticDiff.renameCandidates.length !== 0 ||
    semanticDiff.changes.length !== 2 ||
    !semanticDiff.changes.some(
      (change) =>
        change.operation === "ADD" &&
        change.elementKind === "column" &&
        change.key === expectedColumnKey &&
        change.parentKey === command.targetTableKey,
    ) ||
    !semanticDiff.changes.some(
      (change) =>
        change.operation === "UPDATE" &&
        change.elementKind === "table" &&
        change.key === command.targetTableKey &&
        change.parentKey === null &&
        change.changedFields.length === 1 &&
        change.changedFields[0] === "columnOrder",
    )
  ) {
    return semanticMismatch();
  }

  if (afterTarget.columns.length !== beforeTarget.columns.length + 1) {
    return semanticMismatch();
  }

  const existingAfterColumns = afterTarget.columns.slice(0, beforeTarget.columns.length);
  if (
    beforeTarget.columns.some((column, index) => existingAfterColumns[index]?.key !== column.key)
  ) {
    return semanticMismatch();
  }

  const addedColumn = afterTarget.columns.at(-1);
  if (!addedColumn) return semanticMismatch();

  const expectedType = parseCommandColumnType(command.column.type);
  if (
    !expectedType ||
    !sameColumnType(addedColumn.type, expectedType) ||
    addedColumn.key !== expectedColumnKey ||
    addedColumn.name !== command.column.name ||
    addedColumn.primaryKey ||
    addedColumn.unique ||
    addedColumn.notNull ||
    addedColumn.default !== null ||
    addedColumn.increment ||
    addedColumn.note !== null ||
    Object.keys(addedColumn.metadata).length !== 0 ||
    addedColumn.checks.length !== 0 ||
    addedColumn.injectedFrom !== null
  ) {
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
        column.injectedFrom === null &&
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

function renderColumnType(type: ColumnNode["type"]): string {
  const qualifiedName = type.schemaName ? `${type.schemaName}.${type.name}` : type.name;
  return type.arguments === null ? qualifiedName : `${qualifiedName}(${type.arguments})`;
}

function parseCommandColumnType(value: string): ColumnNode["type"] | null {
  const fragment = value.trim();
  const argumentStart = trailingArgumentStart(fragment);
  const nameFragment = argumentStart === null ? fragment : fragment.slice(0, argumentStart).trim();
  const segments = splitQualifiedTypeName(nameFragment);
  if (!segments || segments.length < 1 || segments.length > 2) return null;

  const decoded = segments.map(decodeTypeIdentifier);
  if (decoded.some((segment) => segment === null)) return null;
  const names = decoded as string[];
  const schemaName = names.length === 2 ? names[0] : null;
  const name = names.at(-1);
  if (!name) return null;
  const argumentsValue =
    argumentStart === null ? null : normalizeTypeArguments(fragment.slice(argumentStart + 1, -1));
  if (argumentsValue === undefined) return null;

  const type = {
    schemaName: schemaName ?? null,
    name,
    arguments: argumentsValue,
    display: "",
  } satisfies ColumnNode["type"];
  return { ...type, display: renderColumnType(type) };
}

function trailingArgumentStart(value: string): number | null {
  if (!value.endsWith(")")) return null;
  let quoted = false;
  let escaped = false;
  let depth = 0;
  let start: number | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "(") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth < 0 || (depth === 0 && index !== value.length - 1)) return null;
    }
  }

  return !quoted && depth === 0 ? start : null;
}

function splitQualifiedTypeName(value: string): string[] | null {
  const segments: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character !== ".") continue;
    segments.push(value.slice(start, index).trim());
    start = index + 1;
  }
  if (quoted || escaped) return null;
  segments.push(value.slice(start).trim());
  return segments;
}

function decodeTypeIdentifier(value: string): string | null {
  if (value.length === 0) return null;
  if (!value.startsWith('"')) {
    return /["\s]/u.test(value) ? null : value;
  }
  if (!value.endsWith('"')) return null;
  try {
    const decoded = JSON.parse(value) as unknown;
    return typeof decoded === "string" && decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function normalizeTypeArguments(value: string): string | undefined {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      let end = index + 1;
      let escaped = false;
      for (; end < value.length; end += 1) {
        const candidate = value[end];
        if (escaped) escaped = false;
        else if (candidate === "\\") escaped = true;
        else if (candidate === '"') break;
      }
      if (end >= value.length) return undefined;
      const decoded = decodeTypeIdentifier(value.slice(index, end + 1));
      if (decoded === null) return undefined;
      result += decoded;
      index = end;
      continue;
    }
    if (!/\s/u.test(character ?? "")) result += character;
  }
  return result;
}

function sameColumnType(left: ColumnNode["type"], right: ColumnNode["type"]): boolean {
  return (
    left.schemaName === right.schemaName &&
    left.name === right.name &&
    left.arguments === right.arguments &&
    left.display === right.display
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
