import type { VisualCommand } from "@er-diagram/contracts";
import { describe, expect, it } from "vitest";

import {
  createVisualCommandApplication,
  type DiagramLayout,
  type Project,
  type SchemaRevision,
  type VisualCommandApplicationResult,
  type VisualCommandPersistencePort,
  type VisualCommandPersistenceTransaction,
  type VisualCommandReceipt,
  type VisualCommandTransformResult,
} from "../../src/index.js";

const PROJECT_ID = "0199a111-1111-7111-8111-111111111111";
const REVISION_ID = "0199a111-1111-7111-8111-111111111112";
const COMMAND_ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const SECOND_COMMAND_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BEFORE_HASH = "a".repeat(64);
const AFTER_HASH = "b".repeat(64);
const VALID_SOURCE = "Table users {\n  id int [pk]\n}\n";
const CHANGED_SOURCE = "Table users {\n  id int [pk]\n  email varchar\n}\n";
const TABLE_KEY = 'table:["public","users"]';
const RENAMED_TABLE_KEY = 'table:["public","accounts"]';
const COLUMN_KEY = 'column:["public","users","id"]';
const RENAMED_COLUMN_KEY = 'column:["public","users","user_id"]';

class FakeVisualCommandPersistence
  implements VisualCommandPersistencePort, VisualCommandPersistenceTransaction
{
  readonly projects = new Map<string, Project>();
  readonly revisions = new Map<string, SchemaRevision>();
  readonly layouts = new Map<string, DiagramLayout>();
  readonly receipts = new Map<string, VisualCommandReceipt>();
  failAfterRevisionInsert = false;
  failAfterLayoutUpsert = false;
  failAfterReceiptInsert = false;

  constructor() {
    const timestamp = "2026-08-30T00:00:00.000Z";
    const revision: SchemaRevision = {
      id: REVISION_ID,
      projectId: PROJECT_ID,
      revisionNo: 1,
      source: VALID_SOURCE,
      sourceHash: "c".repeat(64),
      validity: "VALID",
      origin: "SOURCE_EDIT",
      parserVersion: "9.1.1",
      diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
      createdAt: timestamp,
    };
    this.revisions.set(revision.id, revision);
    this.projects.set(PROJECT_ID, {
      id: PROJECT_ID,
      name: "Schema",
      primaryDialect: "POSTGRESQL",
      draftSource: revision.source,
      draftHash: revision.sourceHash,
      lastValidRevisionId: revision.id,
      parserVersion: revision.parserVersion,
      schemaRevisionNo: revision.revisionNo,
      layoutRevisionNo: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  listProjects(): Project[] {
    return [...this.projects.values()].map(clone);
  }

  getProject(projectId: string): Project | null {
    return cloneOrNull(this.projects.get(projectId));
  }

  getRevisionById(projectId: string, revisionId: string): SchemaRevision | null {
    const revision = this.revisions.get(revisionId);
    return revision?.projectId === projectId ? clone(revision) : null;
  }

  getRevisionByNumber(projectId: string, revisionNo: number): SchemaRevision | null {
    const revision = [...this.revisions.values()].find(
      (candidate) => candidate.projectId === projectId && candidate.revisionNo === revisionNo,
    );
    return cloneOrNull(revision);
  }

  listRevisions(projectId: string): SchemaRevision[] {
    return [...this.revisions.values()]
      .filter((revision) => revision.projectId === projectId)
      .sort((left, right) => right.revisionNo - left.revisionNo)
      .map(clone);
  }

  getVisualCommandReceipt(projectId: string, commandId: string): VisualCommandReceipt | null {
    return cloneOrNull(this.receipts.get(`${projectId}:${commandId}`));
  }

  listLayouts(projectId: string): DiagramLayout[] {
    return [...this.layouts.values()]
      .filter((layout) => layout.projectId === projectId)
      .sort((left, right) => compare(left.viewKey, right.viewKey))
      .map(clone);
  }

  transaction<T>(operation: (transaction: VisualCommandPersistenceTransaction) => T): T {
    const snapshot = {
      projects: structuredClone(this.projects),
      revisions: structuredClone(this.revisions),
      layouts: structuredClone(this.layouts),
      receipts: structuredClone(this.receipts),
    };
    try {
      return operation(this);
    } catch (error) {
      restoreMap(this.projects, snapshot.projects);
      restoreMap(this.revisions, snapshot.revisions);
      restoreMap(this.layouts, snapshot.layouts);
      restoreMap(this.receipts, snapshot.receipts);
      throw error;
    }
  }

  insertProject(project: Project): void {
    if (this.projects.has(project.id)) throw new Error("duplicate project");
    this.projects.set(project.id, clone(project));
  }

  insertRevision(revision: SchemaRevision): void {
    if (this.revisions.has(revision.id)) throw new Error("duplicate revision");
    this.revisions.set(revision.id, clone(revision));
    if (this.failAfterRevisionInsert) throw new Error("forced revision failure");
  }

  updateProject(project: Project, expectedSchemaRevisionNo: number): boolean {
    const current = this.projects.get(project.id);
    if (!current || current.schemaRevisionNo !== expectedSchemaRevisionNo) return false;
    this.projects.set(project.id, clone(project));
    return true;
  }

  deleteProject(projectId: string, expectedSchemaRevisionNo: number): boolean {
    const current = this.projects.get(projectId);
    if (!current || current.schemaRevisionNo !== expectedSchemaRevisionNo) return false;
    this.projects.delete(projectId);
    return true;
  }

  deleteRevisions(projectId: string, revisionIds: readonly string[]): number {
    let deleted = 0;
    for (const revisionId of revisionIds) {
      const revision = this.revisions.get(revisionId);
      if (revision?.projectId === projectId && this.revisions.delete(revisionId)) deleted += 1;
    }
    return deleted;
  }

  insertVisualCommandReceipt(receipt: VisualCommandReceipt): void {
    const key = `${receipt.projectId}:${receipt.commandId}`;
    if (this.receipts.has(key)) throw new Error("duplicate receipt");
    this.receipts.set(key, clone(receipt));
    if (this.failAfterReceiptInsert) throw new Error("forced receipt failure");
  }

  upsertLayout(layout: DiagramLayout): void {
    this.layouts.set(`${layout.projectId}:${layout.viewKey}`, clone(layout));
    if (this.failAfterLayoutUpsert) throw new Error("forced layout failure");
  }
}

function createColumnCommand(commandId = COMMAND_ID): VisualCommand {
  return {
    commandId,
    expectedSchemaRevisionNo: 1,
    kind: "CREATE_COLUMN",
    targetTableKey: TABLE_KEY,
    column: {
      name: "email",
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

function renameTableCommand(commandId = COMMAND_ID): VisualCommand {
  return {
    commandId,
    expectedSchemaRevisionNo: 1,
    kind: "RENAME_TABLE",
    targetTableKey: TABLE_KEY,
    newName: "accounts",
  };
}

function alterColumnCommand(commandId = COMMAND_ID): VisualCommand {
  return {
    commandId,
    expectedSchemaRevisionNo: 1,
    kind: "ALTER_COLUMN",
    targetTableKey: TABLE_KEY,
    targetColumnKey: COLUMN_KEY,
    newName: "user_id",
    changes: { type: "bigint", notNull: true },
    beforeColumnKey: null,
  };
}

function alteredColumnTransform(renamed: boolean): VisualCommandTransformResult {
  return {
    ok: true,
    changed: true,
    source: renamed
      ? "Table users {\n  user_id bigint [pk, not null]\n}\n"
      : "Table users {\n  id bigint [pk, not null]\n}\n",
    beforeSchemaHash: BEFORE_HASH,
    afterSchemaHash: AFTER_HASH,
    semanticDiff: {
      changes: renamed
        ? [
            { operation: "DELETE", elementKind: "column", key: COLUMN_KEY, parentKey: TABLE_KEY },
            {
              operation: "ADD",
              elementKind: "column",
              key: RENAMED_COLUMN_KEY,
              parentKey: TABLE_KEY,
            },
            {
              operation: "UPDATE",
              elementKind: "table",
              key: TABLE_KEY,
              parentKey: null,
              changedFields: ["columnOrder"],
            },
          ]
        : [
            {
              operation: "UPDATE",
              elementKind: "column",
              key: COLUMN_KEY,
              parentKey: TABLE_KEY,
              changedFields: ["type", "notNull"],
            },
          ],
      renameCandidates: renamed
        ? [
            {
              elementKind: "column",
              beforeKey: COLUMN_KEY,
              afterKey: RENAMED_COLUMN_KEY,
              beforeParentKey: TABLE_KEY,
              afterParentKey: TABLE_KEY,
              confidence: "HIGH",
              reason: "UNIQUE_EXACT_STRUCTURE",
            },
          ]
        : [],
    },
    diagnostics: [],
  };
}

function changedTransform(command: VisualCommand): VisualCommandTransformResult {
  if (command.kind === "RENAME_TABLE") {
    return {
      ok: true,
      changed: true,
      source: VALID_SOURCE.replace("users", "accounts"),
      beforeSchemaHash: BEFORE_HASH,
      afterSchemaHash: AFTER_HASH,
      semanticDiff: {
        changes: [
          { operation: "DELETE", elementKind: "table", key: TABLE_KEY, parentKey: null },
          { operation: "ADD", elementKind: "table", key: RENAMED_TABLE_KEY, parentKey: null },
        ],
        renameCandidates: [
          {
            elementKind: "table",
            beforeKey: TABLE_KEY,
            afterKey: RENAMED_TABLE_KEY,
            beforeParentKey: null,
            afterParentKey: null,
            confidence: "HIGH",
            reason: "UNIQUE_EXACT_STRUCTURE",
          },
        ],
      },
      diagnostics: [],
    };
  }
  return {
    ok: true,
    changed: true,
    source: CHANGED_SOURCE,
    beforeSchemaHash: BEFORE_HASH,
    afterSchemaHash: AFTER_HASH,
    semanticDiff: {
      changes: [
        {
          operation: "ADD",
          elementKind: "column",
          key: 'column:["public","users","email"]',
          parentKey: TABLE_KEY,
        },
      ],
      renameCandidates: [],
    },
    diagnostics: [
      { code: "DBML_INFORMATION", message: "Informational diagnostic.", severity: "INFO" },
    ],
  };
}

function noOpTransform(): VisualCommandTransformResult {
  return {
    ok: true,
    changed: false,
    source: VALID_SOURCE,
    beforeSchemaHash: BEFORE_HASH,
    afterSchemaHash: BEFORE_HASH,
    semanticDiff: { changes: [], renameCandidates: [] },
    diagnostics: [],
  };
}

function createApplication(
  persistence: FakeVisualCommandPersistence,
  transform: (source: string, command: VisualCommand) => Promise<VisualCommandTransformResult>,
) {
  let id = 0;
  let timestamp = Date.parse("2026-08-30T00:00:01.000Z");
  return createVisualCommandApplication({
    persistence,
    transform,
    generateId: () => `revision-${++id}`,
    now: () => new Date(timestamp++).toISOString(),
  });
}

function success<T>(result: VisualCommandApplicationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe("visual command application", () => {
  it("creates one valid revision and replays the durable receipt before stale checks", async () => {
    const persistence = new FakeVisualCommandPersistence();
    let transformCalls = 0;
    const application = createApplication(persistence, async (_source, command) => {
      transformCalls += 1;
      return changedTransform(command);
    });

    const applied = success(
      await application.apply({ projectId: PROJECT_ID, command: createColumnCommand() }),
    );
    expect(applied).toMatchObject({
      replayed: false,
      revisionCreated: true,
      layoutMigrated: false,
      appliedSchemaRevisionNo: 2,
      appliedLayoutRevisionNo: 0,
      state: {
        project: { schemaRevisionNo: 2, draftSource: CHANGED_SOURCE },
        currentRevision: { origin: "VISUAL_COMMAND", validity: "VALID" },
      },
    });
    expect(applied.state.project.lastValidRevisionId).toBe(applied.state.currentRevision.id);
    expect(applied.state.currentRevision.diagnosticSummary.infos).toBe(1);

    const replayed = success(
      await application.apply({ projectId: PROJECT_ID, command: createColumnCommand() }),
    );
    expect(replayed).toMatchObject({
      replayed: true,
      revisionCreated: true,
      appliedSchemaRevisionNo: 2,
      state: { project: { schemaRevisionNo: 2 } },
    });
    expect(transformCalls).toBe(1);
    expect(persistence.revisions.size).toBe(2);
    expect(persistence.receipts.size).toBe(1);
    expect([...persistence.receipts.values()][0]?.commandId).toBe(COMMAND_ID.toLowerCase());
  });

  it("stores semantic no-op receipts without changing project state", async () => {
    const persistence = new FakeVisualCommandPersistence();
    const before = clone(persistence.projects.get(PROJECT_ID));
    const application = createApplication(persistence, async () => noOpTransform());

    const result = success(
      await application.apply({ projectId: PROJECT_ID, command: createColumnCommand() }),
    );

    expect(result).toMatchObject({
      replayed: false,
      revisionCreated: false,
      layoutMigrated: false,
      appliedSchemaRevisionNo: 1,
      appliedLayoutRevisionNo: 0,
    });
    expect(persistence.projects.get(PROJECT_ID)).toEqual(before);
    expect(persistence.revisions.size).toBe(1);
    expect(persistence.receipts.size).toBe(1);

    success(
      await createApplication(persistence, async (_source, command) =>
        changedTransform(command),
      ).apply({
        projectId: PROJECT_ID,
        command: createColumnCommand(SECOND_COMMAND_ID),
      }),
    );
    const replayed = success(
      await application.apply({
        projectId: PROJECT_ID,
        command: createColumnCommand(COMMAND_ID.toLowerCase()),
      }),
    );
    expect(replayed).toMatchObject({
      replayed: true,
      revisionCreated: false,
      appliedSchemaRevisionNo: 1,
      state: { project: { schemaRevisionNo: 2 } },
    });
  });

  it("rejects command ID reuse with a different payload before transform", async () => {
    const persistence = new FakeVisualCommandPersistence();
    let calls = 0;
    const application = createApplication(persistence, async () => {
      calls += 1;
      return noOpTransform();
    });
    success(await application.apply({ projectId: PROJECT_ID, command: createColumnCommand() }));

    const conflicting = createColumnCommand();
    if (conflicting.kind !== "CREATE_COLUMN") throw new Error("unexpected command");
    const result = await application.apply({
      projectId: PROJECT_ID,
      command: { ...conflicting, column: { ...conflicting.column, name: "other" } },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "VISUAL_COMMAND_IDEMPOTENCY_CONFLICT", commandId: COMMAND_ID.toLowerCase() },
    });
    expect(calls).toBe(1);
  });

  it("rejects stale, invalid-draft, and transform failures without mutations", async () => {
    const persistence = new FakeVisualCommandPersistence();
    const application = createApplication(persistence, async () => ({
      ok: false,
      source: VALID_SOURCE,
      diagnostics: [{ code: "VISUAL_TARGET_NOT_FOUND", message: "Missing.", severity: "ERROR" }],
    }));

    const stale = createColumnCommand();
    if (stale.kind !== "CREATE_COLUMN") throw new Error("unexpected command");
    const staleResult = await application.apply({
      projectId: PROJECT_ID,
      command: { ...stale, expectedSchemaRevisionNo: 2 },
    });
    expect(staleResult).toMatchObject({
      ok: false,
      error: { code: "VISUAL_COMMAND_SCHEMA_REVISION_CONFLICT", currentSchemaRevisionNo: 1 },
    });

    const transformFailure = await application.apply({
      projectId: PROJECT_ID,
      command: createColumnCommand(),
    });
    expect(transformFailure).toMatchObject({
      ok: false,
      error: {
        code: "VISUAL_COMMAND_TRANSFORM_FAILED",
        diagnostics: [{ code: "VISUAL_TARGET_NOT_FOUND" }],
      },
    });

    const revision = persistence.revisions.get(REVISION_ID);
    if (!revision) throw new Error("missing revision");
    persistence.revisions.set(REVISION_ID, { ...revision, validity: "INVALID" });
    const project = persistence.projects.get(PROJECT_ID);
    if (!project) throw new Error("missing project");
    persistence.projects.set(PROJECT_ID, { ...project, lastValidRevisionId: null });
    const invalid = await application.apply({
      projectId: PROJECT_ID,
      command: createColumnCommand(SECOND_COMMAND_ID),
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "VISUAL_COMMAND_DRAFT_INVALID" } });
    expect(persistence.receipts.size).toBe(0);
  });

  it("migrates every matching layout in one global layout revision and preserves old keys", async () => {
    const persistence = new FakeVisualCommandPersistence();
    persistence.layouts.set(`${PROJECT_ID}:GLOBAL`, layout("GLOBAL", 0, BEFORE_HASH, true));
    persistence.layouts.set(`${PROJECT_ID}:view`, layout("view", 0, "d".repeat(64), false));
    const application = createApplication(persistence, async (_source, command) =>
      changedTransform(command),
    );

    const result = success(
      await application.apply({ projectId: PROJECT_ID, command: renameTableCommand() }),
    );

    expect(result).toMatchObject({
      layoutMigrated: true,
      appliedSchemaRevisionNo: 2,
      appliedLayoutRevisionNo: 1,
      state: { project: { layoutRevisionNo: 1 } },
    });
    const global = persistence.layouts.get(`${PROJECT_ID}:GLOBAL`);
    const view = persistence.layouts.get(`${PROJECT_ID}:view`);
    expect(global).toMatchObject({ revisionNo: 1, baseSchemaHash: AFTER_HASH });
    expect(global?.positions).toEqual({
      [TABLE_KEY]: { x: 10, y: 20, width: 360, height: 224 },
      [RENAMED_TABLE_KEY]: { x: 10, y: 20, width: 360, height: 224 },
    });
    expect(global?.hiddenElementKeys).toEqual([RENAMED_TABLE_KEY, TABLE_KEY].sort(compare));
    expect(view).toMatchObject({ revisionNo: 1, baseSchemaHash: "d".repeat(64) });
    expect(view?.positions[RENAMED_TABLE_KEY]).toEqual({
      x: 10,
      y: 20,
      width: 360,
      height: 224,
    });
    expect(view?.collapsedGroupKeys).toEqual(["group:stable"]);
    expect(view?.viewport).toEqual({ x: 1, y: 2, zoom: 0.8 });
  });

  it("migrates column layout keys only when ALTER_COLUMN returns verified rename evidence", async () => {
    const renamedPersistence = new FakeVisualCommandPersistence();
    const baseLayout = layout("GLOBAL", 0, BEFORE_HASH, false);
    renamedPersistence.layouts.set(`${PROJECT_ID}:GLOBAL`, {
      ...baseLayout,
      positions: { [COLUMN_KEY]: { x: 30, y: 40 } },
      hiddenElementKeys: [COLUMN_KEY],
    });
    const renamed = success(
      await createApplication(renamedPersistence, async () => alteredColumnTransform(true)).apply({
        projectId: PROJECT_ID,
        command: alterColumnCommand(),
      }),
    );

    expect(renamed).toMatchObject({
      revisionCreated: true,
      layoutMigrated: true,
      appliedSchemaRevisionNo: 2,
      appliedLayoutRevisionNo: 1,
    });
    expect(renamedPersistence.revisions.size).toBe(2);
    expect(renamedPersistence.receipts.size).toBe(1);
    expect(renamedPersistence.layouts.get(`${PROJECT_ID}:GLOBAL`)).toMatchObject({
      revisionNo: 1,
      positions: {
        [COLUMN_KEY]: { x: 30, y: 40 },
        [RENAMED_COLUMN_KEY]: { x: 30, y: 40 },
      },
      hiddenElementKeys: [COLUMN_KEY, RENAMED_COLUMN_KEY].sort(compare),
    });

    const attributePersistence = new FakeVisualCommandPersistence();
    attributePersistence.layouts.set(`${PROJECT_ID}:GLOBAL`, {
      ...baseLayout,
      positions: { [COLUMN_KEY]: { x: 30, y: 40 } },
    });
    const attributeOnlyCommand: VisualCommand = {
      commandId: SECOND_COMMAND_ID,
      expectedSchemaRevisionNo: 1,
      kind: "ALTER_COLUMN",
      targetTableKey: TABLE_KEY,
      targetColumnKey: COLUMN_KEY,
      changes: { type: "bigint", notNull: true },
    };
    const attributeOnly = success(
      await createApplication(attributePersistence, async () =>
        alteredColumnTransform(false),
      ).apply({ projectId: PROJECT_ID, command: attributeOnlyCommand }),
    );
    expect(attributeOnly).toMatchObject({
      revisionCreated: true,
      layoutMigrated: false,
      appliedLayoutRevisionNo: 0,
    });
    expect(attributePersistence.layouts.get(`${PROJECT_ID}:GLOBAL`)).toEqual({
      ...baseLayout,
      positions: { [COLUMN_KEY]: { x: 30, y: 40 } },
    });
  });

  it("preserves a legacy column receipt as evidence and rejects reuse by ALTER_COLUMN", async () => {
    const persistence = new FakeVisualCommandPersistence();
    persistence.receipts.set(`${PROJECT_ID}:${COMMAND_ID.toLowerCase()}`, {
      projectId: PROJECT_ID,
      commandId: COMMAND_ID.toLowerCase(),
      commandKind: "RENAME_COLUMN",
      commandHash: "f".repeat(64),
      expectedSchemaRevisionNo: 1,
      appliedSchemaRevisionNo: 2,
      appliedLayoutRevisionNo: 0,
      revisionCreated: true,
      layoutMigrated: false,
      createdAt: "2026-08-30T00:00:01.000Z",
    });
    let transformCalls = 0;
    const result = await createApplication(persistence, async () => {
      transformCalls += 1;
      return alteredColumnTransform(true);
    }).apply({ projectId: PROJECT_ID, command: alterColumnCommand() });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "VISUAL_COMMAND_IDEMPOTENCY_CONFLICT",
        commandId: COMMAND_ID.toLowerCase(),
      },
    });
    expect(transformCalls).toBe(0);
    expect(persistence.receipts.size).toBe(1);
  });

  it("rolls back revision, layout, project, and receipt on migration collision or storage failure", async () => {
    const persistence = new FakeVisualCommandPersistence();
    const colliding = layout("GLOBAL", 0, BEFORE_HASH, false);
    persistence.layouts.set(`${PROJECT_ID}:GLOBAL`, {
      ...colliding,
      positions: {
        ...colliding.positions,
        [RENAMED_TABLE_KEY]: { x: 999, y: 999 },
      },
    });
    const before = snapshot(persistence);
    const application = createApplication(persistence, async (_source, command) =>
      changedTransform(command),
    );

    const conflict = await application.apply({
      projectId: PROJECT_ID,
      command: renameTableCommand(),
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: "VISUAL_COMMAND_LAYOUT_MIGRATION_CONFLICT", viewKey: "GLOBAL" },
    });
    expect(snapshot(persistence)).toEqual(before);

    persistence.layouts.clear();
    persistence.failAfterReceiptInsert = true;
    const beforeFailure = snapshot(persistence);
    await expect(
      application.apply({ projectId: PROJECT_ID, command: createColumnCommand(SECOND_COMMAND_ID) }),
    ).rejects.toThrow("forced receipt failure");
    expect(snapshot(persistence)).toEqual(beforeFailure);
  });

  it("fails closed when a successful transformer violates its result invariants", async () => {
    const persistence = new FakeVisualCommandPersistence();
    const application = createApplication(persistence, async () => ({
      ...noOpTransform(),
      source: CHANGED_SOURCE,
    }));

    const result = await application.apply({
      projectId: PROJECT_ID,
      command: createColumnCommand(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "VISUAL_COMMAND_TRANSFORM_FAILED",
        diagnostics: [{ code: "VISUAL_APPLICATION_TRANSFORM_INVARIANT" }],
      },
    });
    expect(persistence.revisions.size).toBe(1);
    expect(persistence.receipts.size).toBe(0);
  });
});

function layout(
  viewKey: string,
  revisionNo: number,
  baseSchemaHash: string,
  hidden: boolean,
): DiagramLayout {
  return {
    projectId: PROJECT_ID,
    viewKey,
    positions: { [TABLE_KEY]: { x: 10, y: 20, width: 360, height: 224 } },
    collapsedGroupKeys: ["group:stable"],
    hiddenElementKeys: hidden ? [TABLE_KEY] : [],
    viewport: { x: 1, y: 2, zoom: 0.8 },
    detailLevel: "KEYS_ONLY",
    baseSchemaHash,
    revisionNo,
  };
}

function snapshot(persistence: FakeVisualCommandPersistence) {
  return {
    projects: [...persistence.projects.entries()],
    revisions: [...persistence.revisions.entries()],
    layouts: [...persistence.layouts.entries()],
    receipts: [...persistence.receipts.entries()],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : clone(value);
}

function restoreMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
