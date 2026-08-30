import {
  visualCommandSchema,
  type Diagnostic,
  type ProjectState,
  type VisualCommand,
  type VisualCommandMutationResponse,
  type VisualCommandPartialImpact,
} from "@er-diagram/contracts";

import type { LayoutSessionController } from "../diagram/layout-session.js";
import type { ProjectApi, ProjectApiError } from "../projects/project-api.js";
import type {
  SourceSessionController,
  SourceSessionSnapshot,
} from "../source-editor/source-session.js";

type StripCommandEnvelope<T> = T extends VisualCommand
  ? Omit<T, "commandId" | "expectedSchemaRevisionNo">
  : never;

export type VisualCommandDraft = StripCommandEnvelope<VisualCommand>;

export type VisualCommandSessionStatus =
  | "IDLE"
  | "FLUSHING_SOURCE"
  | "FLUSHING_LAYOUT"
  | "SUBMITTING"
  | "SUCCEEDED"
  | "REJECTED"
  | "STALE_REVIEW"
  | "UNKNOWN_OUTCOME";

export interface VisualCommandSessionError {
  readonly code: string;
  readonly message: string;
  readonly correlationId?: string;
  readonly currentRevisionNo?: number;
  readonly diagnostics: Diagnostic[];
  readonly partialImpact?: VisualCommandPartialImpact;
}

export interface VisualCommandSessionSnapshot {
  readonly status: VisualCommandSessionStatus;
  readonly error: VisualCommandSessionError | null;
  readonly mutation: VisualCommandMutationResponse | null;
  readonly pendingCommand: VisualCommand | null;
  readonly lastCommand: VisualCommand | null;
  readonly layoutRefreshFailed: boolean;
}

export interface VisualCommandSessionController {
  getSnapshot(): VisualCommandSessionSnapshot;
  subscribe(listener: () => void): () => void;
  submit(draft: VisualCommandDraft, openedSchemaHash: string): Promise<void>;
  retrySafely(): Promise<void>;
  reviewLatestSchema(): void;
  reset(): void;
}

export interface CreateVisualCommandSessionOptions {
  readonly projectId: string;
  readonly sourceSession: Pick<
    SourceSessionController,
    "getSnapshot" | "flushAndWait" | "adoptCommittedState"
  >;
  readonly layoutSession: Pick<
    LayoutSessionController,
    "getSnapshot" | "flush" | "adoptCommittedRevision"
  >;
  readonly applyVisualCommand: ProjectApi["applyVisualCommand"];
  readonly loadProject: () => Promise<ProjectState>;
  readonly generateCommandId?: () => string;
  readonly onBeforeCommittedState?: (
    state: ProjectState,
    mutation: VisualCommandMutationResponse,
    command: VisualCommand,
  ) => void;
  readonly onCommittedState?: (
    state: ProjectState,
    mutation: VisualCommandMutationResponse,
  ) => void;
}

