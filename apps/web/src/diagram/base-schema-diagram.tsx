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

import type { BaseSchemaDiagramProps } from "./base-schema-diagram-contract.js";
import {
  DiagramInteractionContext,
  GroupDiagramNodeComponent,
  ReferenceDiagramEdgeComponent,
  TableDiagramNodeComponent,
} from "./diagram-components.js";
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

type LayoutStatus = "LAYING_OUT" | "READY" | "ERROR";
const EMPTY_LAYOUT_POSITIONS = {} as const;

export function BaseSchemaDiagram({
  graph,
  viewKey,
  detailLevel,
  collapsedGroupKeys,
  focusRequest = null,
  selectionStore,
  sourceNavigationEnabled,
  onToggleGroup,
  onNavigateSource,
  requestLayout = requestWorkerLayout,
  layoutPositions = EMPTY_LAYOUT_POSITIONS,
  layoutViewport = null,
  layoutRequest = null,
  interactionDisabled = false,
  onPositionsCommit,
  onViewportCommit,
  onLayoutRequestReady,
  onRenderedLayoutReady,
}: BaseSchemaDiagramProps) {
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
    () => listDiagramViews(graph).find((view) => view.key === viewKey)?.label ?? "Global",
    [graph, viewKey],
  );
  const [displayProjection, setDisplayProjection] = useState(projection);
  const [layoutStatus, setLayoutStatus] = useState<LayoutStatus>(
    projection.nodes.length === 0 ? "READY" : "LAYING_OUT",
  );
  const [settledLayoutRequestId, setSettledLayoutRequestId] = useState<string | null>(null);
  const [layoutGeneration, setLayoutGeneration] = useState(0);
  const [flowInstance, setFlowInstance] = useState<
    ReactFlowInstance<SchemaDiagramNode, SchemaDiagramEdge> | undefined
  >();
  const selection = useStore(selectionStore, (state) => state.selection);
  const requestGenerationRef = useRef(0);
  const layoutPositionsRef = useRef(layoutPositions);
  const activeLayoutRequestRef = useRef("");
  const fittedLayoutRequestRef = useRef<string | null>(null);
  const focusedRequestRef = useRef<number | null>(null);
  const referenceByKey = useMemo(
    () => new Map(graph.references.map((reference) => [reference.key, reference])),
    [graph.references],
  );

  useEffect(() => {
    layoutPositionsRef.current = layoutPositions;
    if (layoutRequest) return;
    setDisplayProjection((current) => applySavedPositions(current, layoutPositions));
  }, [layoutPositions, layoutRequest]);

  useEffect(() => {
    requestGenerationRef.current += 1;
    const requestId = `${graph.schemaHash}:${layoutGeneration}:${requestGenerationRef.current}`;
    activeLayoutRequestRef.current = requestId;
    setDisplayProjection(
      layoutRequest ? projection : applySavedPositions(projection, layoutPositionsRef.current),
    );
    setSettledLayoutRequestId(null);

    if (projection.nodes.length === 0) {
      setLayoutStatus("READY");
      setSettledLayoutRequestId(requestId);
      return;
    }

    setLayoutStatus("LAYING_OUT");
    void requestLayout(projection).then(
      (laidOut) => {
        if (activeLayoutRequestRef.current !== requestId) return;
        setDisplayProjection(
          layoutRequest ? laidOut : applySavedPositions(laidOut, layoutPositionsRef.current),
        );
        setLayoutStatus("READY");
        setSettledLayoutRequestId(requestId);
      },
      () => {
        if (activeLayoutRequestRef.current !== requestId) return;
        setDisplayProjection(
          layoutRequest ? projection : applySavedPositions(projection, layoutPositionsRef.current),
        );
        setLayoutStatus("ERROR");
        setSettledLayoutRequestId(requestId);
      },
    );
  }, [graph.schemaHash, layoutGeneration, layoutRequest, projection, requestLayout]);

  useEffect(() => {
    if (
      layoutStatus === "LAYING_OUT" ||
      !settledLayoutRequestId ||
      !flowInstance ||
      projection.nodes.length === 0
    ) {
      return;
    }
    if (fittedLayoutRequestRef.current === settledLayoutRequestId) return;
    fittedLayoutRequestRef.current = settledLayoutRequestId;
    const animationFrame = requestAnimationFrame(() => {
      if (!layoutRequest && layoutViewport) {
        void Promise.resolve(flowInstance.setViewport(layoutViewport)).then(() => {
          onRenderedLayoutReady?.(
            projectionPositions(displayProjection),
            flowInstance.getViewport(),
          );
        });
        return;
      }
      void Promise.resolve(flowInstance.fitView({ padding: 0.15 })).then(() => {
        if (layoutRequest) {
          onLayoutRequestReady?.({
            requestId: layoutRequest.requestId,
            mode: layoutRequest.mode,
            succeeded: layoutStatus === "READY",
            positions: projectionPositions(displayProjection),
            viewport: flowInstance.getViewport(),
          });
        } else {
          onRenderedLayoutReady?.(
            projectionPositions(displayProjection),
            flowInstance.getViewport(),
          );
        }
      });
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [
    displayProjection,
    flowInstance,
    layoutRequest,
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
    const selectedNodes = displayProjection.nodes.filter((node) => selectedNodeIds.has(node.id));
    if (selectedNodes.length === 0) return;
    const animationFrame = requestAnimationFrame(() => {
      void flowInstance.fitView({ nodes: selectedNodes, padding: 0.45, duration: 250 });
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
    const selectedNodes = displayProjection.nodes.filter((node) => selectedNodeIds.has(node.id));
    if (selectedNodes.length === 0) return;
    focusedRequestRef.current = focusRequest.requestId;
    const animationFrame = requestAnimationFrame(() => {
      void flowInstance.fitView({ nodes: selectedNodes, padding: 0.35, duration: 250 });
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [displayProjection, flowInstance, focusRequest, layoutStatus, settledLayoutRequestId]);

  const activateElement = useCallback(
    (nextSelection: DiagramSelection) => {
      selectionStore.getState().setSelection(nextSelection);
      if (sourceNavigationEnabled) onNavigateSource(nextSelection);
    },
    [onNavigateSource, selectionStore, sourceNavigationEnabled],
  );
  const interactions = useMemo(
    () => ({ activateElement, toggleGroup: onToggleGroup }),
    [activateElement, onToggleGroup],
  );

  const selectedProjection = useMemo<DiagramProjection>(() => {
    const selectedElementKey = selection?.elementKey ?? null;
    return {
      ...displayProjection,
      nodes: displayProjection.nodes.map((node) => {
        if (node.type === "table") {
          const selected = selection?.tableKeys.includes(node.data.tableKey) ?? false;
          return {
            ...node,
            selected,
            data: {
              ...node.data,
              selectedElementKey: selected ? selectedElementKey : null,
            },
          } satisfies TableDiagramNode;
        }
        const selected =
          selection?.elementKey === node.data.groupKey ||
          (node.data.collapsed &&
            (selection?.tableKeys.some((tableKey) => node.data.tableKeys.includes(tableKey)) ??
              false));
        return {
          ...node,
          selected,
          data: {
            ...node.data,
            selectedElementKey: selected ? selectedElementKey : null,
          },
        } satisfies GroupDiagramNode;
      }),
      edges: displayProjection.edges.map((edge) => ({
        ...edge,
        selected:
          selectedElementKey !== null && edge.data.referenceKeys.includes(selectedElementKey),
      })),
    };
  }, [displayProjection, selection]);

  if (visibility.tableKeys.size === 0) {
    return (
      <div className="grid min-h-[32rem] place-items-center bg-slate-950 p-6 text-center">
        <div>
          <p className="font-semibold text-slate-100">
            {viewKey === GLOBAL_VIEW_KEY
              ? "No tables in this valid draft"
              : `No tables are visible in ${viewLabel}`}
          </p>
          <p className="mt-2 text-sm text-slate-400">
            {viewKey === GLOBAL_VIEW_KEY
              ? "Add a DBML table to render the read-only ER diagram."
              : "Update the DiagramView filters in DBML or switch to another view."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-[32rem] h-[min(68vh,52rem)] bg-slate-950">
      <p className="sr-only" aria-live="polite" data-testid="base-diagram-layout-status">
        {layoutStatus === "LAYING_OUT"
          ? "Laying out diagram"
          : layoutStatus === "READY"
            ? "Diagram layout ready"
            : "Diagram layout failed; fallback positions are shown"}
      </p>
      {layoutStatus === "ERROR" ? (
        <div
          className="absolute right-3 top-3 z-10 flex items-center gap-3 rounded-lg border border-amber-300/50 bg-amber-950/95 px-3 py-2 text-xs text-amber-100"
          role="alert"
        >
          <span>Automatic layout failed. Fallback positions are shown.</span>
          <button
            className="rounded border border-amber-200 px-2 py-1 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200"
            type="button"
            onClick={() => setLayoutGeneration((current) => current + 1)}
          >
            Retry layout
          </button>
        </div>
      ) : null}
      <DiagramInteractionContext.Provider value={interactions}>
        <ReactFlow<SchemaDiagramNode, SchemaDiagramEdge>
          aria-label="ER diagram canvas"
          nodes={selectedProjection.nodes}
          edges={selectedProjection.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onInit={setFlowInstance}
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
              (change) => change.type !== "add" && change.type !== "remove",
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
          <Controls showInteractive={false} />
        </ReactFlow>
      </DiagramInteractionContext.Provider>
    </div>
  );
}

function applySavedPositions(
  projection: DiagramProjection,
  positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>,
): DiagramProjection {
  return {
    ...projection,
    nodes: projection.nodes.map((node) => {
      const position = positions[node.id];
      return position ? { ...node, position: { ...position } } : node;
    }),
  };
}

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
