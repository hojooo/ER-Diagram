import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  getStraightPath,
  Handle,
  type NodeProps,
  Position,
} from "@xyflow/react";
import { type CSSProperties, createContext, memo, useContext } from "react";
import type { DiagramSelection } from "./source-navigation.js";
import type { GroupDiagramNode, SchemaDiagramEdge, TableDiagramNode } from "./types.js";

export interface DiagramInteractions {
  toggleGroup(groupKey: string): void;
  activateElement(selection: DiagramSelection): void;
  showEdgeLabels: boolean;
}

export const DiagramInteractionContext = createContext<DiagramInteractions>({
  toggleGroup: () => undefined,
  activateElement: () => undefined,
  showEdgeLabels: true,
});

const DIAGRAM_EDGE_LABEL_RENDER_LIMIT = 100;

export function shouldShowDiagramEdgeLabels(edgeCount: number): boolean {
  return edgeCount <= DIAGRAM_EDGE_LABEL_RENDER_LIMIT;
}

export const GroupDiagramNodeComponent = memo(function GroupDiagramNodeComponent({
  data,
}: NodeProps<GroupDiagramNode>) {
  const { toggleGroup } = useContext(DiagramInteractionContext);
  const action = data.collapsed ? "Expand" : "Collapse";
  const qualifiedName = `${data.schemaName}.${data.name}`;
  const safeColor = safeGroupColor(data.color);
  return (
    <section
      className={`diagram-group ${data.collapsed ? "is-collapsed" : ""} ${data.selectedElementKey ? "is-selected" : ""}`}
      aria-label={`Table group ${qualifiedName}, ${data.tableCount} tables, ${data.collapsed ? "collapsed" : "expanded"}, Color ${data.color ?? "default"}`}
      style={safeColor ? ({ "--diagram-group-color": safeColor } as CSSProperties) : undefined}
    >
      <Handle type="target" position={Position.Left} />
      <header className="diagram-group__header">
        <div>
          <p className="diagram-kicker">TableGroup</p>
          <p className="diagram-group__schema">{data.schemaName}</p>
          <h2>{data.name}</h2>
          <p className="diagram-group__color">Color {data.color ?? "default"}</p>
        </div>
        <button
          className="nodrag nopan diagram-group__toggle"
          type="button"
          aria-expanded={!data.collapsed}
          aria-label={`${action} ${qualifiedName}`}
          onClick={(event) => {
            event.stopPropagation();
            toggleGroup(data.groupKey);
          }}
        >
          {data.collapsed ? "+" : "−"}
        </button>
      </header>
      {data.collapsed ? (
        <p className="diagram-group__summary">{data.tableCount} tables collapsed</p>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </section>
  );
});

export const TableDiagramNodeComponent = memo(function TableDiagramNodeComponent({
  data,
}: NodeProps<TableDiagramNode>) {
  const { activateElement } = useContext(DiagramInteractionContext);
  const displayedColumns =
    data.lod === "FULL"
      ? data.columns
      : data.lod === "KEYS_ONLY"
        ? data.columns.filter((column) => column.primaryKey || column.foreignKey)
        : [];

  return (
    <article
      className={`diagram-table ${data.selectedElementKey ? "is-selected" : ""}`}
      aria-label={`Table ${data.schemaName}.${data.name}`}
    >
      <Handle type="target" position={Position.Left} />
      <header className="diagram-table__header">
        <span className="diagram-table__drag-handle" aria-hidden="true">
          ⋮⋮
        </span>
        <button
          className="nodrag nopan diagram-table__table-action"
          type="button"
          tabIndex={-1}
          aria-pressed={data.selectedElementKey === data.tableKey}
          onClick={(event) => {
            event.stopPropagation();
            activateElement({
              elementKey: data.tableKey,
              kind: "table",
              tableKeys: [data.tableKey],
            });
          }}
        >
          <span>{data.schemaName}</span>
          <strong>{data.name}</strong>
        </button>
      </header>
      {displayedColumns.length > 0 ? (
        <ul className="diagram-table__columns">
          {displayedColumns.map((column) => {
            const badges = [
              column.primaryKey ? "PK" : null,
              column.foreignKey ? "FK" : null,
              column.partialName ? `Partial ${column.partialName}` : null,
            ].filter((badge): badge is string => badge !== null);
            return (
              <li key={column.key}>
                <button
                  className="nodrag nopan diagram-table__column-action"
                  type="button"
                  tabIndex={-1}
                  aria-pressed={data.selectedElementKey === column.key}
                  aria-label={`${column.name}, ${column.type}${badges.length > 0 ? `, ${badges.join(", ")}` : ""}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    activateElement({
                      elementKey: column.key,
                      kind: "column",
                      tableKeys: [data.tableKey],
                    });
                  }}
                >
                  <span className="diagram-table__key">{badges.join(" · ")}</span>
                  <span>{column.name}</span>
                  <code>{column.type}</code>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </article>
  );
});

export const ReferenceDiagramEdgeComponent = memo(function ReferenceDiagramEdgeComponent(
  props: EdgeProps<SchemaDiagramEdge>,
) {
  const { showEdgeLabels } = useContext(DiagramInteractionContext);
  // Dense overview projections keep every relationship visible, but avoid calculating hundreds
  // of orthogonal routes that cannot be distinguished at the fitted overview zoom. Focused views
  // retain the labeled smooth-step route.
  const [edgePath, labelX, labelY] = showEdgeLabels
    ? getSmoothStepPath(props)
    : getStraightPath(props);
  const count = props.data?.count ?? 1;
  const label =
    count > 1
      ? `×${count} relationships`
      : [
          props.data?.referenceName ?? "Ref",
          props.data?.sourceMultiplicity && props.data?.targetMultiplicity
            ? `${props.data.sourceMultiplicity} → ${props.data.targetMultiplicity}`
            : null,
          props.data?.inactive ? "Inactive" : null,
        ]
          .filter((part): part is string => part !== null)
          .join(" · ");
  return (
    <>
      <BaseEdge
        id={props.id}
        path={edgePath}
        {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})}
        {...(props.style ? { style: props.style } : {})}
      />
      {label && showEdgeLabels ? (
        <EdgeLabelRenderer>
          <span
            className="diagram-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

function safeGroupColor(color: string | null): string | null {
  return color && /^#[\da-f]{6}$/i.test(color) ? color : null;
}
