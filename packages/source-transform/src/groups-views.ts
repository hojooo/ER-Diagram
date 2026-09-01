import { type DiagramViewSyncOperation, syncDiagramView } from "@dbml/core";
import type { VisualCommand } from "@er-diagram/contracts";
import {
  type DiagramViewNode,
  qualifiedElementKey,
  type SchemaElementKey,
  type SchemaGraph,
  type SchemaGraphDiff,
  type TableGroupNode,
} from "@er-diagram/core";
import {
  deriveMinimalTextEdits,
  detectNewline,
  findDirectChildBlock,
  findTopLevelCharacterAt,
  lineEndOffset,
  lineIndentAt,
  lineStartOffset,
  type OffsetSpan,
  type ParsedDirectChildBlock,
  renderIdentifier,
} from "./dbml-fragment.js";
import { applyTextEdits } from "./text-edits.js";
import type { TextEdit, VisualSourceTransformResult } from "./types.js";
import {
  type EditPlan,
  invalidRange,
  planFailure,
  runVerifiedVisualTransform,
} from "./verified-transform.js";

type GroupViewCommandKind = "UPDATE_GROUP_MEMBERSHIP" | "UPDATE_DIAGRAM_VIEW";

export type GroupViewVisualCommand = Extract<VisualCommand, { kind: GroupViewCommandKind }>;

const SUPPORTED_KINDS = new Set<VisualCommand["kind"]>([
  "UPDATE_GROUP_MEMBERSHIP",
  "UPDATE_DIAGRAM_VIEW",
]);

type UpdateGroupMembershipCommand = Extract<
  GroupViewVisualCommand,
  { kind: "UPDATE_GROUP_MEMBERSHIP" }
>;
type UpdateDiagramViewCommand = Extract<GroupViewVisualCommand, { kind: "UPDATE_DIAGRAM_VIEW" }>;

type ViewFilterField = keyof UpdateDiagramViewCommand["changes"];

interface FilterItem extends OffsetSpan {
  identity: string;
  wildcard: boolean;
}

interface ViewFilterSpec {
  field: ViewFilterField;
  keyword: "Tables" | "Notes" | "TableGroups" | "Schemas";
  order: number;
  current: (view: DiagramViewNode) => string[] | null;
  resolveIdentity: (
    segments: readonly string[],
    graph: SchemaGraph,
    view: DiagramViewNode,
  ) => string | null;
  renderIdentity: (identity: string, graph: SchemaGraph, view: DiagramViewNode) => string | null;
}

const VIEW_FILTER_SPECS: readonly ViewFilterSpec[] = [
  {
    field: "visibleTableKeys",
    keyword: "Tables",
    order: 0,
    current: (view) => view.visibleTableKeys,
    resolveIdentity: (segments) => {
      if (segments.length === 1) return qualifiedElementKey("table", "public", segments[0] ?? "");
      if (segments.length === 2) {
        return qualifiedElementKey("table", segments[0] ?? "", segments[1] ?? "");
      }
      return null;
    },
    renderIdentity: (identity, graph) => {
      const table = graph.tables.find((candidate) => candidate.key === identity);
      return table ? `${renderIdentifier(table.schemaName)}.${renderIdentifier(table.name)}` : null;
    },
  },
  {
    field: "visibleNoteKeys",
    keyword: "Notes",
    order: 1,
    current: (view) => view.visibleNoteKeys,
    resolveIdentity: (segments) =>
      segments.length === 1 ? qualifiedElementKey("note", segments[0] ?? "") : null,
    renderIdentity: (identity, graph) => {
      const note = graph.notes.find((candidate) => candidate.key === identity);
      return note ? renderIdentifier(note.name) : null;
    },
  },
  {
    field: "visibleGroupKeys",
    keyword: "TableGroups",
    order: 2,
    current: (view) => view.visibleGroupKeys,
    resolveIdentity: (segments, _graph, view) =>
      segments.length === 1
        ? qualifiedElementKey("group", view.schemaName ?? "public", segments[0] ?? "")
        : null,
    renderIdentity: (identity, graph) => {
      const group = graph.groups.find((candidate) => candidate.key === identity);
      return group ? renderIdentifier(group.name) : null;
    },
  },
  {
    field: "visibleSchemaNames",
    keyword: "Schemas",
    order: 3,
    current: (view) => view.visibleSchemaNames,
    resolveIdentity: (segments) => (segments.length === 1 ? (segments[0] ?? null) : null),
    renderIdentity: (identity) => renderIdentifier(identity),
  },
];

