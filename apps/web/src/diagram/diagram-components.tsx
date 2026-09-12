import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  NodeResizeControl,
  type NodeProps,
  Position,
} from "@xyflow/react";
import { type CSSProperties, createContext, memo, useContext, useEffect, useRef } from "react";
import { useUiLocale } from "../localization/ui-locale.js";
import type {
  DiagramColumnEditRequest,
  DiagramTableEditRequest,
  DiagramTableInlineRenameState,
  DiagramTableResizeRequest,
} from "./base-schema-diagram-contract.js";
import { MINIMUM_TABLE_WIDTH, tableNodeMinimumHeight } from "./projection.js";
import type { DiagramSelection } from "./source-navigation.js";
import type { GroupDiagramNode, SchemaDiagramEdge, TableDiagramNode } from "./types.js";

export interface DiagramInteractions {
  toggleGroup(groupKey: string): void;
  activateElement(selection: DiagramSelection): void;
  editTable(request: DiagramTableEditRequest): void;
  editColumn(request: DiagramColumnEditRequest): void;
  tableInlineRename?: DiagramTableInlineRenameState | null;
  changeTableInlineRename?(value: string): void;
  submitTableInlineRename?(): void;
  cancelTableInlineRename?(): void;
  resizeTable?(request: DiagramTableResizeRequest): void;
  showEdgeLabels: boolean;
}

