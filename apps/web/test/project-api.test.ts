import { describe, expect, it, vi } from "vitest";

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

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("HTTP project API", () => {
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
