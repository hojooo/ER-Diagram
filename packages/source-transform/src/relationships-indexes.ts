import { getRelationshipOp } from "@dbml/core";
import type { VisualCommand, VisualReferenceEndpoint } from "@er-diagram/contracts";
import type {
  CheckNode,
  ColumnNode,
  IndexNode,
  ReferenceEdge,
  SchemaElementChange,
  SchemaElementKey,
  SchemaGraph,
  SchemaGraphDiff,
  TableNode,
} from "@er-diagram/core";
import {
  deriveMinimalTextEdits,
  detectNewline,
  type ExistingSettingMutation,
  findDirectChildBlock,
  findTopLevelCharacterAt,
  isQuotedIdentifier,
  lineEndOffset,
  lineIndentAt,
  lineSpanForRange,
  lineStartOffset,
  type OffsetSpan,
  type ParsedSetting,
  parseColumnDeclaration,
  parseSettingsBlockAt,
  renderDbmlString,
  renderDbmlStringWithStyle,
  renderIdentifier,
  replaceSettingValue,
  rewriteSettingOccurrence,
  rewriteSettings,
  type SettingMutation,
  settingValueSource,
} from "./dbml-fragment.js";
import { protectedPartialTarget } from "./partial-impact.js";
import type { TextEdit, VisualSourceTransformResult } from "./types.js";
import {
  type EditPlan,
  invalidRange,
  planFailure,
  runVerifiedVisualTransform,
} from "./verified-transform.js";

type RelationshipIndexCheckCommandKind =
  | "CREATE_REFERENCE"
  | "UPDATE_REFERENCE"
  | "DELETE_REFERENCE"
  | "CREATE_INDEX"
  | "UPDATE_INDEX"
  | "DELETE_INDEX"
  | "CREATE_CHECK"
  | "UPDATE_CHECK"
  | "DELETE_CHECK";

export type RelationshipIndexCheckVisualCommand = Extract<
  VisualCommand,
  { kind: RelationshipIndexCheckCommandKind }
>;

type CreateReferenceCommand = Extract<
  RelationshipIndexCheckVisualCommand,
  { kind: "CREATE_REFERENCE" }
>;
type UpdateReferenceCommand = Extract<
  RelationshipIndexCheckVisualCommand,
  { kind: "UPDATE_REFERENCE" }
>;
type ReferenceValue = CreateReferenceCommand["reference"];
type CreateIndexCommand = Extract<RelationshipIndexCheckVisualCommand, { kind: "CREATE_INDEX" }>;
type UpdateIndexCommand = Extract<RelationshipIndexCheckVisualCommand, { kind: "UPDATE_INDEX" }>;
type IndexValue = CreateIndexCommand["index"];
type CreateCheckCommand = Extract<RelationshipIndexCheckVisualCommand, { kind: "CREATE_CHECK" }>;
type UpdateCheckCommand = Extract<RelationshipIndexCheckVisualCommand, { kind: "UPDATE_CHECK" }>;
type CheckValue = CreateCheckCommand["check"];

const SUPPORTED_KINDS = new Set<VisualCommand["kind"]>([
  "CREATE_REFERENCE",
  "UPDATE_REFERENCE",
  "DELETE_REFERENCE",
  "CREATE_INDEX",
  "UPDATE_INDEX",
  "DELETE_INDEX",
  "CREATE_CHECK",
  "UPDATE_CHECK",
  "DELETE_CHECK",
]);

export function transformRelationshipIndexCheckCommand(
  source: string,
  command: RelationshipIndexCheckVisualCommand,
  filepath = "/main.dbml",
): Promise<VisualSourceTransformResult> {
  return runVerifiedVisualTransform(source, command, filepath, {
    supportedKinds: SUPPORTED_KINDS,
    unsupportedKindMessage:
      "This source transformer only supports reference, index, and check commands.",
    preflight: preflightCommand,
    isSemanticNoOp,
    planEdits: planCommandEdits,
    verifySemantics: verifyCommandSemantics,
  });
}

function preflightCommand(
  graph: SchemaGraph,
  command: RelationshipIndexCheckVisualCommand,
): EditPlan {
  switch (command.kind) {
    case "CREATE_REFERENCE":
      return preflightCreateReference(graph, command);
    case "UPDATE_REFERENCE":
    case "DELETE_REFERENCE":
      return preflightExistingReference(graph, command);
    case "CREATE_INDEX":
      return preflightCreateIndex(graph, command);
    case "UPDATE_INDEX":
    case "DELETE_INDEX":
      return preflightExistingIndex(graph, command);
    case "CREATE_CHECK":
      return preflightCreateCheck(graph, command);
    case "UPDATE_CHECK":
    case "DELETE_CHECK":
      return preflightExistingCheck(graph, command);
  }
}

function preflightCreateReference(graph: SchemaGraph, command: CreateReferenceCommand): EditPlan {
  if (command.reference.schemaName !== "public") {
    return capabilityFailure("Pinned DBML v2 only represents top-level references in public.");
  }
  const endpoints = validateReferenceEndpoints(graph, command.reference.endpoints);
  if (!endpoints.ok) return endpoints;
  return validateReferenceIdentity(graph, command.reference, null);
}

function preflightExistingReference(
  graph: SchemaGraph,
  command: Extract<
    RelationshipIndexCheckVisualCommand,
    { kind: "UPDATE_REFERENCE" | "DELETE_REFERENCE" }
  >,
): EditPlan {
  const target = graph.references.find((reference) => reference.key === command.targetReferenceKey);
  if (!target) return planFailure("VISUAL_TARGET_NOT_FOUND", "The target reference was not found.");
  if (target.injectedFrom) return protectedPartialTarget(graph, target.injectedFrom, "reference");
  if (command.kind === "DELETE_REFERENCE") return { ok: true, edits: [] };
  const desired = mergeReference(target, command.changes);
  const endpoints = validateReferenceEndpoints(graph, desired.endpoints);
  if (!endpoints.ok) return endpoints;
  return validateReferenceIdentity(graph, desired, target.key);
}

function validateReferenceEndpoints(
  graph: SchemaGraph,
  endpoints: ReferenceValue["endpoints"],
): EditPlan {
  for (const endpoint of endpoints) {
    const table = graph.tables.find((candidate) => candidate.key === endpoint.tableKey);
    if (!table)
      return planFailure("VISUAL_TARGET_NOT_FOUND", "A reference endpoint table was not found.");
    for (const columnKey of endpoint.columnKeys) {
      if (!table.columns.some((column) => column.key === columnKey)) {
        const existsElsewhere = graph.tables.some((candidate) =>
          candidate.columns.some((column) => column.key === columnKey),
        );
        return existsElsewhere
          ? planFailure(
              "VISUAL_TARGET_OWNER_MISMATCH",
              "A reference endpoint column does not belong to its table.",
            )
          : planFailure("VISUAL_TARGET_NOT_FOUND", "A reference endpoint column was not found.");
      }
    }
  }
  if (
    endpoints[0].tableKey === endpoints[1].tableKey &&
    arraysEqual(endpoints[0].columnKeys, endpoints[1].columnKeys)
  ) {
    return capabilityFailure("A reference cannot use the same columns for both endpoints.");
  }
  return { ok: true, edits: [] };
}

