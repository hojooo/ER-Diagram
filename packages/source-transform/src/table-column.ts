import { renameTable } from "@dbml/core";
import type { VisualColumnDefault, VisualCommand } from "@er-diagram/contracts";
import {
  type ColumnDefaultNode,
  type ColumnNode,
  qualifiedElementKey,
  type ReferenceEdge,
  type SchemaElementChange,
  type SchemaElementKey,
  type SchemaGraph,
  type SchemaGraphDiff,
  type SourceRange,
  type TableNode,
} from "@er-diagram/core";
import {
  containsOpaqueIdentifierPath,
  containsOpaqueIdentifierQualifier,
  deriveLinePreservingTextEdits,
  deriveMinimalTextEdits,
  detectNewline,
  type ExistingSettingMutation,
  identifierTokens,
  isQuotedIdentifier,
  lineEndOffset,
  lineIndentAt,
  lineSpanForRange,
  lineStartOffset,
  type OffsetSpan,
  parseColumnDeclaration,
  parseColumnTypeFragment,
  parseTableHeader,
  renderDbmlString,
  renderDbmlStringWithStyle,
  renderIdentifier,
  replaceSettingValue,
  rewriteSettings,
  type SettingMutation,
  sameColumnType,
  settingValueSource,
} from "./dbml-fragment.js";
import { applyTextEdits } from "./text-edits.js";
import type {
  SourceTransformDiagnostic,
  TextEdit,
  VisualSourceTransformFailure,
  VisualSourceTransformResult,
  VisualSourceTransformSuccess,
} from "./types.js";
import {
  type EditPlan,
  invalidRange,
  planFailure,
  runVerifiedVisualTransform,
  unsafeTransform,
  withoutFilepath,
} from "./verified-transform.js";

const TABLE_COLUMN_COMMAND_KINDS = new Set<VisualCommand["kind"]>([
  "CREATE_TABLE",
  "UPDATE_TABLE",
  "RENAME_TABLE",
  "DELETE_TABLE",
  "CREATE_COLUMN",
  "UPDATE_COLUMN",
  "RENAME_COLUMN",
  "REORDER_COLUMN",
  "DELETE_COLUMN",
]);

type TableColumnCommandKind =
  | "CREATE_TABLE"
  | "UPDATE_TABLE"
  | "RENAME_TABLE"
  | "DELETE_TABLE"
  | "CREATE_COLUMN"
  | "UPDATE_COLUMN"
  | "RENAME_COLUMN"
  | "REORDER_COLUMN"
  | "DELETE_COLUMN";

export type TableColumnVisualCommand = Extract<VisualCommand, { kind: TableColumnCommandKind }>;

export type TableColumnTransformSuccess = VisualSourceTransformSuccess;
export type TableColumnTransformFailure = VisualSourceTransformFailure;
export type TableColumnTransformResult = VisualSourceTransformResult;

export async function transformTableColumnCommand(
  source: string,
  command: TableColumnVisualCommand,
  filepath = "/main.dbml",
): Promise<TableColumnTransformResult> {
  return runVerifiedVisualTransform(source, command, filepath, {
    supportedKinds: TABLE_COLUMN_COMMAND_KINDS,
    unsupportedKindMessage: "This source transformer only supports table and column commands.",
    preflight: preflightCommand,
    isSemanticNoOp,
    planEdits: planCommandEdits,
    verifySemantics: verifyCommandSemantics,
  });
}

function preflightCommand(graph: SchemaGraph, command: TableColumnVisualCommand): EditPlan {
  if (command.kind === "CREATE_TABLE") {
    const key = qualifiedElementKey("table", command.table.schemaName, command.table.name);
    return graph.tables.some((table) => table.key === key)
      ? planFailure("VISUAL_NAME_CONFLICT", "A table with the requested qualified name exists.")
      : { ok: true, edits: [] };
  }

  const targetTable = graph.tables.find((table) => table.key === command.targetTableKey);
  if (!targetTable)
    return planFailure("VISUAL_TARGET_NOT_FOUND", "The target table was not found.");

  if (command.kind === "RENAME_TABLE") {
    const newKey = qualifiedElementKey("table", targetTable.schemaName, command.newName);
    if (newKey !== targetTable.key && graph.tables.some((table) => table.key === newKey)) {
      return planFailure("VISUAL_NAME_CONFLICT", "A table with the requested name already exists.");
    }
    const opaque = findOpaqueTableDependency(graph, targetTable);
    if (opaque) return opaqueDependency(opaque);
    return { ok: true, edits: [] };
  }

  if (command.kind === "DELETE_TABLE") {
    if (hasExternalTableDependency(graph, targetTable)) {
      return planFailure(
        "VISUAL_DEPENDENCY_CONFLICT",
        "DeleteTable is blocked until references, group membership, and explicit view filters are removed.",
      );
    }
    const opaque = findOpaqueTableDependency(graph, targetTable);
    if (opaque) return opaqueDependency(opaque);
    return { ok: true, edits: [] };
  }

  if (command.kind === "UPDATE_TABLE") return { ok: true, edits: [] };

  if (command.kind === "CREATE_COLUMN") {
    const key = qualifiedElementKey(
      "column",
      targetTable.schemaName,
      targetTable.name,
      command.column.name,
    );
    return targetTable.columns.some((column) => column.key === key)
      ? planFailure("VISUAL_NAME_CONFLICT", "A column with the requested name already exists.")
      : { ok: true, edits: [] };
  }

  const targetColumn = targetTable.columns.find((column) => column.key === command.targetColumnKey);
  if (!targetColumn) {
    const belongsElsewhere = graph.tables.some((table) =>
      table.columns.some((column) => column.key === command.targetColumnKey),
    );
    return belongsElsewhere
      ? planFailure(
          "VISUAL_TARGET_OWNER_MISMATCH",
          "The target column does not belong to the requested table.",
        )
      : planFailure("VISUAL_TARGET_NOT_FOUND", "The target column was not found.");
  }
  if (targetColumn.injectedFrom) {
    return planFailure(
      "VISUAL_PARTIAL_TARGET_PROTECTED",
      "A TablePartial-injected column cannot be edited as a local table column.",
    );
  }

  if (command.kind === "REORDER_COLUMN" && command.beforeColumnKey !== null) {
    const anchor = targetTable.columns.find((column) => column.key === command.beforeColumnKey);
    if (!anchor) {
      const belongsElsewhere = graph.tables.some((table) =>
        table.columns.some((column) => column.key === command.beforeColumnKey),
      );
      return belongsElsewhere
        ? planFailure(
            "VISUAL_TARGET_OWNER_MISMATCH",
            "The reorder anchor does not belong to the requested table.",
          )
        : planFailure("VISUAL_TARGET_NOT_FOUND", "The reorder anchor column was not found.");
    }
    if (anchor.injectedFrom) {
      return planFailure(
        "VISUAL_PARTIAL_TARGET_PROTECTED",
        "A TablePartial-injected column cannot be used as a reorder anchor.",
      );
    }
  }

  if (command.kind === "RENAME_COLUMN") {
    const newKey = qualifiedElementKey(
      "column",
      targetTable.schemaName,
      targetTable.name,
      command.newName,
    );
    if (
      newKey !== targetColumn.key &&
      targetTable.columns.some((column) => column.key === newKey)
    ) {
      return planFailure(
        "VISUAL_NAME_CONFLICT",
        "A column with the requested name already exists.",
      );
    }
    const opaque = findOpaqueColumnDependency(graph, targetTable, targetColumn);
    if (opaque) return opaqueDependency(opaque);
  }

  if (command.kind === "DELETE_COLUMN") {
    if (hasExternalColumnDependency(graph, targetColumn.key)) {
      return planFailure(
        "VISUAL_DEPENDENCY_CONFLICT",
        "DeleteColumn is blocked until references and column index terms are removed.",
      );
    }
    const opaque = findOpaqueColumnDependency(graph, targetTable, targetColumn);
    if (opaque) return opaqueDependency(opaque);
  }

  return { ok: true, edits: [] };
}

