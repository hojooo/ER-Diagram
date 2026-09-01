import { randomUUID } from "node:crypto";
import {
  correlationIdSchema,
  RESOURCE_LIMITS_VERSION,
  runtimeConfigResponseSchema,
} from "@er-diagram/contracts";
import type {
  LayoutApplication,
  ProjectApplication,
  ProjectBundleApplication,
  SqlExportApplication,
  SqlImportApplication,
  VisualCommandApplication,
} from "@er-diagram/core";
import Fastify, { type FastifyInstance } from "fastify";

import { registerHttpErrorHandlers } from "./http-errors.js";
import { registerLayoutRoutes } from "./layout-routes.js";
import {
  NOOP_OPERATIONAL_LOG_SINK,
  type OperationalLogSink,
  registerOperationalLogging,
} from "./operational-logging.js";
import { registerProjectBundleRoutes } from "./project-bundle-routes.js";
import { registerProjectRoutes } from "./project-routes.js";
import {
  DEFAULT_SERVER_RESOURCE_LIMITS,
  parseServerResourceLimits,
  type ServerResourceLimits,
  toRuntimeResourceLimits,
} from "./resource-limits.js";
import { registerSecurityHeaders } from "./security-headers.js";
import { registerSqlExportRoutes } from "./sql-export-routes.js";
import { registerSqlImportRoutes } from "./sql-import-routes.js";
import { registerStaticWeb, type StaticWebOptions } from "./static-web.js";
import { registerVisualCommandRoutes } from "./visual-command-routes.js";

export interface CreateServerOptions {
  readonly projectApplication: ProjectApplication;
  readonly layoutApplication: LayoutApplication;
  readonly sqlImportApplication: SqlImportApplication;
  readonly sqlExportApplication: SqlExportApplication;
  readonly visualCommandApplication: VisualCommandApplication;
  readonly projectBundleApplication: ProjectBundleApplication;
  readonly generateCorrelationId?: () => string;
  readonly operationalLogSink?: OperationalLogSink;
  readonly resourceLimits?: ServerResourceLimits;
  readonly staticWeb?: StaticWebOptions;
}

export function createServer(options: CreateServerOptions): FastifyInstance {
  const generateCorrelationId = options.generateCorrelationId ?? randomUUID;
  const resourceLimits = parseServerResourceLimits(
    options.resourceLimits ?? DEFAULT_SERVER_RESOURCE_LIMITS,
  );
  const server = Fastify({
    bodyLimit: resourceLimits.maxRequestBodyBytes,
    logger: false,
    requestIdHeader: false,
    genReqId: () => correlationIdSchema.parse(generateCorrelationId()),
  });

  registerSecurityHeaders(server);
  registerOperationalLogging(server, options.operationalLogSink ?? NOOP_OPERATIONAL_LOG_SINK);

  server.addHook("onRequest", async (request, reply) => {
    reply.header("x-correlation-id", request.id);
  });

  if (options.staticWeb) registerStaticWeb(server, options.staticWeb);
  registerHttpErrorHandlers(server, options.staticWeb);

  server.get("/health/live", async () => ({ status: "ok" }));
  server.get("/api/v1/runtime-config", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return reply.send(
      runtimeConfigResponseSchema.parse({
        configVersion: RESOURCE_LIMITS_VERSION,
        resourceLimits: toRuntimeResourceLimits(resourceLimits),
      }),
    );
  });
  registerProjectRoutes(
    server,
    options.projectApplication,
    options.sqlImportApplication,
    resourceLimits,
  );
  registerLayoutRoutes(server, options.layoutApplication, resourceLimits);
  registerSqlImportRoutes(server, options.sqlImportApplication, resourceLimits);
  registerSqlExportRoutes(server, options.sqlExportApplication);
  registerVisualCommandRoutes(server, options.visualCommandApplication);
  registerProjectBundleRoutes(server, options.projectBundleApplication, resourceLimits);

  return server;
}
