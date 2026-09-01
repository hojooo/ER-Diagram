import { projectIdSchema } from "@er-diagram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import {
  ProjectSourceWorkspace,
  type ProjectWorkspaceAdapters,
} from "../source-editor/project-source-workspace.js";
import { ProjectApiError } from "./project-api.js";
import { useProjectApi } from "./project-api-context.js";
import { dialectLabel, ValidityBadge } from "./project-home-page.js";
import { projectQueryKeys } from "./project-queries.js";

export function ProjectWorkspacePage({
  adapters,
}: {
  readonly adapters?: ProjectWorkspaceAdapters;
}) {
  const api = useProjectApi();
  const queryClient = useQueryClient();
  const params = useParams();
  const parsedProjectId = projectIdSchema.safeParse(params.projectId);
  const projectId = parsedProjectId.success ? parsedProjectId.data : undefined;
  const projectQuery = useQuery({
    queryKey: projectQueryKeys.detail(projectId ?? "invalid-project-id"),
    queryFn: () => api.getProject(projectId ?? ""),
    enabled: projectId !== undefined,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
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
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Link
            className="inline-flex min-h-11 items-center rounded-lg border border-cyan-400/50 px-4 font-semibold text-cyan-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
            to={`/projects/${projectId}/sql-import`}
          >
            Import SQL
          </Link>
          <Link
            className="inline-flex min-h-11 items-center rounded-lg border border-cyan-400/50 px-4 font-semibold text-cyan-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
            to={`/projects/${projectId}/sql-export`}
          >
            Export SQL
          </Link>
          <Link
            className="inline-flex min-h-11 items-center rounded-lg border border-cyan-400/50 px-4 font-semibold text-cyan-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
            to={`/projects/${projectId}/bundle-export`}
          >
            Export bundle
          </Link>
          <ValidityBadge validity={currentRevision.validity} />
        </div>
      </div>

      <ProjectSourceWorkspace
        key={projectId}
        initialState={projectQuery.data.state}
        api={api}
        queryClient={queryClient}
        {...(adapters ? { adapters } : {})}
      />
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
