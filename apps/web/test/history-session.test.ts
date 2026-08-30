import type {
  DraftValidity,
  ProjectMutationResponse,
  ProjectState,
  SchemaRevisionOrigin,
} from "@er-diagram/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createSchemaHistorySession,
  SCHEMA_HISTORY_LIMIT,
  type SchemaHistoryRestoreRevisionInput,
  type SchemaHistorySaveDraftInput,
  type SchemaHistorySessionController,
  type SchemaHistoryStepKind,
} from "../src/history/history-session.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const CREATED_AT = "2026-08-30T01:02:03.004Z";
const SOURCE_A = "Table users { id integer [pk] }";
const SOURCE_B = "Table users { id integer [pk]\n  name varchar }";
const SOURCE_C = "Table users { id integer [pk]\n  name varchar\n  email varchar }";
const INVALID_SOURCE = "Table users { id integer";
const EXTERNAL_SOURCE = "Table accounts { id integer [pk] }";

describe("schema history session", () => {
  it("records source and visual commits in one bounded stack and clears redo on new work", async () => {
    const harness = createHarness();
    const revision2 = projectState(SOURCE_B, 2, "VALID", "SOURCE_EDIT");
    record(harness.session, "SOURCE_EDIT", harness.box.state, revision2);
    harness.box.state = revision2;
    const revision3 = projectState(SOURCE_C, 3, "VALID", "VISUAL_COMMAND");
    record(harness.session, "VISUAL_COMMAND", revision2, revision3);
    harness.box.state = revision3;

    expect(harness.session.getSnapshot().past.map((step) => step.kind)).toEqual([
      "SOURCE_EDIT",
      "VISUAL_COMMAND",
    ]);

    await harness.session.undo();
    expect(harness.session.getSnapshot()).toMatchObject({
      past: [{ kind: "SOURCE_EDIT" }],
      future: [{ kind: "VISUAL_COMMAND" }],
    });

    const beforeNewEdit = harness.box.state;
    const newEdit = projectState(EXTERNAL_SOURCE, 5, "VALID", "SOURCE_EDIT");
    record(harness.session, "SOURCE_EDIT", beforeNewEdit, newEdit);
    harness.box.state = newEdit;
    expect(harness.session.getSnapshot().future).toHaveLength(0);
    expect(harness.session.getSnapshot().past.map((step) => step.kind)).toEqual([
      "SOURCE_EDIT",
      "SOURCE_EDIT",
    ]);

    const capped = createHarness();
    let before = capped.box.state;
    for (let index = 0; index < SCHEMA_HISTORY_LIMIT + 1; index += 1) {
      const after = projectState(
        `${SOURCE_A}\n// ${String(index)}`,
        index + 2,
        "VALID",
        "SOURCE_EDIT",
      );
      record(capped.session, "SOURCE_EDIT", before, after);
      capped.box.state = after;
      before = after;
    }
    expect(capped.session.getSnapshot().past).toHaveLength(SCHEMA_HISTORY_LIMIT);
    expect(capped.session.getSnapshot().past[0]?.before.revisionNo).toBe(2);
  });

  it("flushes a dirty invalid source, then layouts, then saves the undo target", async () => {
    const order: string[] = [];
    const harness = createHarness({ order });
    harness.flushSource.mockImplementationOnce(async () => {
      order.push("source-flush");
      harness.box.state = projectState(INVALID_SOURCE, 2, "INVALID", "SOURCE_EDIT");
      return harness.box.state;
    });

    await harness.session.undo();

    expect(order).toEqual(["source-flush", "layout-flush", "save-draft", "adopt"]);
    expect(harness.saveDraft).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      source: SOURCE_A,
      expectedSchemaRevisionNo: 2,
      commandId: "command-1",
    });
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "SUCCEEDED",
      locked: false,
      current: { revisionNo: 3, source: SOURCE_A, validity: "VALID", origin: "SOURCE_EDIT" },
      past: [],
      future: [{ kind: "SOURCE_EDIT", after: { validity: "INVALID" } }],
    });
  });

  it("does not move stacks until the authoritative undo response is adopted", async () => {
    const harness = createHarness();
    const revision2 = projectState(SOURCE_B, 2, "VALID", "SOURCE_EDIT");
    record(harness.session, "SOURCE_EDIT", harness.box.state, revision2);
    harness.box.state = revision2;
    const pending = deferred<ProjectMutationResponse>();
    harness.saveDraft.mockImplementationOnce(async () => pending.promise);

    const undo = harness.session.undo();
    await settle();

    expect(harness.session.getSnapshot()).toMatchObject({
      status: "UNDOING",
      locked: true,
      past: [{ kind: "SOURCE_EDIT" }],
      future: [],
    });
    pending.resolve(mutation(projectState(SOURCE_A, 3, "VALID", "SOURCE_EDIT")));
    await undo;

    expect(harness.session.getSnapshot()).toMatchObject({
      status: "SUCCEEDED",
      locked: false,
      past: [],
      future: [{ kind: "SOURCE_EDIT" }],
    });
  });

  it("undoes and redoes source and visual steps without recording its own draft adoption", async () => {
    const harness = createHarness();
    const revision2 = projectState(SOURCE_B, 2, "VALID", "SOURCE_EDIT");
    record(harness.session, "SOURCE_EDIT", harness.box.state, revision2);
    harness.box.state = revision2;
    const revision3 = projectState(SOURCE_C, 3, "VALID", "VISUAL_COMMAND");
    record(harness.session, "VISUAL_COMMAND", revision2, revision3);
    harness.box.state = revision3;

    harness.adoptAuthoritativeState.mockImplementation(async (state) => {
      const pending = harness.session.getSnapshot().pendingOperation;
      if (pending && pending.kind !== "MANUAL_RESTORE") {
        harness.session.recordCommitted({
          kind: "SOURCE_EDIT",
          before: pending.before,
          response: mutation(state),
        });
      }
      harness.box.state = state;
    });

    await harness.session.undo();
    await harness.session.undo();
    await harness.session.redo();
    await harness.session.redo();

    expect(harness.saveDraft.mock.calls.map(([input]) => input.source)).toEqual([
      SOURCE_B,
      SOURCE_A,
      SOURCE_B,
      SOURCE_C,
    ]);
    expect(harness.session.getSnapshot()).toMatchObject({
      past: [{ kind: "SOURCE_EDIT" }, { kind: "VISUAL_COMMAND" }],
      future: [],
      current: { revisionNo: 7, source: SOURCE_C },
    });
  });

  it("skips no-ops and receipt replays, and resets when a replay is behind current state", () => {
    const harness = createHarness();
    harness.session.recordCommitted({
      kind: "SOURCE_EDIT",
      before: harness.box.state,
      response: mutation(harness.box.state, false),
    });
    expect(harness.session.getSnapshot().past).toHaveLength(0);

    const revision2 = projectState(SOURCE_B, 2, "VALID", "VISUAL_COMMAND");
    record(harness.session, "VISUAL_COMMAND", harness.box.state, revision2);
    harness.box.state = revision2;
    harness.session.recordCommitted({
      kind: "VISUAL_COMMAND",
      before: projectState(SOURCE_A, 1, "VALID", "SOURCE_EDIT"),
      response: mutation(revision2),
      replayed: true,
      appliedSchemaRevisionNo: 2,
    });
    expect(harness.session.getSnapshot().past).toHaveLength(1);

    const revision3 = projectState(EXTERNAL_SOURCE, 3, "VALID", "SOURCE_EDIT");
    harness.session.recordCommitted({
      kind: "VISUAL_COMMAND",
      before: projectState(SOURCE_A, 1, "VALID", "SOURCE_EDIT"),
      response: mutation(revision3),
      replayed: true,
      appliedSchemaRevisionNo: 2,
    });
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "CONFLICT",
      current: { revisionNo: 3 },
      past: [],
      future: [],
      error: { code: "CLIENT_HISTORY_REPLAY_STALE" },
    });
  });

  it("records a safe visual retry whose durable receipt proves the first attempt committed", () => {
    const harness = createHarness();
    const revision2 = projectState(SOURCE_B, 2, "VALID", "VISUAL_COMMAND");

    harness.session.recordCommitted({
      kind: "VISUAL_COMMAND",
      before: harness.box.state,
      response: mutation(revision2),
      replayed: true,
      appliedSchemaRevisionNo: 2,
    });

    expect(harness.session.getSnapshot()).toMatchObject({
      status: "IDLE",
      current: { revisionNo: 2 },
      past: [{ kind: "VISUAL_COMMAND", before: { revisionNo: 1 }, after: { revisionNo: 2 } }],
      future: [],
    });
  });

  it("leaves undo and redo history unchanged for a layout-only authoritative state", async () => {
    const harness = createHarness();
    const revision2 = projectState(SOURCE_B, 2, "VALID", "SOURCE_EDIT");
    record(harness.session, "SOURCE_EDIT", harness.box.state, revision2);
    harness.box.state = revision2;
    await harness.session.undo();
    const layoutOnly = structuredClone(harness.box.state);
    layoutOnly.project.layoutRevisionNo = 9;

    harness.session.adoptExternalState(layoutOnly);

    expect(harness.session.getSnapshot()).toMatchObject({
      current: { revisionNo: 3 },
      past: [],
      future: [{ kind: "SOURCE_EDIT" }],
    });
  });

  it("stops before a schema write when layout flushing fails", async () => {
    const harness = createHarness();
    const revision2 = projectState(SOURCE_B, 2, "VALID", "SOURCE_EDIT");
    record(harness.session, "SOURCE_EDIT", harness.box.state, revision2);
    harness.box.state = revision2;
    harness.flushLayout.mockRejectedValueOnce(new Error("layout conflict"));

    await harness.session.undo();

    expect(harness.saveDraft).not.toHaveBeenCalled();
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "ERROR",
      locked: false,
      past: [{ kind: "SOURCE_EDIT" }],
      error: { code: "CLIENT_HISTORY_LAYOUT_FLUSH_FAILED" },
    });
  });

  it("preserves the exact unknown-outcome request for an explicit safe retry", async () => {
    const harness = createHarness();
    const revision2 = projectState(SOURCE_B, 2, "VALID", "SOURCE_EDIT");
    record(harness.session, "SOURCE_EDIT", harness.box.state, revision2);
    harness.box.state = revision2;
    harness.saveDraft
      .mockRejectedValueOnce(new TypeError("network failed"))
      .mockResolvedValueOnce(mutation(projectState(SOURCE_A, 3, "VALID", "SOURCE_EDIT")));

    await harness.session.undo();
    const pending = harness.session.getSnapshot().pendingOperation;
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "UNKNOWN_OUTCOME",
      locked: true,
      past: [{ kind: "SOURCE_EDIT" }],
      future: [],
    });
    expect(pending?.kind).toBe("UNDO");

    await harness.session.retrySafely();

    expect(harness.saveDraft).toHaveBeenCalledTimes(2);
    expect(harness.saveDraft.mock.calls[1]?.[0]).toBe(pending?.request);
    expect(harness.flushSource).toHaveBeenCalledOnce();
    expect(harness.flushLayout).toHaveBeenCalledOnce();
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "SUCCEEDED",
      past: [],
      future: [{ kind: "SOURCE_EDIT" }],
      pendingOperation: null,
    });
  });

  it("keeps network and post-commit response failures retryable with the exact request", async () => {
    for (const error of [
      apiError(null, "CLIENT_NETWORK_ERROR"),
      apiError(200, "CLIENT_COMMAND_ID_MISMATCH"),
      apiError(200, "CLIENT_CONTRACT_ERROR"),
    ]) {
      const harness = createHarness();
      const revision2 = projectState(SOURCE_B, 2, "VALID", "SOURCE_EDIT");
      record(harness.session, "SOURCE_EDIT", harness.box.state, revision2);
      harness.box.state = revision2;
      harness.saveDraft.mockRejectedValueOnce(error);

      await harness.session.undo();

      expect(harness.session.getSnapshot()).toMatchObject({
        status: "UNKNOWN_OUTCOME",
        locked: true,
        pendingOperation: { kind: "UNDO" },
      });
    }
  });

  it("proves an unknown retry committed from expected+1, target hash, and origin", async () => {
    const harness = createHarness();
    const revision2 = projectState(SOURCE_B, 2, "VALID", "SOURCE_EDIT");
    record(harness.session, "SOURCE_EDIT", harness.box.state, revision2);
    harness.box.state = revision2;
    const committed = projectState(SOURCE_A, 3, "VALID", "SOURCE_EDIT");
    harness.saveDraft
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockRejectedValueOnce(apiError(409));
    harness.loadCurrentState.mockResolvedValueOnce(committed);

    await harness.session.undo();
    await harness.session.retrySafely();

    expect(harness.loadCurrentState).toHaveBeenCalledOnce();
    expect(harness.adoptAuthoritativeState).toHaveBeenCalledWith(committed, [], "HISTORY_COMMIT");
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "SUCCEEDED",
      current: { revisionNo: 3, sourceHash: hash(SOURCE_A), origin: "SOURCE_EDIT" },
      past: [],
      future: [{ kind: "SOURCE_EDIT" }],
    });
  });

  it("adopts an external 409 state and clears both session stacks", async () => {
    const harness = createHarness();
    const revision2 = projectState(SOURCE_B, 2, "VALID", "SOURCE_EDIT");
    record(harness.session, "SOURCE_EDIT", harness.box.state, revision2);
    harness.box.state = revision2;
    const external = projectState(EXTERNAL_SOURCE, 3, "VALID", "SOURCE_EDIT");
    harness.saveDraft.mockRejectedValueOnce(apiError(409));
    harness.loadCurrentState.mockResolvedValueOnce(external);

    await harness.session.undo();

    expect(harness.adoptAuthoritativeState).toHaveBeenCalledWith(external, [], "EXTERNAL_CONFLICT");
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "CONFLICT",
      locked: false,
      current: { revisionNo: 3, source: EXTERNAL_SOURCE },
      past: [],
      future: [],
      error: { code: "PROJECT_SCHEMA_REVISION_CONFLICT" },
    });
  });

  it("creates an undoable invalid manual restore step and clears redo", async () => {
    const harness = createHarness();
    const revision2 = projectState(SOURCE_B, 2, "VALID", "SOURCE_EDIT");
    record(harness.session, "SOURCE_EDIT", harness.box.state, revision2);
    harness.box.state = revision2;
    await harness.session.undo();
    expect(harness.session.getSnapshot().future).toHaveLength(1);

    harness.restoreRevision.mockImplementationOnce(async (input) => {
      const state = projectState(
        INVALID_SOURCE,
        input.expectedSchemaRevisionNo + 1,
        "INVALID",
        "RESTORE",
      );
      return mutation(state);
    });
    await harness.session.restore({ revisionNo: 42, sourceHash: hash(INVALID_SOURCE) });

    expect(harness.restoreRevision).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      revisionNo: 42,
      expectedSchemaRevisionNo: 3,
      commandId: "command-2",
    });
    expect(harness.session.getSnapshot()).toMatchObject({
      current: { revisionNo: 4, validity: "INVALID", origin: "RESTORE" },
      past: [{ kind: "MANUAL_RESTORE", after: { validity: "INVALID" } }],
      future: [],
    });

    await harness.session.undo();
    expect(harness.saveDraft.mock.calls.at(-1)?.[0]).toMatchObject({
      source: SOURCE_A,
      expectedSchemaRevisionNo: 4,
    });
    expect(harness.session.getSnapshot()).toMatchObject({
      past: [],
      future: [{ kind: "MANUAL_RESTORE" }],
    });
  });

  it("creates a same-source checkpoint without an undo step and clears redo", async () => {
    const harness = createHarness();
    const revision2 = projectState(SOURCE_B, 2, "VALID", "SOURCE_EDIT");
    record(harness.session, "SOURCE_EDIT", harness.box.state, revision2);
    harness.box.state = revision2;
    await harness.session.undo();
    expect(harness.session.getSnapshot().future).toHaveLength(1);

    harness.restoreRevision.mockImplementationOnce(async (input) =>
      mutation(projectState(SOURCE_A, input.expectedSchemaRevisionNo + 1, "VALID", "RESTORE")),
    );
    await harness.session.restore({ revisionNo: 1, sourceHash: hash(SOURCE_A) });

    expect(harness.restoreRevision).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      revisionNo: 1,
      expectedSchemaRevisionNo: 3,
      commandId: "command-2",
    });
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "SUCCEEDED",
      current: { revisionNo: 4, source: SOURCE_A, origin: "RESTORE" },
      past: [],
      future: [],
    });
  });

  it("allows a same-source restore after a dirty source flush without recording it", async () => {
    const harness = createHarness();
    const flushed = projectState(SOURCE_B, 2, "VALID", "SOURCE_EDIT");
    harness.flushSource.mockImplementationOnce(async () => {
      record(harness.session, "SOURCE_EDIT", harness.box.state, flushed);
      harness.box.state = flushed;
      return flushed;
    });
    harness.restoreRevision.mockImplementationOnce(async (input) =>
      mutation(projectState(SOURCE_B, input.expectedSchemaRevisionNo + 1, "VALID", "RESTORE")),
    );

    await harness.session.restore({ revisionNo: 99, sourceHash: hash(SOURCE_B) });

    expect(harness.restoreRevision).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSchemaRevisionNo: 2, revisionNo: 99 }),
    );
    expect(harness.session.getSnapshot()).toMatchObject({
      current: { revisionNo: 3, source: SOURCE_B, origin: "RESTORE" },
      past: [{ kind: "SOURCE_EDIT", after: { source: SOURCE_B } }],
      future: [],
    });
  });

  it("does not restore the current revision", async () => {
    const harness = createHarness();

    await harness.session.restore({ revisionNo: 1, sourceHash: hash(SOURCE_A) });

    expect(harness.restoreRevision).not.toHaveBeenCalled();
  });
});

