import type { SourceTransformDiagnostic, TextEdit, TextEditApplicationResult } from "./types.js";

export function applyTextEdits(
  source: string,
  edits: readonly TextEdit[],
): TextEditApplicationResult {
  const rangeDiagnostic = validateRanges(source, edits);
  if (rangeDiagnostic) {
    return failure(source, rangeDiagnostic);
  }

  const ascending = [...edits].sort(
    (left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset,
  );
  for (let index = 1; index < ascending.length; index += 1) {
    const previous = ascending[index - 1];
    const current = ascending[index];
    if (!previous || !current) continue;

    const sameStart = current.startOffset === previous.startOffset;
    const intersectsPrevious = current.startOffset < previous.endOffset;
    if (sameStart || intersectsPrevious) {
      return failure(source, {
        code: "TEXT_EDIT_OVERLAP",
        message: `Text edits overlap or have an ambiguous shared start offset at ${current.startOffset}.`,
        severity: "ERROR",
      });
    }
  }

  const descending = ascending.reverse();
  let transformed = source;
  for (const edit of descending) {
    transformed = `${transformed.slice(0, edit.startOffset)}${edit.newText}${transformed.slice(edit.endOffset)}`;
  }

  return { ok: true, source: transformed };
}

function validateRanges(
  source: string,
  edits: readonly TextEdit[],
): SourceTransformDiagnostic | null {
  for (const edit of edits) {
    const valid =
      Number.isInteger(edit.startOffset) &&
      Number.isInteger(edit.endOffset) &&
      edit.startOffset >= 0 &&
      edit.endOffset >= edit.startOffset &&
      edit.endOffset <= source.length &&
      typeof edit.newText === "string";

    if (!valid) {
      return {
        code: "TEXT_EDIT_RANGE_INVALID",
        message: `Text edit range [${String(edit.startOffset)}, ${String(edit.endOffset)}) is outside a source of ${source.length} UTF-16 code units.`,
        severity: "ERROR",
      };
    }
  }
  return null;
}

function failure(source: string, diagnostic: SourceTransformDiagnostic): TextEditApplicationResult {
  return { ok: false, source, diagnostics: [diagnostic] };
}
