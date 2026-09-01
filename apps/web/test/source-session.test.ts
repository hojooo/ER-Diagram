import type { Diagnostic, ProjectMutationResponse, ProjectState } from "@er-diagram/contracts";
import type { SchemaGraph } from "@er-diagram/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectApiError } from "../src/projects/project-api.js";
import type { DbmlWorkerParseResult } from "../src/source-editor/parser-worker-client.js";
import {
  createSourceSession,
  SOURCE_AUTOSAVE_DEBOUNCE_MS,
} from "../src/source-editor/source-session.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const CREATED_AT = "2026-08-27T01:02:03.004Z";
const VALID_SOURCE = "Table users { id int [pk] }";
const EDITED_SOURCE = "Table users { id int [pk]\n  name varchar }";
const LATEST_SOURCE = "Table users { id int [pk]\n  email varchar }";
const INVALID_SOURCE = "Table users { id int";

afterEach(() => {
  vi.useRealTimers();
});

describe("source session autosave", () => {
  it("waits exactly 750 ms, validates and saves once, then advances the revision", async () => {
    vi.useFakeTimers();
    const saveDraft = vi.fn(async ({ source }: { source: string }) => mutation(source, 2, "VALID"));
    const session = createSession({ saveDraft });
    session.start();
    await settle();

    session.edit(EDITED_SOURCE);
    expect(session.getSnapshot()).toMatchObject({ persistence: "DIRTY", validation: "PENDING" });
    await vi.advanceTimersByTimeAsync(SOURCE_AUTOSAVE_DEBOUNCE_MS - 1);
    expect(saveDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(saveDraft).toHaveBeenCalledOnce();
    expect(saveDraft).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      source: EDITED_SOURCE,
      expectedSchemaRevisionNo: 1,
    });
    expect(session.getSnapshot()).toMatchObject({
      persistence: "SAVED",
      validation: "VALID",
      expectedSchemaRevisionNo: 2,
      sourceHash: fakeHash(EDITED_SOURCE),
      canUseValidSchema: true,
      activeGraphSource: "CURRENT_DRAFT",
    });
    session.dispose();
  });

  it("coalesces rapid edits and never overlaps draft writes", async () => {
    vi.useFakeTimers();
    const firstSave = deferred<ProjectMutationResponse>();
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const saveDraft = vi.fn(async ({ source }: { source: string }) => {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      const response =
        source === EDITED_SOURCE ? await firstSave.promise : mutation(source, 3, "VALID");
      activeWrites -= 1;
      return response;
    });
    const session = createSession({ saveDraft });
    session.start();
    await settle();

    session.edit(EDITED_SOURCE);
    await vi.advanceTimersByTimeAsync(750);
    expect(saveDraft).toHaveBeenCalledOnce();

    session.edit(LATEST_SOURCE);
    await vi.advanceTimersByTimeAsync(750);
    expect(saveDraft).toHaveBeenCalledOnce();

    firstSave.resolve(mutation(EDITED_SOURCE, 2, "VALID"));
    await settle();

    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(saveDraft.mock.calls[1]?.[0]).toMatchObject({
      source: LATEST_SOURCE,
      expectedSchemaRevisionNo: 2,
    });
    expect(maximumActiveWrites).toBe(1);
    expect(session.getSnapshot()).toMatchObject({
      persistence: "SAVED",
      expectedSchemaRevisionNo: 3,
      source: LATEST_SOURCE,
    });
    session.dispose();
  });

  it("does not write when the buffer returns to the byte-identical persisted source", async () => {
    vi.useFakeTimers();
    const saveDraft = vi.fn();
    const session = createSession({ saveDraft });
    session.start();
    await settle();

    session.edit(EDITED_SOURCE);
    session.edit(VALID_SOURCE);
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    expect(saveDraft).not.toHaveBeenCalled();
    expect(session.getSnapshot().persistence).toBe("SAVED");
    session.dispose();
  });

  it("ignores an old parser response after a newer Monaco buffer validates", async () => {
    vi.useFakeTimers();
    const oldParse = deferred<DbmlWorkerParseResult>();
    const latestParse = deferred<DbmlWorkerParseResult>();
    const parseSource = vi.fn((source: string) => {
      if (source === EDITED_SOURCE) return oldParse.promise;
      if (source === LATEST_SOURCE) return latestParse.promise;
      return Promise.resolve(validParse(source));
    });
    const session = createSession({
      parseSource,
      saveDraft: async ({ source }) => mutation(source, source === EDITED_SOURCE ? 2 : 3, "VALID"),
    });
    session.start();
    await settle();

    session.edit(EDITED_SOURCE);
    await vi.advanceTimersByTimeAsync(750);
    session.edit(LATEST_SOURCE);
    await vi.advanceTimersByTimeAsync(750);

    latestParse.resolve(validParse(LATEST_SOURCE));
    await settle();
    expect(session.getSnapshot()).toMatchObject({ source: LATEST_SOURCE, validation: "VALID" });

    oldParse.resolve(invalidParse(EDITED_SOURCE));
    await settle();
    expect(session.getSnapshot()).toMatchObject({
      source: LATEST_SOURCE,
      validation: "VALID",
      diagnostics: [],
    });
    session.dispose();
  });

  it("keeps a last-valid graph behind an invalid saved draft and disables schema actions", async () => {
    const state = projectState(INVALID_SOURCE, 2, "INVALID", {
      lastValidRevision: revision(VALID_SOURCE, 1, "VALID"),
    });
    const session = createSession({
      initialState: state,
      parseSource: async (source) =>
        source === INVALID_SOURCE ? invalidParse(source) : validParse(source),
    });

    session.start();
    await settle();

    expect(session.getSnapshot()).toMatchObject({
      persistence: "SAVED",
      validation: "INVALID",
      activeGraphSource: "LAST_VALID",
      canUseValidSchema: false,
    });
    expect(session.getSnapshot().activeGraph?.schemaHash).toBe(fakeHash(VALID_SOURCE));
    session.dispose();
  });

  it("continues server autosave after a worker failure and uses server diagnostics as fallback", async () => {
    vi.useFakeTimers();
    const serverDiagnostic: Diagnostic = {
      code: "DBML_PARSE_SYNTAX_UNEXPECTED_TOKEN",
      message: "Unexpected token.",
      severity: "ERROR",
    };
    const session = createSession({
      parseSource: async (source) => {
        if (source === INVALID_SOURCE) throw new Error("private worker failure");
        return validParse(source);
      },
      saveDraft: async ({ source }) => mutation(source, 2, "INVALID", [serverDiagnostic]),
    });
    session.start();
    await settle();

    session.edit(INVALID_SOURCE);
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    expect(session.getSnapshot()).toMatchObject({
      source: INVALID_SOURCE,
      persistence: "SAVED",
      validation: "ERROR",
      diagnostics: [serverDiagnostic],
      canUseValidSchema: false,
      validationError: { code: "PARSER_WORKER_UNAVAILABLE" },
    });
    session.dispose();
  });

  it("stops autosave on conflict, preserves local source and retries only against the refreshed revision", async () => {
    vi.useFakeTimers();
    const serverState = projectState(LATEST_SOURCE, 2, "VALID");
    const saveDraft = vi
      .fn()
      .mockRejectedValueOnce(
        new ProjectApiError("The project changed.", {
          status: 409,
          code: "PROJECT_SCHEMA_REVISION_CONFLICT",
          currentRevisionNo: 2,
        }),
      )
      .mockResolvedValueOnce(mutation(EDITED_SOURCE, 3, "VALID"));
    const loadProject = vi.fn(async () => serverState);
    const session = createSession({ saveDraft, loadProject });
    session.start();
    await settle();

    session.edit(EDITED_SOURCE);
    await vi.advanceTimersByTimeAsync(750);
    await settle();

    expect(session.getSnapshot()).toMatchObject({
      source: EDITED_SOURCE,
      persistence: "CONFLICT",
      conflictState: serverState,
    });
    session.edit(`${EDITED_SOURCE}\n// local note`);
    await vi.advanceTimersByTimeAsync(750);
    expect(saveDraft).toHaveBeenCalledOnce();

    session.retryLocalDraft();
    await settle();
    expect(saveDraft.mock.calls[1]?.[0]).toMatchObject({
      source: `${EDITED_SOURCE}\n// local note`,
      expectedSchemaRevisionNo: 2,
    });
    session.dispose();
  });

  it("fails closed when browser and authoritative server validity disagree", async () => {
    const session = createSession({
      initialState: projectState(VALID_SOURCE, 1, "VALID"),
      parseSource: async (source) => invalidParse(source),
    });

    session.start();
    await settle();

    expect(session.getSnapshot()).toMatchObject({
      validation: "ERROR",
      canUseValidSchema: false,
      validationError: { code: "SOURCE_VALIDITY_MISMATCH" },
    });
    session.dispose();
  });

  it("fails closed when the persisted hash does not match the initial draft bytes", async () => {
    const state = projectState(VALID_SOURCE, 1, "VALID");
    state.project.draftHash = "f".repeat(64);
    state.currentRevision.sourceHash = "f".repeat(64);
    const session = createSession({ initialState: state });

    session.start();
    await settle();

    expect(session.getSnapshot()).toMatchObject({
      validation: "ERROR",
      canUseValidSchema: false,
      validationError: { code: "SOURCE_HASH_MISMATCH" },
    });
    session.dispose();
  });

  it("flushes and waits for the authoritative draft write to settle", async () => {
    const pending = deferred<ProjectMutationResponse>();
    const pendingValidation = deferred<DbmlWorkerParseResult>();
    const saveDraft = vi.fn(async () => pending.promise);
    const session = createSession({
      saveDraft,
      parseSource: async (source) =>
        source === EDITED_SOURCE ? pendingValidation.promise : validParse(source),
    });
    session.start();
    await settle();

    session.edit(EDITED_SOURCE);
    const flushed = session.flushAndWait();
    await settle();

    expect(saveDraft).toHaveBeenCalledOnce();
    expect(session.getSnapshot().persistence).toBe("SAVING");
    pending.resolve(mutation(EDITED_SOURCE, 2, "VALID"));
    await settle();
    expect(session.getSnapshot().persistence).toBe("SAVED");
    let settled = false;
    void flushed.then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);
    pendingValidation.resolve(validParse(EDITED_SOURCE));

    await expect(flushed).resolves.toMatchObject({
      source: EDITED_SOURCE,
      persistence: "SAVED",
      validation: "VALID",
      expectedSchemaRevisionNo: 2,
    });
    session.dispose();
  });

  it("reports the before state and authoritative response for a committed draft write", async () => {
    vi.useFakeTimers();
    const before = projectState(VALID_SOURCE, 1, "VALID");
    const response = mutation(EDITED_SOURCE, 2, "VALID");
    const onDraftCommitted = vi.fn();
    const session = createSession({
      initialState: before,
      saveDraft: async () => response,
      onDraftCommitted,
    });
    session.start();
    await settle();

    session.edit(EDITED_SOURCE);
    await vi.advanceTimersByTimeAsync(SOURCE_AUTOSAVE_DEBOUNCE_MS);
    await settle();

    expect(onDraftCommitted).toHaveBeenCalledExactlyOnceWith(before, response);
    session.dispose();
  });

  it("adopts an authoritative visual-command state without creating a draft write", async () => {
    const saveDraft = vi.fn();
    const parseSource = vi.fn(async (source: string) => validParse(source));
    const onAdoptCommittedSource = vi.fn();
    const session = createSession({ saveDraft, parseSource, onAdoptCommittedSource });
    session.start();
    await settle();

    const adopted = await session.adoptCommittedState(projectState(EDITED_SOURCE, 2, "VALID"));

    expect(saveDraft).not.toHaveBeenCalled();
    expect(onAdoptCommittedSource).toHaveBeenCalledExactlyOnceWith(EDITED_SOURCE);
    expect(parseSource).toHaveBeenLastCalledWith(EDITED_SOURCE);
    expect(adopted).toMatchObject({
      source: EDITED_SOURCE,
      sourceHash: fakeHash(EDITED_SOURCE),
      persistence: "SAVED",
      validation: "VALID",
      activeGraphSource: "CURRENT_DRAFT",
      expectedSchemaRevisionNo: 2,
    });
    session.dispose();
  });

  it("keeps the validated graph display-only while an authoritative state is reparsed", async () => {
    let resolveAdoptedParse: ((result: DbmlWorkerParseResult) => void) | undefined;
    const session = createSession({
      parseSource: async (source) => {
        if (source !== EDITED_SOURCE) return validParse(source);
        return await new Promise<DbmlWorkerParseResult>((resolve) => {
          resolveAdoptedParse = resolve;
        });
      },
    });
    session.start();
    await settle();
    const previousGraph = session.getSnapshot().activeGraph;

    const adoption = session.adoptCommittedState(projectState(EDITED_SOURCE, 2, "VALID"));
    await settle();
    expect(session.getSnapshot()).toMatchObject({
      source: EDITED_SOURCE,
      activeGraph: previousGraph,
      activeGraphSource: null,
      canUseValidSchema: false,
      validation: "VALIDATING",
    });

    resolveAdoptedParse?.(validParse(EDITED_SOURCE));
    const adopted = await adoption;
    expect(adopted).toMatchObject({
      source: EDITED_SOURCE,
      activeGraphSource: "CURRENT_DRAFT",
      canUseValidSchema: true,
      validation: "VALID",
    });
    session.dispose();
  });

  it("keeps authoritative diagnostics when worker validation fails after state adoption", async () => {
    const serverDiagnostic: Diagnostic = {
      code: "DBML_PARSE_SYNTAX_UNEXPECTED_TOKEN",
      message: "Unexpected token.",
      severity: "ERROR",
    };
    const session = createSession({
      parseSource: async (source) => {
        if (source === INVALID_SOURCE) throw new Error("private worker failure");
        return validParse(source);
      },
    });
    session.start();
    await settle();

    const adopted = await session.adoptCommittedState(projectState(INVALID_SOURCE, 2, "INVALID"), [
      serverDiagnostic,
    ]);

    expect(adopted).toMatchObject({
      source: INVALID_SOURCE,
      persistence: "SAVED",
      validation: "ERROR",
      diagnostics: [serverDiagnostic],
      validationError: { code: "PARSER_WORKER_UNAVAILABLE" },
    });
    session.dispose();
  });
});

