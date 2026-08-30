import type {
  DraftValidity,
  ProjectMutationResponse,
  ProjectState,
  SchemaRevisionOrigin,
} from "@er-diagram/contracts";

export const SCHEMA_HISTORY_LIMIT = 100;

export type SchemaHistoryStepKind = "SOURCE_EDIT" | "VISUAL_COMMAND" | "MANUAL_RESTORE";
export type SchemaHistoryOperationKind = "UNDO" | "REDO" | "MANUAL_RESTORE";

export interface SchemaHistoryPoint {
  readonly revisionNo: number;
  readonly source: string;
  readonly sourceHash: string;
  readonly validity: DraftValidity;
  readonly origin: SchemaRevisionOrigin;
}

export interface SchemaHistoryStep {
  readonly kind: SchemaHistoryStepKind;
  readonly before: SchemaHistoryPoint;
  readonly after: SchemaHistoryPoint;
}

export interface SchemaHistoryRestoreTarget {
  readonly revisionNo: number;
  readonly sourceHash: string;
}

export interface SchemaHistorySaveDraftInput {
  readonly projectId: string;
  readonly source: string;
  readonly expectedSchemaRevisionNo: number;
  readonly commandId: string;
}

export interface SchemaHistoryRestoreRevisionInput {
  readonly projectId: string;
  readonly revisionNo: number;
  readonly expectedSchemaRevisionNo: number;
  readonly commandId: string;
}

export type SchemaHistoryPendingOperation =
  | {
      readonly kind: "UNDO" | "REDO";
      readonly request: SchemaHistorySaveDraftInput;
      readonly step: SchemaHistoryStep;
      readonly before: SchemaHistoryPoint;
      readonly targetSource: string;
      readonly targetSourceHash: string;
      readonly expectedOrigin: "SOURCE_EDIT";
    }
  | {
      readonly kind: "MANUAL_RESTORE";
      readonly request: SchemaHistoryRestoreRevisionInput;
      readonly target: SchemaHistoryRestoreTarget;
      readonly before: SchemaHistoryPoint;
      readonly targetSourceHash: string;
      readonly expectedOrigin: "RESTORE";
    };

export type SchemaHistorySessionStatus =
  | "IDLE"
  | "FLUSHING_SOURCE"
  | "FLUSHING_LAYOUT"
  | "UNDOING"
  | "REDOING"
  | "RESTORING"
  | "SUCCEEDED"
  | "UNKNOWN_OUTCOME"
  | "CONFLICT"
  | "ERROR";

export interface SchemaHistorySessionError {
  readonly code: string;
  readonly message: string;
  readonly correlationId?: string;
  readonly currentRevisionNo?: number;
}

