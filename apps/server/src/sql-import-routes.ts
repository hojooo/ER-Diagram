import {
  projectParamsSchema,
  sqlImportApplyRequestSchema,
  sqlImportApplyResponseSchema,
  sqlImportPreviewRequestSchema,
  sqlImportPreviewResponseSchema,
  sqlImportStandalonePreviewRequestSchema,
  sqlImportStandalonePreviewResponseSchema,
} from "@er-diagram/contracts";
import type { SqlImportApplication } from "@er-diagram/core";
import type { FastifyInstance, FastifyReply } from "fastify";

import { parseRequest, parseResponse, sendSqlImportApplicationError } from "./http-errors.js";
import { assertSourceWithinLimit } from "./request-resource-limits.js";
import type { ServerResourceLimits } from "./resource-limits.js";

export function registerSqlImportRoutes(
  server: FastifyInstance,
  application: SqlImportApplication,
  resourceLimits: ServerResourceLimits,
): void {
  server.post("/api/v1/sql-import/preview", async (request, reply) => {
    const command = parseRequest(sqlImportStandalonePreviewRequestSchema, request.body);
    echoCommandId(reply, command.commandId);
    assertSourceWithinLimit(command.source, resourceLimits);
    const result = await application.previewStandalone({
      dialect: command.dialect,
      source: command.source,
      ...(command.originalSqlRetention === undefined
        ? {}
        : { originalSqlRetention: command.originalSqlRetention }),
    });
    if (!result.ok) return sendSqlImportApplicationError(request, reply, result.error);
    return reply.send(parseResponse(sqlImportStandalonePreviewResponseSchema, result.value));
  });

  server.post("/api/v1/projects/:projectId/sql-import/preview", async (request, reply) => {
    const { projectId } = parseRequest(projectParamsSchema, request.params);
    const command = parseRequest(sqlImportPreviewRequestSchema, request.body);
    echoCommandId(reply, command.commandId);
    assertSourceWithinLimit(command.source, resourceLimits);
    const result = await application.preview({
      projectId,
      expectedSchemaRevisionNo: command.expectedSchemaRevisionNo,
      dialect: command.dialect,
      source: command.source,
      ...(command.originalSqlRetention === undefined
        ? {}
        : { originalSqlRetention: command.originalSqlRetention }),
    });
    if (!result.ok) return sendSqlImportApplicationError(request, reply, result.error);
    return reply.send(parseResponse(sqlImportPreviewResponseSchema, result.value));
  });

  server.post("/api/v1/projects/:projectId/sql-import/apply", async (request, reply) => {
    const { projectId } = parseRequest(projectParamsSchema, request.params);
    const command = parseRequest(sqlImportApplyRequestSchema, request.body);
    echoCommandId(reply, command.commandId);
    assertSourceWithinLimit(command.source, resourceLimits);
    const result = await application.apply({
      projectId,
      expectedSchemaRevisionNo: command.expectedSchemaRevisionNo,
      artifactId: command.artifactId,
      previewHash: command.previewHash,
      source: command.source,
      ...(command.dataStatementHandling === undefined
        ? {}
        : { dataStatementHandling: command.dataStatementHandling }),
    });
    if (!result.ok) return sendSqlImportApplicationError(request, reply, result.error);
    return reply.send(parseResponse(sqlImportApplyResponseSchema, result.value));
  });
}

function echoCommandId(reply: FastifyReply, commandId: string): void {
  reply.header("x-command-id", commandId);
}