function validateReferenceIdentity(
  graph: SchemaGraph,
  desired: ReferenceValue,
  excludedKey: SchemaElementKey | null,
): EditPlan {
  const others = graph.references.filter((reference) => reference.key !== excludedKey);
  if (
    desired.name !== null &&
    others.some(
      (reference) => reference.schemaName === desired.schemaName && reference.name === desired.name,
    )
  ) {
    return planFailure("VISUAL_NAME_CONFLICT", "A reference with the requested name exists.");
  }
  if (others.some((reference) => sameReferenceEndpoints(reference.endpoints, desired.endpoints))) {
    return planFailure(
      "VISUAL_NAME_CONFLICT",
      "A reference with the requested endpoints already exists.",
    );
  }
  if (
    desired.name === null &&
    others.some((reference) =>
      reference.name === null ? sameReferenceIdentity(reference, desired) : false,
    )
  ) {
    return anonymousIdentityFailure("reference");
  }
  return { ok: true, edits: [] };
}

function preflightCreateIndex(graph: SchemaGraph, command: CreateIndexCommand): EditPlan {
  const table = graph.tables.find((candidate) => candidate.key === command.targetTableKey);
  if (!table) return planFailure("VISUAL_TARGET_NOT_FOUND", "The target table was not found.");
  const value = validateIndexValue(graph, table, command.index, null);
  if (!value.ok) return value;
  return validateIndexIdentity(table, command.index, null);
}

function preflightExistingIndex(
  graph: SchemaGraph,
  command: Extract<RelationshipIndexCheckVisualCommand, { kind: "UPDATE_INDEX" | "DELETE_INDEX" }>,
): EditPlan {
  const table = graph.tables.find((candidate) => candidate.key === command.targetTableKey);
  if (!table) return planFailure("VISUAL_TARGET_NOT_FOUND", "The target table was not found.");
  const target = table.indexes.find((index) => index.key === command.targetIndexKey);
  if (!target) {
    const existsElsewhere = graph.tables.some((candidate) =>
      candidate.indexes.some((index) => index.key === command.targetIndexKey),
    );
    return existsElsewhere
      ? planFailure(
          "VISUAL_TARGET_OWNER_MISMATCH",
          "The target index does not belong to the requested table.",
        )
      : planFailure("VISUAL_TARGET_NOT_FOUND", "The target index was not found.");
  }
  if (target.injectedFrom) return protectedPartialTarget(graph, target.injectedFrom, "index");
  if (hasAmbiguousAnonymousIndex(table, target)) return anonymousIdentityFailure("index");
  if (command.kind === "DELETE_INDEX") return { ok: true, edits: [] };
  const desired = mergeIndex(target, command.changes);
  const value = validateIndexValue(graph, table, desired, target.key);
  if (!value.ok) return value;
  return validateIndexIdentity(table, desired, target.key);
}

function validateIndexValue(
  graph: SchemaGraph,
  table: TableNode,
  value: IndexValue,
  targetKey: SchemaElementKey | null,
): EditPlan {
  let sawColumn = false;
  for (const term of value.terms) {
    if (term.kind === "EXPRESSION") {
      if (term.expression.includes("`")) {
        return unrepresentable(
          "An index expression containing a backtick cannot be rendered safely.",
        );
      }
      if (sawColumn) {
        return capabilityFailure(
          "Pinned DBML v2 reorders mixed index terms; expression terms must precede column terms.",
        );
      }
      continue;
    }
    sawColumn = true;
    const column = table.columns.find((candidate) => candidate.key === term.columnKey);
    if (!column) {
      const existsElsewhere = graph.tables.some((candidate) =>
        candidate.columns.some((item) => item.key === term.columnKey),
      );
      return existsElsewhere
        ? planFailure(
            "VISUAL_TARGET_OWNER_MISMATCH",
            "An index column does not belong to the requested table.",
          )
        : planFailure("VISUAL_TARGET_NOT_FOUND", "An index column was not found.");
    }
    if (column.injectedFrom) {
      return protectedPartialTarget(graph, column.injectedFrom, "index column");
    }
  }
  if (value.type !== null && !isRepresentableIndexType(value.type)) {
    return capabilityFailure("The requested index type is not a representable DBML scalar.");
  }
  if (value.primaryKey) {
    if (value.terms.some((term) => term.kind === "EXPRESSION")) {
      return capabilityFailure("A visual primary index can contain only local column terms.");
    }
    const otherPrimaryDefinition =
      table.columns.some((column) => column.primaryKey) ||
      table.indexes.some((index) => index.key !== targetKey && index.primaryKey);
    if (otherPrimaryDefinition) {
      return planFailure(
        "VISUAL_PRIMARY_KEY_CONFLICT",
        "The table already has another primary-key definition.",
      );
    }
  }
  return { ok: true, edits: [] };
}

function validateIndexIdentity(
  table: TableNode,
  desired: IndexValue,
  excludedKey: SchemaElementKey | null,
): EditPlan {
  const others = table.indexes.filter((index) => index.key !== excludedKey);
  if (desired.name !== null && others.some((index) => index.name === desired.name)) {
    return planFailure("VISUAL_NAME_CONFLICT", "An index with the requested name exists.");
  }
  if (
    desired.name === null &&
    others.some((index) => index.name === null && sameIndexIdentity(index, desired))
  ) {
    return anonymousIdentityFailure("index");
  }
  return { ok: true, edits: [] };
}

function preflightCreateCheck(graph: SchemaGraph, command: CreateCheckCommand): EditPlan {
  const owner = resolveCheckOwner(graph, command.targetTableKey, command.ownerColumnKey);
  if (!owner.ok) return owner.plan;
  const value = validateCheckValue(command.check, command.ownerColumnKey);
  if (!value.ok) return value;
  return validateCheckIdentity(owner.checks, command.check, null);
}

function preflightExistingCheck(
  graph: SchemaGraph,
  command: Extract<RelationshipIndexCheckVisualCommand, { kind: "UPDATE_CHECK" | "DELETE_CHECK" }>,
): EditPlan {
  const owner = resolveCheckOwner(graph, command.targetTableKey, command.ownerColumnKey);
  if (!owner.ok) return owner.plan;
  const target = owner.checks.find((check) => check.key === command.targetCheckKey);
  if (!target) {
    const existsElsewhere = allChecks(graph).some((check) => check.key === command.targetCheckKey);
    return existsElsewhere
      ? planFailure(
          "VISUAL_TARGET_OWNER_MISMATCH",
          "The target check does not belong to the requested owner.",
        )
      : planFailure("VISUAL_TARGET_NOT_FOUND", "The target check was not found.");
  }
  if (target.injectedFrom) return protectedPartialTarget(graph, target.injectedFrom, "check");
  if (hasAmbiguousAnonymousCheck(owner.checks, target)) return anonymousIdentityFailure("check");
  if (command.kind === "DELETE_CHECK") return { ok: true, edits: [] };
  const desired = mergeCheck(target, command.changes);
  const value = validateCheckValue(desired, command.ownerColumnKey);
  if (!value.ok) return value;
  return validateCheckIdentity(owner.checks, desired, target.key);
}