export async function transformGroupViewCommand(
  source: string,
  command: GroupViewVisualCommand,
  filepath = "/main.dbml",
): Promise<VisualSourceTransformResult> {
  return runVerifiedVisualTransform(source, command, filepath, {
    supportedKinds: SUPPORTED_KINDS,
    unsupportedKindMessage: "This source transformer only supports group and view commands.",
    preflight: preflightCommand,
    isSemanticNoOp,
    planEdits: planCommandEdits,
    verifySemantics: verifyCommandSemantics,
  });
}

function preflightCommand(graph: SchemaGraph, command: GroupViewVisualCommand): EditPlan {
  if (command.kind === "UPDATE_GROUP_MEMBERSHIP") {
    const group = graph.groups.find((candidate) => candidate.key === command.targetGroupKey);
    if (!group)
      return planFailure("VISUAL_TARGET_NOT_FOUND", "The target TableGroup was not found.");
    for (const key of [...command.addTableKeys, ...command.removeTableKeys]) {
      if (!graph.tables.some((table) => table.key === key)) {
        return planFailure("VISUAL_TARGET_NOT_FOUND", "A TableGroup member table was not found.");
      }
    }
    if (
      command.addTableKeys.some((key) => group.tableKeys.includes(key)) ||
      command.removeTableKeys.some((key) => !group.tableKeys.includes(key))
    ) {
      return planFailure(
        "VISUAL_MEMBERSHIP_CONFLICT",
        "The TableGroup membership delta conflicts with the current source state.",
      );
    }
    if (
      command.addTableKeys.some((key) =>
        graph.groups.some(
          (candidate) => candidate.key !== group.key && candidate.tableKeys.includes(key),
        ),
      )
    ) {
      return planFailure(
        "VISUAL_MEMBERSHIP_CONFLICT",
        "A table cannot be added because it already belongs to another TableGroup.",
      );
    }
    return { ok: true, edits: [] };
  }

  const view = graph.views.find((candidate) => candidate.key === command.targetViewKey);
  if (!view) return planFailure("VISUAL_TARGET_NOT_FOUND", "The target DiagramView was not found.");
  for (const spec of VIEW_FILTER_SPECS) {
    const desired = command.changes[spec.field];
    if (desired === undefined || desired === null) continue;
    for (const identity of desired) {
      if (!filterIdentityExists(graph, spec.field, identity)) {
        return planFailure(
          "VISUAL_TARGET_NOT_FOUND",
          `A ${spec.keyword} filter target was not found.`,
        );
      }
    }
  }
  return { ok: true, edits: [] };
}

function filterIdentityExists(
  graph: SchemaGraph,
  field: ViewFilterField,
  identity: string,
): boolean {
  switch (field) {
    case "visibleTableKeys":
      return graph.tables.some((table) => table.key === identity);
    case "visibleNoteKeys":
      return graph.notes.some((note) => note.key === identity);
    case "visibleGroupKeys":
      return graph.groups.some((group) => group.key === identity);
    case "visibleSchemaNames":
      return schemaNames(graph).has(identity);
  }
}

function schemaNames(graph: SchemaGraph): Set<string> {
  return new Set([
    ...graph.tables.map((table) => table.schemaName),
    ...graph.enums.map((item) => item.schemaName),
    ...graph.groups.map((group) => group.schemaName),
  ]);
}

function isSemanticNoOp(graph: SchemaGraph, command: GroupViewVisualCommand): boolean {
  if (command.kind === "UPDATE_GROUP_MEMBERSHIP") return false;
  const view = graph.views.find((candidate) => candidate.key === command.targetViewKey);
  if (!view) return false;
  return VIEW_FILTER_SPECS.every((spec) => {
    const desired = command.changes[spec.field];
    return desired === undefined || sameTriState(spec.current(view), desired);
  });
}

