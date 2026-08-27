import type { ReferenceEdge, SchemaGraph, TableNode } from "@er-diagram/core";
import { useStore } from "zustand";
import { useEffect, useMemo, useRef } from "react";

import { createBaseDiagramProjection, formatMultiplicity } from "./projection.js";
import type { DiagramSelectionStore } from "./selection-store.js";
import type { DiagramSelection } from "./source-navigation.js";

export function SchemaOutline({
  graph,
  selectionStore,
  sourceNavigationEnabled,
  onNavigateSource,
}: {
  readonly graph: SchemaGraph;
  readonly selectionStore: DiagramSelectionStore;
  readonly sourceNavigationEnabled: boolean;
  readonly onNavigateSource: (selection: DiagramSelection) => void;
}) {
  const selection = useStore(selectionStore, (state) => state.selection);
  const projection = useMemo(() => createBaseDiagramProjection(graph), [graph]);
  const nodeByTableKey = useMemo(
    () =>
      new Map(
        projection.nodes.filter((node) => node.type === "table").map((node) => [node.id, node]),
      ),
    [projection.nodes],
  );
  const tableByKey = useMemo(
    () => new Map(graph.tables.map((table) => [table.key, table])),
    [graph.tables],
  );
  const selectedTableDetailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!selection) return;
    selectedTableDetailsRef.current?.setAttribute("open", "");
  }, [selection]);

  const activate = (nextSelection: DiagramSelection): void => {
    selectionStore.getState().setSelection(nextSelection);
  };
  const navigate = (nextSelection: DiagramSelection): void => {
    if (!sourceNavigationEnabled) return;
    selectionStore.getState().setSelection(nextSelection);
    onNavigateSource(nextSelection);
  };

  return (
    <section
      className="rounded-2xl border border-slate-800 bg-slate-900 p-5"
      aria-label="Schema outline"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-white">Schema outline</h2>
        <span className="text-xs text-slate-400">
          {graph.tables.length} tables · {graph.references.length} relationships
        </span>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Focus an element in the diagram or use its line action to open the canonical source.
      </p>

      <div className="mt-4 grid gap-5 xl:grid-cols-2">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Tables</h3>
          <ol className="mt-3 space-y-2">
            {graph.tables.map((table) => {
              const tableSelection = selectionForTable(table);
              const selectedTable = selection?.tableKeys.includes(table.key) ?? false;
              const projectedTable = nodeByTableKey.get(table.key);
              return (
                <li key={table.key}>
                  <details
                    ref={selectedTable ? selectedTableDetailsRef : undefined}
                    className="rounded-lg border border-slate-700 bg-slate-950/60 p-3"
                  >
                    <summary className="cursor-pointer text-sm font-semibold text-slate-100">
                      {qualifiedTableName(table)}
                      {selectedTable ? (
                        <span className="ml-2 text-xs text-cyan-300">Selected</span>
                      ) : null}
                    </summary>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <OutlineAction
                        label={`Focus ${qualifiedTableName(table)} in diagram`}
                        current={selection?.elementKey === table.key}
                        onClick={() => activate(tableSelection)}
                      >
                        Diagram
                      </OutlineAction>
                      <SourceLineAction
                        selection={tableSelection}
                        graph={graph}
                        enabled={sourceNavigationEnabled}
                        onClick={navigate}
                      />
                    </div>
                    <ol className="mt-3 space-y-1 border-l border-slate-700 pl-3">
                      {table.columns.map((column) => {
                        const columnSelection: DiagramSelection = {
                          elementKey: column.key,
                          kind: "column",
                          tableKeys: [table.key],
                        };
                        const traits = projectedTable?.data.columns.find(
                          (candidate) => candidate.key === column.key,
                        );
                        const labels = [
                          traits?.primaryKey ? "PK" : null,
                          traits?.foreignKey ? "FK" : null,
                          traits?.partialName ? `Partial ${traits.partialName}` : null,
                        ].filter((label): label is string => label !== null);
                        return (
                          <li
                            className="flex flex-wrap items-center gap-2 rounded px-2 py-1 text-xs text-slate-300"
                            key={column.key}
                          >
                            <OutlineAction
                              label={`Focus column ${column.name} in diagram`}
                              current={selection?.elementKey === column.key}
                              onClick={() => activate(columnSelection)}
                            >
                              {column.name}
                            </OutlineAction>
                            <code className="text-sky-300">{column.type.display}</code>
                            {labels.map((label) => (
                              <span className="font-bold text-amber-300" key={label}>
                                {label}
                              </span>
                            ))}
                            <SourceLineAction
                              selection={columnSelection}
                              graph={graph}
                              enabled={sourceNavigationEnabled}
                              onClick={navigate}
                            />
                          </li>
                        );
                      })}
                    </ol>
                  </details>
                </li>
              );
            })}
          </ol>
        </div>

        <div>
          <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
            Relationships
          </h3>
          {graph.references.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No relationships.</p>
          ) : (
            <ol className="mt-3 space-y-2">
              {graph.references.map((reference) => {
                const referenceSelection = selectionForReference(reference);
                return (
                  <li
                    className="rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-xs"
                    key={reference.key}
                  >
                    <p className="font-semibold text-slate-100">
                      {reference.name ?? "Anonymous reference"}
                      {reference.inactive ? (
                        <span className="ml-2 text-amber-300">Inactive</span>
                      ) : null}
                    </p>
                    <p className="mt-1 break-words text-slate-400">
                      {formatReference(reference, tableByKey)}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <OutlineAction
                        label={`Focus relationship ${reference.name ?? "anonymous reference"} in diagram`}
                        current={selection?.elementKey === reference.key}
                        onClick={() => activate(referenceSelection)}
                      >
                        Diagram
                      </OutlineAction>
                      <SourceLineAction
                        selection={referenceSelection}
                        graph={graph}
                        enabled={sourceNavigationEnabled}
                        onClick={navigate}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}

function OutlineAction({
  label,
  current,
  onClick,
  children,
}: {
  readonly label: string;
  readonly current: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button
      className="rounded border border-slate-600 px-2 py-1 font-semibold text-cyan-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
      type="button"
      aria-label={label}
      aria-current={current ? "true" : undefined}
      onClick={onClick}
    >
      {children}
      {current ? <span className="sr-only">, selected</span> : null}
    </button>
  );
}

function SourceLineAction({
  selection,
  graph,
  enabled,
  onClick,
}: {
  readonly selection: DiagramSelection;
  readonly graph: SchemaGraph;
  readonly enabled: boolean;
  readonly onClick: (selection: DiagramSelection) => void;
}) {
  const range = graph.sourceMap[selection.elementKey];
  return (
    <button
      className="rounded px-2 py-1 font-semibold text-slate-300 underline decoration-slate-500 underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:text-slate-600"
      type="button"
      aria-label={`Open source for ${selection.kind} at line ${range?.startLine ?? "unknown"}`}
      disabled={!enabled || !range}
      title={
        !enabled
          ? "Source navigation is unavailable while showing the last-valid diagram."
          : undefined
      }
      onClick={() => onClick(selection)}
    >
      Line {range?.startLine ?? "—"}
    </button>
  );
}

function selectionForTable(table: TableNode): DiagramSelection {
  return { elementKey: table.key, kind: "table", tableKeys: [table.key] };
}

function selectionForReference(reference: ReferenceEdge): DiagramSelection {
  return {
    elementKey: reference.key,
    kind: "reference",
    tableKeys: [...new Set(reference.endpoints.map((endpoint) => endpoint.tableKey))],
  };
}

function qualifiedTableName(table: TableNode): string {
  return `${table.schemaName}.${table.name}`;
}

function formatReference(
  reference: ReferenceEdge,
  tableByKey: ReadonlyMap<string, TableNode>,
): string {
  return reference.endpoints
    .map((endpoint) => {
      const table = tableByKey.get(endpoint.tableKey);
      const columns = endpoint.columnKeys.map(
        (columnKey) => table?.columns.find((column) => column.key === columnKey)?.name ?? columnKey,
      );
      return `${table ? qualifiedTableName(table) : endpoint.tableKey}.(${columns.join(", ")}) ${formatMultiplicity(endpoint)}`;
    })
    .join(" ↔ ");
}