function validateCheckValue(value: CheckValue, ownerColumnKey: string | null): EditPlan {
  if (ownerColumnKey !== null && value.name !== null) {
    return capabilityFailure("Pinned DBML v2 does not support names on column-owned checks.");
  }
  if (value.expression.includes("`")) {
    return unrepresentable("A check expression containing a backtick cannot be rendered safely.");
  }
  return { ok: true, edits: [] };
}

function validateCheckIdentity(
  checks: readonly CheckNode[],
  desired: CheckValue,
  excludedKey: SchemaElementKey | null,
): EditPlan {
  const others = checks.filter((check) => check.key !== excludedKey);
  if (desired.name !== null && others.some((check) => check.name === desired.name)) {
    return planFailure("VISUAL_NAME_CONFLICT", "A check with the requested name exists.");
  }
  if (
    desired.name === null &&
    others.some((check) => check.name === null && check.expression === desired.expression)
  ) {
    return anonymousIdentityFailure("check");
  }
  return { ok: true, edits: [] };
}

type CheckOwnerResult =
  | { ok: true; table: TableNode; column: ColumnNode | null; checks: CheckNode[] }
  | { ok: false; plan: EditPlan };

function resolveCheckOwner(
  graph: SchemaGraph,
  tableKey: SchemaElementKey,
  columnKey: SchemaElementKey | null,
): CheckOwnerResult {
  const table = graph.tables.find((candidate) => candidate.key === tableKey);
  if (!table) {
    return {
      ok: false,
      plan: planFailure("VISUAL_TARGET_NOT_FOUND", "The target table was not found."),
    };
  }
  if (columnKey === null) return { ok: true, table, column: null, checks: table.checks };
  const column = table.columns.find((candidate) => candidate.key === columnKey);
  if (!column) {
    const existsElsewhere = graph.tables.some((candidate) =>
      candidate.columns.some((item) => item.key === columnKey),
    );
    return {
      ok: false,
      plan: existsElsewhere
        ? planFailure(
            "VISUAL_TARGET_OWNER_MISMATCH",
            "The check owner column does not belong to the requested table.",
          )
        : planFailure("VISUAL_TARGET_NOT_FOUND", "The check owner column was not found."),
    };
  }
  if (column.injectedFrom) {
    return {
      ok: false,
      plan: protectedPartialTarget(graph, column.injectedFrom, "check owner column"),
    };
  }
  return { ok: true, table, column, checks: column.checks };
}

function isSemanticNoOp(graph: SchemaGraph, command: RelationshipIndexCheckVisualCommand): boolean {
  switch (command.kind) {
    case "UPDATE_REFERENCE": {
      const target = graph.references.find(
        (reference) => reference.key === command.targetReferenceKey,
      );
      return Boolean(
        target && referenceMatchesValue(target, mergeReference(target, command.changes)),
      );
    }
    case "UPDATE_INDEX": {
      const target = graph.tables
        .find((table) => table.key === command.targetTableKey)
        ?.indexes.find((index) => index.key === command.targetIndexKey);
      return Boolean(target && indexMatchesValue(target, mergeIndex(target, command.changes)));
    }
    case "UPDATE_CHECK": {
      const owner = resolveCheckOwner(graph, command.targetTableKey, command.ownerColumnKey);
      if (!owner.ok) return false;
      const target = owner.checks.find((check) => check.key === command.targetCheckKey);
      return Boolean(target && checkMatchesValue(target, mergeCheck(target, command.changes)));
    }
    default:
      return false;
  }
}

function planCommandEdits(
  source: string,
  graph: SchemaGraph,
  command: RelationshipIndexCheckVisualCommand,
): EditPlan {
  switch (command.kind) {
    case "CREATE_REFERENCE":
      return planCreateReference(source, graph, command.reference);
    case "UPDATE_REFERENCE":
      return planUpdateReference(
        source,
        graph,
        requireReference(graph, command.targetReferenceKey),
        command,
      );
    case "DELETE_REFERENCE":
      return planDeleteReference(
        source,
        graph,
        requireReference(graph, command.targetReferenceKey),
      );
    case "CREATE_INDEX":
      return insertTableBlockEntry(
        source,
        requireTable(graph, command.targetTableKey),
        "indexes",
        renderIndex(command.index, requireTable(graph, command.targetTableKey)),
      );
    case "UPDATE_INDEX":
      return planUpdateIndex(
        source,
        requireIndex(requireTable(graph, command.targetTableKey), command.targetIndexKey),
        requireTable(graph, command.targetTableKey),
        command,
      );
    case "DELETE_INDEX":
      return {
        ok: true,
        edits: [
          {
            ...lineSpanForRange(
              source,
              requireIndex(requireTable(graph, command.targetTableKey), command.targetIndexKey)
                .range,
            ),
            newText: "",
          },
        ],
      };
    case "CREATE_CHECK":
      return planCreateCheck(source, graph, command);
    case "UPDATE_CHECK":
      return planUpdateCheck(source, graph, command);
    case "DELETE_CHECK":
      return planDeleteCheck(source, graph, command);
  }
}

function planCreateReference(source: string, graph: SchemaGraph, value: ReferenceValue): EditPlan {
  return {
    ok: true,
    edits: [standaloneReferenceInsertion(source, graph, renderReference(value, graph))],
  };
}

function planUpdateReference(
  source: string,
  graph: SchemaGraph,
  target: ReferenceEdge,
  command: UpdateReferenceCommand,
): EditPlan {
  const desired = mergeReference(target, command.changes);
  const inline = findInlineReferenceContext(source, graph, target);
  if (inline) {
    if (canRemainInline(target, desired, inline.column.key)) {
      const localIndex = desired.endpoints.findIndex((endpoint) =>
        endpoint.columnKeys.includes(inline.column.key),
      );
      const local = desired.endpoints[localIndex];
      const remote = desired.endpoints[localIndex === 0 ? 1 : 0];
      if (!local || !remote)
        return invalidRange("The inline reference endpoints could not be resolved.");
      const replacement = `ref: ${relationshipOperator(local, remote)} ${renderEndpoint(graph, remote)}`;
      return rewriteInlineSetting(inline, replacement);
    }
    const removed = rewriteInlineSetting(inline, null);
    if (!removed.ok) return removed;
    return {
      ok: true,
      edits: [
        ...removed.edits,
        standaloneReferenceInsertion(source, graph, renderReference(desired, graph)),
      ],
    };
  }

  if (isBlockReference(source, target)) {
    return planUpdateBlockReference(source, graph, target, desired, command);
  }
  return {
    ok: true,
    edits: [
      {
        startOffset: target.range.startOffset,
        endOffset: target.range.endOffset,
        newText: renderReference(desired, graph),
      },
    ],
  };
}

function planDeleteReference(source: string, graph: SchemaGraph, target: ReferenceEdge): EditPlan {
  const inline = findInlineReferenceContext(source, graph, target);
  if (inline) return rewriteInlineSetting(inline, null);
  return {
    ok: true,
    edits: [{ ...lineSpanForRange(source, target.range), newText: "" }],
  };
}