function planCommandEdits(
  source: string,
  graph: SchemaGraph,
  command: TableColumnVisualCommand,
): EditPlan {
  switch (command.kind) {
    case "CREATE_TABLE":
      return planCreateTable(source, command);
    case "UPDATE_TABLE":
      return planUpdateTable(source, requireTable(graph, command.targetTableKey), command);
    case "RENAME_TABLE":
      return planRenameTable(source, graph, requireTable(graph, command.targetTableKey), command);
    case "DELETE_TABLE":
      return {
        ok: true,
        edits: [
          {
            ...lineSpanForRange(source, requireTable(graph, command.targetTableKey).range),
            newText: "",
          },
        ],
      };
    case "CREATE_COLUMN":
      return planCreateColumn(source, requireTable(graph, command.targetTableKey), command);
    case "UPDATE_COLUMN":
      return planUpdateColumn(
        source,
        requireColumn(requireTable(graph, command.targetTableKey), command.targetColumnKey),
        command,
      );
    case "RENAME_COLUMN":
      return planRenameColumn(
        source,
        graph,
        requireTable(graph, command.targetTableKey),
        requireColumn(requireTable(graph, command.targetTableKey), command.targetColumnKey),
        command,
      );
    case "REORDER_COLUMN":
      return planReorderColumn(
        source,
        requireTable(graph, command.targetTableKey),
        requireColumn(requireTable(graph, command.targetTableKey), command.targetColumnKey),
        command.beforeColumnKey,
      );
    case "DELETE_COLUMN": {
      const target = requireColumn(
        requireTable(graph, command.targetTableKey),
        command.targetColumnKey,
      );
      return {
        ok: true,
        edits: [{ ...lineSpanForRange(source, target.range), newText: "" }],
      };
    }
  }
}

function planCreateTable(
  source: string,
  command: Extract<TableColumnVisualCommand, { kind: "CREATE_TABLE" }>,
): EditPlan {
  const newline = detectNewline(source);
  const settings = command.table.color ? ` [headercolor: ${command.table.color}]` : "";
  const declarations: string[] = [];
  for (const column of command.table.columns) {
    const rendered = renderColumn(column);
    if (!rendered.ok) return rendered;
    declarations.push(`  ${rendered.declaration}`);
  }
  if (command.table.note !== null) {
    declarations.push(`  Note: ${renderDbmlString(command.table.note)}`);
  }
  const body = `${declarations.join(newline)}${newline}`;
  const block = `Table ${renderQualifiedName(command.table.schemaName, command.table.name)}${settings} {${newline}${body}}${newline}`;
  let separator = "";
  if (source.length > 0) {
    if (source.endsWith(`${newline}${newline}`)) separator = "";
    else if (source.endsWith(newline)) separator = newline;
    else separator = `${newline}${newline}`;
  }
  return {
    ok: true,
    edits: [
      { startOffset: source.length, endOffset: source.length, newText: `${separator}${block}` },
    ],
  };
}

function planUpdateTable(
  source: string,
  table: TableNode,
  command: Extract<TableColumnVisualCommand, { kind: "UPDATE_TABLE" }>,
): EditPlan {
  const fragment = source.slice(table.range.startOffset, table.range.endOffset);
  const parsedHeader = parseTableHeader(fragment);
  if (!parsedHeader) return invalidRange("The target table header could not be resolved.");
  const header = fragment.slice(0, parsedHeader.openBraceOffset);
  const headerSettings = parsedHeader.settings
    ? {
        ...parsedHeader.settings,
        endOffset: Math.min(parsedHeader.settings.endOffset, header.length),
      }
    : null;
  const noteInHeader =
    table.note !== null &&
    table.note.range.startOffset < table.range.startOffset + parsedHeader.openBraceOffset;
  const mutations: Record<string, SettingMutation> = {};
  if (command.changes.color !== undefined) {
    mutations.headercolor = command.changes.color
      ? valueSettingMutation("headercolor", command.changes.color)
      : null;
  }
  if (noteInHeader && command.changes.note !== undefined) {
    mutations.note =
      command.changes.note === null ? null : stringSettingMutation("note", command.changes.note);
  }

  const rewrittenHeader = rewriteSettings(header, headerSettings, header.length, mutations);
  if (rewrittenHeader === null) return invalidRange("Duplicate table settings are ambiguous.");
  const edits = deriveMinimalTextEdits(header, rewrittenHeader, table.range.startOffset);
  if (!edits) return unsafeTransform("The table header is too large to patch safely.");

  if (!noteInHeader && command.changes.note !== undefined) {
    if (table.note) {
      if (command.changes.note === null) {
        edits.push({ ...lineSpanForRange(source, table.note.range), newText: "" });
      } else {
        edits.push({
          startOffset: table.note.range.startOffset,
          endOffset: table.note.range.endOffset,
          newText: renderDbmlStringWithStyle(
            command.changes.note,
            source.slice(table.note.range.startOffset, table.note.range.endOffset),
          ),
        });
      }
    } else if (command.changes.note !== null) {
      const closingBrace = table.range.endOffset - 1;
      const tableIndent = lineIndentAt(source, table.range.startOffset) ?? "";
      const childIndent = inferTableChildIndent(source, table) ?? `${tableIndent}  `;
      const newline = detectNewline(source, table.range.startOffset, table.range.endOffset);
      const closingLine = lineStartOffset(source, closingBrace);
      const prefix = source.slice(closingLine, closingBrace);
      if (/^[\t ]*$/u.test(prefix)) {
        edits.push({
          startOffset: closingLine,
          endOffset: closingLine,
          newText: `${childIndent}Note: ${renderDbmlString(command.changes.note)}${newline}`,
        });
      } else {
        edits.push({
          startOffset: closingBrace,
          endOffset: closingBrace,
          newText: `${newline}${childIndent}Note: ${renderDbmlString(command.changes.note)}${newline}${tableIndent}`,
        });
      }
    }
  }
  return { ok: true, edits };
}