export interface SchemaHistorySessionSnapshot {
  readonly status: SchemaHistorySessionStatus;
  readonly locked: boolean;
  readonly current: SchemaHistoryPoint;
  readonly past: readonly SchemaHistoryStep[];
  readonly future: readonly SchemaHistoryStep[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly error: SchemaHistorySessionError | null;
  readonly pendingOperation: SchemaHistoryPendingOperation | null;
}

export interface RecordSchemaHistoryCommitInput {
  readonly kind: SchemaHistoryStepKind;
  readonly before: ProjectState | SchemaHistoryPoint;
  readonly response: Pick<ProjectMutationResponse, "state" | "revisionCreated">;
  readonly replayed?: boolean;
  readonly appliedSchemaRevisionNo?: number;
}

export interface SchemaHistorySessionController {
  getSnapshot(): SchemaHistorySessionSnapshot;
  subscribe(listener: () => void): () => void;
  recordCommitted(input: RecordSchemaHistoryCommitInput): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
  restore(target: SchemaHistoryRestoreTarget): Promise<void>;
  retrySafely(): Promise<void>;
  adoptExternalState(state: ProjectState): void;
  reset(): void;
  dispose(): void;
}

export type SchemaHistoryStateAdoption = "HISTORY_COMMIT" | "EXTERNAL_CONFLICT";

export interface CreateSchemaHistorySessionOptions {
  readonly projectId: string;
  readonly initialState: ProjectState;
  readonly flushSource: () => Promise<ProjectState>;
  readonly flushLayout: () => Promise<void>;
  readonly saveDraft: (input: SchemaHistorySaveDraftInput) => Promise<ProjectMutationResponse>;
  readonly restoreRevision: (
    input: SchemaHistoryRestoreRevisionInput,
  ) => Promise<ProjectMutationResponse>;
  readonly adoptAuthoritativeState: (
    state: ProjectState,
    diagnostics: Readonly<ProjectMutationResponse["diagnostics"]>,
    adoption: SchemaHistoryStateAdoption,
  ) => Promise<unknown>;
  readonly loadCurrentState: () => Promise<ProjectState>;
  readonly generateCommandId?: () => string;
}

interface MutableSnapshotFields {
  readonly status: SchemaHistorySessionStatus;
  readonly current: SchemaHistoryPoint;
  readonly past: readonly SchemaHistoryStep[];
  readonly future: readonly SchemaHistoryStep[];
  readonly error: SchemaHistorySessionError | null;
  readonly pendingOperation: SchemaHistoryPendingOperation | null;
}

export function createSchemaHistorySession(
  options: CreateSchemaHistorySessionOptions,
): SchemaHistorySessionController {
  if (options.initialState.project.id !== options.projectId) {
    throw new Error("The initial history state did not belong to the requested project.");
  }

  const listeners = new Set<() => void>();
  const generateCommandId = options.generateCommandId ?? (() => globalThis.crypto.randomUUID());
  let running = false;
  let disposed = false;
  let fields: MutableSnapshotFields = {
    status: "IDLE",
    current: pointFromState(options.initialState, options.projectId),
    past: [],
    future: [],
    error: null,
    pendingOperation: null,
  };
  let snapshot = toSnapshot(fields, running);

  function publish(patch: Partial<MutableSnapshotFields>): void {
    if (disposed) return;
    fields = { ...fields, ...patch };
    snapshot = toSnapshot(fields, running);
    for (const listener of listeners) listener();
  }

  function refreshDerivedState(): void {
    if (disposed) return;
    snapshot = toSnapshot(fields, running);
    for (const listener of listeners) listener();
  }

  function recordCommitted(input: RecordSchemaHistoryCommitInput): void {
    if (disposed) return;
    const before = pointFromInput(input.before, options.projectId);
    const after = pointFromState(input.response.state, options.projectId);

    if (
      fields.pendingOperation &&
      matchesPendingCommit(after, fields.pendingOperation) &&
      after.revisionNo === fields.pendingOperation.before.revisionNo + 1
    ) {
      return;
    }

    if (fields.pendingOperation) {
      resetToPoint(after, "CONFLICT", externalHistoryError(after.revisionNo));
      return;
    }

    if (input.replayed) {
      if (
        input.appliedSchemaRevisionNo !== undefined &&
        after.revisionNo > input.appliedSchemaRevisionNo
      ) {
        resetToPoint(after, "CONFLICT", {
          code: "CLIENT_HISTORY_REPLAY_STALE",
          message:
            "The command receipt predates the current project revision. Session history was reset.",
          currentRevisionNo: after.revisionNo,
        });
      } else if (samePoint(fields.current, after)) {
        return;
      } else if (
        input.response.revisionCreated &&
        input.appliedSchemaRevisionNo === after.revisionNo &&
        samePoint(fields.current, before) &&
        after.revisionNo === before.revisionNo + 1 &&
        after.origin === expectedStepOrigin(input.kind)
      ) {
        appendForwardStep({ kind: input.kind, before, after });
      } else if (!samePoint(fields.current, after)) {
        resetToPoint(after, "CONFLICT", externalHistoryError(after.revisionNo));
      }
      return;
    }

    if (!input.response.revisionCreated || sameSource(before, after)) {
      if (!samePoint(fields.current, after)) {
        resetToPoint(after, "CONFLICT", externalHistoryError(after.revisionNo));
      }
      return;
    }

    if (
      !samePoint(fields.current, before) ||
      after.revisionNo !== before.revisionNo + 1 ||
      after.origin !== expectedStepOrigin(input.kind)
    ) {
      resetToPoint(after, "CONFLICT", externalHistoryError(after.revisionNo));
      return;
    }

    appendForwardStep({ kind: input.kind, before, after });
  }

  async function undo(): Promise<void> {
    await startOperation("UNDO");
  }

  async function redo(): Promise<void> {
    await startOperation("REDO");
  }

  async function restore(target: SchemaHistoryRestoreTarget): Promise<void> {
    if (
      disposed ||
      running ||
      fields.pendingOperation ||
      !isRestoreTarget(target) ||
      target.revisionNo === fields.current.revisionNo
    ) {
      return;
    }
    await runLocked(async () => {
      if (!(await prepareForMutation())) return;
      const pending: SchemaHistoryPendingOperation = {
        kind: "MANUAL_RESTORE",
        request: {
          projectId: options.projectId,
          revisionNo: target.revisionNo,
          expectedSchemaRevisionNo: fields.current.revisionNo,
          commandId: generateCommandId(),
        },
        target,
        before: fields.current,
        targetSourceHash: target.sourceHash,
        expectedOrigin: "RESTORE",
      };
      publish({
        status: "RESTORING",
        error: null,
        pendingOperation: pending,
      });
      await applyPending(pending, false);
    });
  }

  async function retrySafely(): Promise<void> {
    if (disposed || running || fields.status !== "UNKNOWN_OUTCOME" || !fields.pendingOperation) {
      return;
    }
    const pending = fields.pendingOperation;
    await runLocked(async () => {
      publish({ status: operationStatus(pending.kind), error: null });
      await applyPending(pending, true);
    });
  }

  async function startOperation(kind: "UNDO" | "REDO"): Promise<void> {
    if (disposed || running || fields.pendingOperation) return;
    await runLocked(async () => {
      if (!(await prepareForMutation())) return;
      const step = kind === "UNDO" ? fields.past.at(-1) : fields.future.at(-1);
      if (!step) {
        publish({ status: "IDLE", error: null });
        return;
      }
      const target = kind === "UNDO" ? step.before : step.after;
      const pending: SchemaHistoryPendingOperation = {
        kind,
        request: {
          projectId: options.projectId,
          source: target.source,
          expectedSchemaRevisionNo: fields.current.revisionNo,
          commandId: generateCommandId(),
        },
        step,
        before: fields.current,
        targetSource: target.source,
        targetSourceHash: target.sourceHash,
        expectedOrigin: "SOURCE_EDIT",
      };
      publish({
        status: operationStatus(kind),
        error: null,
        pendingOperation: pending,
      });
      await applyPending(pending, false);
    });
  }

  async function runLocked(work: () => Promise<void>): Promise<void> {
    running = true;
    refreshDerivedState();
    try {
      await work();
    } catch (error) {
      publish({
        status: "ERROR",
        error: toSessionError(
          error,
          "CLIENT_HISTORY_OPERATION_FAILED",
          "The history operation could not be completed.",
        ),
        pendingOperation: null,
      });
    } finally {
      running = false;
      refreshDerivedState();
    }
  }

  async function prepareForMutation(): Promise<boolean> {
    publish({ status: "FLUSHING_SOURCE", error: null });
    const stateBeforeFlush = fields.current;
    let flushedState: ProjectState;
    try {
      flushedState = await options.flushSource();
    } catch (error) {
      publish({
        status: "ERROR",
        error: toSessionError(
          error,
          "CLIENT_HISTORY_SOURCE_FLUSH_FAILED",
          "The current source could not be saved before the history operation.",
        ),
      });
      return false;
    }

    const flushed = pointFromState(flushedState, options.projectId);
    if (!samePoint(fields.current, flushed)) {
      if (
        samePoint(fields.current, stateBeforeFlush) &&
        flushed.revisionNo === stateBeforeFlush.revisionNo + 1 &&
        flushed.origin === "SOURCE_EDIT" &&
        !sameSource(stateBeforeFlush, flushed)
      ) {
        appendForwardStep({ kind: "SOURCE_EDIT", before: stateBeforeFlush, after: flushed });
      } else {
        resetToPoint(flushed, "CONFLICT", externalHistoryError(flushed.revisionNo));
        return false;
      }
    }

    publish({ status: "FLUSHING_LAYOUT" });
    try {
      await options.flushLayout();
    } catch (error) {
      publish({
        status: "ERROR",
        error: toSessionError(
          error,
          "CLIENT_HISTORY_LAYOUT_FLUSH_FAILED",
          "Every loaded diagram layout must be saved before changing schema history.",
        ),
      });
      return false;
    }
    return true;
  }

  async function applyPending(
    pending: SchemaHistoryPendingOperation,
    retryAfterUnknownOutcome: boolean,
  ): Promise<void> {
    try {
      const response =
        pending.kind === "MANUAL_RESTORE"
          ? await options.restoreRevision(pending.request)
          : await options.saveDraft(pending.request);
      const point = assertMutationResponse(response, pending, options.projectId);
      await completePending(response.state, point, pending, response.diagnostics);
    } catch (error) {
      if (isRevisionConflict(error)) {
        await resolveConflict(error, pending, retryAfterUnknownOutcome);
        return;
      }
      if (isDefiniteRejection(error)) {
        publish({
          status: "ERROR",
          error: toSessionError(
            error,
            "CLIENT_HISTORY_OPERATION_REJECTED",
            "The server rejected the history operation.",
          ),
          pendingOperation: null,
        });
        return;
      }
      publish({
        status: "UNKNOWN_OUTCOME",
        error: toSessionError(
          error,
          "CLIENT_HISTORY_OUTCOME_UNKNOWN",
          "The history outcome could not be confirmed. Retry safely with the same request.",
        ),
        pendingOperation: pending,
      });
    }
  }

  async function resolveConflict(
    error: unknown,
    pending: SchemaHistoryPendingOperation,
    retryAfterUnknownOutcome: boolean,
  ): Promise<void> {
    try {
      const latest = await options.loadCurrentState();
      const point = pointFromState(latest, options.projectId);
      if (retryAfterUnknownOutcome && matchesPendingCommit(point, pending)) {
        await completePending(latest, point, pending);
        return;
      }

      await options.adoptAuthoritativeState(latest, [], "EXTERNAL_CONFLICT");
      fields = {
        status: "CONFLICT",
        current: point,
        past: [],
        future: [],
        error: toSessionError(
          error,
          "CLIENT_HISTORY_REVISION_CONFLICT",
          "The project changed outside this history session. Session history was reset.",
        ),
        pendingOperation: null,
      };
      refreshDerivedState();
    } catch (loadError) {
      publish({
        status: "UNKNOWN_OUTCOME",
        error: toSessionError(
          loadError,
          "CLIENT_HISTORY_CONFLICT_REFRESH_FAILED",
          "The latest project state could not be loaded. Retry safely with the same request.",
        ),
        pendingOperation: pending,
      });
    }
  }

  async function completePending(
    state: ProjectState,
    point: SchemaHistoryPoint,
    pending: SchemaHistoryPendingOperation,
    diagnostics: Readonly<ProjectMutationResponse["diagnostics"]> = [],
  ): Promise<void> {
    await options.adoptAuthoritativeState(state, diagnostics, "HISTORY_COMMIT");

    if (pending.kind === "UNDO") {
      if (fields.past.at(-1) !== pending.step) {
        resetToPoint(point, "CONFLICT", externalHistoryError(point.revisionNo));
        return;
      }
      publish({
        status: "SUCCEEDED",
        current: point,
        past: fields.past.slice(0, -1),
        future: [...fields.future, pending.step],
        error: null,
        pendingOperation: null,
      });
      return;
    }

    if (pending.kind === "REDO") {
      if (fields.future.at(-1) !== pending.step) {
        resetToPoint(point, "CONFLICT", externalHistoryError(point.revisionNo));
        return;
      }
      publish({
        status: "SUCCEEDED",
        current: point,
        past: boundedPast([...fields.past, pending.step]),
        future: fields.future.slice(0, -1),
        error: null,
        pendingOperation: null,
      });
      return;
    }

    const step: SchemaHistoryStep = {
      kind: "MANUAL_RESTORE",
      before: pending.before,
      after: point,
    };
    if (sameSource(pending.before, point)) {
      publish({
        status: "SUCCEEDED",
        current: point,
        past: fields.past,
        future: [],
        error: null,
        pendingOperation: null,
      });
      return;
    }
    publish({
      status: "SUCCEEDED",
      current: point,
      past: boundedPast([...fields.past, step]),
      future: [],
      error: null,
      pendingOperation: null,
    });
  }

  function appendForwardStep(step: SchemaHistoryStep): void {
    publish({
      status: running ? fields.status : "IDLE",
      current: step.after,
      past: boundedPast([...fields.past, step]),
      future: [],
      error: null,
    });
  }

  function resetToPoint(
    point: SchemaHistoryPoint,
    status: SchemaHistorySessionStatus,
    error: SchemaHistorySessionError | null,
  ): void {
    publish({
      status,
      current: point,
      past: [],
      future: [],
      error,
      pendingOperation: null,
    });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recordCommitted,
    undo,
    redo,
    restore,
    retrySafely,
    adoptExternalState(state) {
      if (disposed || running) return;
      const point = pointFromState(state, options.projectId);
      if (samePoint(point, fields.current)) return;
      resetToPoint(point, "IDLE", null);
    },
    reset() {
      if (disposed || running || fields.pendingOperation) return;
      resetToPoint(fields.current, "IDLE", null);
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

function toSnapshot(fields: MutableSnapshotFields, running: boolean): SchemaHistorySessionSnapshot {
  const locked = running || fields.pendingOperation !== null;
  return {
    ...fields,
    locked,
    canUndo: !locked && fields.past.length > 0,
    canRedo: !locked && fields.future.length > 0,
  };
}

function pointFromInput(
  value: ProjectState | SchemaHistoryPoint,
  projectId: string,
): SchemaHistoryPoint {
  return "project" in value ? pointFromState(value, projectId) : value;
}

function pointFromState(state: ProjectState, projectId: string): SchemaHistoryPoint {
  const { project, currentRevision } = state;
  if (
    project.id !== projectId ||
    currentRevision.projectId !== projectId ||
    project.schemaRevisionNo !== currentRevision.revisionNo ||
    project.draftSource !== currentRevision.source ||
    project.draftHash !== currentRevision.sourceHash
  ) {
    throw new Error("The authoritative project state did not satisfy the history contract.");
  }
  return {
    revisionNo: currentRevision.revisionNo,
    source: currentRevision.source,
    sourceHash: currentRevision.sourceHash,
    validity: currentRevision.validity,
    origin: currentRevision.origin,
  };
}

function assertMutationResponse(
  response: ProjectMutationResponse,
  pending: SchemaHistoryPendingOperation,
  projectId: string,
): SchemaHistoryPoint {
  const point = pointFromState(response.state, projectId);
  if (response.revisionCreated && matchesPendingCommit(point, pending)) return point;
  throw new Error("The history mutation response did not match its exact request.");
}

function matchesPendingCommit(
  point: SchemaHistoryPoint,
  pending: SchemaHistoryPendingOperation,
): boolean {
  return (
    point.revisionNo === pending.request.expectedSchemaRevisionNo + 1 &&
    point.sourceHash === pending.targetSourceHash &&
    point.origin === pending.expectedOrigin &&
    (pending.kind === "MANUAL_RESTORE" || point.source === pending.targetSource)
  );
}

function expectedStepOrigin(kind: SchemaHistoryStepKind): SchemaRevisionOrigin {
  switch (kind) {
    case "SOURCE_EDIT":
      return "SOURCE_EDIT";
    case "VISUAL_COMMAND":
      return "VISUAL_COMMAND";
    case "MANUAL_RESTORE":
      return "RESTORE";
  }
}

function operationStatus(kind: SchemaHistoryOperationKind): SchemaHistorySessionStatus {
  switch (kind) {
    case "UNDO":
      return "UNDOING";
    case "REDO":
      return "REDOING";
    case "MANUAL_RESTORE":
      return "RESTORING";
  }
}

function boundedPast(steps: readonly SchemaHistoryStep[]): readonly SchemaHistoryStep[] {
  return steps.length <= SCHEMA_HISTORY_LIMIT ? steps : steps.slice(-SCHEMA_HISTORY_LIMIT);
}

function sameSource(left: SchemaHistoryPoint, right: SchemaHistoryPoint): boolean {
  return left.source === right.source && left.sourceHash === right.sourceHash;
}

function samePoint(left: SchemaHistoryPoint, right: SchemaHistoryPoint): boolean {
  return (
    left.revisionNo === right.revisionNo &&
    left.source === right.source &&
    left.sourceHash === right.sourceHash &&
    left.validity === right.validity &&
    left.origin === right.origin
  );
}

function isRestoreTarget(target: SchemaHistoryRestoreTarget): boolean {
  return (
    Number.isSafeInteger(target.revisionNo) && target.revisionNo > 0 && target.sourceHash.length > 0
  );
}

function isProjectApiError(error: unknown): error is Error & {
  readonly status: number | null;
  readonly code: string;
  readonly correlationId?: string;
  readonly currentRevisionNo?: number;
} {
  return (
    error instanceof Error &&
    "status" in error &&
    (typeof error.status === "number" || error.status === null) &&
    "code" in error &&
    typeof error.code === "string"
  );
}

function isRevisionConflict(error: unknown): boolean {
  return isProjectApiError(error) && error.status === 409;
}

function isDefiniteRejection(error: unknown): boolean {
  return (
    isProjectApiError(error) && error.status !== null && error.status >= 400 && error.status < 500
  );
}

function toSessionError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): SchemaHistorySessionError {
  if (!isProjectApiError(error)) return { code: fallbackCode, message: fallbackMessage };
  return {
    code: error.code,
    message: error.message,
    ...(error.correlationId ? { correlationId: error.correlationId } : {}),
    ...(error.currentRevisionNo === undefined
      ? {}
      : { currentRevisionNo: error.currentRevisionNo }),
  };
}

function externalHistoryError(currentRevisionNo: number): SchemaHistorySessionError {
  return {
    code: "CLIENT_HISTORY_EXTERNAL_STATE",
    message: "The project changed outside this history session. Session history was reset.",
    currentRevisionNo,
  };
}
