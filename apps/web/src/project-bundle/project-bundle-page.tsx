import type { ProjectBundleReportMode, ProjectState } from "@er-diagram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { useUiLocale } from "../localization/ui-locale.js";
import { ProjectApiError, type ProjectBundleDownload } from "../projects/project-api.js";
import { useProjectApi } from "../projects/project-api-context.js";
import { projectQueryKeys } from "../projects/project-queries.js";
import { useRuntimeResourceLimits } from "../runtime-config.js";

const primaryButton = "ui-button ui-button--primary";
const secondaryButton = "ui-button";

export interface ProjectBundlePageAdapters {
  readonly download: (file: ProjectBundleDownload) => void;
  readonly sha256: (content: Uint8Array<ArrayBuffer>) => Promise<string>;
}

export function ProjectBundleImportPage() {
  const api = useProjectApi();
  const limits = useRuntimeResourceLimits();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { formatNumber, messages } = useUiLocale();
  const [file, setFile] = useState<File>();
  const [fileError, setFileError] = useState<string>();
  const [error, setError] = useState<ProjectApiError | Error>();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    setFile(selected);
    setError(undefined);
    if (!selected) {
      setFileError(undefined);
      return;
    }
    if (selected.size > limits.bundle.maxArchiveBytes) {
      setFileError(
        messages["bundle.archiveTooLarge"](selected.size, limits.bundle.maxArchiveBytes),
      );
      return;
    }
    setFileError(undefined);
  };

  const importBundle = async () => {
    if (!file || fileError) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.importProjectBundle({ archive: file });
      queryClient.setQueryData(projectQueryKeys.detail(response.state.project.id), {
        state: response.state,
      });
      await queryClient.invalidateQueries({ queryKey: projectQueryKeys.list });
      await navigate(`/projects/${response.state.project.id}`);
    } catch (cause) {
      setError(
        cause instanceof ProjectApiError ? cause : new Error(messages["bundle.importFailed"]),
      );
    } finally {
      setBusy(false);
    }
  };

  const checkProjects = async () => {
    setChecking(true);
    await queryClient.invalidateQueries({ queryKey: projectQueryKeys.list });
    setChecking(false);
    await navigate("/");
  };

  return (
    <section aria-labelledby="bundle-import-heading" className="ui-document space-y-6">
      <div>
        <Link className={secondaryButton} to="/">
          {messages["route.backToProjects"]}
        </Link>
        <p className="mt-6 text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">
          {messages["bundle.portableRecovery"]}
        </p>
        <h1 id="bundle-import-heading" className="mt-2 text-3xl font-semibold text-white">
          {messages["bundle.importTitle"]}
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
          {messages["bundle.importDescription"]}
        </p>
      </div>

      <section className="ui-surface p-5">
        <label className="block text-sm font-semibold text-slate-200" htmlFor="project-bundle-file">
          {messages["bundle.zipLabel"]}
        </label>
        <input
          id="project-bundle-file"
          className="ui-input mt-3"
          type="file"
          accept=".zip,application/zip"
          disabled={busy}
          onChange={chooseFile}
        />
        {file ? (
          <p className="mt-3 text-sm text-slate-300">
            {messages["bundle.selectedFile"](file.name, formatNumber(file.size))}
          </p>
        ) : null}
        {fileError ? (
          <p className="mt-3 text-sm text-amber-100" role="alert">
            {fileError}
          </p>
        ) : null}
        <button
          className={`${primaryButton} mt-5`}
          type="button"
          disabled={!file || Boolean(fileError) || busy}
          onClick={() => void importBundle()}
        >
          {busy ? messages["bundle.importing"] : messages["bundle.importAsNew"]}
        </button>
        <p className="mt-3 text-sm text-slate-400" aria-live="polite">
          {busy ? messages["bundle.verifying"] : null}
        </p>
        {error ? (
          <div className="mt-4 rounded-lg border border-red-400/40 bg-red-950/30 p-4" role="alert">
            <p className="text-sm text-red-100">{messages["bundle.importUnknown"]}</p>
            {error instanceof ProjectApiError && error.correlationId ? (
              <p className="mt-2 text-xs text-red-100/70">
                {messages["error.correlationId"](error.correlationId)}
              </p>
            ) : null}
            <button
              className={`${secondaryButton} mt-4`}
              type="button"
              disabled={checking}
              onClick={() => void checkProjects()}
            >
              {checking ? messages["bundle.refreshingProjects"] : messages["bundle.checkProjects"]}
            </button>
          </div>
        ) : null}
      </section>
    </section>
  );
}

export function ProjectBundleExportPage({
  adapters = defaultAdapters,
}: {
  readonly adapters?: ProjectBundlePageAdapters;
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
          {messages["bundle.loadingExport"]}
        </h1>
        <p className="mt-2" aria-live="polite">
          {messages["bundle.loadingExportMessage"]}
        </p>
      </section>
    );
  }
  if (projectQuery.isError) {
    return (
      <section role="alert" className="rounded-xl border border-red-400/40 bg-red-950/30 p-6">
        <h1 className="text-xl font-semibold text-red-100">{messages["bundle.openErrorTitle"]}</h1>
        <p className="mt-2 text-sm text-red-100/80">{messages["bundle.openErrorMessage"]}</p>
        <Link className={`${secondaryButton} mt-4`} to={`/projects/${projectId}`}>
          {messages["workspace.back"]}
        </Link>
      </section>
    );
  }
  return <ProjectBundleExportWorkflow state={projectQuery.data.state} adapters={adapters} />;
}