function planRenameTable(
  source: string,
  graph: SchemaGraph,
  table: TableNode,
  command: Extract<TableColumnVisualCommand, { kind: "RENAME_TABLE" }>,
): EditPlan {
  let transformed: string;
  try {
    transformed = renameTable(
      { schema: table.schemaName, table: table.name },
      { schema: table.schemaName, table: command.newName },
      source,
    );
  } catch {
    return unsafeTransform("The official DBML table rename failed.");
  }
  if (transformed === source) {
    return unsafeTransform("The official DBML table rename returned no source change.");
  }
  const edits = deriveLinePreservingTextEdits(source, transformed);
  if (!edits) {
    return unsafeTransform(
      "The official DBML table rename changed line structure or exceeded the safe diff boundary.",
    );
  }
  const allowedRanges = tableRenameAllowedRanges(graph, table.key);
  if (
    edits.some(
      (edit) =>
        !allowedRanges.some(
          (range) => edit.startOffset >= range.startOffset && edit.endOffset <= range.endOffset,
        ),
    )
  ) {
    return unsafeTransform("The official DBML table rename changed an unrelated source range.");
  }
  const applied = applyTextEdits(source, edits);
  if (!applied.ok || applied.source !== transformed) {
    return unsafeTransform(
      "The official DBML table rename could not be represented as minimal text edits.",
    );
  }
  return { ok: true, edits };
}

function planCreateColumn(
  source: string,
  table: TableNode,
  command: Extract<TableColumnVisualCommand, { kind: "CREATE_COLUMN" }>,
): EditPlan {
  const declaration = renderColumn(command.column);
  if (!declaration.ok) return declaration;
  const closingBraceOffset = table.range.endOffset - 1;
  if (source[closingBraceOffset] !== "}")
    return invalidRange("The table range has no closing brace.");
  const newline = detectNewline(source, table.range.startOffset, table.range.endOffset);
  const tableIndent = lineIndentAt(source, table.range.startOffset) ?? "";
  const columnIndent = inferTableChildIndent(source, table) ?? `${tableIndent}  `;
  const units = effectiveColumnSourceUnits(table);
  let insertionOffset: number;
  if (units.length > 0) {
    const last = units.toSorted((left, right) => left.endOffset - right.endOffset).at(-1);
    if (!last) return invalidRange("The table column ranges could not be resolved.");
    insertionOffset = lineEndOffset(source, last.endOffset, true);
  } else {
    const following = [...table.indexes, ...table.checks]
      .map((element) => element.range.startOffset)
      .concat(table.note ? [table.note.range.startOffset] : [])
      .filter((offset) => offset > table.range.startOffset && offset < closingBraceOffset)
      .toSorted((left, right) => left - right)[0];
    insertionOffset =
      following === undefined
        ? lineStartOffset(source, closingBraceOffset)
        : lineStartOffset(source, following);
  }

  if (insertionOffset <= table.range.startOffset) {
    return {
      ok: true,
      edits: [
        {
          startOffset: closingBraceOffset,
          endOffset: closingBraceOffset,
          newText: `${newline}${columnIndent}${declaration.declaration}${newline}${tableIndent}`,
        },
      ],
    };
  }
  return {
    ok: true,
    edits: [
      {
        startOffset: insertionOffset,
        endOffset: insertionOffset,
        newText: `${columnIndent}${declaration.declaration}${newline}`,
      },
    ],
  };
}

function planUpdateColumn(
  source: string,
  column: ColumnNode,
  command: Extract<TableColumnVisualCommand, { kind: "UPDATE_COLUMN" }>,
): EditPlan {
  const original = source.slice(column.range.startOffset, column.range.endOffset);
  let rewritten = original;
  let parsed = parseColumnDeclaration(rewritten);
  if (!parsed) return invalidRange("The target column declaration could not be resolved.");
  if (command.changes.type !== undefined) {
    rewritten = `${rewritten.slice(0, parsed.typeSpan.startOffset)}${command.changes.type.trim()}${rewritten.slice(parsed.typeSpan.endOffset)}`;
    parsed = parseColumnDeclaration(rewritten);
    if (!parsed) return invalidRange("The updated column type could not be represented safely.");
  }

  const mutations: Record<string, SettingMutation> = {};
  if (command.changes.primaryKey !== undefined)
    mutations.pk = command.changes.primaryKey ? "pk" : null;
  if (command.changes.unique !== undefined)
    mutations.unique = command.changes.unique ? "unique" : null;
  if (command.changes.notNull !== undefined)
    mutations["not null"] = command.changes.notNull ? "not null" : null;
  if (command.changes.default !== undefined) {
    const rendered = renderDefault(command.changes.default);
    if (!rendered.ok) return rendered;
    if (rendered.value === null) {
      mutations.default = null;
    } else if (command.changes.default?.type === "string") {
      mutations.default = stringSettingMutation("default", command.changes.default.value);
    } else {
      mutations.default = valueSettingMutation("default", rendered.value);
    }
  }
  if (command.changes.increment !== undefined)
    mutations.increment = command.changes.increment ? "increment" : null;
  if (command.changes.note !== undefined) {
    mutations.note =
      command.changes.note === null ? null : stringSettingMutation("note", command.changes.note);
  }
  const settingsRewritten = rewriteSettings(
    rewritten,
    parsed.settings,
    parsed.typeSpan.endOffset,
    mutations,
  );
  if (settingsRewritten === null) return invalidRange("Duplicate column settings are ambiguous.");
  rewritten = settingsRewritten;
  const edits = deriveMinimalTextEdits(original, rewritten, column.range.startOffset);
  return edits
    ? { ok: true, edits }
    : unsafeTransform("The column declaration is too large to patch safely.");
}

