import type {
  ProjectState,
  SourceRange,
  SqlExportReportEntry,
  SqlExportResponse,
  SqlExportSourceSelection,
} from "@er-diagram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { forwardRef, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import type { UiMessages } from "../localization/messages.js";
import { useUiLocale } from "../localization/ui-locale.js";
import { ProjectApiError } from "../projects/project-api.js";
import { useProjectApi } from "../projects/project-api-context.js";
import { dialectLabel } from "../projects/project-home-page.js";
import { projectQueryKeys } from "../projects/project-queries.js";
import { WorkflowSteps } from "../workflow-steps.js";

const buttonPrimary = "ui-button ui-button--primary";
const buttonSecondary = "ui-button";

type ReportFilter = "ALL" | "NORMALIZED" | "PARTIAL" | "UNSUPPORTED" | "ERROR";

export interface SqlExportPageAdapters {
  readonly download: (file: DownloadFile) => void;
}

interface DownloadFile {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: string;
}

export function ProjectSqlExportPage({
  adapters = defaultAdapters,
}: {
  readonly adapters?: SqlExportPageAdapters;
}) {
  const api = useProjectApi();
  const { messages } = useUiLocale();
  const params = useParams();
  const projectId = params.projectId ?? "";
  const projectQuery = useQuery({
    queryKey: projectQueryKeys.detail(projectId),
    queryFn: () => api.getProject(projectId),
    enabled: projectId.length > 0,
  });

  if (projectQuery.isPending) {
    return (
      <section>
        <h1 data-route-loading="true" className="font-semibold text-slate-100">
          {messages["sqlExport.loading"]}
        </h1>
        <p className="mt-2" aria-live="polite">
          {messages["sqlExport.loadingMessage"]}
        </p>
      </section>
    );
  }
  if (projectQuery.isError) {
    return (
      <section role="alert" className="rounded-xl border border-red-400/40 bg-red-950/30 p-6">
        <h1 className="text-xl font-semibold text-red-100">
          {messages["sqlExport.openErrorTitle"]}
        </h1>
        <p className="mt-2 text-sm text-red-100/80">{messages["sqlExport.openErrorMessage"]}</p>
        <Link className={`${buttonSecondary} mt-4`} to={`/projects/${projectId}`}>
          {messages["workspace.back"]}
        </Link>
      </section>
    );
  }

  return (
    <SqlExportWorkflow
      key={`${projectQuery.data.state.project.id}:${projectQuery.data.state.project.schemaRevisionNo}`}
      state={projectQuery.data.state}
      adapters={adapters}
    />
  );
}

