import type { Diagnostic, ProjectMutationResponse, ProjectState } from "@er-diagram/contracts";
import type { SchemaGraph } from "@er-diagram/core";

import type { ProjectApiError, SaveDraftInput } from "../projects/project-api.js";
import type { DbmlWorkerParseResult } from "./parser-worker-client.js";
import { hashDbmlSource } from "./source-hash.js";

export const SOURCE_AUTOSAVE_DEBOUNCE_MS = 750;

export type SourcePersistenceStatus = "SAVED" | "DIRTY" | "SAVING" | "ERROR" | "CONFLICT";
export type SourceValidationStatus = "PENDING" | "VALIDATING" | "VALID" | "INVALID" | "ERROR";
export type ActiveGraphSource = "CURRENT_DRAFT" | "LAST_VALID";

export interface SourceSessionError {
  readonly code: string;
  readonly message: string;
  readonly correlationId?: string;
  readonly currentRevisionNo?: number;
}

export interface SourceSessionSnapshot {
  readonly source: string;
  readonly sourceHash: string | null;
  readonly expectedSchemaRevisionNo: number;
  readonly persistence: SourcePersistenceStatus;
  readonly validation: SourceValidationStatus;
  readonly diagnostics: Diagnostic[];
  readonly activeGraph: SchemaGraph | null;
  readonly activeGraphSource: ActiveGraphSource | null;
  readonly fallbackGraphResolved: boolean;
  readonly canUseValidSchema: boolean;
  readonly serverState: ProjectState;
  readonly conflictState: ProjectState | null;
  readonly persistenceError: SourceSessionError | null;
  readonly validationError: SourceSessionError | null;
}

export interface SourceSessionController {
  getSnapshot(): SourceSessionSnapshot;
  subscribe(listener: () => void): () => void;
  start(): void;
  edit(source: string): void;
  flush(): void;
  flushAndWait(): Promise<SourceSessionSnapshot>;
  adoptCommittedState(
    state: ProjectState,
    diagnostics?: readonly Diagnostic[],
  ): Promise<SourceSessionSnapshot>;
  retrySave(): void;
  retryValidation(): void;
  retryLocalDraft(): void;
  loadServerDraft(): string | null;
  dispose(): void;
}

export interface CreateSourceSessionOptions {
  readonly initialState: ProjectState;
  readonly parseSource: (source: string) => Promise<DbmlWorkerParseResult>;
  readonly saveDraft: (input: SaveDraftInput) => Promise<ProjectMutationResponse>;
  readonly loadProject: () => Promise<ProjectState>;
  readonly onDraftCommitted?: (
    beforeState: ProjectState,
    response: ProjectMutationResponse,
  ) => void;
  readonly onServerState?: (state: ProjectState) => void;
  readonly onAdoptCommittedSource?: (source: string) => void;
  readonly debounceMs?: number;
  readonly hashSource?: (source: string) => Promise<string>;
  readonly validateSource?: (source: string) => SourceSessionError | null;
}

interface QueuedSave {
  readonly generation: number;
  readonly source: string;
}

interface SourceValidationOutcome {
  readonly validity: "VALID" | "INVALID";
  readonly diagnostics: Diagnostic[];
  readonly graph: SchemaGraph | null;
}

