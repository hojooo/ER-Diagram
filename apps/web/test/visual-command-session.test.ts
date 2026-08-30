import type { ProjectState } from "@er-diagram/contracts";
import type { SchemaGraph } from "@er-diagram/core";
import { describe, expect, it, vi } from "vitest";

import type { LayoutSessionSnapshot } from "../src/diagram/layout-session.js";
import { ProjectApiError, type ProjectApi } from "../src/projects/project-api.js";
import type { SourceSessionSnapshot } from "../src/source-editor/source-session.js";
import {
  createVisualCommandSession,
  type VisualCommandDraft,
} from "../src/visual-editor/visual-command-session.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const REVISION_ID = "019d3f4e-7b6c-7def-9abc-0123456789ab";
const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";
const RETRY_ID = "550e8400-e29b-41d4-a716-446655440001";
const CREATED_AT = "2026-08-27T01:02:03.004Z";
const SOURCE = "Table users { id integer [pk] }";
const HASH = "a".repeat(64);

const createTableDraft: VisualCommandDraft = {
  kind: "CREATE_TABLE",
  table: {
    schemaName: "public",
    name: "teams",
    note: null,
    color: null,
    columns: [
      {
        name: "id",
        type: "integer",
        primaryKey: true,
        unique: false,
        notNull: true,
        default: null,
        increment: false,
        note: null,
      },
    ],
  },
};

describe("visual command session", () => {
  it("flushes source then layouts before one command and adopts authoritative state", async () => {
    const order: string[] = [];
    const harness = createHarness({ order });
    await harness.session.submit(createTableDraft, HASH);

    expect(order).toEqual([
      "source-flush",
      "layout-flush",
      "apply",
      "source-adopt",
      "layout-adopt",
    ]);
    expect(harness.applyVisualCommand).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      command: expect.objectContaining({
        kind: "CREATE_TABLE",
        commandId: COMMAND_ID,
        expectedSchemaRevisionNo: 1,
      }),
    });
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "SUCCEEDED",
      pendingCommand: null,
      mutation: { revisionCreated: true, replayed: false },
    });
  });

  it("does not call the API for dirty, invalid, last-valid, stale, or failed layout gates", async () => {
    const variants: Array<(harness: ReturnType<typeof createHarness>) => void> = [
      (harness) => {
        harness.sourceSnapshot.persistence = "ERROR";
      },
      (harness) => {
        harness.sourceSnapshot.validation = "INVALID";
      },
      (harness) => {
        harness.sourceSnapshot.activeGraphSource = "LAST_VALID";
      },
      (harness) => {
        harness.sourceSnapshot.activeGraph = graph("b".repeat(64));
      },
      (harness) => {
        harness.layoutSnapshot.hasUnsavedChanges = true;
      },
    ];

    for (const mutate of variants) {
      const harness = createHarness();
      mutate(harness);
      await harness.session.submit(createTableDraft, HASH);
      expect(harness.applyVisualCommand).not.toHaveBeenCalled();
      expect(harness.session.getSnapshot().status).toBe("REJECTED");
    }
  });

  it("preserves the exact command ID and payload for an explicit safe retry", async () => {
    const harness = createHarness();
    harness.applyVisualCommand
      .mockRejectedValueOnce(new TypeError("network failed"))
      .mockResolvedValueOnce(mutation(projectState(2)));

    await harness.session.submit(createTableDraft, HASH);
    const pending = harness.session.getSnapshot().pendingCommand;
    expect(harness.session.getSnapshot().status).toBe("UNKNOWN_OUTCOME");
    expect(pending?.commandId).toBe(COMMAND_ID);

    await harness.session.retrySafely();
    expect(harness.applyVisualCommand).toHaveBeenCalledTimes(2);
    expect(harness.applyVisualCommand.mock.calls[1]?.[0].command).toEqual(pending);
    expect(harness.session.getSnapshot().status).toBe("SUCCEEDED");
  });

  it("reloads a stale 409, preserves the form outside the coordinator, and uses a new ID", async () => {
    const latest = projectState(2);
    const harness = createHarness({ commandIds: [COMMAND_ID, RETRY_ID], latest });
    harness.applyVisualCommand
      .mockRejectedValueOnce(
        new ProjectApiError("Review latest schema.", {
          status: 409,
          code: "VISUAL_COMMAND_SCHEMA_REVISION_CONFLICT",
          currentRevisionNo: 2,
          diagnostics: [],
        }),
      )
      .mockResolvedValueOnce(mutation(projectState(3)));

    await harness.session.submit(createTableDraft, HASH);
    expect(harness.session.getSnapshot().status).toBe("STALE_REVIEW");
    expect(harness.loadProject).toHaveBeenCalledOnce();
    expect(harness.sourceAdopt).toHaveBeenCalledWith(latest);

    harness.session.reviewLatestSchema();
    harness.sourceSnapshot.activeGraph = graph(HASH);
    harness.sourceSnapshot.expectedSchemaRevisionNo = 2;
    await harness.session.submit(createTableDraft, HASH);
    expect(harness.applyVisualCommand.mock.calls.map(([input]) => input.command.commandId)).toEqual(
      [COMMAND_ID, RETRY_ID],
    );
  });

  it("keeps 422 diagnostics and partial impact available for source fallback", async () => {
    const harness = createHarness();
    harness.applyVisualCommand.mockRejectedValueOnce(
      new ProjectApiError("Partial target is protected.", {
        status: 422,
        code: "VISUAL_COMMAND_TRANSFORM_FAILED",
        diagnostics: [
          {
            code: "VISUAL_PARTIAL_TARGET_PROTECTED",
            message: "Edit the partial definition in source.",
            severity: "ERROR",
          },
        ],
        partialImpact: {
          partialKey: 'partial:["audit"]',
          partialName: "audit",
          partialElementKey: 'partialColumn:["audit","created_at"]',
          definitionRange: range(1),
          affectedTables: [{ tableKey: 'table:["public","users"]', injectionRange: range(20) }],
        },
      }),
    );

    await harness.session.submit(createTableDraft, HASH);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "REJECTED",
      error: {
        code: "VISUAL_COMMAND_TRANSFORM_FAILED",
        diagnostics: [{ code: "VISUAL_PARTIAL_TARGET_PROTECTED" }],
        partialImpact: { partialName: "audit" },
      },
    });
  });
});

