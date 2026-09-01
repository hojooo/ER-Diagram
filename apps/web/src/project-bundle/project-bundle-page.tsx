import type { ProjectBundleReportMode, ProjectState } from "@er-diagram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { ProjectApiError, type ProjectBundleDownload } from "../projects/project-api.js";
import { useProjectApi } from "../projects/project-api-context.js";
import { projectQueryKeys } from "../projects/project-queries.js";
import { useRuntimeResourceLimits } from "../runtime-config.js";

const primaryButton =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-cyan-300 px-4 font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-700 px-4 font-semibold text-slate-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300 disabled:cursor-not-allowed disabled:opacity-50";

export interface ProjectBundlePageAdapters {
  readonly download: (file: ProjectBundleDownload) => void;
  readonly sha256: (content: Uint8Array<ArrayBuffer>) => Promise<string>;
}

export function ProjectBundleImportPage() {
  const api = useProjectApi();
  const limits = useRuntimeResourceLimits();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
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
        `This archive is ${selected.size} bytes and exceeds the ${limits.bundle.maxArchiveBytes} byte limit.`,
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
      setError(cause instanceof ProjectApiError ? cause : new Error("Bundle import failed."));
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
    <section aria-labelledby="bundle-import-heading" className="space-y-6">
      <div>
        <Link className={secondaryButton} to="/">
          Back to projects
        </Link>
        <p className="mt-6 text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">
          Portable recovery
        </p>
        <h1 id="bundle-import-heading" className="mt-2 text-3xl font-semibold text-white">
          Import project bundle
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
          A validated bundle always creates a new project. Existing projects are never replaced, and
          importing the same bundle again creates another independent copy with the same name.
        </p>
      </div>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <label className="block text-sm font-semibold text-slate-200" htmlFor="project-bundle-file">
          Portable bundle ZIP
        </label>
        <input
          id="project-bundle-file"
          className="mt-3 block min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-slate-200"
          type="file"
          accept=".zip,application/zip"
          disabled={busy}
          onChange={chooseFile}
        />
        {file ? (
          <p className="mt-3 text-sm text-slate-300">
            Selected {file.name} ({file.size} bytes). The file remains only in this page until you
            start the import.
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
          {busy ? "Validating and importing…" : "Import as new project"}
        </button>
        <p className="mt-3 text-sm text-slate-400" aria-live="polite">
          {busy ? "The archive, manifest, hashes and retained DBML are being verified." : null}
        </p>
        {error ? (
          <div className="mt-4 rounded-lg border border-red-400/40 bg-red-950/30 p-4" role="alert">
            <p className="text-sm text-red-100">
              The bundle was not confirmed as imported. The selected file has been preserved.
            </p>
            {error instanceof ProjectApiError && error.correlationId ? (
              <p className="mt-2 text-xs text-red-100/70">Correlation ID: {error.correlationId}</p>
            ) : null}
            <button
              className={`${secondaryButton} mt-4`}
              type="button"
              disabled={checking}
              onClick={() => void checkProjects()}
            >
              {checking ? "Refreshing projects…" : "Check project list"}
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
          Loading bundle export
        </h1>
        <p className="mt-2" aria-live="polite">
          Loading project for bundle export…
        </p>
      </section>
    );
  }
  if (projectQuery.isError) {
    return (
      <section role="alert" className="rounded-xl border border-red-400/40 bg-red-950/30 p-6">
        <h1 className="text-xl font-semibold text-red-100">Bundle export could not be opened</h1>
        <p className="mt-2 text-sm text-red-100/80">
          The current project state could not be loaded.
        </p>
        <Link className={`${secondaryButton} mt-4`} to={`/projects/${projectId}`}>
          Back to workspace
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
        throw new ProjectApiError("The downloaded bundle hash did not match the server evidence.", {
          status: null,
          code: "CLIENT_BUNDLE_HASH_MISMATCH",
        });
      }
      adapters.download({
        ...download,
        filename: portableBundleFilename(state.project.name),
      });
      setStatus(`Portable bundle downloaded: ${download.contentLength} bytes.`);
    } catch (cause) {
      const publicError =
        cause instanceof ProjectApiError ? cause : new Error("Bundle export failed.");
      setError(publicError);
      if (publicError instanceof ProjectApiError && publicError.status === 409) {
        await queryClient.refetchQueries({ queryKey: projectQueryKeys.detail(state.project.id) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="bundle-export-heading" className="space-y-6">
      <div>
        <Link className={secondaryButton} to={`/projects/${state.project.id}`}>
          Back to workspace
        </Link>
        <p className="mt-6 text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">
          Portable recovery
        </p>
        <h1 id="bundle-export-heading" className="mt-2 text-3xl font-semibold text-white">
          Export project bundle
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
          The bundle includes the current DBML, retained revision history and every saved view
          layout. Current revision {state.currentRevision.revisionNo} is{" "}
          {state.currentRevision.validity.toLowerCase()}
          {state.lastValidRevision
            ? `; last-valid revision ${state.lastValidRevision.revisionNo} is retained.`
            : "; there is no last-valid revision."}
        </p>
      </div>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <label className="block text-sm font-semibold text-slate-200" htmlFor="bundle-report-mode">
          SQL import reports
        </label>
        <select
          id="bundle-report-mode"
          className="mt-3 min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-slate-100"
          value={reportMode}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value as ProjectBundleReportMode;
            setReportMode(value);
            if (value !== "INCLUDE_RETAINED_SQL") setSensitiveConfirmed(false);
          }}
        >
          <option value="REDACTED">Redacted reports</option>
          <option value="INCLUDE_RETAINED_SQL">Include retained SQL</option>
          <option value="OMIT">Omit reports</option>
        </select>
        <p className="mt-3 text-sm text-slate-400">
          Redacted reports preserve conversion evidence but remove retained original SQL. The DBML
          schema source is always included because it is the portable project itself.
        </p>

        {reportMode === "INCLUDE_RETAINED_SQL" ? (
          <label className="mt-4 flex items-start gap-3 text-sm text-amber-100">
            <input
              className="mt-1"
              type="checkbox"
              checked={sensitiveConfirmed}
              onChange={(event) => setSensitiveConfirmed(event.target.checked)}
            />
            I understand that retained original SQL may contain sensitive literals and will be
            copied byte-for-byte into this ZIP alongside the DBML source.
          </label>
        ) : null}

        <button
          className={`${primaryButton} mt-5`}
          type="button"
          disabled={busy || !canExport}
          onClick={() => void exportBundle()}
        >
          {busy ? "Building portable bundle…" : "Download portable bundle"}
        </button>
        <p className="mt-3 text-sm text-slate-400" aria-live="polite">
          {busy ? "Project history, layouts, reports and hashes are being snapshotted." : status}
        </p>
        {error ? (
          <div className="mt-4 rounded-lg border border-red-400/40 bg-red-950/30 p-4" role="alert">
            <p className="text-sm text-red-100">The bundle was not downloaded.</p>
            {error instanceof ProjectApiError && error.correlationId ? (
              <p className="mt-2 text-xs text-red-100/70">Correlation ID: {error.correlationId}</p>
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
