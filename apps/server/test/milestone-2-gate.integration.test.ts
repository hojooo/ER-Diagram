import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  layoutMutationResponseSchema,
  layoutResponseSchema,
  projectMutationResponseSchema,
  projectResponseSchema,
  sqlExportResponseSchema,
  sqlImportApplyResponseSchema,
  sqlImportPreviewResponseSchema,
  sqlImportStandalonePreviewResponseSchema,
} from "@er-diagram/contracts";
import {
  convertDbmlToSqlExport,
  convertSqlImport,
  createLayoutApplication,
  createProjectApplication,
  createSqlExportApplication,
  createSqlImportApplication,
  type ProjectBundleApplication,
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
import {
  type SqlInterchangeGateFixture,
  sqlInterchangeGateFixtures,
} from "@er-diagram/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../src/index.js";

const PREVIEW_COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";
const APPLY_COMMAND_ID = "123e4567-e89b-42d3-a456-426614174000";
const LAYOUT_COMMAND_ID = "123e4567-e89b-42d3-a456-426614174001";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174002";
const INITIAL_MYSQL_SOURCE = "Table legacy { id bigint [pk] }\n";
const LAYOUT_HASH = "a".repeat(64);
const temporaryDirectories = new Set<string>();
const runtimes = new Set<Runtime>();

interface Runtime {
  readonly storage: SqliteStorage;
  readonly server: ReturnType<typeof createServer>;
  readonly importRepository: ReturnType<typeof createSqliteSqlImportRepository>;
}

function openRuntime(filename: string): Runtime {
  const storage = openSqliteStorage({ filename });
  const projectRepository = createSqliteProjectRepository(storage);
  const importRepository = createSqliteSqlImportRepository(storage);
  let epochMs = Date.parse("2026-08-29T01:02:03.000Z");
  const server = createServer({
    projectApplication: createProjectApplication({
      persistence: projectRepository,
      generateId: generateUuidV7,
      now: () => toUtcIsoTimestamp(epochMs++),
    }),
    layoutApplication: createLayoutApplication({
      persistence: createSqliteLayoutRepository(storage),
    }),
    sqlImportApplication: createSqlImportApplication({
      persistence: importRepository,
      generateId: generateUuidV7,
      now: () => toUtcIsoTimestamp(epochMs++),
    }),
    sqlExportApplication: createSqlExportApplication({ persistence: projectRepository }),
    visualCommandApplication: {} as VisualCommandApplication,
    projectBundleApplication: {} as ProjectBundleApplication,
    generateCorrelationId: () => CORRELATION_ID,
  });
  const runtime = { storage, server, importRepository };
  runtimes.add(runtime);
  return runtime;
}

async function closeRuntime(runtime: Runtime): Promise<void> {
  if (!runtimes.delete(runtime)) return;
  await runtime.server.close();
  runtime.storage.close();
}

function createDatabasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-m2-gate-"));
  temporaryDirectories.add(directory);
  return path.join(directory, "er-diagram.sqlite");
}

