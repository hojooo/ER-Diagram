import type {
  Diagnostic,
  DiagramLayoutValue,
  DiagramPosition,
  DiagramViewport,
  ProjectResponse,
  ProjectState,
  ProjectsResponse,
  VisualCommand,
} from "@er-diagram/contracts";
import { utf8ByteLength } from "@er-diagram/contracts";
import { diffSchemaGraphs, recoverLayoutStableKeys, type SchemaGraph } from "@er-diagram/core";
import * as Dialog from "@radix-ui/react-dialog";
import type { QueryClient } from "@tanstack/react-query";
import {
  lazy,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useBlocker } from "react-router-dom";

import type {
  BaseSchemaDiagramComponent,
  BaseSchemaDiagramProps,
  DiagramLayoutRequest,
  DiagramLayoutRequestResult,
  DiagramViewportInsets,
} from "../diagram/base-schema-diagram-contract.js";
import { toggleCollapsedGroup } from "../diagram/collapse-state.js";
import { DiagramWorkspaceControls } from "../diagram/diagram-workspace-controls.js";
import {
  createDefaultLayoutValue,
  createLayoutSession,
  type LayoutConflictState,
  type LayoutSessionController,
  type LayoutSessionSnapshot,
  type LayoutViewSnapshot,
} from "../diagram/layout-session.js";
import { requestWorkerLayout } from "../diagram/layout-worker-client.js";
import {
  createDiagramVisibility,
  GLOBAL_VIEW_KEY,
  listDiagramViews,
} from "../diagram/projection.js";
import { SchemaOutline } from "../diagram/schema-outline.js";
import { createDiagramSelectionStore } from "../diagram/selection-store.js";
import {
  createDiagramNavigationIndex,
  type DiagramSelection,
  findDiagramSelectionAtCursor,
  type SourceCursorPosition,
} from "../diagram/source-navigation.js";
import type {
  DiagramFocusRequest,
  DiagramLod,
  DiagramSearchResult,
  DiagramViewKey,
  DiagramVisibility,
} from "../diagram/types.js";
import { resolveDiagramViewKey } from "../diagram/view-session-state.js";
import { SchemaHistoryControls } from "../history/history-controls.js";
import {
  createSchemaHistorySession,
  type SchemaHistorySessionController,
  type SchemaHistorySessionSnapshot,
} from "../history/history-session.js";
import type { ProjectApi } from "../projects/project-api.js";
import type { UiMessages } from "../localization/messages.js";
import { LanguageSelect, useUiLocale } from "../localization/ui-locale.js";
import { dialectLabel, ValidityBadge } from "../projects/project-home-page.js";
import { projectQueryKeys } from "../projects/project-queries.js";
import { useRuntimeResourceLimits } from "../runtime-config.js";
import {
  createVisualCommandSession,
  type VisualCommandSessionController,
  type VisualCommandSessionSnapshot,
} from "../visual-editor/visual-command-session.js";
import { VisualSchemaInspector } from "../visual-editor/visual-schema-inspector.js";
import {
  CanvasWorkspaceShell,
  useCanvasWorkspaceSurfaces,
} from "../workspace/canvas-workspace-shell.js";
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

