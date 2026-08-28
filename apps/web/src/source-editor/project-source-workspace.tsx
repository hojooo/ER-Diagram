import type { ProjectState } from "@er-diagram/contracts";
import * as Dialog from "@radix-ui/react-dialog";
import type { QueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";

import type { BaseSchemaDiagramComponent } from "../diagram/base-schema-diagram-contract.js";
import { SchemaOutline } from "../diagram/schema-outline.js";
import { createDiagramSelectionStore } from "../diagram/selection-store.js";
import {
  createDiagramNavigationIndex,
  findDiagramSelectionAtCursor,
  type DiagramSelection,
  type SourceCursorPosition,
} from "../diagram/source-navigation.js";
import type { ProjectApi } from "../projects/project-api.js";
import { projectQueryKeys } from "../projects/project-queries.js";
import type { SourceEditorComponent, SourceEditorHandle } from "./editor-contract.js";
import {
  createDbmlParserWorkerClient,
  type DbmlParserWorkerClient,
} from "./parser-worker-client.js";
import {
  createSourceSession,
  type SourcePersistenceStatus,
  type SourceSessionController,
  type SourceSessionSnapshot,
  type SourceValidationStatus,
} from "./source-session.js";

const LazyMonacoDbmlEditor = lazy(async () => {
  const module = await import("./monaco-dbml-editor.js");
  return { default: module.MonacoDbmlEditor };
});

const LazyBaseSchemaDiagram = lazy(async () => {
  const module = await import("../diagram/base-schema-diagram.js");
  return { default: module.BaseSchemaDiagram };
});

export interface ProjectWorkspaceAdapters {
  readonly createParserClient?: () => DbmlParserWorkerClient;
  readonly SourceEditor?: SourceEditorComponent;
  readonly SchemaDiagram?: BaseSchemaDiagramComponent;
}

export function ProjectSourceWorkspace({
  initialState,
  api,
  queryClient,
  adapters,
}: {
  readonly initialState: ProjectState;
  readonly api: ProjectApi;
  readonly queryClient: QueryClient;
  readonly adapters?: ProjectWorkspaceAdapters;
}) {
  const [sessionSnapshot, setSessionSnapshot] = useState<SourceSessionSnapshot | null>(null);
  const sessionRef = useRef<SourceSessionController | null>(null);
  const editorRef = useRef<SourceEditorHandle>(null);
  const flushedBlockedNavigationRef = useRef(false);
  const [selectionStore] = useState(createDiagramSelectionStore);
  const projectId = initialState.project.id;
  const initialStateRef = useRef(initialState);
  const EditorComponent = adapters?.SourceEditor ?? LazyMonacoDbmlEditor;
  const DiagramComponent = adapters?.SchemaDiagram ?? LazyBaseSchemaDiagram;
  const activeGraph = sessionSnapshot?.activeGraph ?? null;
  const sourceNavigationEnabled = sessionSnapshot?.activeGraphSource === "CURRENT_DRAFT";
  const navigationIndex = useMemo(
    () => (activeGraph ? createDiagramNavigationIndex(activeGraph) : null),
    [activeGraph],
  );

  const handleCursorPositionChange = useCallback(
    (position: SourceCursorPosition) => {
      if (!sourceNavigationEnabled || !navigationIndex) {
        selectionStore.getState().setSelection(null);
        return;
      }
      selectionStore
        .getState()
        .setSelection(findDiagramSelectionAtCursor(navigationIndex, position));
    },
    [navigationIndex, selectionStore, sourceNavigationEnabled],
  );

  const handleNavigateSource = useCallback(
    (selection: DiagramSelection) => {
      if (!sourceNavigationEnabled || !activeGraph) return;
      const range = activeGraph.sourceMap[selection.elementKey];
      if (range) editorRef.current?.revealSourceRange(range);
    },
    [activeGraph, sourceNavigationEnabled],
  );

  useEffect(() => {
    const currentSelection = selectionStore.getState().selection;
    if (!activeGraph || (currentSelection && !activeGraph.sourceMap[currentSelection.elementKey])) {
      selectionStore.getState().setSelection(null);
    }
  }, [activeGraph, selectionStore]);

  useEffect(() => {
    const parserClient = (adapters?.createParserClient ?? createDbmlParserWorkerClient)();
    const session = createSourceSession({
      initialState: initialStateRef.current,
      parseSource: (source) => parserClient.parse(source),
      saveDraft: (input) => api.saveDraft(input),
      loadProject: async () => {
        const response = await api.getProject(projectId);
        queryClient.setQueryData(projectQueryKeys.detail(projectId), response);
        return response.state;
      },
      onServerState: (state) => {
        queryClient.setQueryData(projectQueryKeys.detail(projectId), { state });
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.list });
      },
    });
    sessionRef.current = session;
    const unsubscribe = session.subscribe(() => setSessionSnapshot(session.getSnapshot()));
    setSessionSnapshot(session.getSnapshot());
    session.start();

    return () => {
      unsubscribe();
      session.dispose();
      parserClient.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [adapters, api, projectId, queryClient]);

  const hasUnsavedSource = sessionSnapshot !== null && sessionSnapshot.persistence !== "SAVED";
  const navigationBlocker = useBlocker(hasUnsavedSource);

  useEffect(() => {
    if (navigationBlocker.state !== "blocked") {
      flushedBlockedNavigationRef.current = false;
      return;
    }
    if (!sessionSnapshot) return;
    if (sessionSnapshot.persistence === "DIRTY" && !flushedBlockedNavigationRef.current) {
      flushedBlockedNavigationRef.current = true;
      sessionRef.current?.flush();
    }
    if (sessionSnapshot.persistence === "SAVED") navigationBlocker.proceed();
  }, [navigationBlocker, sessionSnapshot]);

  useEffect(() => {
    if (!hasUnsavedSource) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedSource]);

  if (!sessionSnapshot) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-300">
        <p aria-live="polite">Preparing source workspace…</p>
      </div>
    );
  }

  const { serverState } = sessionSnapshot;
  return (
    <>
      <div className="mt-8 space-y-5">
        <div className="grid gap-5 xl:grid-cols-2">
          <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
            <div className="flex flex-col gap-3 border-b border-slate-700 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
                  Canonical DBML source
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Autosaves 750 ms after the latest edit. Ctrl/Cmd+S saves immediately.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  label={persistenceLabel(sessionSnapshot.persistence)}
                  testId="persistence-status"
                />
                <StatusBadge
                  label={validationLabel(sessionSnapshot.validation)}
                  testId="validation-status"
                />
                <button
                  className="min-h-10 rounded-lg border border-slate-600 px-3 text-sm font-semibold text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                  type="button"
                  disabled={sessionSnapshot.persistence === "CONFLICT"}
                  onClick={() => sessionRef.current?.flush()}
                >
                  Save now
                </button>
              </div>
            </div>
            <Suspense
              fallback={
                <div className="grid min-h-[32rem] place-items-center bg-slate-950 text-slate-300">
                  <p aria-live="polite">Loading local editor assets…</p>
                </div>
              }
            >
              <EditorComponent
                ref={editorRef}
                projectId={projectId}
                initialSource={initialStateRef.current.project.draftSource}
                diagnostics={sessionSnapshot.diagnostics}
                onChange={(source) => sessionRef.current?.edit(source)}
                onSave={() => sessionRef.current?.flush()}
                onCursorPositionChange={handleCursorPositionChange}
              />
            </Suspense>
          </section>

          <DiagramPanel
            snapshot={sessionSnapshot}
            selectionStore={selectionStore}
            DiagramComponent={DiagramComponent}
            sourceNavigationEnabled={sourceNavigationEnabled}
            onNavigateSource={handleNavigateSource}
            onFocusSource={() => editorRef.current?.focus()}
          />
        </div>

        <aside className="grid gap-5 lg:grid-cols-2" aria-label="Source workspace details">
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="font-semibold text-white">Draft status</h2>
            <dl className="mt-4 grid gap-3 text-sm">
              <DetailRow
                label="Schema revision"
                value={String(sessionSnapshot.expectedSchemaRevisionNo)}
              />
              <DetailRow label="Parser" value={serverState.project.parserVersion} />
              <DetailRow
                label="Last valid revision"
                value={serverState.lastValidRevision?.revisionNo.toString() ?? "None"}
              />
              <DetailRow
                label="Diagram source"
                value={
                  sessionSnapshot.activeGraphSource === "CURRENT_DRAFT"
                    ? "Current draft"
                    : sessionSnapshot.activeGraphSource === "LAST_VALID"
                      ? "Last valid revision"
                      : "Unavailable"
                }
              />
              <DetailRow
                label="Schema actions"
                value={sessionSnapshot.canUseValidSchema ? "Available" : "Disabled"}
              />
            </dl>
          </section>

          <SessionRecoveryPanel
            snapshot={sessionSnapshot}
            session={sessionRef.current}
            onLoadServer={() => {
              const source = sessionRef.current?.loadServerDraft();
              if (source !== null && source !== undefined) editorRef.current?.replaceSource(source);
            }}
          />

          <ProblemsPanel
            diagnostics={sessionSnapshot.diagnostics}
            onNavigate={(diagnostic) => editorRef.current?.navigateToDiagnostic(diagnostic)}
          />
        </aside>

        {activeGraph ? (
          <SchemaOutline
            graph={activeGraph}
            selectionStore={selectionStore}
            sourceNavigationEnabled={sourceNavigationEnabled}
            onNavigateSource={handleNavigateSource}
          />
        ) : null}
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {persistenceLabel(sessionSnapshot.persistence)}.{" "}
        {validationLabel(sessionSnapshot.validation)}.
      </p>

      <UnsavedNavigationDialog blocker={navigationBlocker} snapshot={sessionSnapshot} />
    </>
  );
}

