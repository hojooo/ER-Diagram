import { CompileErrorCode } from "@dbml/parse";
import { diagnosticSchema, type Diagnostic, type SourceRange } from "@er-diagram/contracts";
import {
  isSourceRangeValid,
  resolvePublicFilepath,
  type DbmlSourceContext,
} from "./dbml-source-range.js";

type DiagnosticSeverity = Diagnostic["severity"];

interface NativePositionLike {
  offset: number;
  line: number;
  column: number;
}

interface NativeSourceLike {
  filepath?: { absolute?: string } | string;
  start?: number;
  end?: number;
  startPos?: NativePositionLike;
  endPos?: NativePositionLike;
}

interface NativeDiagnosticLike {
  code?: number;
  diagnostic?: string;
  nodeOrToken?: NativeSourceLike;
}

export interface DbmlNativeDiagnostics {
  errors: readonly NativeDiagnosticLike[];
  warnings: readonly NativeDiagnosticLike[];
  infos: readonly NativeDiagnosticLike[];
}

const LEXICAL_CODES = new Set<number>([
  CompileErrorCode.UNKNOWN_SYMBOL,
  CompileErrorCode.UNEXPECTED_NEWLINE,
  CompileErrorCode.UNKNOWN_TOKEN,
  CompileErrorCode.INVALID_ESCAPE_SEQUENCE,
]);

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  ERROR: 0,
  WARNING: 1,
  INFO: 2,
};

const INVALID_RANGE_DIAGNOSTIC = diagnosticSchema.parse({
  code: "DBML_PARSE_INTERNAL_DIAGNOSTIC_RANGE",
  message: "DBML compiler returned an invalid diagnostic source range.",
  severity: "ERROR",
});

const INVALID_CONTRACT_DIAGNOSTIC = diagnosticSchema.parse({
  code: "DBML_PARSE_INTERNAL_DIAGNOSTIC_CONTRACT",
  message: "DBML compiler returned an invalid diagnostic.",
  severity: "ERROR",
});

export function normalizeDbmlDiagnostics(
  native: DbmlNativeDiagnostics,
  context: DbmlSourceContext,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const groups: ReadonlyArray<readonly [DiagnosticSeverity, readonly NativeDiagnosticLike[]]> = [
    ["ERROR", native.errors],
    ["WARNING", native.warnings],
    ["INFO", native.infos],
  ];

  for (const [severity, entries] of groups) {
    for (const entry of entries) {
      const diagnostic = normalizeNativeDiagnostic(entry, severity, context);
      if (diagnostic === "INVALID_RANGE") return [INVALID_RANGE_DIAGNOSTIC];
      if (diagnostic === "INVALID_CONTRACT") return [INVALID_CONTRACT_DIAGNOSTIC];
      diagnostics.push(diagnostic);
    }
  }

  const unique = new Map<string, Diagnostic>();
  for (const diagnostic of diagnostics) {
    const identity = JSON.stringify(diagnostic);
    if (!unique.has(identity)) unique.set(identity, diagnostic);
  }

  return [...unique.values()].sort(compareDiagnostics);
}

function normalizeNativeDiagnostic(
  native: NativeDiagnosticLike,
  severity: DiagnosticSeverity,
  context: DbmlSourceContext,
): Diagnostic | "INVALID_RANGE" | "INVALID_CONTRACT" {
  if (
    !Number.isSafeInteger(native.code) ||
    typeof native.code !== "number" ||
    typeof native.diagnostic !== "string" ||
    native.diagnostic.length === 0
  ) {
    return "INVALID_CONTRACT";
  }

  const range = normalizeNativeRange(native.nodeOrToken, context);
  if (!range) return "INVALID_RANGE";

  const diagnostic = {
    code: stableDiagnosticCode(native.code),
    message: native.diagnostic,
    severity,
    range,
  } satisfies Diagnostic;
  return diagnosticSchema.safeParse(diagnostic).success ? diagnostic : "INVALID_CONTRACT";
}

function normalizeNativeRange(
  source: NativeSourceLike | undefined,
  context: DbmlSourceContext,
): SourceRange | null {
  if (!source) return null;

  const compilerFilepath = nativeFilepath(source.filepath);
  const filepath = compilerFilepath ? resolvePublicFilepath(compilerFilepath, context) : null;
  if (!filepath || !source.startPos || !source.endPos) return null;
  if (
    !Number.isSafeInteger(source.start) ||
    !Number.isSafeInteger(source.end) ||
    source.start !== source.startPos.offset ||
    source.end !== source.endPos.offset
  ) {
    return null;
  }

  const range: SourceRange = {
    filepath,
    startOffset: source.start,
    endOffset: source.end,
    startLine: source.startPos.line + 1,
    startColumn: source.startPos.column + 1,
    endLine: source.endPos.line + 1,
    endColumn: source.endPos.column + 1,
  };
  return isSourceRangeValid(range, context.sourceByPublicFilepath) ? range : null;
}

function nativeFilepath(filepath: NativeSourceLike["filepath"]): string | null {
  if (typeof filepath === "string") return filepath;
  return typeof filepath?.absolute === "string" ? filepath.absolute : null;
}

function stableDiagnosticCode(nativeCode: number): string {
  const nativeName = CompileErrorCode[nativeCode] ?? `NATIVE_${nativeCode}`;
  if (LEXICAL_CODES.has(nativeCode)) return `DBML_PARSE_LEXICAL_${nativeName}`;
  if (nativeCode < 3000) return `DBML_PARSE_SYNTAX_${nativeName}`;
  return `DBML_SEMANTIC_${nativeName}`;
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
    compareText(left.range?.filepath ?? "", right.range?.filepath ?? "") ||
    (left.range?.startOffset ?? -1) - (right.range?.startOffset ?? -1) ||
    (left.range?.endOffset ?? -1) - (right.range?.endOffset ?? -1) ||
    compareText(left.code, right.code) ||
    compareText(left.message, right.message)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