function planCommandEdits(
  source: string,
  graph: SchemaGraph,
  command: GroupViewVisualCommand,
): EditPlan {
  return command.kind === "UPDATE_GROUP_MEMBERSHIP"
    ? planGroupMembership(source, graph, command)
    : planDiagramView(source, graph, command);
}

function planGroupMembership(
  source: string,
  graph: SchemaGraph,
  command: UpdateGroupMembershipCommand,
): EditPlan {
  const group = requireGroup(graph, command.targetGroupKey);
  const parsed = parseGroupMemberships(source, group);
  if (!parsed.ok) return invalidRange(parsed.message);

  const current = parsed.members.map((member) => member.tableKey).toSorted(compareCodeUnits);
  if (!arraysEqual(current, [...group.tableKeys].toSorted(compareCodeUnits))) {
    return invalidRange("The TableGroup source membership does not match the normalized graph.");
  }

  const edits: TextEdit[] = [];
  for (const key of command.removeTableKeys) {
    const member = parsed.members.find((candidate) => candidate.tableKey === key);
    if (!member) return invalidRange("A TableGroup membership declaration could not be resolved.");
    edits.push({ startOffset: member.lineStart, endOffset: member.lineEnd, newText: "" });
  }

  if (command.addTableKeys.length > 0) {
    const newline = detectNewline(source, group.range.startOffset, group.range.endOffset);
    const indent =
      parsed.members[0]?.indent ??
      (group.note ? lineIndentAt(source, group.note.range.startOffset) : null) ??
      `${lineIndentAt(source, group.range.startOffset) ?? ""}  `;
    const anchor = group.note?.range.startOffset ?? parsed.closeBraceOffset;
    const insertionOffset = lineStartOffset(source, anchor);
    const newText = command.addTableKeys
      .toSorted(compareCodeUnits)
      .map((key) => {
        const table = requireTable(graph, key);
        return `${indent}${renderIdentifier(table.schemaName)}.${renderIdentifier(table.name)}${newline}`;
      })
      .join("");
    edits.push({ startOffset: insertionOffset, endOffset: insertionOffset, newText });
  }
  return { ok: true, edits };
}

type ParsedGroupMemberships =
  | {
      ok: true;
      closeBraceOffset: number;
      members: Array<{
        tableKey: SchemaElementKey;
        lineStart: number;
        lineEnd: number;
        indent: string;
      }>;
    }
  | { ok: false; message: string };

function parseGroupMemberships(source: string, group: TableGroupNode): ParsedGroupMemberships {
  const fragment = source.slice(group.range.startOffset, group.range.endOffset);
  const openBrace = findTopLevelCharacterAt(fragment, 0, "{");
  const closeBrace = fragment.length - 1;
  if (openBrace === null || fragment[closeBrace] !== "}") {
    return { ok: false, message: "The TableGroup braces could not be resolved." };
  }

  const members: Extract<ParsedGroupMemberships, { ok: true }>["members"] = [];
  const seen = new Set<string>();
  let cursor = group.range.startOffset + openBrace + 1;
  const bodyEnd = group.range.startOffset + closeBrace;
  let blockComment = false;
  while (cursor < bodyEnd) {
    const lineStart = cursor;
    const lineEndWithoutBreak = lineEndOffset(source, cursor, false);
    const lineEnd = lineEndOffset(source, cursor, true);
    const overlapsNote = Boolean(
      group.note &&
        lineStart < group.note.range.endOffset &&
        lineEndWithoutBreak > group.note.range.startOffset,
    );
    const rawLine = source.slice(lineStart, Math.min(lineEndWithoutBreak, bodyEnd));
    const stripped = stripComments(rawLine, blockComment);
    blockComment = stripped.blockComment;
    if (!overlapsNote && stripped.text.trim().length > 0) {
      const parsedName = parseQualifiedIdentifier(stripped.text);
      if (!parsedName) {
        return { ok: false, message: "A TableGroup membership line is ambiguous." };
      }
      const schemaName =
        parsedName.segments.length === 2 ? parsedName.segments[0] : group.schemaName;
      const tableName = parsedName.segments.at(-1);
      if (!schemaName || !tableName) {
        return { ok: false, message: "A TableGroup membership name is incomplete." };
      }
      const tableKey = qualifiedElementKey("table", schemaName, tableName);
      if (seen.has(tableKey)) {
        return { ok: false, message: "A TableGroup membership appears more than once." };
      }
      seen.add(tableKey);
      members.push({
        tableKey,
        lineStart,
        lineEnd: Math.min(lineEnd, bodyEnd),
        indent: rawLine.match(/^[\t ]*/u)?.[0] ?? "",
      });
    }
    cursor = Math.max(lineEnd, cursor + 1);
  }
  if (blockComment) return { ok: false, message: "An unterminated TableGroup comment was found." };
  return { ok: true, closeBraceOffset: bodyEnd, members };
}

