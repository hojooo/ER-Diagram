import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  errorResponseSchema,
  projectMutationResponseSchema,
  projectResponseSchema,
  projectRevisionsResponseSchema,
  projectsResponseSchema,
} from "@er-diagram/contracts";
import {
  createLayoutApplication,
  createProjectApplication,
  type LayoutApplication,
  type ProjectApplication,
  type SqlExportApplication,
  type SqlImportApplication,
  type VisualCommandApplication,
} from "@er-diagram/core";
import {
  createSqliteLayoutRepository,
  createSqliteProjectRepository,
  generateUuidV7,
  openSqliteStorage,
  type SqliteStorage,
  toUtcIsoTimestamp,
} from "@er-diagram/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../src/index.js";

const VALID_SOURCE = "Table users { id int [pk] }";
const OTHER_VALID_SOURCE = "Table users { id int [pk]\n email varchar }";
const INVALID_SOURCE = "Table users {";
const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";
const MISSING_PROJECT_ID = "019d3f4e-7b6c-7abc-8def-ffffffffffff";
const SENSITIVE_SOURCE = "Table private_customer_data { secret varchar }";

const temporaryDirectories = new Set<string>();
const openStorages = new Set<SqliteStorage>();
const openServers = new Set<ReturnType<typeof createServer>>();

interface ServerFixture {
  readonly application: ProjectApplication;
  readonly filename: string;
  readonly server: ReturnType<typeof createServer>;
  readonly storage: SqliteStorage;
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-server-projects-test-"));
  temporaryDirectories.add(directory);
  return path.join(directory, "er-diagram.sqlite");
}

function trackedStorage(filename: string): SqliteStorage {
  const storage = openSqliteStorage({ filename });
  openStorages.add(storage);
  return storage;
}

function applicationFor(storage: SqliteStorage): ProjectApplication {
  let epochMs = Date.parse("2026-08-27T01:02:03.000Z");
  return createProjectApplication({
    persistence: createSqliteProjectRepository(storage),
    generateId: generateUuidV7,
    now: () => toUtcIsoTimestamp(epochMs++),
  });
}

function correlationGenerator(): () => string {
  let sequence = 0;
  return () => `123e4567-e89b-42d3-a456-${(++sequence).toString(16).padStart(12, "0")}`;
}

function trackedServer(
  application: ProjectApplication,
  layoutApplication = {} as LayoutApplication,
): ReturnType<typeof createServer> {
  const server = createServer({
    projectApplication: application,
    layoutApplication,
    sqlImportApplication: {} as SqlImportApplication,
    sqlExportApplication: {} as SqlExportApplication,
    visualCommandApplication: {} as VisualCommandApplication,
    generateCorrelationId: correlationGenerator(),
  });
  openServers.add(server);
  return server;
}

function createFixture(filename = temporaryDatabasePath()): ServerFixture {
  const storage = trackedStorage(filename);
  const application = applicationFor(storage);
  return {
    application,
    filename,
    server: trackedServer(
      application,
      createLayoutApplication({ persistence: createSqliteLayoutRepository(storage) }),
    ),
    storage,
  };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await server.close();
  openServers.delete(server);
}

function closeStorage(storage: SqliteStorage): void {
  storage.close();
  openStorages.delete(storage);
}

async function createProject(
  server: ReturnType<typeof createServer>,
  source = VALID_SOURCE,
  name = "Schema",
) {
  const response = await server.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: {
      operation: "CREATE",
      commandId: COMMAND_ID,
      name,
      primaryDialect: "POSTGRESQL",
      source,
    },
  });
  expect(response.statusCode).toBe(201);
  expect(response.headers["x-command-id"]).toBe(COMMAND_ID);
  return projectMutationResponseSchema.parse(response.json());
}

function expectError(
  response: { headers: Record<string, unknown>; json(): unknown },
  code: string,
) {
  const body = errorResponseSchema.parse(response.json());
  expect(body.code).toBe(code);
  expect(response.headers["x-correlation-id"]).toBe(body.correlationId);
  return body;
}

afterEach(async () => {
  await Promise.all([...openServers].map((server) => server.close()));
  openServers.clear();
  for (const storage of openStorages) storage.close();
  openStorages.clear();
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true });
  temporaryDirectories.clear();
});