function createSession(override: Partial<Parameters<typeof createSourceSession>[0]> = {}) {
  const initialState = override.initialState ?? projectState(VALID_SOURCE, 1, "VALID");
  return createSourceSession({
    initialState,
    parseSource: override.parseSource ?? (async (source) => validParse(source)),
    saveDraft: override.saveDraft ?? (async ({ source }) => mutation(source, 2, "VALID")),
    loadProject: override.loadProject ?? (async () => initialState),
    hashSource: async (source) => fakeHash(source),
    ...override,
  });
}

function validParse(source: string): DbmlWorkerParseResult {
  return {
    type: "DBML_PARSE_RESULT",
    requestId: "550e8400-e29b-41d4-a716-446655440000",
    ok: true,
    sourceHash: fakeHash(source),
    parserInputHash: fakeHash(source),
    parserVersion: "9.1.1",
    diagnostics: [],
    graph: graph(source),
  };
}

function invalidParse(source: string): DbmlWorkerParseResult {
  return {
    type: "DBML_PARSE_RESULT",
    requestId: "550e8400-e29b-41d4-a716-446655440000",
    ok: false,
    sourceHash: fakeHash(source),
    parserInputHash: fakeHash(source),
    parserVersion: "9.1.1",
    diagnostics: [
      {
        code: "DBML_PARSE_SYNTAX_UNEXPECTED_TOKEN",
        message: "Unexpected token.",
        severity: "ERROR",
      },
    ],
  };
}

