export interface TextEdit {
  /** UTF-16 code-unit offset, inclusive. */
  startOffset: number;
  /** UTF-16 code-unit offset, exclusive. */
  endOffset: number;
  newText: string;
}

export interface SourceTransformDiagnosticRange {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface SourceTransformDiagnostic {
  code: string;
  message: string;
  severity: "ERROR" | "WARNING" | "INFO";
  range?: SourceTransformDiagnosticRange;
}

export interface TextEditApplicationSuccess {
  ok: true;
  source: string;
}

export interface TextEditApplicationFailure {
  ok: false;
  source: string;
  diagnostics: SourceTransformDiagnostic[];
}

export type TextEditApplicationResult = TextEditApplicationSuccess | TextEditApplicationFailure;
