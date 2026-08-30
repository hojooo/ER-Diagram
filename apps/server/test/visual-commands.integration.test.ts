import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  errorResponseSchema,
  layoutMutationResponseSchema,
  layoutResponseSchema,
  projectMutationResponseSchema,
  projectResponseSchema,
  projectRevisionsResponseSchema,
  visualCommandMutationResponseSchema,
} from "@er-diagram/contracts";
import {
  createLayoutApplication,
  createProjectApplication,
  createVisualCommandApplication,
  qualifiedElementKey,
  type SqlExportApplication,
  type SqlImportApplication,
} from "@er-diagram/core";
import { transformVisualCommand } from "@er-diagram/source-transform";
import {
  createSqliteLayoutRepository,
  createSqliteProjectRepository,
  createSqliteVisualCommandRepository,
  generateUuidV7,
  openSqliteStorage,
  type SqliteStorage,
  toUtcIsoTimestamp,
} from "@er-diagram/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../src/index.js";

const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";
const SECOND_COMMAND_ID = "550e8400-e29b-41d4-a716-446655440001";
const THIRD_COMMAND_ID = "550e8400-e29b-41d4-a716-446655440002";
const RENAME_COMMAND_ID = "550e8400-e29b-41d4-a716-446655440003";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174001";
const MISSING_PROJECT_ID = "019d3f4e-7b6c-7abc-8def-ffffffffffff";
const USERS_KEY = qualifiedElementKey("table", "public", "users");
const ACCOUNTS_KEY = qualifiedElementKey("table", "public", "accounts");
const POSTS_KEY = qualifiedElementKey("table", "public", "posts");
const INJECTED_COLUMN_KEY = qualifiedElementKey("column", "public", "posts", "created_at");
const VALID_SOURCE = `Table users {
  id int [pk]
}
`;
const PARTIAL_SOURCE = `// SECRET_CANONICAL_SOURCE_SENTINEL
TablePartial audit_fields {
  created_at timestamp
}

Table public.posts {
  ~audit_fields
  id bigint [pk]
}

Table public.comments {
  ~audit_fields
  id bigint [pk]
}
`;

interface TestResource {
  readonly filename: string;
  readonly server: ReturnType<typeof createServer>;
  readonly storage: SqliteStorage;
}

const directories = new Set<string>();
const resources = new Set<TestResource>();

function databasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-visual-api-"));
  directories.add(directory);
  return path.join(directory, "er-diagram.sqlite");
}

function createFixture(filename = databasePath()): TestResource {
  const storage = openSqliteStorage({ filename });
  let epochMs = Date.parse("2026-08-30T03:00:00.000Z");
  const now = () => toUtcIsoTimestamp(epochMs++);
  const server = createServer({
    projectApplication: createProjectApplication({
      persistence: createSqliteProjectRepository(storage),
      generateId: generateUuidV7,
      now,
    }),
    layoutApplication: createLayoutApplication({
      persistence: createSqliteLayoutRepository(storage),
    }),
    sqlImportApplication: {} as SqlImportApplication,
    sqlExportApplication: {} as SqlExportApplication,
    visualCommandApplication: createVisualCommandApplication({
      persistence: createSqliteVisualCommandRepository(storage),
      transform: transformVisualCommand,
      generateId: generateUuidV7,
      now,
    }),
    generateCorrelationId: () => CORRELATION_ID,
  });
  const resource = { filename, server, storage };
  resources.add(resource);
  return resource;
}

async function closeResource(resource: TestResource): Promise<void> {
  if (!resources.delete(resource)) return;
  await resource.server.close();
  resource.storage.close();
}