export function createSourceSession(options: CreateSourceSessionOptions): SourceSessionController {
  const debounceMs = options.debounceMs ?? SOURCE_AUTOSAVE_DEBOUNCE_MS;
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new RangeError("Source autosave debounce must be a finite non-negative number.");
  }

  const listeners = new Set<() => void>();
  const hashSource = options.hashSource ?? hashDbmlSource;
  const projectId = options.initialState.project.id;
  let snapshot: SourceSessionSnapshot = initialSnapshot(options.initialState);
  let persistedSource = options.initialState.project.draftSource;
  let persistedSourceHash = options.initialState.project.draftHash;
  let lastValidGraph: SchemaGraph | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let started = false;
  let disposed = false;
  let activeSave = false;
  let savePump: Promise<void> | null = null;
  let queuedSave: QueuedSave | undefined;
  const workerOutcomes = new Map<string, SourceValidationOutcome>();
  const serverOutcomes = new Map<string, SourceValidationOutcome>();
  const failedWorkerHashes = new Set<string>();
  serverOutcomes.set(persistedSourceHash, {
    validity: options.initialState.currentRevision.validity,
    diagnostics: [],
    graph: null,
  });

  function publish(patch: Partial<SourceSessionSnapshot>): void {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }

  function start(): void {
    if (started || disposed) return;
    started = true;
    const resourceError = options.validateSource?.(snapshot.source) ?? null;
    if (resourceError) {
      publish({ validation: "ERROR", validationError: resourceError });
      return;
    }
    void validateCurrentSource(snapshot.source, generation);
    const { currentRevision, lastValidRevision } = options.initialState;
    if (
      currentRevision.validity === "INVALID" &&
      lastValidRevision !== null &&
      lastValidRevision.sourceHash !== currentRevision.sourceHash
    ) {
      validateLastValidSource(lastValidRevision.source, lastValidRevision.sourceHash);
    }
  }

  function edit(source: string): void {
    if (disposed || source === snapshot.source) return;
    generation += 1;
    clearDebounce();
    publish({
      source,
      sourceHash: null,
      persistence: snapshot.persistence === "CONFLICT" ? "CONFLICT" : "DIRTY",
      validation: "PENDING",
      diagnostics: [],
      activeGraph: lastValidGraph,
      activeGraphSource: lastValidGraph ? "LAST_VALID" : null,
      canUseValidSchema: false,
      persistenceError: snapshot.persistence === "CONFLICT" ? snapshot.persistenceError : null,
      validationError: null,
    });
    const resourceError = options.validateSource?.(source) ?? null;
    if (resourceError) {
      publish({ validation: "ERROR", validationError: resourceError });
      return;
    }
    debounceTimer = setTimeout(runDebouncedWork, debounceMs);
  }

  function runDebouncedWork(): Promise<void> {
    debounceTimer = undefined;
    const source = snapshot.source;
    const currentGeneration = generation;
    const resourceError = options.validateSource?.(source) ?? null;
    if (resourceError) {
      publish({ validation: "ERROR", validationError: resourceError });
      return Promise.resolve();
    }
    const validation = validateCurrentSource(source, currentGeneration);
    if (snapshot.persistence !== "CONFLICT") queueSave(source, currentGeneration);
    return validation;
  }

  function flush(): void {
    if (disposed) return;
    clearDebounce();
    void runDebouncedWork();
  }

  async function flushAndWait(): Promise<SourceSessionSnapshot> {
    if (disposed) return snapshot;
    clearDebounce();
    const validation = runDebouncedWork();
    await Promise.all([validation, pumpSaveQueue()]);
    return snapshot;
  }

  async function validateCurrentSource(source: string, requestGeneration: number): Promise<void> {
    if (disposed) return;
    if (requestGeneration === generation && source === snapshot.source) {
      publish({ validation: "VALIDATING", validationError: null });
    }

    try {
      const result = await options.parseSource(source);
      if (disposed || requestGeneration !== generation || source !== snapshot.source) return;
      if (source === persistedSource && result.sourceHash !== persistedSourceHash) {
        publish({
          sourceHash: result.sourceHash,
          validation: "ERROR",
          diagnostics: [],
          activeGraph: lastValidGraph,
          activeGraphSource: lastValidGraph ? "LAST_VALID" : null,
          canUseValidSchema: false,
          validationError: {
            code: "SOURCE_HASH_MISMATCH",
            message: "The persisted source hash did not match the current draft bytes.",
          },
        });
        return;
      }
      const outcome: SourceValidationOutcome = result.ok
        ? { validity: "VALID", diagnostics: result.diagnostics, graph: result.graph }
        : { validity: "INVALID", diagnostics: result.diagnostics, graph: null };
      workerOutcomes.set(result.sourceHash, outcome);
      applyWorkerOutcome(result.sourceHash, outcome);
    } catch {
      if (disposed || requestGeneration !== generation || source !== snapshot.source) return;
      const sourceHash = await hashSource(source);
      if (disposed || requestGeneration !== generation || source !== snapshot.source) return;
      const fallback = serverOutcomes.get(sourceHash);
      failedWorkerHashes.add(sourceHash);
      publish({
        sourceHash,
        validation: "ERROR",
        diagnostics: fallback?.diagnostics ?? [],
        activeGraph: lastValidGraph,
        activeGraphSource: lastValidGraph ? "LAST_VALID" : null,
        canUseValidSchema: false,
        validationError: {
          code: "PARSER_WORKER_UNAVAILABLE",
          message:
            "Browser validation is unavailable. The saved draft was still checked by the server.",
        },
      });
    }
  }

  function applyWorkerOutcome(sourceHash: string, outcome: SourceValidationOutcome): void {
    const serverOutcome = serverOutcomes.get(sourceHash);
    if (serverOutcome && serverOutcome.validity !== outcome.validity) {
      publish({
        sourceHash,
        validation: "ERROR",
        diagnostics: outcome.diagnostics,
        activeGraph: lastValidGraph,
        activeGraphSource: lastValidGraph ? "LAST_VALID" : null,
        canUseValidSchema: false,
        validationError: {
          code: "SOURCE_VALIDITY_MISMATCH",
          message: "Browser and server validation disagreed. Schema actions remain disabled.",
        },
      });
      return;
    }

    if (outcome.validity === "VALID" && outcome.graph) {
      lastValidGraph = outcome.graph;
      publish({
        sourceHash,
        validation: "VALID",
        diagnostics: outcome.diagnostics,
        activeGraph: outcome.graph,
        activeGraphSource: "CURRENT_DRAFT",
        fallbackGraphResolved: true,
        canUseValidSchema: true,
        validationError: null,
      });
      return;
    }

    publish({
      sourceHash,
      validation: "INVALID",
      diagnostics: outcome.diagnostics,
      activeGraph: lastValidGraph,
      activeGraphSource: lastValidGraph ? "LAST_VALID" : null,
      canUseValidSchema: false,
      validationError: null,
    });
  }

  function validateLastValidSource(source: string, expectedHash: string): void {
    void options.parseSource(source).then(
      (result) => {
        if (disposed) return;
        if (!result.ok || result.sourceHash !== expectedHash) {
          publish({ fallbackGraphResolved: true });
          return;
        }
        lastValidGraph = result.graph;
        if (snapshot.validation !== "VALID") {
          publish({
            activeGraph: result.graph,
            activeGraphSource: "LAST_VALID",
            fallbackGraphResolved: true,
            canUseValidSchema: false,
          });
          return;
        }
        publish({ fallbackGraphResolved: true });
      },
      () => {
        if (!disposed) publish({ fallbackGraphResolved: true });
      },
    );
  }

  function queueSave(source: string, requestGeneration: number): void {
    queuedSave = { source, generation: requestGeneration };
    void pumpSaveQueue();
  }

  function pumpSaveQueue(): Promise<void> {
    if (savePump) return savePump;
    if (disposed || snapshot.persistence === "CONFLICT") return Promise.resolve();
    savePump = drainSaveQueue().finally(() => {
      savePump = null;
      const currentPersistence = snapshot.persistence as SourcePersistenceStatus;
      if (queuedSave && currentPersistence !== "CONFLICT" && currentPersistence !== "ERROR") {
        void pumpSaveQueue();
      }
    });
    return savePump;
  }

  async function drainSaveQueue(): Promise<void> {
    while (!disposed && snapshot.persistence !== "CONFLICT") {
      const candidate = queuedSave;
      if (!candidate) return;
      queuedSave = undefined;

      const sourceHash = await hashSource(candidate.source);
      if (disposed) return;
      const newerQueuedSave = queuedSave as QueuedSave | undefined;
      if (newerQueuedSave && newerQueuedSave.generation > candidate.generation) continue;
      if (sourceHash === persistedSourceHash && candidate.source === persistedSource) {
        if (candidate.generation === generation && candidate.source === snapshot.source) {
          publish({ sourceHash, persistence: "SAVED", persistenceError: null });
        }
        continue;
      }

      activeSave = true;
      if (candidate.generation === generation && candidate.source === snapshot.source) {
        publish({ persistence: "SAVING", persistenceError: null });
      }
      const expectedSchemaRevisionNo = snapshot.expectedSchemaRevisionNo;
      const beforeState = snapshot.serverState;

      try {
        const response = await options.saveDraft({
          projectId,
          source: candidate.source,
          expectedSchemaRevisionNo,
        });
        assertSaveResponse(
          response,
          projectId,
          candidate.source,
          sourceHash,
          expectedSchemaRevisionNo,
        );
        const state = response.state;
        persistedSource = candidate.source;
        persistedSourceHash = sourceHash;
        const serverOutcome: SourceValidationOutcome = {
          validity: state.currentRevision.validity,
          diagnostics: response.diagnostics,
          graph: null,
        };
        serverOutcomes.set(sourceHash, serverOutcome);
        options.onServerState?.(state);
        publish({
          expectedSchemaRevisionNo: state.project.schemaRevisionNo,
          serverState: state,
          persistence:
            candidate.source === snapshot.source && candidate.generation === generation
              ? "SAVED"
              : "DIRTY",
          persistenceError: null,
        });
        options.onDraftCommitted?.(beforeState, response);

        if (
          failedWorkerHashes.has(sourceHash) &&
          candidate.source === snapshot.source &&
          candidate.generation === generation
        ) {
          publish({ diagnostics: response.diagnostics });
        }

        const workerOutcome = workerOutcomes.get(sourceHash);
        if (
          candidate.source === snapshot.source &&
          candidate.generation === generation &&
          workerOutcome
        ) {
          applyWorkerOutcome(sourceHash, workerOutcome);
        }
      } catch (error) {
        queuedSave = undefined;
        if (isRevisionConflict(error)) {
          publish({
            persistence: "CONFLICT",
            persistenceError: publicPersistenceError(error),
          });
          void refreshConflictState();
        } else {
          publish({
            persistence: "ERROR",
            persistenceError: publicPersistenceError(error),
          });
        }
        return;
      } finally {
        activeSave = false;
      }
    }
  }

  async function refreshConflictState(): Promise<void> {
    try {
      const state = await options.loadProject();
      if (disposed || state.project.id !== projectId || snapshot.persistence !== "CONFLICT") return;
      publish({ conflictState: state });
    } catch {
      // The conflict remains recoverable by retrying the project load from the UI.
    }
  }

  function retrySave(): void {
    if (disposed || snapshot.persistence !== "ERROR") return;
    publish({ persistence: "DIRTY", persistenceError: null });
    queueSave(snapshot.source, generation);
  }

  function retryValidation(): void {
    if (disposed) return;
    const resourceError = options.validateSource?.(snapshot.source) ?? null;
    if (resourceError) {
      publish({ validation: "ERROR", validationError: resourceError });
      return;
    }
    void validateCurrentSource(snapshot.source, generation);
  }

  function retryLocalDraft(): void {
    if (disposed || snapshot.persistence !== "CONFLICT" || !snapshot.conflictState) return;
    publish({
      expectedSchemaRevisionNo: snapshot.conflictState.project.schemaRevisionNo,
      serverState: snapshot.conflictState,
      conflictState: null,
      persistence: "DIRTY",
      persistenceError: null,
    });
    queueSave(snapshot.source, generation);
  }

  function loadServerDraft(): string | null {
    if (disposed || snapshot.persistence !== "CONFLICT" || !snapshot.conflictState) return null;
    const state = snapshot.conflictState;
    generation += 1;
    clearDebounce();
    queuedSave = undefined;
    persistedSource = state.project.draftSource;
    persistedSourceHash = state.project.draftHash;
    lastValidGraph = null;
    workerOutcomes.clear();
    serverOutcomes.clear();
    failedWorkerHashes.clear();
    serverOutcomes.set(persistedSourceHash, {
      validity: state.currentRevision.validity,
      diagnostics: [],
      graph: null,
    });
    snapshot = initialSnapshot(state);
    for (const listener of listeners) listener();
    void validateCurrentSource(snapshot.source, generation);
    if (
      state.currentRevision.validity === "INVALID" &&
      state.lastValidRevision &&
      state.lastValidRevision.sourceHash !== state.currentRevision.sourceHash
    ) {
      validateLastValidSource(state.lastValidRevision.source, state.lastValidRevision.sourceHash);
    }
    return state.project.draftSource;
  }

  async function adoptCommittedState(
    state: ProjectState,
    diagnostics: readonly Diagnostic[] = [],
  ): Promise<SourceSessionSnapshot> {
    assertCommittedState(state, projectId);
    if (disposed) return snapshot;
    if (activeSave || savePump || queuedSave) {
      throw clientStateError(
        "CLIENT_SOURCE_SESSION_BUSY",
        "The source session cannot adopt server state while a draft write is active.",
      );
    }
    generation += 1;
    clearDebounce();
    const previousActiveGraph = snapshot.activeGraph;
    persistedSource = state.project.draftSource;
    persistedSourceHash = state.project.draftHash;
    lastValidGraph = null;
    workerOutcomes.clear();
    serverOutcomes.clear();
    failedWorkerHashes.clear();
    serverOutcomes.set(persistedSourceHash, {
      validity: state.currentRevision.validity,
      diagnostics: [...diagnostics],
      graph: null,
    });
    snapshot = {
      ...initialSnapshot(state),
      // Keep the inspector mounted while the authoritative source is reparsed. The graph is
      // display-only during this transition: no source is associated with it and schema actions
      // remain disabled until validation publishes the new current or last-valid graph.
      activeGraph: previousActiveGraph,
    };
    for (const listener of listeners) listener();
    options.onAdoptCommittedSource?.(persistedSource);
    options.onServerState?.(state);
    await validateCurrentSource(snapshot.source, generation);
    if (
      state.currentRevision.validity === "INVALID" &&
      state.lastValidRevision &&
      state.lastValidRevision.sourceHash !== state.currentRevision.sourceHash
    ) {
      validateLastValidSource(state.lastValidRevision.source, state.lastValidRevision.sourceHash);
    }
    return snapshot;
  }

  function clearDebounce(): void {
    if (debounceTimer === undefined) return;
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }

  function dispose(): void {
    if (disposed) return;
    clearDebounce();
    disposed = true;
    listeners.clear();
    queuedSave = undefined;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    edit,
    flush,
    flushAndWait,
    adoptCommittedState,
    retrySave,
    retryValidation,
    retryLocalDraft,
    loadServerDraft,
    dispose,
  };
}

