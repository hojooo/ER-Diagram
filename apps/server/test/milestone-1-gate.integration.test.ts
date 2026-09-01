import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  projectMutationResponseSchema,
  projectResponseSchema,
  projectRevisionsResponseSchema,
} from "@er-diagram/contracts";
import {
  createLayoutApplication,
  createProjectApplication,
  parseDbmlV2,
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
import {
  fixtureInventory,
  generateFidelityFixture,
  sha256FixtureSource,
} from "@er-diagram/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../src/index.js";

const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";
const INVALID_SUFFIX = "\nTable gate_broken {";

const temporaryDirectories = new Set<string>();
const openStorages = new Set<SqliteStorage>();
const openServers = new Set<ReturnType<typeof createServer>>();

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-m1-gate-"));
  temporaryDirectories.add(directory);
  return path.join(directory, "er-diagram.sqlite");
}

function createFixture(filename = temporaryDatabasePath()) {
  const storage = openSqliteStorage({ filename });
  openStorages.add(storage);
  let epochMs = Date.parse("2026-08-28T01:02:03.000Z");
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
  });
  openServers.add(server);
  return { filename, server, storage };
}

async function closeFixture(fixture: ReturnType<typeof createFixture>): Promise<void> {
  await fixture.server.close();
  openServers.delete(fixture.server);
  fixture.storage.close();
  openStorages.delete(fixture.storage);
}

afterEach(async () => {
  await Promise.all([...openServers].map((server) => server.close()));
  openServers.clear();
  for (const storage of openStorages) storage.close();
  openStorages.clear();
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true });
  temporaryDirectories.clear();
});

describe("M1 read-only workspace gate", () => {
  it("recovers a byte-identical invalid draft and fidelity last-valid revision after reopen", async () => {
    const source = generateFidelityFixture();
    const sourceHash = sha256FixtureSource(source);
    const invalidSource = `${source}${INVALID_SUFFIX}`;
    const invalidHash = sha256FixtureSource(invalidSource);
    const first = createFixture();

    const createResponse = await first.server.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: {
        operation: "CREATE",
        commandId: COMMAND_ID,
        name: "M1 fidelity gate",
        primaryDialect: "POSTGRESQL",
        source,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = projectMutationResponseSchema.parse(createResponse.json());
    expect(created.state.project).toMatchObject({
      draftSource: source,
      draftHash: sourceHash,
      parserVersion: "9.1.1",
      schemaRevisionNo: 1,
    });
    expect(created.state.currentRevision).toMatchObject({
      revisionNo: 1,
      source,
      sourceHash,
      validity: "VALID",
    });
    expect(created.state.lastValidRevision?.id).toBe(created.state.currentRevision.id);

    const projectId = created.state.project.id;
    const invalidResponse = await first.server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/draft`,
      payload: {
        commandId: COMMAND_ID,
        source: invalidSource,
        expectedSchemaRevisionNo: 1,
      },
    });
    expect(invalidResponse.statusCode).toBe(200);
    const invalid = projectMutationResponseSchema.parse(invalidResponse.json());
    expect(invalid.state.project).toMatchObject({
      draftSource: invalidSource,
      draftHash: invalidHash,
      schemaRevisionNo: 2,
    });
    expect(invalid.state.currentRevision).toMatchObject({
      revisionNo: 2,
      source: invalidSource,
      sourceHash: invalidHash,
      validity: "INVALID",
    });
    expect(invalid.state.currentRevision.diagnosticSummary.errors).toBeGreaterThan(0);
    expect(invalid.state.lastValidRevision).toMatchObject({
      revisionNo: 1,
      source,
      sourceHash,
      validity: "VALID",
    });
    expect(invalid.diagnostics.some(({ severity }) => severity === "ERROR")).toBe(true);

    await closeFixture(first);
    const reopened = createFixture(first.filename);
    const stateResponse = await reopened.server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
    });
    expect(stateResponse.statusCode).toBe(200);
    const recovered = projectResponseSchema.parse(stateResponse.json()).state;
    expect(recovered.project).toMatchObject({
      draftSource: invalidSource,
      draftHash: invalidHash,
      parserVersion: "9.1.1",
      schemaRevisionNo: 2,
    });
    expect(recovered.currentRevision).toMatchObject({
      revisionNo: 2,
      source: invalidSource,
      sourceHash: invalidHash,
      validity: "INVALID",
    });
    expect(recovered.currentRevision.diagnosticSummary.errors).toBeGreaterThan(0);
    expect(recovered.lastValidRevision).toMatchObject({
      revisionNo: 1,
      source,
      sourceHash,
      validity: "VALID",
    });

    const revisionsResponse = await reopened.server.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/revisions`,
    });
    expect(revisionsResponse.statusCode).toBe(200);
    const revisions = projectRevisionsResponseSchema.parse(revisionsResponse.json()).revisions;
    expect(revisions.map(({ revisionNo }) => revisionNo)).toEqual([2, 1]);
    expect(revisions.map(({ validity }) => validity)).toEqual(["INVALID", "VALID"]);

    const reparsed = await parseDbmlV2(recovered.lastValidRevision?.source ?? "");
    if (!reparsed.ok) throw new Error(JSON.stringify(reparsed.diagnostics));
    expect({
      tables: reparsed.graph.tables.length,
      enums: reparsed.graph.enums.length,
      tablePartials: reparsed.graph.partials.length,
      tableGroups: reparsed.graph.groups.length,
      diagramViews: reparsed.graph.views.length,
      references: reparsed.graph.references.length,
    }).toEqual(fixtureInventory.fidelity);
  }, 30_000);
});
