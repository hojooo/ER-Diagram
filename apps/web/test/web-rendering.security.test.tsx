// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  DEFAULT_RUNTIME_CONFIG_RESPONSE,
  type ProjectState,
  type SqlExportResponse,
  type SqlImportStandalonePreviewResponse,
} from "@er-diagram/contracts";
import { parseDbmlV2, type SchemaGraph } from "@er-diagram/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    BaseEdge: () => null,
    Controls: () => null,
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => children,
    Handle: () => null,
    Position: { Left: "left", Right: "right" },
    getSmoothStepPath: () => ["", 0, 0],
    ReactFlow: (props: Record<string, unknown>) => {
      const nodes = (props.nodes ?? []) as Array<{
        id: string;
        type: string;
        data: Record<string, unknown>;
      }>;
      const nodeTypes = props.nodeTypes as Record<
        string,
        React.ComponentType<Record<string, unknown>>
      >;
      const onInit = props.onInit as ((instance: { fitView(): Promise<void> }) => void) | undefined;
      React.useEffect(() => {
        onInit?.({ fitView: async () => undefined });
      }, [onInit]);
      return (
        <div role="application" aria-label={String(props["aria-label"])}>
          {nodes.map((node) => {
            const Component = nodeTypes[node.type];
            return Component ? <Component key={node.id} {...node} /> : null;
          })}
        </div>
      );
    },
  };
});

import { BaseSchemaDiagram } from "../src/diagram/base-schema-diagram.js";
import { createDiagramVisibility } from "../src/diagram/projection.js";
import { SchemaOutline } from "../src/diagram/schema-outline.js";
import { createDiagramSelectionStore } from "../src/diagram/selection-store.js";
import { ProjectApiProvider } from "../src/projects/project-api-context.js";
import type { ProjectApi } from "../src/projects/project-api.js";
import { ProjectHomePage } from "../src/projects/project-home-page.js";
import { RuntimeConfigProvider } from "../src/runtime-config.js";
import { MonacoDbmlEditor } from "../src/source-editor/monaco-dbml-editor.js";
import type { MonacoRuntime } from "../src/source-editor/monaco-runtime.js";
import { NewSqlImportPage } from "../src/sql-import/sql-import-page.js";
import {
  ProjectSqlExportPage,
  type SqlExportPageAdapters,
} from "../src/sql-export/sql-export-page.js";
import { VisualCommandForm } from "../src/visual-editor/visual-command-form.js";
import type { VisualCommandSessionController } from "../src/visual-editor/visual-command-session.js";
import { VisualSchemaInspector } from "../src/visual-editor/visual-schema-inspector.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const REVISION_ID = "019d3f4e-7b6c-7def-9abc-0123456789ab";
const CREATED_AT = "2026-08-31T01:02:03.004Z";
const HASH = "a".repeat(64);
const PROJECT_NAME = 'Project </h2><img src=x onerror="window.pwned=true"> 😀';
const TABLE_NAME = "table<script>😀";
const COLUMN_NAME = "column<img src=x onerror=window.pwned=true>😀";
const GROUP_NAME = "group<script>😀";
const NOTE = "note</textarea><script>window.pwned=true</script>\r\nsecond line 😀";
const DIAGNOSTIC = "diagnostic</p><img src=x onerror=window.pwned=true>😀";
const REPORT = "report</li><script>window.pwned=true</script>😀";
const DBML_SOURCE = `TableGroup "${GROUP_NAME}" [color: #778899] {
  "${TABLE_NAME}"
}

Table "${TABLE_NAME}" {
  "${COLUMN_NAME}" int [pk]
}
`.replaceAll("\n", "\r\n");

beforeAll(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "pwned");
});

