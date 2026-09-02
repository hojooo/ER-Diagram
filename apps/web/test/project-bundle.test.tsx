// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  DEFAULT_RUNTIME_CONFIG_RESPONSE,
  DEFAULT_RUNTIME_RESOURCE_LIMITS,
  type ProjectState,
} from "@er-diagram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProjectBundleExportPage,
  ProjectBundleImportPage,
  type ProjectBundlePageAdapters,
} from "../src/project-bundle/project-bundle-page.js";
import type { ProjectApi } from "../src/projects/project-api.js";
import { ProjectApiProvider } from "../src/projects/project-api-context.js";
import { RuntimeConfigProvider } from "../src/runtime-config.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const IMPORTED_ID = "019d3f4e-7b6c-7abc-8def-0123456789ac";
const REVISION_ID = "019d3f4e-7b6c-7def-9abc-0123456789ab";
const CREATED_AT = "2026-08-31T01:02:03.000Z";
const HASH = "a".repeat(64);

afterEach(cleanup);

function projectState(): ProjectState {
  const valid = {
    id: REVISION_ID,
    projectId: PROJECT_ID,
    revisionNo: 1,
    source: "Table users { id int [pk] }\n",
    sourceHash: HASH,
    validity: "VALID" as const,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
    createdAt: CREATED_AT,
  };
  const current = {
    ...valid,
    id: "019d3f4e-7b6c-7def-9abc-0123456789ac",
    revisionNo: 2,
    source: `${valid.source}Table broken {`,
    sourceHash: "b".repeat(64),
    validity: "INVALID" as const,
    diagnosticSummary: { ...valid.diagnosticSummary, errors: 1 },
  };
  return {
    project: {
      id: PROJECT_ID,
      name: "Customer / schema 🚀",
      primaryDialect: "POSTGRESQL",
      draftSource: current.source,
      draftHash: current.sourceHash,
      lastValidRevisionId: valid.id,
      parserVersion: "9.1.1",
      schemaRevisionNo: 2,
      layoutRevisionNo: 3,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision: current,
    lastValidRevision: valid,
  };
}

function fakeApi(state = projectState()): ProjectApi {
  const importedState: ProjectState = {
    ...state,
    project: { ...state.project, id: IMPORTED_ID },
    currentRevision: { ...state.currentRevision, projectId: IMPORTED_ID },
    lastValidRevision: state.lastValidRevision
      ? { ...state.lastValidRevision, projectId: IMPORTED_ID }
      : null,
  };
  return {
    getRuntimeConfig: vi.fn(async () => DEFAULT_RUNTIME_CONFIG_RESPONSE),
    listProjects: vi.fn(async () => ({ projects: [] })),
    getProject: vi.fn(async () => ({ state })),
    listRevisions: vi.fn(async () => ({ revisions: [] })),
    createProject: vi.fn(),
    renameProject: vi.fn(),
    duplicateProject: vi.fn(),
    saveDraft: vi.fn(),
    restoreRevision: vi.fn(),
    getLayout: vi.fn(),
    saveLayout: vi.fn(),
    deleteProject: vi.fn(),
    previewStandaloneSqlImport: vi.fn(),
    createProjectFromSqlImport: vi.fn(),
    previewProjectSqlImport: vi.fn(),
    applyProjectSqlImport: vi.fn(),
    exportProjectSql: vi.fn(),
    applyVisualCommand: vi.fn(),
    exportProjectBundle: vi.fn(async () => ({
      content: new Uint8Array([80, 75, 3, 4]),
      contentLength: 4,
      sha256: HASH,
      mimeType: "application/zip" as const,
      filename: "project.erdiagram.zip",
    })),
    importProjectBundle: vi.fn(async () => ({
      bundleSchemaVersion: 1 as const,
      bundleHash: HASH,
      state: importedState,
      diagnostics: [],
      imported: { revisionCount: 2, layoutCount: 1, reportCount: 0 },
    })),
  };
}

describe("portable project bundle workflow", () => {
  it("checks file.size before upload and preserves an oversized selection", async () => {
    const api = fakeApi();
    renderRoute({
      api,
      path: "/project-bundles/import",
      element: <ProjectBundleImportPage />,
      archiveLimit: 3,
    });
    const file = new File([new Uint8Array([1, 2, 3, 4])], "oversized.zip", {
      type: "application/zip",
    });
    fireEvent.change(screen.getByLabelText("Portable bundle ZIP"), {
      target: { files: [file] },
    });
    expect(await screen.findByText(/exceeds the 3 byte limit/u)).toBeInTheDocument();
    expect(screen.getByText(/Selected oversized.zip/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import as new project" })).toBeDisabled();
    expect(api.importProjectBundle).not.toHaveBeenCalled();
  });

  it("imports a selected ZIP as a new project and navigates without reading it as text", async () => {
    const api = fakeApi();
    const { router } = renderRoute({
      api,
      path: "/project-bundles/import",
      element: <ProjectBundleImportPage />,
      extraRoute: { path: "/projects/:projectId", element: <p>Imported workspace</p> },
    });
    const file = new File([new Uint8Array([80, 75, 3, 4])], "portable.zip", {
      type: "application/zip",
    });
    const textSpy = vi.spyOn(file, "text");
    fireEvent.change(screen.getByLabelText("Portable bundle ZIP"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Import as new project" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${IMPORTED_ID}`));
    expect(api.importProjectBundle).toHaveBeenCalledWith({ archive: file });
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("requires a separate retained-SQL confirmation and verifies bytes before download", async () => {
    const api = fakeApi();
    const download = vi.fn();
    const adapters: ProjectBundlePageAdapters = {
      download,
      sha256: vi.fn(async () => HASH),
    };
    renderRoute({
      api,
      path: `/projects/${PROJECT_ID}/bundle-export`,
      element: <ProjectBundleExportPage adapters={adapters} />,
    });
    expect(await screen.findByText(/Current revision 2 is invalid/u)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("SQL import reports"), {
      target: { value: "INCLUDE_RETAINED_SQL" },
    });
    const exportButton = screen.getByRole("button", { name: "Download portable bundle" });
    expect(exportButton).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/retained original SQL may contain sensitive literals/u));
    fireEvent.click(exportButton);
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(api.exportProjectBundle).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      expectedSchemaRevisionNo: 2,
      expectedLayoutRevisionNo: 3,
      reportMode: "INCLUDE_RETAINED_SQL",
    });
    expect(download.mock.calls[0]?.[0]).toMatchObject({
      filename: "Customer-schema.erdiagram.zip",
      sha256: HASH,
    });
  });

  it("blocks download when the browser hash disagrees with the response evidence", async () => {
    const api = fakeApi();
    const download = vi.fn();
    renderRoute({
      api,
      path: `/projects/${PROJECT_ID}/bundle-export`,
      element: (
        <ProjectBundleExportPage
          adapters={{ download, sha256: vi.fn(async () => "f".repeat(64)) }}
        />
      ),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Download portable bundle" }));
    expect(await screen.findByText("The bundle was not downloaded.")).toBeInTheDocument();
    expect(download).not.toHaveBeenCalled();
  });
});

function renderRoute(input: {
  readonly api: ProjectApi;
  readonly path: string;
  readonly element: React.ReactNode;
  readonly archiveLimit?: number;
  readonly extraRoute?: { readonly path: string; readonly element: React.ReactNode };
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      { path: input.path.replace(PROJECT_ID, ":projectId"), element: input.element },
      ...(input.extraRoute ? [input.extraRoute] : []),
    ],
    { initialEntries: [input.path] },
  );
  const resourceLimits = {
    ...DEFAULT_RUNTIME_RESOURCE_LIMITS,
    bundle: {
      ...DEFAULT_RUNTIME_RESOURCE_LIMITS.bundle,
      ...(input.archiveLimit === undefined ? {} : { maxArchiveBytes: input.archiveLimit }),
    },
  };
  render(
    <RuntimeConfigProvider config={{ ...DEFAULT_RUNTIME_CONFIG_RESPONSE, resourceLimits }}>
      <ProjectApiProvider api={input.api}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ProjectApiProvider>
    </RuntimeConfigProvider>,
  );
  return { queryClient, router };
}