afterEach(async () => {
  await Promise.all([...resources].map(closeResource));
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

async function createProject(
  server: ReturnType<typeof createServer>,
  source = VALID_SOURCE,
  name = "Visual schema",
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
  return projectMutationResponseSchema.parse(response.json());
}

function createColumnCommand(commandId = COMMAND_ID, expectedSchemaRevisionNo = 1, name = "email") {
  return {
    commandId,
    expectedSchemaRevisionNo,
    kind: "CREATE_COLUMN",
    targetTableKey: USERS_KEY,
    column: {
      name,
      type: "varchar",
      primaryKey: false,
      unique: false,
      notNull: false,
      default: null,
      increment: false,
      note: null,
    },
  };
}

function renameTableCommand(commandId = RENAME_COMMAND_ID) {
  return {
    commandId,
    expectedSchemaRevisionNo: 1,
    kind: "RENAME_TABLE",
    targetTableKey: USERS_KEY,
    newName: "accounts",
  };
}

async function saveLayout(
  server: ReturnType<typeof createServer>,
  projectId: string,
  positions: Record<string, { x: number; y: number }>,
) {
  const response = await server.inject({
    method: "PUT",
    url: `/api/v1/projects/${projectId}/layouts/GLOBAL`,
    payload: {
      commandId: SECOND_COMMAND_ID,
      expectedLayoutRevisionNo: 0,
      layout: {
        positions,
        collapsedGroupKeys: [],
        hiddenElementKeys: [USERS_KEY],
        viewport: { x: 0, y: 0, zoom: 1 },
        detailLevel: "FULL",
        baseSchemaHash: "a".repeat(64),
      },
    },
  });
  expect(response.statusCode).toBe(200);
  return layoutMutationResponseSchema.parse(response.json());
}

describe("visual command Fastify API", () => {
  it("applies, replays, and rejects idempotency or revision conflicts after reopen", async () => {
    const first = createFixture();
    const created = await createProject(first.server);
    const projectId = created.state.project.id;
    const url = `/api/v1/projects/${projectId}/visual-commands`;

    const appliedResponse = await first.server.inject({
      method: "POST",
      url,
      payload: createColumnCommand(),
    });
    expect(appliedResponse.statusCode).toBe(200);
    expect(appliedResponse.headers["x-command-id"]).toBe(COMMAND_ID);
    const applied = visualCommandMutationResponseSchema.parse(appliedResponse.json());
    expect(applied).toMatchObject({
      replayed: false,
      revisionCreated: true,
      layoutMigrated: false,
      appliedSchemaRevisionNo: 2,
      appliedLayoutRevisionNo: 0,
      state: {
        project: { schemaRevisionNo: 2 },
        currentRevision: { origin: "VISUAL_COMMAND", validity: "VALID" },
      },
    });
    expect(applied.state.project.draftSource).toContain("email varchar");

    const replayResponse = await first.server.inject({
      method: "POST",
      url,
      payload: createColumnCommand(),
    });
    expect(replayResponse.statusCode).toBe(200);
    expect(visualCommandMutationResponseSchema.parse(replayResponse.json())).toMatchObject({
      replayed: true,
      revisionCreated: true,
      appliedSchemaRevisionNo: 2,
      state: { project: { schemaRevisionNo: 2 } },
    });

    const reused = await first.server.inject({
      method: "POST",
      url,
      payload: createColumnCommand(COMMAND_ID, 1, "other"),
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.headers["x-command-id"]).toBe(COMMAND_ID);
    expect(errorResponseSchema.parse(reused.json())).toMatchObject({
      code: "VISUAL_COMMAND_IDEMPOTENCY_CONFLICT",
    });

    const stale = await first.server.inject({
      method: "POST",
      url,
      payload: createColumnCommand(SECOND_COMMAND_ID, 1, "other"),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.headers["x-command-id"]).toBe(SECOND_COMMAND_ID);
    expect(errorResponseSchema.parse(stale.json())).toMatchObject({
      code: "VISUAL_COMMAND_SCHEMA_REVISION_CONFLICT",
      currentRevisionNo: 2,
    });

    const history = await first.server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/revisions`,
    });
    expect(projectRevisionsResponseSchema.parse(history.json()).revisions).toHaveLength(2);

    const filename = first.filename;
    await closeResource(first);
    const reopened = createFixture(filename);
    const durableReplay = await reopened.server.inject({
      method: "POST",
      url,
      payload: createColumnCommand(),
    });
    expect(durableReplay.statusCode).toBe(200);
    expect(visualCommandMutationResponseSchema.parse(durableReplay.json())).toMatchObject({
      replayed: true,
      appliedSchemaRevisionNo: 2,
      state: { project: { schemaRevisionNo: 2 } },
    });
  });

  it("persists semantic no-ops and returns source-ranged partial impacts without source text", async () => {
    const fixture = createFixture();
    const noOpProject = await createProject(fixture.server);
    const noOpUrl = `/api/v1/projects/${noOpProject.state.project.id}/visual-commands`;
    const noOpCommand = {
      commandId: COMMAND_ID,
      expectedSchemaRevisionNo: 1,
      kind: "UPDATE_TABLE",
      targetTableKey: USERS_KEY,
      changes: { note: null },
    };
    const noOpResponse = await fixture.server.inject({
      method: "POST",
      url: noOpUrl,
      payload: noOpCommand,
    });
    expect(noOpResponse.statusCode).toBe(200);
    expect(visualCommandMutationResponseSchema.parse(noOpResponse.json())).toMatchObject({
      replayed: false,
      revisionCreated: false,
      appliedSchemaRevisionNo: 1,
      state: { project: { schemaRevisionNo: 1, layoutRevisionNo: 0 } },
    });

    const partialProject = await createProject(fixture.server, PARTIAL_SOURCE, "Partial schema");
    const partialUrl = `/api/v1/projects/${partialProject.state.project.id}/visual-commands`;
    const blocked = await fixture.server.inject({
      method: "POST",
      url: partialUrl,
      payload: {
        commandId: SECOND_COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        kind: "DELETE_COLUMN",
        targetTableKey: POSTS_KEY,
        targetColumnKey: INJECTED_COLUMN_KEY,
      },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.headers["x-command-id"]).toBe(SECOND_COMMAND_ID);
    const error = errorResponseSchema.parse(blocked.json());
    expect(error).toMatchObject({
      code: "VISUAL_COMMAND_TRANSFORM_FAILED",
      diagnostics: [{ code: "VISUAL_PARTIAL_TARGET_PROTECTED" }],
      partialImpact: {
        partialKey: qualifiedElementKey("partial", "audit_fields"),
        partialElementKey: qualifiedElementKey("partialColumn", "audit_fields", "created_at"),
      },
    });
    expect(error.partialImpact?.definitionRange.filepath).toBe("/main.dbml");
    expect(error.partialImpact?.affectedTables).toHaveLength(2);
    expect(
      error.partialImpact?.affectedTables.every(
        ({ injectionRange }) => injectionRange.filepath === "/main.dbml",
      ),
    ).toBe(true);
    expect(JSON.stringify(blocked.json())).not.toContain("SECRET_CANONICAL_SOURCE_SENTINEL");
    expect(JSON.stringify(blocked.json())).not.toContain("TextEdit");
    expect(JSON.stringify(blocked.json())).not.toContain("semanticDiff");

    const unchanged = await fixture.server.inject({
      method: "GET",
      url: `/api/v1/projects/${partialProject.state.project.id}`,
    });
    expect(projectResponseSchema.parse(unchanged.json()).state.project).toMatchObject({
      schemaRevisionNo: 1,
      draftSource: PARTIAL_SOURCE,
    });

    const invalidDraft = await fixture.server.inject({
      method: "PUT",
      url: `/api/v1/projects/${partialProject.state.project.id}/draft`,
      payload: {
        commandId: THIRD_COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        source: "Table broken {",
      },
    });
    expect(invalidDraft.statusCode).toBe(200);
    const invalidCommand = await fixture.server.inject({
      method: "POST",
      url: partialUrl,
      payload: {
        ...noOpCommand,
        commandId: RENAME_COMMAND_ID,
        expectedSchemaRevisionNo: 2,
        targetTableKey: POSTS_KEY,
      },
    });
    expect(invalidCommand.statusCode).toBe(422);
    expect(errorResponseSchema.parse(invalidCommand.json()).code).toBe(
      "VISUAL_COMMAND_DRAFT_INVALID",
    );
  });

  it("migrates rename layouts and rolls back position collisions", async () => {
    const fixture = createFixture();
    const created = await createProject(fixture.server);
    const projectId = created.state.project.id;
    await saveLayout(fixture.server, projectId, { [USERS_KEY]: { x: 10, y: 20 } });

    const renamedResponse = await fixture.server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/visual-commands`,
      payload: renameTableCommand(),
    });
    expect(renamedResponse.statusCode).toBe(200);
    expect(visualCommandMutationResponseSchema.parse(renamedResponse.json())).toMatchObject({
      revisionCreated: true,
      layoutMigrated: true,
      appliedSchemaRevisionNo: 2,
      appliedLayoutRevisionNo: 2,
      state: { project: { schemaRevisionNo: 2, layoutRevisionNo: 2 } },
    });
    const migratedLayout = await fixture.server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/layouts/GLOBAL`,
    });
    const migratedPositions = layoutResponseSchema.parse(migratedLayout.json()).layout?.positions;
    expect(migratedPositions).toEqual({
      [USERS_KEY]: { x: 10, y: 20 },
      [ACCOUNTS_KEY]: { x: 10, y: 20 },
    });

    const collisionProject = await createProject(fixture.server, VALID_SOURCE, "Collision schema");
    const collisionProjectId = collisionProject.state.project.id;
    await saveLayout(fixture.server, collisionProjectId, {
      [USERS_KEY]: { x: 10, y: 20 },
      [ACCOUNTS_KEY]: { x: 30, y: 40 },
    });
    const collision = await fixture.server.inject({
      method: "POST",
      url: `/api/v1/projects/${collisionProjectId}/visual-commands`,
      payload: renameTableCommand(THIRD_COMMAND_ID),
    });
    expect(collision.statusCode).toBe(409);
    expect(errorResponseSchema.parse(collision.json()).code).toBe(
      "VISUAL_COMMAND_LAYOUT_MIGRATION_CONFLICT",
    );
    const unchanged = await fixture.server.inject({
      method: "GET",
      url: `/api/v1/projects/${collisionProjectId}`,
    });
    expect(projectResponseSchema.parse(unchanged.json()).state.project).toMatchObject({
      schemaRevisionNo: 1,
      layoutRevisionNo: 1,
      draftSource: VALID_SOURCE,
    });
  });

  it("validates requests and redacts missing or malformed storage errors", async () => {
    const fixture = createFixture();
    const malformedPath = await fixture.server.inject({
      method: "POST",
      url: "/api/v1/projects/not-a-uuid/visual-commands",
      payload: createColumnCommand(),
    });
    expect(malformedPath.statusCode).toBe(400);

    const malformed = await fixture.server.inject({
      method: "POST",
      url: `/api/v1/projects/${MISSING_PROJECT_ID}/visual-commands`,
      payload: { ...createColumnCommand(), source: "SHOULD_NOT_BE_REFLECTED" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(JSON.stringify(malformed.json())).not.toContain("SHOULD_NOT_BE_REFLECTED");

    const missing = await fixture.server.inject({
      method: "POST",
      url: `/api/v1/projects/${MISSING_PROJECT_ID}/visual-commands`,
      payload: createColumnCommand(),
    });
    expect(missing.statusCode).toBe(404);
    const missingError = errorResponseSchema.parse(missing.json());
    expect(missingError.code).toBe("VISUAL_COMMAND_PROJECT_NOT_FOUND");
    expect(missing.headers["x-correlation-id"]).toBe(missingError.correlationId);

    const created = await createProject(fixture.server);
    const projectId = created.state.project.id;
    const url = `/api/v1/projects/${projectId}/visual-commands`;
    const applied = await fixture.server.inject({
      method: "POST",
      url,
      payload: createColumnCommand(),
    });
    expect(applied.statusCode).toBe(200);
    fixture.storage.database.run("PRAGMA ignore_check_constraints = ON");
    fixture.storage.database.run(
      `UPDATE visual_command_receipts
       SET command_hash = 'broken-storage-evidence'
       WHERE project_id = '${projectId}'`,
    );
    fixture.storage.database.run("PRAGMA ignore_check_constraints = OFF");

    const corrupted = await fixture.server.inject({
      method: "POST",
      url,
      payload: createColumnCommand(),
    });
    expect(corrupted.statusCode).toBe(500);
    const storageError = errorResponseSchema.parse(corrupted.json());
    expect(storageError).toEqual({
      code: "VISUAL_COMMAND_STORAGE_INVARIANT_VIOLATION",
      message: "Stored visual command data failed an integrity check.",
      correlationId: CORRELATION_ID,
    });
    expect(JSON.stringify(corrupted.json())).not.toContain("broken-storage-evidence");
    expect(JSON.stringify(corrupted.json())).not.toContain(VALID_SOURCE);

    const malformedLayoutProject = await createProject(
      fixture.server,
      VALID_SOURCE,
      "Malformed layout",
    );
    const malformedLayoutProjectId = malformedLayoutProject.state.project.id;
    await saveLayout(fixture.server, malformedLayoutProjectId, {
      [USERS_KEY]: { x: 10, y: 20 },
    });
    fixture.storage.database.run("PRAGMA ignore_check_constraints = ON");
    fixture.storage.database.run(
      `UPDATE diagram_layouts
       SET positions_json = 'broken-layout-evidence'
       WHERE project_id = '${malformedLayoutProjectId}'`,
    );
    fixture.storage.database.run("PRAGMA ignore_check_constraints = OFF");

    const malformedLayout = await fixture.server.inject({
      method: "POST",
      url: `/api/v1/projects/${malformedLayoutProjectId}/visual-commands`,
      payload: renameTableCommand(THIRD_COMMAND_ID),
    });
    expect(malformedLayout.statusCode).toBe(500);
    expect(errorResponseSchema.parse(malformedLayout.json())).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected server error occurred.",
      correlationId: CORRELATION_ID,
    });
    expect(JSON.stringify(malformedLayout.json())).not.toContain("broken-layout-evidence");
  });
});
