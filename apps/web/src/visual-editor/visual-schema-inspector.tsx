import type { Diagnostic, PrimaryDialect, SourceRange } from "@er-diagram/contracts";
import type { SchemaGraph } from "@er-diagram/core";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { DiagramSelectionStore } from "../diagram/selection-store.js";
import { VisualCommandForm } from "./visual-command-form.js";
import type {
  VisualCommandDraft,
  VisualCommandSessionController,
  VisualCommandSessionSnapshot,
} from "./visual-command-session.js";
import {
  createInitialVisualDraft,
  findColumn,
  findPartialProvenance,
  listVisualEditorActions,
  type VisualEditorAction,
} from "./visual-editor-model.js";

export function VisualSchemaInspector({
  graph,
  primaryDialect,
  currentViewKey,
  selectionStore,
  commandSession,
  interactionDisabled,
  sourceNavigationEnabled,
  onOpenSource,
  onReloadLayouts,
}: {
  readonly graph: SchemaGraph;
  readonly primaryDialect: PrimaryDialect;
  readonly currentViewKey: string;
  readonly selectionStore: DiagramSelectionStore;
  readonly commandSession: VisualCommandSessionController;
  readonly interactionDisabled: boolean;
  readonly sourceNavigationEnabled: boolean;
  readonly onOpenSource: (range: SourceRange | null) => void;
  readonly onReloadLayouts: () => void;
}) {
  const selection = useSyncExternalStore(
    selectionStore.subscribe,
    () => selectionStore.getState().selection,
    () => null,
  );
  const commandSnapshot = useSyncExternalStore(
    commandSession.subscribe,
    commandSession.getSnapshot,
    commandSession.getSnapshot,
  );
  const actions = useMemo(
    () => listVisualEditorActions(graph, selection, currentViewKey),
    [currentViewKey, graph, selection],
  );
  const [activeAction, setActiveAction] = useState<VisualEditorAction | null>(null);
  const [activeToolbarIndex, setActiveToolbarIndex] = useState(0);
  const actionButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [openedSchemaHash, setOpenedSchemaHash] = useState(graph.schemaHash);
  const [openedSelection, setOpenedSelection] = useState(selection);
  const partialProvenance = findPartialProvenance(graph, selection);
  const activeDraft = activeAction
    ? createInitialVisualDraft(graph, selection, activeAction)
    : null;
  const busy = isBusy(commandSnapshot) || interactionDisabled;

  useEffect(() => {
    if (commandSnapshot.status === "SUCCEEDED") {
      setActiveAction(null);
      setOpenedSelection(null);
    }
  }, [commandSnapshot.status]);

  useEffect(() => {
    if (
      activeAction &&
      commandSnapshot.status === "IDLE" &&
      !actions.some((action) => action.id === activeAction.id)
    ) {
      setActiveAction(null);
      setOpenedSelection(null);
    }
  }, [actions, activeAction, commandSnapshot.status]);

  useEffect(() => {
    actionButtonRefs.current.length = actions.length;
    setActiveToolbarIndex((current) => Math.min(current, Math.max(0, actions.length - 1)));
  }, [actions.length]);

  useEffect(() => {
    if (
      commandSnapshot.status !== "STALE_REVIEW" ||
      !openedSelection ||
      !graph.sourceMap[openedSelection.elementKey]
    ) {
      return;
    }
    selectionStore.getState().setSelection(openedSelection);
  }, [commandSnapshot.status, graph.sourceMap, openedSelection, selectionStore]);

  const openAction = (action: VisualEditorAction) => {
    commandSession.reset();
    setOpenedSchemaHash(graph.schemaHash);
    setOpenedSelection(selection);
    setActiveAction(action);
  };

  const submit = (draft: VisualCommandDraft) => {
    void commandSession.submit(draft, openedSchemaHash);
  };

  return (
    <aside
      className="border-t border-slate-700 bg-slate-900 p-4"
      aria-label="Visual schema inspector"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-semibold text-white">Visual schema inspector</h2>
          <p className="mt-1 text-xs text-slate-400">
            Select a diagram element, review a typed form, then apply one source-preserving command.
          </p>
        </div>
        <p className="text-xs font-semibold text-cyan-200" aria-live="polite">
          {selectionLabel(graph, selection)}
        </p>
      </div>

      {partialProvenance ? (
        <PartialSelectionNotice
          graph={graph}
          partialKey={partialProvenance.partialKey}
          partialElementKey={partialProvenance.partialElementKey}
          injectionRange={partialProvenance.injectionRange}
          sourceNavigationEnabled={sourceNavigationEnabled}
          onOpenSource={onOpenSource}
        />
      ) : null}

      <div
        className="mt-4 flex max-h-44 flex-wrap gap-2 overflow-auto"
        role="toolbar"
        aria-label="Visual schema actions"
        aria-orientation="horizontal"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const enabledIndexes = actionButtonRefs.current.flatMap((button, index) =>
            button && !button.disabled ? [index] : [],
          );
          if (enabledIndexes.length === 0) return;
          const focusedIndex =
            document.activeElement instanceof HTMLButtonElement
              ? actionButtonRefs.current.indexOf(document.activeElement)
              : -1;
          const currentIndex = focusedIndex >= 0 ? focusedIndex : activeToolbarIndex;
          const enabledPosition = Math.max(0, enabledIndexes.indexOf(currentIndex));
          const nextIndex =
            event.key === "Home"
              ? enabledIndexes[0]
              : event.key === "End"
                ? enabledIndexes.at(-1)
                : event.key === "ArrowRight"
                  ? enabledIndexes[(enabledPosition + 1) % enabledIndexes.length]
                  : enabledIndexes[
                      (enabledPosition - 1 + enabledIndexes.length) % enabledIndexes.length
                    ];
          if (nextIndex === undefined) return;
          setActiveToolbarIndex(nextIndex);
          actionButtonRefs.current[nextIndex]?.focus();
        }}
      >
        {actions.map((action, index) => (
          <button
            key={action.id}
            ref={(button) => {
              actionButtonRefs.current[index] = button;
            }}
            className={action.kind.startsWith("DELETE_") ? dangerButtonClass : actionButtonClass}
            type="button"
            disabled={busy}
            tabIndex={index === activeToolbarIndex ? 0 : -1}
            aria-pressed={activeAction?.id === action.id}
            onFocus={() => setActiveToolbarIndex(index)}
            onClick={() => openAction(action)}
          >
            {action.label}
          </button>
        ))}
      </div>

      {activeAction && activeDraft ? (
        <VisualCommandForm
          key={activeAction.id}
          graph={graph}
          primaryDialect={primaryDialect}
          action={activeAction}
          initialDraft={activeDraft}
          disabled={busy || commandSnapshot.status === "STALE_REVIEW"}
          onCancel={() => {
            setActiveAction(null);
            setOpenedSelection(null);
            commandSession.reset();
          }}
          onSubmit={submit}
        />
      ) : activeAction ? (
        <p className="mt-4 text-sm text-red-100" role="alert">
          The selected schema target is no longer available.
        </p>
      ) : null}

      <CommandStatusPanel
        snapshot={commandSnapshot}
        fallbackRange={selection ? (graph.sourceMap[selection.elementKey] ?? null) : null}
        sourceNavigationEnabled={sourceNavigationEnabled}
        onOpenSource={onOpenSource}
        onReloadLayouts={onReloadLayouts}
        onRetry={() => void commandSession.retrySafely()}
        onReview={() => {
          if (openedSelection && graph.sourceMap[openedSelection.elementKey]) {
            selectionStore.getState().setSelection(openedSelection);
          } else {
            setActiveAction(null);
            setOpenedSelection(null);
          }
          setOpenedSchemaHash(graph.schemaHash);
          commandSession.reviewLatestSchema();
        }}
      />
    </aside>
  );
}