function planDiagramView(
  source: string,
  graph: SchemaGraph,
  command: UpdateDiagramViewCommand,
): EditPlan {
  const view = requireView(graph, command.targetViewKey);
  const originalFragment = source.slice(view.range.startOffset, view.range.endOffset);
  const desiredState = Object.fromEntries(
    VIEW_FILTER_SPECS.map((spec) => [
      spec.field,
      command.changes[spec.field] === undefined ? spec.current(view) : command.changes[spec.field],
    ]),
  ) as Record<ViewFilterField, string[] | null>;

  for (const spec of VIEW_FILTER_SPECS) {
    const validation = validateViewFilterSource(originalFragment, graph, view, spec);
    if (!validation.ok) return invalidRange(validation.message);
  }

  let rewritten = originalFragment;
  for (const spec of VIEW_FILTER_SPECS) {
    const desired = command.changes[spec.field];
    if (desired === undefined) continue;
    const next =
      desired !== null &&
      desired.length === 0 &&
      VIEW_FILTER_SPECS.some((candidate) => {
        const value = desiredState[candidate.field];
        return candidate.field !== spec.field && value !== null && value.length > 0;
      })
        ? removeViewFilterBlock(rewritten, spec)
        : rewriteViewFilter(rewritten, graph, view, spec, desired);
    if (!next.ok) return invalidRange(next.message);
    rewritten = next.fragment;
  }
  const localSource = `${source.slice(0, view.range.startOffset)}${rewritten}${source.slice(view.range.endOffset)}`;
  const officialSource = acceptedOfficialDiagramViewSource(
    source,
    graph,
    view,
    command,
    localSource,
  );
  const candidateFragment = officialSource
    ? officialSource.slice(view.range.startOffset, view.range.startOffset + rewritten.length)
    : rewritten;
  const edits = deriveMinimalTextEdits(originalFragment, candidateFragment, view.range.startOffset);
  return edits
    ? { ok: true, edits }
    : invalidRange("The DiagramView source changes could not be reduced to safe text edits.");
}

function removeViewFilterBlock(
  fragment: string,
  spec: ViewFilterSpec,
): { ok: true; fragment: string } | { ok: false; message: string } {
  const block = findDirectChildBlock(fragment, spec.keyword);
  if (!block) return { ok: true, fragment };
  return {
    ok: true,
    fragment: `${fragment.slice(0, block.keywordStart)}${fragment.slice(block.endOffset)}`,
  };
}

function acceptedOfficialDiagramViewSource(
  source: string,
  graph: SchemaGraph,
  view: DiagramViewNode,
  command: UpdateDiagramViewCommand,
  localSource: string,
): string | null {
  try {
    const operation = buildOfficialViewOperation(graph, view, command);
    const official = syncDiagramView(source, [operation]);
    // Equality with the source-preserving local patch is a deliberately strict acceptance gate:
    // it proves the official output did not rewrite comments, formatting, or untouched filters.
    return official.newDbml === localSource ? official.newDbml : null;
  } catch {
    return null;
  }
}

function buildOfficialViewOperation(
  graph: SchemaGraph,
  view: DiagramViewNode,
  command: UpdateDiagramViewCommand,
): DiagramViewSyncOperation {
  const merged = Object.fromEntries(
    VIEW_FILTER_SPECS.map((spec) => [
      spec.field,
      command.changes[spec.field] === undefined ? spec.current(view) : command.changes[spec.field],
    ]),
  ) as Record<ViewFilterField, string[] | null>;
  return {
    operation: "update",
    name: view.name,
    visibleEntities: {
      tables: mapNullable(merged.visibleTableKeys, (key) => {
        const table = requireTable(graph, key);
        return { name: table.name, schemaName: table.schemaName };
      }),
      stickyNotes: mapNullable(merged.visibleNoteKeys, (key) => ({
        name: requireNoteName(graph, key),
      })),
      tableGroups: mapNullable(merged.visibleGroupKeys, (key) => ({
        name: requireGroup(graph, key).name,
      })),
      schemas: mapNullable(merged.visibleSchemaNames, (name) => ({ name })),
    },
  };
}

