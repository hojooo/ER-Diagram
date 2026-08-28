import {
  createProjectRequestSchema,
  deleteProjectRequestSchema,
  projectMutationResponseSchema,
  projectParamsSchema,
  projectResponseSchema,
  projectRevisionsResponseSchema,
  projectsResponseSchema,
  renameProjectRequestSchema,
  restoreRevisionRequestSchema,
  revisionParamsSchema,
  type SchemaRevisionSummary,
  saveDraftRequestSchema,
  sqlImportApplyResponseSchema,
} from "@er-diagram/contracts";
import type { ProjectApplication, SchemaRevision, SqlImportApplication } from "@er-diagram/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  parseRequest,
  parseResponse,
  sendProjectApplicationError,
  sendSqlImportApplicationError,
} from "./http-errors.js";

export function registerProjectRoutes(
  server: FastifyInstance,
  application: ProjectApplication,
  sqlImportApplication: SqlImportApplication,
): void {
  server.get("/api/v1/projects", async (request, reply) => {
    const result = await application.listProjects();
    if (!result.ok) return sendProjectApplicationError(request, reply, result.error);
    return reply.send(parseResponse(projectsResponseSchema, { projects: result.value }));
  });

  server.post("/api/v1/projects", async (request, reply) => {
    const command = parseRequest(createProjectRequestSchema, request.body);
    echoCommandId(reply, command.commandId);
    if (command.operation === "CREATE_FROM_SQL_IMPORT") {
      const result = await sqlImportApplication.createProjectFromPreview({
        name: command.name,
        primaryDialect: command.primaryDialect,
        source: command.source,
        previewHash: command.previewHash,
        ...(command.originalSqlRetention === undefined
          ? {}
          : { originalSqlRetention: command.originalSqlRetention }),
        ...(command.dataStatementHandling === undefined
          ? {}
          : { dataStatementHandling: command.dataStatementHandling }),
      });
      if (!result.ok) return sendSqlImportApplicationError(request, reply, result.error);
      return reply.code(201).send(parseResponse(sqlImportApplyResponseSchema, result.value));
    }
    const result =
      command.operation === "CREATE"
        ? await application.createProject({
            name: command.name,
            primaryDialect: command.primaryDialect,
            source: command.source,
          })
        : await application.duplicateProject({
            sourceProjectId: command.sourceProjectId,
            name: command.name,
            expectedSchemaRevisionNo: command.expectedSchemaRevisionNo,
          });
    return sendMutation(request, reply, result, 201);
  });

  server.get("/api/v1/projects/:projectId", async (request, reply) => {
    const { projectId } = parseRequest(projectParamsSchema, request.params);
    const result = await application.getProject(projectId);
    if (!result.ok) return sendProjectApplicationError(request, reply, result.error);
    return reply.send(parseResponse(projectResponseSchema, { state: result.value }));
  });

  server.patch("/api/v1/projects/:projectId", async (request, reply) => {
    const { projectId } = parseRequest(projectParamsSchema, request.params);
    const command = parseRequest(renameProjectRequestSchema, request.body);
    echoCommandId(reply, command.commandId);
    const result = await application.renameProject({
      projectId,
      name: command.name,
      expectedSchemaRevisionNo: command.expectedSchemaRevisionNo,
    });
    if (!result.ok) return sendProjectApplicationError(request, reply, result.error);
    return reply.send(parseResponse(projectResponseSchema, { state: result.value }));
  });

  server.delete("/api/v1/projects/:projectId", async (request, reply) => {
    const { projectId } = parseRequest(projectParamsSchema, request.params);
    const command = parseRequest(deleteProjectRequestSchema, request.body);
    echoCommandId(reply, command.commandId);
    const result = await application.deleteProject({
      projectId,
      expectedSchemaRevisionNo: command.expectedSchemaRevisionNo,
    });
    if (!result.ok) return sendProjectApplicationError(request, reply, result.error);
    return reply.code(204).send();
  });

  server.put("/api/v1/projects/:projectId/draft", async (request, reply) => {
    const { projectId } = parseRequest(projectParamsSchema, request.params);
    const command = parseRequest(saveDraftRequestSchema, request.body);
    echoCommandId(reply, command.commandId);
    return sendMutation(
      request,
      reply,
      await application.saveDraft({
        projectId,
        source: command.source,
        expectedSchemaRevisionNo: command.expectedSchemaRevisionNo,
      }),
      200,
    );
  });

  server.get("/api/v1/projects/:projectId/revisions", async (request, reply) => {
    const { projectId } = parseRequest(projectParamsSchema, request.params);
    const result = await application.listRevisions(projectId);
    if (!result.ok) return sendProjectApplicationError(request, reply, result.error);
    return reply.send(
      parseResponse(projectRevisionsResponseSchema, {
        revisions: result.value.map(toRevisionSummary),
      }),
    );
  });

  server.post(
    "/api/v1/projects/:projectId/revisions/:revisionNo/restore",
    async (request, reply) => {
      const { projectId, revisionNo } = parseRequest(revisionParamsSchema, request.params);
      const command = parseRequest(restoreRevisionRequestSchema, request.body);
      echoCommandId(reply, command.commandId);
      return sendMutation(
        request,
        reply,
        await application.restoreRevision({
          projectId,
          revisionNo,
          expectedSchemaRevisionNo: command.expectedSchemaRevisionNo,
        }),
        200,
      );
    },
  );
}

function sendMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  result: Awaited<ReturnType<ProjectApplication["createProject"]>>,
  statusCode: 200 | 201,
): FastifyReply {
  if (!result.ok) return sendProjectApplicationError(request, reply, result.error);
  return reply.code(statusCode).send(parseResponse(projectMutationResponseSchema, result.value));
}

function echoCommandId(reply: FastifyReply, commandId: string): void {
  reply.header("x-command-id", commandId);
}

function toRevisionSummary(revision: SchemaRevision): SchemaRevisionSummary {
  return {
    id: revision.id,
    projectId: revision.projectId,
    revisionNo: revision.revisionNo,
    sourceHash: revision.sourceHash,
    validity: revision.validity,
    origin: revision.origin,
    parserVersion: revision.parserVersion,
    diagnosticSummary: { ...revision.diagnosticSummary },
    createdAt: revision.createdAt,
  };
}
