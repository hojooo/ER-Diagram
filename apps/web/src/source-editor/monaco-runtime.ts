import EditorWorker from "monaco-editor/editor/editor.worker?worker";

export type MonacoRuntime = typeof import("monaco-editor/editor/editor.api");

let runtimePromise: Promise<MonacoRuntime> | undefined;

export function loadMonacoRuntime(): Promise<MonacoRuntime> {
  runtimePromise ??= initializeMonacoRuntime();
  return runtimePromise;
}

async function initializeMonacoRuntime(): Promise<MonacoRuntime> {
  configureLocalEditorWorker();
  const [monaco] = await Promise.all([
    import("monaco-editor/editor/editor.api"),
    import("monaco-editor/editor/contrib/find/browser/findController"),
    import("monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching"),
  ]);
  return monaco;
}

function configureLocalEditorWorker(): void {
  const scope = globalThis as typeof globalThis & {
    MonacoEnvironment?: {
      getWorker(_moduleId: string, _label: string): Worker;
    };
  };
  scope.MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
}