function planRenameColumn(
  source: string,
  graph: SchemaGraph,
  table: TableNode,
  column: ColumnNode,
  command: Extract<TableColumnVisualCommand, { kind: "RENAME_COLUMN" }>,
): EditPlan {
  const fragment = source.slice(column.range.startOffset, column.range.endOffset);
  const declaration = parseColumnDeclaration(fragment);
  if (!declaration) return invalidRange("The target column declaration could not be resolved.");
  const oldDeclaration = fragment.slice(
    declaration.nameSpan.startOffset,
    declaration.nameSpan.endOffset,
  );
  const edits: TextEdit[] = [
    {
      startOffset: column.range.startOffset + declaration.nameSpan.startOffset,
      endOffset: column.range.startOffset + declaration.nameSpan.endOffset,
      newText: renderIdentifier(command.newName, isQuotedIdentifier(oldDeclaration)),
    },
  ];

  for (const reference of graph.references) {
    for (const endpoint of reference.endpoints) {
      const targetIndex = endpoint.columnKeys.indexOf(column.key);
      if (targetIndex === -1) continue;
      if (
        endpoint.range.startOffset <= column.range.startOffset &&
        endpoint.range.endOffset >= column.range.endOffset
      ) {
        continue;
      }
      const token = endpointColumnToken(
        source,
        endpoint.range,
        endpoint.columnKeys.length,
        targetIndex,
      );
      if (!token || token.value !== column.name) {
        return invalidRange(`A reference endpoint for ${column.key} could not be resolved.`);
      }
      const original = source.slice(token.startOffset, token.endOffset);
      edits.push({
        startOffset: token.startOffset,
        endOffset: token.endOffset,
        newText: renderIdentifier(command.newName, isQuotedIdentifier(original)),
      });
    }
  }

  for (const index of table.indexes) {
    for (const term of index.terms) {
      if (term.kind !== "COLUMN" || term.columnKey !== column.key) continue;
      const original = source.slice(term.range.startOffset, term.range.endOffset);
      edits.push({
        startOffset: term.range.startOffset,
        endOffset: term.range.endOffset,
        newText: renderIdentifier(command.newName, isQuotedIdentifier(original)),
      });
    }
  }
  return { ok: true, edits };
}

function planReorderColumn(
  source: string,
  table: TableNode,
  column: ColumnNode,
  beforeColumnKey: SchemaElementKey | null,
): EditPlan {
  const targetSpan = lineSpanForRange(source, column.range);
  const targetText = source.slice(targetSpan.startOffset, targetSpan.endOffset);
  let insertionOffset: number;
  if (beforeColumnKey !== null) {
    const anchor = requireColumn(table, beforeColumnKey);
    insertionOffset = lineStartOffset(source, anchor.range.startOffset);
  } else {
    const remainingUnits = effectiveColumnSourceUnits(table).filter(
      (range) =>
        range.startOffset !== column.range.startOffset ||
        range.endOffset !== column.range.endOffset,
    );
    const last = remainingUnits.toSorted((left, right) => left.endOffset - right.endOffset).at(-1);
    insertionOffset = last ? lineEndOffset(source, last.endOffset, true) : targetSpan.startOffset;
  }
  if (insertionOffset >= targetSpan.startOffset && insertionOffset <= targetSpan.endOffset) {
    return invalidRange("The reorder destination overlaps the target column declaration.");
  }
  return {
    ok: true,
    edits: [
      { startOffset: targetSpan.startOffset, endOffset: targetSpan.endOffset, newText: "" },
      { startOffset: insertionOffset, endOffset: insertionOffset, newText: targetText },
    ],
  };
}

function isSemanticNoOp(graph: SchemaGraph, command: TableColumnVisualCommand): boolean {
  if (command.kind === "UPDATE_TABLE") {
    const table = graph.tables.find((candidate) => candidate.key === command.targetTableKey);
    return Boolean(
      table &&
        (command.changes.note === undefined ||
          command.changes.note === table.note?.value ||
          (command.changes.note === null && table.note === null)) &&
        (command.changes.color === undefined || command.changes.color === table.color),
    );
  }
  if (command.kind === "RENAME_TABLE") {
    return (
      graph.tables.find((table) => table.key === command.targetTableKey)?.name === command.newName
    );
  }
  if (command.kind === "UPDATE_COLUMN") {
    const table = graph.tables.find((candidate) => candidate.key === command.targetTableKey);
    const column = table?.columns.find((candidate) => candidate.key === command.targetColumnKey);
    return Boolean(column && columnMatchesChanges(column, command.changes));
  }
  if (command.kind === "RENAME_COLUMN") {
    return (
      graph.tables
        .find((table) => table.key === command.targetTableKey)
        ?.columns.find((column) => column.key === command.targetColumnKey)?.name === command.newName
    );
  }
  if (command.kind === "REORDER_COLUMN") {
    const table = graph.tables.find((candidate) => candidate.key === command.targetTableKey);
    if (!table) return false;
    return arraysEqual(
      table.columns.map((column) => column.key),
      reorderedColumnKeys(table, command.targetColumnKey, command.beforeColumnKey),
    );
  }
  return false;
}

