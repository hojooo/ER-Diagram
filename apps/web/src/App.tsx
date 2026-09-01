import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RuntimeConfigResponse } from "@er-diagram/contracts";
import {
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  isRouteErrorResponse,
  Link,
  Outlet,
  type RouteObject,
  RouterProvider,
  useLocation,
  useRouteError,
} from "react-router-dom";

import type { ProjectApi } from "./projects/project-api.js";
import { ProjectApiProvider } from "./projects/project-api-context.js";
import { ProjectHomePage } from "./projects/project-home-page.js";
import { RootErrorBoundary } from "./root-error-boundary.js";
import { RuntimeConfigProvider } from "./runtime-config.js";
import type { ProjectWorkspaceAdapters } from "./source-editor/project-source-workspace.js";
import type { SqlImportPageAdapters } from "./sql-import/sql-import-page.js";
import type { SqlExportPageAdapters } from "./sql-export/sql-export-page.js";
import type { ProjectBundlePageAdapters } from "./project-bundle/project-bundle-page.js";

type DataRouter = ComponentProps<typeof RouterProvider>["router"];

const PRODUCT_TITLE = "DBML·SQL ERD Studio";
const MAIN_CONTENT_ID = "main-content";

export interface AppProps {
  readonly api: ProjectApi;
  readonly queryClient: QueryClient;
  readonly router: DataRouter;
}