function ProjectBundleExportWorkflow({
  state,
  adapters,
}: {
  readonly state: ProjectState;
  readonly adapters: ProjectBundlePageAdapters;
}) {
  const api = useProjectApi();
  const queryClient = useQueryClient();
  const { formatNumber, messages } = useUiLocale();
  const [reportMode, setReportMode] = useState<ProjectBundleReportMode>("REDACTED");
  const [sensitiveConfirmed, setSensitiveConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<ProjectApiError | Error>();
  const canExport = reportMode !== "INCLUDE_RETAINED_SQL" || sensitiveConfirmed;

  const exportBundle = async () => {
    if (!canExport) return;
    setBusy(true);
    setStatus(undefined);
    setError(undefined);
    try {
      const download = await api.exportProjectBundle({
        projectId: state.project.id,
        expectedSchemaRevisionNo: state.project.schemaRevisionNo,
        expectedLayoutRevisionNo: state.project.layoutRevisionNo,
        reportMode,
      });
      const calculated = await adapters.sha256(download.content);
      if (calculated !== download.sha256) {
        throw new ProjectApiError(messages["bundle.hashMismatch"], {
          status: null,
          code: "CLIENT_BUNDLE_HASH_MISMATCH",
        });
      }
      adapters.download({
        ...download,
        filename: portableBundleFilename(state.project.name),
      });
      setStatus(messages["bundle.downloaded"](formatNumber(download.contentLength)));
    } catch (cause) {
      const publicError =
        cause instanceof ProjectApiError ? cause : new Error(messages["bundle.exportFailed"]);
      setError(publicError);
      if (publicError instanceof ProjectApiError && publicError.status === 409) {
        await queryClient.refetchQueries({ queryKey: projectQueryKeys.detail(state.project.id) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="bundle-export-heading" className="ui-document space-y-6">
      <div>
        <Link className={secondaryButton} to={`/projects/${state.project.id}`}>
          {messages["workspace.back"]}
        </Link>
        <p className="mt-6 text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">
          {messages["bundle.portableRecovery"]}
        </p>
        <h1 id="bundle-export-heading" className="mt-2 text-3xl font-semibold text-white">
          {messages["bundle.exportTitle"]}
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
          {state.lastValidRevision
            ? messages["bundle.exportDescriptionWithLastValid"](
                state.currentRevision.revisionNo,
                state.currentRevision.validity === "VALID"
                  ? messages["projects.validityValid"]
                  : messages["projects.validityInvalid"],
                state.lastValidRevision.revisionNo,
              )
            : messages["bundle.exportDescriptionWithoutLastValid"](
                state.currentRevision.revisionNo,
                state.currentRevision.validity === "VALID"
                  ? messages["projects.validityValid"]
                  : messages["projects.validityInvalid"],
              )}
        </p>
      </div>

      <section className="ui-surface p-5">
        <label className="block text-sm font-semibold text-slate-200" htmlFor="bundle-report-mode">
          {messages["bundle.sqlReports"]}
        </label>
        <select
          id="bundle-report-mode"
          className="ui-input mt-3"
          value={reportMode}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value as ProjectBundleReportMode;
            setReportMode(value);
            if (value !== "INCLUDE_RETAINED_SQL") setSensitiveConfirmed(false);
          }}
        >
          <option value="REDACTED">{messages["bundle.redactedReports"]}</option>
          <option value="INCLUDE_RETAINED_SQL">{messages["bundle.includeSql"]}</option>
          <option value="OMIT">{messages["bundle.omitReports"]}</option>
        </select>
        <p className="mt-3 text-sm text-slate-400">{messages["bundle.redactionDescription"]}</p>

        {reportMode === "INCLUDE_RETAINED_SQL" ? (
          <label className="mt-4 flex items-start gap-3 text-sm text-amber-100">
            <input
              className="mt-1"
              type="checkbox"
              checked={sensitiveConfirmed}
              onChange={(event) => setSensitiveConfirmed(event.target.checked)}
            />
            {messages["bundle.sensitiveConfirmation"]}
          </label>
        ) : null}

        <button
          className={`${primaryButton} mt-5`}
          type="button"
          disabled={busy || !canExport}
          onClick={() => void exportBundle()}
        >
          {busy ? messages["bundle.building"] : messages["bundle.download"]}
        </button>
        <p className="mt-3 text-sm text-slate-400" aria-live="polite">
          {busy ? messages["bundle.snapshotting"] : status}
        </p>
        {error ? (
          <div className="mt-4 rounded-lg border border-red-400/40 bg-red-950/30 p-4" role="alert">
            <p className="text-sm text-red-100">{messages["bundle.downloadFailed"]}</p>
            {error instanceof ProjectApiError && error.correlationId ? (
              <p className="mt-2 text-xs text-red-100/70">
                {messages["error.correlationId"](error.correlationId)}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
    </section>
  );
}

export async function sha256BundleContent(content: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", content);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function portableBundleFilename(projectName: string): string {
  const stem = projectName
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return `${stem || "project"}.erdiagram.zip`;
}

const defaultAdapters: ProjectBundlePageAdapters = {
  sha256: sha256BundleContent,
  download(file) {
    const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  },
};
