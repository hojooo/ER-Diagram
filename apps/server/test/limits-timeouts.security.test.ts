import {
  DEFAULT_RUNTIME_RESOURCE_LIMITS,
  utf8ByteLength,
  type VisualCommand,
} from "@er-diagram/contracts";
import { qualifiedElementKey } from "@er-diagram/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  createResourceExecutor,
  DEFAULT_SERVER_RESOURCE_LIMITS,
  ResourceOperationError,
  type ServerResourceLimits,
} from "../src/index.js";

const workerUrl = new URL("../dist/resource-worker.js", import.meta.url);
const executors = new Set<ReturnType<typeof createResourceExecutor>>();

afterEach(async () => {
  await Promise.all([...executors].map((executor) => executor.close()));
  executors.clear();
});

function limits(overrides: Partial<ServerResourceLimits> = {}): ServerResourceLimits {
  return {
    ...DEFAULT_SERVER_RESOURCE_LIMITS,
    bundle: { ...DEFAULT_RUNTIME_RESOURCE_LIMITS.bundle },
    ...overrides,
  };
}

function executor(overrides: Partial<ServerResourceLimits> = {}, allowTestOperations = false) {
  const value = createResourceExecutor({
    workerUrl,
    limits: limits(overrides),
    allowTestOperations,
  });
  executors.add(value);
  return value;
}

describe("bounded schema resource workers", () => {
  it("runs DBML, SQL import/export, and visual transforms in the built worker", async () => {
    const worker = executor();
    const source = "Table public.users {\n  id bigint [pk]\n}\n";
    const parsed = await worker.parseDbml(source);
    const imported = await worker.convertSqlImport({
      dialect: "POSTGRESQL",
      source: "CREATE TABLE users (id bigint PRIMARY KEY);",
    });
    const exported = await worker.convertSqlExport({
      primaryDialect: "POSTGRESQL",
      targetDialect: "POSTGRESQL",
      source,
    });
    const command: VisualCommand = {
      kind: "CREATE_COLUMN",
      commandId: "550e8400-e29b-41d4-a716-446655440000",
      expectedSchemaRevisionNo: 1,
      targetTableKey: qualifiedElementKey("table", "public", "users"),
      column: {
        name: "email",
        type: "varchar",
        primaryKey: false,
        unique: false,
        notNull: false,
        default: null,
        increment: false,
        note: null,
      },
    };
    const transformed = await worker.transformVisualCommand(source, command);

    expect(parsed.ok && parsed.graph.tables).toHaveLength(1);
    expect(imported.ok).toBe(true);
    expect(exported.ok).toBe(true);
    expect(transformed).toMatchObject({ ok: true, changed: true });
  }, 20_000);

  it("enforces source, graph, and generated-output boundaries inside the worker", async () => {
    const exactSource = "Table t { id int }";
    const sourceBounded = executor({ maxSourceBytes: utf8ByteLength(exactSource) });
    await expect(sourceBounded.parseDbml(exactSource)).resolves.toMatchObject({ ok: true });
    await expect(sourceBounded.parseDbml(`${exactSource} `)).rejects.toMatchObject({
      code: "RESOURCE_SOURCE_TOO_LARGE",
    });

    const graphBounded = executor({ maxTables: 1 });
    await expect(
      graphBounded.parseDbml("Table one { id int }\nTable two { id int }"),
    ).rejects.toMatchObject({ code: "RESOURCE_COMPLEXITY_LIMIT_EXCEEDED" });

    const outputBounded = executor({ maxGeneratedOutputBytes: 128, maxSourceBytes: 64 });
    await expect(outputBounded.parseDbml("Table t { id int }")).rejects.toMatchObject({
      code: "RESOURCE_OUTPUT_TOO_LARGE",
    });
  }, 20_000);

  it("terminates timed-out and crashed workers and serves the next operation", async () => {
    const worker = executor({ dbmlParserTimeoutMs: 5_000 }, true);
    await expect(worker.parseDbml("Table warmup { id int }")).resolves.toMatchObject({ ok: true });

    await expect(worker.executeTestOperation("TEST_HANG")).rejects.toMatchObject({
      code: "RESOURCE_WORKER_TIMEOUT",
    });
    await expect(worker.parseDbml("Table after_timeout { id int }")).resolves.toMatchObject({
      ok: true,
    });

    await expect(worker.executeTestOperation("TEST_CRASH")).rejects.toMatchObject({
      code: "RESOURCE_WORKER_CRASHED",
    });
    await expect(worker.parseDbml("Table after_crash { id int }")).resolves.toMatchObject({
      ok: true,
    });

    await expect(worker.executeTestOperation("TEST_PROTOCOL")).rejects.toMatchObject({
      code: "RESOURCE_WORKER_CRASHED",
    });
    await expect(worker.parseDbml("Table after_protocol { id int }")).resolves.toMatchObject({
      ok: true,
    });
  }, 30_000);

  it("contains a worker heap exhaustion and replaces only that worker", async () => {
    const worker = executor(
      {
        dbmlParserTimeoutMs: 10_000,
        workerPoolSize: 1,
      },
      true,
    );

    await expect(worker.executeTestOperation("TEST_OOM")).rejects.toMatchObject({
      code: "RESOURCE_WORKER_CRASHED",
    });
    await expect(worker.parseDbml("Table after_oom { id int }")).resolves.toMatchObject({
      ok: true,
    });
  }, 20_000);

  it("rejects a full queue and expires queued work without blocking the caller", async () => {
    const worker = executor(
      {
        workerPoolSize: 1,
        maxWorkerQueue: 1,
        workerQueueTimeoutMs: 50,
        dbmlParserTimeoutMs: 2_000,
      },
      true,
    );
    await expect(worker.parseDbml("Table warmup { id int }")).resolves.toMatchObject({ ok: true });

    const active = worker.executeTestOperation("TEST_HANG").catch((error: unknown) => error);
    const queued = worker.parseDbml("Table queued { id int }");
    await expect(worker.parseDbml("Table overflow { id int }")).rejects.toMatchObject({
      code: "RESOURCE_WORKER_BUSY",
    });
    await expect(queued).rejects.toMatchObject({ code: "RESOURCE_WORKER_BUSY" });
    await worker.close();
    expect(await active).toBeInstanceOf(ResourceOperationError);
  }, 20_000);
});