afterEach(async () => {
  await Promise.all([...runtimes].map(closeRuntime));
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe("M2 SQL interchange Fastify and SQLite gate", () => {
  it("creates PostgreSQL revision 1 atomically, reopens SQLite, and exports the same semantics", async () => {
    const fixture = gateFixture("POSTGRESQL");
    const filename = createDatabasePath();
    let runtime = openRuntime(filename);

    const previewResponse = await runtime.server.inject({
      method: "POST",
      url: "/api/v1/sql-import/preview",
      payload: {
        commandId: PREVIEW_COMMAND_ID,
        dialect: fixture.dialect,
        source: fixture.source,
        originalSqlRetention: "DISCARD",
      },
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = sqlImportStandalonePreviewResponseSchema.parse(previewResponse.json());
    expect(preview).toMatchObject({
      previewStatus: "PREVIEWED",
      report: {
        overallStatus: fixture.expectedImportOverallStatus,
        candidateDbmlHash: fixture.expectedCandidateDbmlHash,
      },
      policy: { applyReadiness: "DATA_EXCLUSION_CONFIRMATION_REQUIRED" },
      candidate: { dbmlHash: fixture.expectedCandidateDbmlHash },
    });
    expect(runtime.storage.database.select().from(projects).all()).toEqual([]);
    expect(runtime.storage.database.select().from(importArtifacts).all()).toEqual([]);

    const createResponse = await runtime.server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        operation: "CREATE_FROM_SQL_IMPORT",
        commandId: APPLY_COMMAND_ID,
        name: "PostgreSQL M2 gate",
        primaryDialect: fixture.dialect,
        source: fixture.source,
        previewHash: preview.previewHash,
        originalSqlRetention: "DISCARD",
        dataStatementHandling: fixture.dataStatementHandling,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const applied = sqlImportApplyResponseSchema.parse(createResponse.json());
    expect(applied).toMatchObject({
      artifactStatus: "APPLIED",
      revisionCreated: true,
      state: {
        project: { schemaRevisionNo: 1, layoutRevisionNo: 0 },
        currentRevision: { revisionNo: 1, origin: "SQL_IMPORT", validity: "VALID" },
      },
    });
    expect(applied.state.project.draftSource).toBe(preview.candidate?.dbml);
    assertAppliedArtifact(runtime, applied.state.project.id, applied.artifactId, fixture);

    const projectId = applied.state.project.id;
    await closeRuntime(runtime);
    runtime = openRuntime(filename);

    await verifyReopenedExport(runtime, projectId, applied.artifactId, fixture, 1, []);
  }, 120_000);

  it("replaces MySQL with a checkpoint while preserving layout through SQLite reopen", async () => {
    const fixture = gateFixture("MYSQL");
    const filename = createDatabasePath();
    let runtime = openRuntime(filename);

    const createdResponse = await runtime.server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        operation: "CREATE",
        commandId: PREVIEW_COMMAND_ID,
        name: "MySQL M2 gate",
        primaryDialect: fixture.dialect,
        source: INITIAL_MYSQL_SOURCE,
      },
    });
    const created = projectMutationResponseSchema.parse(createdResponse.json());
    const projectId = created.state.project.id;
    const savedLayoutResponse = await runtime.server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/layouts/GLOBAL`,
      payload: {
        commandId: LAYOUT_COMMAND_ID,
        expectedLayoutRevisionNo: 0,
        layout: gateLayout(),
      },
    });
    expect(layoutMutationResponseSchema.parse(savedLayoutResponse.json())).toMatchObject({
      layoutUpdated: true,
      state: { currentLayoutRevisionNo: 1 },
    });

    const previewResponse = await runtime.server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/preview`,
      payload: {
        commandId: PREVIEW_COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        dialect: fixture.dialect,
        source: fixture.source,
        originalSqlRetention: "DISCARD",
      },
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = sqlImportPreviewResponseSchema.parse(previewResponse.json());
    expect(preview).toMatchObject({
      artifactStatus: "PREVIEWED",
      baseSchemaRevisionNo: 1,
      report: { overallStatus: fixture.expectedImportOverallStatus },
      policy: { applyReadiness: "DATA_EXCLUSION_CONFIRMATION_REQUIRED" },
    });

    const applyResponse = await runtime.server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/apply`,
      payload: {
        commandId: APPLY_COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        artifactId: preview.artifactId,
        previewHash: preview.previewHash,
        source: fixture.source,
        dataStatementHandling: fixture.dataStatementHandling,
      },
    });
    expect(applyResponse.statusCode).toBe(200);
    const applied = sqlImportApplyResponseSchema.parse(applyResponse.json());
    expect(applied).toMatchObject({
      artifactStatus: "APPLIED",
      revisionCreated: true,
      state: {
        project: { schemaRevisionNo: 2, layoutRevisionNo: 1 },
        currentRevision: { revisionNo: 2, origin: "SQL_IMPORT", validity: "VALID" },
      },
    });
    expect(applied.state.project.draftSource).toBe(preview.candidate?.dbml);
    assertAppliedArtifact(runtime, projectId, applied.artifactId, fixture);

    await closeRuntime(runtime);
    runtime = openRuntime(filename);

    const layoutResponse = await runtime.server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/layouts/GLOBAL`,
    });
    expect(layoutResponseSchema.parse(layoutResponse.json())).toMatchObject({
      currentLayoutRevisionNo: 1,
      layout: { ...gateLayout(), revisionNo: 1 },
    });
    await verifyReopenedExport(runtime, projectId, applied.artifactId, fixture, 2, [
      "SQL_EXPORT_OMITS_LAYOUT",
    ]);
  }, 120_000);
});

