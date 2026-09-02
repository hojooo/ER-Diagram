import type { ReferenceEdge, SchemaGraph, TableNode } from "@er-diagram/core";
import { memo, useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";

import { useUiLocale } from "../localization/ui-locale.js";
import { createBaseDiagramProjection, formatMultiplicity } from "./projection.js";
import type { DiagramSelectionStore } from "./selection-store.js";
import type { DiagramSelection } from "./source-navigation.js";
import type { DiagramVisibility } from "./types.js";

interface SchemaOutlineProps {
  readonly graph: SchemaGraph;
  readonly visibility: DiagramVisibility;
  readonly viewLabel: string;
  readonly collapsedGroupKeys: ReadonlySet<string>;
  readonly selectionStore: DiagramSelectionStore;
  readonly sourceNavigationEnabled: boolean;
  readonly onToggleGroup: (groupKey: string) => void;
  readonly onNavigateSource: (selection: DiagramSelection) => void;
}

const INITIAL_RELATIONSHIP_COUNT = 50;
const LARGE_OUTLINE_ELEMENT_COUNT = 200;
const LARGE_OUTLINE_STABILITY_DELAY_MS = 500;

export function SchemaOutline({ visibility, viewLabel, ...contentProps }: SchemaOutlineProps) {
  const { messages } = useUiLocale();
  const [renderedVisibility, setRenderedVisibility] = useState(visibility);
  const updating = renderedVisibility !== visibility;
  useEffect(() => {
    const large =
      visibility.tableKeys.size + visibility.referenceKeys.size > LARGE_OUTLINE_ELEMENT_COUNT;
    if (!large) {
      setRenderedVisibility(visibility);
      return;
    }
    const timer = window.setTimeout(
      () => setRenderedVisibility(visibility),
      LARGE_OUTLINE_STABILITY_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [visibility]);
  return (
    <section
      className="rounded-2xl border border-slate-800 bg-slate-900 p-5"
      aria-label={messages["outline.label"]}
      aria-busy={updating}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-white">{messages["outline.heading"](viewLabel)}</h2>
        <span className="text-xs text-slate-400">
          {messages["diagram.inventory"](
            visibility.tableKeys.size,
            visibility.groupKeys.size,
            visibility.referenceKeys.size,
          )}
        </span>
      </div>
      <p className="mt-2 text-xs text-slate-400">{messages["outline.description"]}</p>
      {updating ? (
        <p className="mt-3 text-xs text-slate-400" role="status">
          {messages["outline.updating"]}
        </p>
      ) : null}
      <div aria-hidden={updating || undefined} inert={updating || undefined}>
        <SchemaOutlineContent
          key={renderedVisibility.viewKey}
          {...contentProps}
          visibility={renderedVisibility}
        />
      </div>
    </section>
  );
}

const SchemaOutlineContent = memo(function SchemaOutlineContent({
  graph,
  visibility,
  collapsedGroupKeys,
  selectionStore,
  sourceNavigationEnabled,
  onToggleGroup,
  onNavigateSource,
}: Omit<SchemaOutlineProps, "viewLabel">) {
  const { messages } = useUiLocale();
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
  const visibleTables = useMemo(
    () => graph.tables.filter((table) => visibility.tableKeys.has(table.key)),
    [graph.tables, visibility.tableKeys],
  );
  const visibleGroups = useMemo(
    () => graph.groups.filter((group) => visibility.groupKeys.has(group.key)),
    [graph.groups, visibility.groupKeys],
  );
  const visibleReferences = useMemo(
    () => graph.references.filter((reference) => visibility.referenceKeys.has(reference.key)),
    [graph.references, visibility.referenceKeys],
  );
  const [showAllReferences, setShowAllReferences] = useState(false);
  const renderedReferences = showAllReferences
    ? visibleReferences
    : visibleReferences.slice(0, INITIAL_RELATIONSHIP_COUNT);
  const [openTableKeys, setOpenTableKeys] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!selection || selection.tableKeys.length === 0) return;
    setOpenTableKeys((current) => {
      const missingKeys = selection.tableKeys.filter((tableKey) => !current.has(tableKey));
      return missingKeys.length === 0 ? current : new Set([...current, ...missingKeys]);
    });
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
    <>
      {visibleGroups.length > 0 ? (
        <div className="mt-5">
          <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
            {messages["outline.tableGroups"]}
          </h3>
          <ol className="mt-3 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {visibleGroups.map((group) => {
              const groupSelection: DiagramSelection = {
                elementKey: group.key,
                kind: "group",
                tableKeys: [...group.tableKeys],
              };
              const collapsed = collapsedGroupKeys.has(group.key);
              const qualifiedName = `${group.schemaName}.${group.name}`;
              const visibleMemberKeys = group.tableKeys.filter((tableKey) =>
                visibility.tableKeys.has(tableKey),
              );
              const memberNames = visibleMemberKeys.map(
                (tableKey) => tableByKey.get(tableKey)?.name ?? tableKey,
              );
              return (
                <li
                  className="rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-xs"
                  key={group.key}
                >
                  <p className="font-semibold text-slate-100">{qualifiedName}</p>
                  <p className="mt-1 text-slate-400">
                    {messages["outline.groupSummary"](
                      visibleMemberKeys.length,
                      group.color ?? messages["outline.defaultColor"],
                      collapsed ? messages["outline.collapsed"] : messages["outline.expanded"],
                    )}
                  </p>
                  <p className="mt-2 break-words text-slate-300">
                    {memberNames.length > 0
                      ? memberNames.join(", ")
                      : messages["outline.noMembers"]}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <OutlineAction
                      label={messages["outline.focusGroup"](qualifiedName)}
                      current={selection?.elementKey === group.key}
                      onClick={() => activate(groupSelection)}
                    >
                      {messages["outline.diagram"]}
                    </OutlineAction>
                    <button
                      className="rounded border border-slate-600 px-2 py-1 font-semibold text-slate-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
                      type="button"
                      aria-expanded={!collapsed}
                      aria-label={messages["outline.toggleGroup"](
                        collapsed ? messages["action.expand"] : messages["action.collapse"],
                        qualifiedName,
                      )}
                      onClick={() => onToggleGroup(group.key)}
                    >
                      {collapsed ? messages["action.expand"] : messages["action.collapse"]}
                    </button>
                    <SourceLineAction
                      selection={groupSelection}
                      graph={graph}
                      enabled={sourceNavigationEnabled}
                      onClick={navigate}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      <div className="mt-4 grid gap-5 xl:grid-cols-2">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
            {messages["outline.tables"]}
          </h3>
          <ol className="mt-3 space-y-2">
            {visibleTables.map((table) => {
              const tableSelection = selectionForTable(table);
              const selectedTable = selection?.tableKeys.includes(table.key) ?? false;
              const tableOpen = selectedTable || openTableKeys.has(table.key);
              const projectedTable = nodeByTableKey.get(table.key);
              return (
                <li key={table.key}>
                  <details
                    open={tableOpen}
                    className="rounded-lg border border-slate-700 bg-slate-950/60 p-3"
                    onToggle={(event) => {
                      const open = event.currentTarget.open;
                      setOpenTableKeys((current) => {
                        if (open === current.has(table.key)) return current;
                        const next = new Set(current);
                        if (open) next.add(table.key);
                        else next.delete(table.key);
                        return next;
                      });
                    }}
                  >
                    <summary className="cursor-pointer text-sm font-semibold text-slate-100">
                      {qualifiedTableName(table)}
                      {selectedTable ? (
                        <span className="ml-2 text-xs text-cyan-300">
                          {messages["outline.selected"]}
                        </span>
                      ) : null}
                    </summary>
                    {tableOpen ? (
                      <>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <OutlineAction
                            label={messages["outline.focusTable"](qualifiedTableName(table))}
                            current={selection?.elementKey === table.key}
                            onClick={() => activate(tableSelection)}
                          >
                            {messages["outline.diagram"]}
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
                                  label={messages["outline.focusColumn"](column.name)}
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
                      </>
                    ) : null}
                  </details>
                </li>
              );
            })}
          </ol>
        </div>

        <div>
          <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">
            {messages["outline.relationships"]}
          </h3>
          {visibleReferences.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">{messages["outline.noRelationships"]}</p>
          ) : (
            <ol className="mt-3 space-y-2">
              {renderedReferences.map((reference) => {
                const referenceSelection = selectionForReference(reference);
                return (
                  <li
                    className="rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-xs"
                    key={reference.key}
                  >
                    <p className="font-semibold text-slate-100">
                      {reference.name ?? messages["outline.anonymousReference"]}
                      {reference.inactive ? (
                        <span className="ml-2 text-amber-300">{messages["outline.inactive"]}</span>
                      ) : null}
                    </p>
                    <p className="mt-1 break-words text-slate-400">
                      {formatReference(reference, tableByKey)}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <OutlineAction
                        label={messages["outline.focusRelationship"](
                          reference.name ?? messages["outline.anonymousReference"],
                        )}
                        current={selection?.elementKey === reference.key}
                        onClick={() => activate(referenceSelection)}
                      >
                        {messages["outline.diagram"]}
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
          {!showAllReferences && visibleReferences.length > INITIAL_RELATIONSHIP_COUNT ? (
            <button
              className="mt-3 min-h-10 rounded-lg border border-slate-600 px-3 text-sm font-semibold text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
              type="button"
              onClick={() => setShowAllReferences(true)}
            >
              {messages["outline.showAllRelationships"](visibleReferences.length)}
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
});

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
  const { messages } = useUiLocale();
  return (
    <button
      className="rounded border border-slate-600 px-2 py-1 font-semibold text-cyan-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
      type="button"
      aria-label={label}
      aria-current={current ? "true" : undefined}
      onClick={onClick}
    >
      {children}
      {current ? <span className="sr-only">{messages["outline.selectedSuffix"]}</span> : null}
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
  const { messages } = useUiLocale();
  const range = graph.sourceMap[selection.elementKey];
  return (
    <button
      className="rounded px-2 py-1 font-semibold text-slate-300 underline decoration-slate-500 underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:text-slate-600"
      type="button"
      aria-label={messages["outline.openSource"](
        selection.kind,
        String(range?.startLine ?? "unknown"),
      )}
      disabled={!enabled || !range}
      title={!enabled ? messages["outline.sourceUnavailable"] : undefined}
      onClick={() => onClick(selection)}
    >
      {messages["outline.line"](String(range?.startLine ?? "—"))}
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
