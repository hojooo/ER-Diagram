import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  errorResponseSchema,
  projectResponseSchema,
  sqlImportApplyResponseSchema,
  sqlImportPreviewResponseSchema,
  sqlImportStandalonePreviewResponseSchema,
} from "@er-diagram/contracts";
import {
  createLayoutApplication,
  createProjectApplication,
  createSqlImportApplication,
  type SqlExportApplication,
  type VisualCommandApplication,
} from "@er-diagram/core";
import {
  createSqliteLayoutRepository,
  createSqliteProjectRepository,
  createSqliteSqlImportRepository,
  generateUuidV7,
  importArtifacts,
  openSqliteStorage,
  projects,
  schemaRevisions,
  type SqliteStorage,
  toUtcIsoTimestamp,
} from "@er-diagram/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../src/index.js";

const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_COMMAND_ID = "123e4567-e89b-42d3-a456-426614174000";
const MISSING_ARTIFACT_ID = "019d3f4e-7b6c-7abc-8def-ffffffffffff";
const INITIAL_SOURCE = "Table legacy { id int [pk] }";
const POSTGRESQL_DDL = "CREATE TABLE users (id bigint PRIMARY KEY);";
const temporaryDirectories = new Set<string>();
const resources: Array<{ server: ReturnType<typeof createServer>; storage: SqliteStorage }> = [];

function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-server-sql-import-"));
  temporaryDirectories.add(directory);
  const storage = openSqliteStorage({ filename: path.join(directory, "er-diagram.sqlite") });
  let epochMs = Date.parse("2026-08-28T01:02:03.000Z");
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
    sqlImportApplication: createSqlImportApplication({
      persistence: createSqliteSqlImportRepository(storage),
      generateId: generateUuidV7,
      now,
    }),
    sqlExportApplication: {} as SqlExportApplication,
    visualCommandApplication: {} as VisualCommandApplication,
    generateCorrelationId: () => "123e4567-e89b-42d3-a456-426614174001",
  });
  resources.push({ server, storage });
  return { server, storage };
}

