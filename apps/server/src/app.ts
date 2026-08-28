import { randomUUID } from "node:crypto";
import { correlationIdSchema } from "@er-diagram/contracts";
import type { LayoutApplication, ProjectApplication, SqlImportApplication } from "@er-diagram/core";
import Fastify, { type FastifyInstance } from "fastify";

import { registerHttpErrorHandlers } from "./http-errors.js";
import { registerLayoutRoutes } from "./layout-routes.js";
import { registerProjectRoutes } from "./project-routes.js";
import { registerSqlImportRoutes } from "./sql-import-routes.js";

export interface CreateServerOptions {
  readonly projectApplication: ProjectApplication;
  readonly layoutApplication: LayoutApplication;
  readonly sqlImportApplication: SqlImportApplication;
  readonly generateCorrelationId?: () => string;
}

export function createServer(options: CreateServerOptions): FastifyInstance {
  const generateCorrelationId = options.generateCorrelationId ?? randomUUID;
  const server = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: () => correlationIdSchema.parse(generateCorrelationId()),
  });

  server.addHook("onRequest", async (request, reply) => {
    reply.header("x-correlation-id", request.id);
  });

  registerHttpErrorHandlers(server);

  server.get("/health/live", async () => ({ status: "ok" }));
  registerProjectRoutes(server, options.projectApplication);
  registerLayoutRoutes(server, options.layoutApplication);
  registerSqlImportRoutes(server, options.sqlImportApplication);

  return server;
}
