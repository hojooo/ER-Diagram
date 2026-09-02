import type { SchemaGraph } from "@er-diagram/core";
import { useId, useMemo, useState } from "react";

import { useUiLocale } from "../localization/ui-locale.js";
import { listDiagramViews } from "./projection.js";
import { searchDiagramVisibility } from "./search-index.js";
import type {
  DiagramLod,
  DiagramSearchResult,
  DiagramViewKey,
  DiagramVisibility,
} from "./types.js";

export function DiagramWorkspaceControls({
  layout = "OVERLAY",
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
  searchDisabled = disabled,
}: {
  readonly layout?: "OVERLAY" | "SIDEBAR";
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
  readonly searchDisabled?: boolean;
}) {
  const { messages } = useUiLocale();
  const sidebar = layout === "SIDEBAR";
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
    <div
      data-testid="diagram-workspace-controls"
      data-layout={sidebar ? "sidebar" : "overlay"}
      className={
        sidebar
          ? "grid w-full min-w-0 grid-cols-2 gap-3 bg-transparent px-4 py-3"
          : "grid w-full min-w-0 gap-3 border-b border-slate-700 bg-slate-900/95 px-4 py-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,0.7fr)_minmax(0,1.4fr)_minmax(0,0.6fr)_minmax(0,auto)] xl:items-end"
      }
    >
      <label
        className={`grid min-w-0 gap-1 text-xs font-semibold text-slate-300 ${sidebar ? "col-start-1 row-start-1" : ""}`}
      >
        {messages["diagram.view"]}
        <select
          className={`min-h-10 w-full min-w-0 max-w-full rounded-lg border border-slate-600 bg-slate-950 px-3 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300 ${sidebar ? "truncate" : ""}`}
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

      <div
        className={`relative grid min-w-0 gap-1 text-xs font-semibold text-slate-300 ${sidebar ? "col-span-2 row-start-2" : ""}`}
      >
        <label htmlFor={`${listboxId}-input`}>{messages["diagram.search"]}</label>
        <input
          id={`${listboxId}-input`}
          className="min-h-10 w-full min-w-0 max-w-full rounded-lg border border-slate-600 bg-slate-950 px-3 text-sm text-slate-100 placeholder:text-slate-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          type="search"
          role="combobox"
          autoComplete="off"
          placeholder={messages["diagram.searchPlaceholder"]}
          value={searchQuery}
          disabled={searchDisabled}
          aria-autocomplete="list"
          aria-expanded={showResults}
          aria-controls={showResults ? listboxId : undefined}
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
            className={`${sidebar ? "relative" : "absolute left-0 right-0 top-full z-30"} mt-1 max-h-80 overflow-auto rounded-lg border border-slate-600 bg-slate-950 p-1 shadow-2xl`}
            role="listbox"
            aria-label={messages["diagram.searchResults"]}
          >
            {search.results.length === 0 ? (
              <p className="px-3 py-2 text-sm font-normal text-slate-400">
                {messages["diagram.noMatches"]}
              </p>
            ) : (
              search.results.map((result, index) => (
                <button
                  id={optionId(listboxId, index)}
                  className={`block w-full rounded px-3 py-2 text-left text-sm font-normal text-slate-200 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-cyan-300 ${index === activeIndex ? "bg-slate-800" : ""}`}
                  type="button"
                  role="option"
                  aria-label={messages["diagram.resultAccessibleName"](
                    result.kind,
                    result.qualifiedLabel,
                    result.kind === "column" ? result.ownerLabel : null,
                  )}
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
                    <span className="ml-2 text-xs text-slate-400">
                      {messages["diagram.resultOwner"](result.ownerLabel)}
                    </span>
                  ) : null}
                </button>
              ))
            )}
            <p className="px-3 py-2 text-xs font-normal text-slate-400">
              {messages["diagram.showingMatches"](search.results.length, search.total)}
            </p>
          </div>
        ) : null}
        <p className="sr-only" aria-live="polite">
          {searchQuery.trim()
            ? messages["diagram.matchCount"](search.total)
            : messages["diagram.searchScope"]}
        </p>
      </div>

      <label
        className={`grid min-w-0 gap-1 text-xs font-semibold text-slate-300 ${sidebar ? "col-start-2 row-start-1" : ""}`}
      >
        {messages["diagram.detailLevel"]}
        <select
          className="min-h-10 w-full min-w-0 max-w-full rounded-lg border border-slate-600 bg-slate-950 px-3 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          value={detailLevel}
          disabled={disabled}
          onChange={(event) => onDetailLevelChange(event.target.value as DiagramLod)}
        >
          <option value="NAME_ONLY">{messages["diagram.names"]}</option>
          <option value="KEYS_ONLY">{messages["diagram.keys"]}</option>
          <option value="FULL">{messages["diagram.full"]}</option>
        </select>
      </label>

      <p
        className={`min-w-0 break-words pb-2 text-xs text-slate-400 ${sidebar ? "col-span-2 row-start-3" : "sm:col-span-2 xl:col-span-1"}`}
        aria-live="polite"
      >
        {messages["diagram.inventory"](
          visibility.tableKeys.size,
          visibility.groupKeys.size,
          visibility.referenceKeys.size,
        )}
      </p>
    </div>
  );
}

function optionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}
