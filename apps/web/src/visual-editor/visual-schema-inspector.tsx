import type {
  Diagnostic,
  DiagramNodePlacement,
  PrimaryDialect,
  SourceRange,
} from "@er-diagram/contracts";
import type { SchemaGraph } from "@er-diagram/core";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { DiagramSelectionStore } from "../diagram/selection-store.js";
import {
  DEFAULT_TABLE_WIDTH,
  MINIMUM_TABLE_WIDTH,
  tableMinimumHeightInGraph,
} from "../diagram/projection.js";
import type { DiagramLod } from "../diagram/types.js";
import type { UiMessages } from "../localization/messages.js";
import { useUiLocale } from "../localization/ui-locale.js";
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
  layoutPositions,
  detailLevel = "FULL",
  onApplyTableSize,
  onResetTableSize,
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
  readonly layoutPositions?: Readonly<Record<string, DiagramNodePlacement>>;
  readonly detailLevel?: DiagramLod;
  readonly onApplyTableSize?: (tableKey: string, width: number, height: number) => void;
  readonly onResetTableSize?: (tableKey: string) => void;
}) {
  const { messages } = useUiLocale();
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
  const selectedTable =
    selection?.kind === "table"
      ? (graph.tables.find((table) => table.key === selection.elementKey) ?? null)
      : null;
  const activeDraft = activeAction
    ? createInitialVisualDraft(graph, selection, activeAction)
    : null;
  const busy = isVisualCommandSessionBusy(commandSnapshot) || interactionDisabled;
  const activeActionLabel = activeAction ? visualActionLabel(graph, activeAction, messages) : null;

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
    <section
      className="min-w-0 break-words bg-slate-900 p-4 [overflow-wrap:anywhere]"
      aria-label={messages["inspector.title"]}
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-semibold text-white">{messages["inspector.title"]}</h2>
          <p className="mt-1 min-w-0 break-words text-xs text-slate-400 [overflow-wrap:anywhere]">
            {messages["visual.inspectorDescription"]}
          </p>
        </div>
        {selection ? (
          <p
            className="min-w-0 break-words text-xs font-semibold text-cyan-200 [overflow-wrap:anywhere]"
            aria-live="polite"
          >
            {selectionLabel(graph, selection, messages)}
          </p>
        ) : null}
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

      {selectedTable && onApplyTableSize && onResetTableSize ? (
        <TableSizeControls
          key={`${currentViewKey}:${selectedTable.key}`}
          tableKey={selectedTable.key}
          minimumHeight={tableMinimumHeightInGraph(graph, selectedTable.key, detailLevel)}
          placement={layoutPositions?.[selectedTable.key]}
          disabled={busy}
          onApply={onApplyTableSize}
          onReset={onResetTableSize}
        />
      ) : null}

      <div
        className="mt-4 flex max-h-44 flex-wrap gap-2 overflow-auto"
        role="toolbar"
        aria-label={messages["visual.actions"]}
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
            {visualActionLabel(graph, action, messages)}
          </button>
        ))}
      </div>

      {activeAction && activeDraft ? (
        <VisualCommandForm
          key={activeAction.id}
          graph={graph}
          primaryDialect={primaryDialect}
          action={activeAction}
          displayLabel={activeActionLabel ?? activeAction.label}
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
          {messages["visual.targetUnavailable"]}
        </p>
      ) : null}

      <VisualCommandStatusPanel
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
    </section>
  );
}

