import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { VisualCommand } from "@er-diagram/contracts";
import type {
  DbmlParseResult,
  SqlExportConversionInput,
  SqlExportConversionResult,
  SqlImportConversionInput,
  SqlImportConversionResult,
  VisualCommandTransformResult,
} from "@er-diagram/core";

import { ResourceOperationError } from "./resource-errors.js";
import {
  DEFAULT_SERVER_RESOURCE_LIMITS,
  parseServerResourceLimits,
  type ServerResourceLimits,
} from "./resource-limits.js";
import type {
  ResourceOperationResultMap,
  ResourceWorkerOperation,
  ResourceWorkerRequest,
  ResourceWorkerResponse,
} from "./resource-worker-protocol.js";

export interface ResourceExecutor {
  readonly limits: ServerResourceLimits;
  parseDbml(source: string, filepath?: string): Promise<DbmlParseResult>;
  convertSqlImport(input: SqlImportConversionInput): Promise<SqlImportConversionResult>;
  convertSqlExport(input: SqlExportConversionInput): Promise<SqlExportConversionResult>;
  transformVisualCommand(
    source: string,
    command: VisualCommand,
    filepath?: string,
  ): Promise<VisualCommandTransformResult>;
  close(): Promise<void>;
}

export interface CreateResourceExecutorOptions {
  readonly limits?: ServerResourceLimits;
  readonly allowTestOperations?: boolean;
  readonly workerUrl?: URL;
}

interface PendingOperation {
  readonly request: ResourceWorkerRequest;
  readonly timeoutMs: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: ResourceOperationError) => void;
  queueTimeout?: ReturnType<typeof setTimeout>;
}

interface ActiveOperation extends PendingOperation {
  operationTimeout: ReturnType<typeof setTimeout>;
}

interface WorkerSlot {
  readonly worker: Worker;
  active: ActiveOperation | undefined;
}

export class BoundedResourceWorkerPool implements ResourceExecutor {
  readonly #limits: ServerResourceLimits;
  readonly #allowTestOperations: boolean;
  readonly #workerUrl: URL;
  readonly #slots: WorkerSlot[] = [];
  readonly #queue: PendingOperation[] = [];
  #closed = false;

  constructor(options: CreateResourceExecutorOptions = {}) {
    this.#limits = parseServerResourceLimits(options.limits ?? DEFAULT_SERVER_RESOURCE_LIMITS);
    this.#allowTestOperations = options.allowTestOperations ?? false;
    this.#workerUrl = options.workerUrl ?? new URL("./resource-worker.js", import.meta.url);
    for (let index = 0; index < this.#limits.workerPoolSize; index += 1) {
      this.#slots.push(this.#createSlot(index));
    }
  }

  get limits(): ServerResourceLimits {
    return this.#limits;
  }

  parseDbml(source: string, filepath = "/main.dbml"): Promise<DbmlParseResult> {
    return this.#submit({ type: "PARSE_DBML", source, filepath });
  }

  convertSqlImport(input: SqlImportConversionInput): Promise<SqlImportConversionResult> {
    return this.#submit({ type: "CONVERT_SQL_IMPORT", input });
  }

  convertSqlExport(input: SqlExportConversionInput): Promise<SqlExportConversionResult> {
    return this.#submit({ type: "CONVERT_SQL_EXPORT", input });
  }

  transformVisualCommand(
    source: string,
    command: VisualCommand,
    filepath = "/main.dbml",
  ): Promise<VisualCommandTransformResult> {
    return this.#submit({ type: "TRANSFORM_VISUAL_COMMAND", source, command, filepath });
  }

