import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  type EdgeTypes,
  type NodeTypes,
  ReactFlow,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import { useUiLocale } from "../localization/ui-locale.js";
import type { BaseSchemaDiagramProps } from "./base-schema-diagram-contract.js";
import {
  DiagramInteractionContext,
  GroupDiagramNodeComponent,
  ReferenceDiagramEdgeComponent,
  shouldShowDiagramEdgeLabels,
  TableDiagramNodeComponent,
} from "./diagram-components.js";
import { deriveInteractiveLayout, deriveInteractiveViewport } from "./interactive-layout.js";
import { requestWorkerLayout } from "./layout-worker-client.js";
import {
  createDiagramProjection,
  createDiagramVisibility,
  GLOBAL_VIEW_KEY,
  listDiagramViews,
} from "./projection.js";
import type { DiagramSelection } from "./source-navigation.js";
import type {
  DiagramFocusRequest,
  DiagramProjection,
  GroupDiagramNode,
  SchemaDiagramEdge,
  SchemaDiagramNode,
  TableDiagramNode,
} from "./types.js";

const nodeTypes = {
  group: GroupDiagramNodeComponent,
  table: TableDiagramNodeComponent,
} satisfies NodeTypes;
const edgeTypes = { reference: ReferenceDiagramEdgeComponent } satisfies EdgeTypes;

type LayoutStatus = "LAYING_OUT" | "SETTLING" | "READY" | "ERROR";
const EMPTY_LAYOUT_POSITIONS = {} as const;

