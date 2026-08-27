import type { DbmlParserWorkerRequest, DbmlParserWorkerResponse } from "@er-diagram/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createDbmlParserWorkerClient,
  DbmlParserWorkerClientError,
  type DbmlParserWorkerLike,
} from "../src/source-editor/parser-worker-client.js";

const REQUEST_IDS = [
  "550e8400-e29b-41d4-a716-446655440000",
  "550e8400-e29b-41d4-a716-446655440001",
  "550e8400-e29b-41d4-a716-446655440002",
];

const emptyGraph = {
  parserVersion: "9.1.1",
  schemaHash: "c".repeat(64),
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

describe("DBML parser worker client", () => {
  it("keeps one worker and matches out-of-order responses by request ID", async () => {
    const worker = new FakeParserWorker();
    const client = createClient([worker]);

    const first = client.parse("Table first { id int }");
    const second = client.parse("Table second { id int }");
    await vi.waitFor(() => expect(worker.requests).toHaveLength(2));

    worker.succeed(1);
    worker.succeed(0);

    await expect(second).resolves.toMatchObject({ ok: true, graph: emptyGraph });
    await expect(first).resolves.toMatchObject({ ok: true, graph: emptyGraph });
    expect(worker.terminate).not.toHaveBeenCalled();

    client.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("ignores an unrelated stale response without changing a pending request", async () => {
    const worker = new FakeParserWorker();
    const client = createClient([worker]);
    const result = client.parse("Table users { id int }");
    await vi.waitFor(() => expect(worker.requests).toHaveLength(1));

    worker.emit({
      ...worker.successResponse(0),
      requestId: REQUEST_IDS[2] ?? "",
    });
    worker.succeed(0);

    await expect(result).resolves.toMatchObject({ ok: true });
    client.dispose();
  });

  it.each([
    [
      "source hash mismatch",
      (worker: FakeParserWorker) => worker.succeed(0, { sourceHash: "d".repeat(64) }),
    ],
    [
      "parser-input hash mismatch",
      (worker: FakeParserWorker) => worker.succeed(0, { parserInputHash: "d".repeat(64) }),
    ],
    [
      "parser version mismatch",
      (worker: FakeParserWorker) => worker.succeed(0, { parserVersion: "9.2.0" }),
    ],
    ["malformed graph", (worker: FakeParserWorker) => worker.succeed(0, { graph: { tables: [] } })],
  ])("fails closed for %s", async (_name, respond) => {
    const worker = new FakeParserWorker();
    const client = createClient([worker]);
    const result = client.parse("Table users { id int }");
    await vi.waitFor(() => expect(worker.requests).toHaveLength(1));

    respond(worker);

    await expect(result).rejects.toBeInstanceOf(DbmlParserWorkerClientError);
    await expect(result).rejects.toMatchObject({ code: "PARSER_WORKER_PROTOCOL_ERROR" });
    client.dispose();
  });

  it("terminates on timeout and creates a fresh worker for the next request", async () => {
    vi.useFakeTimers();
    const firstWorker = new FakeParserWorker();
    const secondWorker = new FakeParserWorker();
    const client = createClient([firstWorker, secondWorker], 25);

    const timedOut = client.parse("Table timeout { id int }");
    const timeoutRejection = expect(timedOut).rejects.toMatchObject({
      code: "PARSER_WORKER_TIMEOUT",
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    await timeoutRejection;
    expect(firstWorker.terminate).toHaveBeenCalledOnce();

    const retried = client.parse("Table recovered { id int }");
    await Promise.resolve();
    secondWorker.succeed(0);
    await expect(retried).resolves.toMatchObject({ ok: true });
    client.dispose();
    vi.useRealTimers();
  });

  it("isolates a worker crash and rejects pending work without exposing the native error", async () => {
    const worker = new FakeParserWorker();
    const client = createClient([worker]);
    const first = client.parse("Table one { id int }");
    const second = client.parse("Table two { id int }");
    await vi.waitFor(() => expect(worker.requests).toHaveLength(2));

    worker.crash("private parser stack");

    await expect(first).rejects.toMatchObject({
      code: "PARSER_WORKER_CRASH",
      message: "The DBML parser worker stopped unexpectedly.",
    });
    await expect(second).rejects.toMatchObject({ code: "PARSER_WORKER_CRASH" });
    expect(worker.terminate).toHaveBeenCalledOnce();
    client.dispose();
  });
});

function createClient(workers: FakeParserWorker[], timeoutMs = 100) {
  let requestIndex = 0;
  let workerIndex = 0;
  return createDbmlParserWorkerClient({
    timeoutMs,
    generateRequestId: () => REQUEST_IDS[requestIndex++] ?? REQUEST_IDS[0] ?? "",
    hashSource: async () => "a".repeat(64),
    workerFactory: () => workers[workerIndex++] as DbmlParserWorkerLike,
  });
}

class FakeParserWorker implements DbmlParserWorkerLike {
  readonly requests: DbmlParserWorkerRequest[] = [];
  readonly terminate = vi.fn();
  private readonly messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>();

  postMessage(message: DbmlParserWorkerRequest): void {
    this.requests.push(message);
  }

  addEventListener(type: "message" | "error", listener: EventListener): void {
    if (type === "message")
      this.messageListeners.add(listener as (event: MessageEvent<unknown>) => void);
    else this.errorListeners.add(listener as (event: ErrorEvent) => void);
  }

  removeEventListener(type: "message" | "error", listener: EventListener): void {
    if (type === "message")
      this.messageListeners.delete(listener as (event: MessageEvent<unknown>) => void);
    else this.errorListeners.delete(listener as (event: ErrorEvent) => void);
  }

  successResponse(index: number): Extract<DbmlParserWorkerResponse, { ok: true }> {
    const request = this.requests[index];
    if (!request) throw new Error(`Missing request at index ${index}.`);
    return {
      type: "DBML_PARSE_RESULT",
      requestId: request.requestId,
      ok: true,
      sourceHash: request.sourceHash,
      parserInputHash: request.sourceHash,
      parserVersion: "9.1.1",
      diagnostics: [],
      graph: emptyGraph,
    };
  }

  succeed(
    index: number,
    override: Partial<Extract<DbmlParserWorkerResponse, { ok: true }>> = {},
  ): void {
    this.emit({ ...this.successResponse(index), ...override });
  }

  emit(response: unknown): void {
    for (const listener of this.messageListeners) {
      listener({ data: response } as MessageEvent<unknown>);
    }
  }

  crash(message: string): void {
    for (const listener of this.errorListeners) listener({ message } as ErrorEvent);
  }
}
