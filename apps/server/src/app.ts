import { randomUUID } from "node:crypto";
import {
  correlationIdSchema,
  healthLiveResponseSchema,
  healthReadyResponseSchema,
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

import { parseResponse, registerHttpErrorHandlers, sendServerNotReady } from "./http-errors.js";
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
  readonly readinessProbe?: () => boolean | Promise<boolean>;
  readonly trustedProxyCidrs?: readonly string[];
  readonly hstsMaxAgeSeconds?: number;
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
    trustProxy:
      options.trustedProxyCidrs && options.trustedProxyCidrs.length > 0
        ? [...options.trustedProxyCidrs]
        : false,
  });

  registerSecurityHeaders(server, { hstsMaxAgeSeconds: options.hstsMaxAgeSeconds ?? 0 });
  registerOperationalLogging(server, options.operationalLogSink ?? NOOP_OPERATIONAL_LOG_SINK);

  server.addHook("onRequest", async (request, reply) => {
    reply.header("x-correlation-id", request.id);
  });

  if (options.staticWeb) registerStaticWeb(server, options.staticWeb);
  registerHttpErrorHandlers(server, options.staticWeb);

  server.get("/health/live", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return parseResponse(healthLiveResponseSchema, { status: "ok" });
  });
  server.get("/health/ready", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      if (await (options.readinessProbe?.() ?? true)) {
        return parseResponse(healthReadyResponseSchema, { status: "ready" });
      }
    } catch {
      // A failed readiness probe is intentionally reduced to a stable public status.
    }
    return sendServerNotReady(request, reply);
  });
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