function SqlExportWorkflow({
  state,
  adapters,
}: {
  readonly state: ProjectState;
  readonly adapters: SqlExportPageAdapters;
}) {
  const api = useProjectApi();
  const queryClient = useQueryClient();
  const { messages } = useUiLocale();
  const [sourceSelection, setSourceSelection] = useState<SqlExportSourceSelection | null>(
    state.currentRevision.validity === "VALID" ? "CURRENT_DRAFT" : null,
  );
  const [result, setResult] = useState<SqlExportResponse>();
  const [filter, setFilter] = useState<ReportFilter>("ALL");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ProjectApiError | Error>();
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const selectedRevision =
    sourceSelection === "CURRENT_DRAFT" ? state.currentRevision : state.lastValidRevision;
  const entries = useMemo(
    () =>
      result?.report.entries.filter((entry) => filter === "ALL" || entry.status === filter) ?? [],
    [filter, result],
  );

  const runExport = async () => {
    if (!sourceSelection) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    setAcknowledged(false);
    try {
      const exported = await api.exportProjectSql({
        projectId: state.project.id,
        expectedSchemaRevisionNo: state.project.schemaRevisionNo,
        sourceSelection,
      });
      setResult(exported);
    } catch (cause) {
      const publicError =
        cause instanceof ProjectApiError ? cause : new Error(messages["sqlExport.failed"]);
      setError(publicError);
      if (publicError instanceof ProjectApiError && publicError.status === 409) {
        setResult(undefined);
        await queryClient.refetchQueries({ queryKey: projectQueryKeys.detail(state.project.id) });
      }
    } finally {
      setBusy(false);
    }
  };

  const downloadBase = result
    ? exportFilenameBase(state.project.name, result.revisionNo, state.project.primaryDialect)
    : "er-diagram";

  return (
    <section aria-labelledby="sql-export-heading" className="ui-document space-y-6">
      <div>
        <Link className={buttonSecondary} to={`/projects/${state.project.id}`}>
          {messages["workspace.back"]}
        </Link>
        <p className="mt-6 text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">
          {messages["sqlExport.dialectEyebrow"](dialectLabel(state.project.primaryDialect))}
        </p>
        <h1 id="sql-export-heading" className="mt-2 text-3xl font-semibold text-white">
          {messages["sqlExport.title"]}
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
          {messages["sqlExport.description"]}
        </p>
      </div>

      <WorkflowSteps
        steps={[
          messages["sqlExport.sourceRevision"],
          messages["sqlExport.result"],
          messages["sqlExport.downloads"],
        ]}
        current={
          !result
            ? 0
            : result.candidate && (!result.report.acknowledgementRequired || acknowledged)
              ? 2
              : 1
        }
      />

      <section className="ui-surface p-5">
        <h2 className="text-lg font-semibold text-white">{messages["sqlExport.sourceRevision"]}</h2>
        {state.currentRevision.validity === "VALID" ? (
          <p className="mt-3 text-sm text-slate-300">
            {messages["sqlExport.currentValid"](state.currentRevision.revisionNo)}
          </p>
        ) : state.lastValidRevision ? (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-amber-100">
              {messages["sqlExport.currentInvalid"](state.currentRevision.revisionNo)}
            </p>
            <label className="flex items-start gap-3 text-sm text-slate-200">
              <input
                className="mt-1"
                type="checkbox"
                checked={sourceSelection === "LAST_VALID"}
                onChange={(event) => {
                  setSourceSelection(event.target.checked ? "LAST_VALID" : null);
                  setResult(undefined);
                  setAcknowledged(false);
                }}
              />
              {messages["sqlExport.useLastValid"](state.lastValidRevision.revisionNo)}
            </label>
          </div>
        ) : (
          <p className="mt-3 text-sm text-amber-100">{messages["sqlExport.noValid"]}</p>
        )}
        <button
          className={`${buttonPrimary} mt-5`}
          type="button"
          disabled={busy || !sourceSelection}
          onClick={() => void runExport()}
        >
          {busy ? messages["sqlExport.generating"] : messages["sqlExport.generate"]}
        </button>
        <p className="mt-3 text-sm text-slate-400" aria-live="polite">
          {busy ? messages["sqlExport.reparsing"] : null}
          {result ? messages["sqlExport.reportReady"](result.report.overallStatus) : null}
        </p>
        {error ? (
          <div className="mt-4 rounded-lg border border-red-400/40 bg-red-950/30 p-4" role="alert">
            <p className="text-sm text-red-100">{exportErrorMessage(error, messages)}</p>
            {error instanceof ProjectApiError && error.correlationId ? (
              <p className="mt-2 text-xs text-red-100/70">
                {messages["error.correlationId"](error.correlationId)}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {result ? (
        <>
          <ExportSummary result={result} />
          <section className="ui-surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-white">
                {messages["sqlExport.conversionReport"]}
              </h2>
              <label className="text-sm text-slate-300">
                {messages["common.status"]}{" "}
                <select
                  className="ml-2 min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value as ReportFilter)}
                >
                  {(["ALL", "NORMALIZED", "PARTIAL", "UNSUPPORTED", "ERROR"] as const).map(
                    (status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ),
                  )}
                </select>
              </label>
            </div>
            {entries.length === 0 ? (
              <p className="mt-4 text-sm text-slate-400">
                {messages["sqlExport.noFilteredEntries"]}
              </p>
            ) : (
              <ol className="mt-4 space-y-3">
                {entries.map((entry) => (
                  <ReportEntry
                    key={entry.code}
                    entry={entry}
                    onNavigate={(range) => revealRange(sourceRef.current, range)}
                  />
                ))}
              </ol>
            )}
          </section>

          <div className="grid gap-5 xl:grid-cols-2">
            <SourcePanel ref={sourceRef} source={selectedRevision?.source ?? ""} />
            <SqlPanel sql={result.candidate?.sql ?? null} />
          </div>

          <section className="ui-surface p-5">
            <h2 className="text-lg font-semibold text-white">{messages["sqlExport.downloads"]}</h2>
            {result.report.acknowledgementRequired ? (
              <label className="mt-4 flex items-start gap-3 text-sm text-slate-200">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                {messages["sqlExport.acknowledgement"]}
              </label>
            ) : null}
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                className={buttonSecondary}
                type="button"
                onClick={() =>
                  adapters.download({
                    filename: `${downloadBase}.conversion-report.json`,
                    mimeType: "application/json;charset=utf-8",
                    content: reportDownloadJson(result),
                  })
                }
              >
                {messages["sqlExport.downloadReport"]}
              </button>
              {result.candidate ? (
                <button
                  className={buttonPrimary}
                  type="button"
                  disabled={result.report.acknowledgementRequired && !acknowledged}
                  onClick={() =>
                    adapters.download({
                      filename: `${downloadBase}.sql`,
                      mimeType: "application/sql;charset=utf-8",
                      content: result.candidate?.sql ?? "",
                    })
                  }
                >
                  {messages["sqlExport.downloadSql"]}
                </button>
              ) : (
                <p className="self-center text-sm text-red-200">
                  {messages["sqlExport.fatalBlocked"]}
                </p>
              )}
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}

function ExportSummary({ result }: { readonly result: SqlExportResponse }) {
  const { messages } = useUiLocale();
  return (
    <section className="ui-surface p-5">
      <h2 className="text-lg font-semibold text-white">{messages["sqlExport.result"]}</h2>
      <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-slate-400">{messages["common.revision"]}</dt>
          <dd className="mt-1 text-white">{result.revisionNo}</dd>
        </div>
        <div>
          <dt className="text-slate-400">{messages["common.status"]}</dt>
          <dd className="mt-1 text-white">{result.report.overallStatus}</dd>
        </div>
        <div>
          <dt className="text-slate-400">{messages["sqlExport.verification"]}</dt>
          <dd className="mt-1 text-white">{result.report.semanticVerification.status}</dd>
        </div>
        <div>
          <dt className="text-slate-400">{messages["sqlExport.ddlKind"]}</dt>
          <dd className="mt-1 text-white">{messages["sqlExport.emptySchemaCreate"]}</dd>
        </div>
      </dl>
    </section>
  );
}

function ReportEntry({
  entry,
  onNavigate,
}: {
  readonly entry: SqlExportReportEntry;
  readonly onNavigate: (range: SourceRange) => void;
}) {
  return (
    <li className="rounded-lg border border-slate-700 bg-slate-950/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold uppercase tracking-wide text-cyan-300">
          {entry.status}
        </span>
        <span className="text-xs text-slate-400">{entry.code}</span>
      </div>
      <p className="mt-2 text-sm text-slate-200">{entry.message}</p>
      {entry.occurrences.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {entry.occurrences.map((occurrence) => (
            <li
              key={`${occurrence.elementKind}:${occurrence.elementKey ?? "none"}:${occurrence.range?.filepath ?? "none"}:${occurrence.range?.startOffset ?? "none"}:${occurrence.range?.endOffset ?? "none"}`}
            >
              {occurrence.range ? (
                <button
                  className="rounded border border-slate-700 px-2 py-1 text-xs text-cyan-200"
                  type="button"
                  onClick={() => onNavigate(occurrence.range as SourceRange)}
                >
                  {occurrence.elementKind} · {occurrence.range.startLine}:
                  {occurrence.range.startColumn}
                </button>
              ) : (
                <span className="rounded border border-slate-800 px-2 py-1 text-xs text-slate-400">
                  {occurrence.elementKind}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const SourcePanel = forwardRef<HTMLTextAreaElement, { readonly source: string }>(
  function SourcePanel({ source }, ref) {
    const { messages } = useUiLocale();
    return (
      <section className="ui-surface p-5">
        <h2 className="text-lg font-semibold text-white">
          {messages["sqlExport.selectedRevision"]}
        </h2>
        <textarea
          ref={ref}
          aria-label={messages["sqlExport.selectedSource"]}
          className="mt-4 h-80 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-sm text-slate-200"
          readOnly
          value={source}
        />
      </section>
    );
  },
);

function SqlPanel({ sql }: { readonly sql: string | null }) {
  const { messages } = useUiLocale();
  return (
    <section className="ui-surface p-5">
      <h2 className="text-lg font-semibold text-white">{messages["sqlExport.generatedSql"]}</h2>
      {sql === null ? (
        <p className="mt-4 text-sm text-red-200">{messages["sqlExport.noCandidate"]}</p>
      ) : (
        <textarea
          aria-label={messages["sqlExport.generatedSql"]}
          className="mt-4 h-80 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-sm text-slate-200"
          readOnly
          value={sql}
        />
      )}
    </section>
  );
}

function revealRange(element: HTMLTextAreaElement | null, range: SourceRange): void {
  if (!element) return;
  const start = Math.min(Math.max(range.startOffset, 0), element.value.length);
  const end = Math.min(Math.max(range.endOffset, start), element.value.length);
  element.focus();
  element.setSelectionRange(start, end);
}

export function exportFilenameBase(
  projectName: string,
  revisionNo: number,
  dialect: "POSTGRESQL" | "MYSQL",
): string {
  const slug = projectName
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/[-_.]{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 80);
  return `${slug || "er-diagram"}-r${revisionNo}-${dialect.toLowerCase()}`;
}

function reportDownloadJson(result: SqlExportResponse): string {
  return `${JSON.stringify(
    {
      downloadVersion: 1,
      sourceSelection: result.sourceSelection,
      revisionNo: result.revisionNo,
      sourceHash: result.sourceHash,
      report: result.report,
    },
    null,
    2,
  )}\n`;
}

function downloadFile(file: DownloadFile): void {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportErrorMessage(error: Error, messages: UiMessages): string {
  if (error instanceof ProjectApiError && error.status === 409) {
    return messages["sqlExport.changedConflict"];
  }
  return error.message || messages["sqlExport.failed"];
}

const defaultAdapters: SqlExportPageAdapters = { download: downloadFile };
