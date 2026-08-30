import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  errorResponseSchema,
  projectMutationResponseSchema,
  sqlExportResponseSchema,
} from "@er-diagram/contracts";
import {
  createLayoutApplication,
  createProjectApplication,
  createSqlExportApplication,
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

const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_SOURCE = `Table users { id int [pk] }
TableGroup core { users }`;
const INVALID_SOURCE = `${VALID_SOURCE}\nTable broken {`;
const resources: Array<{ server: ReturnType<typeof createServer>; storage: SqliteStorage }> = [];
const directories = new Set<string>();

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-sql-export-"));
  directories.add(directory);
  const storage = openSqliteStorage({ filename: path.join(directory, "er-diagram.sqlite") });
  const projectRepository = createSqliteProjectRepository(storage);
  let epoch = Date.parse("2026-08-29T00:00:00.000Z");
  const server = createServer({
    projectApplication: createProjectApplication({
      persistence: projectRepository,
      generateId: generateUuidV7,
      now: () => toUtcIsoTimestamp(epoch++),
    }),
    layoutApplication: createLayoutApplication({
      persistence: createSqliteLayoutRepository(storage),
    }),
    sqlImportApplication: {} as SqlImportApplication,
    sqlExportApplication: createSqlExportApplication({ persistence: projectRepository }),
    visualCommandApplication: {} as VisualCommandApplication,
    generateCorrelationId: () => "123e4567-e89b-42d3-a456-426614174001",
  });
  resources.push({ server, storage });
  return server;
}

async function createProject(server: ReturnType<typeof createServer>) {
  const response = await server.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: {
      operation: "CREATE",
      commandId: COMMAND_ID,
      name: "Export schema",
      primaryDialect: "POSTGRESQL",
      source: VALID_SOURCE,
    },
  });
  return projectMutationResponseSchema.parse(response.json());
}

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ server, storage }) => {
      await server.close();
      storage.close();
    }),
  );
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

describe("SQL export Fastify API", () => {
  it("returns same-dialect DDL and a contract-validated loss report without command echo", async () => {
    const server = fixture();
    const created = await createProject(server);
    const response = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${created.state.project.id}/sql-export`,
      payload: { expectedSchemaRevisionNo: 1, sourceSelection: "CURRENT_DRAFT" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-command-id"]).toBeUndefined();
    const exported = sqlExportResponseSchema.parse(response.json());
    expect(exported).toMatchObject({
      sourceSelection: "CURRENT_DRAFT",
      revisionNo: 1,
      report: {
        primaryDialect: "POSTGRESQL",
        targetDialect: "POSTGRESQL",
        acknowledgementRequired: true,
      },
    });
    expect(exported.candidate?.sql).toContain("This is not a migration");
  });

  it("blocks invalid current drafts and exports the explicitly selected last-valid revision", async () => {
    const server = fixture();
    const created = await createProject(server);
    const projectId = created.state.project.id;
    const saved = await server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/draft`,
      payload: {
        commandId: COMMAND_ID,
        source: INVALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      },
    });
    expect(saved.statusCode).toBe(200);

    const blocked = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-export`,
      payload: { expectedSchemaRevisionNo: 2, sourceSelection: "CURRENT_DRAFT" },
    });
    expect(blocked.statusCode).toBe(422);
    expect(errorResponseSchema.parse(blocked.json()).code).toBe("SQL_EXPORT_CURRENT_DRAFT_INVALID");

    const lastValid = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-export`,
      payload: { expectedSchemaRevisionNo: 2, sourceSelection: "LAST_VALID" },
    });
    expect(lastValid.statusCode).toBe(200);
    expect(sqlExportResponseSchema.parse(lastValid.json())).toMatchObject({
      sourceSelection: "LAST_VALID",
      revisionNo: 1,
      candidate: expect.any(Object),
    });
  });

  it("maps stale and malformed requests through the shared error contract", async () => {
    const server = fixture();
    const created = await createProject(server);
    const url = `/api/v1/projects/${created.state.project.id}/sql-export`;
    const stale = await server.inject({
      method: "POST",
      url,
      payload: { expectedSchemaRevisionNo: 99, sourceSelection: "CURRENT_DRAFT" },
    });
    expect(stale.statusCode).toBe(409);
    expect(errorResponseSchema.parse(stale.json())).toMatchObject({
      code: "SQL_EXPORT_SCHEMA_REVISION_CONFLICT",
      currentRevisionNo: 1,
    });

    const malformed = await server.inject({
      method: "POST",
      url,
      payload: {
        expectedSchemaRevisionNo: 1,
        sourceSelection: "CURRENT_DRAFT",
        commandId: COMMAND_ID,
      },
    });
    expect(malformed.statusCode).toBe(400);
    expect(errorResponseSchema.parse(malformed.json()).code).toBe("REQUEST_VALIDATION_FAILED");
  });
});