function verifyCommandSemantics(
  before: SchemaGraph,
  after: SchemaGraph,
  command: TableColumnVisualCommand,
  diff: SchemaGraphDiff,
): boolean {
  const allowed = allowedChangeKeys(before, after, command);
  if (!allowed) return false;
  if (diff.changes.some((change) => !allowed.has(change.key))) return false;
  if (command.kind === "RENAME_TABLE" || command.kind === "RENAME_COLUMN") {
    const candidate = diff.renameCandidates[0];
    const expectedAfterKey = renameAfterKey(before, command);
    if (
      diff.renameCandidates.length !== 1 ||
      !candidate ||
      candidate.beforeKey !==
        (command.kind === "RENAME_TABLE" ? command.targetTableKey : command.targetColumnKey) ||
      candidate.afterKey !== expectedAfterKey ||
      candidate.confidence !== "HIGH"
    ) {
      return false;
    }
  } else if (diff.renameCandidates.length !== 0) {
    return false;
  }

  switch (command.kind) {
    case "CREATE_TABLE": {
      const key = qualifiedElementKey("table", command.table.schemaName, command.table.name);
      const table = after.tables.find((candidate) => candidate.key === key);
      return Boolean(
        table &&
          table.columns.length === command.table.columns.length &&
          table.columns.every((column, index) => {
            const expected = command.table.columns[index];
            return expected !== undefined && columnMatchesValue(column, expected);
          }) &&
          (table.note?.value ?? null) === command.table.note &&
          table.color === command.table.color &&
          hasChange(diff.changes, "ADD", "table", key) &&
          command.table.columns.every((column) =>
            hasChange(
              diff.changes,
              "ADD",
              "column",
              qualifiedElementKey(
                "column",
                command.table.schemaName,
                command.table.name,
                column.name,
              ),
            ),
          ),
      );
    }
    case "UPDATE_TABLE": {
      const table = after.tables.find((candidate) => candidate.key === command.targetTableKey);
      return Boolean(
        table &&
          (command.changes.note === undefined ||
            table.note?.value === command.changes.note ||
            (command.changes.note === null && table.note === null)) &&
          (command.changes.color === undefined || table.color === command.changes.color) &&
          diff.changes.length > 0,
      );
    }
    case "RENAME_TABLE":
      return verifyTableRename(before, after, command);
    case "DELETE_TABLE":
      return (
        !after.tables.some((table) => table.key === command.targetTableKey) &&
        hasChange(diff.changes, "DELETE", "table", command.targetTableKey)
      );
    case "CREATE_COLUMN": {
      const table = after.tables.find((candidate) => candidate.key === command.targetTableKey);
      const key = table
        ? qualifiedElementKey("column", table.schemaName, table.name, command.column.name)
        : "";
      const column = table?.columns.find((candidate) => candidate.key === key);
      return Boolean(
        column &&
          columnMatchesValue(column, command.column) &&
          hasChange(diff.changes, "ADD", "column", key) &&
          hasChangedField(diff.changes, command.targetTableKey, "columnOrder"),
      );
    }
    case "UPDATE_COLUMN": {
      const column = after.tables
        .find((table) => table.key === command.targetTableKey)
        ?.columns.find((candidate) => candidate.key === command.targetColumnKey);
      return Boolean(
        column && columnMatchesChanges(column, command.changes) && diff.changes.length > 0,
      );
    }
    case "RENAME_COLUMN":
      return verifyColumnRename(before, after, command);
    case "REORDER_COLUMN": {
      const beforeTable = before.tables.find((table) => table.key === command.targetTableKey);
      const afterTable = after.tables.find((table) => table.key === command.targetTableKey);
      return Boolean(
        beforeTable &&
          afterTable &&
          arraysEqual(
            afterTable.columns.map((column) => column.key),
            reorderedColumnKeys(beforeTable, command.targetColumnKey, command.beforeColumnKey),
          ) &&
          diff.changes.length === 1 &&
          hasChangedField(diff.changes, command.targetTableKey, "columnOrder"),
      );
    }
    case "DELETE_COLUMN":
      return (
        !after.tables.some((table) =>
          table.columns.some((column) => column.key === command.targetColumnKey),
        ) &&
        hasChange(diff.changes, "DELETE", "column", command.targetColumnKey) &&
        hasChangedField(diff.changes, command.targetTableKey, "columnOrder")
      );
  }
}

function allowedChangeKeys(
  before: SchemaGraph,
  after: SchemaGraph,
  command: TableColumnVisualCommand,
): Set<SchemaElementKey> | null {
  if (command.kind === "CREATE_TABLE") {
    return new Set([
      qualifiedElementKey("table", command.table.schemaName, command.table.name),
      ...command.table.columns.map((column) =>
        qualifiedElementKey("column", command.table.schemaName, command.table.name, column.name),
      ),
    ]);
  }
  if (command.kind === "UPDATE_TABLE") return new Set([command.targetTableKey]);
  if (command.kind === "DELETE_TABLE") {
    const table = before.tables.find((candidate) => candidate.key === command.targetTableKey);
    return table ? tableElementKeys(table) : null;
  }
  if (command.kind === "CREATE_COLUMN") {
    const table = before.tables.find((candidate) => candidate.key === command.targetTableKey);
    return table
      ? new Set([
          table.key,
          qualifiedElementKey("column", table.schemaName, table.name, command.column.name),
        ])
      : null;
  }
  if (command.kind === "UPDATE_COLUMN") return new Set([command.targetColumnKey]);
  if (command.kind === "REORDER_COLUMN") return new Set([command.targetTableKey]);
  if (command.kind === "DELETE_COLUMN") {
    const table = before.tables.find((candidate) => candidate.key === command.targetTableKey);
    const column = table?.columns.find((candidate) => candidate.key === command.targetColumnKey);
    return column
      ? new Set([
          table?.key ?? command.targetTableKey,
          column.key,
          ...column.checks.map((check) => check.key),
        ])
      : null;
  }
  if (command.kind === "RENAME_TABLE") {
    const beforeTable = before.tables.find((candidate) => candidate.key === command.targetTableKey);
    const afterKey = renameAfterKey(before, command);
    const afterTable = after.tables.find((candidate) => candidate.key === afterKey);
    if (!beforeTable || !afterTable) return null;
    const keys = new Set([...tableElementKeys(beforeTable), ...tableElementKeys(afterTable)]);
    for (const reference of [...before.references, ...after.references]) {
      if (
        reference.endpoints.some(
          (endpoint) =>
            endpoint.tableKey === beforeTable.key || endpoint.tableKey === afterTable.key,
        )
      ) {
        keys.add(reference.key);
      }
    }
    for (const group of [...before.groups, ...after.groups]) {
      if (group.tableKeys.includes(beforeTable.key) || group.tableKeys.includes(afterTable.key))
        keys.add(group.key);
    }
    for (const view of [...before.views, ...after.views]) {
      if (
        view.visibleTableKeys?.includes(beforeTable.key) ||
        view.visibleTableKeys?.includes(afterTable.key)
      )
        keys.add(view.key);
    }
    return keys;
  }
  const beforeTable = before.tables.find((candidate) => candidate.key === command.targetTableKey);
  const afterTable = after.tables.find((candidate) => candidate.key === command.targetTableKey);
  const afterKey = renameAfterKey(before, command);
  const beforeColumn = beforeTable?.columns.find(
    (column) => column.key === command.targetColumnKey,
  );
  const afterColumn = afterTable?.columns.find((column) => column.key === afterKey);
  if (!beforeTable || !afterTable || !beforeColumn || !afterColumn) return null;
  const keys = new Set<SchemaElementKey>([
    beforeTable.key,
    beforeColumn.key,
    afterColumn.key,
    ...beforeColumn.checks.map((check) => check.key),
    ...afterColumn.checks.map((check) => check.key),
  ]);
  for (const index of [...beforeTable.indexes, ...afterTable.indexes]) {
    if (
      index.terms.some(
        (term) =>
          term.kind === "COLUMN" &&
          (term.columnKey === beforeColumn.key || term.columnKey === afterColumn.key),
      )
    ) {
      keys.add(index.key);
    }
  }
  for (const reference of [...before.references, ...after.references]) {
    if (
      reference.endpoints.some((endpoint) =>
        endpoint.columnKeys.some((key) => key === beforeColumn.key || key === afterColumn.key),
      )
    ) {
      keys.add(reference.key);
    }
  }
  return keys;
}