function mapNullable<T, R>(values: readonly T[] | null, mapper: (value: T) => R): R[] | null {
  return values === null ? null : values.map(mapper);
}

type FilterValidation =
  | { ok: true; items: FilterItem[]; block: ParsedDirectChildBlock | null }
  | { ok: false; message: string };

function validateViewFilterSource(
  fragment: string,
  graph: SchemaGraph,
  view: DiagramViewNode,
  spec: ViewFilterSpec,
): FilterValidation {
  const block = findDirectChildBlock(fragment, spec.keyword);
  if (!block) {
    return spec.current(view) === null || spec.current(view)?.length === 0
      ? { ok: true, items: [], block: null }
      : { ok: false, message: `The ${spec.keyword} filter block is missing from source.` };
  }
  const parsed = parseFilterItems(fragment, block, graph, view, spec);
  if (!parsed.ok) return parsed;
  const wildcard = parsed.items.filter((item) => item.wildcard);
  const identities = parsed.items.filter((item) => !item.wildcard).map((item) => item.identity);
  const unique = new Set(identities);
  if (unique.size !== identities.length || wildcard.length > 1) {
    return { ok: false, message: `The ${spec.keyword} filter contains duplicate entries.` };
  }
  const current = spec.current(view);
  if (current === null) {
    return parsed.items.length === 0
      ? { ok: true, items: parsed.items, block }
      : { ok: false, message: `The ${spec.keyword} filter source does not represent null.` };
  }
  if (current.length === 0) {
    return wildcard.length === 1 && parsed.items.length === 1
      ? { ok: true, items: parsed.items, block }
      : { ok: false, message: `The ${spec.keyword} filter source does not represent all.` };
  }
  return wildcard.length === 0 &&
    arraysEqual([...unique].toSorted(compareCodeUnits), [...current].toSorted(compareCodeUnits))
    ? { ok: true, items: parsed.items, block }
    : { ok: false, message: `The ${spec.keyword} filter source does not match the graph.` };
}

function parseFilterItems(
  fragment: string,
  block: ParsedDirectChildBlock,
  graph: SchemaGraph,
  view: DiagramViewNode,
  spec: ViewFilterSpec,
): { ok: true; items: FilterItem[] } | { ok: false; message: string } {
  const items: FilterItem[] = [];
  let cursor = block.openBraceOffset + 1;
  while (cursor < block.closeBraceOffset) {
    const next = skipTrivia(fragment, cursor, block.closeBraceOffset);
    if (!next.ok) return { ok: false, message: next.message };
    cursor = next.offset;
    if (cursor >= block.closeBraceOffset) break;
    if (fragment[cursor] === "*") {
      items.push({
        identity: "*",
        wildcard: true,
        startOffset: cursor,
        endOffset: cursor + 1,
      });
      cursor += 1;
      continue;
    }
    const parsedName = parseQualifiedIdentifierAt(fragment, cursor, block.closeBraceOffset);
    if (!parsedName) {
      return { ok: false, message: `A ${spec.keyword} filter entry is ambiguous.` };
    }
    const identity = spec.resolveIdentity(parsedName.segments, graph, view);
    if (identity === null || !filterIdentityExists(graph, spec.field, identity)) {
      return { ok: false, message: `A ${spec.keyword} filter entry cannot be resolved.` };
    }
    items.push({
      identity,
      wildcard: false,
      startOffset: cursor,
      endOffset: parsedName.endOffset,
    });
    cursor = parsedName.endOffset;
  }
  return { ok: true, items };
}

