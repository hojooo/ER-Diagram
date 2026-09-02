import { projectIdSchema } from "@er-diagram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import {
  ProjectSourceWorkspace,
  type ProjectWorkspaceAdapters,
} from "../source-editor/project-source-workspace.js";
import { ProjectApiError } from "./project-api.js";
import { useProjectApi } from "./project-api-context.js";
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
      <section className="grid h-full place-items-center bg-slate-950 p-5 text-slate-300">
        <h1 data-route-loading="true" className="font-semibold text-slate-100">
          Loading project
        </h1>
        <p className="mt-2" aria-live="polite">
          Loading project…
        </p>
      </section>
    );
  }
  if (projectQuery.isError) {
    const error = projectQuery.error instanceof ProjectApiError ? projectQuery.error : undefined;
    return (
      <section
        className="mx-auto mt-24 max-w-xl rounded-xl border border-red-400/40 bg-red-950/30 p-6"
        role="alert"
      >
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

  return (
    <section className="h-full min-h-0" aria-labelledby="workspace-heading">
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
    <section className="mx-auto mt-24 max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
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
