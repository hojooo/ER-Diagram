import type { DiagramLayoutValue, LayoutResponse } from "@er-diagram/contracts";

import type { ProjectApiError, SaveLayoutInput } from "../projects/project-api.js";

export const LAYOUT_AUTOSAVE_DEBOUNCE_MS = 500;

export type LayoutPersistenceStatus =
  | "LOADING"
  | "SAVED"
  | "DIRTY"
  | "SAVING"
  | "ERROR"
  | "CONFLICT";

export interface LayoutViewSnapshot {
  readonly viewKey: string;
  readonly layout: DiagramLayoutValue;
  readonly persistedLayout: DiagramLayoutValue | null;
  readonly persistedRevisionNo: number | null;
  readonly hydrated: boolean;
  readonly status: LayoutPersistenceStatus;
  readonly error: ProjectApiError | null;
}

export interface LayoutConflictState {
  readonly viewKey: string;
  readonly server: LayoutResponse;
}

export interface LayoutSessionSnapshot {
  readonly currentLayoutRevisionNo: number;
  readonly views: ReadonlyMap<string, LayoutViewSnapshot>;
  readonly conflict: LayoutConflictState | null;
  readonly hasUnsavedChanges: boolean;
}

export interface LayoutSessionController {
  getSnapshot(): LayoutSessionSnapshot;
  subscribe(listener: () => void): () => void;
  hydrate(viewKey: string, fallback: DiagramLayoutValue): Promise<void>;
  edit(viewKey: string, layout: DiagramLayoutValue): void;
  replaceAndFlush(viewKey: string, layout: DiagramLayoutValue): Promise<void>;
  flush(): Promise<void>;
  retrySave(): Promise<void>;
  retryLocalLayout(): Promise<void>;
  loadServerLayout(): Promise<void>;
  adoptCommittedRevision(
    revisionNo: number,
    refreshHydratedViews: boolean,
  ): Promise<{ readonly refreshFailed: boolean }>;
  retainViews(viewKeys: ReadonlySet<string>): void;
  dispose(): void;
}

export interface CreateLayoutSessionOptions {
  readonly projectId: string;
  readonly initialLayoutRevisionNo: number;
  readonly loadLayout: (viewKey: string) => Promise<LayoutResponse>;
  readonly saveLayout: (input: SaveLayoutInput) => Promise<{
    readonly state: LayoutResponse;
    readonly layoutUpdated: boolean;
  }>;
  readonly onLayoutRevision?: (revisionNo: number) => void;
}

interface MutableViewState {
  viewKey: string;
  layout: DiagramLayoutValue;
  persistedLayout: DiagramLayoutValue | null;
  persistedRevisionNo: number | null;
  fallback: DiagramLayoutValue;
  hydrated: boolean;
  status: LayoutPersistenceStatus;
  error: ProjectApiError | null;
  dirty: boolean;
}