function createHarness(options: { readonly order?: string[] } = {}) {
  const order = options.order ?? [];
  const box = { state: projectState(SOURCE_A, 1, "VALID", "SOURCE_EDIT") };
  const commandIds = Array.from({ length: 32 }, (_, index) => `command-${String(index + 1)}`);
  const flushSource = vi.fn(async () => {
    order.push("source-flush");
    return box.state;
  });
  const flushLayout = vi.fn(async () => {
    order.push("layout-flush");
  });
  const saveDraft = vi.fn<(input: SchemaHistorySaveDraftInput) => Promise<ProjectMutationResponse>>(
    async (input) => {
      order.push("save-draft");
      const validity = input.source === INVALID_SOURCE ? "INVALID" : "VALID";
      return mutation(
        projectState(input.source, input.expectedSchemaRevisionNo + 1, validity, "SOURCE_EDIT"),
      );
    },
  );
  const restoreRevision = vi.fn<
    (input: SchemaHistoryRestoreRevisionInput) => Promise<ProjectMutationResponse>
  >(async () => {
    throw new Error("A restore implementation is required by this test.");
  });
  const adoptAuthoritativeState = vi.fn(async (state: ProjectState) => {
    order.push("adopt");
    box.state = state;
  });
  const loadCurrentState = vi.fn(async () => box.state);
  const session = createSchemaHistorySession({
    projectId: PROJECT_ID,
    initialState: box.state,
    flushSource,
    flushLayout,
    saveDraft,
    restoreRevision,
    adoptAuthoritativeState,
    loadCurrentState,
    generateCommandId: () => commandIds.shift() ?? "command-overflow",
  });
  return {
    session,
    box,
    flushSource,
    flushLayout,
    saveDraft,
    restoreRevision,
    adoptAuthoritativeState,
    loadCurrentState,
  };
}

