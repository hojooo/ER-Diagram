import { randomUUID } from "node:crypto";
import { correlationIdSchema } from "@er-diagram/contracts";
import type {
  LayoutApplication,
  ProjectApplication,
  SqlExportApplication,
  SqlImportApplication,
  VisualCommandApplication,
} from "@er-diagram/core";
import Fastify, { type FastifyInstance } from "fastify";

import { registerHttpErrorHandlers } from "./http-errors.js";
import { registerLayoutRoutes } from "./layout-routes.js";
import { registerProjectRoutes } from "./project-routes.js";
import { registerSqlImportRoutes } from "./sql-import-routes.js";
import { registerSqlExportRoutes } from "./sql-export-routes.js";
import { registerVisualCommandRoutes } from "./visual-command-routes.js";

export interface CreateServerOptions {
  readonly projectApplication: ProjectApplication;
  readonly layoutApplication: LayoutApplication;
  readonly sqlImportApplication: SqlImportApplication;
  readonly sqlExportApplication: SqlExportApplication;
  readonly visualCommandApplication: VisualCommandApplication;
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
  registerProjectRoutes(server, options.projectApplication, options.sqlImportApplication);
  registerLayoutRoutes(server, options.layoutApplication);
  registerSqlImportRoutes(server, options.sqlImportApplication);
  registerSqlExportRoutes(server, options.sqlExportApplication);
  registerVisualCommandRoutes(server, options.visualCommandApplication);

  return server;
}