function rewriteViewFilter(
  fragment: string,
  graph: SchemaGraph,
  view: DiagramViewNode,
  spec: ViewFilterSpec,
  desired: readonly string[] | null,
): { ok: true; fragment: string } | { ok: false; message: string } {
  const block = findDirectChildBlock(fragment, spec.keyword);
  if (!block) {
    if (desired === null) return { ok: true, fragment };
    return insertMissingFilterBlock(fragment, graph, view, spec, desired);
  }
  const parsed = parseFilterItems(fragment, block, graph, view, spec);
  if (!parsed.ok) return parsed;

  const desiredSet =
    desired === null || desired.length === 0 ? new Set<string>() : new Set(desired);
  const retained = parsed.items.filter((item) => !item.wildcard && desiredSet.has(item.identity));
  const missing =
    desired === null || desired.length === 0
      ? []
      : desired
          .filter((identity) => !retained.some((item) => item.identity === identity))
          .toSorted(compareCodeUnits);
  const remove = parsed.items.filter((item) => {
    if (desired === null) return true;
    if (desired.length === 0) return true;
    return item.wildcard || !desiredSet.has(item.identity);
  });
  const additions =
    desired !== null && desired.length === 0
      ? ["*"]
      : missing.map((identity) => spec.renderIdentity(identity, graph, view)).filter(isString);
  if (additions.length !== (desired !== null && desired.length === 0 ? 1 : missing.length)) {
    return { ok: false, message: `A ${spec.keyword} filter value could not be rendered.` };
  }

  const edits: TextEdit[] = remove.map((item) => ({
    startOffset: item.startOffset,
    endOffset: item.endOffset,
    newText: "",
  }));
  if (additions.length > 0) {
    edits.push(filterInsertion(fragment, block, parsed.items, additions));
  }
  const applied = applyTextEdits(fragment, edits);
  return applied.ok
    ? { ok: true, fragment: applied.source }
    : { ok: false, message: `The ${spec.keyword} filter edits overlap.` };
}

function filterInsertion(
  fragment: string,
  block: ParsedDirectChildBlock,
  items: readonly FilterItem[],
  additions: readonly string[],
): TextEdit {
  const inner = fragment.slice(block.openBraceOffset + 1, block.closeBraceOffset);
  if (inner.includes("\n") || inner.includes("\r")) {
    const closeLineStart = lineStartOffset(fragment, block.closeBraceOffset);
    const keywordIndent = lineIndentAt(fragment, block.keywordStart) ?? "";
    const itemIndent =
      items[0] && lineStartOffset(fragment, items[0].startOffset) !== items[0].startOffset
        ? (lineIndentAt(fragment, items[0].startOffset) ?? `${keywordIndent}  `)
        : `${keywordIndent}  `;
    const newline = detectNewline(fragment, block.keywordStart, block.endOffset);
    return {
      startOffset: closeLineStart,
      endOffset: closeLineStart,
      newText: additions.map((value) => `${itemIndent}${value}${newline}`).join(""),
    };
  }

  let insertionOffset = block.closeBraceOffset;
  while (
    insertionOffset > block.openBraceOffset + 1 &&
    /[\t ]/u.test(fragment[insertionOffset - 1] ?? "")
  ) {
    insertionOffset -= 1;
  }
  return {
    startOffset: insertionOffset,
    endOffset: insertionOffset,
    newText: ` ${additions.join(" ")}`,
  };
}

function insertMissingFilterBlock(
  fragment: string,
  graph: SchemaGraph,
  view: DiagramViewNode,
  spec: ViewFilterSpec,
  desired: readonly string[],
): { ok: true; fragment: string } | { ok: false; message: string } {
  const rendered =
    desired.length === 0
      ? ["*"]
      : [...desired]
          .toSorted(compareCodeUnits)
          .map((identity) => spec.renderIdentity(identity, graph, view))
          .filter(isString);
  if (rendered.length !== (desired.length === 0 ? 1 : desired.length)) {
    return { ok: false, message: `A ${spec.keyword} filter value could not be rendered.` };
  }

  const existing = VIEW_FILTER_SPECS.flatMap((candidate) => {
    const block = findDirectChildBlock(fragment, candidate.keyword);
    return block ? [{ spec: candidate, block }] : [];
  });
  const nextBlock = existing
    .filter((candidate) => candidate.spec.order > spec.order)
    .toSorted((left, right) => left.spec.order - right.spec.order)[0];
  const closeBrace = fragment.length - 1;
  if (fragment[closeBrace] !== "}") {
    return { ok: false, message: "The DiagramView closing brace could not be resolved." };
  }
  const anchor = nextBlock?.block.keywordStart ?? closeBrace;
  const insertionOffset = lineStartOffset(fragment, anchor);
  if (insertionOffset === 0) {
    return { ok: false, message: "A compact DiagramView cannot accept a missing filter safely." };
  }
  const childIndent = existing[0]
    ? (lineIndentAt(fragment, existing[0].block.keywordStart) ?? "  ")
    : `${lineIndentAt(fragment, 0) ?? ""}  `;
  const newline = detectNewline(fragment);
  const blockText = `${childIndent}${spec.keyword} {${newline}${rendered
    .map((value) => `${childIndent}  ${value}${newline}`)
    .join("")}${childIndent}}${newline}`;
  const applied = applyTextEdits(fragment, [
    { startOffset: insertionOffset, endOffset: insertionOffset, newText: blockText },
  ]);
  return applied.ok
    ? { ok: true, fragment: applied.source }
    : { ok: false, message: `The ${spec.keyword} filter block could not be inserted.` };
}

