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
  type VisualCommand,
  visualCommandMutationResponseSchema,
} from "@er-diagram/contracts";
import {
  createLayoutApplication,
  createProjectApplication,
  createVisualCommandApplication,
  parseDbmlV2,
  type ProjectBundleApplication,
  qualifiedElementKey,
  type SqlExportApplication,
  type SqlImportApplication,
  sha256Utf8,
} from "@er-diagram/core";
import { transformVisualCommand } from "@er-diagram/source-transform";
import {
  createSqliteLayoutRepository,
  createSqliteProjectRepository,
  createSqliteVisualCommandRepository,
  diagramLayouts,
  generateUuidV7,
  openSqliteStorage,
  projects,
  type SqliteStorage,
  schemaRevisions,
  toUtcIsoTimestamp,
  visualCommandReceipts,
} from "@er-diagram/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../src/index.js";

const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174301";
const SOURCE_SENTINEL = "M3_GATE_UNRELATED_SOURCE_SENTINEL";
const USERS_KEY = qualifiedElementKey("table", "public", "users");
const ACCOUNTS_KEY = qualifiedElementKey("table", "public", "accounts");
const TEAMS_KEY = qualifiedElementKey("table", "public", "teams");
const POSTS_KEY = qualifiedElementKey("table", "public", "posts");
const COMMENTS_KEY = qualifiedElementKey("table", "public", "comments");
const USERS_ID_KEY = qualifiedElementKey("column", "public", "users", "id");
const RENAMED_USERS_ID_KEY = qualifiedElementKey("column", "public", "users", "user_id");
const TEAMS_OWNER_KEY = qualifiedElementKey("column", "public", "teams", "owner_id");
const TEAMS_NAME_KEY = qualifiedElementKey("column", "public", "teams", "name");
const INJECTED_COLUMN_KEY = qualifiedElementKey("column", "public", "posts", "created_at");
const GROUP_KEY = qualifiedElementKey("group", "public", "identity");
const VIEW_KEY = qualifiedElementKey("view", null, "focus");

const SIMPLE_SOURCE = `Table public.users {
  id bigint [pk]
}
`;

const GATE_SOURCE = `// ${SOURCE_SENTINEL}
Table public.users {
  id bigint [pk]
  email varchar
}

Table public.teams {
  id bigint [pk]
  owner_id bigint
}

TableGroup identity {
  public.users
}

DiagramView focus {
  Tables {
    public.users
  }
  TableGroups { identity }
  Schemas { public }
}
`;

const PARTIAL_SOURCE = `// ${SOURCE_SENTINEL}_PARTIAL
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

interface Runtime {
  readonly filename: string;
  readonly server: ReturnType<typeof createServer>;
  readonly storage: SqliteStorage;
}

const directories = new Set<string>();
const runtimes = new Set<Runtime>();

function databasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-m3-gate-"));
  directories.add(directory);
  return path.join(directory, "er-diagram.sqlite");
}

function openRuntime(filename = databasePath()): Runtime {
  const storage = openSqliteStorage({ filename });
  let epochMs = Date.parse("2026-08-30T04:00:00.000Z");
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
    projectBundleApplication: {} as ProjectBundleApplication,
    generateCorrelationId: () => CORRELATION_ID,
  });
  const runtime = { filename, server, storage };
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

function commandId(sequence: number): string {
  return `550e8400-e29b-41d4-a716-${sequence.toString(16).padStart(12, "0")}`;
}

async function createProject(runtime: Runtime, source = SIMPLE_SOURCE, name = "M3 gate schema") {
  const response = await runtime.server.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: {
      operation: "CREATE",
      commandId: commandId(0),
      name,
      primaryDialect: "POSTGRESQL",
      source,
    },
  });
  expect(response.statusCode).toBe(201);
  return projectMutationResponseSchema.parse(response.json());
}

async function getProject(runtime: Runtime, projectId: string) {
  const response = await runtime.server.inject({
    method: "GET",
    url: `/api/v1/projects/${projectId}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return projectResponseSchema.parse(response.json()).state;
}