const NO_COLLAPSED_GROUP_KEYS: ReadonlySet<string> = new Set();

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
  const { messages } = useUiLocale();
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const runtimeLimits = useRuntimeResourceLimits();
  const [sessionSnapshot, setSessionSnapshot] = useState<SourceSessionSnapshot | null>(null);
  const sessionRef = useRef<SourceSessionController | null>(null);
  const [layoutSnapshot, setLayoutSnapshot] = useState<LayoutSessionSnapshot | null>(null);
  const layoutSessionRef = useRef<LayoutSessionController | null>(null);
  const [visualCommandSession, setVisualCommandSession] =
    useState<VisualCommandSessionController | null>(null);
  const [visualCommandSnapshot, setVisualCommandSnapshot] =
    useState<VisualCommandSessionSnapshot | null>(null);
  const [historySession, setHistorySession] = useState<SchemaHistorySessionController | null>(null);
  const [historySnapshot, setHistorySnapshot] = useState<SchemaHistorySessionSnapshot | null>(null);
  const historySessionRef = useRef<SchemaHistorySessionController | null>(null);
  const editorRef = useRef<SourceEditorHandle>(null);
  const lastCursorPositionRef = useRef<SourceCursorPosition | null>(null);
  const pendingSourceNavigationRef = useRef<
    import("@er-diagram/contracts").SourceRange | "FOCUS" | null
  >(null);
  const recoverySourceOpenedRef = useRef(false);
  const flushedBlockedNavigationRef = useRef(false);
  const flushedBlockedLayoutNavigationRef = useRef(false);
  const proceededBlockedNavigationRef = useRef(false);
  const blockedNavigationReturnFocusRef = useRef<HTMLElement | null>(null);
  const focusRequestIdRef = useRef(0);
  const viewTransitionGenerationRef = useRef(0);
  const layoutRequestIdRef = useRef(0);
  const previousGraphRef = useRef<SchemaGraph | null>(null);
  const skipNextClientRenameRecoveryRef = useRef(false);
  const lastAppliedVisualCommandRef = useRef<VisualCommand | null>(null);
  const lastExternalHistoryRevisionRef = useRef<number | null>(null);
  const renderedLayoutRef = useRef<{
    readonly viewKey: DiagramViewKey;
    readonly positions: Readonly<Record<string, DiagramPosition>>;
  } | null>(null);
  const [selectionStore] = useState(createDiagramSelectionStore);
  const [activeViewKey, setActiveViewKey] = useState<DiagramViewKey>(GLOBAL_VIEW_KEY);
  const [searchQuery, setSearchQuery] = useState("");
  const [focusRequest, setFocusRequest] = useState<DiagramFocusRequest | null>(null);
  const [layoutRequest, setLayoutRequest] = useState<DiagramLayoutRequest | null>(null);
  const [layoutPreview, setLayoutPreview] = useState<DiagramLayoutRequestResult | null>(null);
  const [layoutWorkflowError, setLayoutWorkflowError] = useState<string | null>(null);
  const [layoutRecoveryNotice, setLayoutRecoveryNotice] = useState<string | null>(null);
  const [hiddenSourceSelection, setHiddenSourceSelection] = useState<{
    selection: DiagramSelection;
    viewLabel: string;
  } | null>(null);
  const surfaces = useCanvasWorkspaceSurfaces({
    initialRightPanelOpen:
      initialState.currentRevision.validity === "VALID" || initialState.lastValidRevision !== null,
  });
  const [viewportInsets, setViewportInsets] = useState<DiagramViewportInsets | null>(null);
  const projectId = initialState.project.id;
  const initialStateRef = useRef(initialState);
  const prioritizeInitialDiagram =
    adapters?.SourceEditor === undefined && initialState.currentRevision.validity === "VALID";
  const [initialDiagramReady, setInitialDiagramReady] = useState(!prioritizeInitialDiagram);
  const [sourceEditorLoadReady, setSourceEditorLoadReady] = useState(!prioritizeInitialDiagram);
  const [sourceEditorReady, setSourceEditorReady] = useState(adapters?.SourceEditor !== undefined);
  const EditorComponent = adapters?.SourceEditor ?? LazyMonacoDbmlEditor;
  const DiagramComponent = adapters?.SchemaDiagram ?? LazyBaseSchemaDiagram;
  const requestBoundedLayout = useCallback(
    (projection: Parameters<typeof requestWorkerLayout>[0]) =>
      requestWorkerLayout(projection, {
        timeoutMs: runtimeLimits.layoutTimeoutMs,
        maxNodes: runtimeLimits.maxLayoutNodes,
        maxEdges: runtimeLimits.maxLayoutEdges,
      }),
    [runtimeLimits.layoutTimeoutMs, runtimeLimits.maxLayoutEdges, runtimeLimits.maxLayoutNodes],
  );
  const activeGraph = sessionSnapshot?.activeGraph ?? null;
  const sourceNavigationEnabled = sessionSnapshot?.activeGraphSource === "CURRENT_DRAFT";
  const sourceNavigationReady = sourceNavigationEnabled && sourceEditorReady;
  const resolvedViewKey = activeGraph
    ? resolveDiagramViewKey(activeGraph, activeViewKey)
    : GLOBAL_VIEW_KEY;
  const defaultLayout = useMemo(
    () => createDefaultLayoutValue(activeGraph?.schemaHash ?? "0".repeat(64)),
    [activeGraph?.schemaHash],
  );
  const activeLayoutView = layoutSnapshot?.views.get(resolvedViewKey) ?? null;
  const activeLayout = activeLayoutView?.layout ?? defaultLayout;
  const availableGroupKeys = useMemo(
    () => new Set(activeGraph?.groups.map((group) => group.key) ?? []),
    [activeGraph],
  );
  const activeCollapsedGroupKeys = useMemo(() => {
    const collapsed = activeLayout.collapsedGroupKeys.filter((groupKey) =>
      availableGroupKeys.has(groupKey),
    );
    return collapsed.length === 0 ? NO_COLLAPSED_GROUP_KEYS : new Set(collapsed);
  }, [activeLayout.collapsedGroupKeys, availableGroupKeys]);
  const visibility = useMemo(
    () => (activeGraph ? createDiagramVisibility(activeGraph, resolvedViewKey) : null),
    [activeGraph, resolvedViewKey],
  );
  const viewLabel = useMemo(
    () =>
      activeGraph
        ? (listDiagramViews(activeGraph).find((view) => view.key === resolvedViewKey)?.label ??
          messages["diagram.global"])
        : messages["diagram.global"],
    [activeGraph, messages, resolvedViewKey],
  );
  const navigationIndex = useMemo(
    () => (activeGraph ? createDiagramNavigationIndex(activeGraph) : null),
    [activeGraph],
  );
  const visualCommandWorkspaceLocked =
    visualCommandSnapshot?.status === "FLUSHING_SOURCE" ||
    visualCommandSnapshot?.status === "FLUSHING_LAYOUT" ||
    visualCommandSnapshot?.status === "SUBMITTING" ||
    visualCommandSnapshot?.status === "UNKNOWN_OUTCOME";
  const visualWorkspaceLocked = visualCommandWorkspaceLocked || historySnapshot?.locked === true;
  const layoutInteractionLocked =
    layoutRequest !== null ||
    visualWorkspaceLocked ||
    visualCommandSnapshot?.layoutRefreshFailed === true;
  const visualSessionsReady = sessionSnapshot !== null && layoutSnapshot !== null;
  const sourceEditorRecoveryRequired =
    sessionSnapshot?.validation === "INVALID" ||
    sessionSnapshot?.validation === "ERROR" ||
    (sessionSnapshot?.validation === "VALID" && activeGraph?.tables.length === 0) ||
    activeLayoutView?.status === "ERROR";

  const openSourceSurface = useCallback(
    (
      range: import("@er-diagram/contracts").SourceRange | null = null,
      trigger?: HTMLElement | null,
    ) => {
      setSourceEditorLoadReady(true);
      surfaces.openLeft("SOURCE", trigger);
      pendingSourceNavigationRef.current = range ?? "FOCUS";
      window.requestAnimationFrame(() => {
        const pending = pendingSourceNavigationRef.current;
        if (!sourceEditorReady || !pending) return;
        if (pending === "FOCUS") editorRef.current?.focus();
        else editorRef.current?.revealSourceRange(pending);
        pendingSourceNavigationRef.current = null;
      });
    },
    [sourceEditorReady, surfaces.openLeft],
  );

  useEffect(() => {
    if (!sourceEditorRecoveryRequired) return;
    setInitialDiagramReady(true);
    setSourceEditorLoadReady(true);
  }, [sourceEditorRecoveryRequired]);

  useEffect(() => {
    if (
      !sessionSnapshot ||
      activeGraph ||
      !sessionSnapshot.fallbackGraphResolved ||
      (sessionSnapshot.validation !== "INVALID" && sessionSnapshot.validation !== "ERROR") ||
      recoverySourceOpenedRef.current
    ) {
      return;
    }
    recoverySourceOpenedRef.current = true;
    setSourceEditorLoadReady(true);
    surfaces.openLeft("SOURCE");
  }, [activeGraph, sessionSnapshot, surfaces.openLeft]);

  useEffect(() => {
    if (!sourceEditorReady || surfaces.leftSurface !== "SOURCE") return;
    if (!pendingSourceNavigationRef.current) return;
    const animationFrame = window.requestAnimationFrame(() => {
      const pending = pendingSourceNavigationRef.current;
      if (!pending) return;
      if (pending === "FOCUS") editorRef.current?.focus();
      else editorRef.current?.revealSourceRange(pending);
      pendingSourceNavigationRef.current = null;
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [sourceEditorReady, surfaces.leftSurface]);

  useEffect(() => {
    if (!initialDiagramReady || sourceEditorLoadReady) return;
    const loadEditor = () => setSourceEditorLoadReady(true);
    if (typeof window.requestIdleCallback === "function") {
      const callbackId = window.requestIdleCallback(loadEditor, { timeout: 2_000 });
      return () => window.cancelIdleCallback(callbackId);
    }
    const timeoutId = window.setTimeout(loadEditor, 0);
    return () => window.clearTimeout(timeoutId);
  }, [initialDiagramReady, sourceEditorLoadReady]);

  const editActiveLayout = useCallback(
    (update: (current: DiagramLayoutValue) => DiagramLayoutValue) => {
      if (!activeGraph || layoutInteractionLocked) return;
      const controller = layoutSessionRef.current;
      const current = controller?.getSnapshot().views.get(resolvedViewKey);
      if (!controller || !current || current.status === "LOADING") return;
      controller.edit(resolvedViewKey, update(current.layout));
    },
    [activeGraph, layoutInteractionLocked, resolvedViewKey],
  );

  const handleCursorPositionChange = useCallback(
    (position: SourceCursorPosition) => {
      if (!sourceNavigationReady || !navigationIndex) {
        selectionStore.getState().setSelection(null);
        setHiddenSourceSelection(null);
        return;
      }
      lastCursorPositionRef.current = position;
      const selection = findDiagramSelectionAtCursor(navigationIndex, position);
      if (!selection) {
        selectionStore.getState().setSelection(null);
        setHiddenSourceSelection(null);
        return;
      }
      if (visibility && isSelectionVisible(selection, visibility)) {
        selectionStore.getState().setSelection(selection);
        setHiddenSourceSelection(null);
        return;
      }
      selectionStore.getState().setSelection(null);
      setHiddenSourceSelection({ selection, viewLabel });
    },
    [navigationIndex, selectionStore, sourceNavigationReady, viewLabel, visibility],
  );

  const handleNavigateSource = useCallback(
    (selection: DiagramSelection) => {
      if (!sourceNavigationEnabled || !activeGraph) return;
      const range = activeGraph.sourceMap[selection.elementKey];
      if (range) openSourceSurface(range);
    },
    [activeGraph, openSourceSurface, sourceNavigationEnabled],
  );

  const handleToggleGroup = useCallback(
    (groupKey: string) => {
      editActiveLayout((current) => {
        const collapsed = toggleCollapsedGroup(new Set(current.collapsedGroupKeys), groupKey);
        return {
          ...current,
          collapsedGroupKeys: [...collapsed],
          baseSchemaHash: activeGraph?.schemaHash ?? current.baseSchemaHash,
        };
      });
    },
    [activeGraph?.schemaHash, editActiveLayout],
  );

  const handleViewChange = useCallback(
    (viewKey: DiagramViewKey) => {
      if (layoutInteractionLocked) return;
      setFocusRequest(null);
      setLayoutWorkflowError(null);
      const controller = layoutSessionRef.current;
      if (!controller) {
        setActiveViewKey(viewKey);
        return;
      }
      viewTransitionGenerationRef.current += 1;
      const generation = viewTransitionGenerationRef.current;
      void controller.hydrate(viewKey, defaultLayout, { publishLoading: false }).then(() => {
        if (viewTransitionGenerationRef.current !== generation) return;
        setActiveViewKey(viewKey);
      });
    },
    [defaultLayout, layoutInteractionLocked],
  );

  const handleDetailLevelChange = useCallback(
    (detailLevel: DiagramLod) => {
      editActiveLayout((current) => {
        return {
          ...current,
          detailLevel,
          baseSchemaHash: activeGraph?.schemaHash ?? current.baseSchemaHash,
        };
      });
      setFocusRequest(null);
    },
    [activeGraph?.schemaHash, editActiveLayout],
  );

  const handleActivateSearchResult = useCallback(
    (result: DiagramSearchResult) => {
      setHiddenSourceSelection(null);
      if (result.kind === "schema") {
        selectionStore.getState().setSelection(null);
        focusRequestIdRef.current += 1;
        setFocusRequest({
          requestId: focusRequestIdRef.current,
          tableKeys: result.tableKeys,
          groupKeys: result.groupKeys,
        });
        return;
      }
      setFocusRequest(null);
      selectionStore.getState().setSelection({
        elementKey: result.elementKey,
        kind: result.kind,
        tableKeys: result.tableKeys,
      });
    },
    [selectionStore],
  );

  const handleShowHiddenSelectionInGlobal = useCallback(() => {
    if (!hiddenSourceSelection) return;
    setActiveViewKey(GLOBAL_VIEW_KEY);
    setFocusRequest(null);
    selectionStore.getState().setSelection(hiddenSourceSelection.selection);
    setHiddenSourceSelection(null);
  }, [hiddenSourceSelection, selectionStore]);

  const handleHistoryUndo = useCallback(() => {
    if (visualCommandWorkspaceLocked) return;
    void historySessionRef.current?.undo();
  }, [visualCommandWorkspaceLocked]);

  const handleHistoryRedo = useCallback(() => {
    if (visualCommandWorkspaceLocked) return;
    void historySessionRef.current?.redo();
  }, [visualCommandWorkspaceLocked]);

  const loadHistoryRevisions = useCallback(async () => {
    const response = await api.listRevisions(projectId);
    queryClient.setQueryData(projectQueryKeys.revisions(projectId), response);
    return response;
  }, [api, projectId, queryClient]);

  useEffect(() => {
    const currentSelection = selectionStore.getState().selection;
    if (
      !activeGraph ||
      (currentSelection &&
        (!activeGraph.sourceMap[currentSelection.elementKey] ||
          (visibility && !isSelectionVisible(currentSelection, visibility))))
    ) {
      selectionStore.getState().setSelection(null);
    }
  }, [activeGraph, selectionStore, visibility]);

  useEffect(() => {
    if (!activeGraph) return;
    layoutSessionRef.current?.retainViews(
      new Set([GLOBAL_VIEW_KEY, ...activeGraph.views.map((view) => view.key)]),
    );
    setActiveViewKey((current) => resolveDiagramViewKey(activeGraph, current));
    setFocusRequest(null);

    const previousGraph = previousGraphRef.current;
    if (previousGraph && previousGraph.schemaHash !== activeGraph.schemaHash) {
      setLayoutRequest(null);
      setLayoutPreview(null);
      renderedLayoutRef.current = null;
      const graphDiff = diffSchemaGraphs(previousGraph, activeGraph);
      const renameCandidates = graphDiff.renameCandidates;
      const controller = layoutSessionRef.current;
      let recoveredCount = 0;
      if (controller && renameCandidates.length > 0 && !skipNextClientRenameRecoveryRef.current) {
        for (const [viewKey, view] of controller.getSnapshot().views) {
          const recovered = recoverLayoutStableKeys(view.layout, renameCandidates);
          if (recovered.recoveredKeys.length === 0) continue;
          recoveredCount += recovered.recoveredKeys.length;
          controller.edit(viewKey, {
            ...recovered.layout,
            positions: Object.fromEntries(
              Object.entries(recovered.layout.positions).map(([key, position]) => [
                key,
                { ...position },
              ]),
            ),
            collapsedGroupKeys: [...recovered.layout.collapsedGroupKeys],
            hiddenElementKeys: [...recovered.layout.hiddenElementKeys],
            baseSchemaHash: activeGraph.schemaHash,
          });
        }
      }
      setLayoutRecoveryNotice(
        skipNextClientRenameRecoveryRef.current
          ? messagesRef.current["layout.renameReloaded"]
          : recoveredCount > 0
            ? messagesRef.current["layout.renameRecovered"](recoveredCount)
            : null,
      );
      const appliedCommand = lastAppliedVisualCommandRef.current;
      if (appliedCommand) {
        applyVisualCommandSelection(selectionStore, previousGraph, activeGraph, appliedCommand);
        lastAppliedVisualCommandRef.current = null;
      }
      skipNextClientRenameRecoveryRef.current = false;
    }
    previousGraphRef.current = activeGraph;
  }, [activeGraph, selectionStore]);

  useEffect(() => {
    if (!activeGraph) return;
    void layoutSessionRef.current?.hydrate(
      resolvedViewKey,
      createDefaultLayoutValue(activeGraph.schemaHash),
    );
  }, [activeGraph, resolvedViewKey]);

  useEffect(() => {
    if (!sourceNavigationReady) {
      setHiddenSourceSelection(null);
      return;
    }
    const position = lastCursorPositionRef.current;
    if (position) handleCursorPositionChange(position);
  }, [handleCursorPositionChange, sourceNavigationReady]);

  useEffect(() => {
    if (!projectId) return;
    viewTransitionGenerationRef.current += 1;
    setActiveViewKey(GLOBAL_VIEW_KEY);
    setSearchQuery("");
    setFocusRequest(null);
    setLayoutRequest(null);
    setLayoutPreview(null);
    setLayoutWorkflowError(null);
    setLayoutRecoveryNotice(null);
    setHiddenSourceSelection(null);
    previousGraphRef.current = null;
    renderedLayoutRef.current = null;
    lastCursorPositionRef.current = null;
    lastExternalHistoryRevisionRef.current = null;
  }, [projectId]);

  useEffect(() => {
    const layoutSession = createLayoutSession({
      projectId,
      initialLayoutRevisionNo: initialStateRef.current.project.layoutRevisionNo,
      loadLayout: async (viewKey) => {
        const response = await api.getLayout({ projectId, viewKey });
        queryClient.setQueryData(projectQueryKeys.layout(projectId, viewKey), response);
        return response;
      },
      saveLayout: async (input) => {
        const response = await api.saveLayout(input);
        queryClient.setQueryData(projectQueryKeys.layout(projectId, input.viewKey), response.state);
        return response;
      },
      onLayoutRevision: (revisionNo) => {
        updateCachedLayoutRevision(queryClient, projectId, revisionNo);
      },
    });
    layoutSessionRef.current = layoutSession;
    const unsubscribe = layoutSession.subscribe(() => {
      setLayoutSnapshot(layoutSession.getSnapshot());
    });
    setLayoutSnapshot(layoutSession.getSnapshot());

    return () => {
      unsubscribe();
      layoutSession.dispose();
      if (layoutSessionRef.current === layoutSession) layoutSessionRef.current = null;
      setLayoutSnapshot(null);
    };
  }, [api, projectId, queryClient]);

  useEffect(() => {
    const parserClient = adapters?.createParserClient
      ? adapters.createParserClient()
      : createDbmlParserWorkerClient({
          timeoutMs: runtimeLimits.dbmlParserTimeoutMs,
          limits: {
            maxSourceBytes: runtimeLimits.maxSourceBytes,
            maxTables: runtimeLimits.maxTables,
            maxReferences: runtimeLimits.maxReferences,
            maxSchemaElements: runtimeLimits.maxSchemaElements,
          },
        });
    const session = createSourceSession({
      initialState: initialStateRef.current,
      parseSource: (source) => parserClient.parse(source),
      validateSource: (source) =>
        utf8ByteLength(source) > runtimeLimits.maxSourceBytes
          ? {
              code: "RESOURCE_SOURCE_TOO_LARGE",
              message: messagesRef.current["source.tooLarge"](runtimeLimits.maxSourceBytes),
            }
          : null,
      saveDraft: (input) => api.saveDraft(input),
      loadProject: async () => {
        const response = await api.getProject(projectId);
        queryClient.setQueryData(projectQueryKeys.detail(projectId), response);
        return response.state;
      },
      onDraftCommitted: (beforeState, response) => {
        historySessionRef.current?.recordCommitted({
          kind: "SOURCE_EDIT",
          before: beforeState,
          response,
        });
      },
      onAdoptCommittedSource: (source) => editorRef.current?.replaceSource(source),
      onServerState: (state) => {
        queryClient.setQueryData<ProjectResponse>(
          projectQueryKeys.detail(projectId),
          (current) => ({
            state: {
              ...state,
              project: {
                ...state.project,
                layoutRevisionNo: Math.max(
                  state.project.layoutRevisionNo,
                  current?.state.project.layoutRevisionNo ?? 0,
                ),
              },
            },
          }),
        );
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
  }, [adapters, api, projectId, queryClient, runtimeLimits]);

  useEffect(() => {
    if (!visualSessionsReady) return;
    const sourceSession = sessionRef.current;
    const layoutSession = layoutSessionRef.current;
    if (!sourceSession || !layoutSession) return;

    const session = createSchemaHistorySession({
      projectId,
      initialState: sourceSession.getSnapshot().serverState,
      flushSource: async () => {
        const flushed = await sourceSession.flushAndWait();
        if (flushed.persistence !== "SAVED") {
          throw historyWorkspaceError(
            "CLIENT_HISTORY_SOURCE_NOT_SAVED",
            messagesRef.current["history.sourceMustBeSaved"],
          );
        }
        return flushed.serverState;
      },
      flushLayout: async () => {
        await layoutSession.flush();
        const flushed = layoutSession.getSnapshot();
        const failedView = [...flushed.views.values()].find(
          (view) => view.hydrated && (view.status === "ERROR" || view.status === "CONFLICT"),
        );
        if (flushed.hasUnsavedChanges || failedView) {
          throw historyWorkspaceError(
            "CLIENT_HISTORY_LAYOUT_NOT_SAVED",
            messagesRef.current["history.layoutsMustBeSaved"],
          );
        }
      },
      saveDraft: (input) => api.saveDraft(input),
      restoreRevision: (input) => api.restoreRevision(input),
      adoptAuthoritativeState: async (state, diagnostics, adoption) => {
        const adopted = await sourceSession.adoptCommittedState(state, diagnostics);
        if (
          adopted.persistence !== "SAVED" ||
          adopted.serverState.project.schemaRevisionNo !== state.project.schemaRevisionNo ||
          adopted.source !== state.project.draftSource ||
          adopted.sourceHash !== state.project.draftHash
        ) {
          throw historyWorkspaceError(
            "CLIENT_HISTORY_STATE_ADOPTION_FAILED",
            messagesRef.current["history.adoptFailed"],
          );
        }
        await layoutSession.adoptCommittedRevision(
          state.project.layoutRevisionNo,
          adoption === "EXTERNAL_CONFLICT",
        );
        queryClient.setQueryData<ProjectResponse>(projectQueryKeys.detail(projectId), { state });
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.list });
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.revisions(projectId) });
      },
      loadCurrentState: async () => {
        const response = await api.getProject(projectId);
        queryClient.setQueryData(projectQueryKeys.detail(projectId), response);
        return response.state;
      },
    });
    historySessionRef.current = session;
    setHistorySession(session);
    setHistorySnapshot(session.getSnapshot());
    const unsubscribe = session.subscribe(() => setHistorySnapshot(session.getSnapshot()));
    return () => {
      unsubscribe();
      session.dispose();
      if (historySessionRef.current === session) historySessionRef.current = null;
      setHistorySession(null);
      setHistorySnapshot(null);
    };
  }, [api, projectId, queryClient, visualSessionsReady]);

  useEffect(() => {
    if (!historySession || sessionSnapshot?.persistence !== "CONFLICT") return;
    const externalState = sessionSnapshot.conflictState;
    if (!externalState) {
      historySession.reset();
      return;
    }
    if (lastExternalHistoryRevisionRef.current === externalState.project.schemaRevisionNo) return;
    lastExternalHistoryRevisionRef.current = externalState.project.schemaRevisionNo;
    historySession.adoptExternalState(externalState);
  }, [historySession, sessionSnapshot]);

  useEffect(() => {
    if (!visualSessionsReady) return;
    const sourceSession = sessionRef.current;
    const layoutSession = layoutSessionRef.current;
    if (!sourceSession || !layoutSession) return;
    const commandSession = createVisualCommandSession({
      projectId,
      sourceSession,
      layoutSession,
      applyVisualCommand: (input) => api.applyVisualCommand(input),
      loadProject: async () => {
        const response = await api.getProject(projectId);
        queryClient.setQueryData(projectQueryKeys.detail(projectId), response);
        return response.state;
      },
      onBeforeCommittedState: (_state, _mutation, command) => {
        lastAppliedVisualCommandRef.current = command;
        skipNextClientRenameRecoveryRef.current =
          command.kind === "RENAME_TABLE" || command.kind === "RENAME_COLUMN";
      },
      onCommittedState: (state) => {
        queryClient.setQueryData<ProjectResponse>(projectQueryKeys.detail(projectId), { state });
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.list });
      },
      onCommittedMutation: (beforeState, state, mutation) => {
        historySessionRef.current?.recordCommitted({
          kind: "VISUAL_COMMAND",
          before: beforeState,
          response: { state, revisionCreated: mutation.revisionCreated },
          replayed: mutation.replayed,
          appliedSchemaRevisionNo: mutation.appliedSchemaRevisionNo,
        });
      },
      onExternalStateAdopted: (state) => {
        historySessionRef.current?.adoptExternalState(state);
      },
    });
    setVisualCommandSession(commandSession);
    setVisualCommandSnapshot(commandSession.getSnapshot());
    const unsubscribe = commandSession.subscribe(() => {
      setVisualCommandSnapshot(commandSession.getSnapshot());
    });
    return () => {
      unsubscribe();
      setVisualCommandSession(null);
      setVisualCommandSnapshot(null);
    };
  }, [api, projectId, queryClient, visualSessionsReady]);

  const handlePositionsCommit = useCallback(
    (positions: Readonly<Record<string, DiagramPosition>>) => {
      editActiveLayout((current) => ({
        ...current,
        positions: { ...current.positions, ...positions },
        baseSchemaHash: activeGraph?.schemaHash ?? current.baseSchemaHash,
      }));
    },
    [activeGraph?.schemaHash, editActiveLayout],
  );

  const handleReloadLayout = useCallback(async () => {
    const controller = layoutSessionRef.current;
    if (!controller) return;
    const failedViews = [...controller.getSnapshot().views.values()]
      .filter((view) => view.status === "ERROR")
      .sort((left, right) =>
        left.viewKey < right.viewKey ? -1 : left.viewKey > right.viewKey ? 1 : 0,
      );
    if (failedViews.length === 0) {
      await controller.hydrate(resolvedViewKey, defaultLayout);
    } else {
      for (const view of failedViews) await controller.hydrate(view.viewKey, view.layout);
    }
    const refreshRecovered = [...controller.getSnapshot().views.values()].every(
      (view) => view.status !== "ERROR",
    );
    if (refreshRecovered && visualCommandSession?.getSnapshot().layoutRefreshFailed) {
      visualCommandSession.reset();
    }
  }, [defaultLayout, resolvedViewKey, visualCommandSession]);

  const handleRenderedLayoutReady = useCallback(
    (positions: Readonly<Record<string, DiagramPosition>>, _viewport: DiagramViewport) => {
      renderedLayoutRef.current = {
        viewKey: resolvedViewKey,
        positions,
      };
      setInitialDiagramReady(true);
    },
    [resolvedViewKey],
  );

  const persistCurrentLayoutBaseline = useCallback(
    async (includeRenderedLayout: boolean): Promise<boolean> => {
      const controller = layoutSessionRef.current;
      const graph = activeGraph;
      const view = controller?.getSnapshot().views.get(resolvedViewKey);
      if (!controller || !graph || !view || view.status === "LOADING") return false;
      if (view.status === "CONFLICT") {
        setLayoutWorkflowError(messagesRef.current["layout.resolveConflictFirst"]);
        return false;
      }
      let baseline = view.layout;
      const rendered = renderedLayoutRef.current;
      if (includeRenderedLayout && rendered?.viewKey === resolvedViewKey) {
        baseline = {
          ...baseline,
          positions: { ...baseline.positions, ...rendered.positions },
          baseSchemaHash: graph.schemaHash,
        };
      }
      await controller.replaceAndFlush(resolvedViewKey, baseline);
      const status = controller.getSnapshot().views.get(resolvedViewKey)?.status;
      if (status === "ERROR" || status === "CONFLICT") {
        setLayoutWorkflowError(messagesRef.current["layout.baselineSaveFailed"]);
        return false;
      }
      return true;
    },
    [activeGraph, resolvedViewKey],
  );

  const handlePreviewAutoLayout = useCallback(async () => {
    if (layoutRequest || !activeGraph) return;
    setLayoutWorkflowError(null);
    if (!(await persistCurrentLayoutBaseline(true))) return;
    layoutRequestIdRef.current += 1;
    setLayoutPreview(null);
    setLayoutRequest({ requestId: layoutRequestIdRef.current, mode: "PREVIEW" });
  }, [activeGraph, layoutRequest, persistCurrentLayoutBaseline]);

  const handleCancelAutoLayout = useCallback(() => {
    setLayoutPreview(null);
    setLayoutRequest(null);
    setLayoutWorkflowError(null);
  }, []);

  const handleApplyAutoLayout = useCallback(async () => {
    if (layoutPreview?.mode !== "PREVIEW" || !activeGraph) return;
    const controller = layoutSessionRef.current;
    const view = controller?.getSnapshot().views.get(resolvedViewKey);
    if (!controller || !view) return;
    const next: DiagramLayoutValue = {
      ...view.layout,
      positions: { ...view.layout.positions, ...layoutPreview.positions },
      baseSchemaHash: activeGraph.schemaHash,
    };
    await controller.replaceAndFlush(resolvedViewKey, next);
    const status = controller.getSnapshot().views.get(resolvedViewKey)?.status;
    setLayoutPreview(null);
    setLayoutRequest(null);
    if (status === "ERROR" || status === "CONFLICT") {
      setLayoutWorkflowError(
        status === "CONFLICT"
          ? messagesRef.current["layout.previewConflict"]
          : messagesRef.current["layout.previewSaveFailed"],
      );
    }
  }, [activeGraph, layoutPreview, resolvedViewKey]);

  const handleResetLayout = useCallback(async () => {
    if (layoutRequest || !activeGraph) return;
    setLayoutWorkflowError(null);
    if (!(await persistCurrentLayoutBaseline(false))) return;
    layoutRequestIdRef.current += 1;
    setLayoutPreview(null);
    setLayoutRequest({ requestId: layoutRequestIdRef.current, mode: "RESET" });
  }, [activeGraph, layoutRequest, persistCurrentLayoutBaseline]);

  const handleLayoutRequestReady = useCallback(
    (result: DiagramLayoutRequestResult) => {
      if (
        result.requestId !== layoutRequest?.requestId ||
        result.mode !== layoutRequest.mode ||
        !activeGraph
      ) {
        return;
      }
      if (!result.succeeded) {
        setLayoutWorkflowError(messagesRef.current["layout.automaticFailed"]);
        setLayoutRequest(null);
        setLayoutPreview(null);
        return;
      }
      if (result.mode === "PREVIEW") {
        setLayoutPreview(result);
        return;
      }

      const controller = layoutSessionRef.current;
      const view = controller?.getSnapshot().views.get(resolvedViewKey);
      if (!controller || !view) return;
      const resetLayout: DiagramLayoutValue = {
        positions: { ...result.positions },
        collapsedGroupKeys: [],
        hiddenElementKeys: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        detailLevel: "FULL",
        baseSchemaHash: activeGraph.schemaHash,
      };
      void controller.replaceAndFlush(resolvedViewKey, resetLayout).then(() => {
        const status = controller.getSnapshot().views.get(resolvedViewKey)?.status;
        setLayoutRequest(null);
        setLayoutPreview(null);
        if (status === "ERROR" || status === "CONFLICT") {
          setLayoutWorkflowError(
            status === "CONFLICT"
              ? messagesRef.current["layout.resetConflict"]
              : messagesRef.current["layout.resetSaveFailed"],
          );
        }
      });
    },
    [activeGraph, layoutRequest, resolvedViewKey],
  );

  const hasUnsavedSource = sessionSnapshot !== null && sessionSnapshot.persistence !== "SAVED";
  const hasUnsavedLayout = layoutSnapshot?.hasUnsavedChanges ?? false;
  const hasUnsavedWorkspace = hasUnsavedSource || hasUnsavedLayout;
  useEffect(() => {
    const captureNavigationTrigger = (event: MouseEvent) => {
      const target = event.target;
      const link = target instanceof Element ? target.closest("a[href]") : null;
      if (link instanceof HTMLElement) blockedNavigationReturnFocusRef.current = link;
    };
    document.addEventListener("click", captureNavigationTrigger, true);
    return () => document.removeEventListener("click", captureNavigationTrigger, true);
  }, []);
  const navigationBlocker = useBlocker(
    useCallback(() => {
      if (!hasUnsavedWorkspace) return false;
      if (
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
      ) {
        blockedNavigationReturnFocusRef.current = document.activeElement;
      }
      return true;
    }, [hasUnsavedWorkspace]),
  );
  const requiresSavedWorkspace =
    navigationBlocker.state === "blocked" &&
    (navigationBlocker.location.pathname === `/projects/${projectId}/sql-import` ||
      navigationBlocker.location.pathname === `/projects/${projectId}/sql-export` ||
      navigationBlocker.location.pathname === `/projects/${projectId}/bundle-export`);

  useEffect(() => {
    if (navigationBlocker.state !== "blocked") {
      flushedBlockedNavigationRef.current = false;
      flushedBlockedLayoutNavigationRef.current = false;
      proceededBlockedNavigationRef.current = false;
      return;
    }
    if (!sessionSnapshot) return;
    if (sessionSnapshot.persistence === "DIRTY" && !flushedBlockedNavigationRef.current) {
      flushedBlockedNavigationRef.current = true;
      sessionRef.current?.flush();
    }
    if (hasUnsavedLayout && !flushedBlockedLayoutNavigationRef.current) {
      flushedBlockedLayoutNavigationRef.current = true;
      void layoutSessionRef.current?.flush();
    }
    if (!hasUnsavedSource && !hasUnsavedLayout && !proceededBlockedNavigationRef.current) {
      proceededBlockedNavigationRef.current = true;
      navigationBlocker.proceed();
    }
  }, [hasUnsavedLayout, hasUnsavedSource, navigationBlocker, sessionSnapshot]);

  useEffect(() => {
    if (!hasUnsavedWorkspace) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedWorkspace]);

  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        !isSchemaHistoryShortcutTarget(event.target)
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z" && event.shiftKey) {
        event.preventDefault();
        handleHistoryRedo();
        return;
      }
      if (key === "y" || (key === "z" && !event.shiftKey)) {
        event.preventDefault();
        if (key === "y") handleHistoryRedo();
        else handleHistoryUndo();
      }
    };
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [handleHistoryRedo, handleHistoryUndo]);

  if (!sessionSnapshot) {
    return (
      <div className="grid h-full place-items-center bg-slate-950 p-6 text-slate-300">
        <p aria-live="polite">{messages["source.workspacePreparing"]}</p>
      </div>
    );
  }

  const { serverState } = sessionSnapshot;
  const compilerInformationDiagnostics =
    sessionSnapshot.diagnostics.filter(isDbmlCompilerInformation);
  const problemDiagnostics = sessionSnapshot.diagnostics.filter(
    (diagnostic) => !isDbmlCompilerInformation(diagnostic),
  );
  const visualInteractionDisabled =
    layoutInteractionLocked || !sessionSnapshot.canUseValidSchema || visualCommandSession === null;
  return (
    <>
      <CanvasWorkspaceShell
        surfaces={surfaces}
        onViewportInsetsChange={setViewportInsets}
        commandBar={
          <div className="flex max-w-[calc(100vw-1.5rem)] items-center gap-2 overflow-x-auto px-3 py-2 text-sm sm:max-w-[calc(100vw-2.5rem)] sm:px-4">
            <Link className={commandBarButtonClass} to="/">
              {messages["workspace.backToProjects"]}
            </Link>
            <div className="min-w-0 px-1 sm:px-2">
              <p className="truncate text-[0.65rem] font-bold uppercase tracking-[0.14em] text-cyan-300">
                {messages["workspace.revisionSummary"](
                  dialectLabel(serverState.project.primaryDialect),
                  serverState.project.schemaRevisionNo,
                )}
              </p>
              <h1 id="workspace-heading" className="truncate font-semibold text-white">
                {serverState.project.name}
              </h1>
            </div>
            <ValidityBadge validity={serverState.currentRevision.validity} />
            <div className="h-6 w-px bg-slate-700" aria-hidden="true" />
            <button
              className={commandBarButtonClass}
              type="button"
              aria-expanded={surfaces.leftSurface === "SOURCE"}
              aria-controls="workspace-source-surface"
              onClick={(event) => {
                setSourceEditorLoadReady(true);
                surfaces.toggleLeft("SOURCE", event.currentTarget);
              }}
            >
              {messages["workspace.source"]}
            </button>
            <button
              className={commandBarButtonClass}
              type="button"
              aria-expanded={surfaces.leftSurface === "OUTLINE"}
              aria-controls="workspace-outline-surface"
              onClick={(event) => surfaces.toggleLeft("OUTLINE", event.currentTarget)}
            >
              {messages["workspace.outline"]}
            </button>
            <button
              className={commandBarButtonClass}
              type="button"
              aria-expanded={surfaces.rightPanelOpen}
              aria-controls="workspace-right-panel-content"
              onClick={(event) => surfaces.toggleRightPanel(event.currentTarget)}
            >
              {messages["workspace.tools"]}
            </button>
            {historySession && historySnapshot ? (
              <SchemaHistoryControls
                session={historySession}
                loadRevisions={loadHistoryRevisions}
                interactionDisabled={visualCommandWorkspaceLocked}
                compact
              />
            ) : null}
            <Link
              aria-label={messages["workspace.importSql"]}
              className={commandBarButtonClass}
              to={`/projects/${projectId}/sql-import`}
            >
              {messages["workspace.import"]}
            </Link>
            <Link
              aria-label={messages["workspace.exportSql"]}
              className={commandBarButtonClass}
              to={`/projects/${projectId}/sql-export`}
            >
              {messages["workspace.export"]}
            </Link>
            <Link
              aria-label={messages["workspace.exportBundle"]}
              className={commandBarButtonClass}
              to={`/projects/${projectId}/bundle-export`}
            >
              {messages["workspace.bundle"]}
            </Link>
            <LanguageSelect className="shrink-0" />
          </div>
        }
        diagram={
          <DiagramPanel
            snapshot={sessionSnapshot}
            visibility={visibility}
            viewKey={resolvedViewKey}
            viewLabel={viewLabel}
            detailLevel={layoutRequest?.mode === "RESET" ? "FULL" : activeLayout.detailLevel}
            collapsedGroupKeys={
              layoutRequest?.mode === "RESET" ? NO_COLLAPSED_GROUP_KEYS : activeCollapsedGroupKeys
            }
            focusRequest={focusRequest}
            selectionStore={selectionStore}
            DiagramComponent={DiagramComponent}
            requestLayout={requestBoundedLayout}
            sourceNavigationEnabled={sourceNavigationEnabled}
            viewportInsets={viewportInsets}
            layoutView={activeLayoutView}
            layoutConflict={layoutSnapshot?.conflict ?? null}
            layoutPositions={activeLayout.positions}
            layoutRequest={layoutRequest}
            onToggleGroup={handleToggleGroup}
            onNavigateSource={handleNavigateSource}
            onFocusSource={() => openSourceSurface()}
            onPositionsCommit={handlePositionsCommit}
            onRenderedLayoutReady={handleRenderedLayoutReady}
            onLayoutRequestReady={handleLayoutRequestReady}
            onReloadLayout={() => void handleReloadLayout()}
            visualInteractionDisabled={visualInteractionDisabled}
          />
        }
        diagramTools={
          <DiagramToolsPanel
            snapshot={sessionSnapshot}
            visibility={visibility}
            viewKey={resolvedViewKey}
            detailLevel={layoutRequest?.mode === "RESET" ? "FULL" : activeLayout.detailLevel}
            searchQuery={searchQuery}
            layoutView={activeLayoutView}
            layoutConflict={layoutSnapshot?.conflict ?? null}
            layoutRequest={layoutRequest}
            layoutPreview={layoutPreview}
            layoutWorkflowError={layoutWorkflowError}
            layoutRecoveryNotice={layoutRecoveryNotice}
            onViewChange={handleViewChange}
            onDetailLevelChange={handleDetailLevelChange}
            onSearchQueryChange={setSearchQuery}
            onActivateSearchResult={handleActivateSearchResult}
            onPreviewAutoLayout={() => void handlePreviewAutoLayout()}
            onApplyAutoLayout={() => void handleApplyAutoLayout()}
            onCancelAutoLayout={handleCancelAutoLayout}
            onResetLayout={() => void handleResetLayout()}
            onRetryLayout={() => void layoutSessionRef.current?.retrySave()}
            onRetryLocalLayout={() => void layoutSessionRef.current?.retryLocalLayout()}
            onLoadServerLayout={() => void layoutSessionRef.current?.loadServerLayout()}
            layoutInteractionDisabled={layoutInteractionLocked}
          />
        }
        source={
          <div className="flex min-h-full flex-col">
            <div className="flex flex-col gap-3 border-b border-slate-700 pb-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
                  {messages["source.canonicalTitle"]}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {messages["source.autosaveDescription"]}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  label={persistenceLabel(sessionSnapshot.persistence, messages)}
                  testId="source-persistence-status"
                />
                <StatusBadge
                  label={validationLabel(sessionSnapshot.validation, messages)}
                  testId="source-validation-status"
                />
              </div>
            </div>
            <div className="mt-4 min-h-[32rem] flex-1 overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
              {sourceEditorLoadReady ? (
                <Suspense
                  fallback={
                    <div className="grid min-h-[32rem] place-items-center bg-slate-950 text-slate-300">
                      <p aria-live="polite">{messages["source.localAssetsLoading"]}</p>
                    </div>
                  }
                >
                  <EditorComponent
                    ref={editorRef}
                    projectId={projectId}
                    initialSource={sessionSnapshot.source}
                    diagnostics={sessionSnapshot.diagnostics}
                    onChange={(source) => sessionRef.current?.edit(source)}
                    onSave={() => sessionRef.current?.flush()}
                    onUndo={handleHistoryUndo}
                    onRedo={handleHistoryRedo}
                    onReady={() => setSourceEditorReady(true)}
                    onCursorPositionChange={handleCursorPositionChange}
                    readOnly={visualWorkspaceLocked}
                  />
                </Suspense>
              ) : (
                <div className="grid min-h-[32rem] place-items-center bg-slate-950 text-slate-300">
                  <p aria-live="polite">{messages["source.preparingAfterDiagram"]}</p>
                </div>
              )}
            </div>
            <section className="mt-4 rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <h2 className="font-semibold text-white">{messages["source.draftStatus"]}</h2>
              <dl className="mt-4 grid gap-3 text-sm">
                <DetailRow
                  label={messages["source.schemaRevision"]}
                  value={String(sessionSnapshot.expectedSchemaRevisionNo)}
                />
                <DetailRow label="Parser" value={serverState.project.parserVersion} />
                <DetailRow
                  label={messages["source.lastValidRevision"]}
                  value={
                    serverState.lastValidRevision?.revisionNo.toString() ?? messages["common.none"]
                  }
                />
                <DetailRow
                  label={messages["source.diagramSource"]}
                  value={
                    sessionSnapshot.activeGraphSource === "CURRENT_DRAFT"
                      ? messages["source.currentDraft"]
                      : sessionSnapshot.activeGraphSource === "LAST_VALID"
                        ? messages["source.lastValid"]
                        : messages["common.unavailable"]
                  }
                />
                <DetailRow
                  label={messages["source.schemaActions"]}
                  value={
                    sessionSnapshot.canUseValidSchema
                      ? messages["common.available"]
                      : messages["common.disabled"]
                  }
                />
              </dl>
            </section>
          </div>
        }
        outline={
          <div className="flex min-h-full flex-col gap-4">
            {activeGraph && visibility ? (
              <SchemaOutline
                graph={activeGraph}
                visibility={visibility}
                viewLabel={viewLabel}
                collapsedGroupKeys={activeCollapsedGroupKeys}
                selectionStore={selectionStore}
                sourceNavigationEnabled={sourceNavigationEnabled}
                onToggleGroup={handleToggleGroup}
                onNavigateSource={handleNavigateSource}
              />
            ) : (
              <p className="text-sm text-slate-300">{messages["source.outlineRequiresValid"]}</p>
            )}
            {compilerInformationDiagnostics.length > 0 ? (
              <CompilerInformationPanel
                diagnostics={compilerInformationDiagnostics}
                onNavigate={(diagnostic) => {
                  openSourceSurface(diagnostic.range ?? null);
                  window.requestAnimationFrame(() =>
                    editorRef.current?.navigateToDiagnostic(diagnostic),
                  );
                }}
              />
            ) : null}
          </div>
        }
        inspector={
          activeGraph && visualCommandSession ? (
            <VisualSchemaInspector
              graph={activeGraph}
              primaryDialect={serverState.project.primaryDialect}
              currentViewKey={resolvedViewKey}
              selectionStore={selectionStore}
              commandSession={visualCommandSession}
              interactionDisabled={visualInteractionDisabled}
              sourceNavigationEnabled={sourceNavigationEnabled}
              onOpenSource={openSourceSurface}
              onReloadLayouts={() => void handleReloadLayout()}
            />
          ) : (
            <div className="p-2 text-sm text-slate-300">
              <h2 className="font-semibold text-white">{messages["inspector.title"]}</h2>
              <p className="mt-2">{messages["source.inspectorEmpty"]}</p>
            </div>
          )
        }
        status={
          <div className="flex flex-wrap items-center justify-center gap-2 px-3 py-2 text-xs sm:justify-start">
            <span
              className="rounded-full border border-slate-700 px-2.5 py-1 text-slate-200"
              data-testid="persistence-status"
            >
              {messages["source.statusSource"](
                persistenceLabel(sessionSnapshot.persistence, messages),
              )}
            </span>
            <span
              className="rounded-full border border-slate-700 px-2.5 py-1 text-slate-200"
              data-testid="validation-status"
            >
              {messages["source.statusSchema"](
                validationLabel(sessionSnapshot.validation, messages),
              )}
            </span>
            <span className="text-slate-400">
              {messages["source.statusRevision"](
                sessionSnapshot.expectedSchemaRevisionNo,
                viewLabel,
              )}
            </span>
            <button
              className="min-h-9 rounded-lg border border-slate-600 px-3 font-semibold text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              disabled={sessionSnapshot.persistence === "CONFLICT"}
              onClick={() => sessionRef.current?.flush()}
            >
              {messages["source.saveNow"]}
            </button>
          </div>
        }
        alerts={
          <div className="max-h-[45vh] space-y-3 overflow-auto">
            <SessionRecoveryPanel
              snapshot={sessionSnapshot}
              session={sessionRef.current}
              onLoadServer={() => {
                const source = sessionRef.current?.loadServerDraft();
                if (source !== null && source !== undefined)
                  editorRef.current?.replaceSource(source);
              }}
            />
            {problemDiagnostics.length > 0 ? (
              <ProblemsPanel
                diagnostics={problemDiagnostics}
                onNavigate={(diagnostic) => {
                  openSourceSurface(diagnostic.range ?? null);
                  window.requestAnimationFrame(() =>
                    editorRef.current?.navigateToDiagnostic(diagnostic),
                  );
                }}
              />
            ) : null}
            {hiddenSourceSelection ? (
              <section
                className="rounded-2xl border border-amber-300/50 bg-amber-950/90 p-4 text-sm text-amber-100"
                role="status"
              >
                <p>{messages["source.hiddenByView"](hiddenSourceSelection.viewLabel)}</p>
                <button
                  className="mt-3 min-h-10 rounded-lg border border-amber-200 px-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200"
                  type="button"
                  onClick={handleShowHiddenSelectionInGlobal}
                >
                  {messages["source.showInGlobal"]}
                </button>
              </section>
            ) : null}
          </div>
        }
      />

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {persistenceLabel(sessionSnapshot.persistence, messages)}.{" "}
        {validationLabel(sessionSnapshot.validation, messages)}.
      </p>

      <UnsavedNavigationDialog
        blocker={navigationBlocker}
        snapshot={sessionSnapshot}
        hasUnsavedLayout={hasUnsavedLayout}
        requiresSavedWorkspace={requiresSavedWorkspace}
        returnFocusRef={blockedNavigationReturnFocusRef}
        onStay={() => {
          proceededBlockedNavigationRef.current = true;
        }}
      />
    </>
  );
}