describe("Web text and byte-preservation security boundaries", () => {
  it("renders project, schema identifiers, notes, diagnostics, and unsafe colors as inert text", async () => {
    const graph = await parseGraph(DBML_SOURCE);
    const state = projectState(DBML_SOURCE, PROJECT_NAME);
    const api = fakeApi({
      listProjects: vi.fn(async () => ({ projects: [projectSummary(state)] })),
    });
    renderWithProviders(<ProjectHomePage />, api);
    expect(await screen.findByText(PROJECT_NAME, { exact: true })).toBeVisible();
    expectNoExecutableMarkup();

    cleanup();
    render(
      <SchemaOutline
        graph={graph}
        visibility={createDiagramVisibility(graph, "GLOBAL")}
        viewLabel="Global"
        collapsedGroupKeys={new Set()}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={vi.fn()}
      />,
    );
    expect(screen.getByText(`public.${GROUP_NAME}`, { exact: true })).toBeVisible();
    const tableSummary = screen.getByText(`public.${TABLE_NAME}`, { exact: true });
    expect(tableSummary).toBeVisible();
    fireEvent.click(tableSummary);
    expect(await screen.findByRole("button", { name: /column<img src=x onerror/ })).toBeVisible();
    expectNoExecutableMarkup();

    cleanup();
    const group = graph.groups[0];
    if (!group) throw new Error("Expected a TableGroup fixture.");
    const unsafeColorGraph: SchemaGraph = {
      ...graph,
      groups: graph.groups.map((candidate) =>
        candidate.key === group.key
          ? { ...candidate, color: "url(javascript:window.pwned=true)" }
          : candidate,
      ),
    };
    render(
      <BaseSchemaDiagram
        graph={unsafeColorGraph}
        viewKey="GLOBAL"
        detailLevel="FULL"
        collapsedGroupKeys={new Set()}
        selectionStore={createDiagramSelectionStore()}
        sourceNavigationEnabled
        onToggleGroup={vi.fn()}
        onNavigateSource={vi.fn()}
        requestLayout={async (projection) => projection}
      />,
    );
    const renderedGroup = await screen.findByLabelText(/Color url\(javascript:/);
    expect(renderedGroup).toHaveTextContent("Color url(javascript:window.pwned=true)");
    expect(renderedGroup).not.toHaveAttribute("style");
    expectNoExecutableMarkup();

    cleanup();
    const table = graph.tables[0];
    if (!table) throw new Error("Expected a table fixture.");
    render(
      <VisualCommandForm
        graph={graph}
        primaryDialect="POSTGRESQL"
        action={{
          id: "update-table",
          kind: "UPDATE_TABLE",
          label: "Update table",
          targetElementKey: table.key,
        }}
        initialDraft={{
          kind: "UPDATE_TABLE",
          targetTableKey: table.key,
          changes: { note: NOTE },
        }}
        disabled={false}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Table note")).toHaveValue(NOTE.replaceAll("\r\n", "\n"));
    expectNoExecutableMarkup();

    cleanup();
    const errorSnapshot = {
      status: "REJECTED" as const,
      error: {
        code: "VISUAL_COMMAND_TRANSFORM_FAILED",
        message: DIAGNOSTIC,
        diagnostics: [
          { code: "VISUAL_REPARSE_FAILED", message: DIAGNOSTIC, severity: "ERROR" as const },
        ],
      },
      mutation: null,
      pendingCommand: null,
      lastCommand: null,
      layoutRefreshFailed: false,
    };
    const commandSession: VisualCommandSessionController = {
      getSnapshot: () => errorSnapshot,
      subscribe: () => () => undefined,
      submit: vi.fn(async () => undefined),
      retrySafely: vi.fn(async () => undefined),
      reviewLatestSchema: vi.fn(),
      reset: vi.fn(),
    };
    render(
      <VisualSchemaInspector
        graph={graph}
        primaryDialect="POSTGRESQL"
        currentViewKey="GLOBAL"
        selectionStore={createDiagramSelectionStore()}
        commandSession={commandSession}
        interactionDisabled={false}
        sourceNavigationEnabled
        onOpenSource={vi.fn()}
        onReloadLayouts={vi.fn()}
      />,
    );
    expect(screen.getAllByText(DIAGNOSTIC, { exact: true })).toHaveLength(2);
    expectNoExecutableMarkup();
  });

  it("preserves script-like CRLF SQL and DBML in textarea, report, and download boundaries", async () => {
    const sqlSource = `CREATE TABLE safe_name (note text DEFAULT '${NOTE}');\r\n`;
    const candidateDbml = `Table safe_name {\r\n  note text [note: '${NOTE.replace("\r\n", "\\n")}']\r\n}\r\n`;
    const preview = importPreview(sqlSource, candidateDbml);
    const previewStandaloneSqlImport = vi.fn(async () => preview);
    const api = fakeApi({ previewStandaloneSqlImport });
    const importRouter = createMemoryRouter(
      [
        {
          path: "/sql-import/new",
          element: <NewSqlImportPage adapters={{ parseDbml: async () => Promise.reject() }} />,
        },
      ],
      { initialEntries: ["/sql-import/new"] },
    );
    renderWithProviders(<RouterProvider router={importRouter} />, api, false);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: PROJECT_NAME } });
    const file = new File([sqlSource], "script-like.sql", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Choose SQL file"), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByLabelText("SQL source")).toHaveValue(sqlSource.replaceAll("\r\n", "\n")),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
    await screen.findByRole("heading", { name: "Review SQL import" });
    expect(screen.getByLabelText("SQL source")).toHaveValue(sqlSource.replaceAll("\r\n", "\n"));
    expect(screen.getByLabelText("Generated DBML")).toHaveValue(
      candidateDbml.replaceAll("\r\n", "\n"),
    );
    expect(screen.getByText(REPORT, { exact: true })).toBeVisible();
    expect(previewStandaloneSqlImport).toHaveBeenCalledWith(
      expect.objectContaining({ source: sqlSource }),
    );
    expectNoExecutableMarkup();

    cleanup();
    const exportSql = `-- generated\r\nCREATE TABLE safe_name (note text DEFAULT '${NOTE}');\r\n`;
    const downloads: Array<{ readonly content: string }> = [];
    const exported = exportResponse(exportSql);
    renderWithProviders(
      <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}/sql-export`]}>
        <Routes>
          <Route
            path="/projects/:projectId/sql-export"
            element={
              <ProjectSqlExportPage
                adapters={
                  {
                    download: (file) => downloads.push(file),
                  } satisfies SqlExportPageAdapters
                }
              />
            }
          />
        </Routes>
      </MemoryRouter>,
      fakeApi({
        getProject: vi.fn(async () => ({ state: projectState(DBML_SOURCE, PROJECT_NAME) })),
        exportProjectSql: vi.fn(async () => exported),
      }),
      false,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Generate SQL export" }));
    expect(await screen.findByText(REPORT, { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the partial/ }));
    fireEvent.click(screen.getByRole("button", { name: "Download SQL" }));
    expect(downloads).toHaveLength(1);
    expect(new TextEncoder().encode(downloads[0]?.content)).toEqual(
      new TextEncoder().encode(exportSql),
    );
    expect(screen.getByLabelText("Generated SQL")).toHaveValue(exportSql.replaceAll("\r\n", "\n"));
    expectNoExecutableMarkup();
  });

  it("passes the exact CRLF source to the local Monaco model without interpreting markup", async () => {
    let modelValue = "";
    let modelEol = 0;
    const model = {
      uri: { toString: () => "inmemory://security/main.dbml" },
      dispose: vi.fn(),
      getValue: () => modelValue,
      getValueLength: () => modelValue.length,
      getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
      getOffsetAt: (position: { lineNumber: number; column: number }) => position.column - 1,
      setValue: (source: string) => {
        modelValue = source;
      },
      setEOL: (eol: number) => {
        modelEol = eol;
      },
      onDidChangeContent: () => ({ dispose: vi.fn() }),
    };
    const editor = {
      addCommand: vi.fn(),
      dispose: vi.fn(),
      focus: vi.fn(),
      onDidChangeCursorPosition: () => ({ dispose: vi.fn() }),
      revealRangeInCenter: vi.fn(),
      setSelection: vi.fn(),
      updateOptions: vi.fn(),
    };
    const runtime = {
      KeyCode: { KeyS: 1, KeyY: 2, KeyZ: 3 },
      KeyMod: { CtrlCmd: 1 << 8, Shift: 1 << 9 },
      MarkerSeverity: { Error: 8, Hint: 1, Info: 2, Warning: 4 },
      Uri: { parse: (value: string) => ({ toString: () => value }) },
      editor: {
        EndOfLineSequence: { CRLF: 1, LF: 0 },
        create: vi.fn(() => editor),
        createModel: vi.fn((source: string) => {
          modelValue = source;
          return model;
        }),
        defineTheme: vi.fn(),
        getModel: vi.fn(() => null),
        setModelMarkers: vi.fn(),
      },
      languages: {
        register: vi.fn(),
        setLanguageConfiguration: vi.fn(),
        setMonarchTokensProvider: vi.fn(),
      },
    } as unknown as MonacoRuntime;

    render(
      <MonacoDbmlEditor
        projectId={PROJECT_ID}
        initialSource={DBML_SOURCE}
        diagnostics={[]}
        onChange={vi.fn()}
        onSave={vi.fn()}
        loadRuntime={async () => runtime}
      />,
    );
    await waitFor(() => expect(modelValue).toBe(DBML_SOURCE));
    expect(modelEol).toBe(1);
    expect(new TextEncoder().encode(modelValue)).toEqual(new TextEncoder().encode(DBML_SOURCE));
    expectNoExecutableMarkup();
  });
});

async function parseGraph(source: string): Promise<SchemaGraph> {
  const parsed = await parseDbmlV2(source, "/main.dbml");
  if (!parsed.ok)
    throw new Error(parsed.diagnostics.map((diagnostic) => diagnostic.code).join(","));
  return parsed.graph;
}

function renderWithProviders(
  element: React.ReactNode,
  api: ProjectApi,
  includeRouter = true,
): ReturnType<typeof render> {
  const content = includeRouter ? <MemoryRouter>{element}</MemoryRouter> : element;
  return render(
    <RuntimeConfigProvider config={DEFAULT_RUNTIME_CONFIG_RESPONSE}>
      <ProjectApiProvider api={api}>
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
            })
          }
        >
          {content}
        </QueryClientProvider>
      </ProjectApiProvider>
    </RuntimeConfigProvider>,
  );
}

function fakeApi(overrides: Partial<ProjectApi> = {}): ProjectApi {
  const unused = async (): Promise<never> => {
    throw new Error("This API operation is not used by the security fixture.");
  };
  return {
    getRuntimeConfig: async () => DEFAULT_RUNTIME_CONFIG_RESPONSE,
    listProjects: async () => ({ projects: [] }),
    getProject: unused,
    listRevisions: async () => ({ revisions: [] }),
    createProject: unused,
    renameProject: unused,
    duplicateProject: unused,
    saveDraft: unused,
    restoreRevision: unused,
    getLayout: unused,
    saveLayout: unused,
    deleteProject: unused,
    previewStandaloneSqlImport: unused,
    createProjectFromSqlImport: unused,
    previewProjectSqlImport: unused,
    applyProjectSqlImport: unused,
    exportProjectSql: unused,
    applyVisualCommand: unused,
    ...overrides,
  } as ProjectApi;
}

function projectState(source: string, name: string): ProjectState {
  const revision = {
    id: REVISION_ID,
    projectId: PROJECT_ID,
    revisionNo: 1,
    source,
    sourceHash: HASH,
    validity: "VALID" as const,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
    createdAt: CREATED_AT,
  };
  return {
    project: {
      id: PROJECT_ID,
      name,
      primaryDialect: "POSTGRESQL",
      draftSource: source,
      draftHash: HASH,
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

function projectSummary(state: ProjectState) {
  return {
    id: state.project.id,
    name: state.project.name,
    primaryDialect: state.project.primaryDialect,
    parserVersion: state.project.parserVersion,
    schemaRevisionNo: state.project.schemaRevisionNo,
    layoutRevisionNo: state.project.layoutRevisionNo,
    draftValidity: state.currentRevision.validity,
    diagnosticSummary: state.currentRevision.diagnosticSummary,
    createdAt: state.project.createdAt,
    updatedAt: state.project.updatedAt,
  };
}

function importPreview(
  sqlSource: string,
  candidateDbml: string,
): SqlImportStandalonePreviewResponse {
  return {
    previewStatus: "PREVIEWED",
    previewHash: "b".repeat(64),
    originalSqlRetention: "DISCARD",
    report: {
      reportVersion: 1,
      dialect: "POSTGRESQL",
      sourceFilepath: "/import.sql",
      sourceHash: HASH,
      parserInputHash: HASH,
      parserVersions: { dbmlCore: "9.1.1", dbmlParse: "9.1.1" },
      capabilityMatrixVersion: 1,
      schemaSemanticsVersion: 1,
      overallStatus: "PARTIAL",
      applyEligible: true,
      candidateDbmlHash: "c".repeat(64),
      statements: [
        {
          statementNo: 1,
          kind: "CREATE_TABLE",
          capabilityId: "CREATE_TABLE",
          status: "PARTIAL",
          code: "SQL_PARTIAL_CREATE_TABLE",
          message: REPORT,
          range: {
            filepath: "/import.sql",
            startOffset: 0,
            endOffset: sqlSource.length,
            startLine: 1,
            startColumn: 1,
            endLine: 2,
            endColumn: 1,
          },
          clauses: [],
        },
      ],
      diagnostics: [],
      semanticVerification: {
        status: "VERIFIED",
        sourceModelHash: "c".repeat(64),
        candidateSchemaHash: "c".repeat(64),
        changes: [],
      },
    },
    policy: {
      policyVersion: 1,
      dataStatementNos: [],
      dataHandling: "NOT_PRESENT",
      applyReadiness: "READY",
    },
    candidate: { dbml: candidateDbml, dbmlHash: "c".repeat(64) },
  };
}

function exportResponse(sql: string): SqlExportResponse {
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
      generatedSqlHash: "d".repeat(64),
      containsDataStatements: false,
      entries: [
        {
          code: "SQL_EXPORT_OMITS_TABLE_GROUP",
          status: "PARTIAL",
          message: REPORT,
          occurrences: [],
        },
      ],
      diagnostics: [],
      semanticVerification: {
        status: "VERIFIED",
        sourceExportableHash: "e".repeat(64),
        generatedExportableHash: "e".repeat(64),
        changes: [],
      },
    },
    candidate: { sql, sqlHash: "d".repeat(64) },
  };
}

function expectNoExecutableMarkup(): void {
  expect(document.body.querySelector("script")).toBeNull();
  expect(document.body.querySelector("img")).toBeNull();
  expect(Reflect.get(window, "pwned")).toBeUndefined();
}
