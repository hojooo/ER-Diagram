import type { SchemaGraph } from "@er-diagram/core";
import { useId, useMemo, useState } from "react";

import { listDiagramViews } from "./projection.js";
import { searchDiagramVisibility } from "./search-index.js";
import type {
  DiagramLod,
  DiagramSearchResult,
  DiagramViewKey,
  DiagramVisibility,
} from "./types.js";

export function DiagramWorkspaceControls({
  graph,
  visibility,
  viewKey,
  detailLevel,
  searchQuery,
  onSearchQueryChange,
  onActivateSearchResult,
  onViewChange,
  onDetailLevelChange,
  disabled = false,
}: {
  readonly graph: SchemaGraph;
  readonly visibility: DiagramVisibility;
  readonly viewKey: DiagramViewKey;
  readonly detailLevel: DiagramLod;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onActivateSearchResult: (result: DiagramSearchResult) => void;
  readonly onViewChange: (viewKey: DiagramViewKey) => void;
  readonly onDetailLevelChange: (detailLevel: DiagramLod) => void;
  readonly disabled?: boolean;
}) {
  const listboxId = useId();
  const [activeIndex, setActiveIndex] = useState(-1);
  const [resultsOpen, setResultsOpen] = useState(false);
  const viewOptions = useMemo(() => listDiagramViews(graph), [graph]);
  const search = useMemo(
    () => searchDiagramVisibility(graph, visibility, searchQuery),
    [graph, searchQuery, visibility],
  );
  const showResults = resultsOpen && searchQuery.trim().length > 0;
  const activeResult =
    activeIndex >= 0 && activeIndex < search.results.length
      ? search.results[activeIndex]
      : undefined;

  const activateResult = (result: DiagramSearchResult): void => {
    onActivateSearchResult(result);
    setResultsOpen(false);
  };

  return (
    <div className="grid gap-3 border-b border-slate-700 bg-slate-900/95 px-4 py-3 lg:grid-cols-[minmax(10rem,0.7fr)_minmax(14rem,1.4fr)_minmax(9rem,0.6fr)_auto] lg:items-end">
      <label className="grid gap-1 text-xs font-semibold text-slate-300">
        Diagram view
        <select
          className="min-h-10 rounded-lg border border-slate-600 bg-slate-950 px-3 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          value={viewKey}
          disabled={disabled}
          onChange={(event) => {
            setActiveIndex(-1);
            onViewChange(event.target.value);
          }}
        >
          {viewOptions.map((view) => (
            <option key={view.key} value={view.key}>
              {view.label}
            </option>
          ))}
        </select>
      </label>

      <div className="relative grid gap-1 text-xs font-semibold text-slate-300">
        <label htmlFor={`${listboxId}-input`}>Search current view</label>
        <input
          id={`${listboxId}-input`}
          className="min-h-10 rounded-lg border border-slate-600 bg-slate-950 px-3 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          type="search"
          role="combobox"
          autoComplete="off"
          placeholder="Table, column, group, or schema"
          value={searchQuery}
          disabled={disabled}
          aria-autocomplete="list"
          aria-expanded={showResults}
          aria-controls={listboxId}
          aria-activedescendant={activeResult ? optionId(listboxId, activeIndex) : undefined}
          onFocus={() => {
            if (searchQuery.trim()) setResultsOpen(true);
          }}
          onChange={(event) => {
            setResultsOpen(true);
            setActiveIndex(-1);
            onSearchQueryChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setResultsOpen(false);
              setActiveIndex(-1);
              onSearchQueryChange("");
              return;
            }
            if (search.results.length === 0) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setResultsOpen(true);
              setActiveIndex((current) => (current + 1) % search.results.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setResultsOpen(true);
              setActiveIndex((current) => (current <= 0 ? search.results.length - 1 : current - 1));
              return;
            }
            if (event.key === "Enter" && activeResult) {
              event.preventDefault();
              activateResult(activeResult);
            }
          }}
        />

        {showResults ? (
          <div
            id={listboxId}
            className="absolute left-0 right-0 top-full z-30 mt-1 max-h-80 overflow-auto rounded-lg border border-slate-600 bg-slate-950 p-1 shadow-2xl"
            role="listbox"
            aria-label="Current view search results"
          >
            {search.results.length === 0 ? (
              <p className="px-3 py-2 text-sm font-normal text-slate-400">
                No matches in this view.
              </p>
            ) : (
              search.results.map((result, index) => (
                <button
                  id={optionId(listboxId, index)}
                  className={`block w-full rounded px-3 py-2 text-left text-sm font-normal text-slate-200 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-cyan-300 ${index === activeIndex ? "bg-slate-800" : ""}`}
                  type="button"
                  role="option"
                  aria-label={formatResultAccessibleName(result)}
                  aria-selected={index === activeIndex}
                  key={result.resultId}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => activateResult(result)}
                >
                  <span className="mr-2 text-[0.65rem] font-bold uppercase tracking-wide text-cyan-300">
                    {result.kind}
                  </span>
                  <span>{result.qualifiedLabel}</span>
                  {result.kind === "column" ? (
                    <span className="ml-2 text-xs text-slate-500">in {result.ownerLabel}</span>
                  ) : null}
                </button>
              ))
            )}
            <p className="px-3 py-2 text-xs font-normal text-slate-500">
              Showing {search.results.length} of {search.total} matches
            </p>
          </div>
        ) : null}
        <p className="sr-only" aria-live="polite">
          {searchQuery.trim()
            ? `${search.total} matches in the current diagram view`
            : "Search is limited to the current diagram view"}
        </p>
      </div>

      <label className="grid gap-1 text-xs font-semibold text-slate-300">
        Detail level
        <select
          className="min-h-10 rounded-lg border border-slate-600 bg-slate-950 px-3 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          value={detailLevel}
          disabled={disabled}
          onChange={(event) => onDetailLevelChange(event.target.value as DiagramLod)}
        >
          <option value="NAME_ONLY">Names</option>
          <option value="KEYS_ONLY">Keys</option>
          <option value="FULL">Full</option>
        </select>
      </label>

      <p className="pb-2 text-xs text-slate-400" aria-live="polite">
        {formatInventory(visibility)}
      </p>
    </div>
  );
}

function optionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

function formatInventory(visibility: DiagramVisibility): string {
  return `${visibility.tableKeys.size} ${plural(visibility.tableKeys.size, "table")} · ${visibility.groupKeys.size} ${plural(visibility.groupKeys.size, "group")} · ${visibility.referenceKeys.size} ${plural(visibility.referenceKeys.size, "relationship")}`;
}

function formatResultAccessibleName(result: DiagramSearchResult): string {
  return `${result.kind} ${result.qualifiedLabel}${result.kind === "column" ? ` in ${result.ownerLabel}` : ""}`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
