import { parentPort, workerData } from "node:worker_threads";
import { utf8ByteLength } from "@er-diagram/contracts";
import {
  convertDbmlToSqlExport,
  convertSqlImport,
  measureSchemaGraph,
  parseDbmlV2,
  type SchemaGraph,
} from "@er-diagram/core";
import { transformVisualCommand } from "@er-diagram/source-transform";

import { ResourceOperationError } from "./resource-errors.js";
import { parseServerResourceLimits, type ServerResourceLimits } from "./resource-limits.js";
import type {
  ResourceWorkerOperation,
  ResourceWorkerRequest,
  ResourceWorkerResponse,
} from "./resource-worker-protocol.js";

interface ResourceWorkerData {
  readonly limits: ServerResourceLimits;
  readonly allowTestOperations?: boolean;
}

const data = workerData as ResourceWorkerData;
const limits = parseServerResourceLimits(data.limits);

if (!parentPort) throw new Error("Resource worker requires a parent message port.");
const port = parentPort;

port.on("message", (input: unknown) => {
  if (!isWorkerRequest(input)) {
    throw new Error("Resource worker received an invalid protocol message.");
  }
  if (input.operation.type === "TEST_PROTOCOL") {
    requireTestOperations();
    port.postMessage({ requestId: input.requestId, ok: "invalid" });
    return;
  }
  void execute(input.operation).then(
    (value) => {
      const response: ResourceWorkerResponse = { requestId: input.requestId, ok: true, value };
      port.postMessage(response);
    },
    (error: unknown) => {
      if (error instanceof ResourceOperationError) {
        const response: ResourceWorkerResponse = {
          requestId: input.requestId,
          ok: false,
          error: { code: error.code },
        };
        port.postMessage(response);
        return;
      }
      const response: ResourceWorkerResponse = {
        requestId: input.requestId,
        ok: false,
        error: { code: "RESOURCE_WORKER_CRASHED" },
      };
      port.postMessage(response);
    },
  );
});

async function execute(operation: ResourceWorkerOperation): Promise<unknown> {
  switch (operation.type) {
    case "PARSE_DBML": {
      assertSource(operation.source);
      const result = await parseDbmlV2(operation.source, operation.filepath);
      if (result.ok) assertGraph(result.graph);
      assertOutput(result);
      return result;
    }
    case "CONVERT_SQL_IMPORT": {
      assertSource(operation.input.source);
      const result = await convertSqlImport(operation.input);
      if (result.ok) {
        if (utf8ByteLength(result.candidate.dbml) > limits.maxSourceBytes) {
          throw new ResourceOperationError("RESOURCE_COMPLEXITY_LIMIT_EXCEEDED");
        }
        assertGraph(result.candidate.graph);
      }
      assertOutput(result);
      return result;
    }
    case "CONVERT_SQL_EXPORT": {
      assertSource(operation.input.source);
      const parsed = await parseDbmlV2(operation.input.source, operation.input.filepath);
      if (parsed.ok) assertGraph(parsed.graph);
      const result = await convertDbmlToSqlExport(operation.input);
      assertOutput(result);
      return result;
    }
    case "TRANSFORM_VISUAL_COMMAND": {
      assertSource(operation.source);
      const before = await parseDbmlV2(operation.source, operation.filepath);
      if (before.ok) assertGraph(before.graph);
      const result = await transformVisualCommand(
        operation.source,
        operation.command,
        operation.filepath,
      );
      if (result.ok) {
        assertSource(result.source);
        const after = await parseDbmlV2(result.source, operation.filepath);
        if (after.ok) assertGraph(after.graph);
      }
      assertOutput(result);
      return result;
    }
    case "TEST_HANG":
      requireTestOperations();
      return new Promise<never>(() => undefined);
    case "TEST_CRASH":
      requireTestOperations();
      throw new Error("test-only worker crash");
    case "TEST_OOM": {
      requireTestOperations();
      return exhaustWorkerHeap();
    }
    case "TEST_PROTOCOL":
      throw new Error("test-only protocol path must be handled before execution");
  }
}

function exhaustWorkerHeap(): never {
  const retained: Array<{ readonly index: number; readonly value: string }> = [];
  while (true) retained.push({ index: retained.length, value: "x".repeat(4_096) });
}

function assertSource(source: string): void {
  if (utf8ByteLength(source) > limits.maxSourceBytes) {
    throw new ResourceOperationError("RESOURCE_SOURCE_TOO_LARGE");
  }
}

function assertGraph(graph: SchemaGraph): void {
  const metrics = measureSchemaGraph(graph);
  if (
    metrics.tables > limits.maxTables ||
    metrics.references > limits.maxReferences ||
    metrics.totalElements > limits.maxSchemaElements
  ) {
    throw new ResourceOperationError("RESOURCE_COMPLEXITY_LIMIT_EXCEEDED");
  }
}

function assertOutput(value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (utf8ByteLength(serialized) > limits.maxGeneratedOutputBytes) {
    throw new ResourceOperationError("RESOURCE_OUTPUT_TOO_LARGE");
  }
}

function requireTestOperations(): void {
  if (data.allowTestOperations !== true) {
    throw new Error("Test-only worker operation is disabled.");
  }
}

function isWorkerRequest(input: unknown): input is ResourceWorkerRequest {
  if (input === null || typeof input !== "object") return false;
  if (typeof (input as { requestId?: unknown }).requestId !== "string") return false;
  const operation = (input as { operation?: unknown }).operation;
  if (operation === null || typeof operation !== "object") return false;
  const type = (operation as { type?: unknown }).type;
  return typeof type === "string" && WORKER_OPERATION_TYPES.has(type);
}

const WORKER_OPERATION_TYPES = new Set([
  "PARSE_DBML",
  "CONVERT_SQL_IMPORT",
  "CONVERT_SQL_EXPORT",
  "TRANSFORM_VISUAL_COMMAND",
  "TEST_CRASH",
  "TEST_HANG",
  "TEST_OOM",
  "TEST_PROTOCOL",
]);
