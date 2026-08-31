// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  DEFAULT_RUNTIME_RESOURCE_LIMITS,
  type ProjectState,
  type SqlExportResponse,
} from "@er-diagram/contracts";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, createAppRoutes } from "../src/App.js";
import type { ProjectApi } from "../src/projects/project-api.js";
import type { SqlExportPageAdapters } from "../src/sql-export/sql-export-page.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const REVISION_ID = "019d3f4e-7b6c-7def-9abc-0123456789ab";
const HASH = "a".repeat(64);
const CREATED_AT = "2026-08-29T00:00:00.000Z";
const SOURCE = `Table users { id int [pk] }
TableGroup core { users }`;

afterEach(cleanup);

function projectState(validity: "VALID" | "INVALID", withLastValid = true): ProjectState {
  const lastValid = {
    id: REVISION_ID,
    projectId: PROJECT_ID,
    revisionNo: 1,
    source: SOURCE,
    sourceHash: HASH,
    validity: "VALID" as const,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
    createdAt: CREATED_AT,
  };
  const current =
    validity === "VALID"
      ? lastValid
      : {
          ...lastValid,
          id: "019d3f4e-7b6c-7def-9abc-0123456789ac",
          revisionNo: 2,
          source: `${SOURCE}\nTable broken {`,
          sourceHash: "b".repeat(64),
          validity: "INVALID" as const,
          diagnosticSummary: { ...lastValid.diagnosticSummary, errors: 1 },
        };
  return {
    project: {
      id: PROJECT_ID,
      name: "Customer / schema",
      primaryDialect: "POSTGRESQL",
      draftSource: current.source,
      draftHash: current.sourceHash,
      lastValidRevisionId: withLastValid ? lastValid.id : null,
      parserVersion: "9.1.1",
      schemaRevisionNo: current.revisionNo,
      layoutRevisionNo: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision: current,
    lastValidRevision: withLastValid ? lastValid : null,
  };
}

function exportResponse(overrides: Partial<SqlExportResponse> = {}): SqlExportResponse {
  return {
    sourceSelection: "CURRENT_DRAFT",
    revisionNo: 1,
    sourceHash: HASH,
    report: {
      reportVersion: 1,
      exportSemanticsVersion: 1,
      sourceFilepath: "/main.dbml",
      sourceHash: HASH,
      parserInputHash: HASH,
      primaryDialect: "POSTGRESQL",
      targetDialect: "POSTGRESQL",
      parserVersions: { dbmlCore: "9.1.1", dbmlParse: "9.1.1" },
      schemaSemanticsVersion: 1,
      ddlKind: "EMPTY_SCHEMA_CREATE",
      overallStatus: "PARTIAL",
      acknowledgementRequired: true,
      generatedSqlHash: HASH,
      containsDataStatements: false,
      entries: [
        {
          code: "SQL_EXPORT_OMITS_TABLE_GROUP",
          status: "PARTIAL",
          message: "TableGroup definitions are not represented in SQL DDL.",
          occurrences: [
            {
              elementKind: "group",
              elementKey: "group-key",
              range: {
                filepath: "/main.dbml",
                startOffset: 33,
                endOffset: SOURCE.length,
                startLine: 2,
                startColumn: 1,
                endLine: 2,
                endColumn: 26,
              },
            },
          ],
        },
      ],
      diagnostics: [],
      semanticVerification: {
        status: "VERIFIED",
        sourceExportableHash: HASH,
        generatedExportableHash: HASH,
        changes: [],
      },
    },
    candidate: {
      sql: "-- This is not a migration.\nCREATE TABLE users (id integer PRIMARY KEY);",
      sqlHash: HASH,
    },
    ...overrides,
  };
}

function fakeApi(state: ProjectState, exported: SqlExportResponse): ProjectApi {
  return {
    getRuntimeConfig: vi.fn(async () => ({
      configVersion: 1 as const,
      resourceLimits: DEFAULT_RUNTIME_RESOURCE_LIMITS,
    })),
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
    previewStandaloneSqlImport: vi.fn(),
    createProjectFromSqlImport: vi.fn(),
    previewProjectSqlImport: vi.fn(),
    applyProjectSqlImport: vi.fn(),
    exportProjectSql: vi.fn(async () => exported),
    exportProjectBundle: vi.fn(),
    importProjectBundle: vi.fn(),
  };
}

function renderExport(state: ProjectState, exported: SqlExportResponse) {
  const downloads: Array<{ filename: string; mimeType: string; content: string }> = [];
  const adapters: SqlExportPageAdapters = { download: (file) => downloads.push(file) };
  const api = fakeApi(state, exported);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(createAppRoutes({ sqlExportAdapters: adapters }), {
    initialEntries: [`/projects/${PROJECT_ID}/sql-export`],
  });
  render(<App api={api} queryClient={queryClient} router={router} />);
  return { api, downloads };
}

describe("SQL export page", () => {
  it("requires loss acknowledgement and downloads separate SQL and report files", async () => {
    const { api, downloads } = renderExport(projectState("VALID"), exportResponse());
    fireEvent.click(await screen.findByRole("button", { name: "Generate SQL export" }));
    await screen.findByText("Export report ready: PARTIAL.");

    const sqlDownload = screen.getByRole("button", { name: "Download SQL" });
    expect(sqlDownload).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Download report JSON" }));
    expect(downloads[0]?.filename).toBe("Customer-schema-r1-postgresql.conversion-report.json");
    expect(JSON.parse(downloads[0]?.content ?? "")).toMatchObject({
      downloadVersion: 1,
      revisionNo: 1,
      report: { overallStatus: "PARTIAL" },
    });

    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the partial/ }));
    fireEvent.click(sqlDownload);
    expect(downloads[1]).toMatchObject({
      filename: "Customer-schema-r1-postgresql.sql",
      mimeType: "application/sql;charset=utf-8",
    });
    expect(api.exportProjectSql).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      expectedSchemaRevisionNo: 1,
      sourceSelection: "CURRENT_DRAFT",
    });
  });

  it("requires explicit last-valid selection and navigates occurrences in its source", async () => {
    const exported = exportResponse({ sourceSelection: "LAST_VALID" });
    const { api } = renderExport(projectState("INVALID"), exported);
    const generate = await screen.findByRole("button", { name: "Generate SQL export" });
    expect(generate).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Export last-valid revision 1 explicitly" }),
    );
    fireEvent.click(generate);
    await screen.findByText("Export report ready: PARTIAL.");
    fireEvent.click(screen.getByRole("button", { name: /group · 2:1/ }));
    const source = screen.getByRole("textbox", { name: "Selected DBML source" });
    expect(source).toHaveFocus();
    expect((source as HTMLTextAreaElement).selectionStart).toBe(33);
    expect(api.exportProjectSql).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSelection: "LAST_VALID", expectedSchemaRevisionNo: 2 }),
    );
  });

  it("keeps fatal report download available while withholding SQL", async () => {
    const fatal = exportResponse({
      candidate: null,
      report: {
        ...exportResponse().report,
        overallStatus: "ERROR",
        acknowledgementRequired: false,
        generatedSqlHash: null,
        entries: [],
        semanticVerification: {
          status: "NOT_RUN",
          sourceExportableHash: null,
          generatedExportableHash: null,
          changes: [],
        },
      },
    });
    const { downloads } = renderExport(projectState("VALID"), fatal);
    fireEvent.click(await screen.findByRole("button", { name: "Generate SQL export" }));
    await screen.findByText("Fatal conversion errors blocked SQL download.");
    expect(screen.queryByRole("button", { name: "Download SQL" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download report JSON" }));
    await waitFor(() => expect(downloads).toHaveLength(1));
  });
});