interface InlineReferenceContext {
  column: ColumnNode;
  fragment: string;
  settings: NonNullable<ReturnType<typeof parseColumnDeclaration>>["settings"] & {};
  entryIndex: number;
}

function findInlineReferenceContext(
  source: string,
  graph: SchemaGraph,
  reference: ReferenceEdge,
): InlineReferenceContext | null {
  for (const table of graph.tables) {
    for (const column of table.columns) {
      if (
        reference.range.startOffset < column.range.startOffset ||
        reference.range.endOffset > column.range.endOffset
      ) {
        continue;
      }
      const fragment = source.slice(column.range.startOffset, column.range.endOffset);
      const declaration = parseColumnDeclaration(fragment);
      if (!declaration?.settings) return null;
      const entryIndex = declaration.settings.entries.findIndex(
        (entry) =>
          column.range.startOffset + entry.contentStart === reference.range.startOffset &&
          column.range.startOffset + entry.contentEnd === reference.range.endOffset,
      );
      if (entryIndex === -1) return null;
      return { column, fragment, settings: declaration.settings, entryIndex };
    }
  }
  return null;
}

function canRemainInline(
  before: ReferenceEdge,
  desired: ReferenceValue,
  ownerColumnKey: SchemaElementKey,
): boolean {
  if (
    desired.name !== null ||
    desired.onDelete !== null ||
    desired.onUpdate !== null ||
    desired.color !== null ||
    desired.inactive
  ) {
    return false;
  }
  const currentLocalIndex = before.endpoints.findIndex(
    (endpoint) => endpoint.columnKeys.length === 1 && endpoint.columnKeys[0] === ownerColumnKey,
  );
  const desiredLocalIndex = desired.endpoints.findIndex(
    (endpoint) => endpoint.columnKeys.length === 1 && endpoint.columnKeys[0] === ownerColumnKey,
  );
  return (
    currentLocalIndex !== -1 &&
    desiredLocalIndex === currentLocalIndex &&
    desired.endpoints.every((endpoint) => endpoint.columnKeys.length === 1)
  );
}

function rewriteInlineSetting(
  context: InlineReferenceContext,
  replacement: string | null,
): EditPlan {
  if (!context.settings)
    return invalidRange("The inline reference settings could not be resolved.");
  const rewritten = rewriteSettingOccurrence(
    context.fragment,
    context.settings,
    context.entryIndex,
    replacement,
  );
  if (rewritten === null) return invalidRange("The inline reference setting is ambiguous.");
  const edits = deriveMinimalTextEdits(
    context.fragment,
    rewritten,
    context.column.range.startOffset,
  );
  return edits
    ? { ok: true, edits }
    : invalidRange("The inline reference could not be patched safely.");
}

function planUpdateBlockReference(
  source: string,
  graph: SchemaGraph,
  target: ReferenceEdge,
  desired: ReferenceValue,
  command: UpdateReferenceCommand,
): EditPlan {
  const edits: TextEdit[] = [];
  if (command.changes.name !== undefined) {
    const headerEnd = lineEndOffset(source, target.range.startOffset, false);
    const header = source.slice(target.range.startOffset, headerEnd);
    const brace = findTopLevelCharacterAt(header, 0, "{");
    const tokens = identifierTokensInSpan(header, {
      startOffset: 0,
      endOffset: brace ?? header.length,
    });
    const keyword = tokens[0];
    if (brace === null || !keyword || keyword.value.toLowerCase() !== "ref") {
      return invalidRange("The block reference header could not be resolved.");
    }
    const nameToken = target.name === null ? null : tokens[1];
    if (desired.name === null) {
      if (!nameToken) return invalidRange("The block reference name could not be resolved.");
      edits.push({
        startOffset: target.range.startOffset + keyword.endOffset,
        endOffset: target.range.startOffset + brace,
        newText: " ",
      });
    } else if (nameToken) {
      edits.push({
        startOffset: target.range.startOffset + nameToken.startOffset,
        endOffset: target.range.startOffset + nameToken.endOffset,
        newText: renderIdentifier(
          desired.name,
          isQuotedIdentifier(header.slice(nameToken.startOffset, nameToken.endOffset)),
        ),
      });
    } else {
      edits.push({
        startOffset: target.range.startOffset + keyword.endOffset,
        endOffset: target.range.startOffset + keyword.endOffset,
        newText: ` ${renderIdentifier(desired.name)}`,
      });
    }
  }
  if (Object.keys(command.changes).some((key) => key !== "name")) {
    const startOffset = Math.min(...target.endpoints.map((endpoint) => endpoint.range.startOffset));
    const endOffset = referenceClauseEnd(source, target);
    edits.push({
      startOffset,
      endOffset,
      newText: renderReferenceClause(desired, graph),
    });
  }
  return { ok: true, edits };
}

function referenceClauseEnd(source: string, target: ReferenceEdge): number {
  const endpointEnd = Math.max(...target.endpoints.map((endpoint) => endpoint.range.endOffset));
  const lineEnd = lineEndOffset(source, endpointEnd, false);
  const tail = source.slice(endpointEnd, lineEnd);
  const bracket = findTopLevelCharacterAt(tail, 0, "[");
  if (bracket === null) return endpointEnd;
  const settings = parseSettingsBlockAt(tail, bracket);
  return settings ? endpointEnd + settings.endOffset : endpointEnd;
}

function standaloneReferenceInsertion(
  source: string,
  graph: SchemaGraph,
  rendered: string,
): TextEdit {
  const standalone = graph.references.filter(
    (reference) => findInlineReferenceContext(source, graph, reference) === null,
  );
  const last = standalone
    .toSorted((left, right) => left.range.endOffset - right.range.endOffset)
    .at(-1);
  const newline = detectNewline(source);
  if (last) {
    const offset = lineEndOffset(source, last.range.endOffset, true);
    return { startOffset: offset, endOffset: offset, newText: `${rendered}${newline}` };
  }
  const separator =
    source.length === 0 ? "" : source.endsWith(newline) ? newline : `${newline}${newline}`;
  return {
    startOffset: source.length,
    endOffset: source.length,
    newText: `${separator}${rendered}${newline}`,
  };
}

function renderReference(value: ReferenceValue, graph: SchemaGraph): string {
  const prefix = value.name === null ? "Ref:" : `Ref ${renderIdentifier(value.name)}:`;
  return `${prefix} ${renderReferenceClause(value, graph)}`;
}

function renderReferenceClause(value: ReferenceValue, graph: SchemaGraph): string {
  return `${renderEndpoint(graph, value.endpoints[0])} ${relationshipOperator(value.endpoints[0], value.endpoints[1])} ${renderEndpoint(graph, value.endpoints[1])}${renderReferenceSettings(value)}`;
}

function relationshipOperator(
  left: Pick<VisualReferenceEndpoint, "multiplicity">,
  right: Pick<VisualReferenceEndpoint, "multiplicity">,
): string {
  return getRelationshipOp(cardinality(left.multiplicity), cardinality(right.multiplicity));
}