function createHarness(
  options: { order?: string[]; commandIds?: string[]; latest?: ProjectState } = {},
) {
  const order = options.order ?? [];
  const commandIds = [...(options.commandIds ?? [COMMAND_ID])];
  const sourceSnapshot = sourceSessionSnapshot();
  const layoutSnapshot = layoutSessionSnapshot();
  const applyVisualCommand = vi.fn<ProjectApi["applyVisualCommand"]>(async () =>
    mutation(projectState(2)),
  );
  const sourceAdopt = vi.fn(async (state: ProjectState) => {
    order.push("source-adopt");
    sourceSnapshot.serverState = state;
    sourceSnapshot.expectedSchemaRevisionNo = state.project.schemaRevisionNo;
    sourceSnapshot.persistence = "SAVED";
    return sourceSnapshot;
  });
  const loadProject = vi.fn(async () => options.latest ?? projectState(2));
  const session = createVisualCommandSession({
    projectId: PROJECT_ID,
    sourceSession: {
      getSnapshot: () => sourceSnapshot,
      flushAndWait: async () => {
        order.push("source-flush");
        return sourceSnapshot;
      },
      adoptCommittedState: sourceAdopt,
    },
    layoutSession: {
      getSnapshot: () => layoutSnapshot,
      flush: async () => {
        order.push("layout-flush");
      },
      adoptCommittedRevision: async () => {
        order.push("layout-adopt");
        return { refreshFailed: false };
      },
    },
    applyVisualCommand: async (input) => {
      order.push("apply");
      return applyVisualCommand(input);
    },
    loadProject,
    generateCommandId: () => commandIds.shift() ?? RETRY_ID,
  });
  return {
    session,
    sourceSnapshot,
    layoutSnapshot,
    applyVisualCommand,
    sourceAdopt,
    loadProject,
  };
}

function sourceSessionSnapshot(): Mutable<SourceSessionSnapshot> {
  const state = projectState(1);
  return {
    source: SOURCE,
    sourceHash: state.project.draftHash,
    expectedSchemaRevisionNo: 1,
    persistence: "SAVED",
    validation: "VALID",
    diagnostics: [],
    activeGraph: graph(HASH),
    activeGraphSource: "CURRENT_DRAFT",
    canUseValidSchema: true,
    serverState: state,
    conflictState: null,
    persistenceError: null,
    validationError: null,
  };
}

function layoutSessionSnapshot(): Mutable<LayoutSessionSnapshot> {
  return {
    currentLayoutRevisionNo: 0,
    views: new Map([
      [
        "GLOBAL",
        {
          viewKey: "GLOBAL",
          layout: {
            positions: {},
            collapsedGroupKeys: [],
            hiddenElementKeys: [],
            viewport: { x: 0, y: 0, zoom: 1 },
            detailLevel: "FULL",
            baseSchemaHash: HASH,
          },
          persistedLayout: null,
          persistedRevisionNo: null,
          hydrated: true,
          status: "SAVED",
          error: null,
        },
      ],
    ]),
    conflict: null,
    hasUnsavedChanges: false,
  };
}

function mutation(state: ProjectState) {
  return {
    state,
    revisionCreated: true,
    layoutMigrated: false,
    replayed: false,
    appliedSchemaRevisionNo: state.project.schemaRevisionNo,
    appliedLayoutRevisionNo: state.project.layoutRevisionNo,
  };
}

function projectState(revisionNo: number): ProjectState {
  const revision = {
    id: REVISION_ID,
    projectId: PROJECT_ID,
    revisionNo,
    source: SOURCE,
    sourceHash: `hash-${revisionNo}`,
    validity: "VALID" as const,
    origin: "VISUAL_COMMAND" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
    createdAt: CREATED_AT,
  };
  return {
    project: {
      id: PROJECT_ID,
      name: "Schema",
      primaryDialect: "POSTGRESQL",
      draftSource: SOURCE,
      draftHash: revision.sourceHash,
      lastValidRevisionId: REVISION_ID,
      parserVersion: "9.1.1",
      schemaRevisionNo: revisionNo,
      layoutRevisionNo: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision: revision,
    lastValidRevision: revision,
  };
}

function graph(schemaHash: string): SchemaGraph {
  return {
    parserVersion: "9.1.1",
    schemaHash,
    project: null,
    notes: [],
    tables: [],
    enums: [],
    references: [],
    groups: [],
    partials: [],
    views: [],
    diagnostics: [],
    sourceMap: {},
  };
}

function range(startOffset: number) {
  return {
    filepath: "/main.dbml",
    startOffset,
    endOffset: startOffset + 1,
    startLine: 1,
    startColumn: startOffset + 1,
    endLine: 1,
    endColumn: startOffset + 2,
  };
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
