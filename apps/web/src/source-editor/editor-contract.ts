import type { Diagnostic } from "@er-diagram/contracts";
import type { ComponentType, RefAttributes } from "react";

export interface SourceEditorHandle {
  replaceSource(source: string): void;
  navigateToDiagnostic(diagnostic: Diagnostic): boolean;
  focus(): void;
}

export interface SourceEditorProps extends RefAttributes<SourceEditorHandle> {
  readonly projectId: string;
  readonly initialSource: string;
  readonly diagnostics: Diagnostic[];
  readonly onChange: (source: string) => void;
  readonly onSave: () => void;
}

export type SourceEditorComponent = ComponentType<SourceEditorProps>;