function DiagramPanel({
  snapshot,
  selectionStore,
  DiagramComponent,
  sourceNavigationEnabled,
  onNavigateSource,
  onFocusSource,
}: {
  readonly snapshot: SourceSessionSnapshot;
  readonly selectionStore: ReturnType<typeof createDiagramSelectionStore>;
  readonly DiagramComponent: BaseSchemaDiagramComponent;
  readonly sourceNavigationEnabled: boolean;
  readonly onNavigateSource: (selection: DiagramSelection) => void;
  readonly onFocusSource: () => void;
}) {
  const graph = snapshot.activeGraph;
  const showingLastValid = snapshot.activeGraphSource === "LAST_VALID";
  const lastValidRevisionNo = snapshot.serverState.lastValidRevision?.revisionNo;

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
      <div className="border-b border-slate-700 px-4 py-3">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
          Read-only ER diagram
        </p>
        <p className="mt-1 text-xs text-slate-400" aria-live="polite">
          {showingLastValid
            ? `Showing last-valid revision ${lastValidRevisionNo ?? "unknown"}. Source navigation is disabled until the current draft is valid.`
            : graph
              ? "Showing the current valid draft. Select a table, column, or relationship to open its source."
              : "Waiting for a valid schema graph."}
        </p>
      </div>
      {graph ? (
        <Suspense
          fallback={
            <div className="grid min-h-[32rem] place-items-center bg-slate-950 text-slate-300">
              <p aria-live="polite">Loading local diagram assets…</p>
            </div>
          }
        >
          <DiagramComponent
            graph={graph}
            selectionStore={selectionStore}
            sourceNavigationEnabled={sourceNavigationEnabled}
            onNavigateSource={onNavigateSource}
          />
        </Suspense>
      ) : (
        <div className="grid min-h-[32rem] place-items-center bg-slate-950 p-6 text-center">
          <div>
            <p className="font-semibold text-slate-100">No valid diagram yet</p>
            <p className="mt-2 max-w-md text-sm text-slate-400">
              Fix the current DBML diagnostics to create the first valid diagram.
            </p>
            <button
              className="mt-4 rounded-lg border border-slate-600 px-3 py-2 text-sm font-semibold text-cyan-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
              type="button"
              onClick={onFocusSource}
            >
              Focus source editor
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function SessionRecoveryPanel({
  snapshot,
  session,
  onLoadServer,
}: {
  readonly snapshot: SourceSessionSnapshot;
  readonly session: SourceSessionController | null;
  readonly onLoadServer: () => void;
}) {
  if (snapshot.persistence === "CONFLICT") {
    return (
      <section className="rounded-2xl border border-amber-300/50 bg-amber-950/30 p-5" role="alert">
        <h2 className="font-semibold text-amber-100">Draft conflict</h2>
        <p className="mt-2 text-sm text-amber-100/80">
          The server draft changed. Your local buffer was preserved and autosave is paused.
        </p>
        {snapshot.persistenceError?.currentRevisionNo ? (
          <p className="mt-2 text-xs text-amber-100/70">
            Current server revision: {snapshot.persistenceError.currentRevisionNo}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="min-h-10 rounded-lg bg-amber-200 px-3 text-sm font-semibold text-amber-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200 disabled:opacity-50"
            type="button"
            disabled={!snapshot.conflictState}
            onClick={() => session?.retryLocalDraft()}
          >
            Retry local draft
          </button>
          <ConflictLoadDialog
            snapshot={snapshot}
            disabled={!snapshot.conflictState}
            onLoad={onLoadServer}
          />
        </div>
      </section>
    );
  }

  if (snapshot.persistence === "ERROR" || snapshot.validation === "ERROR") {
    return (
      <section className="rounded-2xl border border-red-400/40 bg-red-950/30 p-5" role="alert">
        <h2 className="font-semibold text-red-100">Workspace needs attention</h2>
        {snapshot.persistenceError ? (
          <ErrorDescription title="Save error" error={snapshot.persistenceError} />
        ) : null}
        {snapshot.validationError ? (
          <ErrorDescription title="Validation error" error={snapshot.validationError} />
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {snapshot.persistence === "ERROR" ? (
            <button
              className={secondaryButtonClass}
              type="button"
              onClick={() => session?.retrySave()}
            >
              Retry save
            </button>
          ) : null}
          {snapshot.validation === "ERROR" ? (
            <button
              className={secondaryButtonClass}
              type="button"
              onClick={() => session?.retryValidation()}
            >
              Retry validation
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  return null;
}

function ProblemsPanel({
  diagnostics,
  onNavigate,
}: {
  readonly diagnostics: SourceSessionSnapshot["diagnostics"];
  readonly onNavigate: (diagnostic: SourceSessionSnapshot["diagnostics"][number]) => void;
}) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-white">Problems</h2>
        <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">
          {diagnostics.length}
        </span>
      </div>
      {diagnostics.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400">No diagnostics for the current buffer.</p>
      ) : (
        <ol className="mt-4 space-y-3">
          {diagnostics.map((diagnostic) => (
            <li
              className="rounded-lg border border-slate-700 bg-slate-950/60 p-3"
              key={`${diagnostic.code}:${diagnostic.severity}:${diagnostic.range?.filepath ?? "none"}:${diagnostic.range?.startOffset ?? "none"}:${diagnostic.message}`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-slate-300">
                  {diagnostic.severity}
                </span>
                {diagnostic.range ? (
                  <button
                    className="text-xs font-semibold text-cyan-300 underline decoration-cyan-300/40 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
                    type="button"
                    aria-label={`Go to ${diagnostic.code}`}
                    onClick={() => onNavigate(diagnostic)}
                  >
                    {diagnostic.range.startLine}:{diagnostic.range.startColumn}
                  </button>
                ) : null}
              </div>
              <p className="mt-2 break-words text-sm text-slate-200">{diagnostic.message}</p>
              <p className="mt-2 break-all text-[0.7rem] text-slate-500">{diagnostic.code}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ConflictLoadDialog({
  snapshot,
  disabled,
  onLoad,
}: {
  readonly snapshot: SourceSessionSnapshot;
  readonly disabled: boolean;
  readonly onLoad: () => void;
}) {
  const [open, setOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  if (snapshot.persistence !== "CONFLICT") return null;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className={secondaryButtonClass} type="button" disabled={disabled}>
          Load server draft
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/80" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
        >
          <Dialog.Title className="text-xl font-semibold">Load server draft?</Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-slate-300">
            This replaces unsaved local source with server revision{" "}
            {snapshot.conflictState?.project.schemaRevisionNo ?? "unknown"}. This action cannot be
            undone in this session.
          </Dialog.Description>
          <div className="mt-6 flex flex-row-reverse flex-wrap gap-3">
            <button
              className="min-h-11 rounded-lg bg-red-300 px-4 font-semibold text-red-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300"
              type="button"
              onClick={() => {
                onLoad();
                setOpen(false);
              }}
            >
              Load server draft
            </button>
            <Dialog.Close asChild>
              <button ref={cancelRef} className={secondaryButtonClass} type="button">
                Cancel
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function UnsavedNavigationDialog({
  blocker,
  snapshot,
}: {
  readonly blocker: ReturnType<typeof useBlocker>;
  readonly snapshot: SourceSessionSnapshot;
}) {
  const stayRef = useRef<HTMLButtonElement>(null);
  const open = blocker.state === "blocked";
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && blocker.state === "blocked") blocker.reset();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/80" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            stayRef.current?.focus();
          }}
        >
          <Dialog.Title className="text-xl font-semibold">Leave source workspace?</Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-slate-300">
            {snapshot.persistence === "SAVING" || snapshot.persistence === "DIRTY"
              ? "The current draft is being saved. Navigation will continue automatically after it succeeds."
              : "Local edits have not been saved. Leaving now discards edits that were not sent; a write already sent to the server may still commit."}
          </Dialog.Description>
          <div className="mt-6 flex flex-row-reverse flex-wrap gap-3">
            <button
              className="min-h-11 rounded-lg bg-red-300 px-4 font-semibold text-red-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300"
              type="button"
              onClick={() => {
                if (blocker.state === "blocked") blocker.proceed();
              }}
            >
              Leave workspace
            </button>
            <button
              ref={stayRef}
              className={secondaryButtonClass}
              type="button"
              onClick={() => {
                if (blocker.state === "blocked") blocker.reset();
              }}
            >
              Stay
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function StatusBadge({ label, testId }: { readonly label: string; readonly testId: string }) {
  return (
    <span
      className="inline-flex min-h-8 items-center rounded-full border border-slate-600 bg-slate-950 px-3 text-xs font-semibold text-slate-200"
      data-testid={testId}
    >
      <span aria-hidden="true" className="mr-1.5 text-cyan-300">
        ●
      </span>
      {label}
    </span>
  );
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-1 font-semibold text-slate-200">{value}</dd>
    </div>
  );
}

function ErrorDescription({
  title,
  error,
}: {
  readonly title: string;
  readonly error: NonNullable<SourceSessionSnapshot["persistenceError"]>;
}) {
  return (
    <div className="mt-3 text-sm text-red-100/80">
      <p>
        <strong>{title}:</strong> {error.message}
      </p>
      {error.correlationId ? (
        <p className="mt-1 text-xs">Correlation ID: {error.correlationId}</p>
      ) : null}
    </div>
  );
}

function persistenceLabel(status: SourcePersistenceStatus): string {
  return {
    SAVED: "Saved",
    DIRTY: "Unsaved changes",
    SAVING: "Saving",
    ERROR: "Save error",
    CONFLICT: "Conflict",
  }[status];
}

function validationLabel(status: SourceValidationStatus): string {
  return {
    PENDING: "Validation pending",
    VALIDATING: "Validating",
    VALID: "Draft valid",
    INVALID: "Draft invalid",
    ERROR: "Validation error",
  }[status];
}

const secondaryButtonClass =
  "min-h-10 rounded-lg border border-slate-600 px-3 text-sm font-semibold text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:opacity-50";