function DiagramToolsPanel({
  snapshot,
  visibility,
  viewKey,
  detailLevel,
  searchQuery,
  layoutView,
  layoutConflict,
  layoutRequest,
  layoutPreview,
  layoutWorkflowError,
  layoutRecoveryNotice,
  onViewChange,
  onDetailLevelChange,
  onSearchQueryChange,
  onActivateSearchResult,
  onPreviewAutoLayout,
  onApplyAutoLayout,
  onCancelAutoLayout,
  onResetLayout,
  onRetryLayout,
  onRetryLocalLayout,
  onLoadServerLayout,
  layoutInteractionDisabled,
}: {
  readonly snapshot: SourceSessionSnapshot;
  readonly visibility: DiagramVisibility | null;
  readonly viewKey: DiagramViewKey;
  readonly detailLevel: DiagramLod;
  readonly searchQuery: string;
  readonly layoutView: LayoutViewSnapshot | null;
  readonly layoutConflict: LayoutConflictState | null;
  readonly layoutRequest: DiagramLayoutRequest | null;
  readonly layoutPreview: DiagramLayoutRequestResult | null;
  readonly layoutWorkflowError: string | null;
  readonly layoutRecoveryNotice: string | null;
  readonly onViewChange: (viewKey: DiagramViewKey) => void;
  readonly onDetailLevelChange: (detailLevel: DiagramLod) => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onActivateSearchResult: (result: DiagramSearchResult) => void;
  readonly onPreviewAutoLayout: () => void;
  readonly onApplyAutoLayout: () => void;
  readonly onCancelAutoLayout: () => void;
  readonly onResetLayout: () => void;
  readonly onRetryLayout: () => void;
  readonly onRetryLocalLayout: () => void;
  readonly onLoadServerLayout: () => void;
  readonly layoutInteractionDisabled: boolean;
}) {
  const { messages } = useUiLocale();
  const graph = snapshot.activeGraph;
  const showingLastValid = snapshot.activeGraphSource === "LAST_VALID";
  const lastValidRevisionNo = snapshot.serverState.lastValidRevision?.revisionNo;
  const layoutBusy = layoutRequest !== null;
  const layoutHydrating = layoutView === null || layoutView.status === "LOADING";
  const layoutLoadFailed = layoutView?.status === "ERROR" && !layoutView.hydrated;
  const schemaHashMismatch =
    graph !== null &&
    layoutView?.persistedLayout != null &&
    layoutView?.layout.baseSchemaHash !== graph.schemaHash;

  return (
    <div className="min-w-0">
      <div className="px-4 py-3">
        <h2 className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
          {messages["diagram.editable"]}
        </h2>
        <p className="mt-1 text-xs text-slate-400" aria-live="polite">
          {graph
            ? showingLastValid
              ? messages["diagram.showingLastValid"](
                  lastValidRevisionNo?.toString() ?? messages["common.unavailable"],
                )
              : messages["diagram.showingCurrent"]
            : messages["diagram.noValidDescription"]}
        </p>
      </div>
      {graph && visibility ? (
        <>
          <DiagramWorkspaceControls
            layout="SIDEBAR"
            graph={graph}
            visibility={visibility}
            viewKey={viewKey}
            detailLevel={detailLevel}
            searchQuery={searchQuery}
            onSearchQueryChange={onSearchQueryChange}
            onActivateSearchResult={onActivateSearchResult}
            onViewChange={onViewChange}
            onDetailLevelChange={onDetailLevelChange}
            disabled={
              layoutInteractionDisabled ||
              layoutHydrating ||
              layoutLoadFailed ||
              layoutConflict !== null
            }
            searchDisabled={layoutBusy}
          />
          <LayoutToolbar
            viewKey={viewKey}
            layoutView={layoutView}
            layoutConflict={layoutConflict}
            layoutRequest={layoutRequest}
            layoutPreview={layoutPreview}
            workflowError={layoutWorkflowError}
            recoveryNotice={layoutRecoveryNotice}
            schemaHashMismatch={schemaHashMismatch}
            onPreview={onPreviewAutoLayout}
            onApply={onApplyAutoLayout}
            onCancel={onCancelAutoLayout}
            onReset={onResetLayout}
            onRetry={onRetryLayout}
            onRetryLocal={onRetryLocalLayout}
            onLoadServer={onLoadServerLayout}
          />
        </>
      ) : null}
    </div>
  );
}

