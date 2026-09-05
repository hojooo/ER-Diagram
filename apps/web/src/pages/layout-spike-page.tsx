import {
  Background,
  BackgroundVariant,
  type EdgeTypes,
  type NodeTypes,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { demoSchemaGraph } from "../diagram/demo-schema.js";
import {
  DiagramInteractionContext,
  GroupDiagramNodeComponent,
  ReferenceDiagramEdgeComponent,
  shouldShowDiagramEdgeLabels,
  TableDiagramNodeComponent,
} from "../diagram/diagram-components.js";
import { requestWorkerLayout } from "../diagram/layout-worker-client.js";
import { LanguageSelect, useUiLocale } from "../localization/ui-locale.js";
import {
  createDiagramProjection,
  GLOBAL_VIEW_KEY,
  listDiagramViews,
} from "../diagram/projection.js";
import type {
  DiagramLod,
  DiagramProjection,
  DiagramViewKey,
  SchemaDiagramEdge,
  SchemaDiagramNode,
} from "../diagram/types.js";

const nodeTypes = {
  group: GroupDiagramNodeComponent,
  table: TableDiagramNodeComponent,
} satisfies NodeTypes;

const edgeTypes = {
  reference: ReferenceDiagramEdgeComponent,
} satisfies EdgeTypes;

export function LayoutSpikePage() {
  const { messages } = useUiLocale();
  const [viewKey, setViewKey] = useState<DiagramViewKey>(GLOBAL_VIEW_KEY);
  const [lod, setLod] = useState<DiagramLod>("FULL");
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<ReadonlySet<string>>(new Set());
  const projection = useMemo(
    () => createDiagramProjection(demoSchemaGraph, { viewKey, collapsedGroupKeys, lod }),
    [collapsedGroupKeys, lod, viewKey],
  );
  const [displayProjection, setDisplayProjection] = useState<DiagramProjection>(projection);
  const [layoutStatus, setLayoutStatus] = useState<
    | { readonly status: "LAYING_OUT" | "READY" }
    | { readonly status: "FAILED"; readonly message: string | null }
  >({ status: "LAYING_OUT" });
  const [flowInstance, setFlowInstance] = useState<
    ReactFlowInstance<SchemaDiagramNode, SchemaDiagramEdge> | undefined
  >();
  const viewOptions = useMemo(() => listDiagramViews(demoSchemaGraph), []);

  useEffect(() => {
    let active = true;
    setDisplayProjection(projection);
    setLayoutStatus({ status: "LAYING_OUT" });
    requestWorkerLayout(projection)
      .then((laidOut) => {
        if (!active) return;
        setDisplayProjection(laidOut);
        setLayoutStatus({ status: "READY" });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : null;
        console.error("Diagram layout failed", error);
        setLayoutStatus({ status: "FAILED", message });
      });
    return () => {
      active = false;
    };
  }, [projection]);

  useEffect(() => {
    if (layoutStatus.status !== "READY" || !flowInstance) return;
    const animationFrame = requestAnimationFrame(() => {
      void flowInstance.fitView({ padding: 0.12 });
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [flowInstance, layoutStatus.status]);

  const interactions = useMemo(
    () => ({
      activateElement: () => undefined,
      editColumn: () => undefined,
      showEdgeLabels: shouldShowDiagramEdgeLabels(displayProjection.edges.length),
      toggleGroup: (groupKey: string) => {
        setCollapsedGroupKeys((current) => {
          const next = new Set(current);
          if (next.has(groupKey)) next.delete(groupKey);
          else next.add(groupKey);
          return next;
        });
      },
    }),
    [displayProjection.edges.length],
  );

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="app-eyebrow">{messages["spike.eyebrow"]}</p>
          <h1>DBML·SQL ERD Studio</h1>
          <p>{messages["spike.description"]}</p>
        </div>
        <LanguageSelect />
        <fieldset className="app-controls">
          <legend className="sr-only">{messages["spike.controls"]}</legend>
          <label>
            {messages["spike.view"]}
            <select value={viewKey} onChange={(event) => setViewKey(event.target.value)}>
              {viewOptions.map((view) => (
                <option key={view.key} value={view.key}>
                  {view.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {messages["spike.detail"]}
            <select value={lod} onChange={(event) => setLod(event.target.value as DiagramLod)}>
              <option value="NAME_ONLY">{messages["diagram.names"]}</option>
              <option value="KEYS_ONLY">{messages["diagram.keys"]}</option>
              <option value="FULL">{messages["diagram.full"]}</option>
            </select>
          </label>
          <output data-testid="layout-status" aria-live="polite">
            {layoutStatus.status === "LAYING_OUT"
              ? messages["spike.layingOut"]
              : layoutStatus.status === "READY"
                ? messages["spike.layoutReady"]
                : messages["spike.layoutFailed"](
                    ("message" in layoutStatus ? layoutStatus.message : null) ??
                      messages["spike.unknownLayoutError"],
                  )}
          </output>
        </fieldset>
      </header>
      <section
        className="canvas-shell"
        data-testid="erd-canvas"
        aria-label={messages["diagram.canvas"]}
      >
        <DiagramInteractionContext.Provider value={interactions}>
          <ReactFlow<SchemaDiagramNode, SchemaDiagramEdge>
            nodes={displayProjection.nodes}
            edges={displayProjection.edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={setFlowInstance}
            fitView
            minZoom={0.15}
            maxZoom={1.75}
            onlyRenderVisibleElements
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          </ReactFlow>
        </DiagramInteractionContext.Provider>
      </section>
    </main>
  );
}
