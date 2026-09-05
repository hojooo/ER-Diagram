import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  layoutMutationResponseSchema,
  layoutResponseSchema,
  projectBundleImportResponseSchema,
  projectMutationResponseSchema,
  projectResponseSchema,
  projectRevisionsResponseSchema,
  sqlImportPreviewResponseSchema,
} from "@er-diagram/contracts";
import {
  createSqliteProjectBundleRepository,
  openSqliteStorage,
  type SqliteStorage,
} from "@er-diagram/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSqliteServer,
  createResourceExecutor,
  NOOP_OPERATIONAL_LOG_SINK,
  readBoundedZipArchive,
  DEFAULT_SERVER_RESOURCE_LIMITS,
} from "../src/index.js";

const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";
const IMPORT_COMMAND_ID = "550e8400-e29b-41d4-a716-446655440001";
const VALID_SOURCE = "Table 사용자 {\r\n  id int [pk]\r\n}\r\n";
const INVALID_SOURCE = `${VALID_SOURCE}Table broken {`;
const SQL = "CREATE TABLE report_source (id bigint PRIMARY KEY);";
const directories = new Set<string>();
const runtimes = new Set<Runtime>();

interface Runtime {
  readonly server: ReturnType<typeof createSqliteServer>;
  readonly storage: SqliteStorage;
}

function databasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-bundles-integration-"));
  directories.add(directory);
  return path.join(directory, "studio.sqlite");
}

function openRuntime(filename: string): Runtime {
  const storage = openSqliteStorage({ filename });
  const resourceExecutor = createResourceExecutor({
    workerUrl: new URL("../dist/resource-worker.js", import.meta.url),
    operationalLogSink: NOOP_OPERATIONAL_LOG_SINK,
  });
  const server = createSqliteServer({
    storage,
    resourceExecutor,
    operationalLogSink: NOOP_OPERATIONAL_LOG_SINK,
  });
  const runtime = { server, storage };
  runtimes.add(runtime);
  return runtime;
}

async function closeRuntime(runtime: Runtime): Promise<void> {
  if (!runtimes.delete(runtime)) return;
  await runtime.server.close();
  runtime.storage.close();
}

