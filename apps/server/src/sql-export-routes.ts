import {
  projectParamsSchema,
  sqlExportRequestSchema,
  sqlExportResponseSchema,
} from "@er-diagram/contracts";
import type { SqlExportApplication } from "@er-diagram/core";
import type { FastifyInstance } from "fastify";

import { parseRequest, parseResponse, sendSqlExportApplicationError } from "./http-errors.js";

export function registerSqlExportRoutes(
  server: FastifyInstance,
  application: SqlExportApplication,
): void {
  server.post("/api/v1/projects/:projectId/sql-export", async (request, reply) => {
    const { projectId } = parseRequest(projectParamsSchema, request.params);
    const command = parseRequest(sqlExportRequestSchema, request.body);
    const result = await application.exportProject({ projectId, ...command });
    if (!result.ok) return sendSqlExportApplicationError(request, reply, result.error);
    return reply.send(parseResponse(sqlExportResponseSchema, result.value));
  });
}