async function createProject(
  server: ReturnType<typeof createServer>,
  dialect: "POSTGRESQL" | "MYSQL" = "POSTGRESQL",
): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: {
      operation: "CREATE",
      commandId: COMMAND_ID,
      name: "SQL import",
      primaryDialect: dialect,
      source: INITIAL_SOURCE,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().state.project.id as string;
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

describe("SQL import Fastify API", () => {
  it("previews stateless SQL and creates the project only when apply is submitted", async () => {
    const { server, storage } = createFixture();
    const previewResponse = await server.inject({
      method: "POST",
      url: "/api/v1/sql-import/preview",
      payload: {
        commandId: COMMAND_ID,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
        originalSqlRetention: "RETAIN",
      },
    });

    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.headers["x-command-id"]).toBe(COMMAND_ID);
    const preview = sqlImportStandalonePreviewResponseSchema.parse(previewResponse.json());
    expect(preview).toMatchObject({ previewStatus: "PREVIEWED", candidate: expect.any(Object) });
    expect(storage.database.select().from(projects).all()).toEqual([]);
    expect(storage.database.select().from(schemaRevisions).all()).toEqual([]);
    expect(storage.database.select().from(importArtifacts).all()).toEqual([]);

    const createResponse = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        operation: "CREATE_FROM_SQL_IMPORT",
        commandId: OTHER_COMMAND_ID,
        name: "Imported schema",
        primaryDialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
        previewHash: preview.previewHash,
        originalSqlRetention: "RETAIN",
      },
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.headers["x-command-id"]).toBe(OTHER_COMMAND_ID);
    const applied = sqlImportApplyResponseSchema.parse(createResponse.json());
    expect(applied.state).toMatchObject({
      project: { name: "Imported schema", schemaRevisionNo: 1, layoutRevisionNo: 0 },
      currentRevision: { revisionNo: 1, origin: "SQL_IMPORT", validity: "VALID" },
    });
    expect(storage.database.select().from(projects).all()).toHaveLength(1);
    expect(storage.database.select().from(schemaRevisions).all()).toHaveLength(1);
    expect(storage.database.select().from(importArtifacts).all()).toHaveLength(1);
  });

  it("returns failed stateless previews as 200 without storing source or artifacts", async () => {
    const { server, storage } = createFixture();
    const marker = "PRIVATE_STATELESS_LITERAL";
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/sql-import/preview",
      payload: {
        commandId: COMMAND_ID,
        dialect: "POSTGRESQL",
        source: `CREATE TABLE broken (note text DEFAULT '${marker}'`,
        originalSqlRetention: "RETAIN",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(sqlImportStandalonePreviewResponseSchema.parse(response.json())).toMatchObject({
      previewStatus: "FAILED",
      candidate: null,
    });
    expect(response.body).not.toContain(marker);
    expect(storage.database.select().from(projects).all()).toEqual([]);
    expect(storage.database.select().from(importArtifacts).all()).toEqual([]);
  });

  it("maps atomic project import preview mismatch and readiness failures", async () => {
    const { server } = createFixture();
    const source = `${POSTGRESQL_DDL} INSERT INTO users VALUES (1);`;
    const previewResponse = await server.inject({
      method: "POST",
      url: "/api/v1/sql-import/preview",
      payload: { commandId: COMMAND_ID, dialect: "POSTGRESQL", source },
    });
    const preview = sqlImportStandalonePreviewResponseSchema.parse(previewResponse.json());

    const mismatch = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        operation: "CREATE_FROM_SQL_IMPORT",
        commandId: COMMAND_ID,
        name: "Import",
        primaryDialect: "POSTGRESQL",
        source,
        previewHash: "f".repeat(64),
      },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(errorResponseSchema.parse(mismatch.json()).code).toBe(
      "SQL_IMPORT_CREATE_PREVIEW_MISMATCH",
    );

    const confirmation = await server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        operation: "CREATE_FROM_SQL_IMPORT",
        commandId: COMMAND_ID,
        name: "Import",
        primaryDialect: "POSTGRESQL",
        source,
        previewHash: preview.previewHash,
      },
    });
    expect(confirmation.statusCode).toBe(422);
    expect(errorResponseSchema.parse(confirmation.json()).code).toBe(
      "SQL_IMPORT_CREATE_DATA_CONFIRMATION_REQUIRED",
    );
  });

  it("previews and atomically applies PostgreSQL DDL", async () => {
    const { server } = createFixture();
    const projectId = await createProject(server);

    const previewResponse = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/preview`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
      },
    });
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.headers["x-command-id"]).toBe(COMMAND_ID);
    const preview = sqlImportPreviewResponseSchema.parse(previewResponse.json());
    expect(preview).toMatchObject({
      artifactStatus: "PREVIEWED",
      baseSchemaRevisionNo: 1,
      policy: { applyReadiness: "READY" },
    });

    const unchanged = await server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
    });
    expect(projectResponseSchema.parse(unchanged.json()).state.project).toMatchObject({
      draftSource: INITIAL_SOURCE,
      schemaRevisionNo: 1,
      layoutRevisionNo: 0,
    });

    const appliedResponse = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/apply`,
      payload: {
        commandId: OTHER_COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source: POSTGRESQL_DDL,
      },
    });
    expect(appliedResponse.statusCode).toBe(200);
    expect(appliedResponse.headers["x-command-id"]).toBe(OTHER_COMMAND_ID);
    const applied = sqlImportApplyResponseSchema.parse(appliedResponse.json());
    expect(applied).toMatchObject({
      artifactStatus: "APPLIED",
      revisionCreated: true,
      state: {
        project: { schemaRevisionNo: 2, layoutRevisionNo: 0 },
        currentRevision: { origin: "SQL_IMPORT", validity: "VALID" },
      },
    });
  });

  it("returns failed previews as 200 and stores retained source without exposing it", async () => {
    const { server, storage } = createFixture();
    const projectId = await createProject(server);
    const marker = "PRIVATE_SQL_LITERAL";
    const source = `CREATE TABLE broken (note text DEFAULT '${marker}'`;

    const response = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/preview`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source,
        originalSqlRetention: "RETAIN",
      },
    });

    expect(response.statusCode).toBe(200);
    const preview = sqlImportPreviewResponseSchema.parse(response.json());
    expect(preview).toMatchObject({
      artifactStatus: "FAILED",
      candidate: null,
      policy: { applyReadiness: "CONVERSION_FAILED" },
    });
    expect(response.body).not.toContain(marker);
    expect(
      createSqliteSqlImportRepository(storage).getImportArtifact(projectId, preview.artifactId)
        ?.originalSql,
    ).toBe(source);
  });

  it("requires explicit DDL-only confirmation at apply time", async () => {
    const { server } = createFixture();
    const projectId = await createProject(server);
    const source = `${POSTGRESQL_DDL} INSERT INTO users VALUES (1);`;
    const previewResponse = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/preview`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source,
      },
    });
    const preview = sqlImportPreviewResponseSchema.parse(previewResponse.json());
    expect(preview.report.applyEligible).toBe(false);

    const rejected = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/apply`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source,
      },
    });
    expect(rejected.statusCode).toBe(422);
    expect(errorResponseSchema.parse(rejected.json()).code).toBe(
      "SQL_IMPORT_DATA_CONFIRMATION_REQUIRED",
    );

    const confirmed = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/apply`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source,
        dataStatementHandling: "CONFIRM_DDL_ONLY",
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(sqlImportApplyResponseSchema.parse(confirmed.json()).policy).toMatchObject({
      dataHandling: "CONFIRMED_DDL_ONLY",
      applyReadiness: "READY",
    });
  });

  it("maps dialect, revision, evidence, missing artifact, and replay failures", async () => {
    const { server } = createFixture();
    const projectId = await createProject(server);
    const dialect = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/preview`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        dialect: "MYSQL",
        source: "CREATE TABLE users (id bigint);",
      },
    });
    expect(dialect.statusCode).toBe(422);

    const previewResponse = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/preview`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
      },
    });
    const preview = sqlImportPreviewResponseSchema.parse(previewResponse.json());
    const missing = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/apply`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        artifactId: MISSING_ARTIFACT_ID,
        previewHash: preview.previewHash,
        source: POSTGRESQL_DDL,
      },
    });
    expect(missing.statusCode).toBe(404);

    for (const payload of [
      { previewHash: "f".repeat(64), source: POSTGRESQL_DDL },
      { previewHash: preview.previewHash, source: "CREATE TABLE changed (id bigint);" },
    ]) {
      const mismatch = await server.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/sql-import/apply`,
        payload: {
          commandId: COMMAND_ID,
          expectedSchemaRevisionNo: 1,
          artifactId: preview.artifactId,
          ...payload,
        },
      });
      expect(mismatch.statusCode).toBe(409);
      expect(errorResponseSchema.parse(mismatch.json()).code).toBe("SQL_IMPORT_PREVIEW_MISMATCH");
    }

    const applied = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/apply`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source: POSTGRESQL_DDL,
      },
    });
    expect(applied.statusCode).toBe(200);
    const replay = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/apply`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 2,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source: POSTGRESQL_DDL,
      },
    });
    expect(replay.statusCode).toBe(409);
    expect(errorResponseSchema.parse(replay.json()).code).toBe(
      "SQL_IMPORT_ARTIFACT_ALREADY_APPLIED",
    );
  });

  it("rejects malformed requests and redacts invariant and body-limit errors", async () => {
    const { server, storage } = createFixture();
    const projectId = await createProject(server);
    const invalid = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/preview`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
        unexpected: "SECRET_CONTRACT_VALUE",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain("SECRET_CONTRACT_VALUE");

    const previewResponse = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/preview`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: POSTGRESQL_DDL,
      },
    });
    const preview = sqlImportPreviewResponseSchema.parse(previewResponse.json());
    storage.database.run(
      `UPDATE import_artifacts SET report_json = '{}' WHERE id = '${preview.artifactId}'`,
    );
    const corrupt = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/apply`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source: POSTGRESQL_DDL,
      },
    });
    expect(corrupt.statusCode).toBe(500);
    const error = errorResponseSchema.parse(corrupt.json());
    expect(error.code).toBe("SQL_IMPORT_STORAGE_INVARIANT_VIOLATION");
    expect(error.message).toBe("Stored SQL import data failed an integrity check.");
    expect(corrupt.headers["x-correlation-id"]).toBe(error.correlationId);

    const tooLarge = await server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/preview`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        dialect: "POSTGRESQL",
        source: "x".repeat(1_100_000),
      },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(errorResponseSchema.parse(tooLarge.json()).code).toBe("REQUEST_BODY_TOO_LARGE");
  });
});
