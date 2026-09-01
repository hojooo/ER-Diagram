// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  DEFAULT_RUNTIME_CONFIG_RESPONSE,
  type ProjectState,
  type SqlImportStandalonePreviewResponse,
} from "@er-diagram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectApi } from "../src/projects/project-api.js";
import { ProjectApiProvider } from "../src/projects/project-api-context.js";
import { RuntimeConfigProvider } from "../src/runtime-config.js";
import { NewSqlImportPage, type SqlImportPageAdapters } from "../src/sql-import/sql-import-page.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const REVISION_ID = "019d3f4e-7b6c-7def-9abc-0123456789ab";
const ARTIFACT_ID = "019d3f4e-7b6c-7eee-8abc-0123456789ab";
const CREATED_AT = "2026-08-28T01:02:03.000Z";
const SOURCE = "CREATE TABLE users (id bigint PRIMARY KEY);\nINSERT INTO users VALUES (1);";
const DBML = "Table users {\n  id bigint [pk]\n}\n";

afterEach(cleanup);

function projectState(): ProjectState {
  const revision = {
    id: REVISION_ID,
    projectId: PROJECT_ID,
    revisionNo: 1,
    source: DBML,
    sourceHash: "b".repeat(64),
    validity: "VALID" as const,
    origin: "SQL_IMPORT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
    createdAt: CREATED_AT,
  };
  return {
    project: {
      id: PROJECT_ID,
      name: "Imported schema",
      primaryDialect: "POSTGRESQL",
      draftSource: DBML,
      draftHash: revision.sourceHash,
      lastValidRevisionId: REVISION_ID,
      parserVersion: "9.1.1",
      schemaRevisionNo: 1,
      layoutRevisionNo: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision: revision,
    lastValidRevision: revision,
  };
}

function preview(): SqlImportStandalonePreviewResponse {
  const range = {
    filepath: "/import.sql",
    startOffset: 0,
    endOffset: 44,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 45,
  };
  return {
    previewStatus: "PREVIEWED",
    previewHash: "c".repeat(64),
    originalSqlRetention: "DISCARD",
    report: {
      reportVersion: 1,
      dialect: "POSTGRESQL",
      sourceFilepath: "/import.sql",
      sourceHash: "a".repeat(64),
      parserInputHash: "a".repeat(64),
      parserVersions: { dbmlCore: "9.1.1", dbmlParse: "9.1.1" },
      capabilityMatrixVersion: 1,
      schemaSemanticsVersion: 1,
      overallStatus: "PARTIAL",
      applyEligible: false,
      candidateDbmlHash: "b".repeat(64),
      statements: [
        {
          statementNo: 1,
          kind: "CREATE_TABLE",
          capabilityId: "CREATE_TABLE",
          status: "PARTIAL",
          code: "SQL_PARTIAL_CREATE_TABLE",
          message: "Some table clauses are not preserved.",
          range,
          clauses: [],
        },
        {
          statementNo: 2,
          kind: "DML",
          capabilityId: "DML",
          status: "UNSUPPORTED",
          code: "SQL_UNSUPPORTED_DATA_STATEMENT",
          message: "Row data is excluded from schema import.",
          range: {
            ...range,
            startOffset: 45,
            endOffset: SOURCE.length,
            startLine: 2,
            endLine: 2,
            endColumn: 30,
          },
          clauses: [],
        },
      ],
      diagnostics: [],
      semanticVerification: {
        status: "VERIFIED",
        sourceModelHash: "b".repeat(64),
        candidateSchemaHash: "b".repeat(64),
        changes: [],
      },
    },
    policy: {
      policyVersion: 1,
      dataStatementNos: [2],
      dataHandling: "CONFIRMATION_REQUIRED",
      applyReadiness: "DATA_EXCLUSION_CONFIRMATION_REQUIRED",
    },
    candidate: { dbml: DBML, dbmlHash: "b".repeat(64) },
  };
}

function fakeApi() {
  const state = projectState();
  const api = {
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
    applyVisualCommand: vi.fn(),
    deleteProject: vi.fn(),
    previewStandaloneSqlImport: vi.fn(async () => preview()),
    createProjectFromSqlImport: vi.fn(async () => ({
      artifactId: ARTIFACT_ID,
      artifactStatus: "APPLIED" as const,
      previewHash: "c".repeat(64),
      appliedAt: CREATED_AT,
      policy: {
        policyVersion: 1 as const,
        dataStatementNos: [2],
        dataHandling: "CONFIRMED_DDL_ONLY" as const,
        applyReadiness: "READY" as const,
      },
      state,
      diagnostics: [],
      revisionCreated: true as const,
    })),
    previewProjectSqlImport: vi.fn(),
    applyProjectSqlImport: vi.fn(),
    exportProjectSql: vi.fn(),
    exportProjectBundle: vi.fn(),
    importProjectBundle: vi.fn(),
  } satisfies ProjectApi;
  return api;
}

const unavailableDiff: SqlImportPageAdapters = {
  async parseDbml() {
    throw new Error("Display-only diff worker unavailable.");
  },
};

function renderNewImport(api: ProjectApi) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        path: "/sql-import/new",
        element: <NewSqlImportPage adapters={unavailableDiff} />,
      },
      { path: "/projects/:projectId", element: <h1>Workspace destination</h1> },
      { path: "/", element: <h1>Project Home</h1> },
    ],
    { initialEntries: ["/sql-import/new"] },
  );
  return render(
    <RuntimeConfigProvider config={DEFAULT_RUNTIME_CONFIG_RESPONSE}>
      <ProjectApiProvider api={api}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ProjectApiProvider>
    </RuntimeConfigProvider>,
  );
}

