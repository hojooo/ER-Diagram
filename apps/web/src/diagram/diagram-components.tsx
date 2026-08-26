import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  type NodeProps,
  Position,
} from "@xyflow/react";
import { createContext, useContext } from "react";
import type { GroupDiagramNode, SchemaDiagramEdge, TableDiagramNode } from "./types.js";

export interface DiagramInteractions {
  toggleGroup(groupKey: string): void;
}

export const DiagramInteractionContext = createContext<DiagramInteractions>({
  toggleGroup: () => undefined,
});

export function GroupDiagramNodeComponent({ data }: NodeProps<GroupDiagramNode>) {
  const { toggleGroup } = useContext(DiagramInteractionContext);
  const action = data.collapsed ? "Expand" : "Collapse";
  return (
    <section className={`diagram-group ${data.collapsed ? "is-collapsed" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <header className="diagram-group__header">
        <div>
          <p className="diagram-kicker">TableGroup</p>
          <h2>{data.name}</h2>
        </div>
        <button
          className="nodrag nopan diagram-group__toggle"
          type="button"
          aria-label={`${action} ${data.name}`}
          onClick={() => toggleGroup(data.groupKey)}
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
}

export function TableDiagramNodeComponent({ data }: NodeProps<TableDiagramNode>) {
  const displayedColumns =
    data.lod === "FULL"
      ? data.columns
      : data.lod === "KEYS_ONLY"
        ? data.columns.filter((column) => column.primaryKey || column.foreignKey)
        : [];

  return (
    <article className="diagram-table">
      <Handle type="target" position={Position.Left} />
      <header className="diagram-table__header">
        <span>{data.schemaName}</span>
        <strong>{data.name}</strong>
      </header>
      {displayedColumns.length > 0 ? (
        <ul className="diagram-table__columns">
          {displayedColumns.map((column) => (
            <li key={column.key}>
              <span className="diagram-table__key">
                {column.primaryKey ? "PK" : column.foreignKey ? "FK" : ""}
              </span>
              <span>{column.name}</span>
              <code>{column.type}</code>
            </li>
          ))}
        </ul>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </article>
  );
}

export function ReferenceDiagramEdgeComponent(props: EdgeProps<SchemaDiagramEdge>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath(props);
  const count = props.data?.count ?? 1;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={edgePath}
        {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})}
        {...(props.style ? { style: props.style } : {})}
      />
      {count > 1 ? (
        <EdgeLabelRenderer>
          <span
            className="diagram-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            ×{count}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