function CommandStatusPanel({
  snapshot,
  fallbackRange,
  sourceNavigationEnabled,
  onOpenSource,
  onReloadLayouts,
  onRetry,
  onReview,
}: {
  readonly snapshot: VisualCommandSessionSnapshot;
  readonly fallbackRange: SourceRange | null;
  readonly sourceNavigationEnabled: boolean;
  readonly onOpenSource: (range: SourceRange | null) => void;
  readonly onReloadLayouts: () => void;
  readonly onRetry: () => void;
  readonly onReview: () => void;
}) {
  if (snapshot.status === "IDLE") return null;
  if (isBusy(snapshot)) {
    return (
      <p
        className="mt-4 rounded-lg border border-cyan-400/30 bg-cyan-950/30 p-3 text-sm text-cyan-100"
        aria-live="polite"
      >
        {snapshot.status === "FLUSHING_SOURCE"
          ? "Saving and validating source before the command…"
          : snapshot.status === "FLUSHING_LAYOUT"
            ? "Saving loaded diagram layouts before the command…"
            : "Applying the visual command once…"}
      </p>
    );
  }
  if (snapshot.status === "SUCCEEDED") {
    return (
      <section
        className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-950/30 p-3 text-sm text-emerald-100"
        aria-live="polite"
      >
        <p>
          {snapshot.mutation?.replayed
            ? "The saved command receipt was replayed without creating another revision."
            : snapshot.mutation?.revisionCreated
              ? `Visual command applied as schema revision ${snapshot.mutation.appliedSchemaRevisionNo}.`
              : "The command was a semantic no-op; no schema revision was created."}
          {snapshot.layoutRefreshFailed
            ? " The schema commit succeeded, but layout interaction is disabled until layout reload succeeds."
            : ""}
        </p>
        {snapshot.layoutRefreshFailed ? (
          <button
            className={`${secondaryButtonClass} mt-3`}
            type="button"
            onClick={onReloadLayouts}
          >
            Reload layouts
          </button>
        ) : null}
      </section>
    );
  }

  const error = snapshot.error;
  if (!error) return null;
  return (
    <section className="mt-4 rounded-xl border border-red-400/40 bg-red-950/30 p-4" role="alert">
      <h3 className="font-semibold text-red-100">
        {snapshot.status === "STALE_REVIEW"
          ? "Review the latest schema"
          : snapshot.status === "UNKNOWN_OUTCOME"
            ? "Command outcome is not confirmed"
            : "Visual command was not applied"}
      </h3>
      <p className="mt-2 text-sm text-red-100/90">{error.message}</p>
      {error.correlationId ? (
        <p className="mt-2 text-xs text-red-100/70">Correlation ID: {error.correlationId}</p>
      ) : null}
      {error.diagnostics.length > 0 ? (
        <ul className="mt-3 space-y-2" aria-label="Visual command diagnostics">
          {error.diagnostics.map((diagnostic) => (
            <li
              key={diagnosticIdentity(diagnostic)}
              className="rounded-lg border border-red-300/20 p-3 text-sm"
            >
              <p className="font-semibold">{diagnostic.code}</p>
              <p className="mt-1">{diagnostic.message}</p>
              <button
                className={`${secondaryButtonClass} mt-2`}
                type="button"
                disabled={!sourceNavigationEnabled}
                onClick={() => onOpenSource(diagnostic.range ?? fallbackRange)}
              >
                Open in source
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error.partialImpact ? (
        <div className="mt-4 rounded-lg border border-amber-300/30 bg-amber-950/30 p-3 text-amber-100">
          <p className="font-semibold">
            Partial {error.partialImpact.partialName} owns this element
          </p>
          <button
            className={`${secondaryButtonClass} mt-2`}
            type="button"
            disabled={!sourceNavigationEnabled}
            onClick={() => onOpenSource(error.partialImpact?.definitionRange ?? null)}
          >
            Open partial definition
          </button>
          <ul className="mt-3 space-y-2">
            {error.partialImpact.affectedTables.map((table) => (
              <li
                key={`${table.tableKey}-${table.injectionRange.startOffset}`}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <code className="break-all">{table.tableKey}</code>
                <button
                  className={secondaryButtonClass}
                  type="button"
                  disabled={!sourceNavigationEnabled}
                  onClick={() => onOpenSource(table.injectionRange)}
                >
                  Open injection
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {snapshot.status === "UNKNOWN_OUTCOME" ? (
          <button className={primaryButtonClass} type="button" onClick={onRetry}>
            Retry safely
          </button>
        ) : null}
        {snapshot.status === "STALE_REVIEW" ? (
          <button className={primaryButtonClass} type="button" onClick={onReview}>
            Review latest schema
          </button>
        ) : null}
      </div>
    </section>
  );
}

function PartialSelectionNotice({
  graph,
  partialKey,
  partialElementKey,
  injectionRange,
  sourceNavigationEnabled,
  onOpenSource,
}: {
  readonly graph: SchemaGraph;
  readonly partialKey: string;
  readonly partialElementKey: string;
  readonly injectionRange: SourceRange;
  readonly sourceNavigationEnabled: boolean;
  readonly onOpenSource: (range: SourceRange | null) => void;
}) {
  const partial = graph.partials.find((candidate) => candidate.key === partialKey);
  const definitionRange = graph.sourceMap[partialElementKey] ?? null;
  const affectedTables = collectPartialAffectedTables(graph, partialKey, injectionRange);
  const provenanceComplete = definitionRange !== null && affectedTables.length > 0;
  return (
    <section className="mt-4 rounded-xl border border-amber-300/40 bg-amber-950/30 p-4 text-sm text-amber-100">
      <p className="font-semibold">Partial {partial?.name ?? "definition"} owns this element</p>
      <p className="mt-1">
        {provenanceComplete
          ? "Visual mutation is disabled. Open the canonical partial definition or an affected table injection."
          : "Visual mutation is disabled. Provenance is incomplete, so no source location is inferred."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {provenanceComplete ? (
          <button
            className={secondaryButtonClass}
            type="button"
            disabled={!sourceNavigationEnabled}
            onClick={() => onOpenSource(definitionRange)}
          >
            Open partial definition
          </button>
        ) : null}
        {!provenanceComplete ? (
          <button className={secondaryButtonClass} type="button" onClick={() => onOpenSource(null)}>
            Focus source editor
          </button>
        ) : null}
      </div>
      {provenanceComplete ? (
        <ul className="mt-3 space-y-2" aria-label="Affected partial tables">
          {affectedTables.map((affected) => (
            <li
              key={`${affected.tableKey}-${affected.range.startOffset}`}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <code className="break-all text-xs">{affected.tableKey}</code>
              <button
                className={secondaryButtonClass}
                type="button"
                disabled={!sourceNavigationEnabled}
                onClick={() => onOpenSource(affected.range)}
              >
                Open table injection
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function collectPartialAffectedTables(
  graph: SchemaGraph,
  partialKey: string,
  selectedInjectionRange: SourceRange,
): Array<{ readonly tableKey: string; readonly range: SourceRange }> {
  const values: Array<{ tableKey: string; range: SourceRange }> = [];
  for (const table of graph.tables) {
    const provenances = [
      ...table.columns.map((element) => element.injectedFrom),
      ...table.indexes.map((element) => element.injectedFrom),
      ...table.checks.map((element) => element.injectedFrom),
      ...table.columns.flatMap((column) => column.checks.map((element) => element.injectedFrom)),
    ].filter((value) => value?.partialKey === partialKey);
    for (const provenance of provenances) {
      if (provenance) values.push({ tableKey: table.key, range: provenance.injectionRange });
    }
  }
  for (const reference of graph.references) {
    if (reference.injectedFrom?.partialKey !== partialKey) continue;
    for (const tableKey of reference.endpoints.map((endpoint) => endpoint.tableKey)) {
      values.push({ tableKey, range: reference.injectedFrom.injectionRange });
    }
  }
  if (values.length === 0) {
    const selectedTable = graph.tables.find((table) =>
      table.columns.some((column) => column.injectedFrom?.partialKey === partialKey),
    );
    if (selectedTable) values.push({ tableKey: selectedTable.key, range: selectedInjectionRange });
  }
  const unique = new Map(
    values.map((value) => [
      `${value.tableKey}:${value.range.filepath}:${value.range.startOffset}:${value.range.endOffset}`,
      value,
    ]),
  );
  return [...unique.values()].sort((left, right) =>
    left.tableKey === right.tableKey
      ? left.range.startOffset - right.range.startOffset
      : left.tableKey < right.tableKey
        ? -1
        : 1,
  );
}

function selectionLabel(
  graph: SchemaGraph,
  selection: ReturnType<DiagramSelectionStore["getState"]>["selection"],
): string {
  if (!selection) return "No diagram element selected";
  if (selection.kind === "table") {
    const table = graph.tables.find((candidate) => candidate.key === selection.elementKey);
    return table
      ? `Selected table ${table.schemaName}.${table.name}`
      : "Selected table unavailable";
  }
  if (selection.kind === "column") {
    const resolved = findColumn(graph, selection.elementKey);
    return resolved
      ? `Selected column ${resolved.table.name}.${resolved.column.name}`
      : "Selected column unavailable";
  }
  if (selection.kind === "reference") return "Selected relationship";
  return "Selected TableGroup";
}

function isBusy(snapshot: VisualCommandSessionSnapshot): boolean {
  return (
    snapshot.status === "FLUSHING_SOURCE" ||
    snapshot.status === "FLUSHING_LAYOUT" ||
    snapshot.status === "SUBMITTING"
  );
}

function diagnosticIdentity(diagnostic: Diagnostic): string {
  const range = diagnostic.range;
  return `${diagnostic.code}:${diagnostic.message}:${range?.filepath ?? "none"}:${range?.startOffset ?? "none"}:${range?.endOffset ?? "none"}`;
}

const actionButtonClass =
  "min-h-10 rounded-lg border border-cyan-400/40 px-3 text-sm font-semibold text-cyan-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:bg-cyan-950";
const dangerButtonClass =
  "min-h-10 rounded-lg border border-red-400/50 px-3 text-sm font-semibold text-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300 disabled:cursor-not-allowed disabled:opacity-50";
const primaryButtonClass =
  "min-h-10 rounded-lg bg-cyan-300 px-4 text-sm font-bold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300";
const secondaryButtonClass =
  "min-h-10 rounded-lg border border-slate-600 px-3 text-sm font-semibold text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-50";
