import type {
  PartialInjectionProvenance,
  SchemaElementKey,
  SchemaGraph,
  SourceRange,
  TableNode,
} from "@er-diagram/core";
import type { VisualPartialImpact } from "./types.js";
import { type EditPlan, planFailure, withoutFilepath } from "./verified-transform.js";

type ImpactResolution = { ok: true; impact: VisualPartialImpact } | { ok: false; message: string };

export function protectedPartialTarget(
  graph: SchemaGraph,
  provenance: PartialInjectionProvenance,
  kind: string,
): EditPlan {
  const resolution = resolveVisualPartialImpact(graph, provenance);
  if (!resolution.ok) {
    return planFailure("VISUAL_SOURCE_RANGE_INVALID", resolution.message);
  }
  return planFailure(
    "VISUAL_PARTIAL_TARGET_PROTECTED",
    `A TablePartial-injected ${kind} cannot be edited as a local table element.`,
    resolution.impact,
  );
}

export function resolveVisualPartialImpact(
  graph: SchemaGraph,
  provenance: PartialInjectionProvenance,
): ImpactResolution {
  const partial = graph.partials.find((candidate) => candidate.key === provenance.partialKey);
  if (!partial) return invalid("The injected element refers to an unknown TablePartial.");

  const elementKeys = new Set<SchemaElementKey>([
    ...partial.columns.flatMap((column) => [
      column.key,
      ...column.checks.map((check) => check.key),
    ]),
    ...partial.indexes.map((index) => index.key),
    ...partial.checks.map((check) => check.key),
  ]);
  if (!elementKeys.has(provenance.partialElementKey)) {
    return invalid("The injected element does not belong to its reported TablePartial.");
  }

  const definitionRange = graph.sourceMap[provenance.partialElementKey];
  if (!definitionRange || !validRange(definitionRange)) {
    return invalid("The TablePartial definition range is missing or invalid.");
  }

  const affectedTables: VisualPartialImpact["affectedTables"] = [];
  for (const table of graph.tables
    .filter((candidate) => candidate.partialKeys.includes(provenance.partialKey))
    .toSorted((left, right) => compareCodeUnits(left.key, right.key))) {
    const ranges = injectionRangesForTable(graph, table, provenance.partialKey);
    if (ranges.length !== 1) {
      return invalid(
        `The TablePartial injection range for ${table.key} is missing or inconsistent.`,
      );
    }
    const injectionRange = ranges[0];
    if (!injectionRange || !validRange(injectionRange)) {
      return invalid(`The TablePartial injection range for ${table.key} is invalid.`);
    }
    affectedTables.push({ tableKey: table.key, injectionRange: withoutFilepath(injectionRange) });
  }
  if (affectedTables.length === 0) {
    return invalid("The TablePartial has no resolvable affected table injection.");
  }

  return {
    ok: true,
    impact: {
      partialKey: partial.key,
      partialName: partial.name,
      partialElementKey: provenance.partialElementKey,
      definitionRange: withoutFilepath(definitionRange),
      affectedTables,
    },
  };
}

function injectionRangesForTable(
  graph: SchemaGraph,
  table: TableNode,
  partialKey: SchemaElementKey,
): SourceRange[] {
  const ranges = [
    ...table.columns.flatMap((column) => [
      column.injectedFrom,
      ...column.checks.map((check) => check.injectedFrom),
    ]),
    ...table.indexes.map((index) => index.injectedFrom),
    ...table.checks.map((check) => check.injectedFrom),
    ...graph.references
      .filter((reference) =>
        reference.endpoints.some((endpoint) => endpoint.tableKey === table.key),
      )
      .map((reference) => reference.injectedFrom),
  ]
    .filter(
      (item): item is PartialInjectionProvenance => item !== null && item.partialKey === partialKey,
    )
    .map((item) => item.injectionRange);

  const unique = new Map<string, SourceRange>();
  for (const range of ranges) unique.set(rangeIdentity(range), range);
  return [...unique.values()].toSorted(
    (left, right) =>
      compareCodeUnits(left.filepath, right.filepath) ||
      left.startOffset - right.startOffset ||
      left.endOffset - right.endOffset,
  );
}

function rangeIdentity(range: SourceRange): string {
  return `${range.filepath}\u0000${range.startOffset}\u0000${range.endOffset}`;
}

function validRange(range: SourceRange): boolean {
  return (
    range.filepath.length > 0 &&
    Number.isInteger(range.startOffset) &&
    Number.isInteger(range.endOffset) &&
    range.startOffset >= 0 &&
    range.endOffset >= range.startOffset &&
    range.startLine >= 1 &&
    range.startColumn >= 1 &&
    range.endLine >= range.startLine &&
    range.endColumn >= 1 &&
    (range.endLine !== range.startLine || range.endColumn >= range.startColumn)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): Extract<ImpactResolution, { ok: false }> {
  return { ok: false, message };
}