function verifyCommandSemantics(
  before: SchemaGraph,
  after: SchemaGraph,
  command: GroupViewVisualCommand,
  diff: SchemaGraphDiff,
): boolean {
  if (diff.renameCandidates.length !== 0 || diff.changes.length !== 1) return false;
  const change = diff.changes[0];
  if (change?.operation !== "UPDATE") return false;

  if (command.kind === "UPDATE_GROUP_MEMBERSHIP") {
    const beforeGroup = before.groups.find((group) => group.key === command.targetGroupKey);
    const afterGroup = after.groups.find((group) => group.key === command.targetGroupKey);
    if (!beforeGroup || !afterGroup) return false;
    const expected = beforeGroup.tableKeys
      .filter((key) => !command.removeTableKeys.includes(key))
      .concat(command.addTableKeys)
      .toSorted(compareCodeUnits);
    return (
      change.elementKind === "group" &&
      change.key === command.targetGroupKey &&
      arraysEqual(change.changedFields, ["tableKeys"]) &&
      arraysEqual([...afterGroup.tableKeys].toSorted(compareCodeUnits), expected)
    );
  }

  const beforeView = before.views.find((view) => view.key === command.targetViewKey);
  const afterView = after.views.find((view) => view.key === command.targetViewKey);
  if (!beforeView || !afterView) return false;
  const expectedFields = VIEW_FILTER_SPECS.flatMap((spec) => {
    const desired = command.changes[spec.field];
    return desired !== undefined && !sameTriState(spec.current(beforeView), desired)
      ? [spec.field]
      : [];
  }).toSorted(compareCodeUnits);
  if (
    change.elementKind !== "view" ||
    change.key !== command.targetViewKey ||
    !arraysEqual(change.changedFields, expectedFields)
  ) {
    return false;
  }
  return VIEW_FILTER_SPECS.every((spec) => {
    const desired = command.changes[spec.field];
    const expected = desired === undefined ? spec.current(beforeView) : desired;
    return sameTriState(spec.current(afterView), expected);
  });
}

function sameTriState(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return left === right;
  return arraysEqual([...left].toSorted(compareCodeUnits), [...right].toSorted(compareCodeUnits));
}

function parseQualifiedIdentifier(
  source: string,
): { segments: string[]; endOffset: number } | null {
  const start = skipSpaces(source, 0, source.length);
  const parsed = parseQualifiedIdentifierAt(source, start, source.length);
  if (!parsed || skipSpaces(source, parsed.endOffset, source.length) !== source.length) return null;
  return parsed;
}

function parseQualifiedIdentifierAt(
  source: string,
  startOffset: number,
  endOffset: number,
): { segments: string[]; endOffset: number } | null {
  const first = readIdentifier(source, startOffset, endOffset);
  if (!first) return null;
  const segments = [first.value];
  let cursor = first.endOffset;
  const dotStart = skipSpaces(source, cursor, endOffset);
  if (source[dotStart] === ".") {
    const secondStart = skipSpaces(source, dotStart + 1, endOffset);
    const second = readIdentifier(source, secondStart, endOffset);
    if (!second) return null;
    segments.push(second.value);
    cursor = second.endOffset;
  }
  return { segments, endOffset: cursor };
}