async function verifyReopenedExport(
  runtime: Runtime,
  projectId: string,
  artifactId: string,
  fixture: SqlInterchangeGateFixture,
  revisionNo: number,
  additionalEntryCodes: readonly string[],
): Promise<void> {
  const stateResponse = await runtime.server.inject({
    method: "GET",
    url: `/api/v1/projects/${projectId}`,
  });
  expect(stateResponse.statusCode).toBe(200);
  const state = projectResponseSchema.parse(stateResponse.json()).state;
  expect(state).toMatchObject({
    project: {
      primaryDialect: fixture.dialect,
      schemaRevisionNo: revisionNo,
      layoutRevisionNo: additionalEntryCodes.length,
    },
    currentRevision: { revisionNo, origin: "SQL_IMPORT", validity: "VALID" },
  });
  expect(state.project.draftHash).toBe(fixture.expectedCandidateDbmlHash);
  expect(state.currentRevision.source).toBe(state.project.draftSource);

  const exportResponse = await runtime.server.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/sql-export`,
    payload: { expectedSchemaRevisionNo: revisionNo, sourceSelection: "CURRENT_DRAFT" },
  });
  expect(exportResponse.statusCode).toBe(200);
  const exported = sqlExportResponseSchema.parse(exportResponse.json());
  expect(exported.candidate).not.toBeNull();
  expect(exported.candidate?.sqlHash).toBe(fixture.expectedGeneratedSqlHash);
  expect(exported.report).toMatchObject({
    overallStatus: fixture.expectedExportOverallStatus,
    containsDataStatements: false,
    semanticVerification: {
      status: "VERIFIED",
      sourceExportableHash: fixture.expectedExportableSchemaHash,
      generatedExportableHash: fixture.expectedExportableSchemaHash,
      changes: [],
    },
  });
  expect(exported.report.entries.map(({ code }) => code)).toEqual(
    [...fixture.expectedExportEntryCodes, ...additionalEntryCodes].sort(compareCodeUnits),
  );
  expect(exported.candidate?.sql).toMatch(/^-- Generated by DBML·SQL ERD Studio/u);
  expect(exported.candidate?.sql).not.toContain(fixture.rowSentinel);

  const reimported = await convertSqlImport({
    dialect: fixture.dialect,
    source: exported.candidate?.sql ?? "",
    filepath: `/m2-gate/${fixture.id}-server-round-trip.sql`,
  });
  expect(reimported.ok).toBe(true);
  if (reimported.ok) {
    const repeatedExport = await convertDbmlToSqlExport({
      primaryDialect: fixture.dialect,
      targetDialect: fixture.dialect,
      source: reimported.candidate.dbml,
      filepath: `/m2-gate/${fixture.id}-server-round-trip.dbml`,
    });
    expect(repeatedExport.ok).toBe(true);
    expect(repeatedExport.report.semanticVerification).toMatchObject({
      status: "VERIFIED",
      sourceExportableHash: fixture.expectedExportableSchemaHash,
      generatedExportableHash: fixture.expectedExportableSchemaHash,
      changes: [],
    });
    if (repeatedExport.ok) {
      expect(repeatedExport.report.containsDataStatements).toBe(false);
      expect(repeatedExport.candidate.sql).not.toContain(fixture.rowSentinel);
    }
  }

  assertAppliedArtifact(runtime, projectId, artifactId, fixture);
  const persisted = JSON.stringify({
    projects: runtime.storage.database.select().from(projects).all(),
    revisions: runtime.storage.database.select().from(schemaRevisions).all(),
    artifacts: runtime.storage.database.select().from(importArtifacts).all(),
  });
  expect(persisted).not.toContain(fixture.rowSentinel);
}

function assertAppliedArtifact(
  runtime: Runtime,
  projectId: string,
  artifactId: string,
  fixture: SqlInterchangeGateFixture,
): void {
  const artifact = runtime.importRepository.getImportArtifact(projectId, artifactId);
  expect(artifact).toMatchObject({
    id: artifactId,
    projectId,
    dialect: fixture.dialect,
    originalSql: null,
    originalHash: fixture.sourceHash,
    generatedDbml: expect.any(String),
    status: "APPLIED",
    appliedAt: expect.any(String),
    envelope: {
      evidence: {
        sourceHash: fixture.sourceHash,
        candidateDbmlHash: fixture.expectedCandidateDbmlHash,
      },
      originalSqlRetention: "DISCARD",
      appliedPolicy: {
        dataHandling: "CONFIRMED_DDL_ONLY",
        applyReadiness: "READY",
      },
    },
  });
  expect(artifact?.generatedDbml).not.toContain(fixture.rowSentinel);
  expect(JSON.stringify(artifact?.envelope)).not.toContain(fixture.rowSentinel);
}

function gateFixture(dialect: "POSTGRESQL" | "MYSQL"): SqlInterchangeGateFixture {
  const fixture = sqlInterchangeGateFixtures.find((candidate) => candidate.dialect === dialect);
  if (!fixture) throw new Error(`Missing ${dialect} M2 gate fixture.`);
  return fixture;
}

function gateLayout() {
  return {
    positions: { 'table:["public","legacy"]': { x: 10, y: 20 } },
    collapsedGroupKeys: [],
    hiddenElementKeys: [],
    viewport: { x: 1, y: 2, zoom: 1 },
    detailLevel: "FULL" as const,
    baseSchemaHash: LAYOUT_HASH,
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
