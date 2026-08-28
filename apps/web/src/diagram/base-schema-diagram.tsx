import {
  Background,
  BackgroundVariant,
  Controls,
  type EdgeTypes,
  type NodeTypes,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useStore } from "zustand";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BaseSchemaDiagramProps } from "./base-schema-diagram-contract.js";
import {
  DiagramInteractionContext,
  ReferenceDiagramEdgeComponent,
  TableDiagramNodeComponent,
} from "./diagram-components.js";
import { requestWorkerLayout } from "./layout-worker-client.js";
import { createBaseDiagramProjection } from "./projection.js";
import type { DiagramSelection } from "./source-navigation.js";
import type {
  DiagramProjection,
  SchemaDiagramEdge,
  SchemaDiagramNode,
  TableDiagramNode,
} from "./types.js";

const nodeTypes = { table: TableDiagramNodeComponent } satisfies NodeTypes;
const edgeTypes = { reference: ReferenceDiagramEdgeComponent } satisfies EdgeTypes;

type LayoutStatus = "LAYING_OUT" | "READY" | "ERROR";

export function BaseSchemaDiagram({
  graph,
  selectionStore,
  sourceNavigationEnabled,
  onNavigateSource,
  requestLayout = requestWorkerLayout,
}: BaseSchemaDiagramProps) {
  const projection = useMemo(() => createBaseDiagramProjection(graph), [graph]);
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
  const activeLayoutRequestRef = useRef("");
  const fittedLayoutRequestRef = useRef<string | null>(null);

  useEffect(() => {
    requestGenerationRef.current += 1;
    const requestId = `${graph.schemaHash}:${layoutGeneration}:${requestGenerationRef.current}`;
    activeLayoutRequestRef.current = requestId;
    setDisplayProjection(projection);
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
        setDisplayProjection(laidOut);
        setLayoutStatus("READY");
        setSettledLayoutRequestId(requestId);
      },
      () => {
        if (activeLayoutRequestRef.current !== requestId) return;
        setDisplayProjection(projection);
        setLayoutStatus("ERROR");
        setSettledLayoutRequestId(requestId);
      },
    );
  }, [graph.schemaHash, layoutGeneration, projection, requestLayout]);

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
      void flowInstance.fitView({ padding: 0.15 });
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [flowInstance, layoutStatus, projection.nodes.length, settledLayoutRequestId]);

  useEffect(() => {
    if (!flowInstance || !selection || displayProjection.nodes.length === 0) return;
    const selectedNodes = displayProjection.nodes.filter(
      (node) => node.type === "table" && selection.tableKeys.includes(node.data.tableKey),
    );
    if (selectedNodes.length === 0) return;
    const animationFrame = requestAnimationFrame(() => {
      void flowInstance.fitView({ nodes: selectedNodes, padding: 0.45, duration: 250 });
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [displayProjection.nodes, flowInstance, selection]);

  const activateElement = useCallback(
    (nextSelection: DiagramSelection) => {
      selectionStore.getState().setSelection(nextSelection);
      if (sourceNavigationEnabled) onNavigateSource(nextSelection);
    },
    [onNavigateSource, selectionStore, sourceNavigationEnabled],
  );
  const interactions = useMemo(
    () => ({ activateElement, toggleGroup: () => undefined }),
    [activateElement],
  );

  const selectedProjection = useMemo<DiagramProjection>(() => {
    const selectedElementKey = selection?.elementKey ?? null;
    return {
      ...displayProjection,
      nodes: displayProjection.nodes.map((node) => {
        if (node.type !== "table") return node;
        const selected = selection?.tableKeys.includes(node.data.tableKey) ?? false;
        return {
          ...node,
          selected,
          data: {
            ...node.data,
            selectedElementKey: selected ? selectedElementKey : null,
          },
        } satisfies TableDiagramNode;
      }),
      edges: displayProjection.edges.map((edge) => ({
        ...edge,
        selected: edge.id === selectedElementKey,
      })),
    };
  }, [displayProjection, selection]);

  if (projection.nodes.length === 0) {
    return (
      <div className="grid min-h-[32rem] place-items-center bg-slate-950 p-6 text-center">
        <div>
          <p className="font-semibold text-slate-100">No tables in this valid draft</p>
          <p className="mt-2 text-sm text-slate-400">
            Add a DBML table to render the read-only ER diagram.
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
            if (node.type !== "table") return;
            activateElement({
              elementKey: node.data.tableKey,
              kind: "table",
              tableKeys: [node.data.tableKey],
            });
          }}
          onEdgeClick={(_event, edge) => {
            const referenceKey = edge.data.referenceKeys[0];
            if (!referenceKey) return;
            activateElement({
              elementKey: referenceKey,
              kind: "reference",
              tableKeys: [edge.source, edge.target],
            });
          }}
          onPaneClick={() => selectionStore.getState().setSelection(null)}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
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
