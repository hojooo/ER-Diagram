import { type VisualCommand, visualCommandSchema } from "@er-diagram/contracts";
import {
  diffSchemaGraphs,
  parseDbmlV2,
  type SchemaGraph,
  type SchemaGraphDiff,
  type SourceRange,
} from "@er-diagram/core";
import { applyTextEdits } from "./text-edits.js";
import type {
  SourceTransformDiagnostic,
  TextEdit,
  VisualSourceTransformFailure,
  VisualSourceTransformResult,
  VisualSourceTransformSuccess,
} from "./types.js";

export type EditPlan =
  | { ok: true; edits: TextEdit[] }
  | { ok: false; diagnostic: SourceTransformDiagnostic };

interface VerifiedVisualTransformHooks<Command extends VisualCommand> {
  supportedKinds: ReadonlySet<VisualCommand["kind"]>;
  unsupportedKindMessage: string;
  preflight(graph: SchemaGraph, command: Command): EditPlan;
  isSemanticNoOp(graph: SchemaGraph, command: Command): boolean;
  planEdits(source: string, graph: SchemaGraph, command: Command): EditPlan;
  verifySemantics(
    before: SchemaGraph,
    after: SchemaGraph,
    command: Command,
    diff: SchemaGraphDiff,
  ): boolean;
}

export async function runVerifiedVisualTransform<Command extends VisualCommand>(
  source: string,
  command: Command,
  filepath: string,
  hooks: VerifiedVisualTransformHooks<Command>,
): Promise<VisualSourceTransformResult> {
  const parsedCommand = visualCommandSchema.safeParse(command);
  if (!parsedCommand.success) {
    return failure(source, "VISUAL_COMMAND_INVALID", "The visual command payload is invalid.");
  }
  if (!hooks.supportedKinds.has(parsedCommand.data.kind)) {
    return failure(source, "VISUAL_COMMAND_KIND_UNSUPPORTED", hooks.unsupportedKindMessage);
  }
  const typedCommand = parsedCommand.data as Command;
  const before = await parseDbmlV2(source, filepath);
  if (!before.ok) {
    return {
      ok: false,
      source,
      diagnostics: [
        error("VISUAL_SOURCE_INVALID", "Visual commands require a valid DBML v2 source."),
        ...copyParserDiagnostics(before.diagnostics),
      ],
    };
  }

  const preflight = hooks.preflight(before.graph, typedCommand);
  if (!preflight.ok) return { ok: false, source, diagnostics: [preflight.diagnostic] };
  if (hooks.isSemanticNoOp(before.graph, typedCommand)) {
    return noOp(source, before.graph.schemaHash);
  }

  let plan: EditPlan;
  try {
    plan = hooks.planEdits(source, before.graph, typedCommand);
  } catch {
    return failure(
      source,
      "VISUAL_SOURCE_RANGE_INVALID",
      "The requested source element could not be resolved safely.",
    );
  }
  if (!plan.ok) return { ok: false, source, diagnostics: [plan.diagnostic] };
  const edits = uniqueSortedEdits(plan.edits);
  if (!edits) {
    return failure(
      source,
      "VISUAL_SOURCE_RANGE_INVALID",
      "The generated source edits overlap or conflict.",
    );
  }

  const applied = applyTextEdits(source, edits);
  if (!applied.ok) return { ok: false, source, diagnostics: applied.diagnostics };
  if (applied.source === source) return noOp(source, before.graph.schemaHash);

  const after = await parseDbmlV2(applied.source, filepath);
  if (!after.ok) {
    return {
      ok: false,
      source,
      diagnostics: [
        error("VISUAL_REPARSE_FAILED", "The generated source edits did not produce valid DBML v2."),
        ...copyParserDiagnostics(after.diagnostics),
      ],
    };
  }
  if (!diagnosticProfileIsSafe(before.graph, after.graph)) {
    return failure(
      source,
      "VISUAL_SEMANTIC_MISMATCH",
      "Reparsed DBML introduced a new parser diagnostic.",
    );
  }

  const semanticDiff = diffSchemaGraphs(before.graph, after.graph);
  if (!hooks.verifySemantics(before.graph, after.graph, typedCommand, semanticDiff)) {
    return failure(
      source,
      "VISUAL_SEMANTIC_MISMATCH",
      "Reparsed DBML changed schema semantics beyond the requested visual command.",
    );
  }

  return {
    ok: true,
    changed: true,
    source: applied.source,
    edits,
    beforeSchemaHash: before.graph.schemaHash,
    afterSchemaHash: after.graph.schemaHash,
    semanticDiff,
  };
}

export function planFailure(code: string, message: string): Extract<EditPlan, { ok: false }> {
  return { ok: false, diagnostic: error(code, message) };
}

export function invalidRange(message: string): EditPlan {
  return planFailure("VISUAL_SOURCE_RANGE_INVALID", message);
}

export function unsafeTransform(message: string): EditPlan {
  return planFailure("VISUAL_OFFICIAL_TRANSFORM_UNSAFE", message);
}

export function error(code: string, message: string): SourceTransformDiagnostic {
  return { code, message, severity: "ERROR" };
}

export function withoutFilepath(
  range: SourceRange,
): NonNullable<SourceTransformDiagnostic["range"]> {
  return {
    startOffset: range.startOffset,
    endOffset: range.endOffset,
    startLine: range.startLine,
    startColumn: range.startColumn,
    endLine: range.endLine,
    endColumn: range.endColumn,
  };
}

function uniqueSortedEdits(edits: readonly TextEdit[]): TextEdit[] | null {
  const byRange = new Map<string, TextEdit>();
  for (const edit of edits) {
    const key = `${edit.startOffset}:${edit.endOffset}`;
    const existing = byRange.get(key);
    if (existing && existing.newText !== edit.newText) return null;
    byRange.set(key, edit);
  }
  const sorted = [...byRange.values()].toSorted(
    (left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (!previous || !current) continue;
    if (current.startOffset < previous.endOffset || current.startOffset === previous.startOffset) {
      return null;
    }
  }
  return sorted;
}

function noOp(source: string, schemaHash: string): VisualSourceTransformSuccess {
  return {
    ok: true,
    changed: false,
    source,
    edits: [],
    beforeSchemaHash: schemaHash,
    afterSchemaHash: schemaHash,
    semanticDiff: { changes: [], renameCandidates: [] },
  };
}

function diagnosticProfileIsSafe(before: SchemaGraph, after: SchemaGraph): boolean {
  const beforeCounts = diagnosticCodeCounts(before);
  const afterCounts = diagnosticCodeCounts(after);
  for (const [identity, count] of afterCounts) {
    if (count > (beforeCounts.get(identity) ?? 0)) return false;
  }
  return true;
}

function diagnosticCodeCounts(graph: SchemaGraph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of graph.diagnostics) {
    if (diagnostic.severity !== "WARNING") continue;
    const identity = `${diagnostic.severity}:${diagnostic.code}`;
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return counts;
}

function failure(source: string, code: string, message: string): VisualSourceTransformFailure {
  return { ok: false, source, diagnostics: [error(code, message)] };
}

function copyParserDiagnostics(
  diagnostics: ReadonlyArray<{
    code: string;
    message: string;
    severity: "ERROR" | "WARNING" | "INFO";
    range?: SourceRange | undefined;
  }>,
): SourceTransformDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    ...(diagnostic.range ? { range: withoutFilepath(diagnostic.range) } : {}),
  }));
}
