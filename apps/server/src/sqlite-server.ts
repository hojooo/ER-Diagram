import {
  createLayoutApplication,
  createProjectApplication,
  createProjectBundleApplication,
  createSqlExportApplication,
  createSqlImportApplication,
  createVisualCommandApplication,
} from "@er-diagram/core";
import {
  createSqliteLayoutRepository,
  createSqliteProjectBundleRepository,
  createSqliteProjectRepository,
  createSqliteSqlImportRepository,
  createSqliteVisualCommandRepository,
  generateUuidV7,
  type SqliteStorage,
  toUtcIsoTimestamp,
} from "@er-diagram/storage-sqlite";
import type { RuntimeReleaseIdentity } from "@er-diagram/contracts";
import type { FastifyInstance } from "fastify";

import { createServer } from "./app.js";
import {
  createJsonLineOperationalLogSink,
  type OperationalLogSink,
} from "./operational-logging.js";
import { createResourceExecutor, type ResourceExecutor } from "./resource-executor.js";
import {
  DEFAULT_SERVER_RESOURCE_LIMITS,
  parseServerResourceLimits,
  type ServerResourceLimits,
} from "./resource-limits.js";
import type { StaticWebOptions } from "./static-web.js";

export interface CreateSqliteServerOptions {
  readonly storage: SqliteStorage;
  readonly resourceLimits?: ServerResourceLimits;
  readonly resourceExecutor?: ResourceExecutor;
  readonly generateCorrelationId?: () => string;
  readonly generateId?: () => string;
  readonly now?: () => string;
  readonly operationalLogSink?: OperationalLogSink;
  readonly staticWeb?: StaticWebOptions;
  readonly readinessProbe?: () => boolean | Promise<boolean>;
  readonly trustedProxyCidrs?: readonly string[];
  readonly hstsMaxAgeSeconds?: number;
  readonly closeOwnedResources?: () => void | Promise<void>;
  readonly releaseIdentity?: RuntimeReleaseIdentity;
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
  const operationalLogSink = options.operationalLogSink ?? createJsonLineOperationalLogSink();
  const executor =
    options.resourceExecutor ??
    createResourceExecutor({ limits: resourceLimits, operationalLogSink });
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
    projectBundleApplication: createProjectBundleApplication({
      persistence: createSqliteProjectBundleRepository(options.storage),
      parseSource: (source, filepath) => executor.parseDbml(source, filepath),
      resourceLimits,
      generateId,
      now,
    }),
    ...(options.generateCorrelationId
      ? { generateCorrelationId: options.generateCorrelationId }
      : {}),
    operationalLogSink,
    resourceLimits,
    ...(options.releaseIdentity ? { releaseIdentity: options.releaseIdentity } : {}),
    ...(options.staticWeb ? { staticWeb: options.staticWeb } : {}),
    ...(options.readinessProbe ? { readinessProbe: options.readinessProbe } : {}),
    ...(options.trustedProxyCidrs ? { trustedProxyCidrs: options.trustedProxyCidrs } : {}),
    ...(options.hstsMaxAgeSeconds === undefined
      ? {}
      : { hstsMaxAgeSeconds: options.hstsMaxAgeSeconds }),
  });

  server.addHook("onClose", async () => {
    try {
      await executor.close();
    } finally {
      await options.closeOwnedResources?.();
    }
  });
  return server;
}
