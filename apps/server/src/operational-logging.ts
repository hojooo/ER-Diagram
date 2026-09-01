import { projectIdSchema, utf8ByteLength } from "@er-diagram/contracts";
import type { RuntimeReleaseIdentity } from "@er-diagram/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

export const OPERATIONAL_LOG_VERSION = 1 as const;

export type HttpOperation =
  | "HEALTH_LIVE"
  | "HEALTH_READY"
  | "LAYOUT_GET"
  | "LAYOUT_SAVE"
  | "PROJECT_CREATE"
  | "PROJECT_DELETE"
  | "PROJECT_DRAFT_SAVE"
  | "PROJECT_GET"
  | "PROJECT_LIST"
  | "PROJECT_RENAME"
  | "PROJECT_REVISION_LIST"
  | "PROJECT_REVISION_RESTORE"
  | "PROJECT_BUNDLE_EXPORT"
  | "PROJECT_BUNDLE_IMPORT"
  | "ROUTE_NOT_FOUND"
  | "RUNTIME_CONFIG_GET"
  | "SQL_EXPORT"
  | "SQL_IMPORT_APPLY"
  | "SQL_IMPORT_PREVIEW"
  | "SQL_IMPORT_STANDALONE_PREVIEW"
  | "UNCLASSIFIED_ROUTE"
  | "VISUAL_COMMAND_APPLY"
  | "WEB_STATIC";

export interface HttpCompletionOperationalLog {
  readonly logVersion: 1;
  readonly event: "HTTP_REQUEST_COMPLETED";
  readonly timestamp: string;
  readonly correlationId: string;
  readonly operation: HttpOperation;
  readonly method: "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT" | "OTHER";
  readonly statusCode: number;
  readonly latencyMs: number;
  readonly projectId?: string;
  readonly requestBytes?: number;
  readonly responseBytes?: number;
  readonly sourceBytes?: number;
  readonly diagnosticCount?: number;
  readonly errorCode?: string;
}

export type ResourceOperationKind =
  | "DBML_PARSE"
  | "INTERNAL_TEST"
  | "SQL_EXPORT"
  | "SQL_IMPORT"
  | "VISUAL_TRANSFORM";

export interface ResourceOperationOperationalLog {
  readonly logVersion: 1;
  readonly event: "RESOURCE_OPERATION_COMPLETED";
  readonly timestamp: string;
  readonly operation: ResourceOperationKind;
  readonly status: "ERROR" | "SUCCESS";
  readonly latencyMs: number;
  readonly inputBytes: number;
  readonly outputBytes?: number;
  readonly tableCount?: number;
  readonly referenceCount?: number;
  readonly schemaElementCount?: number;
  readonly semanticChangeCount?: number;
  readonly parserVersion?: string;
  readonly diagnosticCount?: number;
  readonly diagnosticCodes?: readonly string[];
  readonly diagnosticCodesTruncated?: boolean;
  readonly errorCode?: string;
}

export type ServerLifecycleState = "STARTING" | "READY" | "SHUTTING_DOWN" | "STOPPED" | "FAILED";

export interface ServerLifecycleOperationalLog {
  readonly logVersion: 1;
  readonly event: "SERVER_LIFECYCLE";
  readonly timestamp: string;
  readonly state: ServerLifecycleState;
  readonly reasonCode?: string;
}

export interface ServerReleaseIdentityOperationalLog {
  readonly logVersion: 1;
  readonly event: "SERVER_RELEASE_IDENTITY";
  readonly timestamp: string;
  readonly channel: RuntimeReleaseIdentity["channel"];
  readonly version: string;
  readonly sourceRevision: string | null;
  readonly imageReference: string | null;
  readonly parserVersion: "9.1.1";
  readonly bundleSchemaVersion: 1;
}

export type OperationalLogEvent =
  | HttpCompletionOperationalLog
  | ResourceOperationOperationalLog
  | ServerLifecycleOperationalLog
  | ServerReleaseIdentityOperationalLog;

export interface OperationalLogSink {
  write(event: OperationalLogEvent): void | Promise<void>;
  flush?(): void | Promise<void>;
}

