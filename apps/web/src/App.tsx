import type { RuntimeConfigResponse } from "@er-diagram/contracts";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  useMatches,
  useRouteError,
} from "react-router-dom";
import type { ProjectBundlePageAdapters } from "./project-bundle/project-bundle-page.js";
import {
  LanguageSelect,
  UiLocaleProvider,
  type UiLocale,
  useUiLocale,
} from "./localization/ui-locale.js";
import type { ProjectApi } from "./projects/project-api.js";
import { ProjectApiProvider } from "./projects/project-api-context.js";
import { ProjectHomePage } from "./projects/project-home-page.js";
import { RootErrorBoundary } from "./root-error-boundary.js";
import { RuntimeConfigProvider } from "./runtime-config.js";
import type { ProjectWorkspaceAdapters } from "./source-editor/project-source-workspace.js";
import type { SqlExportPageAdapters } from "./sql-export/sql-export-page.js";
import type { SqlImportPageAdapters } from "./sql-import/sql-import-page.js";

type DataRouter = ComponentProps<typeof RouterProvider>["router"];

const MAIN_CONTENT_ID = "main-content";

export interface AppProps {
  readonly api: ProjectApi;
  readonly queryClient: QueryClient;
  readonly router: DataRouter;
  readonly initialLocale?: UiLocale;
}

export function App({ api, queryClient, router, initialLocale }: AppProps) {
  return (
    <UiLocaleProvider {...(initialLocale ? { initialLocale } : {})}>
      <ConfiguredApp api={api} queryClient={queryClient} router={router} />
    </UiLocaleProvider>
  );
}

function ConfiguredApp({ api, queryClient, router }: Omit<AppProps, "initialLocale">) {
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
  const { messages } = useUiLocale();
  useDocumentTitle(messages["startup.loadingTitle"]);
  return (
    <main
      id={MAIN_CONTENT_ID}
      className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-300"
    >
      <LanguageSelect className="absolute right-6 top-6" />
      <section className="text-center">
        <h1 className="text-xl font-semibold text-slate-100">{messages["startup.loadingTitle"]}</h1>
        <p className="mt-2" aria-live="polite">
          {messages["startup.loadingMessage"]}
        </p>
      </section>
    </main>
  );
}

function StartupConfigError({ onRetry }: { readonly onRetry: () => void }) {
  const { messages } = useUiLocale();
  useDocumentTitle(messages["startup.errorTitle"]);
  return (
    <main
      id={MAIN_CONTENT_ID}
      className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-100"
    >
      <LanguageSelect className="absolute right-6 top-6" />
      <section className="max-w-xl rounded-2xl border border-red-900 bg-slate-900 p-8 text-center">
        <h1 className="text-2xl font-semibold">{messages["startup.errorTitle"]}</h1>
        <p className="mt-3 text-slate-300" role="alert">
          {messages["startup.errorMessage"]}
        </p>
        <button
          className="mt-6 min-h-11 rounded-lg bg-cyan-300 px-5 font-semibold text-slate-950"
          onClick={onRetry}
          type="button"
        >
          {messages["action.retry"]}
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
          handle: { layout: "CANVAS_WORKSPACE" },
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
  const matches = useMatches();
  const { messages } = useUiLocale();
  const canvasWorkspace = matches.some(
    (match) =>
      typeof match.handle === "object" &&
      match.handle !== null &&
      "layout" in match.handle &&
      match.handle.layout === "CANVAS_WORKSPACE",
  );
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
      document.title = headingText
        ? messages["app.documentTitle"](headingText)
        : messages["app.productTitle"];
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
  }, [location.key, messages]);

  const focusMainContent = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const main = document.getElementById(MAIN_CONTENT_ID);
    if (!main) return;
    main.focus();
    window.history.replaceState(window.history.state, "", `#${MAIN_CONTENT_ID}`);
  };

  return (
    <div
      className={`${canvasWorkspace ? "h-dvh overflow-hidden" : "min-h-screen"} bg-slate-950 text-slate-100`}
    >
      <a
        className="fixed left-4 top-4 z-[100] -translate-y-24 rounded-lg bg-cyan-300 px-4 py-3 font-semibold text-slate-950 shadow-lg transition-transform focus:translate-y-0 focus:outline-2 focus:outline-offset-2 focus:outline-white"
        href={`#${MAIN_CONTENT_ID}`}
        onClick={focusMainContent}
      >
        {messages["app.skipToMain"]}
      </a>
      {canvasWorkspace ? null : (
        <header className="border-b border-slate-800 bg-slate-950/95">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-8">
            <div>
              <Link
                className="text-lg font-semibold tracking-tight text-white no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
                to="/"
              >
                {messages["app.productTitle"]}
              </Link>
              <p className="mt-1 text-xs text-slate-400">{messages["app.tagline"]}</p>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <LanguageSelect />
              <span className="rounded-full border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-300">
                {messages["app.singleUser"]}
              </span>
            </div>
          </div>
        </header>
      )}
      <main
        id={MAIN_CONTENT_ID}
        className={
          canvasWorkspace
            ? "h-full w-full overflow-hidden outline-none"
            : "mx-auto w-full max-w-7xl px-5 py-8 outline-none sm:px-8 sm:py-10"
        }
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
  const { messages } = useUiLocale();
  return (
    <ErrorState
      title={isNotFound ? messages["route.notFoundTitle"] : messages["route.errorTitle"]}
      message={isNotFound ? messages["route.notFoundMessage"] : messages["route.errorMessage"]}
    />
  );
}

function NotFoundPage() {
  const { messages } = useUiLocale();
  return (
    <ErrorState
      title={messages["route.notFoundTitle"]}
      message={messages["route.missingMessage"]}
    />
  );
}

function RouteLoadingPage() {
  const { messages } = useUiLocale();
  useDocumentTitle(messages["route.loadingDocumentTitle"]);
  return (
    <main
      id={MAIN_CONTENT_ID}
      className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-300"
    >
      <section className="text-center">
        <h1 data-route-loading="true" className="text-xl font-semibold text-slate-100">
          {messages["route.loadingTitle"]}
        </h1>
        <p className="mt-2" aria-live="polite">
          {messages["route.loadingMessage"]}
        </p>
      </section>
    </main>
  );
}

function useDocumentTitle(pageTitle: string) {
  const { messages } = useUiLocale();
  useEffect(() => {
    document.title = messages["app.documentTitle"](pageTitle);
  }, [messages, pageTitle]);
}

function ErrorState({ title, message }: { readonly title: string; readonly message: string }) {
  const { messages } = useUiLocale();
  return (
    <section className="mx-auto max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">
        {messages["route.navigation"]}
      </p>
      <h1 className="mt-3 text-2xl font-semibold text-white">{title}</h1>
      <p className="mt-3 text-slate-300">{message}</p>
      <Link
        className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg bg-cyan-300 px-5 font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
        to="/"
      >
        {messages["route.backToProjects"]}
      </Link>
    </section>
  );
}
