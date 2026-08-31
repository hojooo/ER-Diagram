import type {
  LayoutApplication,
  ProjectApplication,
  SqlExportApplication,
  SqlImportApplication,
  VisualCommandApplication,
} from "@er-diagram/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTENT_SECURITY_POLICY,
  createJsonLineOperationalLogSink,
  createResourceExecutor,
  createServer,
  DEFAULT_SERVER_RESOURCE_LIMITS,
  type HttpCompletionOperationalLog,
  type OperationalLogEvent,
  type OperationalLogSink,
  SECURITY_HEADERS,
  SECURITY_POLICY_VERSION,
} from "../src/index.js";

const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const COMMAND_ID = "550e8400-e29b-41d4-a716-446655440000";
const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const SENTINEL = "private-source-<script>alert('leak')</script>-SELECT secret_value";
const workerUrl = new URL("../dist/resource-worker.js", import.meta.url);

const servers = new Set<ReturnType<typeof createServer>>();
const executors = new Set<ReturnType<typeof createResourceExecutor>>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  await Promise.all([...executors].map((executor) => executor.close()));
  servers.clear();
  executors.clear();
});

describe("Fastify security headers and operational logs", () => {
  it("enforces the same security policy on success and every public error class", async () => {
    const events: OperationalLogEvent[] = [];
    const server = trackedServer(events);
    const responses = [
      await server.inject({ method: "GET", url: "/health/live" }),
      await server.inject({
        method: "GET",
        url: `/missing?source=${encodeURIComponent(SENTINEL)}`,
      }),
      await server.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { "content-type": "application/json" },
        payload: `{"source":"${SENTINEL}`,
      }),
      await server.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ source: SENTINEL.repeat(20) }),
      }),
      await server.inject({
        method: "POST",
        url: "/api/v1/projects",
        payload: createProjectPayload(SENTINEL),
      }),
      await server.inject({ method: "GET", url: "/api/v1/projects" }),
      await server.inject({ method: "GET", url: `/api/v1/projects/${PROJECT_ID}` }),
    ];

    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 404, 400, 413, 422, 500, 404,
    ]);
    for (const response of responses) {
      for (const [header, expected] of Object.entries(SECURITY_HEADERS)) {
        expect(response.headers[header]).toBe(expected);
      }
      expect(response.headers["strict-transport-security"]).toBeUndefined();
      expect(response.headers["x-correlation-id"]).toBe(CORRELATION_ID);
    }
    expect(SECURITY_POLICY_VERSION).toBe(1);
    expect(CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*'unsafe-inline'/u);

    expect(events).toHaveLength(responses.length);
    const httpEvents = events as HttpCompletionOperationalLog[];
    expect(httpEvents.map((event) => event.statusCode)).toEqual([
      200, 404, 400, 413, 422, 500, 404,
    ]);
    expect(httpEvents.map((event) => event.errorCode)).toEqual([
      undefined,
      "ROUTE_NOT_FOUND",
      "REQUEST_VALIDATION_FAILED",
      "REQUEST_BODY_TOO_LARGE",
      "PROJECT_NAME_INVALID",
      "INTERNAL_SERVER_ERROR",
      "PROJECT_NOT_FOUND",
    ]);
    expect(httpEvents.at(-1)).toMatchObject({
      operation: "PROJECT_GET",
      projectId: PROJECT_ID,
    });
    expect(httpEvents[4]).toMatchObject({
      operation: "PROJECT_CREATE",
      sourceBytes: expect.any(Number),
    });
    for (const event of httpEvents) {
      expect(Object.keys(event).toSorted()).toEqual(
        expect.arrayContaining([
          "correlationId",
          "event",
          "latencyMs",
          "logVersion",
          "method",
          "operation",
          "statusCode",
          "timestamp",
        ]),
      );
      expect(event.latencyMs).toBeGreaterThanOrEqual(0);
      expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    }
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("native storage stack");
    expect(serialized).not.toContain("/missing?source=");
    expect(serialized).not.toContain("headers");
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("message");
    expect(serialized).not.toContain("stack");
  });

  it("keeps log sink failures best-effort and produces strict JSON lines", async () => {
    const failingServer = trackedServer([], {
      write: async () => {
        throw new Error(SENTINEL);
      },
    });
    await expect(
      failingServer.inject({ method: "GET", url: "/health/live" }),
    ).resolves.toMatchObject({
      statusCode: 200,
    });

    const lines: string[] = [];
    const sink = createJsonLineOperationalLogSink((line) => lines.push(line));
    const jsonServer = trackedServer([], sink);
    await jsonServer.inject({ method: "GET", url: "/health/live" });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
      logVersion: 1,
      event: "HTTP_REQUEST_COMPLETED",
      operation: "HEALTH_LIVE",
      statusCode: 200,
    });
  });

  it("emits one redacted allowlist event per resource operation", async () => {
    const events: OperationalLogEvent[] = [];
    const executor = createResourceExecutor({
      workerUrl,
      operationalLogSink: collectingSink(events),
      limits: {
        ...DEFAULT_SERVER_RESOURCE_LIMITS,
        bundle: { ...DEFAULT_SERVER_RESOURCE_LIMITS.bundle },
        maxSourceBytes: 256,
      },
    });
    executors.add(executor);

    const source = `// ${SENTINEL}\nTable public.users { id bigint [pk] }`;
    await executor.parseDbml(source);
    await expect(executor.parseDbml(SENTINEL.repeat(20))).rejects.toMatchObject({
      code: "RESOURCE_SOURCE_TOO_LARGE",
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      logVersion: 1,
      event: "RESOURCE_OPERATION_COMPLETED",
      operation: "DBML_PARSE",
      status: "SUCCESS",
      timestamp: expect.any(String),
      inputBytes: expect.any(Number),
      tableCount: 1,
      referenceCount: 0,
      parserVersion: "9.1.1",
      diagnosticCount: expect.any(Number),
    });
    expect(events[1]).toMatchObject({
      event: "RESOURCE_OPERATION_COMPLETED",
      operation: "DBML_PARSE",
      status: "ERROR",
      errorCode: "RESOURCE_SOURCE_TOO_LARGE",
    });
    expect(JSON.stringify(events)).not.toContain(SENTINEL);

    const failingExecutor = createResourceExecutor({
      workerUrl,
      operationalLogSink: {
        write: () => {
          throw new Error(SENTINEL);
        },
      },
      limits: {
        ...DEFAULT_SERVER_RESOURCE_LIMITS,
        bundle: { ...DEFAULT_SERVER_RESOURCE_LIMITS.bundle },
        maxSourceBytes: 256,
      },
    });
    executors.add(failingExecutor);
    await expect(failingExecutor.parseDbml(source)).resolves.toMatchObject({ ok: true });
  }, 20_000);
});