export function createLayoutSession(options: CreateLayoutSessionOptions): LayoutSessionController {
  let currentLayoutRevisionNo = options.initialLayoutRevisionNo;
  const views = new Map<string, MutableViewState>();
  const listeners = new Set<() => void>();
  const pendingViewKeys: string[] = [];
  const pendingSet = new Set<string>();
  let conflict: LayoutConflictState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let drainPromise: Promise<void> | null = null;
  let disposed = false;

  function snapshot(): LayoutSessionSnapshot {
    const publicViews = new Map<string, LayoutViewSnapshot>();
    for (const [key, view] of views) {
      publicViews.set(key, {
        viewKey: view.viewKey,
        layout: cloneLayout(view.layout),
        persistedLayout: view.persistedLayout ? cloneLayout(view.persistedLayout) : null,
        persistedRevisionNo: view.persistedRevisionNo,
        hydrated: view.hydrated,
        status: view.status,
        error: view.error,
      });
    }
    return {
      currentLayoutRevisionNo,
      views: publicViews,
      conflict,
      hasUnsavedChanges: [...views.values()].some(
        (view) => view.dirty || view.status === "SAVING" || view.status === "CONFLICT",
      ),
    };
  }

  function notify(): void {
    if (disposed) return;
    for (const listener of listeners) listener();
  }

  function updateRevision(revisionNo: number): void {
    if (revisionNo <= currentLayoutRevisionNo) return;
    currentLayoutRevisionNo = revisionNo;
    options.onLayoutRevision?.(revisionNo);
  }

  function enqueue(viewKey: string): void {
    if (!pendingSet.has(viewKey)) {
      pendingSet.add(viewKey);
      pendingViewKeys.push(viewKey);
    }
  }

  function schedule(): void {
    if (disposed || conflict || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, LAYOUT_AUTOSAVE_DEBOUNCE_MS);
  }

  async function hydrate(viewKey: string, fallback: DiagramLayoutValue): Promise<void> {
    const existing = views.get(viewKey);
    if (existing && existing.status !== "ERROR") return;
    const view: MutableViewState = existing ?? {
      viewKey,
      layout: cloneLayout(fallback),
      persistedLayout: null,
      persistedRevisionNo: null,
      fallback: cloneLayout(fallback),
      hydrated: false,
      status: "LOADING",
      error: null,
      dirty: false,
    };
    view.fallback = cloneLayout(fallback);
    view.status = "LOADING";
    view.error = null;
    views.set(viewKey, view);
    notify();
    try {
      const response = await options.loadLayout(viewKey);
      if (disposed) return;
      updateRevision(response.currentLayoutRevisionNo);
      if (!view.dirty) {
        view.layout = response.layout ? stripIdentity(response.layout) : cloneLayout(view.fallback);
        view.persistedLayout = response.layout ? stripIdentity(response.layout) : null;
        view.persistedRevisionNo = response.layout?.revisionNo ?? null;
      }
      view.hydrated = true;
      view.status = view.dirty ? "DIRTY" : "SAVED";
    } catch (error) {
      if (disposed) return;
      view.status = "ERROR";
      view.error = publicError(error);
    }
    notify();
  }

  function edit(viewKey: string, layout: DiagramLayoutValue): void {
    const view = views.get(viewKey);
    if (!view || view.status === "LOADING") return;
    view.layout = cloneLayout(layout);
    view.dirty = !layoutEqual(view.layout, view.persistedLayout);
    view.status = view.dirty ? "DIRTY" : "SAVED";
    view.error = null;
    if (view.dirty) {
      enqueue(viewKey);
      schedule();
    } else {
      pendingSet.delete(viewKey);
    }
    notify();
  }

  async function replaceAndFlush(viewKey: string, layout: DiagramLayoutValue): Promise<void> {
    edit(viewKey, layout);
    await flush();
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await drain();
  }

  function drain(): Promise<void> {
    if (drainPromise) return drainPromise;
    if (disposed || conflict) return Promise.resolve();
    drainPromise = (async () => {
      while (!disposed && !conflict && pendingViewKeys.length > 0) {
        const viewKey = pendingViewKeys.shift();
        if (!viewKey) continue;
        pendingSet.delete(viewKey);
        const view = views.get(viewKey);
        if (!view?.dirty) continue;
        const sentLayout = cloneLayout(view.layout);
        view.status = "SAVING";
        view.error = null;
        notify();
        try {
          const response = await options.saveLayout({
            projectId: options.projectId,
            viewKey,
            expectedLayoutRevisionNo: currentLayoutRevisionNo,
            layout: sentLayout,
          });
          if (disposed) return;
          updateRevision(response.state.currentLayoutRevisionNo);
          view.persistedLayout = response.state.layout
            ? stripIdentity(response.state.layout)
            : cloneLayout(sentLayout);
          view.persistedRevisionNo = response.state.layout?.revisionNo ?? null;
          view.dirty = !layoutEqual(view.layout, sentLayout);
          view.status = view.dirty ? "DIRTY" : "SAVED";
          if (view.dirty) enqueue(viewKey);
        } catch (error) {
          if (disposed) return;
          const apiError = publicError(error);
          view.error = apiError;
          if (isConflict(apiError)) {
            try {
              const server = await options.loadLayout(viewKey);
              if (disposed) return;
              updateRevision(server.currentLayoutRevisionNo);
              conflict = { viewKey, server };
              view.status = "CONFLICT";
            } catch (loadError) {
              if (disposed) return;
              view.error = publicError(loadError);
              view.status = "ERROR";
            }
          } else {
            view.status = "ERROR";
          }
        }
        notify();
      }
    })().finally(() => {
      drainPromise = null;
    });
    return drainPromise;
  }

  async function retrySave(): Promise<void> {
    for (const view of views.values()) {
      if (view.status !== "ERROR" || !view.dirty) continue;
      view.status = "DIRTY";
      view.error = null;
      enqueue(view.viewKey);
    }
    notify();
    await flush();
  }

  async function retryLocalLayout(): Promise<void> {
    if (!conflict) return;
    const view = views.get(conflict.viewKey);
    if (!view) return;
    const viewKey = conflict.viewKey;
    conflict = null;
    view.status = "DIRTY";
    view.error = null;
    view.dirty = true;
    enqueue(viewKey);
    notify();
    await flush();
  }

  async function loadServerLayout(): Promise<void> {
    if (!conflict) return;
    const state = conflict;
    const view = views.get(state.viewKey);
    conflict = null;
    if (view) {
      view.layout = state.server.layout
        ? stripIdentity(state.server.layout)
        : cloneLayout(view.fallback);
      view.persistedLayout = state.server.layout ? stripIdentity(state.server.layout) : null;
      view.persistedRevisionNo = state.server.layout?.revisionNo ?? null;
      view.dirty = false;
      view.status = "SAVED";
      view.error = null;
    }
    notify();
    await drain();
  }

  async function adoptCommittedRevision(
    revisionNo: number,
    refreshHydratedViews: boolean,
  ): Promise<{ readonly refreshFailed: boolean }> {
    if (!Number.isSafeInteger(revisionNo) || revisionNo < currentLayoutRevisionNo) {
      throw new RangeError("Committed layout revision must not move backwards.");
    }
    if (conflict || [...views.values()].some((view) => view.dirty || view.status === "SAVING")) {
      throw new Error("Committed layout state cannot be adopted while local layout writes exist.");
    }
    updateRevision(revisionNo);
    if (!refreshHydratedViews) {
      notify();
      return { refreshFailed: false };
    }

    let refreshFailed = false;
    const hydratedViews = [...views.values()]
      .filter((view) => view.hydrated)
      .sort((left, right) => compareStrings(left.viewKey, right.viewKey));
    for (const view of hydratedViews) {
      view.status = "LOADING";
      view.error = null;
      notify();
      try {
        const response = await options.loadLayout(view.viewKey);
        if (disposed) return { refreshFailed };
        updateRevision(response.currentLayoutRevisionNo);
        view.layout = response.layout ? stripIdentity(response.layout) : cloneLayout(view.fallback);
        view.persistedLayout = response.layout ? stripIdentity(response.layout) : null;
        view.persistedRevisionNo = response.layout?.revisionNo ?? null;
        view.dirty = false;
        view.status = "SAVED";
      } catch (error) {
        if (disposed) return { refreshFailed: true };
        refreshFailed = true;
        view.status = "ERROR";
        view.error = publicError(error);
      }
      notify();
    }
    return { refreshFailed };
  }

  function retainViews(viewKeys: ReadonlySet<string>): void {
    let changed = false;
    for (const viewKey of views.keys()) {
      if (viewKeys.has(viewKey)) continue;
      views.delete(viewKey);
      pendingSet.delete(viewKey);
      changed = true;
    }
    for (let index = pendingViewKeys.length - 1; index >= 0; index -= 1) {
      const viewKey = pendingViewKeys[index];
      if (viewKey && viewKeys.has(viewKey)) continue;
      pendingViewKeys.splice(index, 1);
    }
    if (conflict && !viewKeys.has(conflict.viewKey)) {
      conflict = null;
      changed = true;
    }
    if (changed) notify();
  }

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hydrate,
    edit,
    replaceAndFlush,
    flush,
    retrySave,
    retryLocalLayout,
    loadServerLayout,
    adoptCommittedRevision,
    retainViews,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      listeners.clear();
    },
  };
}

