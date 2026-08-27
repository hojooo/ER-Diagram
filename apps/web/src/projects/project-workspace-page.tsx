import { projectIdSchema } from "@er-diagram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { ProjectApiError } from "./project-api.js";
import { useProjectApi } from "./project-api-context.js";
import { diagnosticSummaryLabel, dialectLabel, ValidityBadge } from "./project-home-page.js";
import { projectQueryKeys } from "./project-queries.js";

export function ProjectWorkspacePage() {
  const api = useProjectApi();
  const params = useParams();
  const parsedProjectId = projectIdSchema.safeParse(params.projectId);
  const projectId = parsedProjectId.success ? parsedProjectId.data : undefined;
  const projectQuery = useQuery({
    queryKey: projectQueryKeys.detail(projectId ?? "invalid-project-id"),
    queryFn: () => api.getProject(projectId ?? ""),
    enabled: projectId !== undefined,
  });

  if (!projectId || isNotFound(projectQuery.error)) {
    return <ProjectNotFound />;
  }
  if (projectQuery.isPending) {
    return (
      <p
        className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-slate-300"
        aria-live="polite"
      >
        Loading project…
      </p>
    );
  }
  if (projectQuery.isError) {
    const error = projectQuery.error instanceof ProjectApiError ? projectQuery.error : undefined;
    return (
      <section className="rounded-xl border border-red-400/40 bg-red-950/30 p-6" role="alert">
        <h1 className="text-xl font-semibold text-red-100">Project could not be loaded</h1>
        <p className="mt-2 text-sm text-red-100/80">No project source was changed.</p>
        {error?.correlationId ? (
          <p className="mt-2 text-xs text-red-100/70">Correlation ID: {error.correlationId}</p>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            className="min-h-11 rounded-lg border border-red-200/50 px-4 font-semibold text-red-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red-300"
            type="button"
            onClick={() => void projectQuery.refetch()}
          >
            Try again
          </button>
          <BackToProjectsLink />
        </div>
      </section>
    );
  }

  const { project, currentRevision } = projectQuery.data.state;
  return (
    <section aria-labelledby="workspace-heading">
      <BackToProjectsLink />
      <div className="mt-6 flex flex-col gap-4 border-b border-slate-800 pb-7 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">
            {dialectLabel(project.primaryDialect)} project
          </p>
          <h1 id="workspace-heading" className="mt-2 text-3xl font-semibold text-white">
            {project.name}
          </h1>
          <p className="mt-3 text-sm text-slate-300">
            Revision {project.schemaRevisionNo} · Parser {project.parserVersion}
          </p>
        </div>
        <ValidityBadge validity={currentRevision.validity} />
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">
            Schema workspace
          </p>
          <h2 className="mt-3 text-xl font-semibold text-white">Source editor not available yet</h2>
          <p className="mt-3 max-w-2xl text-slate-300">
            This route is connected to the durable project state. Source editing and the
            project-derived diagram are not available in this build.
          </p>
        </section>
        <aside
          className="rounded-2xl border border-slate-800 bg-slate-900 p-6"
          aria-label="Project validation summary"
        >
          <h2 className="font-semibold text-white">Validation summary</h2>
          <p className="mt-3 text-sm text-slate-300">
            {diagnosticSummaryLabel(currentRevision.diagnosticSummary)}
          </p>
          <dl className="mt-5 grid gap-3 text-sm">
            <div>
              <dt className="text-slate-500">Current revision</dt>
              <dd className="mt-1 font-semibold text-slate-200">{currentRevision.revisionNo}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Last valid revision</dt>
              <dd className="mt-1 font-semibold text-slate-200">
                {projectQuery.data.state.lastValidRevision?.revisionNo ?? "None"}
              </dd>
            </div>
          </dl>
        </aside>
      </div>
    </section>
  );
}

function ProjectNotFound() {
  return (
    <section className="mx-auto max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
      <h1 className="text-2xl font-semibold text-white">Project not found</h1>
      <p className="mt-3 text-slate-300">
        The project may have been deleted or the link is invalid.
      </p>
      <BackToProjectsLink extraClass="mt-6" />
    </section>
  );
}

function BackToProjectsLink({ extraClass = "" }: { readonly extraClass?: string }) {
  return (
    <Link
      className={`inline-flex min-h-11 items-center rounded-lg border border-slate-700 px-4 font-semibold text-slate-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300 ${extraClass}`}
      to="/"
    >
      Back to projects
    </Link>
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof ProjectApiError && error.status === 404;
}