function DiagramPanel({
  snapshot,
  visibility,
  viewKey,
  viewLabel,
  detailLevel,
  collapsedGroupKeys,
  focusRequest,
  selectionStore,
  DiagramComponent,
  requestLayout,
  sourceNavigationEnabled,
  layoutView,
  layoutConflict,
  layoutPositions,
  layoutRequest,
  onToggleGroup,
  onNavigateSource,
  onFocusSource,
  onPositionsCommit,
  onRenderedLayoutReady,
  onLayoutRequestReady,
  onReloadLayout,
  visualInteractionDisabled,
  viewportInsets,
}: {
  readonly snapshot: SourceSessionSnapshot;
  readonly visibility: DiagramVisibility | null;
  readonly viewKey: DiagramViewKey;
  readonly viewLabel: string;
  readonly detailLevel: DiagramLod;
  readonly collapsedGroupKeys: ReadonlySet<string>;
  readonly focusRequest: DiagramFocusRequest | null;
  readonly selectionStore: ReturnType<typeof createDiagramSelectionStore>;
  readonly DiagramComponent: BaseSchemaDiagramComponent;
  readonly requestLayout: NonNullable<BaseSchemaDiagramProps["requestLayout"]>;
  readonly sourceNavigationEnabled: boolean;
  readonly layoutView: LayoutViewSnapshot | null;
  readonly layoutConflict: LayoutConflictState | null;
  readonly layoutPositions: Readonly<Record<string, DiagramPosition>>;
  readonly layoutRequest: DiagramLayoutRequest | null;
  readonly onToggleGroup: (groupKey: string) => void;
  readonly onNavigateSource: (selection: DiagramSelection) => void;
  readonly onFocusSource: () => void;
  readonly onPositionsCommit: (positions: Readonly<Record<string, DiagramPosition>>) => void;
  readonly onRenderedLayoutReady: (
    positions: Readonly<Record<string, DiagramPosition>>,
    viewport: DiagramViewport,
  ) => void;
  readonly onLayoutRequestReady: (result: DiagramLayoutRequestResult) => void;
  readonly onReloadLayout: () => void;
  readonly visualInteractionDisabled: boolean;
  readonly viewportInsets: DiagramViewportInsets | null;
}) {
  const { messages } = useUiLocale();
  const graph = snapshot.activeGraph;
  const layoutBusy = layoutRequest !== null;
  const layoutHydrating = layoutView === null || layoutView.status === "LOADING";
  const layoutLoadFailed = layoutView?.status === "ERROR" && !layoutView.hydrated;

  return (
    <section className="relative h-full min-h-0 overflow-hidden bg-slate-950">
      {graph && visibility ? (
        <>
          <Suspense
            fallback={
              <div className="grid h-full place-items-center bg-slate-950 text-slate-300">
                <p aria-live="polite">{messages["diagram.localAssetsLoading"]}</p>
              </div>
            }
          >
            {layoutLoadFailed ? (
              <div className="grid h-full place-items-center bg-slate-950 p-6 text-center">
                <div>
                  <p className="font-semibold text-red-100">{messages["layout.loadFailedTitle"]}</p>
                  <p className="mt-2 text-sm text-slate-400">
                    {messages["layout.loadFailedDescription"]}
                  </p>
                  <button
                    className={`${secondaryButtonClass} mt-4`}
                    type="button"
                    onClick={onReloadLayout}
                  >
                    {messages["layout.retryLoad"]}
                  </button>
                </div>
              </div>
            ) : viewportInsets === null ? (
              <div className="grid h-full place-items-center bg-slate-950 text-slate-300">
                <p aria-live="polite">{messages["diagram.preparingSafeArea"]}</p>
              </div>
            ) : (
              <DiagramComponent
                graph={graph}
                viewKey={viewKey}
                detailLevel={detailLevel}
                collapsedGroupKeys={collapsedGroupKeys}
                focusRequest={focusRequest}
                selectionStore={selectionStore}
                sourceNavigationEnabled={sourceNavigationEnabled}
                onToggleGroup={onToggleGroup}
                onNavigateSource={onNavigateSource}
                viewportInsets={viewportInsets}
                fillContainer
                requestLayout={requestLayout}
                layoutPositions={layoutPositions}
                layoutPending={layoutHydrating}
                layoutRequest={layoutRequest}
                interactionDisabled={
                  layoutBusy || layoutConflict !== null || visualInteractionDisabled
                }
                onPositionsCommit={onPositionsCommit}
                onRenderedLayoutReady={onRenderedLayoutReady}
                onLayoutRequestReady={onLayoutRequestReady}
              />
            )}
          </Suspense>
          <p className="sr-only" aria-live="polite">
            {messages["diagram.detailStatus"](
              viewLabel,
              detailLevel.toLowerCase().replaceAll("_", " "),
            )}
          </p>
        </>
      ) : (
        <div className="grid h-full place-items-center bg-slate-950 p-6 text-center">
          <div>
            <p className="font-semibold text-slate-100">{messages["diagram.noValidTitle"]}</p>
            <p className="mt-2 max-w-md text-sm text-slate-400">
              {messages["diagram.noValidDescription"]}
            </p>
            <button
              className="mt-4 rounded-lg border border-slate-600 px-3 py-2 text-sm font-semibold text-cyan-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
              type="button"
              onClick={onFocusSource}
            >
              {messages["source.focusEditor"]}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function LayoutToolbar({
  viewKey,
  layoutView,
  layoutConflict,
  layoutRequest,
  layoutPreview,
  workflowError,
  recoveryNotice,
  schemaHashMismatch,
  onPreview,
  onApply,
  onCancel,
  onReset,
  onRetry,
  onRetryLocal,
  onLoadServer,
}: {
  readonly viewKey: string;
  readonly layoutView: LayoutViewSnapshot | null;
  readonly layoutConflict: LayoutConflictState | null;
  readonly layoutRequest: DiagramLayoutRequest | null;
  readonly layoutPreview: DiagramLayoutRequestResult | null;
  readonly workflowError: string | null;
  readonly recoveryNotice: string | null;
  readonly schemaHashMismatch: boolean;
  readonly onPreview: () => void;
  readonly onApply: () => void;
  readonly onCancel: () => void;
  readonly onReset: () => void;
  readonly onRetry: () => void;
  readonly onRetryLocal: () => void;
  readonly onLoadServer: () => void;
}) {
  const { messages } = useUiLocale();
  const unavailable =
    layoutView === null ||
    layoutView.status === "LOADING" ||
    layoutView.status === "ERROR" ||
    layoutConflict !== null;
  return (
    <div className="border-b border-slate-700 bg-slate-950/50 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-semibold text-slate-300" aria-live="polite">
          {layoutRequest?.mode === "PREVIEW"
            ? layoutPreview
              ? messages["layout.previewReady"]
              : messages["layout.previewing"]
            : layoutRequest?.mode === "RESET"
              ? messages["layout.resetting"]
              : layoutStatusLabel(layoutView, messages)}
        </p>
        <div className="flex flex-wrap gap-2">
          {layoutRequest?.mode === "PREVIEW" && layoutPreview ? (
            <>
              <button className={primaryButtonClass} type="button" onClick={onApply}>
                {messages["layout.applyAuto"]}
              </button>
              <button className={secondaryButtonClass} type="button" onClick={onCancel}>
                {messages["layout.cancelPreview"]}
              </button>
            </>
          ) : (
            <>
              <button
                className={secondaryButtonClass}
                type="button"
                disabled={unavailable || layoutRequest !== null}
                onClick={onPreview}
              >
                {messages["layout.previewAuto"]}
              </button>
              <ResetLayoutDialog
                disabled={unavailable || layoutRequest !== null}
                viewKey={viewKey}
                onReset={onReset}
              />
            </>
          )}
          {layoutView?.status === "ERROR" ? (
            <button className={secondaryButtonClass} type="button" onClick={onRetry}>
              {messages["layout.retrySave"]}
            </button>
          ) : null}
        </div>
      </div>

      {schemaHashMismatch ? (
        <p className="mt-2 text-xs text-amber-200" role="status">
          {messages["layout.savedForEarlierSchema"]}
        </p>
      ) : null}
      {recoveryNotice ? (
        <p className="mt-2 text-xs text-cyan-200" role="status">
          {recoveryNotice}
        </p>
      ) : null}
      {workflowError ? (
        <p className="mt-2 text-xs text-red-200" role="alert">
          {workflowError}
        </p>
      ) : null}
      {layoutView?.error?.correlationId ? (
        <p className="mt-2 text-xs text-red-200">
          {messages["error.correlationId"](layoutView.error.correlationId)}
        </p>
      ) : null}
      {layoutConflict ? (
        <div
          className="mt-3 rounded-lg border border-amber-300/50 bg-amber-950/30 p-3"
          role="alert"
        >
          <p className="font-semibold text-amber-100">{messages["layout.conflictTitle"]}</p>
          <p className="mt-1 text-xs text-amber-100/80">{messages["layout.conflictDescription"]}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={primaryButtonClass} type="button" onClick={onRetryLocal}>
              {messages["layout.retryLocal"]}
            </button>
            <LayoutConflictLoadDialog viewKey={layoutConflict.viewKey} onLoad={onLoadServer} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ResetLayoutDialog({
  disabled,
  viewKey,
  onReset,
}: {
  readonly disabled: boolean;
  readonly viewKey: string;
  readonly onReset: () => void;
}) {
  const { messages } = useUiLocale();
  const [open, setOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className={secondaryButtonClass} type="button" disabled={disabled}>
          {messages["layout.reset"]}
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
          <Dialog.Title className="text-xl font-semibold">
            {messages["layout.resetQuestion"]}
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-slate-300">
            {messages["layout.resetDescription"](viewKey)}
          </Dialog.Description>
          <div className="mt-6 flex flex-row-reverse flex-wrap gap-3">
            <button
              className="min-h-11 rounded-lg bg-red-300 px-4 font-semibold text-red-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300"
              type="button"
              onClick={() => {
                setOpen(false);
                onReset();
              }}
            >
              {messages["layout.resetThisView"]}
            </button>
            <Dialog.Close asChild>
              <button ref={cancelRef} className={secondaryButtonClass} type="button">
                {messages["action.cancel"]}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function LayoutConflictLoadDialog({
  viewKey,
  onLoad,
}: {
  readonly viewKey: string;
  readonly onLoad: () => void;
}) {
  const { messages } = useUiLocale();
  const [open, setOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className={secondaryButtonClass} type="button">
          {messages["layout.loadServer"]}
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
          <Dialog.Title className="text-xl font-semibold">
            {messages["layout.loadServerQuestion"]}
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-slate-300">
            {messages["layout.loadServerDescription"](viewKey)}
          </Dialog.Description>
          <div className="mt-6 flex flex-row-reverse flex-wrap gap-3">
            <button
              className="min-h-11 rounded-lg bg-red-300 px-4 font-semibold text-red-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300"
              type="button"
              onClick={() => {
                setOpen(false);
                onLoad();
              }}
            >
              {messages["layout.loadServer"]}
            </button>
            <Dialog.Close asChild>
              <button ref={cancelRef} className={secondaryButtonClass} type="button">
                {messages["action.cancel"]}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function layoutStatusLabel(view: LayoutViewSnapshot | null, messages: UiMessages): string {
  if (!view) return messages["layout.statusLoading"];
  return {
    LOADING: messages["layout.statusLoading"],
    SAVED: messages["layout.statusSaved"],
    DIRTY: messages["layout.statusDirty"],
    SAVING: messages["layout.statusSaving"],
    ERROR: messages["layout.statusError"],
    CONFLICT: messages["layout.statusConflict"],
  }[view.status];
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
  const { messages } = useUiLocale();
  if (snapshot.persistence === "CONFLICT") {
    return (
      <section className="rounded-2xl border border-amber-300/50 bg-amber-950/30 p-5" role="alert">
        <h2 className="font-semibold text-amber-100">{messages["source.conflictTitle"]}</h2>
        <p className="mt-2 text-sm text-amber-100/80">{messages["source.conflictDescription"]}</p>
        {snapshot.persistenceError?.currentRevisionNo ? (
          <p className="mt-2 text-xs text-amber-100/70">
            {messages["source.currentServerRevision"](snapshot.persistenceError.currentRevisionNo)}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="min-h-10 rounded-lg bg-amber-200 px-3 text-sm font-semibold text-amber-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200 disabled:opacity-50"
            type="button"
            disabled={!snapshot.conflictState}
            onClick={() => session?.retryLocalDraft()}
          >
            {messages["source.retryLocalDraft"]}
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
        <h2 className="font-semibold text-red-100">{messages["source.attentionTitle"]}</h2>
        {snapshot.persistenceError ? (
          <ErrorDescription
            title={messages["source.persistenceError"]}
            error={snapshot.persistenceError}
          />
        ) : null}
        {snapshot.validationError ? (
          <ErrorDescription
            title={messages["source.validationError"]}
            error={snapshot.validationError}
          />
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {snapshot.persistence === "ERROR" ? (
            <button
              className={secondaryButtonClass}
              type="button"
              onClick={() => session?.retrySave()}
            >
              {messages["source.retrySave"]}
            </button>
          ) : null}
          {snapshot.validation === "ERROR" ? (
            <button
              className={secondaryButtonClass}
              type="button"
              onClick={() => session?.retryValidation()}
            >
              {messages["source.retryValidation"]}
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
  const { messages } = useUiLocale();
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-white">{messages["source.problems"]}</h2>
        <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-300">
          {diagnostics.length}
        </span>
      </div>
      {diagnostics.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400">{messages["source.noDiagnostics"]}</p>
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
                    aria-label={messages["source.goToDiagnostic"](diagnostic.code)}
                    onClick={() => onNavigate(diagnostic)}
                  >
                    {diagnostic.range.startLine}:{diagnostic.range.startColumn}
                  </button>
                ) : null}
              </div>
              <p className="mt-2 break-words text-sm text-slate-200">{diagnostic.message}</p>
              <p className="mt-2 break-all text-[0.7rem] text-slate-400">{diagnostic.code}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CompilerInformationPanel({
  diagnostics,
  onNavigate,
}: {
  readonly diagnostics: readonly Diagnostic[];
  readonly onNavigate: (diagnostic: Diagnostic) => void;
}) {
  const { messages } = useUiLocale();
  const groups = groupDiagnosticsByMessage(diagnostics);
  return (
    <section
      className="mt-auto rounded-2xl border border-sky-800/70 bg-sky-950/40 p-5"
      aria-label={messages["outline.compilerInformation"]}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-white">{messages["outline.compilerInformation"]}</h2>
        <span className="rounded-full bg-sky-950 px-2.5 py-1 text-xs font-semibold text-sky-200">
          {diagnostics.length}
        </span>
      </div>
      <p className="mt-2 text-xs text-slate-300">
        {messages["outline.compilerInformationDescription"]}
      </p>
      <ol className="mt-4 space-y-3">
        {groups.map((group) => (
          <li
            className="rounded-lg border border-sky-900/80 bg-slate-950/60 p-3"
            key={`${group.code}:${group.message}`}
          >
            <p className="break-words text-sm text-slate-200">{group.message}</p>
            <p className="mt-2 break-all text-[0.7rem] text-slate-400">{group.code}</p>
            {group.diagnostics.some((diagnostic) => diagnostic.range) ? (
              <details className="mt-3 text-xs text-slate-300">
                <summary className="cursor-pointer font-semibold text-sky-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300">
                  {messages["outline.compilerInformationLocations"](group.diagnostics.length)}
                </summary>
                <ol className="mt-2 flex flex-wrap gap-2">
                  {group.diagnostics.map((diagnostic, index) => (
                    <li key={diagnosticIdentity(diagnostic, index)}>
                      {diagnostic.range ? (
                        <button
                          className="rounded border border-slate-700 px-2 py-1 font-semibold text-cyan-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
                          type="button"
                          aria-label={messages["outline.openCompilerInformation"](
                            diagnostic.code,
                            diagnostic.range.startLine,
                            diagnostic.range.startColumn,
                          )}
                          onClick={() => onNavigate(diagnostic)}
                        >
                          {diagnostic.range.startLine}:{diagnostic.range.startColumn}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </details>
            ) : (
              <p className="mt-3 text-xs text-slate-400">
                {messages["outline.compilerInformationNoLocation"]}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function isDbmlCompilerInformation(diagnostic: Diagnostic): boolean {
  return diagnostic.severity === "INFO" && diagnostic.code.startsWith("DBML_");
}

function groupDiagnosticsByMessage(diagnostics: readonly Diagnostic[]): ReadonlyArray<{
  readonly code: string;
  readonly message: string;
  readonly diagnostics: readonly Diagnostic[];
}> {
  const groups = new Map<string, { code: string; message: string; diagnostics: Diagnostic[] }>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\u0000${diagnostic.message}`;
    const current = groups.get(key);
    if (current) current.diagnostics.push(diagnostic);
    else {
      groups.set(key, {
        code: diagnostic.code,
        message: diagnostic.message,
        diagnostics: [diagnostic],
      });
    }
  }
  return [...groups.values()];
}

function diagnosticIdentity(diagnostic: Diagnostic, index: number): string {
  return `${diagnostic.range?.filepath ?? "none"}:${diagnostic.range?.startOffset ?? "none"}:${diagnostic.range?.endOffset ?? "none"}:${index}`;
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
  const { messages } = useUiLocale();
  const [open, setOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  if (snapshot.persistence !== "CONFLICT") return null;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className={secondaryButtonClass} type="button" disabled={disabled}>
          {messages["source.loadServerDraft"]}
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
          <Dialog.Title className="text-xl font-semibold">
            {messages["source.loadServerDraftQuestion"]}
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-slate-300">
            {messages["source.loadServerDraftDescription"](
              snapshot.conflictState?.project.schemaRevisionNo.toString() ??
                messages["common.unavailable"],
            )}
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
              {messages["source.loadServerDraft"]}
            </button>
            <Dialog.Close asChild>
              <button ref={cancelRef} className={secondaryButtonClass} type="button">
                {messages["action.cancel"]}
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
  hasUnsavedLayout,
  requiresSavedWorkspace,
  returnFocusRef,
  onStay,
}: {
  readonly blocker: ReturnType<typeof useBlocker>;
  readonly snapshot: SourceSessionSnapshot;
  readonly hasUnsavedLayout: boolean;
  readonly requiresSavedWorkspace: boolean;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly onStay: () => void;
}) {
  const { messages } = useUiLocale();
  const stayRef = useRef<HTMLButtonElement>(null);
  const open = blocker.state === "blocked";
  const resetNavigation = () => {
    onStay();
    if (blocker.state === "blocked") blocker.reset();
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) resetNavigation();
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
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef.current?.focus();
          }}
        >
          <Dialog.Title className="text-xl font-semibold">
            {messages["navigation.leaveWorkspaceQuestion"]}
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-slate-300">
            {requiresSavedWorkspace &&
            (snapshot.persistence === "ERROR" || snapshot.persistence === "CONFLICT")
              ? messages["navigation.requiresSavedWorkspace"]
              : snapshot.persistence === "SAVING" ||
                  snapshot.persistence === "DIRTY" ||
                  hasUnsavedLayout
                ? messages["navigation.flushingWorkspace"]
                : messages["navigation.unsavedWorkspace"]}
          </Dialog.Description>
          <div className="mt-6 flex flex-row-reverse flex-wrap gap-3">
            {!requiresSavedWorkspace ? (
              <button
                className="min-h-11 rounded-lg bg-red-300 px-4 font-semibold text-red-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300"
                type="button"
                onClick={() => {
                  if (blocker.state === "blocked") blocker.proceed();
                }}
              >
                {messages["navigation.leaveWorkspace"]}
              </button>
            ) : null}
            <button
              ref={stayRef}
              className={secondaryButtonClass}
              type="button"
              onClick={resetNavigation}
            >
              {messages["action.stay"]}
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
      <dt className="text-slate-400">{label}</dt>
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
  const { messages } = useUiLocale();
  return (
    <div className="mt-3 text-sm text-red-100/80">
      <p>
        <strong>{title}:</strong> {error.message}
      </p>
      {error.correlationId ? (
        <p className="mt-1 text-xs">{messages["error.correlationId"](error.correlationId)}</p>
      ) : null}
    </div>
  );
}

function persistenceLabel(status: SourcePersistenceStatus, messages: UiMessages): string {
  return {
    SAVED: messages["source.persistenceSaved"],
    DIRTY: messages["source.persistenceDirty"],
    SAVING: messages["source.persistenceSaving"],
    ERROR: messages["source.persistenceError"],
    CONFLICT: messages["source.persistenceConflict"],
  }[status];
}

function validationLabel(status: SourceValidationStatus, messages: UiMessages): string {
  return {
    PENDING: messages["source.validationPending"],
    VALIDATING: messages["source.validating"],
    VALID: messages["source.valid"],
    INVALID: messages["source.invalid"],
    ERROR: messages["source.validationError"],
  }[status];
}

function applyVisualCommandSelection(
  selectionStore: ReturnType<typeof createDiagramSelectionStore>,
  before: SchemaGraph,
  after: SchemaGraph,
  command: VisualCommand,
): void {
  const diff = diffSchemaGraphs(before, after);
  if (command.kind === "CREATE_TABLE") {
    const keys = diff.changes
      .filter((change) => change.operation === "ADD" && change.elementKind === "table")
      .map((change) => change.key);
    selectionStore
      .getState()
      .setSelection(
        keys.length === 1
          ? { elementKey: keys[0] as string, kind: "table", tableKeys: keys }
          : null,
      );
    return;
  }
  if (command.kind === "CREATE_COLUMN") {
    const keys = diff.changes
      .filter((change) => change.operation === "ADD" && change.elementKind === "column")
      .map((change) => change.key);
    selectionStore
      .getState()
      .setSelection(
        keys.length === 1
          ? { elementKey: keys[0] as string, kind: "column", tableKeys: [command.targetTableKey] }
          : null,
      );
    return;
  }
  if (command.kind === "CREATE_REFERENCE") {
    const keys = diff.changes
      .filter((change) => change.operation === "ADD" && change.elementKind === "reference")
      .map((change) => change.key);
    const reference =
      keys.length === 1 ? after.references.find((candidate) => candidate.key === keys[0]) : null;
    selectionStore.getState().setSelection(
      reference
        ? {
            elementKey: reference.key,
            kind: "reference",
            tableKeys: [...new Set(reference.endpoints.map((endpoint) => endpoint.tableKey))],
          }
        : null,
    );
    return;
  }
  if (command.kind === "RENAME_TABLE" || command.kind === "RENAME_COLUMN") {
    const kind = command.kind === "RENAME_TABLE" ? "table" : "column";
    const beforeKey =
      command.kind === "RENAME_TABLE" ? command.targetTableKey : command.targetColumnKey;
    const candidates = diff.renameCandidates.filter(
      (candidate) => candidate.elementKind === kind && candidate.beforeKey === beforeKey,
    );
    if (candidates.length !== 1) {
      selectionStore.getState().setSelection(null);
      return;
    }
    const afterKey = candidates[0]?.afterKey;
    if (!afterKey) return;
    const tableKeys =
      kind === "table"
        ? [afterKey]
        : [
            after.tables.find((table) => table.columns.some((column) => column.key === afterKey))
              ?.key,
          ].filter((value): value is string => value !== undefined);
    selectionStore.getState().setSelection({ elementKey: afterKey, kind, tableKeys });
    return;
  }
  if (command.kind === "DELETE_COLUMN") {
    selectionStore.getState().setSelection({
      elementKey: command.targetTableKey,
      kind: "table",
      tableKeys: [command.targetTableKey],
    });
    return;
  }
  if (command.kind === "DELETE_TABLE" || command.kind === "DELETE_REFERENCE") {
    selectionStore.getState().setSelection(null);
  }
}

function isSelectionVisible(selection: DiagramSelection, visibility: DiagramVisibility): boolean {
  if (selection.kind === "group") return visibility.groupKeys.has(selection.elementKey);
  if (selection.kind === "reference") return visibility.referenceKeys.has(selection.elementKey);
  return selection.tableKeys.every((tableKey) => visibility.tableKeys.has(tableKey));
}

function updateCachedLayoutRevision(
  queryClient: QueryClient,
  projectId: string,
  layoutRevisionNo: number,
): void {
  queryClient.setQueryData<ProjectResponse>(projectQueryKeys.detail(projectId), (current) =>
    current
      ? {
          state: {
            ...current.state,
            project: { ...current.state.project, layoutRevisionNo },
          },
        }
      : current,
  );
  queryClient.setQueryData<ProjectsResponse>(projectQueryKeys.list, (current) =>
    current
      ? {
          projects: current.projects.map((project) =>
            project.id === projectId ? { ...project, layoutRevisionNo } : project,
          ),
        }
      : current,
  );
}

function historyWorkspaceError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function isSchemaHistoryShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("[data-schema-history-scope]") !== null;
}

const secondaryButtonClass =
  "min-h-10 rounded-lg border border-slate-600 px-3 text-sm font-semibold text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:opacity-50";
const primaryButtonClass =
  "min-h-10 rounded-lg bg-cyan-300 px-3 text-sm font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:opacity-50";
const commandBarButtonClass =
  "inline-flex min-h-10 items-center rounded-lg border border-slate-600 px-3 text-xs font-semibold text-slate-100 no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:opacity-50";