function cardinality(value: VisualReferenceEndpoint["multiplicity"]): "1" | "0..1" | "*" | "0..*" {
  if (value.max === 1) return value.min === 0 ? "0..1" : "1";
  return value.min === 0 ? "0..*" : "*";
}

function renderEndpoint(graph: SchemaGraph, endpoint: ReferenceValue["endpoints"][number]): string {
  const table = requireTable(graph, endpoint.tableKey);
  const names = endpoint.columnKeys.map((key) => requireColumn(table, key).name);
  const tableName = `${renderIdentifier(table.schemaName)}.${renderIdentifier(table.name)}`;
  return names.length === 1
    ? `${tableName}.${renderIdentifier(names[0] ?? "")}`
    : `${tableName}.(${names.map((name) => renderIdentifier(name)).join(", ")})`;
}

function renderReferenceSettings(value: ReferenceValue): string {
  const settings: string[] = [];
  if (value.onDelete !== null) settings.push(`delete: ${value.onDelete}`);
  if (value.onUpdate !== null) settings.push(`update: ${value.onUpdate}`);
  if (value.color !== null) settings.push(`color: ${value.color}`);
  if (value.inactive) settings.push("inactive");
  return settings.length === 0 ? "" : ` [${settings.join(", ")}]`;
}

function isBlockReference(source: string, reference: ReferenceEdge): boolean {
  const firstEndpoint = Math.min(
    ...reference.endpoints.map((endpoint) => endpoint.range.startOffset),
  );
  return source.slice(reference.range.startOffset, firstEndpoint).includes("{");
}

function planUpdateIndex(
  source: string,
  target: IndexNode,
  table: TableNode,
  command: UpdateIndexCommand,
): EditPlan {
  const original = source.slice(target.range.startOffset, target.range.endOffset);
  let rewritten = original;
  let parsed = parseIndexDeclaration(rewritten);
  if (!parsed) return invalidRange("The target index declaration could not be resolved.");
  if (command.changes.terms !== undefined) {
    const terms = renderIndexTerms(command.changes.terms, table);
    rewritten = `${rewritten.slice(0, parsed.terms.startOffset)}${terms}${rewritten.slice(parsed.terms.endOffset)}`;
    parsed = parseIndexDeclaration(rewritten);
    if (!parsed) return invalidRange("The updated index terms could not be resolved.");
  }
  const mutations: Record<string, SettingMutation> = {};
  if (command.changes.primaryKey !== undefined) {
    mutations.pk = command.changes.primaryKey ? "pk" : null;
  }
  if (command.changes.unique !== undefined) {
    mutations.unique = command.changes.unique ? "unique" : null;
  }
  if (command.changes.name !== undefined) {
    mutations.name =
      command.changes.name === null ? null : stringMutation("name", command.changes.name);
  }
  if (command.changes.type !== undefined) {
    mutations.type =
      command.changes.type === null ? null : valueMutation("type", command.changes.type.trim());
  }
  if (command.changes.note !== undefined) {
    mutations.note =
      command.changes.note === null ? null : stringMutation("note", command.changes.note);
  }
  const withSettings = rewriteSettings(
    rewritten,
    parsed.settings,
    parsed.terms.endOffset,
    mutations,
  );
  if (withSettings === null) return invalidRange("Duplicate index settings are ambiguous.");
  const edits = deriveMinimalTextEdits(original, withSettings, target.range.startOffset);
  return edits ? { ok: true, edits } : invalidRange("The index could not be patched safely.");
}

function renderIndex(value: IndexValue, table: TableNode): string {
  const settings: string[] = [];
  if (value.primaryKey) settings.push("pk");
  if (value.unique) settings.push("unique");
  if (value.name !== null) settings.push(`name: ${renderDbmlString(value.name)}`);
  if (value.type !== null) settings.push(`type: ${value.type.trim()}`);
  if (value.note !== null) settings.push(`note: ${renderDbmlString(value.note)}`);
  return `${renderIndexTerms(value.terms, table)}${settings.length > 0 ? ` [${settings.join(", ")}]` : ""}`;
}

function renderIndexTerms(value: IndexValue["terms"], table: TableNode): string {
  const terms = value.map((term) =>
    term.kind === "COLUMN"
      ? renderIdentifier(requireColumn(table, term.columnKey).name)
      : `\`${term.expression}\``,
  );
  return terms.length === 1 ? (terms[0] ?? "") : `(${terms.join(", ")})`;
}

function parseIndexDeclaration(fragment: string): {
  terms: OffsetSpan;
  settings: ReturnType<typeof parseSettingsBlockAt>;
} | null {
  const bracket = findTopLevelCharacterAt(fragment, 0, "[");
  const end = trimEnd(fragment, 0, bracket ?? fragment.length);
  const start = trimStart(fragment, 0, end);
  if (start >= end) return null;
  const settings = bracket === null ? null : parseSettingsBlockAt(fragment, bracket);
  if (bracket !== null && !settings) return null;
  return { terms: { startOffset: start, endOffset: end }, settings };
}

function planCreateCheck(
  source: string,
  graph: SchemaGraph,
  command: CreateCheckCommand,
): EditPlan {
  const table = requireTable(graph, command.targetTableKey);
  if (command.ownerColumnKey === null) {
    return insertTableBlockEntry(source, table, "checks", renderCheck(command.check));
  }
  const column = requireColumn(table, command.ownerColumnKey);
  return appendColumnCheck(source, column, renderColumnCheck(command.check.expression));
}

function planUpdateCheck(
  source: string,
  graph: SchemaGraph,
  command: UpdateCheckCommand,
): EditPlan {
  const owner = resolveCheckOwner(graph, command.targetTableKey, command.ownerColumnKey);
  if (!owner.ok) return owner.plan;
  const target = owner.checks.find((check) => check.key === command.targetCheckKey);
  if (!target) return invalidRange("The target check could not be resolved.");
  const desired = mergeCheck(target, command.changes);
  if (owner.column) {
    return rewriteColumnCheck(source, owner.column, target, renderColumnCheck(desired.expression));
  }
  return rewriteTableCheck(source, target, desired);
}

function planDeleteCheck(
  source: string,
  graph: SchemaGraph,
  command: Extract<RelationshipIndexCheckVisualCommand, { kind: "DELETE_CHECK" }>,
): EditPlan {
  const owner = resolveCheckOwner(graph, command.targetTableKey, command.ownerColumnKey);
  if (!owner.ok) return owner.plan;
  const target = owner.checks.find((check) => check.key === command.targetCheckKey);
  if (!target) return invalidRange("The target check could not be resolved.");
  return owner.column
    ? rewriteColumnCheck(source, owner.column, target, null)
    : { ok: true, edits: [{ ...lineSpanForRange(source, target.range), newText: "" }] };
}