function graph(source: string): SchemaGraph {
  return {
    parserVersion: "9.1.1",
    schemaHash: fakeHash(source),
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

function mutation(
  source: string,
  revisionNo: number,
  validity: "VALID" | "INVALID",
  diagnostics: Diagnostic[] = [],
): ProjectMutationResponse {
  return {
    state: projectState(source, revisionNo, validity),
    diagnostics,
    revisionCreated: true,
  };
}

function projectState(
  source: string,
  revisionNo: number,
  validity: "VALID" | "INVALID",
  override: { readonly lastValidRevision?: ProjectState["lastValidRevision"] } = {},
): ProjectState {
  const currentRevision = revision(source, revisionNo, validity);
  const lastValidRevision =
    override.lastValidRevision ?? (validity === "VALID" ? currentRevision : null);
  return {
    project: {
      id: PROJECT_ID,
      name: "Schema",
      primaryDialect: "POSTGRESQL",
      draftSource: source,
      draftHash: fakeHash(source),
      lastValidRevisionId: lastValidRevision?.id ?? null,
      parserVersion: "9.1.1",
      schemaRevisionNo: revisionNo,
      layoutRevisionNo: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision,
    lastValidRevision,
  };
}

function revision(source: string, revisionNo: number, validity: "VALID" | "INVALID") {
  return {
    id: `019d3f4e-7b6c-7a${revisionNo.toString().padStart(2, "0")}-8def-0123456789ab`,
    projectId: PROJECT_ID,
    revisionNo,
    source,
    sourceHash: fakeHash(source),
    validity,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: {
      errors: validity === "INVALID" ? 1 : 0,
      warnings: 0,
      infos: 0,
      parserVersion: "9.1.1",
    },
    createdAt: CREATED_AT,
  };
}

function fakeHash(source: string): string {
  let value = 0;
  for (const character of source) value = (value * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return value.toString(16).padStart(64, "0");
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