async function getRevisions(runtime: Runtime, projectId: string) {
  const response = await runtime.server.inject({
    method: "GET",
    url: `/api/v1/projects/${projectId}/revisions`,
  });
  expect(response.statusCode).toBe(200);
  return projectRevisionsResponseSchema.parse(response.json()).revisions;
}

async function applyVisual(runtime: Runtime, projectId: string, command: VisualCommand) {
  const response = await runtime.server.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/visual-commands`,
    payload: command,
  });
  expect(response.statusCode, `${command.kind}: ${response.body}`).toBe(200);
  expect(response.headers["x-command-id"]).toBe(command.commandId);
  return visualCommandMutationResponseSchema.parse(response.json());
}

async function saveLayout(input: {
  readonly runtime: Runtime;
  readonly projectId: string;
  readonly viewKey: string;
  readonly expectedLayoutRevisionNo: number;
  readonly baseSchemaHash: string;
  readonly positions: Record<string, { x: number; y: number }>;
  readonly hiddenElementKeys?: readonly string[];
}) {
  const response = await input.runtime.server.inject({
    method: "PUT",
    url: `/api/v1/projects/${input.projectId}/layouts/${input.viewKey}`,
    payload: {
      commandId: commandId(100 + input.expectedLayoutRevisionNo),
      expectedLayoutRevisionNo: input.expectedLayoutRevisionNo,
      layout: {
        positions: input.positions,
        collapsedGroupKeys: [],
        hiddenElementKeys: input.hiddenElementKeys ?? [USERS_KEY],
        viewport: { x: input.expectedLayoutRevisionNo, y: 2, zoom: 0.8 },
        detailLevel: "FULL",
        baseSchemaHash: input.baseSchemaHash,
      },
    },
  });
  expect(response.statusCode).toBe(200);
  return layoutMutationResponseSchema.parse(response.json());
}

async function getLayout(runtime: Runtime, projectId: string, viewKey: string) {
  const response = await runtime.server.inject({
    method: "GET",
    url: `/api/v1/projects/${projectId}/layouts/${viewKey}`,
  });
  expect(response.statusCode).toBe(200);
  return layoutResponseSchema.parse(response.json());
}

async function schemaHash(source: string): Promise<string> {
  const parsed = await parseDbmlV2(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.graph.schemaHash;
}

function persistedRows(storage: SqliteStorage, projectId: string) {
  return {
    project:
      storage.database
        .select()
        .from(projects)
        .all()
        .find((row) => row.id === projectId) ?? null,
    revisions: storage.database
      .select()
      .from(schemaRevisions)
      .all()
      .filter((row) => row.projectId === projectId)
      .toSorted((left, right) => left.revisionNo - right.revisionNo),
    layouts: storage.database
      .select()
      .from(diagramLayouts)
      .all()
      .filter((row) => row.projectId === projectId)
      .toSorted((left, right) => left.viewKey.localeCompare(right.viewKey)),
    receipts: storage.database
      .select()
      .from(visualCommandReceipts)
      .all()
      .filter((row) => row.projectId === projectId)
      .toSorted((left, right) => left.commandId.localeCompare(right.commandId)),
  };
}

function createColumnCommand(
  sequence: number,
  expectedSchemaRevisionNo: number,
  targetTableKey = TEAMS_KEY,
  name = "name",
): Extract<VisualCommand, { kind: "CREATE_COLUMN" }> {
  return {
    commandId: commandId(sequence),
    expectedSchemaRevisionNo,
    kind: "CREATE_COLUMN",
    targetTableKey,
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

function renameTableCommand(sequence: number, expectedSchemaRevisionNo: number): VisualCommand {
  return {
    commandId: commandId(sequence),
    expectedSchemaRevisionNo,
    kind: "RENAME_TABLE",
    targetTableKey: USERS_KEY,
    newName: "accounts",
  };
}

function renameColumnCommand(sequence: number, expectedSchemaRevisionNo: number): VisualCommand {
  return {
    commandId: commandId(sequence),
    expectedSchemaRevisionNo,
    kind: "ALTER_COLUMN",
    targetTableKey: USERS_KEY,
    targetColumnKey: USERS_ID_KEY,
    newName: "user_id",
  };
}

describe("M3 visual editing Fastify and SQLite gate", () => {
  it("persists representative command families, no-op receipts, and replay after later revisions and reopen", async () => {
    const runtime = openRuntime();
    const created = await createProject(runtime, GATE_SOURCE);
    const projectId = created.state.project.id;

    const commands: VisualCommand[] = [
      createColumnCommand(1, 1),
      {
        commandId: commandId(2),
        expectedSchemaRevisionNo: 2,
        kind: "CREATE_REFERENCE",
        reference: {
          schemaName: "public",
          name: "team_owner",
          endpoints: [
            {
              tableKey: TEAMS_KEY,
              columnKeys: [TEAMS_OWNER_KEY],
              multiplicity: { min: 0, max: null },
            },
            {
              tableKey: USERS_KEY,
              columnKeys: [USERS_ID_KEY],
              multiplicity: { min: 1, max: 1 },
            },
          ],
          onDelete: "restrict",
          onUpdate: null,
          color: null,
          inactive: false,
        },
      },
      {
        commandId: commandId(3),
        expectedSchemaRevisionNo: 3,
        kind: "CREATE_INDEX",
        targetTableKey: TEAMS_KEY,
        index: {
          name: "teams_name_idx",
          terms: [{ kind: "COLUMN", columnKey: TEAMS_NAME_KEY }],
          type: "btree",
          unique: false,
          primaryKey: false,
          note: "gate index",
        },
      },
      {
        commandId: commandId(4),
        expectedSchemaRevisionNo: 4,
        kind: "CREATE_CHECK",
        targetTableKey: TEAMS_KEY,
        ownerColumnKey: null,
        check: { name: "teams_positive_id", expression: "id > 0" },
      },
      {
        commandId: commandId(5),
        expectedSchemaRevisionNo: 5,
        kind: "UPDATE_GROUP_MEMBERSHIP",
        targetGroupKey: GROUP_KEY,
        addTableKeys: [TEAMS_KEY],
        removeTableKeys: [],
      },
      {
        commandId: commandId(6),
        expectedSchemaRevisionNo: 6,
        kind: "UPDATE_DIAGRAM_VIEW",
        targetViewKey: VIEW_KEY,
        changes: { visibleTableKeys: [USERS_KEY, TEAMS_KEY] },
      },
    ];

    for (const command of commands) {
      const mutation = await applyVisual(runtime, projectId, command);
      expect(mutation).toMatchObject({ replayed: false, revisionCreated: true });
    }

    const stateAfterFamilies = await getProject(runtime, projectId);
    expect(stateAfterFamilies.project).toMatchObject({ schemaRevisionNo: 7 });
    expect(stateAfterFamilies.currentRevision).toMatchObject({
      origin: "VISUAL_COMMAND",
      validity: "VALID",
    });
    expect(stateAfterFamilies.project.draftSource).toContain(SOURCE_SENTINEL);
    expect(stateAfterFamilies.project.draftSource).toContain("Ref team_owner:");
    expect(stateAfterFamilies.project.draftSource).toContain("teams_name_idx");
    expect(stateAfterFamilies.project.draftSource).toContain("teams_positive_id");

    const beforeNoOp = persistedRows(runtime.storage, projectId);
    const noOpCommand: VisualCommand = {
      commandId: commandId(7),
      expectedSchemaRevisionNo: 7,
      kind: "UPDATE_TABLE",
      targetTableKey: TEAMS_KEY,
      changes: { note: null },
    };
    const noOp = await applyVisual(runtime, projectId, noOpCommand);
    expect(noOp).toMatchObject({
      replayed: false,
      revisionCreated: false,
      appliedSchemaRevisionNo: 7,
      state: { project: { schemaRevisionNo: 7 } },
    });
    const afterNoOp = persistedRows(runtime.storage, projectId);
    expect(afterNoOp.project).toEqual(beforeNoOp.project);
    expect(afterNoOp.revisions).toEqual(beforeNoOp.revisions);
    expect(afterNoOp.layouts).toEqual(beforeNoOp.layouts);
    expect(afterNoOp.receipts).toHaveLength(beforeNoOp.receipts.length + 1);
    expect(
      afterNoOp.receipts.find(({ commandId: id }) => id === noOpCommand.commandId),
    ).toMatchObject({ revisionCreated: false, appliedSchemaRevisionNo: 7 });

    await applyVisual(runtime, projectId, {
      commandId: commandId(8),
      expectedSchemaRevisionNo: 7,
      kind: "UPDATE_TABLE",
      targetTableKey: TEAMS_KEY,
      changes: { note: "later revision" },
    });
    const replayAfterLaterRevision = await applyVisual(
      runtime,
      projectId,
      commands[0] as VisualCommand,
    );
    expect(replayAfterLaterRevision).toMatchObject({
      replayed: true,
      revisionCreated: true,
      appliedSchemaRevisionNo: 2,
      state: { project: { schemaRevisionNo: 8 } },
    });
    expect(await getRevisions(runtime, projectId)).toHaveLength(8);
    expect(persistedRows(runtime.storage, projectId).receipts).toHaveLength(8);

    const filename = runtime.filename;
    await closeRuntime(runtime);
    const reopened = openRuntime(filename);
    const durableReplay = await applyVisual(reopened, projectId, commands[0] as VisualCommand);
    expect(durableReplay).toMatchObject({
      replayed: true,
      appliedSchemaRevisionNo: 2,
      state: { project: { schemaRevisionNo: 8 } },
    });
    expect((await getProject(reopened, projectId)).project.draftSource).toContain(SOURCE_SENTINEL);
    expect(await getRevisions(reopened, projectId)).toHaveLength(8);
  });

  it("migrates every saved view on table rename and keeps that layout through draft recovery and restore", async () => {
    const runtime = openRuntime();
    const created = await createProject(runtime);
    const projectId = created.state.project.id;
    const beforeHash = await schemaHash(SIMPLE_SOURCE);

    await saveLayout({
      runtime,
      projectId,
      viewKey: "GLOBAL",
      expectedLayoutRevisionNo: 0,
      baseSchemaHash: beforeHash,
      positions: { [USERS_KEY]: { x: 10, y: 20 } },
    });
    await saveLayout({
      runtime,
      projectId,
      viewKey: "FOCUS",
      expectedLayoutRevisionNo: 1,
      baseSchemaHash: beforeHash,
      positions: { [USERS_KEY]: { x: 30, y: 40 } },
    });

    const renamed = await applyVisual(runtime, projectId, renameTableCommand(20, 1));
    expect(renamed).toMatchObject({
      revisionCreated: true,
      layoutMigrated: true,
      appliedSchemaRevisionNo: 2,
      appliedLayoutRevisionNo: 3,
      state: { project: { schemaRevisionNo: 2, layoutRevisionNo: 3 } },
    });
    const renamedSource = renamed.state.project.draftSource;
    for (const [viewKey, position] of [
      ["GLOBAL", { x: 10, y: 20 }],
      ["FOCUS", { x: 30, y: 40 }],
    ] as const) {
      const response = await getLayout(runtime, projectId, viewKey);
      expect(response.layout).toMatchObject({ revisionNo: 3 });
      expect(response.layout?.positions).toEqual({
        [USERS_KEY]: position,
        [ACCOUNTS_KEY]: position,
      });
      expect(new Set(response.layout?.hiddenElementKeys)).toEqual(
        new Set([USERS_KEY, ACCOUNTS_KEY]),
      );
    }
    const migratedLayouts = persistedRows(runtime.storage, projectId).layouts;

    const invalidResponse = await runtime.server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/draft`,
      payload: {
        commandId: commandId(21),
        expectedSchemaRevisionNo: 2,
        source: "Table public.broken {",
      },
    });
    expect(invalidResponse.statusCode).toBe(200);
    expect(
      projectMutationResponseSchema.parse(invalidResponse.json()).state.currentRevision,
    ).toMatchObject({ revisionNo: 3, validity: "INVALID" });
    const beforeBlockedCommand = persistedRows(runtime.storage, projectId);
    const blocked = await runtime.server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/visual-commands`,
      payload: {
        commandId: commandId(22),
        expectedSchemaRevisionNo: 3,
        kind: "UPDATE_TABLE",
        targetTableKey: ACCOUNTS_KEY,
        changes: { note: "must not apply" },
      },
    });
    expect(blocked.statusCode).toBe(422);
    expect(errorResponseSchema.parse(blocked.json()).code).toBe("VISUAL_COMMAND_DRAFT_INVALID");
    expect(persistedRows(runtime.storage, projectId)).toEqual(beforeBlockedCommand);

    const sourceRecoveryResponse = await runtime.server.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/draft`,
      payload: {
        commandId: commandId(23),
        expectedSchemaRevisionNo: 3,
        source: renamedSource,
      },
    });
    expect(sourceRecoveryResponse.statusCode).toBe(200);
    const sourceRecovery = projectMutationResponseSchema.parse(sourceRecoveryResponse.json());
    expect(sourceRecovery).toMatchObject({
      revisionCreated: true,
      state: {
        project: { schemaRevisionNo: 4, layoutRevisionNo: 3 },
        currentRevision: {
          revisionNo: 4,
          origin: "SOURCE_EDIT",
          validity: "VALID",
          source: renamedSource,
        },
      },
    });
    expect(persistedRows(runtime.storage, projectId).layouts).toEqual(migratedLayouts);

    const recovered = await applyVisual(
      runtime,
      projectId,
      createColumnCommand(24, 4, ACCOUNTS_KEY, "recovered_column"),
    );
    expect(recovered).toMatchObject({
      replayed: false,
      revisionCreated: true,
      layoutMigrated: false,
      state: { project: { schemaRevisionNo: 5, layoutRevisionNo: 3 } },
    });
    expect(persistedRows(runtime.storage, projectId).layouts).toEqual(migratedLayouts);

    const restoreResponse = await runtime.server.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/revisions/1/restore`,
      payload: { commandId: commandId(25), expectedSchemaRevisionNo: 5 },
    });
    expect(restoreResponse.statusCode).toBe(200);
    const restored = projectMutationResponseSchema.parse(restoreResponse.json());
    expect(restored.state.currentRevision).toMatchObject({
      revisionNo: 6,
      origin: "RESTORE",
      validity: "VALID",
      source: SIMPLE_SOURCE,
    });
    const restoredSourceHash = await sha256Utf8(SIMPLE_SOURCE);
    expect(restored.state.project.draftHash).toBe(restoredSourceHash);
    expect(restored.state.currentRevision.sourceHash).toBe(restoredSourceHash);
    expect(restored.state.project.lastValidRevisionId).toBe(restored.state.currentRevision.id);
    expect(restored.state.lastValidRevision?.id).toBe(restored.state.currentRevision.id);
    expect(restored.state.project.layoutRevisionNo).toBe(3);
    expect(persistedRows(runtime.storage, projectId).layouts).toEqual(migratedLayouts);

    const filename = runtime.filename;
    await closeRuntime(runtime);
    const reopened = openRuntime(filename);
    const reopenedState = await getProject(reopened, projectId);
    expect(reopenedState.project).toMatchObject({
      draftSource: SIMPLE_SOURCE,
      draftHash: restoredSourceHash,
      schemaRevisionNo: 6,
      layoutRevisionNo: 3,
    });
    expect(reopenedState.currentRevision).toMatchObject({
      revisionNo: 6,
      origin: "RESTORE",
      source: SIMPLE_SOURCE,
      sourceHash: restoredSourceHash,
    });
    expect(reopenedState.project.lastValidRevisionId).toBe(reopenedState.currentRevision.id);
    expect(reopenedState.lastValidRevision?.id).toBe(reopenedState.currentRevision.id);
    expect(persistedRows(reopened.storage, projectId).layouts).toEqual(migratedLayouts);
    expect((await getRevisions(reopened, projectId))[0]).toMatchObject({
      revisionNo: 6,
      origin: "RESTORE",
    });

    const replay = await applyVisual(reopened, projectId, renameTableCommand(20, 1));
    expect(replay).toMatchObject({
      replayed: true,
      revisionCreated: true,
      layoutMigrated: true,
      appliedSchemaRevisionNo: 2,
      appliedLayoutRevisionNo: 3,
      state: { project: { schemaRevisionNo: 6, layoutRevisionNo: 3 } },
    });
    expect((await getProject(reopened, projectId)).project.draftSource).toBe(SIMPLE_SOURCE);
    expect(persistedRows(reopened.storage, projectId).layouts).toEqual(migratedLayouts);
  });

  it("copies column rename layout keys across every saved view with one global revision", async () => {
    const runtime = openRuntime();
    const created = await createProject(runtime, SIMPLE_SOURCE, "Column rename layout");
    const projectId = created.state.project.id;
    const beforeHash = await schemaHash(SIMPLE_SOURCE);

    await saveLayout({
      runtime,
      projectId,
      viewKey: "GLOBAL",
      expectedLayoutRevisionNo: 0,
      baseSchemaHash: beforeHash,
      positions: { [USERS_ID_KEY]: { x: 11, y: 21 } },
      hiddenElementKeys: [USERS_ID_KEY],
    });
    await saveLayout({
      runtime,
      projectId,
      viewKey: "FOCUS",
      expectedLayoutRevisionNo: 1,
      baseSchemaHash: beforeHash,
      positions: { [USERS_ID_KEY]: { x: 31, y: 41 } },
      hiddenElementKeys: [USERS_ID_KEY],
    });

    const renameCommand = renameColumnCommand(26, 1);
    const renamed = await applyVisual(runtime, projectId, renameCommand);
    expect(renamed).toMatchObject({
      revisionCreated: true,
      layoutMigrated: true,
      appliedSchemaRevisionNo: 2,
      appliedLayoutRevisionNo: 3,
      state: { project: { schemaRevisionNo: 2, layoutRevisionNo: 3 } },
    });
    for (const [viewKey, position] of [
      ["GLOBAL", { x: 11, y: 21 }],
      ["FOCUS", { x: 31, y: 41 }],
    ] as const) {
      const response = await getLayout(runtime, projectId, viewKey);
      expect(response.layout).toMatchObject({ revisionNo: 3 });
      expect(response.layout?.positions).toEqual({
        [USERS_ID_KEY]: position,
        [RENAMED_USERS_ID_KEY]: position,
      });
      expect(new Set(response.layout?.hiddenElementKeys)).toEqual(
        new Set([USERS_ID_KEY, RENAMED_USERS_ID_KEY]),
      );
    }
    const migratedRows = persistedRows(runtime.storage, projectId);
    expect(migratedRows.layouts.map(({ revisionNo }) => revisionNo)).toEqual([3, 3]);

    const renamedSource = renamed.state.project.draftSource;
    const renamedSourceHash = renamed.state.project.draftHash;
    const filename = runtime.filename;
    await closeRuntime(runtime);
    const reopened = openRuntime(filename);
    const reopenedState = await getProject(reopened, projectId);
    expect(reopenedState.project).toMatchObject({
      draftSource: renamedSource,
      draftHash: renamedSourceHash,
      schemaRevisionNo: 2,
      layoutRevisionNo: 3,
    });
    expect(persistedRows(reopened.storage, projectId).layouts).toEqual(migratedRows.layouts);
    const replay = await applyVisual(reopened, projectId, renameCommand);
    expect(replay).toMatchObject({
      replayed: true,
      appliedSchemaRevisionNo: 2,
      appliedLayoutRevisionNo: 3,
      state: { project: { schemaRevisionNo: 2, layoutRevisionNo: 3 } },
    });
  });

  it("allows exactly one concurrent writer across two connections to the same SQLite file", async () => {
    const first = openRuntime();
    const created = await createProject(first);
    const projectId = created.state.project.id;
    const second = openRuntime(first.filename);
    const contenders = [
      {
        runtime: first,
        command: createColumnCommand(30, 1, USERS_KEY, "first_writer"),
      },
      {
        runtime: second,
        command: createColumnCommand(31, 1, USERS_KEY, "second_writer"),
      },
    ];

    const responses = await Promise.all(
      contenders.map(({ runtime, command }) =>
        runtime.server.inject({
          method: "POST",
          url: `/api/v1/projects/${projectId}/visual-commands`,
          payload: command,
        }),
      ),
    );
    expect(responses.map(({ statusCode }) => statusCode).toSorted()).toEqual([200, 409]);
    const winnerIndex = responses.findIndex(({ statusCode }) => statusCode === 200);
    const loserIndex = responses.findIndex(({ statusCode }) => statusCode === 409);
    const winnerResponse = responses[winnerIndex];
    const loserResponse = responses[loserIndex];
    const winnerCommand = contenders[winnerIndex]?.command;
    const loserCommand = contenders[loserIndex]?.command;
    if (!winnerResponse || !loserResponse || !winnerCommand || !loserCommand) {
      throw new Error("Expected one successful and one stale concurrent writer.");
    }

    expect(winnerResponse.headers["x-command-id"]).toBe(winnerCommand.commandId);
    expect(visualCommandMutationResponseSchema.parse(winnerResponse.json())).toMatchObject({
      replayed: false,
      revisionCreated: true,
      state: { project: { schemaRevisionNo: 2 } },
    });
    expect(loserResponse.headers["x-command-id"]).toBe(loserCommand.commandId);
    expect(errorResponseSchema.parse(loserResponse.json())).toMatchObject({
      code: "VISUAL_COMMAND_SCHEMA_REVISION_CONFLICT",
      currentRevisionNo: 2,
    });
    expect(persistedRows(second.storage, projectId)).toEqual(
      persistedRows(first.storage, projectId),
    );
    expect(persistedRows(first.storage, projectId).receipts.map(({ commandId: id }) => id)).toEqual(
      [winnerCommand.commandId],
    );
    expect(persistedRows(first.storage, projectId).revisions).toHaveLength(2);
    const source = (await getProject(second, projectId)).project.draftSource;
    const winnerName = winnerCommand.column.name;
    const loserName = loserCommand.column.name;
    expect(source).toContain(winnerName);
    expect(source).not.toContain(loserName);
  });

  it("rolls back transform, layout-migration, and receipt-storage failures without residual rows", async () => {
    const runtime = openRuntime();

    const partialProject = await createProject(runtime, PARTIAL_SOURCE, "Partial protection");
    const partialProjectId = partialProject.state.project.id;
    const beforePartialFailure = persistedRows(runtime.storage, partialProjectId);
    const partialFailure = await runtime.server.inject({
      method: "POST",
      url: `/api/v1/projects/${partialProjectId}/visual-commands`,
      payload: {
        commandId: commandId(39),
        expectedSchemaRevisionNo: 1,
        kind: "DELETE_COLUMN",
        targetTableKey: POSTS_KEY,
        targetColumnKey: INJECTED_COLUMN_KEY,
      },
    });
    expect(partialFailure.statusCode).toBe(422);
    const partialError = errorResponseSchema.parse(partialFailure.json());
    expect(partialError).toMatchObject({
      code: "VISUAL_COMMAND_TRANSFORM_FAILED",
      diagnostics: [{ code: "VISUAL_PARTIAL_TARGET_PROTECTED" }],
      partialImpact: {
        partialName: "audit_fields",
        affectedTables: [{ tableKey: COMMENTS_KEY }, { tableKey: POSTS_KEY }],
      },
    });
    expect(partialError.partialImpact?.definitionRange.filepath).toBe("/main.dbml");
    expect(
      partialError.partialImpact?.affectedTables.every(
        ({ injectionRange }) => injectionRange.filepath === "/main.dbml",
      ),
    ).toBe(true);
    expect(JSON.stringify(partialFailure.json())).not.toContain(`${SOURCE_SENTINEL}_PARTIAL`);
    expect(persistedRows(runtime.storage, partialProjectId)).toEqual(beforePartialFailure);
    expect(await getProject(runtime, partialProjectId)).toEqual(partialProject.state);

    const transformProject = await createProject(runtime, GATE_SOURCE, "Transform rollback");
    const transformProjectId = transformProject.state.project.id;
    const beforeTransformFailure = persistedRows(runtime.storage, transformProjectId);
    const transformFailure = await runtime.server.inject({
      method: "POST",
      url: `/api/v1/projects/${transformProjectId}/visual-commands`,
      payload: {
        commandId: commandId(40),
        expectedSchemaRevisionNo: 1,
        kind: "DELETE_TABLE",
        targetTableKey: USERS_KEY,
      },
    });
    expect(transformFailure.statusCode).toBe(422);
    expect(errorResponseSchema.parse(transformFailure.json())).toMatchObject({
      code: "VISUAL_COMMAND_TRANSFORM_FAILED",
      diagnostics: [{ code: "VISUAL_DEPENDENCY_CONFLICT" }],
    });
    expect(persistedRows(runtime.storage, transformProjectId)).toEqual(beforeTransformFailure);
    expect(await getProject(runtime, transformProjectId)).toEqual(transformProject.state);

    const layoutProject = await createProject(runtime, SIMPLE_SOURCE, "Layout rollback");
    const layoutProjectId = layoutProject.state.project.id;
    await saveLayout({
      runtime,
      projectId: layoutProjectId,
      viewKey: "GLOBAL",
      expectedLayoutRevisionNo: 0,
      baseSchemaHash: await schemaHash(SIMPLE_SOURCE),
      positions: {
        [USERS_KEY]: { x: 10, y: 20 },
        [ACCOUNTS_KEY]: { x: 30, y: 40 },
      },
    });
    const beforeLayoutFailure = persistedRows(runtime.storage, layoutProjectId);
    const layoutStateBeforeFailure = await getProject(runtime, layoutProjectId);
    const layoutFailure = await runtime.server.inject({
      method: "POST",
      url: `/api/v1/projects/${layoutProjectId}/visual-commands`,
      payload: renameTableCommand(41, 1),
    });
    expect(layoutFailure.statusCode).toBe(409);
    expect(errorResponseSchema.parse(layoutFailure.json()).code).toBe(
      "VISUAL_COMMAND_LAYOUT_MIGRATION_CONFLICT",
    );
    expect(persistedRows(runtime.storage, layoutProjectId)).toEqual(beforeLayoutFailure);
    expect(await getProject(runtime, layoutProjectId)).toEqual(layoutStateBeforeFailure);

    const storageProject = await createProject(runtime, SIMPLE_SOURCE, "Storage rollback");
    const storageProjectId = storageProject.state.project.id;
    const beforeStorageFailure = persistedRows(runtime.storage, storageProjectId);
    runtime.storage.database.run(`
      CREATE TRIGGER reject_m3_gate_receipt
      BEFORE INSERT ON visual_command_receipts
      WHEN NEW.project_id = '${storageProjectId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced M3 gate receipt failure');
      END
    `);
    const storageFailure = await runtime.server.inject({
      method: "POST",
      url: `/api/v1/projects/${storageProjectId}/visual-commands`,
      payload: createColumnCommand(42, 1, USERS_KEY, "must_rollback"),
    });
    expect(storageFailure.statusCode).toBe(500);
    expect(errorResponseSchema.parse(storageFailure.json())).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected server error occurred.",
      correlationId: CORRELATION_ID,
    });
    expect(persistedRows(runtime.storage, storageProjectId)).toEqual(beforeStorageFailure);
    expect(await getProject(runtime, storageProjectId)).toEqual(storageProject.state);
    expect(await getRevisions(runtime, storageProjectId)).toHaveLength(1);
  });
});