describe("project Fastify API", () => {
  it("generates an untrusted-input-independent correlation ID for every response", async () => {
    const { server } = createFixture();

    const first = await server.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "caller-controlled" },
    });
    const second = await server.inject({ method: "GET", url: "/health/live" });

    expect(first.statusCode).toBe(200);
    expect(first.headers["x-correlation-id"]).toBe("123e4567-e89b-42d3-a456-000000000001");
    expect(second.headers["x-correlation-id"]).toBe("123e4567-e89b-42d3-a456-000000000002");
    expect(first.headers["x-correlation-id"]).not.toBe("caller-controlled");
  });

  it("creates valid and invalid projects and returns contract-validated list and state", async () => {
    const { server } = createFixture();

    const valid = await createProject(server, VALID_SOURCE, "Valid schema");
    const invalid = await createProject(server, INVALID_SOURCE, "Invalid schema");

    expect(valid.state.currentRevision.validity).toBe("VALID");
    expect(invalid.state.currentRevision.validity).toBe("INVALID");
    expect(invalid.state.project.draftSource).toBe(INVALID_SOURCE);
    expect(invalid.diagnostics.some(({ severity }) => severity === "ERROR")).toBe(true);

    const listResponse = await server.inject({ method: "GET", url: "/api/v1/projects" });
    expect(listResponse.statusCode).toBe(200);
    const listed = projectsResponseSchema.parse(listResponse.json());
    expect(listed.projects.map(({ id }) => id).toSorted()).toEqual(
      [valid.state.project.id, invalid.state.project.id].toSorted(),
    );

    const getResponse = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${valid.state.project.id}`,
    });
    expect(getResponse.statusCode).toBe(200);
    expect(projectResponseSchema.parse(getResponse.json()).state.project.draftSource).toBe(
      VALID_SOURCE,
    );
  });

  it("renames, saves drafts, preserves last-valid state, and returns source-free history", async () => {
    const { server } = createFixture();
    const created = await createProject(server);
    const projectId = created.state.project.id;

    for (const name of ["First name", "Second name"]) {
      const response = await server.inject({
        method: "PATCH",
        url: `/api/v1/projects/${projectId}`,
        payload: { commandId: COMMAND_ID, name, expectedSchemaRevisionNo: 1 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-command-id"]).toBe(COMMAND_ID);
      expect(projectResponseSchema.parse(response.json()).state.project).toMatchObject({
        name,
        schemaRevisionNo: 1,
      });
    }

    const invalidResponse = await server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/draft`,
      payload: {
        commandId: COMMAND_ID,
        source: INVALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      },
    });
    expect(invalidResponse.statusCode).toBe(200);
    expect(invalidResponse.headers["x-command-id"]).toBe(COMMAND_ID);
    const invalid = projectMutationResponseSchema.parse(invalidResponse.json());
    expect(invalid.state.currentRevision.validity).toBe("INVALID");
    expect(invalid.state.lastValidRevision?.revisionNo).toBe(1);

    const noOpResponse = await server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/draft`,
      payload: {
        commandId: COMMAND_ID,
        source: INVALID_SOURCE,
        expectedSchemaRevisionNo: 2,
      },
    });
    const noOp = projectMutationResponseSchema.parse(noOpResponse.json());
    expect(noOp.revisionCreated).toBe(false);
    expect(noOp.state.project.schemaRevisionNo).toBe(2);

    const recoveredResponse = await server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/draft`,
      payload: {
        commandId: COMMAND_ID,
        source: OTHER_VALID_SOURCE,
        expectedSchemaRevisionNo: 2,
      },
    });
    const recovered = projectMutationResponseSchema.parse(recoveredResponse.json());
    expect(recovered.state.currentRevision.validity).toBe("VALID");
    expect(recovered.state.project.schemaRevisionNo).toBe(3);

    const revisionsResponse = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/revisions`,
    });
    const revisions = projectRevisionsResponseSchema.parse(revisionsResponse.json()).revisions;
    expect(revisions.map(({ revisionNo }) => revisionNo)).toEqual([3, 2, 1]);
    expect(revisions.every((revision) => !("source" in revision))).toBe(true);
  });

  it("rebases valid, invalid with last-valid, and invalid-only duplicates", async () => {
    const { server } = createFixture();
    const validSource = await createProject(server, VALID_SOURCE, "Valid source");

    const validDuplicateResponse = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        operation: "DUPLICATE",
        commandId: COMMAND_ID,
        sourceProjectId: validSource.state.project.id,
        name: "Valid copy",
        expectedSchemaRevisionNo: 1,
      },
    });
    expect(validDuplicateResponse.statusCode).toBe(201);
    expect(validDuplicateResponse.headers["x-command-id"]).toBe(COMMAND_ID);
    expect(
      projectMutationResponseSchema.parse(validDuplicateResponse.json()).state.currentRevision
        .revisionNo,
    ).toBe(1);

    const invalidDraftResponse = await server.inject({
      method: "PUT",
      url: `/api/v1/projects/${validSource.state.project.id}/draft`,
      payload: {
        commandId: COMMAND_ID,
        source: INVALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      },
    });
    expect(invalidDraftResponse.statusCode).toBe(200);

    const mixedDuplicateResponse = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        operation: "DUPLICATE",
        commandId: COMMAND_ID,
        sourceProjectId: validSource.state.project.id,
        name: "Mixed copy",
        expectedSchemaRevisionNo: 2,
      },
    });
    const mixed = projectMutationResponseSchema.parse(mixedDuplicateResponse.json());
    expect(mixed.state.currentRevision).toMatchObject({ revisionNo: 2, validity: "INVALID" });
    expect(mixed.state.lastValidRevision).toMatchObject({ revisionNo: 1, validity: "VALID" });

    const invalidOnly = await createProject(server, INVALID_SOURCE, "Invalid only");
    const invalidOnlyDuplicateResponse = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        operation: "DUPLICATE",
        commandId: COMMAND_ID,
        sourceProjectId: invalidOnly.state.project.id,
        name: "Invalid-only copy",
        expectedSchemaRevisionNo: 1,
      },
    });
    const invalidCopy = projectMutationResponseSchema.parse(invalidOnlyDuplicateResponse.json());
    expect(invalidCopy.state.currentRevision).toMatchObject({ revisionNo: 1, validity: "INVALID" });
    expect(invalidCopy.state.lastValidRevision).toBeNull();
  });

  it("restores a revision, recovers after reopen, and deletes the project", async () => {
    const fixture = createFixture();
    const created = await createProject(fixture.server);
    const projectId = created.state.project.id;
    await fixture.server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/draft`,
      payload: {
        commandId: COMMAND_ID,
        source: INVALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      },
    });

    const restoreResponse = await fixture.server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/revisions/1/restore`,
      payload: { commandId: COMMAND_ID, expectedSchemaRevisionNo: 2 },
    });
    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.headers["x-command-id"]).toBe(COMMAND_ID);
    const restored = projectMutationResponseSchema.parse(restoreResponse.json());
    expect(restored.state.currentRevision).toMatchObject({
      revisionNo: 3,
      validity: "VALID",
      origin: "RESTORE",
      source: VALID_SOURCE,
    });

    const missingRevisionResponse = await fixture.server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/revisions/999/restore`,
      payload: { commandId: COMMAND_ID, expectedSchemaRevisionNo: 3 },
    });
    expect(missingRevisionResponse.statusCode).toBe(404);
    expectError(missingRevisionResponse, "PROJECT_REVISION_NOT_FOUND");

    await closeServer(fixture.server);
    closeStorage(fixture.storage);
    const reopened = createFixture(fixture.filename);
    const recoveredResponse = await reopened.server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
    });
    expect(projectResponseSchema.parse(recoveredResponse.json()).state.currentRevision.source).toBe(
      VALID_SOURCE,
    );

    const deleteResponse = await reopened.server.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}`,
      payload: { commandId: COMMAND_ID, expectedSchemaRevisionNo: 3 },
    });
    expect(deleteResponse.statusCode).toBe(204);
    expect(deleteResponse.body).toBe("");
    expect(deleteResponse.headers["x-command-id"]).toBe(COMMAND_ID);

    const deletedResponse = await reopened.server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
    });
    expect(deletedResponse.statusCode).toBe(404);
  });

  it("rejects every stale project mutation without changing current state", async () => {
    const { server } = createFixture();
    const created = await createProject(server);
    const projectId = created.state.project.id;
    await server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/draft`,
      payload: {
        commandId: COMMAND_ID,
        source: OTHER_VALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      },
    });

    const staleRequests = [
      {
        method: "PUT" as const,
        url: `/api/v1/projects/${projectId}/draft`,
        payload: {
          commandId: COMMAND_ID,
          source: INVALID_SOURCE,
          expectedSchemaRevisionNo: 1,
        },
      },
      {
        method: "PATCH" as const,
        url: `/api/v1/projects/${projectId}`,
        payload: { commandId: COMMAND_ID, name: "Stale", expectedSchemaRevisionNo: 1 },
      },
      {
        method: "DELETE" as const,
        url: `/api/v1/projects/${projectId}`,
        payload: { commandId: COMMAND_ID, expectedSchemaRevisionNo: 1 },
      },
      {
        method: "POST" as const,
        url: "/api/v1/projects",
        payload: {
          operation: "DUPLICATE",
          commandId: COMMAND_ID,
          sourceProjectId: projectId,
          name: "Stale copy",
          expectedSchemaRevisionNo: 1,
        },
      },
      {
        method: "POST" as const,
        url: `/api/v1/projects/${projectId}/revisions/1/restore`,
        payload: { commandId: COMMAND_ID, expectedSchemaRevisionNo: 1 },
      },
    ];

    for (const request of staleRequests) {
      const response = await server.inject(request);
      expect(response.statusCode).toBe(409);
      expect(expectError(response, "PROJECT_SCHEMA_REVISION_CONFLICT").currentRevisionNo).toBe(2);
    }

    const stateResponse = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
    });
    const state = projectResponseSchema.parse(stateResponse.json()).state;
    expect(state.project).toMatchObject({ name: "Schema", schemaRevisionNo: 2 });
    expect(state.project.draftSource).toBe(OTHER_VALID_SOURCE);

    const listResponse = await server.inject({ method: "GET", url: "/api/v1/projects" });
    expect(projectsResponseSchema.parse(listResponse.json()).projects).toHaveLength(1);
  });

  it("maps malformed requests, missing resources, and blank names consistently", async () => {
    const { server } = createFixture();

    const malformedId = await server.inject({
      method: "GET",
      url: "/api/v1/projects/not-a-uuid",
    });
    expect(malformedId.statusCode).toBe(400);
    expectError(malformedId, "REQUEST_VALIDATION_FAILED");

    const invalidCreate = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        operation: "CREATE",
        commandId: "not-a-uuid",
        name: "Schema",
        primaryDialect: "SQLITE",
        source: "",
        unknown: true,
      },
    });
    expect(invalidCreate.statusCode).toBe(400);
    expectError(invalidCreate, "REQUEST_VALIDATION_FAILED");

    const malformedJson = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(malformedJson.statusCode).toBe(400);
    expectError(malformedJson, "REQUEST_VALIDATION_FAILED");

    const blankName = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        operation: "CREATE",
        commandId: COMMAND_ID,
        name: " \n ",
        primaryDialect: "MYSQL",
        source: "",
      },
    });
    expect(blankName.statusCode).toBe(422);
    expectError(blankName, "PROJECT_NAME_INVALID");

    const missing = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${MISSING_PROJECT_ID}`,
    });
    expect(missing.statusCode).toBe(404);
    expectError(missing, "PROJECT_NOT_FOUND");

    const missingRoute = await server.inject({ method: "GET", url: "/api/v1/missing" });
    expect(missingRoute.statusCode).toBe(404);
    expectError(missingRoute, "ROUTE_NOT_FOUND");

    const oversized = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        operation: "CREATE",
        commandId: COMMAND_ID,
        name: "Too large",
        primaryDialect: "POSTGRESQL",
        source: "x".repeat(1_100_000),
      },
    });
    expect(oversized.statusCode).toBe(413);
    expectError(oversized, "REQUEST_BODY_TOO_LARGE");
  });

  it("redacts unexpected application failures from the public error response", async () => {
    const fixture = createFixture();
    const failingApplication: ProjectApplication = {
      ...fixture.application,
      listProjects: async () => {
        throw new Error(`Storage failed while reading ${SENSITIVE_SOURCE}`);
      },
    };
    const server = trackedServer(failingApplication);

    const response = await server.inject({ method: "GET", url: "/api/v1/projects" });

    expect(response.statusCode).toBe(500);
    const error = expectError(response, "INTERNAL_SERVER_ERROR");
    expect(error.message).toBe("An unexpected server error occurred.");
    expect(response.body).not.toContain(SENSITIVE_SOURCE);

    const invariantApplication: ProjectApplication = {
      ...fixture.application,
      getProject: async (projectId) => ({
        ok: false,
        error: {
          code: "PROJECT_STORAGE_INVARIANT_VIOLATION",
          message: `Invalid stored source: ${SENSITIVE_SOURCE}`,
          projectId,
        },
      }),
    };
    const invariantServer = trackedServer(invariantApplication);
    const invariantResponse = await invariantServer.inject({
      method: "GET",
      url: `/api/v1/projects/${MISSING_PROJECT_ID}`,
    });
    expect(invariantResponse.statusCode).toBe(500);
    expectError(invariantResponse, "PROJECT_STORAGE_INVARIANT_VIOLATION");
    expect(invariantResponse.body).not.toContain(SENSITIVE_SOURCE);
  });
});