afterEach(async () => {
  await Promise.all([...runtimes].map(closeRuntime));
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

describe("portable project bundle Fastify API", () => {
  it("exports raw ZIP and restores a re-keyed project atomically after SQLite restart", async () => {
    const filename = databasePath();
    let runtime = openRuntime(filename);
    const createResponse = await runtime.server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        operation: "CREATE",
        commandId: COMMAND_ID,
        name: "Portable 사용자 🚀",
        primaryDialect: "POSTGRESQL",
        source: VALID_SOURCE,
      },
    });
    const created = projectMutationResponseSchema.parse(createResponse.json());
    const projectId = created.state.project.id;
    const invalidResponse = await runtime.server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/draft`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
        source: INVALID_SOURCE,
      },
    });
    expect(
      projectMutationResponseSchema.parse(invalidResponse.json()).state.currentRevision.validity,
    ).toBe("INVALID");
    const layoutResponse = await runtime.server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/layouts/GLOBAL`,
      payload: {
        commandId: COMMAND_ID,
        expectedLayoutRevisionNo: 0,
        layout: {
          positions: {
            'table:["public","사용자"]': { x: 10, y: 20, width: 360, height: 224 },
          },
          collapsedGroupKeys: [],
          hiddenElementKeys: [],
          viewport: { x: 1, y: 2, zoom: 0.75 },
          detailLevel: "FULL",
          baseSchemaHash: created.state.project.draftHash,
        },
      },
    });
    expect(
      layoutMutationResponseSchema.parse(layoutResponse.json()).state.currentLayoutRevisionNo,
    ).toBe(1);
    const previewResponse = await runtime.server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/sql-import/preview`,
      payload: {
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 2,
        dialect: "POSTGRESQL",
        source: SQL,
        originalSqlRetention: "RETAIN",
      },
    });
    expect(sqlImportPreviewResponseSchema.parse(previewResponse.json()).artifactStatus).toBe(
      "PREVIEWED",
    );

    const exportResponse = await runtime.server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/bundle-export`,
      payload: {
        expectedSchemaRevisionNo: 2,
        expectedLayoutRevisionNo: 1,
        reportMode: "REDACTED",
      },
    });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.headers["content-type"]).toMatch(/^application\/zip/u);
    expect(exportResponse.headers["cache-control"]).toBe("no-store");
    expect(exportResponse.headers["content-length"]).toBe(String(exportResponse.rawPayload.length));
    expect(exportResponse.headers["x-bundle-sha256"]).toBe(
      createHash("sha256").update(exportResponse.rawPayload).digest("hex"),
    );
    const archiveFilename = path.join(path.dirname(filename), "portable.erdiagram.zip");
    writeFileSync(archiveFilename, exportResponse.rawPayload, { mode: 0o600 });
    const archivePaths: string[] = [];
    const summary = await readBoundedZipArchive(
      archiveFilename,
      DEFAULT_SERVER_RESOURCE_LIMITS.bundle,
      ({ path: entryPath }) => {
        archivePaths.push(entryPath);
      },
    );
    expect(summary.entryCount).toBe(summary.fileCount);
    expect(archivePaths).toEqual([
      "history/0000000001.dbml",
      "history/0000000002.dbml",
      "layouts/0000.json",
      "manifest.json",
      "reports/import/0000.json",
      "schema/main.dbml",
    ]);

    const importResponse = await runtime.server.inject({
      method: "POST",
      url: "/api/v1/project-bundles/import",
      headers: { "content-type": "application/zip", "x-command-id": IMPORT_COMMAND_ID },
      payload: exportResponse.rawPayload,
    });
    expect(importResponse.statusCode).toBe(201);
    expect(importResponse.headers["x-command-id"]).toBe(IMPORT_COMMAND_ID);
    const imported = projectBundleImportResponseSchema.parse(importResponse.json());
    expect(imported.state.project.id).not.toBe(projectId);
    expect(imported.state).toMatchObject({
      project: {
        name: "Portable 사용자 🚀",
        draftSource: INVALID_SOURCE,
        schemaRevisionNo: 2,
        layoutRevisionNo: 1,
      },
      currentRevision: { validity: "INVALID", revisionNo: 2 },
      lastValidRevision: { validity: "VALID", revisionNo: 1, source: VALID_SOURCE },
    });
    expect(imported.imported).toEqual({ revisionCount: 2, layoutCount: 1, reportCount: 1 });
    const importedId = imported.state.project.id;

    await closeRuntime(runtime);
    runtime = openRuntime(filename);
    const reopenedProject = await runtime.server.inject({
      method: "GET",
      url: `/api/v1/projects/${importedId}`,
    });
    expect(projectResponseSchema.parse(reopenedProject.json()).state.project.draftSource).toBe(
      INVALID_SOURCE,
    );
    const history = await runtime.server.inject({
      method: "GET",
      url: `/api/v1/projects/${importedId}/revisions`,
    });
    expect(
      projectRevisionsResponseSchema
        .parse(history.json())
        .revisions.map(({ revisionNo }) => revisionNo),
    ).toEqual([2, 1]);
    const layout = await runtime.server.inject({
      method: "GET",
      url: `/api/v1/projects/${importedId}/layouts/GLOBAL`,
    });
    expect(layoutResponseSchema.parse(layout.json()).layout).toMatchObject({
      revisionNo: 1,
      positions: {
        'table:["public","사용자"]': { x: 10, y: 20, width: 360, height: 224 },
      },
    });
    expect(
      createSqliteProjectBundleRepository(runtime.storage).listImportArtifacts(importedId)[0],
    ).toMatchObject({
      originalSql: null,
      status: "CANCELLED",
      envelope: { originalSqlRetention: "DISCARD" },
    });
  }, 60_000);

  it("rejects unsupported content types and malformed ZIP without leaking native errors", async () => {
    const runtime = openRuntime(databasePath());
    const unsupported = await runtime.server.inject({
      method: "POST",
      url: "/api/v1/project-bundles/import",
      headers: { "content-type": "application/json", "x-command-id": IMPORT_COMMAND_ID },
      payload: {},
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toMatchObject({ code: "PROJECT_BUNDLE_CONTENT_TYPE_UNSUPPORTED" });

    const invalid = await runtime.server.inject({
      method: "POST",
      url: "/api/v1/project-bundles/import",
      headers: { "content-type": "application/zip", "x-command-id": IMPORT_COMMAND_ID },
      payload: Buffer.from("not-a-zip"),
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.body).not.toContain("yauzl");
    expect(invalid.body).not.toContain("end of central directory");

    const declaredOversized = await runtime.server.inject({
      method: "POST",
      url: "/api/v1/project-bundles/import",
      headers: {
        "content-type": "application/zip",
        "content-length": String(DEFAULT_SERVER_RESOURCE_LIMITS.bundle.maxArchiveBytes + 1),
        "x-command-id": IMPORT_COMMAND_ID,
      },
      payload: Buffer.from("not-a-zip"),
    });
    expect(declaredOversized.statusCode).toBe(413);
    expect(declaredOversized.json()).toMatchObject({
      code: "PROJECT_BUNDLE_ARCHIVE_TOO_LARGE",
    });

    const mismatchedLength = await runtime.server.inject({
      method: "POST",
      url: "/api/v1/project-bundles/import",
      headers: {
        "content-type": "application/zip",
        "content-length": "10",
        "x-command-id": IMPORT_COMMAND_ID,
      },
      payload: Buffer.from("not-a-zip"),
    });
    expect(mismatchedLength.statusCode).toBe(422);
    expect(mismatchedLength.json()).toMatchObject({
      code: "PROJECT_BUNDLE_ARCHIVE_INVALID",
      message: "The portable bundle upload length did not match its header.",
    });
  });
});