export function createDefaultLayoutValue(schemaHash: string): DiagramLayoutValue {
  return {
    positions: {},
    collapsedGroupKeys: [],
    hiddenElementKeys: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    detailLevel: "FULL",
    baseSchemaHash: schemaHash,
  };
}

function stripIdentity(layout: NonNullable<LayoutResponse["layout"]>): DiagramLayoutValue {
  return {
    positions: clonePositions(layout.positions),
    collapsedGroupKeys: [...layout.collapsedGroupKeys],
    hiddenElementKeys: [...layout.hiddenElementKeys],
    viewport: { ...layout.viewport },
    detailLevel: layout.detailLevel,
    baseSchemaHash: layout.baseSchemaHash,
  };
}

function cloneLayout(layout: DiagramLayoutValue): DiagramLayoutValue {
  return {
    positions: clonePositions(layout.positions),
    collapsedGroupKeys: [...layout.collapsedGroupKeys],
    hiddenElementKeys: [...layout.hiddenElementKeys],
    viewport: { ...layout.viewport },
    detailLevel: layout.detailLevel,
    baseSchemaHash: layout.baseSchemaHash,
  };
}

function clonePositions(
  positions: DiagramLayoutValue["positions"],
): DiagramLayoutValue["positions"] {
  return Object.fromEntries(
    Object.entries(positions).map(([key, position]) => [key, { ...position }]),
  );
}

function layoutEqual(left: DiagramLayoutValue, right: DiagramLayoutValue | null): boolean {
  return (
    right !== null &&
    JSON.stringify(canonicalLayout(left)) === JSON.stringify(canonicalLayout(right))
  );
}

function canonicalLayout(layout: DiagramLayoutValue): DiagramLayoutValue {
  return {
    positions: Object.fromEntries(
      Object.entries(layout.positions)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, position]) => [key, { ...position }]),
    ),
    collapsedGroupKeys: [...layout.collapsedGroupKeys].sort(compareStrings),
    hiddenElementKeys: [...layout.hiddenElementKeys].sort(compareStrings),
    viewport: { ...layout.viewport },
    detailLevel: layout.detailLevel,
    baseSchemaHash: layout.baseSchemaHash,
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function publicError(error: unknown): ProjectApiError {
  if (isProjectApiError(error)) return error;
  return Object.assign(new Error("The layout could not be saved."), {
    name: "ProjectApiError",
    status: null,
    code: "CLIENT_LAYOUT_ERROR",
    correlationId: undefined,
    currentRevisionNo: undefined,
  }) as ProjectApiError;
}

function isProjectApiError(error: unknown): error is ProjectApiError {
  return (
    error instanceof Error && "status" in error && "code" in error && typeof error.code === "string"
  );
}

function isConflict(error: ProjectApiError): boolean {
  return error.status === 409 && error.code === "LAYOUT_REVISION_CONFLICT";
}