function record(
  session: SchemaHistorySessionController,
  kind: SchemaHistoryStepKind,
  before: ProjectState,
  after: ProjectState,
): void {
  session.recordCommitted({ kind, before, response: mutation(after) });
}

function mutation(state: ProjectState, revisionCreated = true): ProjectMutationResponse {
  return { state, diagnostics: [], revisionCreated };
}

function projectState(
  source: string,
  revisionNo: number,
  validity: DraftValidity,
  origin: SchemaRevisionOrigin,
): ProjectState {
  const revision = {
    id: `019d3f4e-7b6c-7a${revisionNo.toString().padStart(2, "0")}-8def-0123456789ab`,
    projectId: PROJECT_ID,
    revisionNo,
    source,
    sourceHash: hash(source),
    validity,
    origin,
    parserVersion: "9.1.1",
    diagnosticSummary: {
      errors: validity === "INVALID" ? 1 : 0,
      warnings: 0,
      infos: 0,
      parserVersion: "9.1.1",
    },
    createdAt: CREATED_AT,
  };
  return {
    project: {
      id: PROJECT_ID,
      name: "Schema",
      primaryDialect: "POSTGRESQL",
      draftSource: source,
      draftHash: revision.sourceHash,
      lastValidRevisionId: validity === "VALID" ? revision.id : null,
      parserVersion: "9.1.1",
      schemaRevisionNo: revisionNo,
      layoutRevisionNo: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision: revision,
    lastValidRevision: validity === "VALID" ? revision : null,
  };
}

function hash(source: string): string {
  let value = 0;
  for (const character of source) value = (value * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return value.toString(16).padStart(64, "0");
}

function apiError(status: number | null, code = "PROJECT_SCHEMA_REVISION_CONFLICT"): Error {
  return Object.assign(new Error("The project changed."), {
    status,
    code,
    currentRevisionNo: 3,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