export function createVisualCommandSession(
  options: CreateVisualCommandSessionOptions,
): VisualCommandSessionController {
  const listeners = new Set<() => void>();
  const generateCommandId = options.generateCommandId ?? (() => globalThis.crypto.randomUUID());
  let snapshot: VisualCommandSessionSnapshot = {
    status: "IDLE",
    error: null,
    mutation: null,
    pendingCommand: null,
    lastCommand: null,
    layoutRefreshFailed: false,
  };
  let running = false;

  function publish(patch: Partial<VisualCommandSessionSnapshot>): void {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }

  async function submit(draft: VisualCommandDraft, openedSchemaHash: string): Promise<void> {
    if (running) return;
    running = true;
    publish({
      status: "FLUSHING_SOURCE",
      error: null,
      mutation: null,
      pendingCommand: null,
      lastCommand: null,
      layoutRefreshFailed: false,
    });
    try {
      const source = await options.sourceSession.flushAndWait();
      const sourceGateError = sourceGateFailure(source, openedSchemaHash);
      if (sourceGateError) {
        publish({ status: "REJECTED", error: sourceGateError });
        return;
      }

      publish({ status: "FLUSHING_LAYOUT" });
      await options.layoutSession.flush();
      const layoutGateError = layoutGateFailure(options.layoutSession.getSnapshot());
      if (layoutGateError) {
        publish({ status: "REJECTED", error: layoutGateError });
        return;
      }

      const parsed = visualCommandSchema.safeParse({
        ...draft,
        commandId: generateCommandId(),
        expectedSchemaRevisionNo: source.expectedSchemaRevisionNo,
      });
      if (!parsed.success) {
        publish({
          status: "REJECTED",
          error: clientError(
            "CLIENT_VISUAL_COMMAND_INVALID",
            "The visual form could not produce a valid command.",
          ),
        });
        return;
      }
      publish({ status: "SUBMITTING", pendingCommand: parsed.data });
      await applyCommand(parsed.data);
    } finally {
      running = false;
    }
  }

  async function retrySafely(): Promise<void> {
    if (running || snapshot.status !== "UNKNOWN_OUTCOME" || !snapshot.pendingCommand) return;
    running = true;
    publish({ status: "SUBMITTING", error: null });
    try {
      await applyCommand(snapshot.pendingCommand);
    } finally {
      running = false;
    }
  }

  async function applyCommand(command: VisualCommand): Promise<void> {
    try {
      const mutation = await options.applyVisualCommand({ projectId: options.projectId, command });
      options.onBeforeCommittedState?.(mutation.state, mutation, command);
      const adopted = await options.sourceSession.adoptCommittedState(mutation.state);
      if (
        adopted.persistence !== "SAVED" ||
        adopted.serverState.project.schemaRevisionNo !== mutation.state.project.schemaRevisionNo
      ) {
        throw new Error("The committed source state could not be adopted.");
      }
      const layoutRefresh = await options.layoutSession.adoptCommittedRevision(
        mutation.state.project.layoutRevisionNo,
        mutation.layoutMigrated,
      );
      options.onCommittedState?.(mutation.state, mutation);
      publish({
        status: "SUCCEEDED",
        error: null,
        mutation,
        pendingCommand: null,
        lastCommand: command,
        layoutRefreshFailed: layoutRefresh.refreshFailed,
      });
    } catch (error) {
      const apiError = toSessionError(error);
      if (isStaleConflict(error)) {
        try {
          const latest = await options.loadProject();
          await options.sourceSession.adoptCommittedState(latest);
          await options.layoutSession.adoptCommittedRevision(latest.project.layoutRevisionNo, true);
        } catch {
          // Keep the original conflict as the actionable error. A later review can reload again.
        }
        publish({ status: "STALE_REVIEW", error: apiError, pendingCommand: null });
        return;
      }
      if (isDefiniteRejection(error)) {
        publish({ status: "REJECTED", error: apiError, pendingCommand: null });
        return;
      }
      publish({ status: "UNKNOWN_OUTCOME", error: apiError });
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit,
    retrySafely,
    reviewLatestSchema() {
      if (snapshot.status !== "STALE_REVIEW") return;
      publish({ status: "IDLE", error: null, mutation: null, pendingCommand: null });
    },
    reset() {
      if (running) return;
      publish({
        status: "IDLE",
        error: null,
        mutation: null,
        pendingCommand: null,
        lastCommand: null,
        layoutRefreshFailed: false,
      });
    },
  };
}

function sourceGateFailure(
  source: SourceSessionSnapshot,
  openedSchemaHash: string,
): VisualCommandSessionError | null {
  if (source.persistence !== "SAVED") {
    return clientError(
      "CLIENT_VISUAL_SOURCE_NOT_SAVED",
      "Save the current DBML source before applying a visual command.",
    );
  }
  if (
    source.validation !== "VALID" ||
    source.activeGraphSource !== "CURRENT_DRAFT" ||
    !source.activeGraph
  ) {
    return clientError(
      "CLIENT_VISUAL_SOURCE_NOT_CURRENT_VALID",
      "Visual commands require a saved, valid current draft.",
    );
  }
  if (source.activeGraph.schemaHash !== openedSchemaHash) {
    return clientError(
      "CLIENT_VISUAL_FORM_STALE",
      "The schema changed while this form was open. Review the latest schema before submitting.",
    );
  }
  return null;
}

function layoutGateFailure(
  layout: ReturnType<LayoutSessionController["getSnapshot"]>,
): VisualCommandSessionError | null {
  if (
    layout.conflict ||
    layout.hasUnsavedChanges ||
    [...layout.views.values()].some((view) => view.status !== "SAVED")
  ) {
    return clientError(
      "CLIENT_VISUAL_LAYOUT_NOT_SAVED",
      "Resolve or save every loaded diagram layout before applying a visual command.",
    );
  }
  return null;
}

function clientError(code: string, message: string): VisualCommandSessionError {
  return { code, message, diagnostics: [] };
}

function toSessionError(error: unknown): VisualCommandSessionError {
  if (isProjectApiError(error)) {
    return {
      code: error.code,
      message: error.message,
      diagnostics: [...(error.diagnostics ?? [])],
      ...(error.correlationId ? { correlationId: error.correlationId } : {}),
      ...(error.currentRevisionNo === undefined
        ? {}
        : { currentRevisionNo: error.currentRevisionNo }),
      ...(error.partialImpact ? { partialImpact: error.partialImpact } : {}),
    };
  }
  return clientError(
    "CLIENT_VISUAL_COMMAND_OUTCOME_UNKNOWN",
    "The command outcome could not be confirmed. Retry safely with the same command ID.",
  );
}

function isProjectApiError(error: unknown): error is ProjectApiError {
  return (
    error instanceof Error && "status" in error && "code" in error && typeof error.code === "string"
  );
}

function isStaleConflict(error: unknown): boolean {
  return isProjectApiError(error) && error.status === 409;
}

function isDefiniteRejection(error: unknown): boolean {
  return isProjectApiError(error) && error.status !== null && error.status < 500;
}