function appendColumnCheck(source: string, column: ColumnNode, setting: string): EditPlan {
  const original = source.slice(column.range.startOffset, column.range.endOffset);
  const declaration = parseColumnDeclaration(original);
  if (!declaration) return invalidRange("The check owner column could not be resolved.");
  let rewritten: string;
  if (!declaration.settings) {
    rewritten = `${original.slice(0, declaration.typeSpan.endOffset)} [${setting}]${original.slice(declaration.typeSpan.endOffset)}`;
  } else {
    const closing = declaration.settings.endOffset - 1;
    let insertion = closing;
    while (
      insertion > declaration.settings.startOffset &&
      /\s/u.test(original[insertion - 1] ?? "")
    ) {
      insertion -= 1;
    }
    const prefix = declaration.settings.entries.length > 0 ? ", " : "";
    rewritten = `${original.slice(0, insertion)}${prefix}${setting}${original.slice(insertion)}`;
  }
  const edits = deriveMinimalTextEdits(original, rewritten, column.range.startOffset);
  return edits
    ? { ok: true, edits }
    : invalidRange("The column check could not be inserted safely.");
}

function rewriteColumnCheck(
  source: string,
  column: ColumnNode,
  check: CheckNode,
  replacement: string | null,
): EditPlan {
  const original = source.slice(column.range.startOffset, column.range.endOffset);
  const declaration = parseColumnDeclaration(original);
  if (!declaration?.settings)
    return invalidRange("The column check settings could not be resolved.");
  const entryIndex = declaration.settings.entries.findIndex(
    (entry) =>
      column.range.startOffset + entry.contentStart === check.range.startOffset &&
      column.range.startOffset + entry.contentEnd === check.range.endOffset,
  );
  if (entryIndex === -1) return invalidRange("The target column check occurrence was not found.");
  const rewritten = rewriteSettingOccurrence(
    original,
    declaration.settings,
    entryIndex,
    replacement,
  );
  if (rewritten === null) return invalidRange("The target column check is ambiguous.");
  const edits = deriveMinimalTextEdits(original, rewritten, column.range.startOffset);
  return edits
    ? { ok: true, edits }
    : invalidRange("The column check could not be patched safely.");
}

function rewriteTableCheck(source: string, target: CheckNode, desired: CheckValue): EditPlan {
  const original = source.slice(target.range.startOffset, target.range.endOffset);
  const expressionEnd = quotedExpressionEnd(original);
  if (expressionEnd === null)
    return invalidRange("The table check expression could not be resolved.");
  let rewritten = `\`${desired.expression}\`${original.slice(expressionEnd)}`;
  const bracket = findTopLevelCharacterAt(rewritten, 0, "[");
  const settings = bracket === null ? null : parseSettingsBlockAt(rewritten, bracket);
  const mutations: Record<string, SettingMutation> = {
    name: desired.name === null ? null : stringMutation("name", desired.name),
  };
  const withSettings = rewriteSettings(
    rewritten,
    settings,
    quotedExpressionEnd(rewritten) ?? 0,
    mutations,
  );
  if (withSettings === null) return invalidRange("Duplicate check settings are ambiguous.");
  rewritten = withSettings;
  const edits = deriveMinimalTextEdits(original, rewritten, target.range.startOffset);
  return edits ? { ok: true, edits } : invalidRange("The table check could not be patched safely.");
}

function renderCheck(value: CheckValue): string {
  return `\`${value.expression}\`${value.name === null ? "" : ` [name: ${renderDbmlString(value.name)}]`}`;
}

function renderColumnCheck(expression: string): string {
  return `check: \`${expression}\``;
}

function insertTableBlockEntry(
  source: string,
  table: TableNode,
  blockName: "indexes" | "checks",
  entry: string,
): EditPlan {
  const fragment = source.slice(table.range.startOffset, table.range.endOffset);
  const block = findDirectChildBlock(fragment, blockName);
  const newline = detectNewline(source, table.range.startOffset, table.range.endOffset);
  const tableIndent = lineIndentAt(source, table.range.startOffset) ?? "";
  const childIndent = inferTableChildIndent(source, table) ?? `${tableIndent}  `;
  if (block) {
    const close = table.range.startOffset + block.closeBraceOffset;
    const insertionOffset = lineStartOffset(source, close);
    const existing = blockName === "indexes" ? table.indexes : table.checks;
    const entryIndent = existing[0]
      ? (lineIndentAt(source, existing[0].range.startOffset) ?? `${childIndent}  `)
      : `${lineIndentAt(source, table.range.startOffset + block.keywordStart) ?? childIndent}  `;
    return {
      ok: true,
      edits: [
        {
          startOffset: insertionOffset,
          endOffset: insertionOffset,
          newText: `${entryIndent}${entry}${newline}`,
        },
      ],
    };
  }

  const closingBrace = table.range.endOffset - 1;
  if (source[closingBrace] !== "}") return invalidRange("The target table has no closing brace.");
  const otherBlock = blockName === "indexes" ? findDirectChildBlock(fragment, "checks") : null;
  const noteAnchor = sourceOwnedTableNoteAnchor(source, table, closingBrace);
  const anchor = otherBlock
    ? table.range.startOffset + otherBlock.keywordStart
    : (noteAnchor ?? closingBrace);
  const insertionOffset = lineStartOffset(source, anchor);
  const blockText = `${childIndent}${blockName} {${newline}${childIndent}  ${entry}${newline}${childIndent}}${newline}`;
  return {
    ok: true,
    edits: [{ startOffset: insertionOffset, endOffset: insertionOffset, newText: blockText }],
  };
}

function sourceOwnedTableNoteAnchor(
  source: string,
  table: TableNode,
  closingBrace: number,
): number | null {
  if (!table.note) return null;
  const start = lineStartOffset(source, table.note.range.startOffset);
  if (start <= table.range.startOffset || start >= closingBrace) return null;
  const line = source.slice(start, lineEndOffset(source, start, false)).trimStart();
  return /^Note\s*:/u.test(line) ? start : null;
}

function inferTableChildIndent(source: string, table: TableNode): string | null {
  const noteAnchor = sourceOwnedTableNoteAnchor(source, table, table.range.endOffset - 1);
  const candidates = [
    ...table.columns.map((column) => column.injectedFrom?.injectionRange ?? column.range),
    ...table.indexes.map((index) => index.range),
    ...table.checks.map((check) => check.range),
    ...(noteAnchor === null ? [] : [{ startOffset: noteAnchor, endOffset: noteAnchor }]),
  ].toSorted((left, right) => left.startOffset - right.startOffset);
  for (const candidate of candidates) {
    const indent = lineIndentAt(source, candidate.startOffset);
    if (indent !== null) return indent;
  }
  return null;
}