interface RequestLogContext {
  errorCode?: string;
  diagnosticCount?: number;
  operation?: HttpOperation;
}

const requestContexts = new WeakMap<FastifyRequest, RequestLogContext>();

export const NOOP_OPERATIONAL_LOG_SINK: OperationalLogSink = Object.freeze({
  write: (_event: OperationalLogEvent) => undefined,
  flush: () => undefined,
});

export function createJsonLineOperationalLogSink(
  writeLine: (line: string) => unknown = (line) => {
    return new Promise<void>((resolve) => {
      process.stdout.write(line, () => resolve());
    });
  },
): OperationalLogSink {
  const pending = new Set<Promise<void>>();
  return Object.freeze({
    write(event: OperationalLogEvent) {
      const result = writeLine(`${JSON.stringify(event)}\n`);
      if (!isPromiseLike(result)) return;
      const tracked = Promise.resolve(result).finally(() => pending.delete(tracked));
      pending.add(tracked);
      return tracked;
    },
    async flush() {
      await Promise.allSettled([...pending]);
    },
  });
}

export function registerOperationalLogging(
  server: FastifyInstance,
  sink: OperationalLogSink,
): void {
  server.addHook("onResponse", async (request, reply) => {
    try {
      const context = requestContexts.get(request);
      const event = Object.freeze({
        logVersion: OPERATIONAL_LOG_VERSION,
        event: "HTTP_REQUEST_COMPLETED",
        timestamp: utcTimestamp(),
        correlationId: request.id,
        operation: context?.operation ?? resolveOperation(request),
        method: safeMethod(request.method),
        statusCode: reply.statusCode,
        latencyMs: safeLatency(reply.elapsedTime),
        ...validatedProjectId(request),
        ...requestMeasurements(request),
        ...responseMeasurements(reply.getHeader("content-length")),
        ...(context?.diagnosticCount === undefined
          ? {}
          : { diagnosticCount: context.diagnosticCount }),
        ...(context?.errorCode === undefined ? {} : { errorCode: context.errorCode }),
      } satisfies HttpCompletionOperationalLog);
      writeOperationalLog(sink, event);
    } catch {
      // Event measurement is best-effort and must never alter product behavior.
    } finally {
      requestContexts.delete(request);
    }
  });
}

export function writeOperationalLog(sink: OperationalLogSink, event: OperationalLogEvent): void {
  try {
    const pending = sink.write(Object.freeze(event));
    if (isPromiseLike(pending)) void pending.then(undefined, () => undefined);
  } catch {
    // Operational logging is best-effort and must never alter product behavior.
  }
}

export async function flushOperationalLog(sink: OperationalLogSink): Promise<void> {
  try {
    await sink.flush?.();
  } catch {
    // Operational logging is best-effort and must never alter lifecycle behavior.
  }
}

export function recordOperationalError(
  request: FastifyRequest,
  errorCode: string,
  diagnosticCount?: number,
): void {
  const current = requestContexts.get(request);
  requestContexts.set(request, {
    ...(current?.operation ? { operation: current.operation } : {}),
    errorCode: safeErrorCode(errorCode),
    ...(diagnosticCount === undefined ? {} : { diagnosticCount: safeCount(diagnosticCount) }),
  });
}

export function recordStaticWebOperation(request: FastifyRequest): void {
  const current = requestContexts.get(request);
  requestContexts.set(request, {
    ...(current ?? {}),
    operation: "WEB_STATIC",
  });
}

function resolveOperation(request: FastifyRequest): HttpOperation {
  const route = request.routeOptions.url;
  if (route === undefined) return "ROUTE_NOT_FOUND";
  const knownOperation = OPERATIONS.get(`${request.method} ${route}`);
  if (knownOperation) return knownOperation;
  if (
    route === "/*" &&
    (request.method === "GET" || request.method === "HEAD") &&
    !isReservedServerUrl(request.url)
  ) {
    return "WEB_STATIC";
  }
  return route === "/*" ? "ROUTE_NOT_FOUND" : "UNCLASSIFIED_ROUTE";
}

