import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  errorResponseSchema,
  layoutMutationResponseSchema,
  layoutResponseSchema,
  projectMutationResponseSchema,
} from "@er-diagram/contracts";
import {
  createLayoutApplication,
  createProjectApplication,
  type ProjectBundleApplication,
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

const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";
const MISSING_PROJECT_ID = "019d3f4e-7b6c-7abc-8def-ffffffffffff";
const HASH = "a".repeat(64);
const temporaryDirectories = new Set<string>();
const resources: Array<{ server: ReturnType<typeof createServer>; storage: SqliteStorage }> = [];

function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-server-layout-test-"));
  temporaryDirectories.add(directory);
  const storage = openSqliteStorage({ filename: path.join(directory, "er-diagram.sqlite") });
  let epochMs = Date.parse("2026-08-27T01:02:03.000Z");
  const projectApplication = createProjectApplication({
    persistence: createSqliteProjectRepository(storage),
    generateId: generateUuidV7,
    now: () => toUtcIsoTimestamp(epochMs++),
  });
  const server = createServer({
    projectApplication,
    layoutApplication: createLayoutApplication({
      persistence: createSqliteLayoutRepository(storage),
    }),
    sqlImportApplication: {} as SqlImportApplication,
    sqlExportApplication: {} as SqlExportApplication,
    visualCommandApplication: {} as VisualCommandApplication,
    projectBundleApplication: {} as ProjectBundleApplication,
    generateCorrelationId: () => "123e4567-e89b-42d3-a456-426614174001",
  });
  resources.push({ server, storage });
  return server;
}

async function createProject(server: ReturnType<typeof createServer>): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: {
      operation: "CREATE",
      commandId: COMMAND_ID,
      name: "Layout project",
      primaryDialect: "POSTGRESQL",
      source: "Table users { id int [pk] }",
    },
  });
  return projectMutationResponseSchema.parse(response.json()).state.project.id;
}

function layout(viewport = { x: 1, y: 2, zoom: 1 }) {
  return {
    positions: { 'table:["public","users"]': { x: 10, y: 20 } },
    collapsedGroupKeys: [],
    hiddenElementKeys: [],
    viewport,
    detailLevel: "FULL",
    baseSchemaHash: HASH,
  };
}

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ server, storage }) => {
      await server.close();
      storage.close();
    }),
  );
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe("layout Fastify API", () => {
  it("returns null for a new view and persists project-global layout revisions", async () => {
    const server = createFixture();
    const projectId = await createProject(server);
    const empty = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/layouts/GLOBAL`,
    });
    expect(empty.statusCode).toBe(200);
    expect(layoutResponseSchema.parse(empty.json())).toEqual({
      layout: null,
      currentLayoutRevisionNo: 0,
    });

    const saved = await server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/layouts/GLOBAL`,
      payload: { commandId: COMMAND_ID, expectedLayoutRevisionNo: 0, layout: layout() },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers["x-command-id"]).toBe(COMMAND_ID);
    expect(layoutMutationResponseSchema.parse(saved.json())).toMatchObject({
      layoutUpdated: true,
      state: { currentLayoutRevisionNo: 1, layout: { revisionNo: 1 } },
    });

    const viewKey = encodeURIComponent('view:["public","focus"]');
    const view = await server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/layouts/${viewKey}`,
      payload: {
        commandId: COMMAND_ID,
        expectedLayoutRevisionNo: 1,
        layout: layout({ x: 30, y: 40, zoom: 0.8 }),
      },
    });
    expect(layoutMutationResponseSchema.parse(view.json()).state.currentLayoutRevisionNo).toBe(2);
    const global = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/layouts/GLOBAL`,
    });
    expect(layoutResponseSchema.parse(global.json())).toMatchObject({
      currentLayoutRevisionNo: 2,
      layout: { revisionNo: 1, viewport: { x: 1, y: 2, zoom: 1 } },
    });
  });

  it("returns a redacted 409 without changing the target view", async () => {
    const server = createFixture();
    const projectId = await createProject(server);
    await server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/layouts/GLOBAL`,
      payload: { commandId: COMMAND_ID, expectedLayoutRevisionNo: 0, layout: layout() },
    });
    const stale = await server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/layouts/other`,
      payload: { commandId: COMMAND_ID, expectedLayoutRevisionNo: 0, layout: layout() },
    });
    expect(stale.statusCode).toBe(409);
    expect(errorResponseSchema.parse(stale.json())).toMatchObject({
      code: "LAYOUT_REVISION_CONFLICT",
      currentRevisionNo: 1,
    });
    const other = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/layouts/other`,
    });
    expect(layoutResponseSchema.parse(other.json()).layout).toBeNull();
  });

  it("validates paths and bodies and returns a redacted not-found error", async () => {
    const server = createFixture();
    const invalid = await server.inject({
      method: "PUT",
      url: `/api/v1/projects/${MISSING_PROJECT_ID}/layouts/GLOBAL`,
      payload: {
        commandId: COMMAND_ID,
        expectedLayoutRevisionNo: 0,
        layout: { ...layout(), viewport: { x: 0, y: 0, zoom: "secret-source" } },
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(JSON.stringify(invalid.json())).not.toContain("secret-source");

    const missing = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${MISSING_PROJECT_ID}/layouts/GLOBAL`,
    });
    expect(missing.statusCode).toBe(404);
    const error = errorResponseSchema.parse(missing.json());
    expect(error.code).toBe("LAYOUT_PROJECT_NOT_FOUND");
    expect(missing.headers["x-correlation-id"]).toBe(error.correlationId);
  });
});
