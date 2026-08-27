import type { Diagnostic } from "@er-diagram/contracts";
import type { editor, IRange } from "monaco-editor";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import {
  DBML_LANGUAGE_ID,
  dbmlLanguageConfiguration,
  dbmlMonarchLanguage,
} from "./dbml-language.js";
import type { SourceEditorHandle, SourceEditorProps } from "./editor-contract.js";
import { loadMonacoRuntime, type MonacoRuntime } from "./monaco-runtime.js";

export const DBML_MARKER_OWNER = "er-diagram-dbml";

interface MonacoDbmlEditorProps extends SourceEditorProps {
  readonly loadRuntime?: () => Promise<MonacoRuntime>;
}

let languageRegistered = false;

export const MonacoDbmlEditor = forwardRef<SourceEditorHandle, MonacoDbmlEditorProps>(
  function MonacoDbmlEditor(
    { projectId, initialSource, diagnostics, onChange, onSave, loadRuntime = loadMonacoRuntime },
    forwardedRef,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const modelRef = useRef<editor.ITextModel | null>(null);
    const monacoRef = useRef<MonacoRuntime | null>(null);
    const initialSourceRef = useRef(initialSource);
    const diagnosticsRef = useRef(diagnostics);
    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSave);
    const suppressChangeRef = useRef(false);
    const [loadState, setLoadState] = useState<"LOADING" | "READY" | "ERROR">("LOADING");

    diagnosticsRef.current = diagnostics;
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;

    useImperativeHandle(
      forwardedRef,
      () => ({
        replaceSource(source) {
          const model = modelRef.current;
          if (!model) return;
          suppressChangeRef.current = true;
          try {
            model.setValue(source);
            setModelEol(model, source);
          } finally {
            suppressChangeRef.current = false;
          }
        },
        navigateToDiagnostic(diagnostic) {
          const activeEditor = editorRef.current;
          const model = modelRef.current;
          if (!activeEditor || !model || !diagnostic.range) return false;
          const selection = sourceRangeToEditorRange(model, diagnostic.range);
          activeEditor.setSelection(selection);
          activeEditor.revealRangeInCenter(selection);
          activeEditor.focus();
          return true;
        },
        focus() {
          editorRef.current?.focus();
        },
      }),
      [],
    );

    useEffect(() => {
      let cancelled = false;
      let activeEditor: editor.IStandaloneCodeEditor | undefined;
      let model: editor.ITextModel | undefined;
      let changeListener: { dispose(): void } | undefined;

      void loadRuntime().then(
        (monaco) => {
          if (cancelled || !containerRef.current) return;
          registerDbmlLanguage(monaco);
          const uri = monaco.Uri.parse(
            `inmemory://projects/${encodeURIComponent(projectId)}/main.dbml`,
          );
          monaco.editor.getModel(uri)?.dispose();
          model = monaco.editor.createModel(initialSourceRef.current, DBML_LANGUAGE_ID, uri);
          setModelEol(model, initialSourceRef.current);
          activeEditor = monaco.editor.create(containerRef.current, {
            model,
            ariaLabel: "DBML source editor",
            automaticLayout: true,
            bracketPairColorization: { enabled: true },
            fontSize: 14,
            lineNumbersMinChars: 3,
            minimap: { enabled: false },
            padding: { top: 14, bottom: 14 },
            scrollBeyondLastLine: false,
            tabSize: 2,
            theme: "vs-dark",
            wordWrap: "off",
          });
          activeEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            onSaveRef.current();
          });
          changeListener = model.onDidChangeContent(() => {
            if (!suppressChangeRef.current && model) onChangeRef.current(model.getValue());
          });
          monacoRef.current = monaco;
          modelRef.current = model;
          editorRef.current = activeEditor;
          applyDiagnosticMarkers(monaco, model, diagnosticsRef.current);
          setLoadState("READY");
        },
        () => {
          if (!cancelled) setLoadState("ERROR");
        },
      );

      return () => {
        cancelled = true;
        changeListener?.dispose();
        if (model && monacoRef.current) {
          monacoRef.current.editor.setModelMarkers(model, DBML_MARKER_OWNER, []);
        }
        activeEditor?.dispose();
        model?.dispose();
        editorRef.current = null;
        modelRef.current = null;
        monacoRef.current = null;
      };
    }, [loadRuntime, projectId]);

    useEffect(() => {
      const monaco = monacoRef.current;
      const model = modelRef.current;
      if (monaco && model) applyDiagnosticMarkers(monaco, model, diagnostics);
    }, [diagnostics]);

    return (
      <div className="relative min-h-[32rem] overflow-hidden rounded-b-xl bg-[#1e1e1e]">
        <section
          ref={containerRef}
          className="h-[min(68vh,52rem)] min-h-[32rem] w-full"
          aria-label="DBML source editor"
        />
        {loadState === "LOADING" ? (
          <div className="absolute inset-0 grid place-items-center bg-slate-950 text-sm text-slate-300">
            <p aria-live="polite">Loading source editor…</p>
          </div>
        ) : null}
        {loadState === "ERROR" ? (
          <div
            className="absolute inset-0 grid place-items-center bg-red-950/95 p-6 text-center text-red-100"
            role="alert"
          >
            <div>
              <p className="font-semibold">Source editor could not be loaded</p>
              <p className="mt-2 text-sm text-red-100/80">
                Reload the workspace to try loading the local editor assets again.
              </p>
            </div>
          </div>
        ) : null}
      </div>
    );
  },
);

function registerDbmlLanguage(monaco: MonacoRuntime): void {
  if (languageRegistered) return;
  monaco.languages.register({ id: DBML_LANGUAGE_ID, extensions: [".dbml"] });
  monaco.languages.setLanguageConfiguration(DBML_LANGUAGE_ID, dbmlLanguageConfiguration);
  monaco.languages.setMonarchTokensProvider(DBML_LANGUAGE_ID, dbmlMonarchLanguage);
  languageRegistered = true;
}

export function applyDiagnosticMarkers(
  monaco: MonacoRuntime,
  model: editor.ITextModel,
  diagnostics: Diagnostic[],
): void {
  const markers = diagnostics.flatMap((diagnostic) => {
    if (!diagnostic.range) return [];
    const range = sourceRangeToEditorRange(model, diagnostic.range);
    return [
      {
        ...range,
        message: diagnostic.message,
        code: diagnostic.code,
        severity: markerSeverity(monaco, diagnostic.severity),
        source: "DBML",
      },
    ];
  });
  monaco.editor.setModelMarkers(model, DBML_MARKER_OWNER, markers);
}

function sourceRangeToEditorRange(
  model: editor.ITextModel,
  range: NonNullable<Diagnostic["range"]>,
): IRange {
  const sourceLength = model.getValueLength();
  const start = model.getPositionAt(clamp(range.startOffset, 0, sourceLength));
  const end = model.getPositionAt(clamp(range.endOffset, 0, sourceLength));
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  };
}

function markerSeverity(monaco: MonacoRuntime, severity: Diagnostic["severity"]): number {
  if (severity === "ERROR") return monaco.MarkerSeverity.Error;
  if (severity === "WARNING") return monaco.MarkerSeverity.Warning;
  return monaco.MarkerSeverity.Info;
}

function setModelEol(model: editor.ITextModel, source: string): void {
  model.setEOL(source.includes("\r\n") ? 1 : 0);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
