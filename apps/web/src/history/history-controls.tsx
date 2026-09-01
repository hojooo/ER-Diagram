import type { ProjectRevisionsResponse, SchemaRevisionSummary } from "@er-diagram/contracts";
import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";

import type {
  SchemaHistorySessionController,
  SchemaHistorySessionSnapshot,
} from "./history-session.js";

export interface SchemaHistoryControlsProps {
  readonly session: SchemaHistorySessionController;
  readonly loadRevisions: () => Promise<ProjectRevisionsResponse>;
  readonly interactionDisabled?: boolean;
}

export function SchemaHistoryControls({
  session,
  loadRevisions,
  interactionDisabled = false,
}: SchemaHistoryControlsProps) {
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
      aria-label="Schema history"
      className="rounded-xl border border-slate-700 bg-slate-900/70 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          aria-label={`Undo schema change, ${formatStepCount(snapshot.past.length)} available`}
          className={secondaryButtonClass}
          type="button"
          disabled={interactionDisabled || !snapshot.canUndo}
          onClick={() => void runUndo()}
        >
          Undo <span aria-hidden="true">({snapshot.past.length})</span>
        </button>
        <button
          aria-label={`Redo schema change, ${formatStepCount(snapshot.future.length)} available`}
          className={secondaryButtonClass}
          type="button"
          disabled={interactionDisabled || !snapshot.canRedo}
          onClick={() => void runRedo()}
        >
          Redo <span aria-hidden="true">({snapshot.future.length})</span>
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
            <button className={secondaryButtonClass} type="button">
              Revision history
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
        {historyStatusMessage(snapshot)}
      </p>
      {snapshot.error ? (
        <div className="mt-3 rounded-lg border border-red-300/50 bg-red-950/30 p-3" role="alert">
          <p className="font-semibold text-red-100">{snapshot.error.message}</p>
          {snapshot.error.correlationId ? (
            <p className="mt-1 text-xs text-red-100/80">
              Correlation ID: {snapshot.error.correlationId}
            </p>
          ) : null}
          {snapshot.status === "UNKNOWN_OUTCOME" && snapshot.pendingOperation ? (
            <button
              className={`${secondaryButtonClass} mt-3`}
              type="button"
              disabled={interactionDisabled}
              onClick={() => void retrySafely()}
            >
              Retry safely
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
  const restoreTriggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/80" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[min(94vw,56rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl">
        <Dialog.Title className="text-xl font-semibold">Revision history</Dialog.Title>
        <Dialog.Description className="mt-2 text-sm leading-6 text-slate-300">
          Durable revisions contain source-free summaries here. Restoring creates a new checkpoint
          revision and does not restore diagram layouts.
        </Dialog.Description>

        {loading ? (
          <p className="mt-6 text-sm text-slate-300" role="status">
            Loading revision history
          </p>
        ) : loadFailed ? (
          <div className="mt-6 rounded-lg border border-red-300/50 bg-red-950/30 p-3" role="alert">
            <p>Revision history could not be loaded.</p>
            <button className={`${secondaryButtonClass} mt-3`} type="button" onClick={onRetryLoad}>
              Try again
            </button>
          </div>
        ) : revisions.length === 0 ? (
          <p className="mt-6 text-sm text-slate-300">No revisions are available.</p>
        ) : (
          <ol className="mt-6 space-y-3" aria-label="Project revisions">
            {revisions.map((revision) => {
              const current = revision.revisionNo === snapshot.current.revisionNo;
              return (
                <li
                  key={revision.id}
                  className="rounded-xl border border-slate-700 bg-slate-950/60 p-4"
                >
                  <article aria-label={`Revision ${revision.revisionNo}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold">Revision {revision.revisionNo}</h3>
                        <p className="mt-1 text-sm text-slate-300">
                          {revision.validity} · {revision.origin}
                        </p>
                      </div>
                      {current ? (
                        <button className={secondaryButtonClass} type="button" disabled>
                          Current revision
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
                          Restore revision {revision.revisionNo}
                        </button>
                      )}
                    </div>
                    <dl className="mt-3 grid gap-2 text-xs text-slate-300 sm:grid-cols-2">
                      <SummaryDetail label="Created">
                        <time dateTime={revision.createdAt}>{revision.createdAt}</time>
                      </SummaryDetail>
                      <SummaryDetail label="Parser">{revision.parserVersion}</SummaryDetail>
                      <SummaryDetail label="Diagnostics">
                        {formatDiagnosticCounts(revision)}
                      </SummaryDetail>
                      <SummaryDetail label="Source hash">
                        <code className="break-all">{revision.sourceHash}</code>
                      </SummaryDetail>
                    </dl>
                    {revision.validity === "INVALID" ? (
                      <p className="mt-3 text-xs leading-5 text-amber-200">
                        Restoring this invalid revision keeps the last-valid diagram available until
                        the draft becomes valid again.
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
              Close history
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
            Restore revision {revision?.revisionNo}?
          </Dialog.Title>
          <Dialog.Description className="mt-3 space-y-2 text-sm leading-6 text-slate-300">
            <span className="block">
              This appends a RESTORE checkpoint with the selected revision source. Diagram layouts
              are not restored.
            </span>
            {revision?.validity === "INVALID" ? (
              <span className="block text-amber-200">
                This revision is invalid. The current last-valid diagram remains available while the
                restored draft is invalid.
              </span>
            ) : null}
          </Dialog.Description>
          <div className="mt-6 flex flex-row-reverse flex-wrap gap-3">
            <button
              className={primaryButtonClass}
              type="button"
              disabled={locked || !revision}
              onClick={() => void onConfirm()}
            >
              Restore revision {revision?.revisionNo}
            </button>
            <button
              ref={cancelRef}
              className={secondaryButtonClass}
              type="button"
              disabled={locked}
              onClick={onCancel}
            >
              Cancel
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

function formatDiagnosticCounts(revision: SchemaRevisionSummary): string {
  const { errors, warnings, infos } = revision.diagnosticSummary;
  return `${errors} errors · ${warnings} warnings · ${infos} info`;
}

function formatStepCount(count: number): string {
  return `${count} ${count === 1 ? "step" : "steps"}`;
}

function historyStatusMessage(snapshot: SchemaHistorySessionSnapshot): string {
  switch (snapshot.status) {
    case "FLUSHING_SOURCE":
      return "Saving source before the history operation.";
    case "FLUSHING_LAYOUT":
      return "Saving diagram layouts before the history operation.";
    case "UNDOING":
      return "Undoing the last schema revision.";
    case "REDOING":
      return "Redoing the next schema revision.";
    case "RESTORING":
      return "Restoring the selected durable revision.";
    case "SUCCEEDED":
      return "Schema history operation completed.";
    case "UNKNOWN_OUTCOME":
      return "The history outcome is unknown. Retry safely to confirm it.";
    case "CONFLICT":
      return "Schema history was reset because the project changed.";
    case "ERROR":
      return "The schema history operation failed.";
    case "IDLE":
      return `Schema history ready. ${snapshot.past.length} undo and ${snapshot.future.length} redo steps available.`;
  }
}

const secondaryButtonClass =
  "min-h-10 rounded-lg border border-slate-600 px-3 text-sm font-semibold text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:opacity-50";
const primaryButtonClass =
  "min-h-10 rounded-lg bg-cyan-300 px-3 text-sm font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:opacity-50";