function verifyCommandSemantics(
  before: SchemaGraph,
  after: SchemaGraph,
  command: RelationshipIndexCheckVisualCommand,
  diff: SchemaGraphDiff,
): boolean {
  if (diff.renameCandidates.length !== 0) return false;
  switch (command.kind) {
    case "CREATE_REFERENCE": {
      const target = uniqueMatch(after.references, (reference) =>
        referenceMatchesValue(reference, command.reference),
      );
      return Boolean(target && verifyCreate(diff.changes, "reference", target.key));
    }
    case "UPDATE_REFERENCE": {
      const beforeTarget = before.references.find(
        (reference) => reference.key === command.targetReferenceKey,
      );
      if (!beforeTarget) return false;
      const desired = mergeReference(beforeTarget, command.changes);
      const afterTarget = uniqueMatch(after.references, (reference) =>
        referenceMatchesValue(reference, desired),
      );
      return Boolean(
        afterTarget && verifyUpdate(diff.changes, "reference", beforeTarget.key, afterTarget.key),
      );
    }
    case "DELETE_REFERENCE":
      return verifyDelete(diff.changes, "reference", command.targetReferenceKey);
    case "CREATE_INDEX": {
      const table = after.tables.find((candidate) => candidate.key === command.targetTableKey);
      const target = table
        ? uniqueMatch(table.indexes, (index) => indexMatchesValue(index, command.index))
        : null;
      return Boolean(target && verifyCreate(diff.changes, "index", target.key));
    }
    case "UPDATE_INDEX": {
      const beforeTable = before.tables.find((table) => table.key === command.targetTableKey);
      const afterTable = after.tables.find((table) => table.key === command.targetTableKey);
      const beforeTarget = beforeTable?.indexes.find(
        (index) => index.key === command.targetIndexKey,
      );
      if (!beforeTarget || !afterTable) return false;
      const desired = mergeIndex(beforeTarget, command.changes);
      const afterTarget = uniqueMatch(afterTable.indexes, (index) =>
        indexMatchesValue(index, desired),
      );
      return Boolean(
        afterTarget && verifyUpdate(diff.changes, "index", beforeTarget.key, afterTarget.key),
      );
    }
    case "DELETE_INDEX":
      return verifyDelete(diff.changes, "index", command.targetIndexKey);
    case "CREATE_CHECK": {
      const owner = resolveCheckOwner(after, command.targetTableKey, command.ownerColumnKey);
      const target = owner.ok
        ? uniqueMatch(owner.checks, (check) => checkMatchesValue(check, command.check))
        : null;
      return Boolean(target && verifyCreate(diff.changes, "check", target.key));
    }
    case "UPDATE_CHECK": {
      const beforeOwner = resolveCheckOwner(before, command.targetTableKey, command.ownerColumnKey);
      const afterOwner = resolveCheckOwner(after, command.targetTableKey, command.ownerColumnKey);
      if (!beforeOwner.ok || !afterOwner.ok) return false;
      const beforeTarget = beforeOwner.checks.find((check) => check.key === command.targetCheckKey);
      if (!beforeTarget) return false;
      const desired = mergeCheck(beforeTarget, command.changes);
      const afterTarget = uniqueMatch(afterOwner.checks, (check) =>
        checkMatchesValue(check, desired),
      );
      return Boolean(
        afterTarget && verifyUpdate(diff.changes, "check", beforeTarget.key, afterTarget.key),
      );
    }
    case "DELETE_CHECK":
      return verifyDelete(diff.changes, "check", command.targetCheckKey);
  }
}

function verifyCreate(
  changes: readonly SchemaElementChange[],
  kind: "reference" | "index" | "check",
  key: SchemaElementKey,
): boolean {
  return (
    changes.length === 1 &&
    changes[0]?.operation === "ADD" &&
    changes[0].elementKind === kind &&
    changes[0].key === key
  );
}

function verifyDelete(
  changes: readonly SchemaElementChange[],
  kind: "reference" | "index" | "check",
  key: SchemaElementKey,
): boolean {
  return (
    changes.length === 1 &&
    changes[0]?.operation === "DELETE" &&
    changes[0].elementKind === kind &&
    changes[0].key === key
  );
}

function verifyUpdate(
  changes: readonly SchemaElementChange[],
  kind: "reference" | "index" | "check",
  beforeKey: SchemaElementKey,
  afterKey: SchemaElementKey,
): boolean {
  if (beforeKey === afterKey) {
    return (
      changes.length === 1 &&
      changes[0]?.operation === "UPDATE" &&
      changes[0].elementKind === kind &&
      changes[0].key === beforeKey
    );
  }
  return (
    changes.length === 2 &&
    changes.some(
      (change) =>
        change.operation === "DELETE" && change.elementKind === kind && change.key === beforeKey,
    ) &&
    changes.some(
      (change) =>
        change.operation === "ADD" && change.elementKind === kind && change.key === afterKey,
    )
  );
}

function mergeReference(
  target: ReferenceEdge,
  changes: UpdateReferenceCommand["changes"],
): ReferenceValue {
  return {
    schemaName: target.schemaName,
    name: changes.name === undefined ? target.name : changes.name,
    endpoints:
      changes.endpoints ??
      (target.endpoints.map(stripEndpointRange) as ReferenceValue["endpoints"]),
    onDelete: changes.onDelete === undefined ? target.onDelete : changes.onDelete,
    onUpdate: changes.onUpdate === undefined ? target.onUpdate : changes.onUpdate,
    color: changes.color === undefined ? target.color : changes.color,
    inactive: changes.inactive === undefined ? target.inactive : changes.inactive,
  } as ReferenceValue;
}

function stripEndpointRange(endpoint: ReferenceEdge["endpoints"][number]): VisualReferenceEndpoint {
  return {
    tableKey: endpoint.tableKey,
    columnKeys: [...endpoint.columnKeys],
    multiplicity: { ...endpoint.multiplicity } as VisualReferenceEndpoint["multiplicity"],
  };
}

function mergeIndex(target: IndexNode, changes: UpdateIndexCommand["changes"]): IndexValue {
  return {
    name: changes.name === undefined ? target.name : changes.name,
    terms:
      changes.terms ??
      target.terms.map((term) =>
        term.kind === "COLUMN"
          ? { kind: "COLUMN" as const, columnKey: term.columnKey }
          : { kind: "EXPRESSION" as const, expression: term.expression },
      ),
    type: changes.type === undefined ? target.type : changes.type,
    unique: changes.unique === undefined ? target.unique : changes.unique,
    primaryKey: changes.primaryKey === undefined ? target.primaryKey : changes.primaryKey,
    note: changes.note === undefined ? (target.note?.value ?? null) : changes.note,
  } as IndexValue;
}

function mergeCheck(target: CheckNode, changes: UpdateCheckCommand["changes"]): CheckValue {
  return {
    name: changes.name === undefined ? target.name : changes.name,
    expression: changes.expression === undefined ? target.expression : changes.expression,
  };
}

function referenceMatchesValue(reference: ReferenceEdge, value: ReferenceValue): boolean {
  return (
    reference.schemaName === value.schemaName &&
    reference.name === value.name &&
    sameReferenceEndpoints(reference.endpoints, value.endpoints) &&
    reference.onDelete === value.onDelete &&
    reference.onUpdate === value.onUpdate &&
    reference.color === value.color &&
    reference.inactive === value.inactive &&
    reference.injectedFrom === null
  );
}

function sameReferenceIdentity(reference: ReferenceEdge, value: ReferenceValue): boolean {
  return (
    sameReferenceEndpoints(reference.endpoints, value.endpoints) &&
    reference.onDelete === value.onDelete &&
    reference.onUpdate === value.onUpdate &&
    reference.inactive === value.inactive
  );
}

