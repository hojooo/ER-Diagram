import type {
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
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useBlocker } from "react-router-dom";

import type {
  BaseSchemaDiagramProps,
  BaseSchemaDiagramComponent,
  DiagramLayoutRequest,
  DiagramLayoutRequestResult,
} from "../diagram/base-schema-diagram-contract.js";
import { toggleCollapsedGroup } from "../diagram/collapse-state.js";
import { DiagramWorkspaceControls } from "../diagram/diagram-workspace-controls.js";
import { requestWorkerLayout } from "../diagram/layout-worker-client.js";
import {
  createDefaultLayoutValue,
  createLayoutSession,
  type LayoutConflictState,
  type LayoutSessionController,
  type LayoutSessionSnapshot,
  type LayoutViewSnapshot,
} from "../diagram/layout-session.js";
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
import { projectQueryKeys } from "../projects/project-queries.js";
import { useRuntimeResourceLimits } from "../runtime-config.js";
import {
  createVisualCommandSession,
  type VisualCommandSessionController,
  type VisualCommandSessionSnapshot,
} from "../visual-editor/visual-command-session.js";
import { VisualSchemaInspector } from "../visual-editor/visual-schema-inspector.js";
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
    readonly viewport: DiagramViewport;
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
          "Global")
        : "Global",
    [activeGraph, resolvedViewKey],
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

  useEffect(() => {
    if (!sourceEditorRecoveryRequired) return;
    setInitialDiagramReady(true);
    setSourceEditorLoadReady(true);
  }, [sourceEditorRecoveryRequired]);

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
      if (!sourceNavigationReady || !activeGraph) return;
      const range = activeGraph.sourceMap[selection.elementKey];
      if (range) editorRef.current?.revealSourceRange(range);
    },
    [activeGraph, sourceNavigationReady],
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
          ? "Authoritative layout rename migration was reloaded from the server."
          : recoveredCount > 0
            ? `Recovered ${recoveredCount} renamed layout ${recoveredCount === 1 ? "key" : "keys"}. Previous keys were retained for safe fallback.`
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
              message: `Source exceeds the configured ${runtimeLimits.maxSourceBytes} byte limit. Reduce it before validation or saving.`,
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
            "The current DBML source must be saved before changing schema history.",
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
            "Every loaded diagram layout must be saved before changing schema history.",
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
            "The committed history state could not be adopted.",
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

  const handleViewportCommit = useCallback(
    (viewport: DiagramViewport) => {
      editActiveLayout((current) => ({
        ...current,
        viewport: { ...viewport },
        baseSchemaHash: activeGraph?.schemaHash ?? current.baseSchemaHash,
      }));
    },
    [activeGraph?.schemaHash, editActiveLayout],
  );

  const handleRenderedLayoutReady = useCallback(
    (positions: Readonly<Record<string, DiagramPosition>>, viewport: DiagramViewport) => {
      renderedLayoutRef.current = {
        viewKey: resolvedViewKey,
        positions,
        viewport,
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
        setLayoutWorkflowError("Resolve the layout conflict before starting auto-layout.");
        return false;
      }
      let baseline = view.layout;
      const rendered = renderedLayoutRef.current;
      if (includeRenderedLayout && rendered?.viewKey === resolvedViewKey) {
        baseline = {
          ...baseline,
          positions: { ...baseline.positions, ...rendered.positions },
          viewport: { ...rendered.viewport },
          baseSchemaHash: graph.schemaHash,
        };
      }
      await controller.replaceAndFlush(resolvedViewKey, baseline);
      const status = controller.getSnapshot().views.get(resolvedViewKey)?.status;
      if (status === "ERROR" || status === "CONFLICT") {
        setLayoutWorkflowError("The current layout could not be saved as an auto-layout baseline.");
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
      viewport: { ...layoutPreview.viewport },
      baseSchemaHash: activeGraph.schemaHash,
    };
    await controller.replaceAndFlush(resolvedViewKey, next);
    const status = controller.getSnapshot().views.get(resolvedViewKey)?.status;
    setLayoutPreview(null);
    setLayoutRequest(null);
    if (status === "ERROR" || status === "CONFLICT") {
      setLayoutWorkflowError(
        status === "CONFLICT"
          ? "The auto-layout is preserved locally. Resolve the layout conflict to continue."
          : "The auto-layout could not be saved. The previous durable layout is unchanged.",
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
        setLayoutWorkflowError("Automatic layout failed. The durable layout was not changed.");
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
        viewport: { ...result.viewport },
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
              ? "The reset layout is preserved locally. Resolve the layout conflict to continue."
              : "The reset layout could not be saved. The previous durable layout is unchanged.",
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
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-slate-300">
        <p aria-live="polite">Preparing source workspace…</p>
      </div>
    );
  }

  const { serverState } = sessionSnapshot;
  return (
    <>
      <div className="mt-8 space-y-5">
        {historySession && historySnapshot ? (
          <SchemaHistoryControls
            session={historySession}
            loadRevisions={loadHistoryRevisions}
            interactionDisabled={visualCommandWorkspaceLocked}
          />
        ) : null}
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
            {sourceEditorLoadReady ? (
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
                <p aria-live="polite">Preparing the diagram before loading editor assets…</p>
              </div>
            )}
          </section>

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
            searchQuery={searchQuery}
            selectionStore={selectionStore}
            DiagramComponent={DiagramComponent}
            requestLayout={requestBoundedLayout}
            sourceNavigationEnabled={sourceNavigationReady}
            layoutView={activeLayoutView}
            layoutConflict={layoutSnapshot?.conflict ?? null}
            layoutPositions={activeLayout.positions}
            layoutViewport={activeLayoutView?.persistedLayout ? activeLayout.viewport : null}
            layoutRequest={layoutRequest}
            layoutPreview={layoutPreview}
            layoutWorkflowError={layoutWorkflowError}
            layoutRecoveryNotice={layoutRecoveryNotice}
            onToggleGroup={handleToggleGroup}
            onViewChange={handleViewChange}
            onDetailLevelChange={handleDetailLevelChange}
            onSearchQueryChange={setSearchQuery}
            onActivateSearchResult={handleActivateSearchResult}
            onNavigateSource={handleNavigateSource}
            onFocusSource={() => editorRef.current?.focus()}
            onPositionsCommit={handlePositionsCommit}
            onViewportCommit={handleViewportCommit}
            onRenderedLayoutReady={handleRenderedLayoutReady}
            onLayoutRequestReady={handleLayoutRequestReady}
            onPreviewAutoLayout={() => void handlePreviewAutoLayout()}
            onApplyAutoLayout={() => void handleApplyAutoLayout()}
            onCancelAutoLayout={handleCancelAutoLayout}
            onResetLayout={() => void handleResetLayout()}
            onRetryLayout={() => void layoutSessionRef.current?.retrySave()}
            onRetryLocalLayout={() => void layoutSessionRef.current?.retryLocalLayout()}
            onLoadServerLayout={() => void layoutSessionRef.current?.loadServerLayout()}
            onReloadLayout={() => void handleReloadLayout()}
            layoutInteractionDisabled={layoutInteractionLocked}
            visualCommandSession={visualCommandSession}
            visualInteractionDisabled={
              layoutInteractionLocked ||
              !sessionSnapshot.canUseValidSchema ||
              visualCommandSession === null
            }
            onOpenVisualSource={(range) => {
              if (range) editorRef.current?.revealSourceRange(range);
              else editorRef.current?.focus();
            }}
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

        {activeGraph && visibility ? (
          <SchemaOutline
            graph={activeGraph}
            visibility={visibility}
            viewLabel={viewLabel}
            collapsedGroupKeys={activeCollapsedGroupKeys}
            selectionStore={selectionStore}
            sourceNavigationEnabled={sourceNavigationReady}
            onToggleGroup={handleToggleGroup}
            onNavigateSource={handleNavigateSource}
          />
        ) : null}
        {hiddenSourceSelection ? (
          <section
            className="rounded-2xl border border-amber-300/50 bg-amber-950/30 p-4 text-sm text-amber-100"
            role="status"
          >
            <p>This symbol is hidden by {hiddenSourceSelection.viewLabel}.</p>
            <button
              className="mt-3 min-h-10 rounded-lg border border-amber-200 px-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200"
              type="button"
              onClick={handleShowHiddenSelectionInGlobal}
            >
              Show in Global
            </button>
          </section>
        ) : null}
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {persistenceLabel(sessionSnapshot.persistence)}.{" "}
        {validationLabel(sessionSnapshot.validation)}.
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

function DiagramPanel({
  snapshot,
  visibility,
  viewKey,
  viewLabel,
  detailLevel,
  collapsedGroupKeys,
  focusRequest,
  searchQuery,
  selectionStore,
  DiagramComponent,
  requestLayout,
  sourceNavigationEnabled,
  layoutView,
  layoutConflict,
  layoutPositions,
  layoutViewport,
  layoutRequest,
  layoutPreview,
  layoutWorkflowError,
  layoutRecoveryNotice,
  onToggleGroup,
  onViewChange,
  onDetailLevelChange,
  onSearchQueryChange,
  onActivateSearchResult,
  onNavigateSource,
  onFocusSource,
  onPositionsCommit,
  onViewportCommit,
  onRenderedLayoutReady,
  onLayoutRequestReady,
  onPreviewAutoLayout,
  onApplyAutoLayout,
  onCancelAutoLayout,
  onResetLayout,
  onRetryLayout,
  onRetryLocalLayout,
  onLoadServerLayout,
  onReloadLayout,
  layoutInteractionDisabled,
  visualCommandSession,
  visualInteractionDisabled,
  onOpenVisualSource,
}: {
  readonly snapshot: SourceSessionSnapshot;
  readonly visibility: DiagramVisibility | null;
  readonly viewKey: DiagramViewKey;
  readonly viewLabel: string;
  readonly detailLevel: DiagramLod;
  readonly collapsedGroupKeys: ReadonlySet<string>;
  readonly focusRequest: DiagramFocusRequest | null;
  readonly searchQuery: string;
  readonly selectionStore: ReturnType<typeof createDiagramSelectionStore>;
  readonly DiagramComponent: BaseSchemaDiagramComponent;
  readonly requestLayout: NonNullable<BaseSchemaDiagramProps["requestLayout"]>;
  readonly sourceNavigationEnabled: boolean;
  readonly layoutView: LayoutViewSnapshot | null;
  readonly layoutConflict: LayoutConflictState | null;
  readonly layoutPositions: Readonly<Record<string, DiagramPosition>>;
  readonly layoutViewport: DiagramViewport | null;
  readonly layoutRequest: DiagramLayoutRequest | null;
  readonly layoutPreview: DiagramLayoutRequestResult | null;
  readonly layoutWorkflowError: string | null;
  readonly layoutRecoveryNotice: string | null;
  readonly onToggleGroup: (groupKey: string) => void;
  readonly onViewChange: (viewKey: DiagramViewKey) => void;
  readonly onDetailLevelChange: (detailLevel: DiagramLod) => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onActivateSearchResult: (result: DiagramSearchResult) => void;
  readonly onNavigateSource: (selection: DiagramSelection) => void;
  readonly onFocusSource: () => void;
  readonly onPositionsCommit: (positions: Readonly<Record<string, DiagramPosition>>) => void;
  readonly onViewportCommit: (viewport: DiagramViewport) => void;
  readonly onRenderedLayoutReady: (
    positions: Readonly<Record<string, DiagramPosition>>,
    viewport: DiagramViewport,
  ) => void;
  readonly onLayoutRequestReady: (result: DiagramLayoutRequestResult) => void;
  readonly onPreviewAutoLayout: () => void;
  readonly onApplyAutoLayout: () => void;
  readonly onCancelAutoLayout: () => void;
  readonly onResetLayout: () => void;
  readonly onRetryLayout: () => void;
  readonly onRetryLocalLayout: () => void;
  readonly onLoadServerLayout: () => void;
  readonly onReloadLayout: () => void;
  readonly layoutInteractionDisabled: boolean;
  readonly visualCommandSession: VisualCommandSessionController | null;
  readonly visualInteractionDisabled: boolean;
  readonly onOpenVisualSource: (range: import("@er-diagram/contracts").SourceRange | null) => void;
}) {
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
    <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
      <div className="border-b border-slate-700 px-4 py-3">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
          Editable ER diagram
        </p>
        <p className="mt-1 text-xs text-slate-400" aria-live="polite">
          {showingLastValid
            ? `Showing last-valid revision ${lastValidRevisionNo ?? "unknown"}. Source navigation is disabled until the current draft is valid.`
            : graph
              ? "Showing the current valid draft. Select a schema element to inspect, edit, or open its source."
              : "Waiting for a valid schema graph."}
        </p>
      </div>
      {graph && visibility ? (
        <>
          <DiagramWorkspaceControls
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
          <Suspense
            fallback={
              <div className="grid min-h-[32rem] place-items-center bg-slate-950 text-slate-300">
                <p aria-live="polite">Loading local diagram assets…</p>
              </div>
            }
          >
            {layoutLoadFailed ? (
              <div className="grid min-h-[32rem] place-items-center bg-slate-950 p-6 text-center">
                <div>
                  <p className="font-semibold text-red-100">Layout could not be loaded</p>
                  <p className="mt-2 text-sm text-slate-400">
                    The diagram remains protected from overwriting an unknown server layout.
                  </p>
                  <button
                    className={`${secondaryButtonClass} mt-4`}
                    type="button"
                    onClick={onReloadLayout}
                  >
                    Retry layout load
                  </button>
                </div>
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
                requestLayout={requestLayout}
                layoutPositions={layoutPositions}
                layoutViewport={layoutViewport}
                layoutPending={layoutHydrating}
                layoutRequest={layoutRequest}
                interactionDisabled={
                  layoutBusy || layoutConflict !== null || visualInteractionDisabled
                }
                onPositionsCommit={onPositionsCommit}
                onViewportCommit={onViewportCommit}
                onRenderedLayoutReady={onRenderedLayoutReady}
                onLayoutRequestReady={onLayoutRequestReady}
              />
            )}
          </Suspense>
          <p className="sr-only" aria-live="polite">
            Showing {viewLabel} at {detailLevel.toLowerCase().replaceAll("_", " ")} detail.
          </p>
          {visualCommandSession ? (
            <VisualSchemaInspector
              graph={graph}
              primaryDialect={snapshot.serverState.project.primaryDialect}
              currentViewKey={viewKey}
              selectionStore={selectionStore}
              commandSession={visualCommandSession}
              interactionDisabled={visualInteractionDisabled}
              sourceNavigationEnabled={sourceNavigationEnabled}
              onOpenSource={onOpenVisualSource}
              onReloadLayouts={onReloadLayout}
            />
          ) : null}
        </>
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
              ? "Auto-layout preview ready"
              : "Previewing auto layout"
            : layoutRequest?.mode === "RESET"
              ? "Resetting layout"
              : layoutStatusLabel(layoutView)}
        </p>
        <div className="flex flex-wrap gap-2">
          {layoutRequest?.mode === "PREVIEW" && layoutPreview ? (
            <>
              <button className={primaryButtonClass} type="button" onClick={onApply}>
                Apply auto layout
              </button>
              <button className={secondaryButtonClass} type="button" onClick={onCancel}>
                Cancel preview
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
                Preview auto layout
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
              Retry layout save
            </button>
          ) : null}
        </div>
      </div>

      {schemaHashMismatch ? (
        <p className="mt-2 text-xs text-amber-200" role="status">
          This layout was saved for an earlier schema. Matching stable keys were restored; new
          elements use automatic positions.
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
          Correlation ID: {layoutView.error.correlationId}
        </p>
      ) : null}
      {layoutConflict ? (
        <div
          className="mt-3 rounded-lg border border-amber-300/50 bg-amber-950/30 p-3"
          role="alert"
        >
          <p className="font-semibold text-amber-100">Layout conflict</p>
          <p className="mt-1 text-xs text-amber-100/80">
            Autosave is paused. Local layouts remain available until you choose a recovery action.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={primaryButtonClass} type="button" onClick={onRetryLocal}>
              Retry local layout
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
  const [open, setOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className={secondaryButtonClass} type="button" disabled={disabled}>
          Reset layout
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
          <Dialog.Title className="text-xl font-semibold">Reset this view layout?</Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-slate-300">
            {viewKey} will return to Full detail, all groups expanded, no hidden elements, and a
            fresh automatic layout. Other views are not changed.
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
              Reset this view
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

function LayoutConflictLoadDialog({
  viewKey,
  onLoad,
}: {
  readonly viewKey: string;
  readonly onLoad: () => void;
}) {
  const [open, setOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className={secondaryButtonClass} type="button">
          Load server layout
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
          <Dialog.Title className="text-xl font-semibold">Load server layout?</Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-slate-300">
            This replaces the unsaved local layout for {viewKey}. Pending layouts for other views
            remain unchanged.
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
              Load server layout
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

function layoutStatusLabel(view: LayoutViewSnapshot | null): string {
  if (!view) return "Loading layout";
  return {
    LOADING: "Loading layout",
    SAVED: "Layout saved",
    DIRTY: "Unsaved layout changes",
    SAVING: "Saving layout",
    ERROR: "Layout save error",
    CONFLICT: "Layout conflict",
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
              <p className="mt-2 break-all text-[0.7rem] text-slate-400">{diagnostic.code}</p>
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
          <Dialog.Title className="text-xl font-semibold">Leave schema workspace?</Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-slate-300">
            {requiresSavedWorkspace &&
            (snapshot.persistence === "ERROR" || snapshot.persistence === "CONFLICT")
              ? "SQL import and export require a fully saved source and layout. Resolve the current save error or conflict, then try again."
              : snapshot.persistence === "SAVING" ||
                  snapshot.persistence === "DIRTY" ||
                  hasUnsavedLayout
                ? "Source and layout changes are being flushed. Navigation will continue automatically after every write succeeds."
                : "Local source or layout changes have not been saved. Leaving now discards changes that were not sent; a write already sent to the server may still commit."}
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
                Leave workspace
              </button>
            ) : null}
            <button
              ref={stayRef}
              className={secondaryButtonClass}
              type="button"
              onClick={resetNavigation}
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
  return (
    target.closest('[aria-label="ER diagram canvas"]') !== null ||
    target.closest('section[aria-label="DBML source editor"]') !== null
  );
}

const secondaryButtonClass =
  "min-h-10 rounded-lg border border-slate-600 px-3 text-sm font-semibold text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:opacity-50";
const primaryButtonClass =
  "min-h-10 rounded-lg bg-cyan-300 px-3 text-sm font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:opacity-50";
