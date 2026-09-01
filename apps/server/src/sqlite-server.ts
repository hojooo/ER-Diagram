import {
  createLayoutApplication,
  createProjectApplication,
  createSqlExportApplication,
  createSqlImportApplication,
  createVisualCommandApplication,
} from "@er-diagram/core";
import {
  createSqliteLayoutRepository,
  createSqliteProjectRepository,
  createSqliteSqlImportRepository,
  createSqliteVisualCommandRepository,
  generateUuidV7,
  type SqliteStorage,
  toUtcIsoTimestamp,
} from "@er-diagram/storage-sqlite";
import type { FastifyInstance } from "fastify";

import { createServer } from "./app.js";
import { createResourceExecutor, type ResourceExecutor } from "./resource-executor.js";
import {
  DEFAULT_SERVER_RESOURCE_LIMITS,
  parseServerResourceLimits,
  type ServerResourceLimits,
} from "./resource-limits.js";

export interface CreateSqliteServerOptions {
  readonly storage: SqliteStorage;
  readonly resourceLimits?: ServerResourceLimits;
  readonly resourceExecutor?: ResourceExecutor;
  readonly generateCorrelationId?: () => string;
  readonly generateId?: () => string;
  readonly now?: () => string;
}

export function createSqliteServer(options: CreateSqliteServerOptions): FastifyInstance {
  const resourceLimits = parseServerResourceLimits(
    options.resourceLimits ?? options.resourceExecutor?.limits ?? DEFAULT_SERVER_RESOURCE_LIMITS,
  );
  if (
    options.resourceExecutor &&
    JSON.stringify(options.resourceExecutor.limits) !== JSON.stringify(resourceLimits)
  ) {
    throw new RangeError("The injected resource executor limits must match the server limits.");
  }
  const executor = options.resourceExecutor ?? createResourceExecutor({ limits: resourceLimits });
  const generateId = options.generateId ?? generateUuidV7;
  const now = options.now ?? (() => toUtcIsoTimestamp());
  const projectPersistence = createSqliteProjectRepository(options.storage);

  const server = createServer({
    projectApplication: createProjectApplication({
      persistence: projectPersistence,
      generateId,
      now,
      parseSource: (source, filepath) => executor.parseDbml(source, filepath),
    }),
    layoutApplication: createLayoutApplication({
      persistence: createSqliteLayoutRepository(options.storage),
    }),
    sqlImportApplication: createSqlImportApplication({
      persistence: createSqliteSqlImportRepository(options.storage),
      generateId,
      now,
      convert: (input) => executor.convertSqlImport(input),
    }),
    sqlExportApplication: createSqlExportApplication({
      persistence: projectPersistence,
      convert: (input) => executor.convertSqlExport(input),
    }),
    visualCommandApplication: createVisualCommandApplication({
      persistence: createSqliteVisualCommandRepository(options.storage),
      transform: (source, command, filepath) =>
        executor.transformVisualCommand(source, command, filepath),
      generateId,
      now,
    }),
    ...(options.generateCorrelationId
      ? { generateCorrelationId: options.generateCorrelationId }
      : {}),
    resourceLimits,
  });

  server.addHook("onClose", async () => executor.close());
  return server;
}
