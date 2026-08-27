import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import {
  isRouteErrorResponse,
  Link,
  Outlet,
  type RouteObject,
  RouterProvider,
  useRouteError,
} from "react-router-dom";

import type { ProjectApi } from "./projects/project-api.js";
import { ProjectApiProvider } from "./projects/project-api-context.js";
import { ProjectHomePage } from "./projects/project-home-page.js";
import { ProjectWorkspacePage } from "./projects/project-workspace-page.js";
import { RootErrorBoundary } from "./root-error-boundary.js";

type DataRouter = ComponentProps<typeof RouterProvider>["router"];

export interface AppProps {
  readonly api: ProjectApi;
  readonly queryClient: QueryClient;
  readonly router: DataRouter;
}

export function App({ api, queryClient, router }: AppProps) {
  return (
    <RootErrorBoundary>
      <ProjectApiProvider api={api}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ProjectApiProvider>
    </RootErrorBoundary>
  );
}

export function createAppRoutes(
  options: { readonly includeLayoutSpike?: boolean } = {},
): RouteObject[] {
  const routes: RouteObject[] = [
    {
      element: <AppShell />,
      errorElement: <RouteErrorPage />,
      HydrateFallback: RouteLoadingPage,
      children: [
        { index: true, element: <ProjectHomePage /> },
        { path: "projects/:projectId", element: <ProjectWorkspacePage /> },
        { path: "*", element: <NotFoundPage /> },
      ],
    },
  ];

  if (options.includeLayoutSpike) {
    routes.push({
      path: "/__spikes/layout",
      lazy: async () => {
        const module = await import("./pages/layout-spike-page.js");
        return { Component: module.LayoutSpikePage };
      },
      errorElement: <RouteErrorPage />,
      HydrateFallback: RouteLoadingPage,
    });
  }

  return routes;
}

function AppShell() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-950/95">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-5 py-4 sm:px-8">
          <div>
            <Link
              className="text-lg font-semibold tracking-tight text-white no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
              to="/"
            >
              DBML·SQL ERD Studio
            </Link>
            <p className="mt-1 text-xs text-slate-400">Self-hosted schema workspace</p>
          </div>
          <span className="rounded-full border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-300">
            Single user
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-10">
        <Outlet />
      </main>
    </div>
  );
}

function RouteErrorPage() {
  const error = useRouteError();
  const isNotFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <ErrorState
      title={isNotFound ? "Page not found" : "Page error"}
      message={
        isNotFound ? "The requested page could not be found." : "This page could not be displayed."
      }
    />
  );
}

function NotFoundPage() {
  return <ErrorState title="Page not found" message="The requested page does not exist." />;
}

function RouteLoadingPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-300">
      <p aria-live="polite">Loading workspace…</p>
    </main>
  );
}

function ErrorState({ title, message }: { readonly title: string; readonly message: string }) {
  return (
    <section className="mx-auto max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">Navigation</p>
      <h1 className="mt-3 text-2xl font-semibold text-white">{title}</h1>
      <p className="mt-3 text-slate-300">{message}</p>
      <Link
        className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg bg-cyan-300 px-5 font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
        to="/"
      >
        Back to projects
      </Link>
    </section>
  );
}