export function App({ api, queryClient, router }: AppProps) {
  const [attempt, setAttempt] = useState(0);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfigResponse | null>(null);
  const [startupError, setStartupError] = useState(false);

  useEffect(() => {
    let active = true;
    setStartupError(false);
    if (attempt > 0) setRuntimeConfig(null);
    void api.getRuntimeConfig().then(
      (config) => {
        if (active) setRuntimeConfig(config);
      },
      () => {
        if (active) setStartupError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api, attempt]);

  return (
    <RootErrorBoundary>
      {runtimeConfig ? (
        <RuntimeConfigProvider config={runtimeConfig}>
          <ProjectApiProvider api={api}>
            <QueryClientProvider client={queryClient}>
              <RouterProvider router={router} />
            </QueryClientProvider>
          </ProjectApiProvider>
        </RuntimeConfigProvider>
      ) : startupError ? (
        <StartupConfigError onRetry={() => setAttempt((current) => current + 1)} />
      ) : (
        <StartupConfigLoading />
      )}
    </RootErrorBoundary>
  );
}

function StartupConfigLoading() {
  useDocumentTitle("Loading");
  return (
    <main
      id={MAIN_CONTENT_ID}
      className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-300"
    >
      <section className="text-center">
        <h1 className="text-xl font-semibold text-slate-100">Starting workspace</h1>
        <p className="mt-2" aria-live="polite">
          Loading runtime configuration…
        </p>
      </section>
    </main>
  );
}

function StartupConfigError({ onRetry }: { readonly onRetry: () => void }) {
  useDocumentTitle("Runtime configuration unavailable");
  return (
    <main
      id={MAIN_CONTENT_ID}
      className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-100"
    >
      <section className="max-w-xl rounded-2xl border border-red-900 bg-slate-900 p-8 text-center">
        <h1 className="text-2xl font-semibold">Runtime configuration unavailable</h1>
        <p className="mt-3 text-slate-300" role="alert">
          The workspace cannot safely start until its resource limits are loaded.
        </p>
        <button
          className="mt-6 min-h-11 rounded-lg bg-cyan-300 px-5 font-semibold text-slate-950"
          onClick={onRetry}
          type="button"
        >
          Retry
        </button>
      </section>
    </main>
  );
}

export function createAppRoutes(
  options: {
    readonly includeLayoutSpike?: boolean;
    readonly workspaceAdapters?: ProjectWorkspaceAdapters;
    readonly sqlImportAdapters?: SqlImportPageAdapters;
    readonly sqlExportAdapters?: SqlExportPageAdapters;
    readonly projectBundleAdapters?: ProjectBundlePageAdapters;
  } = {},
): RouteObject[] {
  const routes: RouteObject[] = [
    {
      element: <AppShell />,
      errorElement: <RouteErrorPage />,
      HydrateFallback: RouteLoadingPage,
      children: [
        { index: true, element: <ProjectHomePage /> },
        {
          path: "sql-import/new",
          lazy: async () => {
            const module = await import("./sql-import/sql-import-page.js");
            return {
              Component: () => (
                <module.NewSqlImportPage
                  {...(options.sqlImportAdapters ? { adapters: options.sqlImportAdapters } : {})}
                />
              ),
            };
          },
        },
        {
          path: "projects/:projectId/sql-import",
          lazy: async () => {
            const module = await import("./sql-import/sql-import-page.js");
            return {
              Component: () => (
                <module.ReplaceSqlImportPage
                  {...(options.sqlImportAdapters ? { adapters: options.sqlImportAdapters } : {})}
                />
              ),
            };
          },
        },
        {
          path: "project-bundles/import",
          lazy: async () => {
            const module = await import("./project-bundle/project-bundle-page.js");
            return { Component: module.ProjectBundleImportPage };
          },
        },
        {
          path: "projects/:projectId/bundle-export",
          lazy: async () => {
            const module = await import("./project-bundle/project-bundle-page.js");
            return {
              Component: () => (
                <module.ProjectBundleExportPage
                  {...(options.projectBundleAdapters
                    ? { adapters: options.projectBundleAdapters }
                    : {})}
                />
              ),
            };
          },
        },
        {
          path: "projects/:projectId/sql-export",
          lazy: async () => {
            const module = await import("./sql-export/sql-export-page.js");
            return {
              Component: () => (
                <module.ProjectSqlExportPage
                  {...(options.sqlExportAdapters ? { adapters: options.sqlExportAdapters } : {})}
                />
              ),
            };
          },
        },
        {
          path: "projects/:projectId",
          lazy: async () => {
            const module = await import("./projects/project-workspace-page.js");
            return {
              Component: () => (
                <module.ProjectWorkspacePage
                  {...(options.workspaceAdapters ? { adapters: options.workspaceAdapters } : {})}
                />
              ),
            };
          },
        },
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
  const location = useLocation();
  const previousLocationKey = useRef<string | null>(null);

  useEffect(() => {
    const main = document.getElementById(MAIN_CONTENT_ID);
    const routeChanged =
      previousLocationKey.current !== null && previousLocationKey.current !== location.key;
    previousLocationKey.current = location.key;
    let focusHandled = false;
    let observer: MutationObserver | null = null;
    let frame: number | null = null;

    const synchronizeRoute = () => {
      const heading = main?.querySelector<HTMLElement>("h1") ?? null;
      const headingText = heading?.textContent?.trim();
      const routeStillLoading = heading?.dataset.routeLoading === "true";
      document.title = headingText ? `${headingText} · ${PRODUCT_TITLE}` : PRODUCT_TITLE;
      if (heading && !routeStillLoading) observer?.disconnect();

      if (!routeChanged || focusHandled || !heading || !main || routeStillLoading) return;
      const activeElement = document.activeElement;
      const hasMoreSpecificFocus =
        activeElement instanceof HTMLElement &&
        activeElement !== document.body &&
        activeElement !== main &&
        main.contains(activeElement);
      if (!hasMoreSpecificFocus) {
        heading.tabIndex = -1;
        heading.focus();
      }
      focusHandled = true;
    };

    synchronizeRoute();
    if (!main?.querySelector("h1:not([data-route-loading='true'])")) {
      frame = window.requestAnimationFrame(synchronizeRoute);
      observer = main ? new MutationObserver(synchronizeRoute) : null;
      if (observer && main) observer.observe(main, { childList: true, subtree: true });
    }

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [location.key]);

  const focusMainContent = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const main = document.getElementById(MAIN_CONTENT_ID);
    if (!main) return;
    main.focus();
    window.history.replaceState(window.history.state, "", `#${MAIN_CONTENT_ID}`);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <a
        className="fixed left-4 top-4 z-[100] -translate-y-24 rounded-lg bg-cyan-300 px-4 py-3 font-semibold text-slate-950 shadow-lg transition-transform focus:translate-y-0 focus:outline-2 focus:outline-offset-2 focus:outline-white"
        href={`#${MAIN_CONTENT_ID}`}
        onClick={focusMainContent}
      >
        Skip to main content
      </a>
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
      <main
        id={MAIN_CONTENT_ID}
        className="mx-auto w-full max-w-7xl px-5 py-8 outline-none sm:px-8 sm:py-10"
        tabIndex={-1}
      >
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
  useDocumentTitle("Loading workspace");
  return (
    <main
      id={MAIN_CONTENT_ID}
      className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-300"
    >
      <section className="text-center">
        <h1 data-route-loading="true" className="text-xl font-semibold text-slate-100">
          Loading page
        </h1>
        <p className="mt-2" aria-live="polite">
          Loading workspace…
        </p>
      </section>
    </main>
  );
}

function useDocumentTitle(pageTitle: string) {
  useEffect(() => {
    document.title = `${pageTitle} · ${PRODUCT_TITLE}`;
  }, [pageTitle]);
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