function verifyTableRename(
  before: SchemaGraph,
  after: SchemaGraph,
  command: Extract<TableColumnVisualCommand, { kind: "RENAME_TABLE" }>,
): boolean {
  const beforeTable = before.tables.find((table) => table.key === command.targetTableKey);
  const afterTable = after.tables.find((table) => table.key === renameAfterKey(before, command));
  if (!beforeTable || !afterTable) return false;
  if (stableJson(tablePayloadShape(beforeTable)) !== stableJson(tablePayloadShape(afterTable)))
    return false;
  const remap = tableRenameMap(beforeTable, afterTable);
  return (
    semanticCollectionEqual(
      before.references.map((reference) => referenceShape(reference, remap)),
      after.references.map((reference) => referenceShape(reference)),
    ) &&
    semanticCollectionEqual(
      before.groups.map((group) => ({
        ...groupShape(group),
        tableKeys: group.tableKeys.map((key) => remap.get(key) ?? key).toSorted(),
      })),
      after.groups.map(groupShape),
    ) &&
    semanticCollectionEqual(
      before.views.map((view) => ({
        ...viewShape(view),
        visibleTableKeys:
          view.visibleTableKeys?.map((key) => remap.get(key) ?? key).toSorted() ?? null,
      })),
      after.views.map(viewShape),
    )
  );
}

function verifyColumnRename(
  before: SchemaGraph,
  after: SchemaGraph,
  command: Extract<TableColumnVisualCommand, { kind: "RENAME_COLUMN" }>,
): boolean {
  const beforeTable = before.tables.find((table) => table.key === command.targetTableKey);
  const afterTable = after.tables.find((table) => table.key === command.targetTableKey);
  if (!beforeTable || !afterTable) return false;
  const afterKey = renameAfterKey(before, command);
  const remap = new Map([[command.targetColumnKey, afterKey]]);
  if (
    stableJson(tablePayloadShape(beforeTable, command.targetColumnKey, command.newName)) !==
    stableJson(tablePayloadShape(afterTable))
  ) {
    return false;
  }
  return semanticCollectionEqual(
    before.references.map((reference) => referenceShape(reference, remap)),
    after.references.map((reference) => referenceShape(reference)),
  );
}

function tablePayloadShape(table: TableNode, renamedColumnKey?: string, newName?: string) {
  const names = new Map(table.columns.map((column) => [column.key, column.name]));
  if (renamedColumnKey && newName) names.set(renamedColumnKey, newName);
  return {
    alias: table.alias,
    note: table.note?.value ?? null,
    color: table.color,
    metadata: table.metadata,
    partialKeys: [...table.partialKeys].toSorted(),
    columns: table.columns.map((column) => ({
      name: names.get(column.key) ?? column.name,
      type: column.type,
      primaryKey: column.primaryKey,
      unique: column.unique,
      notNull: column.notNull,
      default: column.default,
      increment: column.increment,
      note: column.note?.value ?? null,
      metadata: column.metadata,
      checks: column.checks.map((check) => ({ name: check.name, expression: check.expression })),
      injectedFrom: column.injectedFrom
        ? {
            partialKey: column.injectedFrom.partialKey,
            partialElementKey: column.injectedFrom.partialElementKey,
          }
        : null,
    })),
    indexes: table.indexes
      .map((index) => ({
        name: index.name,
        terms: index.terms.map((term) =>
          term.kind === "COLUMN"
            ? { kind: "COLUMN", columnName: names.get(term.columnKey) ?? term.columnKey }
            : { kind: "EXPRESSION", expression: term.expression },
        ),
        type: index.type,
        unique: index.unique,
        primaryKey: index.primaryKey,
        note: index.note?.value ?? null,
      }))
      .toSorted(compareJson),
    checks: table.checks
      .map((check) => ({ name: check.name, expression: check.expression }))
      .toSorted(compareJson),
  };
}

function tableRenameMap(before: TableNode, after: TableNode): Map<string, string> {
  const remap = new Map<string, string>([[before.key, after.key]]);
  for (const beforeColumn of before.columns) {
    const afterColumn = after.columns.find((column) => column.name === beforeColumn.name);
    if (afterColumn) remap.set(beforeColumn.key, afterColumn.key);
  }
  return remap;
}

function referenceShape(reference: ReferenceEdge, remap = new Map<string, string>()) {
  return {
    schemaName: reference.schemaName,
    name: reference.name,
    endpoints: reference.endpoints.map((endpoint) => ({
      tableKey: remap.get(endpoint.tableKey) ?? endpoint.tableKey,
      columnKeys: endpoint.columnKeys.map((key) => remap.get(key) ?? key),
      multiplicity: endpoint.multiplicity,
    })),
    onDelete: reference.onDelete,
    onUpdate: reference.onUpdate,
    color: reference.color,
    inactive: reference.inactive,
  };
}

function groupShape(group: SchemaGraph["groups"][number]) {
  return {
    key: group.key,
    schemaName: group.schemaName,
    name: group.name,
    tableKeys: [...group.tableKeys].toSorted(),
    note: group.note?.value ?? null,
    color: group.color,
    metadata: group.metadata,
  };
}

