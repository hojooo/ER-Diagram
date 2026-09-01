import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  errorResponseSchema,
  projectMutationResponseSchema,
  projectsResponseSchema,
  runtimeConfigResponseSchema,
} from "@er-diagram/contracts";
import { openSqliteStorage, type SqliteStorage } from "@er-diagram/storage-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  createResourceExecutor,
  createSqliteServer,
  DEFAULT_SERVER_RESOURCE_LIMITS,
  type ServerResourceLimits,
} from "../src/index.js";

const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174401";

interface Runtime {
  readonly directory: string;
  readonly storage: SqliteStorage;
  readonly server: ReturnType<typeof createSqliteServer>;
}

const runtimes = new Set<Runtime>();

function limits(overrides: Partial<ServerResourceLimits> = {}): ServerResourceLimits {
  return {
    ...DEFAULT_SERVER_RESOURCE_LIMITS,
    bundle: { ...DEFAULT_SERVER_RESOURCE_LIMITS.bundle },
    ...overrides,
  };
}

function openRuntime(resourceLimits: ServerResourceLimits): Runtime {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-limits-"));
  const storage = openSqliteStorage({ filename: path.join(directory, "database.sqlite") });
  const resourceExecutor = createResourceExecutor({
    limits: resourceLimits,
    workerUrl: new URL("../dist/resource-worker.js", import.meta.url),
  });
  const server = createSqliteServer({
    storage,
    resourceLimits,
    resourceExecutor,
    generateCorrelationId: () => CORRELATION_ID,
  });
  const runtime = { directory, storage, server };
  runtimes.add(runtime);
  return runtime;
}

async function closeRuntime(runtime: Runtime): Promise<void> {
  if (!runtimes.delete(runtime)) return;
  await runtime.server.close();
  runtime.storage.close();
  rmSync(runtime.directory, { force: true, recursive: true });
}

afterEach(async () => {
  await Promise.all([...runtimes].map(closeRuntime));
});

describe("runtime resource limit integration", () => {
  it("publishes strict no-store runtime config without server-only worker settings", async () => {
    const runtime = openRuntime(limits({ maxSourceBytes: 64, maxRequestBodyBytes: 512 }));

    const response = await runtime.server.inject({ method: "GET", url: "/api/v1/runtime-config" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const config = runtimeConfigResponseSchema.parse(response.json());
    expect(config.resourceLimits.maxSourceBytes).toBe(64);
    expect(config.resourceLimits).not.toHaveProperty("workerPoolSize");
  });

  it("distinguishes decoded source, raw body, and graph complexity failures without writes", async () => {
    const runtime = openRuntime(
      limits({
        maxSourceBytes: 64,
        maxRequestBodyBytes: 512,
        maxTables: 1,
      }),
    );

    const sourceResponse = await createProject(runtime, "x".repeat(65), "Oversized source", 1);
    expectPublicError(sourceResponse, 413, "RESOURCE_SOURCE_TOO_LARGE");

    const rawBodyResponse = await createProject(runtime, "", "n".repeat(600), 2);
    expectPublicError(rawBodyResponse, 413, "REQUEST_BODY_TOO_LARGE");

    const complexResponse = await createProject(
      runtime,
      "Table a { id int }\nTable b { id int }",
      "Too many tables",
      3,
    );
    expectPublicError(complexResponse, 422, "RESOURCE_COMPLEXITY_LIMIT_EXCEEDED");

    const projects = await runtime.server.inject({ method: "GET", url: "/api/v1/projects" });
    expect(projectsResponseSchema.parse(projects.json()).projects).toEqual([]);
    expect(`${sourceResponse.body}${complexResponse.body}`).not.toContain("Table b");
  });

  it("keeps liveness responsive under worker pressure and returns Retry-After", async () => {
    const resourceLimits = limits({
      workerPoolSize: 1,
      maxWorkerQueue: 1,
      workerQueueTimeoutMs: 50,
      dbmlParserTimeoutMs: 1_000,
    });
    const executor = createResourceExecutor({
      limits: resourceLimits,
      allowTestOperations: true,
      workerUrl: new URL("../dist/resource-worker.js", import.meta.url),
    });
    const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-limits-pressure-"));
    const storage = openSqliteStorage({ filename: path.join(directory, "database.sqlite") });
    const server = createSqliteServer({
      storage,
      resourceLimits,
      resourceExecutor: executor,
      generateCorrelationId: () => CORRELATION_ID,
    });
    const runtime = { directory, storage, server };
    runtimes.add(runtime);
    const hanging = executor.executeTestOperation("TEST_HANG").catch(() => undefined);

    const health = await server.inject({ method: "GET", url: "/health/live" });
    expect(health.statusCode).toBe(200);

    const queued = createProject(runtime, "Table queued { id int }", "Queued", 4);
    const busy = await createProject(runtime, "Table busy { id int }", "Busy", 5);
    expectPublicError(busy, 503, "RESOURCE_WORKER_BUSY");
    expect(busy.headers["retry-after"]).toBe("1");
    expectPublicError(await queued, 503, "RESOURCE_WORKER_BUSY");

    await closeRuntime(runtime);
    await hanging;
  });
});

async function createProject(runtime: Runtime, source: string, name: string, sequence: number) {
  return runtime.server.inject({
    method: "POST",
    url: "/api/v1/projects",
    payload: {
      operation: "CREATE",
      commandId: commandId(sequence),
      name,
      primaryDialect: "POSTGRESQL",
      source,
    },
  });
}

function expectPublicError(
  response: Awaited<ReturnType<Runtime["server"]["inject"]>>,
  status: number,
  code: string,
): void {
  expect(response.statusCode, response.body).toBe(status);
  const error = errorResponseSchema.parse(response.json());
  expect(error).toMatchObject({ code, correlationId: CORRELATION_ID });
  expect(error.message).not.toContain("worker_threads");
  expect(projectMutationResponseSchema.safeParse(response.json()).success).toBe(false);
}

function commandId(sequence: number): string {
  return `550e8400-e29b-41d4-a716-${sequence.toString(16).padStart(12, "0")}`;
}
