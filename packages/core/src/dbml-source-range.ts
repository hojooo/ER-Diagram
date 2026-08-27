import { sourceRangeSchema, type SourceRange } from "@er-diagram/contracts";

export interface DbmlSourceContext {
  fallbackPublicFilepath: string;
  publicFilepathByCompilerPath?: ReadonlyMap<string, string> | undefined;
  sourceByPublicFilepath?: ReadonlyMap<string, string> | undefined;
}

export function resolvePublicFilepath(
  compilerFilepath: string | null,
  context: DbmlSourceContext,
): string | null {
  if (compilerFilepath === null) return context.fallbackPublicFilepath;

  const aliases = context.publicFilepathByCompilerPath;
  if (!aliases) return compilerFilepath;
  return aliases.get(compilerFilepath) ?? null;
}

export function isSourceRangeValid(
  range: SourceRange,
  sourceByPublicFilepath?: ReadonlyMap<string, string>,
): boolean {
  if (!sourceRangeSchema.safeParse(range).success) return false;
  if (!sourceByPublicFilepath) return true;

  const source = sourceByPublicFilepath.get(range.filepath);
  if (
    source === undefined ||
    range.startOffset > source.length ||
    range.endOffset > source.length
  ) {
    return false;
  }

  return (
    offsetAtPosition(source, range.startLine, range.startColumn) === range.startOffset &&
    offsetAtPosition(source, range.endLine, range.endColumn) === range.endOffset
  );
}

function offsetAtPosition(source: string, line: number, column: number): number | null {
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) {
    return null;
  }

  let lineStart = 0;
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    const newline = source.indexOf("\n", lineStart);
    if (newline === -1) return null;
    lineStart = newline + 1;
  }

  const newline = source.indexOf("\n", lineStart);
  const lineEnd = newline === -1 ? source.length : newline;
  const offset = lineStart + column - 1;
  return offset <= lineEnd ? offset : null;
}