function assertCommittedState(state: ProjectState, projectId: string): void {
  if (
    state.project.id !== projectId ||
    state.currentRevision.projectId !== projectId ||
    state.project.draftSource !== state.currentRevision.source ||
    state.project.draftHash !== state.currentRevision.sourceHash ||
    state.project.schemaRevisionNo !== state.currentRevision.revisionNo ||
    state.project.parserVersion !== state.currentRevision.parserVersion
  ) {
    throw clientStateError(
      "CLIENT_COMMITTED_STATE_MISMATCH",
      "The committed project state did not satisfy the source session contract.",
    );
  }
}

function clientStateError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function initialSnapshot(state: ProjectState): SourceSessionSnapshot {
  const fallbackGraphPending =
    state.currentRevision.validity === "INVALID" &&
    state.lastValidRevision !== null &&
    state.lastValidRevision.sourceHash !== state.currentRevision.sourceHash;
  return {
    source: state.project.draftSource,
    sourceHash: null,
    expectedSchemaRevisionNo: state.project.schemaRevisionNo,
    persistence: "SAVED",
    validation: "PENDING",
    diagnostics: [],
    activeGraph: null,
    activeGraphSource: null,
    fallbackGraphResolved: !fallbackGraphPending,
    canUseValidSchema: false,
    serverState: state,
    conflictState: null,
    persistenceError: null,
    validationError: null,
  };
}

