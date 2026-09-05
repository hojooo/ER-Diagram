import type {
  ConversionReport,
  OriginalSqlRetentionMode,
  PrimaryDialect,
  ProjectState,
  SourceRange,
  SqlClauseConversion,
  SqlImportDataPolicyDecision,
  SqlImportPreviewResponse,
  SqlImportStandalonePreviewResponse,
  SqlStatementConversion,
} from "@er-diagram/contracts";
import { type RuntimeResourceLimits, utf8ByteLength } from "@er-diagram/contracts";
import { diffSchemaGraphs, type SchemaElementChange, type SchemaGraph } from "@er-diagram/core";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router-dom";

import { useUiLocale } from "../localization/ui-locale.js";
import { ProjectApiError } from "../projects/project-api.js";
import { useProjectApi } from "../projects/project-api-context.js";
import { projectQueryKeys } from "../projects/project-queries.js";
import { useRuntimeResourceLimits } from "../runtime-config.js";
import { createDbmlParserWorkerClient } from "../source-editor/parser-worker-client.js";
import { WorkflowSteps } from "../workflow-steps.js";

const buttonPrimary = "ui-button ui-button--primary";
const buttonSecondary = "ui-button";
const inputClass = "ui-input";

type ImportMode = "NEW" | "REPLACE";
type ReportStatus = "EXACT" | "NORMALIZED" | "PARTIAL" | "UNSUPPORTED" | "ERROR";

interface NormalizedPreview {
  readonly previewHash: string;
  readonly originalSqlRetention: OriginalSqlRetentionMode;
  readonly report: ConversionReport;
  readonly policy: SqlImportDataPolicyDecision;
  readonly candidate: { readonly dbml: string; readonly dbmlHash: string } | null;
  readonly artifactId: string | null;
  readonly baseSchemaRevisionNo: number | null;
}

export interface SqlImportPageAdapters {
  readonly parseDbml: (source: string) => Promise<SchemaGraph>;
}

export function NewSqlImportPage({ adapters }: { readonly adapters?: SqlImportPageAdapters }) {
  const limits = useRuntimeResourceLimits();
  const effectiveAdapters = useMemo(
    () => adapters ?? createDefaultAdapters(limits),
    [adapters, limits],
  );
  return <SqlImportPage mode="NEW" adapters={effectiveAdapters} />;
}

export function ReplaceSqlImportPage({ adapters }: { readonly adapters?: SqlImportPageAdapters }) {
  const { messages } = useUiLocale();
  const limits = useRuntimeResourceLimits();
  const effectiveAdapters = useMemo(
    () => adapters ?? createDefaultAdapters(limits),
    [adapters, limits],
  );
  const api = useProjectApi();
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
          {messages["sqlImport.loading"]}
        </h1>
        <p className="mt-2" aria-live="polite">
          {messages["sqlImport.loadingMessage"]}
        </p>
      </section>
    );
  }
  if (projectQuery.isError) {
    return (
      <section role="alert" className="rounded-xl border border-red-400/40 bg-red-950/30 p-6">
        <h1 className="text-xl font-semibold text-red-100">
          {messages["sqlImport.openErrorTitle"]}
        </h1>
        <p className="mt-2 text-sm text-red-100/80">{messages["sqlImport.openErrorMessage"]}</p>
        <Link className={`${buttonSecondary} mt-4`} to={`/projects/${projectId}`}>
          {messages["workspace.back"]}
        </Link>
      </section>
    );
  }

  return (
    <SqlImportPage
      mode="REPLACE"
      projectState={projectQuery.data.state}
      adapters={effectiveAdapters}
    />
  );
}