function TableSizeControls({
  tableKey,
  minimumHeight,
  placement,
  disabled,
  onApply,
  onReset,
}: {
  readonly tableKey: string;
  readonly minimumHeight: number;
  readonly placement: DiagramNodePlacement | undefined;
  readonly disabled: boolean;
  readonly onApply: (tableKey: string, width: number, height: number) => void;
  readonly onReset: (tableKey: string) => void;
}) {
  const { messages } = useUiLocale();
  const effectiveWidth = Math.max(MINIMUM_TABLE_WIDTH, placement?.width ?? DEFAULT_TABLE_WIDTH);
  const effectiveHeight = Math.max(minimumHeight, placement?.height ?? minimumHeight);
  const [width, setWidth] = useState(String(effectiveWidth));
  const [height, setHeight] = useState(String(effectiveHeight));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setWidth(String(effectiveWidth));
    setHeight(String(effectiveHeight));
    setInvalid(false);
  }, [effectiveHeight, effectiveWidth]);

  const apply = () => {
    const parsedWidth = Number(width);
    const parsedHeight = Number(height);
    if (
      !Number.isSafeInteger(parsedWidth) ||
      !Number.isSafeInteger(parsedHeight) ||
      parsedWidth < MINIMUM_TABLE_WIDTH ||
      parsedHeight < minimumHeight
    ) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onApply(tableKey, parsedWidth, parsedHeight);
  };

  return (
    <section className="mt-4 rounded-xl border border-slate-700 bg-slate-950/45 p-3">
      <h3 className="text-sm font-semibold text-slate-100">{messages["visual.tableSizeTitle"]}</h3>
      <p className="mt-1 text-xs text-slate-400">{messages["visual.tableSizeDescription"]}</p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="text-xs font-semibold text-slate-200">
          {messages["visual.tableWidth"]}
          <input
            className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            type="number"
            min={MINIMUM_TABLE_WIDTH}
            step={1}
            value={width}
            disabled={disabled}
            aria-invalid={invalid}
            onChange={(event) => setWidth(event.currentTarget.value)}
          />
        </label>
        <label className="text-xs font-semibold text-slate-200">
          {messages["visual.tableHeight"]}
          <input
            className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            type="number"
            min={minimumHeight}
            step={1}
            value={height}
            disabled={disabled}
            aria-invalid={invalid}
            onChange={(event) => setHeight(event.currentTarget.value)}
          />
        </label>
      </div>
      {invalid ? (
        <p className="mt-2 text-xs text-red-200" role="alert">
          {messages["visual.tableSizeInvalid"]}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={primaryButtonClass} type="button" disabled={disabled} onClick={apply}>
          {messages["visual.applyTableSize"]}
        </button>
        <button
          className={secondaryButtonClass}
          type="button"
          disabled={disabled || placement?.width === undefined}
          onClick={() => {
            onReset(tableKey);
            setWidth(String(DEFAULT_TABLE_WIDTH));
            setHeight(String(minimumHeight));
            setInvalid(false);
          }}
        >
          {messages["visual.resetTableSize"]}
        </button>
      </div>
    </section>
  );
}

export function VisualCommandStatusPanel({
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
  const { messages } = useUiLocale();
  if (snapshot.status === "IDLE") return null;
  if (isVisualCommandSessionBusy(snapshot)) {
    return (
      <p
        className="mt-4 rounded-lg border border-cyan-400/30 bg-cyan-950/30 p-3 text-sm text-cyan-100"
        aria-live="polite"
      >
        {snapshot.status === "FLUSHING_SOURCE"
          ? messages["visual.commandFlushingSource"]
          : snapshot.status === "FLUSHING_LAYOUT"
            ? messages["visual.commandFlushingLayout"]
            : messages["visual.commandApplying"]}
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
            ? messages["visual.commandReplayed"]
            : snapshot.mutation?.revisionCreated
              ? messages["visual.commandApplied"](snapshot.mutation.appliedSchemaRevisionNo)
              : messages["visual.commandNoop"]}
          {snapshot.layoutRefreshFailed ? messages["visual.layoutRefreshFailed"] : ""}
        </p>
        {snapshot.layoutRefreshFailed ? (
          <button
            className={`${secondaryButtonClass} mt-3`}
            type="button"
            onClick={onReloadLayouts}
          >
            {messages["visual.reloadLayouts"]}
          </button>
        ) : null}
      </section>
    );
  }

  const error = snapshot.error;
  if (!error) return null;
  return (
    <section
      className="mt-4 min-w-0 break-words rounded-xl border border-red-400/40 bg-red-950/30 p-4 [overflow-wrap:anywhere]"
      role="alert"
    >
      <h3 className="font-semibold text-red-100">
        {snapshot.status === "STALE_REVIEW"
          ? messages["visual.reviewLatestTitle"]
          : snapshot.status === "UNKNOWN_OUTCOME"
            ? messages["visual.unknownOutcomeTitle"]
            : messages["visual.notAppliedTitle"]}
      </h3>
      <p className="mt-2 min-w-0 break-words text-sm text-red-100/90 [overflow-wrap:anywhere]">
        {error.message}
      </p>
      {error.correlationId ? (
        <p className="mt-2 break-all text-xs text-red-100/70">
          {messages["error.correlationId"](error.correlationId)}
        </p>
      ) : null}
      {error.diagnostics.length > 0 ? (
        <ul className="mt-3 space-y-2" aria-label={messages["visual.diagnostics"]}>
          {error.diagnostics.map((diagnostic) => (
            <li
              key={diagnosticIdentity(diagnostic)}
              className="rounded-lg border border-red-300/20 p-3 text-sm"
            >
              <p className="break-all font-semibold">{diagnostic.code}</p>
              <p className="mt-1 min-w-0 break-words [overflow-wrap:anywhere]">
                {diagnostic.message}
              </p>
              <button
                className={`${secondaryButtonClass} mt-2`}
                type="button"
                disabled={!sourceNavigationEnabled}
                onClick={() => onOpenSource(diagnostic.range ?? fallbackRange)}
              >
                {messages["visual.openInSource"]}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error.partialImpact ? (
        <div className="mt-4 rounded-lg border border-amber-300/30 bg-amber-950/30 p-3 text-amber-100">
          <p className="font-semibold">
            {messages["visual.partialOwns"](error.partialImpact.partialName)}
          </p>
          <button
            className={`${secondaryButtonClass} mt-2`}
            type="button"
            disabled={!sourceNavigationEnabled}
            onClick={() => onOpenSource(error.partialImpact?.definitionRange ?? null)}
          >
            {messages["visual.openPartialDefinition"]}
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
                  {messages["visual.openInjection"]}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {snapshot.status === "UNKNOWN_OUTCOME" ? (
          <button className={primaryButtonClass} type="button" onClick={onRetry}>
            {messages["visual.retrySafely"]}
          </button>
        ) : null}
        {snapshot.status === "STALE_REVIEW" ? (
          <button className={primaryButtonClass} type="button" onClick={onReview}>
            {messages["visual.reviewLatest"]}
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
  const { messages } = useUiLocale();
  const partial = graph.partials.find((candidate) => candidate.key === partialKey);
  const definitionRange = graph.sourceMap[partialElementKey] ?? null;
  const affectedTables = collectPartialAffectedTables(graph, partialKey, injectionRange);
  const provenanceComplete = definitionRange !== null && affectedTables.length > 0;
  return (
    <section className="mt-4 min-w-0 break-words rounded-xl border border-amber-300/40 bg-amber-950/30 p-4 text-sm text-amber-100 [overflow-wrap:anywhere]">
      <p className="font-semibold">
        {messages["visual.partialOwns"](partial?.name ?? messages["visual.partialDefinition"])}
      </p>
      <p className="mt-1">
        {provenanceComplete
          ? messages["visual.partialComplete"]
          : messages["visual.partialIncomplete"]}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {provenanceComplete ? (
          <button
            className={secondaryButtonClass}
            type="button"
            disabled={!sourceNavigationEnabled}
            onClick={() => onOpenSource(definitionRange)}
          >
            {messages["visual.openPartialDefinition"]}
          </button>
        ) : null}
        {!provenanceComplete ? (
          <button className={secondaryButtonClass} type="button" onClick={() => onOpenSource(null)}>
            {messages["source.focusEditor"]}
          </button>
        ) : null}
      </div>
      {provenanceComplete ? (
        <ul className="mt-3 space-y-2" aria-label={messages["visual.affectedPartialTables"]}>
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
                {messages["visual.openTableInjection"]}
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
  selection: NonNullable<ReturnType<DiagramSelectionStore["getState"]>["selection"]>,
  messages: UiMessages,
): string {
  if (selection.kind === "table") {
    const table = graph.tables.find((candidate) => candidate.key === selection.elementKey);
    return table
      ? messages["visual.selectedTable"](`${table.schemaName}.${table.name}`)
      : messages["visual.selectedTableUnavailable"];
  }
  if (selection.kind === "column") {
    const resolved = findColumn(graph, selection.elementKey);
    return resolved
      ? messages["visual.selectedColumn"](`${resolved.table.name}.${resolved.column.name}`)
      : messages["visual.selectedColumnUnavailable"];
  }
  if (selection.kind === "reference") return messages["visual.selectedReference"];
  return messages["visual.selectedGroup"];
}

function visualActionLabel(
  graph: SchemaGraph,
  action: VisualEditorAction,
  messages: UiMessages,
): string {
  const targetIndex = graph.tables
    .flatMap((table) => table.indexes)
    .find((index) => index.key === action.targetElementKey);
  const targetCheck = graph.tables
    .flatMap((table) => [...table.checks, ...table.columns.flatMap((column) => column.checks)])
    .find((check) => check.key === action.targetElementKey);
  const anonymous = messages["visual.anonymous"];
  switch (action.kind) {
    case "CREATE_TABLE":
      return messages["visual.action.createTable"];
    case "UPDATE_TABLE":
      return messages["visual.action.updateTable"];
    case "RENAME_TABLE":
      return messages["visual.action.renameTable"];
    case "DELETE_TABLE":
      return messages["visual.action.deleteTable"];
    case "CREATE_COLUMN":
      return messages["visual.action.createColumn"];
    case "ALTER_COLUMN":
      return messages["visual.action.alterColumn"];
    case "DELETE_COLUMN":
      return messages["visual.action.deleteColumn"];
    case "CREATE_REFERENCE":
      return messages["visual.action.createReference"];
    case "UPDATE_REFERENCE":
      return messages["visual.action.updateReference"];
    case "DELETE_REFERENCE":
      return messages["visual.action.deleteReference"];
    case "CREATE_INDEX":
      return messages["visual.action.createIndex"];
    case "UPDATE_INDEX":
      return messages["visual.action.updateIndex"](targetIndex?.name ?? anonymous);
    case "DELETE_INDEX":
      return messages["visual.action.deleteIndex"](targetIndex?.name ?? anonymous);
    case "CREATE_CHECK":
      return action.ownerColumnKey === null
        ? messages["visual.action.createTableCheck"]
        : messages["visual.action.createColumnCheck"];
    case "UPDATE_CHECK":
      return action.ownerColumnKey
        ? messages["visual.action.updateColumnCheck"]
        : messages["visual.action.updateCheck"](targetCheck?.name ?? anonymous);
    case "DELETE_CHECK":
      return action.ownerColumnKey
        ? messages["visual.action.deleteColumnCheck"]
        : messages["visual.action.deleteCheck"](targetCheck?.name ?? anonymous);
    case "UPDATE_GROUP_MEMBERSHIP":
      return messages["visual.action.updateGroup"];
    case "UPDATE_DIAGRAM_VIEW":
      return messages["visual.action.updateView"];
  }
}

export function isVisualCommandSessionBusy(snapshot: VisualCommandSessionSnapshot): boolean {
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

const actionButtonClass = "ui-button ui-button--action";
const dangerButtonClass = "ui-button ui-button--danger";
const primaryButtonClass = "ui-button ui-button--primary";
const secondaryButtonClass = "ui-button";