const OPERATIONS = new Map<string, HttpOperation>([
  ["GET /health/live", "HEALTH_LIVE"],
  ["GET /health/ready", "HEALTH_READY"],
  ["GET /api/v1/runtime-config", "RUNTIME_CONFIG_GET"],
  ["GET /api/v1/projects", "PROJECT_LIST"],
  ["POST /api/v1/projects", "PROJECT_CREATE"],
  ["GET /api/v1/projects/:projectId", "PROJECT_GET"],
  ["PATCH /api/v1/projects/:projectId", "PROJECT_RENAME"],
  ["DELETE /api/v1/projects/:projectId", "PROJECT_DELETE"],
  ["PUT /api/v1/projects/:projectId/draft", "PROJECT_DRAFT_SAVE"],
  ["GET /api/v1/projects/:projectId/revisions", "PROJECT_REVISION_LIST"],
  ["POST /api/v1/projects/:projectId/revisions/:revisionNo/restore", "PROJECT_REVISION_RESTORE"],
  ["GET /api/v1/projects/:projectId/layouts/:viewKey", "LAYOUT_GET"],
  ["PUT /api/v1/projects/:projectId/layouts/:viewKey", "LAYOUT_SAVE"],
  ["POST /api/v1/sql-import/preview", "SQL_IMPORT_STANDALONE_PREVIEW"],
  ["POST /api/v1/projects/:projectId/sql-import/preview", "SQL_IMPORT_PREVIEW"],
  ["POST /api/v1/projects/:projectId/sql-import/apply", "SQL_IMPORT_APPLY"],
  ["POST /api/v1/projects/:projectId/sql-export", "SQL_EXPORT"],
  ["POST /api/v1/projects/:projectId/visual-commands", "VISUAL_COMMAND_APPLY"],
  ["POST /api/v1/projects/:projectId/bundle-export", "PROJECT_BUNDLE_EXPORT"],
  ["POST /api/v1/project-bundles/import", "PROJECT_BUNDLE_IMPORT"],
]);

function isReservedServerUrl(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? "/";
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/health" ||
    pathname.startsWith("/health/")
  );
}

function safeMethod(method: string): HttpCompletionOperationalLog["method"] {
  switch (method) {
    case "DELETE":
    case "GET":
    case "HEAD":
    case "OPTIONS":
    case "PATCH":
    case "POST":
    case "PUT":
      return method;
    default:
      return "OTHER";
  }
}

function validatedProjectId(request: FastifyRequest): { readonly projectId?: string } {
  if (!isRecord(request.params)) return {};
  const parsed = projectIdSchema.safeParse(request.params.projectId);
  return parsed.success ? { projectId: parsed.data } : {};
}

function requestMeasurements(request: FastifyRequest): {
  readonly requestBytes?: number;
  readonly sourceBytes?: number;
} {
  const requestBytes = safeHeaderSize(request.headers["content-length"]);
  const body = request.body;
  const sourceBytes =
    isRecord(body) && typeof body.source === "string" ? utf8ByteLength(body.source) : undefined;
  return {
    ...(requestBytes === undefined ? {} : { requestBytes }),
    ...(sourceBytes === undefined ? {} : { sourceBytes }),
  };
}

function responseMeasurements(contentLength: string | number | string[] | undefined): {
  readonly responseBytes?: number;
} {
  const responseBytes = safeHeaderSize(contentLength);
  return responseBytes === undefined ? {} : { responseBytes };
}

function safeHeaderSize(value: string | number | string[] | undefined): number | undefined {
  const candidate = Array.isArray(value) ? undefined : value;
  if (typeof candidate === "number") return safeCount(candidate);
  if (typeof candidate !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(candidate)) return undefined;
  const parsed = Number(candidate);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function safeLatency(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 1_000) / 1_000;
}

export function utcTimestamp(): string {
  return new Date().toISOString();
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeErrorCode(value: string): string {
  return /^[A-Z][A-Z0-9_]*$/u.test(value) ? value : "INTERNAL_SERVER_ERROR";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
