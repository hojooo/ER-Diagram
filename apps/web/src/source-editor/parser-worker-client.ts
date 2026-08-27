import {
  type DbmlParserWorkerRequest,
  type DbmlParserWorkerResponse,
  dbmlParserWorkerRequestSchema,
  dbmlParserWorkerResponseSchema,
} from "@er-diagram/contracts";
import { DBML_PARSER_VERSION, type SchemaGraph } from "@er-diagram/core";

import { hashDbmlSource } from "./source-hash.js";

export const DBML_PARSER_WORKER_TIMEOUT_MS = 5_000;

export interface DbmlParserWorkerLike {
  postMessage(message: DbmlParserWorkerRequest): void;
  addEventListener(type: "message" | "error", listener: EventListener): void;
  removeEventListener(type: "message" | "error", listener: EventListener): void;
  terminate(): void;
}

export type DbmlWorkerParseResult =
  | (Omit<Extract<DbmlParserWorkerResponse, { ok: true }>, "graph"> & {
      readonly graph: SchemaGraph;
    })
  | Extract<DbmlParserWorkerResponse, { ok: false }>;

export class DbmlParserWorkerClientError extends Error {
  constructor(
    readonly code:
      | "PARSER_WORKER_CRASH"
      | "PARSER_WORKER_DISPOSED"
      | "PARSER_WORKER_PROTOCOL_ERROR"
      | "PARSER_WORKER_TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "DbmlParserWorkerClientError";
  }
}

export interface DbmlParserWorkerClient {
  parse(source: string): Promise<DbmlWorkerParseResult>;
  dispose(): void;
}

interface CreateDbmlParserWorkerClientOptions {
  readonly workerFactory?: () => DbmlParserWorkerLike;
  readonly timeoutMs?: number;
  readonly generateRequestId?: () => string;
  readonly hashSource?: (source: string) => Promise<string>;
}

interface PendingRequest {
  readonly sourceHash: string;
  readonly resolve: (result: DbmlWorkerParseResult) => void;
  readonly reject: (error: DbmlParserWorkerClientError) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export function createDbmlParserWorkerClient(
  options: CreateDbmlParserWorkerClientOptions = {},
): DbmlParserWorkerClient {
  const timeoutMs = options.timeoutMs ?? DBML_PARSER_WORKER_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("DBML parser worker timeout must be a finite positive number.");
  }

  const workerFactory = options.workerFactory ?? createBrowserParserWorker;
  const generateRequestId = options.generateRequestId ?? generateBrowserUuid;
  const hashSource = options.hashSource ?? hashDbmlSource;
  const pending = new Map<string, PendingRequest>();
  let worker: DbmlParserWorkerLike | undefined;
  let disposed = false;

  const handleMessage = (event: MessageEvent<unknown>): void => {
    const parsed = dbmlParserWorkerResponseSchema.safeParse(event.data);
    if (!parsed.success) {
      invalidateWorker(
        new DbmlParserWorkerClientError(
          "PARSER_WORKER_PROTOCOL_ERROR",
          "The DBML parser worker returned an invalid response.",
        ),
      );
      return;
    }

    const response = parsed.data;
    const request = pending.get(response.requestId);
    if (!request) return;

    if (
      response.sourceHash !== request.sourceHash ||
      response.parserInputHash !== request.sourceHash ||
      response.parserVersion !== DBML_PARSER_VERSION ||
      (response.ok && !isSchemaGraphTransport(response.graph))
    ) {
      invalidateWorker(
        new DbmlParserWorkerClientError(
          "PARSER_WORKER_PROTOCOL_ERROR",
          "The DBML parser worker response did not match its request.",
        ),
      );
      return;
    }

    clearTimeout(request.timeout);
    pending.delete(response.requestId);
    request.resolve(response as DbmlWorkerParseResult);
  };

  const handleError = (): void => {
    invalidateWorker(
      new DbmlParserWorkerClientError(
        "PARSER_WORKER_CRASH",
        "The DBML parser worker stopped unexpectedly.",
      ),
    );
  };

  function ensureWorker(): DbmlParserWorkerLike {
    if (worker) return worker;
    worker = workerFactory();
    worker.addEventListener("message", handleMessage as EventListener);
    worker.addEventListener("error", handleError as EventListener);
    return worker;
  }

  function invalidateWorker(error: DbmlParserWorkerClientError): void {
    if (worker) {
      worker.removeEventListener("message", handleMessage as EventListener);
      worker.removeEventListener("error", handleError as EventListener);
      worker.terminate();
      worker = undefined;
    }
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  }

  return {
    async parse(source) {
      if (disposed) {
        throw new DbmlParserWorkerClientError(
          "PARSER_WORKER_DISPOSED",
          "The DBML parser worker client is no longer available.",
        );
      }

      const sourceHash = await hashSource(source);
      if (disposed) {
        throw new DbmlParserWorkerClientError(
          "PARSER_WORKER_DISPOSED",
          "The DBML parser worker client is no longer available.",
        );
      }

      const request = dbmlParserWorkerRequestSchema.parse({
        type: "PARSE_DBML",
        requestId: generateRequestId(),
        filepath: "/main.dbml",
        source,
        sourceHash,
      });
      const activeWorker = ensureWorker();

      return new Promise<DbmlWorkerParseResult>((resolve, reject) => {
        const timeout = setTimeout(() => {
          invalidateWorker(
            new DbmlParserWorkerClientError(
              "PARSER_WORKER_TIMEOUT",
              `DBML validation exceeded the ${timeoutMs} ms limit.`,
            ),
          );
        }, timeoutMs);
        pending.set(request.requestId, { sourceHash, resolve, reject, timeout });
        activeWorker.postMessage(request);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      invalidateWorker(
        new DbmlParserWorkerClientError(
          "PARSER_WORKER_DISPOSED",
          "The DBML parser worker client was disposed.",
        ),
      );
    },
  };
}

function isSchemaGraphTransport(value: unknown): value is SchemaGraph {
  if (!isPlainRecord(value)) return false;
  if (value.parserVersion !== DBML_PARSER_VERSION) return false;
  if (typeof value.schemaHash !== "string" || !/^[0-9a-f]{64}$/.test(value.schemaHash))
    return false;
  if (value.project !== null && !isPlainRecord(value.project)) return false;
  if (!isPlainRecord(value.sourceMap)) return false;

  for (const field of [
    "notes",
    "tables",
    "enums",
    "references",
    "groups",
    "partials",
    "views",
    "diagnostics",
  ]) {
    if (!Array.isArray(value[field])) return false;
  }
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createBrowserParserWorker(): DbmlParserWorkerLike {
  return new Worker(new URL("./parser.worker.ts", import.meta.url), {
    type: "module",
    name: "er-diagram-dbml-parser",
  });
}

function generateBrowserUuid(): string {
  return globalThis.crypto.randomUUID();
}