function sameReferenceEndpoints(
  left: readonly ReferenceEdge["endpoints"][number][],
  right: readonly ReferenceValue["endpoints"][number][],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (endpoint, index) =>
        endpoint.tableKey === right[index]?.tableKey &&
        arraysEqual(endpoint.columnKeys, right[index]?.columnKeys ?? []) &&
        endpoint.multiplicity.min === right[index]?.multiplicity.min &&
        endpoint.multiplicity.max === right[index]?.multiplicity.max,
    )
  );
}

function indexMatchesValue(index: IndexNode, value: IndexValue): boolean {
  return (
    index.name === value.name &&
    index.type === normalizedIndexType(value.type) &&
    index.unique === value.unique &&
    index.primaryKey === value.primaryKey &&
    (index.note?.value ?? null) === value.note &&
    index.injectedFrom === null &&
    index.terms.length === value.terms.length &&
    index.terms.every((term, position) => {
      const expected = value.terms[position];
      return term.kind === "COLUMN"
        ? expected?.kind === "COLUMN" && term.columnKey === expected.columnKey
        : expected?.kind === "EXPRESSION" && term.expression === expected.expression;
    })
  );
}

function sameIndexIdentity(index: IndexNode, value: IndexValue): boolean {
  return (
    index.type === normalizedIndexType(value.type) &&
    index.unique === value.unique &&
    index.primaryKey === value.primaryKey &&
    index.terms.length === value.terms.length &&
    index.terms.every((term, position) => {
      const expected = value.terms[position];
      return term.kind === "COLUMN"
        ? expected?.kind === "COLUMN" && term.columnKey === expected.columnKey
        : expected?.kind === "EXPRESSION" && term.expression === expected.expression;
    })
  );
}

function checkMatchesValue(check: CheckNode, value: CheckValue): boolean {
  return (
    check.name === value.name &&
    check.expression === value.expression &&
    check.injectedFrom === null
  );
}

function hasAmbiguousAnonymousIndex(table: TableNode, target: IndexNode): boolean {
  return (
    target.name === null &&
    table.indexes.filter(
      (index) => index.name === null && sameIndexIdentity(index, graphIndexValue(target)),
    ).length > 1
  );
}

function hasAmbiguousAnonymousCheck(checks: readonly CheckNode[], target: CheckNode): boolean {
  return (
    target.name === null &&
    checks.filter((check) => check.name === null && check.expression === target.expression).length >
      1
  );
}

function graphIndexValue(index: IndexNode): IndexValue {
  return mergeIndex(index, {});
}

function normalizedIndexType(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  try {
    const decoded = JSON.parse(trimmed);
    return typeof decoded === "string" ? decoded : trimmed;
  } catch {
    return trimmed;
  }
}

function isRepresentableIndexType(value: string): boolean {
  const trimmed = value.trim();
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(trimmed)) return true;
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return false;
  try {
    return typeof JSON.parse(trimmed) === "string";
  } catch {
    return false;
  }
}

function allChecks(graph: SchemaGraph): CheckNode[] {
  return graph.tables.flatMap((table) => [
    ...table.checks,
    ...table.columns.flatMap((column) => column.checks),
  ]);
}

function requireTable(graph: SchemaGraph, key: SchemaElementKey): TableNode {
  const table = graph.tables.find((candidate) => candidate.key === key);
  if (!table) throw new Error(`Preflight invariant violated for table ${key}`);
  return table;
}

function requireColumn(table: TableNode, key: SchemaElementKey): ColumnNode {
  const column = table.columns.find((candidate) => candidate.key === key);
  if (!column) throw new Error(`Preflight invariant violated for column ${key}`);
  return column;
}

function requireReference(graph: SchemaGraph, key: SchemaElementKey): ReferenceEdge {
  const reference = graph.references.find((candidate) => candidate.key === key);
  if (!reference) throw new Error(`Preflight invariant violated for reference ${key}`);
  return reference;
}

function requireIndex(table: TableNode, key: SchemaElementKey): IndexNode {
  const index = table.indexes.find((candidate) => candidate.key === key);
  if (!index) throw new Error(`Preflight invariant violated for index ${key}`);
  return index;
}

function valueMutation(key: string, value: string): ExistingSettingMutation {
  return { create: `${key}: ${value}`, update: (entry) => replaceSettingValue(entry, value) };
}

function stringMutation(key: string, value: string): ExistingSettingMutation {
  return {
    create: `${key}: ${renderDbmlString(value)}`,
    update: (entry: ParsedSetting) => {
      const existing = settingValueSource(entry);
      return existing === null
        ? null
        : replaceSettingValue(entry, renderDbmlStringWithStyle(value, existing));
    },
  };
}

function capabilityFailure(message: string): EditPlan {
  return planFailure("VISUAL_CAPABILITY_UNSUPPORTED", message);
}

function anonymousIdentityFailure(kind: string): EditPlan {
  return planFailure(
    "VISUAL_ANONYMOUS_IDENTITY_AMBIGUOUS",
    `The anonymous ${kind} identity is ambiguous and must be edited in source.`,
  );
}

function unrepresentable(message: string): EditPlan {
  return planFailure("VISUAL_VALUE_UNREPRESENTABLE", message);
}

function uniqueMatch<T>(values: readonly T[], predicate: (value: T) => boolean): T | null {
  const matches = values.filter(predicate);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function quotedExpressionEnd(value: string): number | null {
  if (value[0] !== "`") return null;
  const end = value.indexOf("`", 1);
  return end === -1 ? null : end + 1;
}

function identifierTokensInSpan(source: string, range: OffsetSpan) {
  const tokens: Array<OffsetSpan & { value: string }> = [];
  let cursor = range.startOffset;
  while (cursor < range.endOffset) {
    const char = source[cursor] ?? "";
    if (char === '"') {
      let end = cursor + 1;
      let escaped = false;
      while (end < range.endOffset) {
        const next = source[end] ?? "";
        if (!escaped && next === '"') break;
        escaped = !escaped && next === "\\";
        if (next !== "\\") escaped = false;
        end += 1;
      }
      if (end >= range.endOffset) return tokens;
      const raw = source.slice(cursor, end + 1);
      let value = raw.slice(1, -1);
      try {
        value = JSON.parse(raw) as string;
      } catch {
        // Keep the raw decoded fallback; full reparse remains authoritative.
      }
      tokens.push({ startOffset: cursor, endOffset: end + 1, value });
      cursor = end + 1;
      continue;
    }
    if (/[A-Za-z0-9_$\p{L}\p{N}]/u.test(char)) {
      const start = cursor;
      cursor += 1;
      while (cursor < range.endOffset && /[A-Za-z0-9_$\p{L}\p{N}]/u.test(source[cursor] ?? "")) {
        cursor += 1;
      }
      tokens.push({ startOffset: start, endOffset: cursor, value: source.slice(start, cursor) });
      continue;
    }
    cursor += 1;
  }
  return tokens;
}

function trimStart(value: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end && /\s/u.test(value[cursor] ?? "")) cursor += 1;
  return cursor;
}

function trimEnd(value: string, start: number, end: number): number {
  let cursor = end;
  while (cursor > start && /\s/u.test(value[cursor - 1] ?? "")) cursor -= 1;
  return cursor;
}
