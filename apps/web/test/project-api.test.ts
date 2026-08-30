import { describe, expect, it, vi } from "vitest";
import type { VisualCommand } from "@er-diagram/contracts";

import { createHttpProjectApi, ProjectApiError } from "../src/projects/project-api.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const REVISION_ID = "019d3f4e-7b6c-7def-9abc-0123456789ab";
const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-08-27T01:02:03.004Z";

const diagnosticSummary = {
  errors: 0,
  warnings: 1,
  infos: 0,
  parserVersion: "9.1.1",
};

const revision = {
  id: REVISION_ID,
  projectId: PROJECT_ID,
  revisionNo: 1,
  source: "Table users { id int [pk] }",
  sourceHash: "source-hash",
  validity: "VALID" as const,
  origin: "SOURCE_EDIT" as const,
  parserVersion: "9.1.1",
  diagnosticSummary,
  createdAt: CREATED_AT,
};

const project = {
  id: PROJECT_ID,
  name: "Customer schema",
  primaryDialect: "POSTGRESQL" as const,
  draftSource: revision.source,
  draftHash: revision.sourceHash,
  lastValidRevisionId: REVISION_ID,
  parserVersion: "9.1.1",
  schemaRevisionNo: 1,
  layoutRevisionNo: 0,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const state = { project, currentRevision: revision, lastValidRevision: revision };

function sqlImportReport() {
  return {
    reportVersion: 1 as const,
    dialect: "POSTGRESQL" as const,
    sourceFilepath: "/import.sql",
    sourceHash: "a".repeat(64),
    parserInputHash: "a".repeat(64),
    parserVersions: { dbmlCore: "9.1.1" as const, dbmlParse: "9.1.1" as const },
    capabilityMatrixVersion: 1 as const,
    schemaSemanticsVersion: 1 as const,
    overallStatus: "EXACT" as const,
    applyEligible: true,
    candidateDbmlHash: "b".repeat(64),
    statements: [],
    diagnostics: [],
    semanticVerification: {
      status: "VERIFIED" as const,
      sourceModelHash: "b".repeat(64),
      candidateSchemaHash: "b".repeat(64),
      changes: [] as const,
    },
  };
}

const sqlImportPolicy = {
  policyVersion: 1 as const,
  dataStatementNos: [] as number[],
  dataHandling: "NOT_PRESENT" as const,
  applyReadiness: "READY" as const,
};

function sqlImportApplyResponse() {
  return {
    artifactId: "019d3f4e-7b6c-7abc-8def-0123456789ac",
    artifactStatus: "APPLIED" as const,
    previewHash: "c".repeat(64),
    appliedAt: CREATED_AT,
    policy: sqlImportPolicy,
    state,
    diagnostics: [],
    revisionCreated: true as const,
  };
}

function sqlExportResponse() {
  const hash = "d".repeat(64);
  return {
    sourceSelection: "CURRENT_DRAFT" as const,
    revisionNo: 1,
    sourceHash: hash,
    report: {
      reportVersion: 1 as const,
      exportSemanticsVersion: 1 as const,
      sourceFilepath: "/main.dbml",
      sourceHash: hash,
      parserInputHash: hash,
      primaryDialect: "POSTGRESQL" as const,
      targetDialect: "POSTGRESQL" as const,
      parserVersions: { dbmlCore: "9.1.1" as const, dbmlParse: "9.1.1" as const },
      schemaSemanticsVersion: 1 as const,
      ddlKind: "EMPTY_SCHEMA_CREATE" as const,
      overallStatus: "EXACT" as const,
      acknowledgementRequired: false,
      generatedSqlHash: hash,
      containsDataStatements: false,
      entries: [],
      diagnostics: [],
      semanticVerification: {
        status: "VERIFIED" as const,
        sourceExportableHash: hash,
        generatedExportableHash: hash,
        changes: [] as const,
      },
    },
    candidate: { sql: "CREATE TABLE users (id int);", sqlHash: hash },
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("HTTP project API", () => {
  it("posts a read-only SQL export request without generating a command ID", async () => {
    const generateCommandId = vi.fn(() => COMMAND_ID);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(sqlExportResponse()));
    const api = createHttpProjectApi({ fetch: fetcher, generateCommandId });

    await expect(
      api.exportProjectSql({
        projectId: PROJECT_ID,
        expectedSchemaRevisionNo: 1,
        sourceSelection: "CURRENT_DRAFT",
      }),
    ).resolves.toEqual(sqlExportResponse());
    expect(generateCommandId).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/projects/${PROJECT_ID}/sql-export`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          expectedSchemaRevisionNo: 1,
          sourceSelection: "CURRENT_DRAFT",
        }),
      }),
    );
  });

  it("validates list and detail responses with the shared contracts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          projects: [
            {
              id: project.id,
              name: project.name,
              primaryDialect: project.primaryDialect,
              parserVersion: project.parserVersion,
              schemaRevisionNo: project.schemaRevisionNo,
              layoutRevisionNo: project.layoutRevisionNo,
              draftValidity: revision.validity,
              diagnosticSummary,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ state }));
    const api = createHttpProjectApi({ fetch: fetcher, generateCommandId: () => COMMAND_ID });

    await expect(api.listProjects()).resolves.toMatchObject({
      projects: [{ id: PROJECT_ID, name: "Customer schema" }],
    });
    await expect(api.getProject(PROJECT_ID)).resolves.toEqual({ state });
    expect(fetcher.mock.calls.map(([input, init]) => [input, init?.method])).toEqual([
      ["/api/v1/projects", "GET"],
      [`/api/v1/projects/${PROJECT_ID}`, "GET"],
    ]);
  });

  it("sends strict write bodies and verifies the echoed command ID", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { state, diagnostics: [], revisionCreated: true },
          { status: 201, headers: { "x-command-id": COMMAND_ID } },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ state }, { status: 200, headers: { "x-command-id": COMMAND_ID } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { state, diagnostics: [], revisionCreated: true },
          { status: 201, headers: { "x-command-id": COMMAND_ID } },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { state, diagnostics: [], revisionCreated: false },
          { status: 200, headers: { "x-command-id": COMMAND_ID } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 204, headers: { "x-command-id": COMMAND_ID } }),
      );
    const api = createHttpProjectApi({ fetch: fetcher, generateCommandId: () => COMMAND_ID });

    await api.createProject({
      name: project.name,
      primaryDialect: project.primaryDialect,
      source: project.draftSource,
    });
    await api.renameProject({
      projectId: PROJECT_ID,
      name: "Renamed",
      expectedSchemaRevisionNo: 1,
    });
    await api.duplicateProject({
      sourceProjectId: PROJECT_ID,
      name: "Customer schema copy",
      expectedSchemaRevisionNo: 1,
    });
    await api.saveDraft({
      projectId: PROJECT_ID,
      source: project.draftSource,
      expectedSchemaRevisionNo: 1,
    });
    await api.deleteProject({ projectId: PROJECT_ID, expectedSchemaRevisionNo: 1 });

    expect(fetcher.mock.calls.map(([input, init]) => [input, init?.method])).toEqual([
      ["/api/v1/projects", "POST"],
      [`/api/v1/projects/${PROJECT_ID}`, "PATCH"],
      ["/api/v1/projects", "POST"],
      [`/api/v1/projects/${PROJECT_ID}/draft`, "PUT"],
      [`/api/v1/projects/${PROJECT_ID}`, "DELETE"],
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      operation: "CREATE",
      commandId: COMMAND_ID,
      name: project.name,
      primaryDialect: "POSTGRESQL",
      source: project.draftSource,
    });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      operation: "DUPLICATE",
      commandId: COMMAND_ID,
      sourceProjectId: PROJECT_ID,
      name: "Customer schema copy",
      expectedSchemaRevisionNo: 1,
    });
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({
      commandId: COMMAND_ID,
      source: project.draftSource,
      expectedSchemaRevisionNo: 1,
    });
  });

  it("loads and saves encoded per-view layouts through the shared contract", async () => {
    const viewKey = 'view:["public","focus"]';
    const layout = {
      positions: { 'table:["public","users"]': { x: 10, y: 20 } },
      collapsedGroupKeys: [],
      hiddenElementKeys: [],
      viewport: { x: 1, y: 2, zoom: 0.8 },
      detailLevel: "FULL" as const,
      baseSchemaHash: "a".repeat(64),
    };
    const savedLayout = { projectId: PROJECT_ID, viewKey, revisionNo: 1, ...layout };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ layout: null, currentLayoutRevisionNo: 0 }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            state: { layout: savedLayout, currentLayoutRevisionNo: 1 },
            layoutUpdated: true,
          },
          { status: 200, headers: { "x-command-id": COMMAND_ID } },
        ),
      );
    const api = createHttpProjectApi({ fetch: fetcher, generateCommandId: () => COMMAND_ID });

    await expect(api.getLayout({ projectId: PROJECT_ID, viewKey })).resolves.toEqual({
      layout: null,
      currentLayoutRevisionNo: 0,
    });
    await expect(
      api.saveLayout({
        projectId: PROJECT_ID,
        viewKey,
        expectedLayoutRevisionNo: 0,
        layout,
      }),
    ).resolves.toMatchObject({ layoutUpdated: true, state: { layout: savedLayout } });

    const encodedPath = `/api/v1/projects/${PROJECT_ID}/layouts/${encodeURIComponent(viewKey)}`;
    expect(fetcher.mock.calls.map(([input, init]) => [input, init?.method])).toEqual([
      [encodedPath, "GET"],
      [encodedPath, "PUT"],
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      commandId: COMMAND_ID,
      expectedLayoutRevisionNo: 0,
      layout,
    });
  });

  it("posts a caller-owned visual command and preserves replay evidence", async () => {
    const command: VisualCommand = {
      commandId: COMMAND_ID,
      expectedSchemaRevisionNo: 1,
      kind: "UPDATE_TABLE",
      targetTableKey: 'table:["public","users"]',
      changes: { note: "Reviewed" },
    };
    const response = {
      state,
      revisionCreated: false,
      layoutMigrated: false,
      replayed: true,
      appliedSchemaRevisionNo: 1,
      appliedLayoutRevisionNo: 0,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(response, {
        status: 200,
        headers: { "x-command-id": COMMAND_ID },
      }),
    );
    const api = createHttpProjectApi({ fetch: fetcher });

    await expect(api.applyVisualCommand({ projectId: PROJECT_ID, command })).resolves.toEqual(
      response,
    );
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/projects/${PROJECT_ID}/visual-commands`,
      expect.objectContaining({ method: "POST", body: JSON.stringify(command) }),
    );
  });

  it("preserves public visual diagnostics and partial impact without response text", async () => {
    const range = {
      filepath: "/main.dbml",
      startOffset: 10,
      endOffset: 20,
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: 11,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(
        {
          code: "VISUAL_COMMAND_TRANSFORM_FAILED",
          message: "The visual command could not be applied.",
          correlationId: CORRELATION_ID,
          diagnostics: [
            {
              code: "VISUAL_PARTIAL_TARGET_PROTECTED",
              message: "Edit the partial definition instead.",
              severity: "ERROR",
              range,
            },
          ],
          partialImpact: {
            partialKey: 'partial:["audit"]',
            partialName: "audit",
            partialElementKey: 'partialColumn:["audit","created_at"]',
            definitionRange: range,
            affectedTables: [
              {
                tableKey: 'table:["public","users"]',
                injectionRange: {
                  ...range,
                  startOffset: 30,
                  endOffset: 36,
                  startLine: 4,
                  endLine: 4,
                },
              },
            ],
          },
        },
        { status: 422 },
      ),
    );
    const api = createHttpProjectApi({ fetch: fetcher });

    const error = await api
      .applyVisualCommand({
        projectId: PROJECT_ID,
        command: {
          commandId: COMMAND_ID,
          expectedSchemaRevisionNo: 1,
          kind: "DELETE_COLUMN",
          targetTableKey: 'table:["public","users"]',
          targetColumnKey: 'column:["public","users","created_at"]',
        },
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProjectApiError);
    expect(error).toMatchObject({
      status: 422,
      code: "VISUAL_COMMAND_TRANSFORM_FAILED",
      diagnostics: [{ code: "VISUAL_PARTIAL_TARGET_PROTECTED", range }],
      partialImpact: { partialName: "audit" },
    });
  });

  it("previews and applies new and replacement SQL imports without automatic retries", async () => {
    const standalonePreview = {
      previewStatus: "PREVIEWED" as const,
      previewHash: "c".repeat(64),
      originalSqlRetention: "DISCARD" as const,
      report: sqlImportReport(),
      policy: sqlImportPolicy,
      candidate: { dbml: "Table users { id bigint [pk] }\n", dbmlHash: "b".repeat(64) },
    };
    const replacePreview = {
      artifactId: "019d3f4e-7b6c-7abc-8def-0123456789ac",
      artifactStatus: "PREVIEWED" as const,
      createdAt: CREATED_AT,
      baseSchemaRevisionNo: 1,
      previewHash: standalonePreview.previewHash,
      originalSqlRetention: standalonePreview.originalSqlRetention,
      report: standalonePreview.report,
      policy: standalonePreview.policy,
      candidate: standalonePreview.candidate,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(standalonePreview, {
          status: 200,
          headers: { "x-command-id": COMMAND_ID },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(sqlImportApplyResponse(), {
          status: 201,
          headers: { "x-command-id": COMMAND_ID },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(replacePreview, {
          status: 200,
          headers: { "x-command-id": COMMAND_ID },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(sqlImportApplyResponse(), {
          status: 200,
          headers: { "x-command-id": COMMAND_ID },
        }),
      );
    const api = createHttpProjectApi({ fetch: fetcher, generateCommandId: () => COMMAND_ID });
    const source = "CREATE TABLE users (id bigint PRIMARY KEY);";

    await api.previewStandaloneSqlImport({ dialect: "POSTGRESQL", source });
    await api.createProjectFromSqlImport({
      name: "Imported",
      primaryDialect: "POSTGRESQL",
      source,
      previewHash: standalonePreview.previewHash,
    });
    await api.previewProjectSqlImport({
      projectId: PROJECT_ID,
      expectedSchemaRevisionNo: 1,
      dialect: "POSTGRESQL",
      source,
    });
    await api.applyProjectSqlImport({
      projectId: PROJECT_ID,
      expectedSchemaRevisionNo: 1,
      artifactId: replacePreview.artifactId,
      previewHash: replacePreview.previewHash,
      source,
    });

    expect(fetcher.mock.calls.map(([input, init]) => [input, init?.method])).toEqual([
      ["/api/v1/sql-import/preview", "POST"],
      ["/api/v1/projects", "POST"],
      [`/api/v1/projects/${PROJECT_ID}/sql-import/preview`, "POST"],
      [`/api/v1/projects/${PROJECT_ID}/sql-import/apply`, "POST"],
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      operation: "CREATE_FROM_SQL_IMPORT",
      commandId: COMMAND_ID,
      name: "Imported",
      primaryDialect: "POSTGRESQL",
      source,
      previewHash: standalonePreview.previewHash,
    });
  });

  it.each([400, 404, 409, 413, 422, 500])(
    "preserves the safe public error boundary for HTTP %s",
    async (status) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            code: status === 409 ? "PROJECT_SCHEMA_REVISION_CONFLICT" : "REQUEST_FAILED",
            message: "The request could not be completed.",
            correlationId: CORRELATION_ID,
            ...(status === 409 ? { currentRevisionNo: 2 } : {}),
          },
          { status },
        ),
      );
      const api = createHttpProjectApi({ fetch: fetcher, generateCommandId: () => COMMAND_ID });

      const error = await api.listProjects().catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ProjectApiError);
      expect(error).toMatchObject({
        status,
        correlationId: CORRELATION_ID,
        ...(status === 409 ? { currentRevisionNo: 2 } : {}),
      });
    },
  );

  it("fails closed for malformed payloads, command echoes, and network errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ projects: [{ leaked: true }] }))
      .mockResolvedValueOnce(
        jsonResponse(
          { state, diagnostics: [], revisionCreated: true },
          { status: 201, headers: { "x-command-id": "wrong-command" } },
        ),
      )
      .mockRejectedValueOnce(new Error("private network detail"));
    const api = createHttpProjectApi({ fetch: fetcher, generateCommandId: () => COMMAND_ID });

    await expect(api.listProjects()).rejects.toMatchObject({ code: "CLIENT_CONTRACT_ERROR" });
    await expect(
      api.createProject({ name: "Schema", primaryDialect: "MYSQL", source: "" }),
    ).rejects.toMatchObject({ code: "CLIENT_COMMAND_ID_MISMATCH" });
    await expect(api.listProjects()).rejects.toMatchObject({
      code: "CLIENT_NETWORK_ERROR",
      message: "The server could not be reached.",
    });
  });
});