export function BaseSchemaDiagram({
  graph,
  viewKey,
  detailLevel,
  collapsedGroupKeys,
  focusRequest = null,
  selectionStore,
  onToggleGroup,
  onActivateElement,
  viewportInsets = EMPTY_VIEWPORT_INSETS,
  fillContainer = false,
  requestLayout = requestWorkerLayout,
  layoutPositions = EMPTY_LAYOUT_POSITIONS,
  layoutViewport = null,
  layoutPending = false,
  layoutRequest = null,
  interactionDisabled = false,
  onPositionsCommit,
  onViewportCommit,
  onLayoutRequestReady,
  onRenderedLayoutReady,
}: BaseSchemaDiagramProps) {
  const { messages } = useUiLocale();
  const projection = useMemo(
    () =>
      createDiagramProjection(graph, {
        viewKey,
        collapsedGroupKeys,
        lod: detailLevel,
      }),
    [collapsedGroupKeys, detailLevel, graph, viewKey],
  );
  const visibility = useMemo(() => createDiagramVisibility(graph, viewKey), [graph, viewKey]);
  const viewLabel = useMemo(
    () =>
      listDiagramViews(graph).find((view) => view.key === viewKey)?.label ??
      messages["diagram.global"],
    [graph, messages, viewKey],
  );
  const [displayProjection, setDisplayProjection] = useState(() =>
    layoutRequest
      ? projection
      : deriveInteractiveLayout(projection, { savedPositions: layoutPositions }),
  );
  const [layoutStatus, setLayoutStatus] = useState<LayoutStatus>(
    projection.nodes.length === 0 ? "READY" : layoutRequest ? "LAYING_OUT" : "SETTLING",
  );
  const [settledLayoutRequestId, setSettledLayoutRequestId] = useState<string | null>(null);
  const [layoutGeneration, setLayoutGeneration] = useState(0);
  const [flowInstance, setFlowInstance] = useState<
    ReactFlowInstance<SchemaDiagramNode, SchemaDiagramEdge> | undefined
  >();
  const flowInstanceRef = useRef<
    ReactFlowInstance<SchemaDiagramNode, SchemaDiagramEdge> | undefined
  >(undefined);
  const diagramContainerRef = useRef<HTMLDivElement>(null);
  const viewportInsetsRef = useRef(viewportInsets);
  viewportInsetsRef.current = viewportInsets;
  const selection = useStore(selectionStore, (state) => state.selection);
  const requestGenerationRef = useRef(0);
  const stableProjectionRef = useRef<DiagramProjection | null>(
    layoutRequest ? null : displayProjection,
  );
  const activeLayoutRequestRef = useRef("");
  const fittedLayoutRequestRef = useRef<string | null>(null);
  const preparedViewportRef = useRef<{
    requestId: string;
    completion: Promise<unknown>;
  } | null>(null);
  const focusedRequestRef = useRef<number | null>(null);
  const referenceByKey = useMemo(
    () => new Map(graph.references.map((reference) => [reference.key, reference])),
    [graph.references],
  );

  useEffect(() => {
    requestGenerationRef.current += 1;
    const requestId = `${graph.schemaHash}:${layoutGeneration}:${requestGenerationRef.current}`;
    activeLayoutRequestRef.current = requestId;
    preparedViewportRef.current = null;
    setSettledLayoutRequestId(null);

    if (projection.nodes.length === 0) {
      const emptyProjection = deriveInteractiveLayout(projection);
      setDisplayProjection(emptyProjection);
      if (!layoutRequest) stableProjectionRef.current = emptyProjection;
      setLayoutStatus("READY");
      setSettledLayoutRequestId(requestId);
      return;
    }

    if (!layoutRequest) {
      const derivedProjection = deriveInteractiveLayout(projection, {
        savedPositions: layoutPositions,
        previousProjection: stableProjectionRef.current,
      });
      const container = diagramContainerRef.current;
      const viewport =
        layoutViewport ??
        (container
          ? deriveInteractiveViewport(
              derivedProjection,
              {
                width: container.clientWidth,
                height: container.clientHeight,
              },
              { insets: viewportInsetsRef.current },
            )
          : null);
      const currentFlowInstance = flowInstanceRef.current;
      let viewportPrepared = false;
      if (currentFlowInstance && viewport) {
        preparedViewportRef.current = {
          requestId,
          completion: Promise.resolve(currentFlowInstance.setViewport(viewport)),
        };
        viewportPrepared = true;
      }
      setDisplayProjection(derivedProjection);
      setLayoutStatus(viewportPrepared && !layoutPending ? "READY" : "SETTLING");
      setSettledLayoutRequestId(requestId);
      return;
    }

    setDisplayProjection(projection);
    setLayoutStatus("LAYING_OUT");
    void requestLayout(projection).then(
      (laidOut) => {
        if (activeLayoutRequestRef.current !== requestId) return;
        setDisplayProjection(laidOut);
        setLayoutStatus("SETTLING");
        setSettledLayoutRequestId(requestId);
      },
      () => {
        if (activeLayoutRequestRef.current !== requestId) return;
        setDisplayProjection(projection);
        setLayoutStatus("ERROR");
        setSettledLayoutRequestId(requestId);
      },
    );
  }, [
    graph.schemaHash,
    layoutGeneration,
    layoutPositions,
    layoutPending,
    layoutRequest,
    layoutViewport,
    projection,
    requestLayout,
  ]);

  useEffect(() => {
    if (
      layoutStatus === "LAYING_OUT" ||
      layoutPending ||
      !settledLayoutRequestId ||
      !flowInstance ||
      projection.nodes.length === 0
    ) {
      return;
    }
    if (fittedLayoutRequestRef.current === settledLayoutRequestId) return;
    const animationFrame = requestAnimationFrame(() => {
      const finishRenderedLayout = () => {
        if (activeLayoutRequestRef.current !== settledLayoutRequestId) return;
        if (fittedLayoutRequestRef.current === settledLayoutRequestId) return;
        fittedLayoutRequestRef.current = settledLayoutRequestId;
        if (layoutRequest) {
          const succeeded = layoutStatus !== "ERROR";
          if (succeeded) setLayoutStatus("READY");
          onLayoutRequestReady?.({
            requestId: layoutRequest.requestId,
            mode: layoutRequest.mode,
            succeeded,
            positions: projectionPositions(displayProjection),
            viewport: flowInstance.getViewport(),
          });
          return;
        }
        stableProjectionRef.current = displayProjection;
        setLayoutStatus("READY");
        onRenderedLayoutReady?.(projectionPositions(displayProjection), flowInstance.getViewport());
      };
      const preparedViewport = preparedViewportRef.current;
      if (preparedViewport?.requestId === settledLayoutRequestId) {
        void preparedViewport.completion.then(finishRenderedLayout, () => {
          void Promise.resolve(flowInstance.fitView({ padding: 0.15 })).then(finishRenderedLayout);
        });
        return;
      }
      if (!layoutRequest && layoutViewport) {
        void Promise.resolve(flowInstance.setViewport(layoutViewport)).then(finishRenderedLayout);
        return;
      }
      if (!layoutRequest) {
        const container = diagramContainerRef.current;
        const viewport = container
          ? deriveInteractiveViewport(
              displayProjection,
              {
                width: container.clientWidth,
                height: container.clientHeight,
              },
              { insets: viewportInsetsRef.current },
            )
          : null;
        if (viewport) {
          void Promise.resolve(flowInstance.setViewport(viewport)).then(finishRenderedLayout);
          return;
        }
      }
      const container = diagramContainerRef.current;
      const viewport = container
        ? deriveInteractiveViewport(
            displayProjection,
            { width: container.clientWidth, height: container.clientHeight },
            { insets: viewportInsetsRef.current },
          )
        : null;
      if (viewport) {
        void Promise.resolve(flowInstance.setViewport(viewport)).then(finishRenderedLayout);
        return;
      }
      void Promise.resolve(flowInstance.fitView({ padding: 0.15 })).then(finishRenderedLayout);
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [
    displayProjection,
    flowInstance,
    layoutRequest,
    layoutPending,
    layoutStatus,
    layoutViewport,
    onLayoutRequestReady,
    onRenderedLayoutReady,
    projection.nodes.length,
    settledLayoutRequestId,
  ]);

  useEffect(() => {
    if (!flowInstance || !selection || displayProjection.nodes.length === 0) return;
    const selectedNodeIds = representativeNodeIds(displayProjection, selection);
    if (selectedNodeIds.size === 0) return;
    const selectedNodes = displayProjection.nodes.filter((node) => selectedNodeIds.has(node.id));
    const animationFrame = requestAnimationFrame(() => {
      const container = diagramContainerRef.current;
      const viewport = container
        ? deriveInteractiveViewport(
            displayProjection,
            { width: container.clientWidth, height: container.clientHeight },
            {
              padding: 0.45,
              insets: viewportInsetsRef.current,
              targetNodeIds: selectedNodeIds,
            },
          )
        : null;
      if (viewport) void flowInstance.setViewport(viewport, { duration: 250 });
      else void flowInstance.fitView({ nodes: selectedNodes, padding: 0.45, duration: 250 });
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [displayProjection, flowInstance, selection]);

  useEffect(() => {
    if (
      !focusRequest ||
      focusedRequestRef.current === focusRequest.requestId ||
      layoutStatus === "LAYING_OUT" ||
      !settledLayoutRequestId ||
      !flowInstance ||
      displayProjection.nodes.length === 0
    ) {
      return;
    }
    const selectedNodeIds = representativeNodeIdsForFocus(displayProjection, focusRequest);
    if (selectedNodeIds.size === 0) return;
    const selectedNodes = displayProjection.nodes.filter((node) => selectedNodeIds.has(node.id));
    focusedRequestRef.current = focusRequest.requestId;
    const animationFrame = requestAnimationFrame(() => {
      const container = diagramContainerRef.current;
      const viewport = container
        ? deriveInteractiveViewport(
            displayProjection,
            { width: container.clientWidth, height: container.clientHeight },
            {
              padding: 0.35,
              insets: viewportInsetsRef.current,
              targetNodeIds: selectedNodeIds,
            },
          )
        : null;
      if (viewport) void flowInstance.setViewport(viewport, { duration: 250 });
      else void flowInstance.fitView({ nodes: selectedNodes, padding: 0.35, duration: 250 });
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [displayProjection, flowInstance, focusRequest, layoutStatus, settledLayoutRequestId]);

  const activateElement = useCallback(
    (nextSelection: DiagramSelection) => {
      selectionStore.getState().setSelection(nextSelection);
      onActivateElement?.(nextSelection);
    },
    [onActivateElement, selectionStore],
  );
  const interactions = useMemo(
    () => ({
      activateElement,
      toggleGroup: onToggleGroup,
      showEdgeLabels: shouldShowDiagramEdgeLabels(displayProjection.edges.length),
    }),
    [activateElement, displayProjection.edges.length, onToggleGroup],
  );
  const handleFlowInit = useCallback(
    (instance: ReactFlowInstance<SchemaDiagramNode, SchemaDiagramEdge>) => {
      flowInstanceRef.current = instance;
      setFlowInstance(instance);
    },
    [],
  );

  const selectedProjection = useMemo<DiagramProjection>(() => {
    if (!selection) return displayProjection;
    const selectedElementKey = selection.elementKey;
    return {
      ...displayProjection,
      nodes: displayProjection.nodes.map((node) => {
        if (node.type === "table") {
          const selected = selection.tableKeys.includes(node.data.tableKey);
          if (!selected) return node;
          return {
            ...node,
            selected: true,
            data: {
              ...node.data,
              selectedElementKey,
            },
          } satisfies TableDiagramNode;
        }
        const selected =
          selection.elementKey === node.data.groupKey ||
          (node.data.collapsed &&
            selection.tableKeys.some((tableKey) => node.data.tableKeys.includes(tableKey)));
        if (!selected) return node;
        return {
          ...node,
          selected: true,
          data: {
            ...node.data,
            selectedElementKey,
          },
        } satisfies GroupDiagramNode;
      }),
      edges: displayProjection.edges.map((edge) =>
        edge.data.referenceKeys.includes(selectedElementKey) ? { ...edge, selected: true } : edge,
      ),
    };
  }, [displayProjection, selection]);

  if (visibility.tableKeys.size === 0) {
    return (
      <div className="grid min-h-[32rem] place-items-center bg-slate-950 p-6 text-center">
        <div>
          <p className="font-semibold text-slate-100">
            {viewKey === GLOBAL_VIEW_KEY
              ? messages["diagram.emptyGlobal"]
              : messages["diagram.emptyView"](viewLabel)}
          </p>
          <p className="mt-2 text-sm text-slate-400">
            {viewKey === GLOBAL_VIEW_KEY
              ? messages["diagram.emptyGlobalDescription"]
              : messages["diagram.emptyViewDescription"]}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={diagramContainerRef}
      data-schema-history-scope="diagram"
      className={`relative bg-slate-950 ${
        fillContainer ? "h-full min-h-0" : "h-[min(68vh,52rem)] min-h-[32rem]"
      }`}
    >
      <p
        className="sr-only"
        aria-live="polite"
        data-testid="base-diagram-layout-status"
        data-view-key={displayProjection.viewKey}
        data-lod={displayProjection.lod}
      >
        {layoutPending
          ? messages["diagram.loadingLayout"]
          : layoutStatus === "LAYING_OUT"
            ? messages["diagram.layingOut"]
            : layoutStatus === "SETTLING"
              ? messages["diagram.preparingViewport"]
              : layoutStatus === "READY"
                ? messages["diagram.layoutReady"]
                : messages["diagram.layoutFailedStatus"]}
      </p>
      {layoutPending ? (
        <div
          className="absolute right-3 top-3 z-10 rounded-lg border border-slate-600 bg-slate-950/95 px-3 py-2 text-xs text-slate-200"
          role="status"
        >
          {messages["diagram.loadingSavedLayout"]}
        </div>
      ) : null}
      {layoutStatus === "ERROR" ? (
        <div
          className="absolute right-3 top-3 z-10 flex items-center gap-3 rounded-lg border border-amber-300/50 bg-amber-950/95 px-3 py-2 text-xs text-amber-100"
          role="alert"
        >
          <span>{messages["diagram.layoutFailed"]}</span>
          <button
            className="rounded border border-amber-200 px-2 py-1 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200"
            type="button"
            onClick={() => setLayoutGeneration((current) => current + 1)}
          >
            {messages["diagram.retryLayout"]}
          </button>
        </div>
      ) : null}
      <DiagramInteractionContext.Provider value={interactions}>
        <ReactFlow<SchemaDiagramNode, SchemaDiagramEdge>
          aria-label={messages["diagram.canvas"]}
          nodes={selectedProjection.nodes}
          edges={selectedProjection.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onInit={handleFlowInit}
          onNodeClick={(_event, node) => {
            if (node.type === "table") {
              activateElement({
                elementKey: node.data.tableKey,
                kind: "table",
                tableKeys: [node.data.tableKey],
              });
            } else {
              activateElement({
                elementKey: node.data.groupKey,
                kind: "group",
                tableKeys: node.data.tableKeys,
              });
            }
          }}
          onEdgeClick={(_event, edge) => {
            if (edge.data.referenceKeys.length !== 1) return;
            const referenceKey = edge.data.referenceKeys[0];
            if (!referenceKey) return;
            const reference = referenceByKey.get(referenceKey);
            if (!reference) return;
            activateElement({
              elementKey: referenceKey,
              kind: "reference",
              tableKeys: reference.endpoints.map((endpoint) => endpoint.tableKey),
            });
          }}
          onPaneClick={() => selectionStore.getState().setSelection(null)}
          onNodesChange={(changes) => {
            const controlledChanges = changes.filter(
              (change) =>
                change.type !== "add" && change.type !== "remove" && change.type !== "select",
            );
            if (controlledChanges.length === 0) return;
            setDisplayProjection((current) => ({
              ...current,
              nodes: applyNodeChanges(controlledChanges, current.nodes),
            }));
          }}
          onNodeDragStop={(_event, node) => {
            if (interactionDisabled || layoutRequest) return;
            const positions = projectionPositions(displayProjection);
            positions[node.id] = { ...node.position };
            onPositionsCommit?.(positions);
            if (flowInstance) onViewportCommit?.(toDiagramViewport(flowInstance.getViewport()));
          }}
          onMoveEnd={(event, viewport) => {
            if (!event || interactionDisabled || layoutRequest) return;
            onViewportCommit?.(toDiagramViewport(viewport));
          }}
          nodesDraggable={!interactionDisabled && layoutStatus === "READY"}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesReconnectable={false}
          edgesFocusable={false}
          elementsSelectable
          deleteKeyCode={null}
          fitView={false}
          minZoom={0.15}
          maxZoom={1.75}
          onlyRenderVisibleElements
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls
            showInteractive={false}
            style={{
              right: Math.max(10, viewportInsets.right + 10),
              bottom: Math.max(10, viewportInsets.bottom + 10),
            }}
          />
        </ReactFlow>
      </DiagramInteractionContext.Provider>
    </div>
  );
}

const EMPTY_VIEWPORT_INSETS = { top: 0, right: 0, bottom: 0, left: 0 } as const;

function projectionPositions(
  projection: DiagramProjection,
): Record<string, { x: number; y: number }> {
  return Object.fromEntries(
    projection.nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y }]),
  );
}

function toDiagramViewport(viewport: Viewport): { x: number; y: number; zoom: number } {
  return { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
}

function representativeNodeIdsForFocus(
  projection: DiagramProjection,
  focusRequest: DiagramFocusRequest,
): ReadonlySet<string> {
  const result = new Set<string>();
  const nodeById = new Map(projection.nodes.map((node) => [node.id, node]));
  for (const groupKey of focusRequest.groupKeys) {
    if (nodeById.get(groupKey)?.type === "group") result.add(groupKey);
  }
  for (const tableKey of focusRequest.tableKeys) {
    if (nodeById.get(tableKey)?.type === "table") {
      result.add(tableKey);
      continue;
    }
    const representative = projection.nodes.find(
      (node) =>
        node.type === "group" && node.data.collapsed && node.data.tableKeys.includes(tableKey),
    );
    if (representative) result.add(representative.id);
  }
  return result;
}

function representativeNodeIds(
  projection: DiagramProjection,
  selection: DiagramSelection,
): ReadonlySet<string> {
  const nodeById = new Map(projection.nodes.map((node) => [node.id, node]));
  const result = new Set<string>();

  if (selection.kind === "group" && nodeById.has(selection.elementKey)) {
    result.add(selection.elementKey);
  }
  for (const tableKey of selection.tableKeys) {
    if (nodeById.get(tableKey)?.type === "table") {
      result.add(tableKey);
      continue;
    }
    const parent = projection.nodes.find(
      (node) =>
        node.type === "group" && node.data.collapsed && node.data.tableKeys.includes(tableKey),
    );
    if (parent) result.add(parent.id);
  }
  return result;
}