function viewShape(view: SchemaGraph["views"][number]) {
  return {
    key: view.key,
    schemaName: view.schemaName,
    name: view.name,
    visibleTableKeys: view.visibleTableKeys ? [...view.visibleTableKeys].toSorted() : null,
    visibleNoteKeys: view.visibleNoteKeys ? [...view.visibleNoteKeys].toSorted() : null,
    visibleGroupKeys: view.visibleGroupKeys ? [...view.visibleGroupKeys].toSorted() : null,
    visibleSchemaNames: view.visibleSchemaNames ? [...view.visibleSchemaNames].toSorted() : null,
  };
}

function tableElementKeys(table: TableNode): Set<SchemaElementKey> {
  return new Set([
    table.key,
    ...table.columns.flatMap((column) => [column.key, ...column.checks.map((check) => check.key)]),
    ...table.indexes.map((index) => index.key),
    ...table.checks.map((check) => check.key),
  ]);
}

function renderColumn(
  column: Extract<TableColumnVisualCommand, { kind: "CREATE_COLUMN" }>["column"],
): { ok: true; declaration: string } | { ok: false; diagnostic: SourceTransformDiagnostic } {
  const settings: string[] = [];
  if (column.primaryKey) settings.push("pk");
  if (column.unique) settings.push("unique");
  if (column.notNull) settings.push("not null");
  if (column.default !== null) {
    const rendered = renderDefault(column.default);
    if (!rendered.ok) return rendered;
    if (rendered.value !== null) settings.push(`default: ${rendered.value}`);
  }
  if (column.increment) settings.push("increment");
  if (column.note !== null) settings.push(`note: ${renderDbmlString(column.note)}`);
  return {
    ok: true,
    declaration: `${renderIdentifier(column.name)} ${column.type.trim()}${settings.length > 0 ? ` [${settings.join(", ")}]` : ""}`,
  };
}

function renderDefault(
  value: VisualColumnDefault | null,
): { ok: true; value: string | null } | { ok: false; diagnostic: SourceTransformDiagnostic } {
  if (value === null) return { ok: true, value: null };
  switch (value.type) {
    case "number":
      return { ok: true, value: String(value.value) };
    case "string":
      return { ok: true, value: renderDbmlString(value.value) };
    case "boolean":
      return { ok: true, value: String(value.value) };
    case "null":
      return { ok: true, value: "null" };
    case "expression":
      return value.value.includes("`")
        ? planFailure(
            "VISUAL_VALUE_UNREPRESENTABLE",
            "A DBML expression containing a backtick cannot be rendered safely.",
          )
        : { ok: true, value: `\`${value.value}\`` };
  }
}

function valueSettingMutation(key: string, value: string): ExistingSettingMutation {
  return {
    create: `${key}: ${value}`,
    update: (entry) => replaceSettingValue(entry, value),
  };
}

function stringSettingMutation(key: string, value: string): ExistingSettingMutation {
  return {
    create: `${key}: ${renderDbmlString(value)}`,
    update: (entry) => {
      const existingValue = settingValueSource(entry);
      if (existingValue === null) return null;
      return replaceSettingValue(entry, renderDbmlStringWithStyle(value, existingValue));
    },
  };
}

function columnMatchesValue(
  column: ColumnNode,
  expected: Extract<TableColumnVisualCommand, { kind: "CREATE_COLUMN" }>["column"],
): boolean {
  return (
    column.name === expected.name &&
    matchesTypeFragment(column, expected.type) &&
    column.primaryKey === expected.primaryKey &&
    column.unique === expected.unique &&
    column.notNull === expected.notNull &&
    sameDefault(column.default, expected.default) &&
    column.increment === expected.increment &&
    (column.note?.value ?? null) === expected.note &&
    Object.keys(column.metadata).length === 0 &&
    column.checks.length === 0 &&
    column.injectedFrom === null
  );
}

function columnMatchesChanges(
  column: ColumnNode,
  changes: Extract<TableColumnVisualCommand, { kind: "UPDATE_COLUMN" }>["changes"],
): boolean {
  return (
    (changes.type === undefined || matchesTypeFragment(column, changes.type)) &&
    (changes.primaryKey === undefined || column.primaryKey === changes.primaryKey) &&
    (changes.unique === undefined || column.unique === changes.unique) &&
    (changes.notNull === undefined || column.notNull === changes.notNull) &&
    (changes.default === undefined || sameDefault(column.default, changes.default)) &&
    (changes.increment === undefined || column.increment === changes.increment) &&
    (changes.note === undefined || (column.note?.value ?? null) === changes.note)
  );
}

function matchesTypeFragment(column: ColumnNode, value: string): boolean {
  const expected = parseColumnTypeFragment(value);
  return expected !== null && sameColumnType(column.type, expected);
}

function sameDefault(left: ColumnDefaultNode | null, right: VisualColumnDefault | null): boolean {
  return stableJson(left) === stableJson(right);
}

function reorderedColumnKeys(
  table: TableNode,
  targetColumnKey: string,
  beforeColumnKey: string | null,
): string[] {
  const keys = table.columns.map((column) => column.key).filter((key) => key !== targetColumnKey);
  const insertionIndex = beforeColumnKey === null ? keys.length : keys.indexOf(beforeColumnKey);
  if (insertionIndex < 0) return table.columns.map((column) => column.key);
  keys.splice(insertionIndex, 0, targetColumnKey);
  return keys;
}

function hasExternalTableDependency(graph: SchemaGraph, table: TableNode): boolean {
  return (
    graph.references.some((reference) =>
      reference.endpoints.some((endpoint) => endpoint.tableKey === table.key),
    ) ||
    graph.groups.some((group) => group.tableKeys.includes(table.key)) ||
    graph.views.some((view) => view.visibleTableKeys?.includes(table.key) === true)
  );
}

function hasExternalColumnDependency(graph: SchemaGraph, columnKey: string): boolean {
  return (
    graph.references.some((reference) =>
      reference.endpoints.some((endpoint) => endpoint.columnKeys.includes(columnKey)),
    ) ||
    graph.tables.some((table) =>
      table.indexes.some((index) =>
        index.terms.some((term) => term.kind === "COLUMN" && term.columnKey === columnKey),
      ),
    )
  );
}

function findOpaqueTableDependency(graph: SchemaGraph, table: TableNode): SourceRange | null {
  const candidates = [[table.schemaName, table.name], [table.name]];
  return (
    expressionOccurrences(graph).find((occurrence) =>
      containsOpaqueIdentifierQualifier(occurrence.expression, candidates),
    )?.range ?? null
  );
}