describe("SQL import preview workflow", () => {
  it("keeps source local, navigates report ranges, and requires separate loss and data confirmation", async () => {
    const api = fakeApi();
    renderNewImport(api);

    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Imported schema" },
    });
    fireEvent.change(screen.getByLabelText("SQL source"), { target: { value: SOURCE } });
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));

    expect(await screen.findByRole("heading", { name: "Review SQL import" })).toBeVisible();
    expect(screen.getByLabelText("Generated DBML")).toHaveValue(DBML);
    expect(screen.getByLabelText("Generated DBML")).toHaveAttribute("readonly");
    expect(screen.getByText("Semantic inventory unavailable")).toBeVisible();
    const apply = screen.getByRole("button", { name: "Apply import" });
    expect(apply).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /SQL_PARTIAL_CREATE_TABLE/ }));
    const source = screen.getByLabelText("SQL source") as HTMLTextAreaElement;
    expect(source.selectionStart).toBe(0);
    expect(source.selectionEnd).toBe(44);

    fireEvent.click(screen.getByLabelText("I understand the reported schema conversion losses"));
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I confirm row data statements will be excluded"));
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    expect(await screen.findByRole("heading", { name: "Workspace destination" })).toBeVisible();
    expect(api.createProjectFromSqlImport).toHaveBeenCalledWith({
      name: "Imported schema",
      primaryDialect: "POSTGRESQL",
      source: SOURCE,
      previewHash: "c".repeat(64),
      originalSqlRetention: "DISCARD",
      dataStatementHandling: "CONFIRM_DDL_ONLY",
    });
  });

  it("does not create a project before apply and explicit cancel discards the local draft", async () => {
    const api = fakeApi();
    renderNewImport(api);
    fireEvent.change(screen.getByLabelText("SQL source"), { target: { value: SOURCE } });

    expect(api.createProjectFromSqlImport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    expect(await screen.findByRole("heading", { name: "Project Home" })).toBeVisible();
    expect(api.previewStandaloneSqlImport).not.toHaveBeenCalled();
    expect(api.createProjectFromSqlImport).not.toHaveBeenCalled();
  });

  it("reads a local SQL file byte-for-byte", async () => {
    const api = fakeApi();
    renderNewImport(api);
    const file = new File([SOURCE], "schema.sql", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Choose SQL file"), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByLabelText("SQL source")).toHaveValue(SOURCE));
    expect(screen.getByText("schema.sql")).toBeVisible();
  });
});
