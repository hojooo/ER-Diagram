import {
  projectParamsSchema,
  visualCommandMutationResponseSchema,
  visualCommandRequestSchema,
} from "@er-diagram/contracts";
import type { VisualCommandApplication } from "@er-diagram/core";
import type { FastifyInstance, FastifyReply } from "fastify";

import { parseRequest, parseResponse, sendVisualCommandApplicationError } from "./http-errors.js";

export function registerVisualCommandRoutes(
  server: FastifyInstance,
  application: VisualCommandApplication,
): void {
  server.post("/api/v1/projects/:projectId/visual-commands", async (request, reply) => {
    const { projectId } = parseRequest(projectParamsSchema, request.params);
    const command = parseRequest(visualCommandRequestSchema, request.body);
    echoCommandId(reply, command.commandId);
    const result = await application.apply({ projectId, command });
    if (!result.ok) return sendVisualCommandApplicationError(request, reply, result.error);
    return reply.send(parseResponse(visualCommandMutationResponseSchema, result.value));
  });
}

function echoCommandId(reply: FastifyReply, commandId: string): void {
  reply.header("x-command-id", commandId);
}