function findOpaqueColumnDependency(
  graph: SchemaGraph,
  table: TableNode,
  column: ColumnNode,
): SourceRange | null {
  const qualified = [
    [table.schemaName, table.name, column.name],
    [table.name, column.name],
  ];
  return (
    expressionOccurrences(graph).find((occurrence) => {
      const candidates =
        occurrence.ownerTableKey === table.key ? [...qualified, [column.name]] : qualified;
      return containsOpaqueIdentifierPath(occurrence.expression, candidates);
    })?.range ?? null
  );
}

function expressionOccurrences(graph: SchemaGraph): Array<{
  expression: string;
  ownerTableKey: string | null;
  range: SourceRange;
}> {
  const occurrences: Array<{
    expression: string;
    ownerTableKey: string | null;
    range: SourceRange;
  }> = [];
  for (const table of graph.tables) {
    for (const column of table.columns) {
      if (column.default?.type === "expression") {
        occurrences.push({
          expression: column.default.value,
          ownerTableKey: table.key,
          range: column.range,
        });
      }
      for (const check of column.checks) {
        occurrences.push({
          expression: check.expression,
          ownerTableKey: table.key,
          range: check.range,
        });
      }
    }
    for (const check of table.checks) {
      occurrences.push({
        expression: check.expression,
        ownerTableKey: table.key,
        range: check.range,
      });
    }
    for (const index of table.indexes) {
      for (const term of index.terms) {
        if (term.kind === "EXPRESSION") {
          occurrences.push({
            expression: term.expression,
            ownerTableKey: table.key,
            range: term.range,
          });
        }
      }
    }
  }
  for (const partial of graph.partials) {
    for (const column of partial.columns) {
      if (column.default?.type === "expression") {
        occurrences.push({
          expression: column.default.value,
          ownerTableKey: null,
          range: column.range,
        });
      }
      for (const check of column.checks) {
        occurrences.push({ expression: check.expression, ownerTableKey: null, range: check.range });
      }
    }
    for (const check of partial.checks) {
      occurrences.push({ expression: check.expression, ownerTableKey: null, range: check.range });
    }
    for (const index of partial.indexes) {
      for (const term of index.terms) {
        if (term.kind === "EXPRESSION") {
          occurrences.push({ expression: term.expression, ownerTableKey: null, range: term.range });
        }
      }
    }
  }
  return occurrences;
}

function tableRenameAllowedRanges(graph: SchemaGraph, tableKey: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  const table = graph.tables.find((candidate) => candidate.key === tableKey);
  if (table) ranges.push(table.range);
  for (const reference of graph.references) {
    for (const endpoint of reference.endpoints) {
      if (endpoint.tableKey === tableKey) ranges.push(endpoint.range);
    }
  }
  for (const group of graph.groups) {
    if (group.tableKeys.includes(tableKey)) ranges.push(group.range);
  }
  for (const view of graph.views) {
    if (view.visibleTableKeys?.includes(tableKey)) ranges.push(view.range);
  }
  return ranges;
}

function endpointColumnToken(
  source: string,
  range: SourceRange,
  arity: number,
  targetIndex: number,
): (OffsetSpan & { value: string }) | null {
  const tokens = identifierTokens(source, range);
  const endpointTokens = tokens.slice(-arity);
  return endpointTokens[targetIndex] ?? null;
}

function effectiveColumnSourceUnits(table: TableNode): OffsetSpan[] {
  const unique = new Map<string, OffsetSpan>();
  for (const column of table.columns) {
    const range = column.injectedFrom?.injectionRange ?? column.range;
    unique.set(`${range.startOffset}:${range.endOffset}`, range);
  }
  return [...unique.values()].toSorted((left, right) => left.startOffset - right.startOffset);
}

function inferTableChildIndent(source: string, table: TableNode): string | null {
  const candidates = [
    ...effectiveColumnSourceUnits(table),
    ...table.indexes.map((index) => index.range),
    ...table.checks.map((check) => check.range),
    ...(table.note ? [table.note.range] : []),
  ].toSorted((left, right) => left.startOffset - right.startOffset);
  for (const candidate of candidates) {
    const indent = lineIndentAt(source, candidate.startOffset);
    if (indent !== null) return indent;
  }
  return null;
}

function renameAfterKey(
  before: SchemaGraph,
  command: Extract<TableColumnVisualCommand, { kind: "RENAME_TABLE" | "RENAME_COLUMN" }>,
): string {
  const table = before.tables.find((candidate) => candidate.key === command.targetTableKey);
  if (!table) return "";
  return command.kind === "RENAME_TABLE"
    ? qualifiedElementKey("table", table.schemaName, command.newName)
    : qualifiedElementKey("column", table.schemaName, table.name, command.newName);
}

function renderQualifiedName(schemaName: string, tableName: string): string {
  return `${renderIdentifier(schemaName)}.${renderIdentifier(tableName)}`;
}

function requireTable(graph: SchemaGraph, key: string): TableNode {
  const table = graph.tables.find((candidate) => candidate.key === key);
  if (!table) throw new Error(`Preflight invariant violated for table ${key}`);
  return table;
}

function requireColumn(table: TableNode, key: string): ColumnNode {
  const column = table.columns.find((candidate) => candidate.key === key);
  if (!column) throw new Error(`Preflight invariant violated for column ${key}`);
  return column;
}

function hasChange(
  changes: readonly SchemaElementChange[],
  operation: "ADD" | "DELETE",
  kind: SchemaElementChange["elementKind"],
  key: string,
): boolean {
  return changes.some(
    (change) => change.operation === operation && change.elementKind === kind && change.key === key,
  );
}

function hasChangedField(
  changes: readonly SchemaElementChange[],
  key: string,
  field: string,
): boolean {
  return changes.some(
    (change) =>
      change.operation === "UPDATE" && change.key === key && change.changedFields.includes(field),
  );
}

function semanticCollectionEqual(left: unknown[], right: unknown[]): boolean {
  return arraysEqual(left.map(stableJson).toSorted(), right.map(stableJson).toSorted());
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function compareJson(left: unknown, right: unknown): number {
  const leftJson = stableJson(left);
  const rightJson = stableJson(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function opaqueDependency(range: SourceRange): EditPlan {
  return {
    ok: false,
    diagnostic: {
      code: "VISUAL_OPAQUE_EXPRESSION_DEPENDENCY",
      message:
        "The target identifier is used by an opaque expression and must be edited in source.",
      severity: "ERROR",
      range: withoutFilepath(range),
    },
  };
}