  /** @internal Security tests only. */
  executeTestOperation(
    type: "TEST_CRASH" | "TEST_HANG" | "TEST_OOM" | "TEST_PROTOCOL",
  ): Promise<never> {
    if (!this.#allowTestOperations) {
      return Promise.reject(new ResourceOperationError("RESOURCE_WORKER_CRASHED"));
    }
    return this.#submit({ type });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#queue.splice(0)) {
      if (pending.queueTimeout) clearTimeout(pending.queueTimeout);
      pending.reject(new ResourceOperationError("RESOURCE_WORKER_CRASHED"));
    }
    const terminations = this.#slots.map(async (slot) => {
      if (slot.active) {
        clearTimeout(slot.active.operationTimeout);
        slot.active.reject(new ResourceOperationError("RESOURCE_WORKER_CRASHED"));
        slot.active = undefined;
      }
      slot.worker.removeAllListeners();
      await slot.worker.terminate();
    });
    await Promise.all(terminations);
  }

  #submit<Operation extends ResourceWorkerOperation>(
    operation: Operation,
  ): Promise<ResourceOperationResultMap[Operation["type"]]> {
    if (this.#closed) {
      return Promise.reject(new ResourceOperationError("RESOURCE_WORKER_CRASHED"));
    }
    const timeoutMs = operationTimeoutMs(operation, this.#limits);
    return new Promise((resolve, reject) => {
      const pending: PendingOperation = {
        request: { requestId: randomUUID(), operation },
        timeoutMs,
        resolve: (value) => resolve(value as ResourceOperationResultMap[Operation["type"]]),
        reject,
      };
      const idle = this.#slots.findIndex((slot) => slot.active === undefined);
      if (idle >= 0) {
        this.#start(idle, pending);
        return;
      }
      if (this.#queue.length >= this.#limits.maxWorkerQueue) {
        reject(new ResourceOperationError("RESOURCE_WORKER_BUSY"));
        return;
      }
      pending.queueTimeout = setTimeout(() => {
        const index = this.#queue.indexOf(pending);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(new ResourceOperationError("RESOURCE_WORKER_BUSY"));
      }, this.#limits.workerQueueTimeoutMs);
      this.#queue.push(pending);
    }) as Promise<ResourceOperationResultMap[Operation["type"]]>;
  }

  #createSlot(index: number): WorkerSlot {
    const worker = new Worker(this.#workerUrl, {
      execArgv: [],
      workerData: {
        limits: this.#limits,
        allowTestOperations: this.#allowTestOperations,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: this.#limits.workerMaxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: this.#limits.workerMaxYoungGenerationSizeMb,
        stackSizeMb: this.#limits.workerStackSizeMb,
      },
    });
    const slot: WorkerSlot = { worker, active: undefined };
    worker.on("message", (message: unknown) => this.#handleMessage(index, slot, message));
    worker.on("error", () => this.#replace(index, slot, "RESOURCE_WORKER_CRASHED"));
    worker.on("exit", () => {
      if (!this.#closed && this.#slots[index] === slot) {
        this.#replace(index, slot, "RESOURCE_WORKER_CRASHED", false);
      }
    });
    return slot;
  }

  #start(index: number, pending: PendingOperation): void {
    if (pending.queueTimeout) clearTimeout(pending.queueTimeout);
    const slot = this.#slots[index];
    if (!slot || slot.active || this.#closed) {
      pending.reject(new ResourceOperationError("RESOURCE_WORKER_CRASHED"));
      return;
    }
    const operationTimeout = setTimeout(() => {
      this.#replace(index, slot, "RESOURCE_WORKER_TIMEOUT");
    }, pending.timeoutMs);
    slot.active = { ...pending, operationTimeout };
    try {
      slot.worker.postMessage(pending.request);
    } catch {
      this.#replace(index, slot, "RESOURCE_WORKER_CRASHED");
    }
  }

  #handleMessage(index: number, slot: WorkerSlot, message: unknown): void {
    if (this.#slots[index] !== slot || !slot.active) return;
    if (!isWorkerResponse(message) || message.requestId !== slot.active.request.requestId) {
      this.#replace(index, slot, "RESOURCE_WORKER_CRASHED");
      return;
    }

    const active = slot.active;
    clearTimeout(active.operationTimeout);
    slot.active = undefined;
    if (message.ok) {
      active.resolve(message.value);
    } else {
      active.reject(new ResourceOperationError(message.error.code));
      if (message.error.code === "RESOURCE_WORKER_CRASHED") {
        this.#replace(index, slot, "RESOURCE_WORKER_CRASHED");
        return;
      }
    }
    this.#drain(index);
  }

  #replace(
    index: number,
    slot: WorkerSlot,
    code: "RESOURCE_WORKER_CRASHED" | "RESOURCE_WORKER_TIMEOUT",
    terminate = true,
  ): void {
    if (this.#slots[index] !== slot) return;
    if (slot.active) {
      clearTimeout(slot.active.operationTimeout);
      slot.active.reject(new ResourceOperationError(code));
      slot.active = undefined;
    }
    slot.worker.removeAllListeners();
    if (terminate) void slot.worker.terminate();
    if (this.#closed) return;
    this.#slots[index] = this.#createSlot(index);
    this.#drain(index);
  }

  #drain(index: number): void {
    if (this.#closed || this.#slots[index]?.active || this.#queue.length === 0) return;
    const next = this.#queue.shift();
    if (next) this.#start(index, next);
  }
}

export function createResourceExecutor(
  options: CreateResourceExecutorOptions = {},
): BoundedResourceWorkerPool {
  return new BoundedResourceWorkerPool(options);
}

function operationTimeoutMs(
  operation: ResourceWorkerOperation,
  limits: ServerResourceLimits,
): number {
  switch (operation.type) {
    case "PARSE_DBML":
      return limits.dbmlParserTimeoutMs;
    case "CONVERT_SQL_IMPORT":
    case "CONVERT_SQL_EXPORT":
      return limits.sqlConversionTimeoutMs;
    case "TRANSFORM_VISUAL_COMMAND":
      return limits.visualTransformTimeoutMs;
    case "TEST_CRASH":
    case "TEST_HANG":
    case "TEST_OOM":
    case "TEST_PROTOCOL":
      return limits.dbmlParserTimeoutMs;
  }
}

function isWorkerResponse(value: unknown): value is ResourceWorkerResponse {
  if (value === null || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  if (typeof response.requestId !== "string" || typeof response.ok !== "boolean") return false;
  if (response.ok) return "value" in response;
  const error = response.error;
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && WORKER_ERROR_CODES.has(code);
}

const WORKER_ERROR_CODES = new Set([
  "RESOURCE_SOURCE_TOO_LARGE",
  "RESOURCE_COMPLEXITY_LIMIT_EXCEEDED",
  "RESOURCE_OUTPUT_TOO_LARGE",
  "RESOURCE_WORKER_BUSY",
  "RESOURCE_WORKER_TIMEOUT",
  "RESOURCE_WORKER_CRASHED",
]);