export const DiagramInteractionContext = createContext<DiagramInteractions>({
  toggleGroup: () => undefined,
  activateElement: () => undefined,
  editTable: () => undefined,
  editColumn: () => undefined,
  tableInlineRename: null,
  changeTableInlineRename: () => undefined,
  submitTableInlineRename: () => undefined,
  cancelTableInlineRename: () => undefined,
  resizeTable: () => undefined,
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
  const { messages } = useUiLocale();
  const action = data.collapsed ? messages["action.expand"] : messages["action.collapse"];
  const qualifiedName = `${data.schemaName}.${data.name}`;
  const safeColor = safeGroupColor(data.color);
  return (
    <section
      className={`diagram-group ${data.collapsed ? "is-collapsed" : ""} ${data.selectedElementKey ? "is-selected" : ""}`}
      aria-label={messages["diagram.groupAccessibleName"](
        qualifiedName,
        data.tableCount,
        data.collapsed ? messages["diagram.stateCollapsed"] : messages["diagram.stateExpanded"],
        data.color ?? messages["outline.defaultColor"],
      )}
      style={safeColor ? ({ "--diagram-group-color": safeColor } as CSSProperties) : undefined}
    >
      <Handle type="target" position={Position.Left} />
      <header className="diagram-group__header">
        <div>
          <p className="diagram-kicker">TableGroup</p>
          <p className="diagram-group__schema">{data.schemaName}</p>
          <h2>{data.name}</h2>
        </div>
        <button
          className="nodrag nopan diagram-group__toggle"
          type="button"
          aria-expanded={!data.collapsed}
          aria-label={messages["diagram.toggleGroup"](action, qualifiedName)}
          onClick={(event) => {
            event.stopPropagation();
            toggleGroup(data.groupKey);
          }}
        >
          {data.collapsed ? "+" : "−"}
        </button>
      </header>
      {data.collapsed ? (
        <p className="diagram-group__summary">
          {messages["diagram.tablesCollapsed"](data.tableCount)}
        </p>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </section>
  );
});

export const TableDiagramNodeComponent = memo(function TableDiagramNodeComponent({
  data,
}: NodeProps<TableDiagramNode>) {
  const {
    activateElement,
    cancelTableInlineRename,
    changeTableInlineRename,
    editColumn,
    editTable,
    resizeTable,
    submitTableInlineRename,
    tableInlineRename,
  } = useContext(DiagramInteractionContext);
  const { messages } = useUiLocale();
  const displayedColumns =
    data.lod === "FULL"
      ? data.columns
      : data.lod === "KEYS_ONLY"
        ? data.columns.filter((column) => column.primaryKey || column.foreignKey)
        : [];
  const activeTableRename =
    tableInlineRename?.tableKey === data.tableKey ? tableInlineRename : null;
  const resizeVisible = data.selectedElementKey === data.tableKey && activeTableRename === null;
  const minimumHeight = tableNodeMinimumHeight({ data });
  const commitResize = (
    _event: unknown,
    params: { x: number; y: number; width: number; height: number },
  ) => {
    resizeTable?.({
      tableKey: data.tableKey,
      x: Math.round(params.x),
      y: Math.round(params.y),
      width: Math.round(params.width),
      height: Math.round(params.height),
    });
  };

  return (
    <article
      className={`diagram-table ${data.selectedElementKey ? "is-selected" : ""} ${activeTableRename ? "is-inline-editing" : ""}`}
      aria-label={messages["diagram.tableAccessibleName"](`${data.schemaName}.${data.name}`)}
    >
      {resizeVisible ? (
        <>
          <NodeResizeControl
            position="right"
            resizeDirection="horizontal"
            minWidth={MINIMUM_TABLE_WIDTH}
            minHeight={minimumHeight}
            className="nodrag nopan nowheel diagram-table__resize-line diagram-table__resize-line--right"
            onResizeEnd={commitResize}
          />
          <NodeResizeControl
            position="bottom"
            resizeDirection="vertical"
            minWidth={MINIMUM_TABLE_WIDTH}
            minHeight={minimumHeight}
            className="nodrag nopan nowheel diagram-table__resize-line diagram-table__resize-line--bottom"
            onResizeEnd={commitResize}
          />
          <NodeResizeControl
            position="bottom-right"
            minWidth={MINIMUM_TABLE_WIDTH}
            minHeight={minimumHeight}
            className="nodrag nopan nowheel diagram-table__resize-handle"
            onResizeEnd={commitResize}
          >
            <span aria-hidden="true" />
          </NodeResizeControl>
        </>
      ) : null}
      <Handle type="target" position={Position.Left} />
      <header className="diagram-table__header">
        <span
          className={`diagram-table__drag-handle ${activeTableRename ? "nodrag nopan" : ""}`}
          aria-hidden="true"
        >
          ⋮⋮
        </span>
        {activeTableRename ? (
          <TableInlineRenameForm
            tableKey={data.tableKey}
            schemaName={data.schemaName}
            state={activeTableRename}
            onChange={(value) => changeTableInlineRename?.(value)}
            onSubmit={() => submitTableInlineRename?.()}
            onCancel={() => cancelTableInlineRename?.()}
          />
        ) : (
          <button
            className="nodrag nopan diagram-table__table-action"
            title={`${data.schemaName}.${data.name}`}
            type="button"
            tabIndex={-1}
            aria-label={messages["diagram.tableAccessibleName"](`${data.schemaName}.${data.name}`)}
            aria-pressed={data.selectedElementKey === data.tableKey}
            onClick={(event) => {
              event.stopPropagation();
              activateElement({
                elementKey: data.tableKey,
                kind: "table",
                tableKeys: [data.tableKey],
              });
            }}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const bounds = event.currentTarget.getBoundingClientRect();
              editTable({
                selection: {
                  elementKey: data.tableKey,
                  kind: "table",
                  tableKeys: [data.tableKey],
                },
                anchor: {
                  top: bounds.top,
                  right: bounds.right,
                  bottom: bounds.bottom,
                  left: bounds.left,
                },
              });
            }}
            data-diagram-table-key={data.tableKey}
          >
            <span>{data.schemaName}</span>
            <strong>{data.name}</strong>
          </button>
        )}
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
                  data-diagram-column-key={column.key}
                  title={`${column.name}, ${column.type}${badges.length > 0 ? `, ${badges.join(", ")}` : ""}`}
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
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    editColumn({
                      selection: {
                        elementKey: column.key,
                        kind: "column",
                        tableKeys: [data.tableKey],
                      },
                      anchor: {
                        top: bounds.top,
                        right: bounds.right,
                        bottom: bounds.bottom,
                        left: bounds.left,
                      },
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

function TableInlineRenameForm({
  tableKey,
  schemaName,
  state,
  onChange,
  onSubmit,
  onCancel,
}: {
  readonly tableKey: string;
  readonly schemaName: string;
  readonly state: DiagramTableInlineRenameState;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}) {
  const { messages } = useUiLocale();
  const inputRef = useRef<HTMLInputElement>(null);
  const statusId = `diagram-table-rename-status-${encodeURIComponent(tableKey)}`;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <form
      className="nodrag nopan nowheel diagram-table__rename-form"
      data-diagram-table-key={tableKey}
      aria-label={messages["visual.inlineTableRenameForm"](`${schemaName}.${state.value}`)}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (state.disabled || state.value.trim().length === 0) return;
        onSubmit();
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (!state.disabled) onCancel();
      }}
    >
      <span className="diagram-table__rename-schema" title={schemaName}>
        {schemaName}
      </span>
      <input
        ref={inputRef}
        className="diagram-table__rename-input"
        aria-label={messages["visual.inlineTableNameInput"]}
        aria-describedby={state.statusMessage ? statusId : undefined}
        aria-invalid={state.invalid || undefined}
        disabled={state.disabled}
        value={state.value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button
        className="diagram-table__rename-button"
        type="submit"
        aria-label={messages["visual.inlineTableRenameApply"]}
        title={messages["visual.inlineTableRenameApply"]}
        disabled={state.disabled || state.value.trim().length === 0}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
          <path d="m3.25 8.25 3 3 6.5-7" />
        </svg>
      </button>
      <button
        className="diagram-table__rename-button"
        type="button"
        aria-label={messages["visual.inlineTableRenameCancel"]}
        title={messages["visual.inlineTableRenameCancel"]}
        disabled={state.disabled}
        onClick={onCancel}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
          <path d="m4 4 8 8M12 4l-8 8" />
        </svg>
      </button>
      {state.statusMessage ? (
        <span id={statusId} className="sr-only" aria-live="polite">
          {state.statusMessage}
        </span>
      ) : null}
    </form>
  );
}

export const ReferenceDiagramEdgeComponent = memo(function ReferenceDiagramEdgeComponent(
  props: EdgeProps<SchemaDiagramEdge>,
) {
  const { showEdgeLabels } = useContext(DiagramInteractionContext);
  const { messages } = useUiLocale();
  const route = props.data?.route;
  if (!route) return null;
  const edgePath = route.path;
  const labelX = route.labelX;
  const labelY = route.labelY;
  const count = props.data?.count ?? 1;
  const label =
    count > 1
      ? messages["diagram.relationshipCount"](count)
      : [
          props.data?.referenceName ?? messages["diagram.ref"],
          props.data?.sourceMultiplicity && props.data?.targetMultiplicity
            ? `${props.data.sourceMultiplicity} → ${props.data.targetMultiplicity}`
            : null,
          props.data?.inactive ? messages["outline.inactive"] : null,
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