function trackedServer(
  events: OperationalLogEvent[],
  sink: OperationalLogSink = collectingSink(events),
): ReturnType<typeof createServer> {
  const projectApplication = {
    listProjects: async () => {
      throw new Error(`native storage stack ${SENTINEL}`);
    },
    getProject: async (projectId: string) => ({
      ok: false as const,
      error: {
        code: "PROJECT_NOT_FOUND" as const,
        message: `Project not found ${SENTINEL}`,
        projectId,
      },
    }),
    createProject: async () => ({
      ok: false as const,
      error: {
        code: "PROJECT_NAME_INVALID" as const,
        message: "Project name is invalid.",
      },
    }),
  } as unknown as ProjectApplication;
  const server = createServer({
    projectApplication,
    layoutApplication: {} as LayoutApplication,
    sqlImportApplication: {} as SqlImportApplication,
    sqlExportApplication: {} as SqlExportApplication,
    visualCommandApplication: {} as VisualCommandApplication,
    generateCorrelationId: () => CORRELATION_ID,
    operationalLogSink: sink,
    resourceLimits: {
      ...DEFAULT_SERVER_RESOURCE_LIMITS,
      bundle: { ...DEFAULT_SERVER_RESOURCE_LIMITS.bundle },
      maxSourceBytes: 128,
      maxGeneratedOutputBytes: 512,
      maxRequestBodyBytes: 512,
    },
  });
  servers.add(server);
  return server;
}

function collectingSink(events: OperationalLogEvent[]): OperationalLogSink {
  return {
    write: (event) => {
      events.push(event);
    },
  };
}

function createProjectPayload(source: string): Record<string, unknown> {
  return {
    operation: "CREATE",
    commandId: COMMAND_ID,
    name: "Sensitive project",
    primaryDialect: "POSTGRESQL",
    source,
  };
}
