import type { ProjectRevisionsResponse, SchemaRevisionSummary } from "@er-diagram/contracts";
import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";

import type { UiMessages } from "../localization/messages.js";
import { useUiLocale } from "../localization/ui-locale.js";
import type {
  SchemaHistorySessionController,
  SchemaHistorySessionSnapshot,
} from "./history-session.js";

export interface SchemaHistoryControlsProps {
  readonly session: SchemaHistorySessionController;
  readonly loadRevisions: () => Promise<ProjectRevisionsResponse>;
  readonly interactionDisabled?: boolean;
  readonly compact?: boolean;
}

export function SchemaHistoryControls({
  session,
  loadRevisions,
  interactionDisabled = false,
  compact = false,
}: SchemaHistoryControlsProps) {
  const { messages } = useUiLocale();
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<readonly SchemaRevisionSummary[]>([]);
  const [loadingRevisions, setLoadingRevisions] = useState(false);
  const [revisionsError, setRevisionsError] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<SchemaRevisionSummary | null>(null);

  const refreshRevisions = useCallback(async () => {
    setLoadingRevisions(true);
    setRevisionsError(false);
    try {
      const response = await loadRevisions();
      setRevisions(
        [...response.revisions].sort((left, right) => right.revisionNo - left.revisionNo),
      );
    } catch {
      setRevisionsError(true);
    } finally {
      setLoadingRevisions(false);
    }
  }, [loadRevisions]);

  const finishOperation = useCallback(async () => {
    if (session.getSnapshot().status === "SUCCEEDED" && historyOpen) {
      await refreshRevisions();
    }
  }, [historyOpen, refreshRevisions, session]);

  const runUndo = useCallback(async () => {
    await session.undo();
    await finishOperation();
  }, [finishOperation, session]);

  const runRedo = useCallback(async () => {
    await session.redo();
    await finishOperation();
  }, [finishOperation, session]);

  const retrySafely = useCallback(async () => {
    await session.retrySafely();
    await finishOperation();
  }, [finishOperation, session]);

  return (
    <section
      aria-label={messages["history.label"]}
      className={compact ? "contents" : "rounded-xl border border-slate-700 bg-slate-900/70 p-3"}
    >
      <div className={`flex items-center gap-2 ${compact ? "shrink-0" : "flex-wrap"}`}>
        <button
          aria-label={messages["history.undoAvailable"](
            messages["history.steps"](snapshot.past.length),
          )}
          className={secondaryButtonClass}
          type="button"
          disabled={interactionDisabled || !snapshot.canUndo}
          onClick={() => void runUndo()}
        >
          {messages["history.undo"]} <span aria-hidden="true">({snapshot.past.length})</span>
        </button>
        <button
          aria-label={messages["history.redoAvailable"](
            messages["history.steps"](snapshot.future.length),
          )}
          className={secondaryButtonClass}
          type="button"
          disabled={interactionDisabled || !snapshot.canRedo}
          onClick={() => void runRedo()}
        >
          {messages["history.redo"]} <span aria-hidden="true">({snapshot.future.length})</span>
        </button>

        <Dialog.Root
          open={historyOpen}
          onOpenChange={(open) => {
            setHistoryOpen(open);
            if (!open) {
              setRestoreTarget(null);
              return;
            }
            void refreshRevisions();
          }}
        >
          <Dialog.Trigger asChild>
            <button
              aria-label={compact ? messages["history.revisionHistory"] : undefined}
              className={secondaryButtonClass}
              type="button"
            >
              {compact ? messages["history.short"] : messages["history.revisionHistory"]}
            </button>
          </Dialog.Trigger>
          <RevisionHistoryDialog
            snapshot={snapshot}
            interactionDisabled={interactionDisabled}
            revisions={revisions}
            loading={loadingRevisions}
            loadFailed={revisionsError}
            restoreTarget={restoreTarget}
            onRetryLoad={() => void refreshRevisions()}
            onSelectRestore={setRestoreTarget}
            onCancelRestore={() => setRestoreTarget(null)}
            onConfirmRestore={async () => {
              if (!restoreTarget) return;
              await session.restore({
                revisionNo: restoreTarget.revisionNo,
                sourceHash: restoreTarget.sourceHash,
              });
              setRestoreTarget(null);
              await finishOperation();
            }}
          />
        </Dialog.Root>
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {historyStatusMessage(snapshot, messages)}
      </p>
      {snapshot.error ? (
        <div className="mt-3 rounded-lg border border-red-300/50 bg-red-950/30 p-3" role="alert">
          <p className="font-semibold text-red-100">{snapshot.error.message}</p>
          {snapshot.error.correlationId ? (
            <p className="mt-1 text-xs text-red-100/80">
              {messages["error.correlationId"](snapshot.error.correlationId)}
            </p>
          ) : null}
          {snapshot.status === "UNKNOWN_OUTCOME" && snapshot.pendingOperation ? (
            <button
              className={`${secondaryButtonClass} mt-3`}
              type="button"
              disabled={interactionDisabled}
              onClick={() => void retrySafely()}
            >
              {messages["history.retrySafely"]}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function RevisionHistoryDialog({
  snapshot,
  interactionDisabled,
  revisions,
  loading,
  loadFailed,
  restoreTarget,
  onRetryLoad,
  onSelectRestore,
  onCancelRestore,
  onConfirmRestore,
}: {
  readonly snapshot: SchemaHistorySessionSnapshot;
  readonly interactionDisabled: boolean;
  readonly revisions: readonly SchemaRevisionSummary[];
  readonly loading: boolean;
  readonly loadFailed: boolean;
  readonly restoreTarget: SchemaRevisionSummary | null;
  readonly onRetryLoad: () => void;
  readonly onSelectRestore: (revision: SchemaRevisionSummary) => void;
  readonly onCancelRestore: () => void;
  readonly onConfirmRestore: () => Promise<void>;
}) {
  const { formatDate, messages } = useUiLocale();
  const restoreTriggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/80" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[min(94vw,56rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl">
        <Dialog.Title className="text-xl font-semibold">
          {messages["history.revisionHistory"]}
        </Dialog.Title>
        <Dialog.Description className="mt-2 text-sm leading-6 text-slate-300">
          {messages["history.description"]}
        </Dialog.Description>

        {loading ? (
          <p className="mt-6 text-sm text-slate-300" role="status">
            {messages["history.loading"]}
          </p>
        ) : loadFailed ? (
          <div className="mt-6 rounded-lg border border-red-300/50 bg-red-950/30 p-3" role="alert">
            <p>{messages["history.loadError"]}</p>
            <button className={`${secondaryButtonClass} mt-3`} type="button" onClick={onRetryLoad}>
              {messages["action.tryAgain"]}
            </button>
          </div>
        ) : revisions.length === 0 ? (
          <p className="mt-6 text-sm text-slate-300">{messages["history.empty"]}</p>
        ) : (
          <ol className="mt-6 space-y-3" aria-label={messages["history.projectRevisions"]}>
            {revisions.map((revision) => {
              const current = revision.revisionNo === snapshot.current.revisionNo;
              return (
                <li
                  key={revision.id}
                  className="rounded-xl border border-slate-700 bg-slate-950/60 p-4"
                >
                  <article aria-label={messages["history.revision"](revision.revisionNo)}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold">
                          {messages["history.revision"](revision.revisionNo)}
                        </h3>
                        <p className="mt-1 text-sm text-slate-300">
                          {revision.validity} · {revision.origin}
                        </p>
                      </div>
                      {current ? (
                        <button className={secondaryButtonClass} type="button" disabled>
                          {messages["history.current"]}
                        </button>
                      ) : (
                        <button
                          className={secondaryButtonClass}
                          type="button"
                          disabled={interactionDisabled || snapshot.locked}
                          onClick={(event) => {
                            restoreTriggerRef.current = event.currentTarget;
                            onSelectRestore(revision);
                          }}
                        >
                          {messages["history.restore"](revision.revisionNo)}
                        </button>
                      )}
                    </div>
                    <dl className="mt-3 grid gap-2 text-xs text-slate-300 sm:grid-cols-2">
                      <SummaryDetail label={messages["history.created"]}>
                        <time dateTime={revision.createdAt}>
                          {formatDate(revision.createdAt, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </time>
                      </SummaryDetail>
                      <SummaryDetail label={messages["runtime.parser"]}>
                        {revision.parserVersion}
                      </SummaryDetail>
                      <SummaryDetail label={messages["history.diagnostics"]}>
                        {messages["history.diagnosticCounts"](
                          revision.diagnosticSummary.errors,
                          revision.diagnosticSummary.warnings,
                          revision.diagnosticSummary.infos,
                        )}
                      </SummaryDetail>
                      <SummaryDetail label={messages["history.sourceHash"]}>
                        <code className="break-all">{revision.sourceHash}</code>
                      </SummaryDetail>
                    </dl>
                    {revision.validity === "INVALID" ? (
                      <p className="mt-3 text-xs leading-5 text-amber-200">
                        {messages["history.invalidSummary"]}
                      </p>
                    ) : null}
                  </article>
                </li>
              );
            })}
          </ol>
        )}

        <div className="mt-6 flex justify-end">
          <Dialog.Close asChild>
            <button className={secondaryButtonClass} type="button">
              {messages["history.close"]}
            </button>
          </Dialog.Close>
        </div>

        <RestoreConfirmationDialog
          revision={restoreTarget}
          locked={interactionDisabled || snapshot.locked}
          returnFocusRef={restoreTriggerRef}
          onCancel={onCancelRestore}
          onConfirm={onConfirmRestore}
        />
      </Dialog.Content>
    </Dialog.Portal>
  );
}

function RestoreConfirmationDialog({
  revision,
  locked,
  returnFocusRef,
  onCancel,
  onConfirm,
}: {
  readonly revision: SchemaRevisionSummary | null;
  readonly locked: boolean;
  readonly returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  readonly onCancel: () => void;
  readonly onConfirm: () => Promise<void>;
}) {
  const { messages } = useUiLocale();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root
      open={revision !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-slate-950/85" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[70] w-[min(92vw,34rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef.current?.focus();
          }}
        >
          <Dialog.Title className="text-xl font-semibold">
            {messages["history.restoreQuestion"](revision?.revisionNo ?? null)}
          </Dialog.Title>
          <Dialog.Description className="mt-3 space-y-2 text-sm leading-6 text-slate-300">
            <span className="block">{messages["history.restoreDescription"]}</span>
            {revision?.validity === "INVALID" ? (
              <span className="block text-amber-200">{messages["history.restoreInvalid"]}</span>
            ) : null}
          </Dialog.Description>
          <div className="mt-6 flex flex-row-reverse flex-wrap gap-3">
            <button
              className={primaryButtonClass}
              type="button"
              disabled={locked || !revision}
              onClick={() => void onConfirm()}
            >
              {revision ? messages["history.restore"](revision.revisionNo) : null}
            </button>
            <button
              ref={cancelRef}
              className={secondaryButtonClass}
              type="button"
              disabled={locked}
              onClick={onCancel}
            >
              {messages["action.cancel"]}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SummaryDetail({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="font-semibold text-slate-400">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

function historyStatusMessage(
  snapshot: SchemaHistorySessionSnapshot,
  messages: UiMessages,
): string {
  switch (snapshot.status) {
    case "FLUSHING_SOURCE":
      return messages["history.statusFlushingSource"];
    case "FLUSHING_LAYOUT":
      return messages["history.statusFlushingLayout"];
    case "UNDOING":
      return messages["history.statusUndoing"];
    case "REDOING":
      return messages["history.statusRedoing"];
    case "RESTORING":
      return messages["history.statusRestoring"];
    case "SUCCEEDED":
      return messages["history.statusSucceeded"];
    case "UNKNOWN_OUTCOME":
      return messages["history.statusUnknown"];
    case "CONFLICT":
      return messages["history.statusConflict"];
    case "ERROR":
      return messages["history.statusError"];
    case "IDLE":
      return messages["history.statusIdle"](snapshot.past.length, snapshot.future.length);
  }
}

const secondaryButtonClass =
  "min-h-10 rounded-lg border border-slate-600 px-3 text-sm font-semibold text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:opacity-50";
const primaryButtonClass =
  "min-h-10 rounded-lg bg-cyan-300 px-3 text-sm font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:opacity-50";