function assertSaveResponse(
  response: ProjectMutationResponse,
  projectId: string,
  source: string,
  sourceHash: string,
  expectedSchemaRevisionNo: number,
): void {
  const { project, currentRevision } = response.state;
  if (
    project.id !== projectId ||
    currentRevision.projectId !== projectId ||
    project.draftSource !== source ||
    currentRevision.source !== source ||
    project.draftHash !== sourceHash ||
    currentRevision.sourceHash !== sourceHash ||
    project.schemaRevisionNo !== currentRevision.revisionNo ||
    project.schemaRevisionNo !== expectedSchemaRevisionNo + (response.revisionCreated ? 1 : 0) ||
    project.parserVersion !== currentRevision.parserVersion
  ) {
    const error = new Error("The saved draft response did not match its request.");
    Object.assign(error, { code: "CLIENT_SAVE_RESPONSE_MISMATCH" });
    throw error;
  }
}

function isRevisionConflict(error: unknown): error is ProjectApiError {
  return (
    error instanceof Error &&
    "status" in error &&
    (error as { readonly status?: unknown }).status === 409
  );
}

function publicPersistenceError(error: unknown): SourceSessionError {
  if (error instanceof Error) {
    const value = error as Error & {
      readonly code?: unknown;
      readonly correlationId?: unknown;
      readonly currentRevisionNo?: unknown;
    };
    return {
      code: typeof value.code === "string" ? value.code : "SOURCE_SAVE_FAILED",
      message:
        typeof value.code === "string"
          ? value.message
          : "The draft could not be saved. Your local source is unchanged.",
      ...(typeof value.correlationId === "string" ? { correlationId: value.correlationId } : {}),
      ...(typeof value.currentRevisionNo === "number"
        ? { currentRevisionNo: value.currentRevisionNo }
        : {}),
    };
  }
  return {
    code: "SOURCE_SAVE_FAILED",
    message: "The draft could not be saved. Your local source is unchanged.",
  };
}
