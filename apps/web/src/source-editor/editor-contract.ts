import type { Diagnostic } from "@er-diagram/contracts";
import type { SourceRange } from "@er-diagram/core";
import type { ComponentType, RefAttributes } from "react";
import type { SourceCursorPosition } from "../diagram/source-navigation.js";

export interface SourceEditorHandle {
  replaceSource(source: string): void;
  navigateToDiagnostic(diagnostic: Diagnostic): boolean;
  revealSourceRange(range: SourceRange): boolean;
  focus(): void;
}

export interface SourceEditorProps extends RefAttributes<SourceEditorHandle> {
  readonly projectId: string;
  readonly initialSource: string;
  readonly diagnostics: Diagnostic[];
  readonly onChange: (source: string) => void;
  readonly onSave: () => void;
  readonly onCursorPositionChange?: (position: SourceCursorPosition) => void;
  readonly readOnly?: boolean;
}

export type SourceEditorComponent = ComponentType<SourceEditorProps>;