function SqlImportPage({
  mode,
  projectState,
  adapters,
}: {
  readonly mode: ImportMode;
  readonly projectState?: ProjectState;
  readonly adapters: SqlImportPageAdapters;
}) {
  const api = useProjectApi();
  const { messages } = useUiLocale();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const runtimeLimits = useRuntimeResourceLimits();
  const [phase, setPhase] = useState<"EDIT" | "PREVIEW">("EDIT");
  const [name, setName] = useState("");
  const [dialect, setDialect] = useState<PrimaryDialect>(
    projectState?.project.primaryDialect ?? "POSTGRESQL",
  );
  const [source, setSource] = useState("");
  const [fileName, setFileName] = useState<string>();
  const [retention, setRetention] = useState<OriginalSqlRetentionMode>("DISCARD");
  const [preview, setPreview] = useState<NormalizedPreview>();
  const [lossAcknowledged, setLossAcknowledged] = useState(false);
  const [dataAcknowledged, setDataAcknowledged] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ReportStatus | "ALL">("ALL");
  const [busy, setBusy] = useState<"PREVIEW" | "APPLY" | null>(null);
  const [error, setError] = useState<unknown>();
  const [fileError, setFileError] = useState<string>();
  const [previewStale, setPreviewStale] = useState(false);
  const [diffState, setDiffState] = useState<
    | { readonly status: "LOADING" }
    | { readonly status: "READY"; readonly changes: readonly SchemaElementChange[] }
    | { readonly status: "UNAVAILABLE" }
  >({ status: "UNAVAILABLE" });
  const sqlRef = useRef<HTMLTextAreaElement>(null);
  const allowNavigationRef = useRef(false);
  const hasDraft = source.length > 0 || name.trim().length > 0 || phase === "PREVIEW";
  const blocker = useBlocker(() => hasDraft && !allowNavigationRef.current);

  useEffect(() => {
    if (!hasDraft) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [hasDraft]);

  useEffect(() => {
    if (!preview?.candidate) {
      setDiffState({ status: "UNAVAILABLE" });
      return;
    }
    const baseline = baselineSource(mode, projectState);
    if (baseline === null) {
      setDiffState({ status: "UNAVAILABLE" });
      return;
    }
    let cancelled = false;
    setDiffState({ status: "LOADING" });
    void Promise.all([
      adapters.parseDbml(baseline),
      adapters.parseDbml(preview.candidate.dbml),
    ]).then(
      ([before, after]) => {
        if (!cancelled) {
          setDiffState({ status: "READY", changes: diffSchemaGraphs(before, after).changes });
        }
      },
      () => {
        if (!cancelled) setDiffState({ status: "UNAVAILABLE" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapters, mode, preview?.candidate, projectState]);

  const reportItems = useMemo(() => flattenReport(preview?.report), [preview?.report]);
  const filteredItems = useMemo(
    () =>
      statusFilter === "ALL"
        ? reportItems
        : reportItems.filter((item) => item.status === statusFilter),
    [reportItems, statusFilter],
  );
  const hasLoss = reportItems.some(
    ({ status }) => status === "PARTIAL" || status === "UNSUPPORTED",
  );
  const hasData = (preview?.policy.dataStatementNos.length ?? 0) > 0;
  const replaceRevisionCurrent =
    mode === "NEW" ||
    (preview?.baseSchemaRevisionNo !== null &&
      preview?.baseSchemaRevisionNo === projectState?.project.schemaRevisionNo);
  const applyEnabled =
    preview?.candidate !== null &&
    preview?.candidate !== undefined &&
    preview.policy.applyReadiness !== "CONVERSION_FAILED" &&
    preview.policy.applyReadiness !== "NO_SCHEMA_ELEMENTS" &&
    (!hasLoss || lossAcknowledged) &&
    (!hasData || dataAcknowledged) &&
    replaceRevisionCurrent &&
    !previewStale &&
    busy === null;

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    setFileError(undefined);
    setFileName(undefined);
    if (!file) return;
    if (file.size > runtimeLimits.maxSourceBytes) {
      setFileError(messages["sqlImport.fileTooLarge"](runtimeLimits.maxSourceBytes));
      return;
    }
    try {
      const text = await file.text();
      if (utf8ByteLength(text) > runtimeLimits.maxSourceBytes) {
        setFileError(messages["sqlImport.fileTooLarge"](runtimeLimits.maxSourceBytes));
        return;
      }
      setSource(text);
      setFileName(file.name);
    } catch {
      setFileError(messages["sqlImport.fileReadError"]);
    }
  }

  async function handlePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    if (mode === "NEW" && name.trim().length === 0) {
      setError(new Error(messages["projects.enterName"]));
      return;
    }
    if (source.trim().length === 0) {
      setError(new Error(messages["sqlImport.enterSource"]));
      return;
    }
    if (utf8ByteLength(source) > runtimeLimits.maxSourceBytes) {
      setError(
        new ProjectApiError(messages["sqlImport.sourceTooLarge"](runtimeLimits.maxSourceBytes), {
          status: null,
          code: "RESOURCE_SOURCE_TOO_LARGE",
        }),
      );
      return;
    }
    setBusy("PREVIEW");
    try {
      const response =
        mode === "NEW"
          ? await api.previewStandaloneSqlImport({
              dialect,
              source,
              originalSqlRetention: retention,
            })
          : await api.previewProjectSqlImport({
              projectId: requireProjectState(projectState).project.id,
              expectedSchemaRevisionNo: requireProjectState(projectState).project.schemaRevisionNo,
              dialect: requireProjectState(projectState).project.primaryDialect,
              source,
              originalSqlRetention: retention,
            });
      setPreview(normalizePreview(response));
      setPhase("PREVIEW");
      setLossAcknowledged(false);
      setDataAcknowledged(false);
      setPreviewStale(false);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function handleApply() {
    if (!preview || !applyEnabled) return;
    setError(undefined);
    setBusy("APPLY");
    try {
      const dataStatementHandling = hasData ? ("CONFIRM_DDL_ONLY" as const) : undefined;
      const result =
        mode === "NEW"
          ? await api.createProjectFromSqlImport({
              name: name.trim(),
              primaryDialect: dialect,
              source,
              previewHash: preview.previewHash,
              originalSqlRetention: retention,
              ...(dataStatementHandling ? { dataStatementHandling } : {}),
            })
          : await api.applyProjectSqlImport({
              projectId: requireProjectState(projectState).project.id,
              expectedSchemaRevisionNo: requireProjectState(projectState).project.schemaRevisionNo,
              artifactId: requireArtifactId(preview),
              previewHash: preview.previewHash,
              source,
              ...(dataStatementHandling ? { dataStatementHandling } : {}),
            });
      queryClient.setQueryData(projectQueryKeys.detail(result.state.project.id), {
        state: result.state,
      });
      await queryClient.invalidateQueries({ queryKey: projectQueryKeys.list });
      allowNavigationRef.current = true;
      await navigate(`/projects/${result.state.project.id}`, { replace: true });
    } catch (cause) {
      if (cause instanceof ProjectApiError && cause.status === 409) {
        setPreviewStale(true);
        if (projectState) {
          await queryClient.invalidateQueries({
            queryKey: projectQueryKeys.detail(projectState.project.id),
          });
        }
      }
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  function cancelImport() {
    allowNavigationRef.current = true;
    setSource("");
    setName("");
    void navigate(
      mode === "NEW" ? "/" : `/projects/${requireProjectState(projectState).project.id}`,
    );
  }

  function revealRange(range: SourceRange) {
    const textarea = sqlRef.current;
    if (!textarea) return;
    const start = clamp(range.startOffset, 0, textarea.value.length);
    const end = clamp(range.endOffset, start, textarea.value.length);
    textarea.focus();
    textarea.setSelectionRange(start, end);
  }

  return (
    <section aria-labelledby="sql-import-heading" className="ui-document space-y-6">
      <div className="border-b border-slate-800 pb-6">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">
          {mode === "NEW" ? messages["sqlImport.newProject"] : messages["sqlImport.replaceProject"]}
        </p>
        <h1 id="sql-import-heading" className="mt-2 text-3xl font-semibold text-white">
          {phase === "EDIT" ? messages["sqlImport.title"] : messages["sqlImport.reviewTitle"]}
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
          {messages["sqlImport.description"]}
        </p>
      </div>

      <WorkflowSteps
        steps={[
          messages["sqlImport.source"],
          messages["sqlImport.preview"],
          messages["sqlImport.apply"],
        ]}
        current={busy === "APPLY" ? 2 : phase === "PREVIEW" ? 1 : 0}
      />

      {phase === "EDIT" ? (
        <form className="grid gap-5 ui-surface p-6" onSubmit={(event) => void handlePreview(event)}>
          {mode === "NEW" ? (
            <label className="grid gap-2 text-sm font-semibold text-slate-200">
              {messages["projects.name"]}
              <input
                className={inputClass}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
          ) : (
            <p className="text-sm text-slate-300">
              {messages["sqlImport.replacing"](
                projectState?.project.name ?? "",
                projectState?.project.schemaRevisionNo ?? 0,
              )}
            </p>
          )}
          <label className="grid gap-2 text-sm font-semibold text-slate-200">
            {messages["sqlImport.dialect"]}
            <select
              className={inputClass}
              value={dialect}
              disabled={mode === "REPLACE"}
              onChange={(event) => setDialect(event.currentTarget.value as PrimaryDialect)}
            >
              <option value="POSTGRESQL">PostgreSQL</option>
              <option value="MYSQL">MySQL</option>
            </select>
          </label>
          <label className="grid gap-2 text-sm font-semibold text-slate-200">
            {messages["sqlImport.source"]}
            <textarea
              ref={sqlRef}
              className={`${inputClass} min-h-72 resize-y py-3 font-mono text-sm`}
              value={source}
              onChange={(event) => setSource(event.currentTarget.value)}
              spellCheck={false}
            />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-slate-200">
            {messages["sqlImport.chooseFile"]}
            <input
              className={`${inputClass} py-2`}
              type="file"
              accept=".sql,text/plain"
              onChange={(event) => void handleFile(event)}
            />
            {fileName ? <span className="text-xs text-cyan-300">{fileName}</span> : null}
            {fileError ? <span className="text-xs text-red-200">{fileError}</span> : null}
          </label>
          <label className="grid gap-2 text-sm font-semibold text-slate-200">
            {messages["sqlImport.retention"]}
            <select
              className={inputClass}
              value={retention}
              onChange={(event) =>
                setRetention(event.currentTarget.value as OriginalSqlRetentionMode)
              }
            >
              <option value="DISCARD">{messages["sqlImport.discard"]}</option>
              <option value="RETAIN">{messages["sqlImport.retain"]}</option>
            </select>
            <span className="text-xs font-normal text-slate-400">
              {messages["sqlImport.retentionDescription"]}
            </span>
          </label>
          <PublicError error={error} />
          <div className="ui-actions">
            <button className={buttonSecondary} type="button" onClick={cancelImport}>
              {messages["sqlImport.cancel"]}
            </button>
            <button className={buttonPrimary} type="submit" disabled={busy !== null}>
              {busy === "PREVIEW"
                ? messages["sqlImport.generatingPreview"]
                : messages["sqlImport.preview"]}
            </button>
          </div>
        </form>
      ) : preview ? (
        <div className="space-y-6">
          <div className="grid gap-4 lg:grid-cols-2">
            <label className="grid gap-2 text-sm font-semibold text-slate-200">
              {messages["sqlImport.source"]}
              <textarea
                ref={sqlRef}
                className={`${inputClass} min-h-80 py-3 font-mono text-sm`}
                value={source}
                readOnly
                spellCheck={false}
              />
            </label>
            <label className="grid gap-2 text-sm font-semibold text-slate-200">
              {messages["sqlImport.generatedDbml"]}
              <textarea
                className={`${inputClass} min-h-80 py-3 font-mono text-sm`}
                value={preview.candidate?.dbml ?? messages["sqlImport.noCandidateDbml"]}
                readOnly
                spellCheck={false}
              />
            </label>
          </div>

          <ReportPanel
            report={preview.report}
            items={filteredItems}
            filter={statusFilter}
            onFilter={setStatusFilter}
            onSelect={revealRange}
          />
          <SemanticInventory state={diffState} />

          {hasLoss ? (
            <label className="flex items-start gap-3 rounded-xl border border-amber-400/40 bg-amber-950/20 p-4 text-sm text-amber-100">
              <input
                type="checkbox"
                checked={lossAcknowledged}
                onChange={(event) => setLossAcknowledged(event.currentTarget.checked)}
              />
              {messages["sqlImport.lossAcknowledgement"]}
            </label>
          ) : null}
          {hasData ? (
            <label className="flex items-start gap-3 rounded-xl border border-orange-400/40 bg-orange-950/20 p-4 text-sm text-orange-100">
              <input
                type="checkbox"
                checked={dataAcknowledged}
                onChange={(event) => setDataAcknowledged(event.currentTarget.checked)}
              />
              {messages["sqlImport.dataAcknowledgement"]}
            </label>
          ) : null}
          {previewStale || !replaceRevisionCurrent ? (
            <p
              role="alert"
              className="rounded-xl border border-amber-400/40 bg-amber-950/20 p-4 text-sm text-amber-100"
            >
              {messages["sqlImport.stale"]}
            </p>
          ) : null}
          <PublicError error={error} />
          <div className="ui-actions">
            <button className={buttonSecondary} type="button" onClick={cancelImport}>
              {messages["sqlImport.cancel"]}
            </button>
            <button
              className={buttonSecondary}
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setPhase("EDIT");
                setPreview(undefined);
                setError(undefined);
                setPreviewStale(false);
              }}
            >
              {messages["sqlImport.backToEdit"]}
            </button>
            <button
              className={buttonPrimary}
              type="button"
              disabled={!applyEnabled}
              onClick={() => void handleApply()}
            >
              {busy === "APPLY" ? messages["sqlImport.applying"] : messages["sqlImport.apply"]}
            </button>
          </div>
        </div>
      ) : null}

      <ImportDraftNavigationDialog blocker={blocker} />
    </section>
  );
}

function ReportPanel({
  report,
  items,
  filter,
  onFilter,
  onSelect,
}: {
  readonly report: ConversionReport;
  readonly items: readonly ReportItem[];
  readonly filter: ReportStatus | "ALL";
  readonly onFilter: (status: ReportStatus | "ALL") => void;
  readonly onSelect: (range: SourceRange) => void;
}) {
  const { messages } = useUiLocale();
  return (
    <section className="ui-surface p-5" aria-labelledby="conversion-report-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="conversion-report-heading" className="text-xl font-semibold text-white">
            {messages["sqlExport.conversionReport"]}
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            {messages["sqlImport.overallStatus"](report.overallStatus)}
          </p>
        </div>
        <label className="text-sm font-semibold text-slate-200">
          {messages["sqlImport.statusFilter"]}
          <select
            className={`${inputClass} ml-3 w-auto`}
            value={filter}
            onChange={(event) => onFilter(event.currentTarget.value as ReportStatus | "ALL")}
          >
            {(["ALL", "EXACT", "NORMALIZED", "PARTIAL", "UNSUPPORTED", "ERROR"] as const).map(
              (status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
      <ul className="mt-4 grid gap-2">
        {items.map((item) => (
          <li key={item.key}>
            <button
              className="w-full rounded-lg border border-slate-800 bg-slate-950 p-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-cyan-300"
              type="button"
              aria-label={`${item.code}: ${item.message}`}
              onClick={() => onSelect(item.range)}
            >
              <span className="font-semibold text-cyan-200">{item.status}</span>{" "}
              <span className="font-mono text-sm text-slate-300">{item.code}</span>
              <span className="ml-2 text-slate-400">
                {messages["sqlImport.range"](item.range.startLine, item.range.startColumn)}
              </span>
              <span className="mt-1 block text-slate-200">{item.message}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SemanticInventory({
  state,
}: {
  readonly state:
    | { readonly status: "LOADING" }
    | { readonly status: "READY"; readonly changes: readonly SchemaElementChange[] }
    | { readonly status: "UNAVAILABLE" };
}) {
  const { messages } = useUiLocale();
  if (state.status === "LOADING") {
    return <p aria-live="polite">{messages["sqlImport.inventoryLoading"]}</p>;
  }
  if (state.status === "UNAVAILABLE") {
    return <p>{messages["sqlImport.inventoryUnavailable"]}</p>;
  }
  const counts = state.changes.reduce<Record<string, number>>((result, change) => {
    const key = `${change.operation} ${change.elementKind}`;
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
  const visible = state.changes.slice(0, 200);
  return (
    <section className="ui-surface p-5" aria-labelledby="semantic-inventory-heading">
      <h2 id="semantic-inventory-heading" className="text-xl font-semibold text-white">
        {messages["sqlImport.inventoryTitle"]}
      </h2>
      <p className="mt-2 text-sm text-slate-300">
        {Object.entries(counts)
          .map(([key, count]) => `${key}: ${count}`)
          .join(" · ") || messages["sqlImport.noSemanticChanges"]}
      </p>
      <ol className="mt-3 grid gap-1 font-mono text-sm text-slate-400">
        {visible.map((change) => (
          <li key={`${change.operation}:${change.key}`}>
            {change.operation} {change.elementKind} {change.key}
          </li>
        ))}
      </ol>
      {state.changes.length > visible.length ? (
        <p className="mt-2 text-xs text-amber-200">
          {messages["sqlImport.showingChanges"](visible.length, state.changes.length)}
        </p>
      ) : null}
    </section>
  );
}

function ImportDraftNavigationDialog({
  blocker,
}: {
  readonly blocker: ReturnType<typeof useBlocker>;
}) {
  const { messages } = useUiLocale();
  const stayRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root
      open={blocker.state === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.state === "blocked") blocker.reset();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/80" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-700 bg-slate-900 p-6"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            stayRef.current?.focus();
          }}
        >
          <Dialog.Title className="text-xl font-semibold text-white">
            {messages["sqlImport.localDraftTitle"]}
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-6 text-slate-300">
            {messages["sqlImport.localDraftDescription"]}
          </Dialog.Description>
          <div className="mt-6 flex justify-end">
            <button
              ref={stayRef}
              className={buttonSecondary}
              type="button"
              onClick={() => {
                if (blocker.state === "blocked") blocker.reset();
              }}
            >
              {messages["action.stay"]}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PublicError({ error }: { readonly error: unknown }) {
  const { messages } = useUiLocale();
  if (!error) return null;
  const apiError = error instanceof ProjectApiError ? error : null;
  const message = error instanceof Error ? error.message : messages["sqlImport.unknownError"];
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-xl border border-red-400/40 bg-red-950/30 p-4 text-sm text-red-100"
    >
      <p>{message}</p>
      {apiError?.correlationId ? (
        <p className="mt-1 text-xs">{messages["error.correlationId"](apiError.correlationId)}</p>
      ) : null}
    </div>
  );
}

interface ReportItem {
  readonly key: string;
  readonly status: ReportStatus;
  readonly code: string;
  readonly message: string;
  readonly range: SourceRange;
}

function flattenReport(report: ConversionReport | undefined): readonly ReportItem[] {
  if (!report) return [];
  const items: ReportItem[] = [];
  for (const statement of report.statements) {
    items.push(toReportItem(statement, `statement:${statement.statementNo}`));
    for (const clause of statement.clauses) {
      items.push(
        toReportItem(clause, `statement:${statement.statementNo}:clause:${clause.clauseNo}`),
      );
    }
  }
  return items;
}

function toReportItem(item: SqlStatementConversion | SqlClauseConversion, key: string): ReportItem {
  return { key, status: item.status, code: item.code, message: item.message, range: item.range };
}

function normalizePreview(
  response: SqlImportStandalonePreviewResponse | SqlImportPreviewResponse,
): NormalizedPreview {
  if ("artifactStatus" in response) {
    return {
      previewHash: response.previewHash,
      originalSqlRetention: response.originalSqlRetention,
      report: response.report,
      policy: response.policy,
      candidate: response.candidate,
      artifactId: response.artifactId,
      baseSchemaRevisionNo: response.baseSchemaRevisionNo,
    };
  }
  return {
    previewHash: response.previewHash,
    originalSqlRetention: response.originalSqlRetention,
    report: response.report,
    policy: response.policy,
    candidate: response.candidate,
    artifactId: null,
    baseSchemaRevisionNo: null,
  };
}

function baselineSource(mode: ImportMode, state: ProjectState | undefined): string | null {
  if (mode === "NEW") return "";
  if (!state) return null;
  return state.currentRevision.validity === "VALID"
    ? state.currentRevision.source
    : (state.lastValidRevision?.source ?? null);
}

function requireProjectState(state: ProjectState | undefined): ProjectState {
  if (!state) throw new Error("Project state is required for replace import.");
  return state;
}

function requireArtifactId(preview: NormalizedPreview): string {
  if (!preview.artifactId) throw new Error("Replace import preview artifact is missing.");
  return preview.artifactId;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function createDefaultAdapters(limits: RuntimeResourceLimits): SqlImportPageAdapters {
  return {
    async parseDbml(source) {
      const client = createDbmlParserWorkerClient({
        timeoutMs: limits.dbmlParserTimeoutMs,
        limits: {
          maxSourceBytes: limits.maxSourceBytes,
          maxTables: limits.maxTables,
          maxReferences: limits.maxReferences,
          maxSchemaElements: limits.maxSchemaElements,
        },
      });
      try {
        const result = await client.parse(source);
        if (!result.ok) throw new Error("DBML diff input was invalid.");
        return result.graph;
      } finally {
        client.dispose();
      }
    },
  };
}