function readIdentifier(
  source: string,
  startOffset: number,
  endOffset: number,
): { value: string; endOffset: number } | null {
  if (source[startOffset] === '"') {
    let cursor = startOffset + 1;
    let escaped = false;
    while (cursor < endOffset) {
      const character = source[cursor] ?? "";
      if (!escaped && character === '"') {
        const raw = source.slice(startOffset, cursor + 1);
        try {
          const value = JSON.parse(raw);
          return typeof value === "string" ? { value, endOffset: cursor + 1 } : null;
        } catch {
          return null;
        }
      }
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
      cursor += 1;
    }
    return null;
  }
  if (!isIdentifierCharacter(source[startOffset] ?? "")) return null;
  let cursor = startOffset + 1;
  while (cursor < endOffset && isIdentifierCharacter(source[cursor] ?? "")) cursor += 1;
  return { value: source.slice(startOffset, cursor), endOffset: cursor };
}

function isIdentifierCharacter(value: string): boolean {
  return /[A-Za-z0-9_$\p{L}\p{N}]/u.test(value);
}

function skipSpaces(source: string, startOffset: number, endOffset: number): number {
  let cursor = startOffset;
  while (cursor < endOffset && /\s/u.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

function skipTrivia(
  source: string,
  startOffset: number,
  endOffset: number,
): { ok: true; offset: number } | { ok: false; message: string } {
  let cursor = startOffset;
  while (cursor < endOffset) {
    if (/\s/u.test(source[cursor] ?? "")) {
      cursor += 1;
      continue;
    }
    if (source.startsWith("//", cursor)) {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline === -1 || newline >= endOffset ? endOffset : newline + 1;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const closing = source.indexOf("*/", cursor + 2);
      if (closing === -1 || closing + 2 > endOffset) {
        return { ok: false, message: "An unterminated filter comment was found." };
      }
      cursor = closing + 2;
      continue;
    }
    break;
  }
  return { ok: true, offset: cursor };
}

function stripComments(
  line: string,
  initialBlockComment: boolean,
): { text: string; blockComment: boolean } {
  const output = [...line];
  let cursor = 0;
  let blockComment = initialBlockComment;
  let quoted = false;
  let escaped = false;
  while (cursor < line.length) {
    if (blockComment) {
      output[cursor] = " ";
      if (line.startsWith("*/", cursor)) {
        output[cursor + 1] = " ";
        cursor += 2;
        blockComment = false;
      } else {
        cursor += 1;
      }
      continue;
    }
    const character = line[cursor] ?? "";
    if (quoted) {
      if (!escaped && character === '"') quoted = false;
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
      cursor += 1;
      continue;
    }
    if (character === '"') {
      quoted = true;
      cursor += 1;
      continue;
    }
    if (line.startsWith("//", cursor)) {
      for (let index = cursor; index < output.length; index += 1) output[index] = " ";
      break;
    }
    if (line.startsWith("/*", cursor)) {
      output[cursor] = " ";
      output[cursor + 1] = " ";
      cursor += 2;
      blockComment = true;
      continue;
    }
    cursor += 1;
  }
  return { text: output.join(""), blockComment };
}

function requireTable(graph: SchemaGraph, key: SchemaElementKey) {
  const table = graph.tables.find((candidate) => candidate.key === key);
  if (!table) throw new Error(`Preflight invariant violated for table ${key}`);
  return table;
}

function requireGroup(graph: SchemaGraph, key: SchemaElementKey) {
  const group = graph.groups.find((candidate) => candidate.key === key);
  if (!group) throw new Error(`Preflight invariant violated for group ${key}`);
  return group;
}

function requireView(graph: SchemaGraph, key: SchemaElementKey) {
  const view = graph.views.find((candidate) => candidate.key === key);
  if (!view) throw new Error(`Preflight invariant violated for view ${key}`);
  return view;
}

function requireNoteName(graph: SchemaGraph, key: SchemaElementKey): string {
  const note = graph.notes.find((candidate) => candidate.key === key);
  if (!note) throw new Error(`Preflight invariant violated for note ${key}`);
  return note.name;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isString(value: string | null): value is string {
  return value !== null;
}
