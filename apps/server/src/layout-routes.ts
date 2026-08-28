import {
  layoutMutationResponseSchema,
  layoutParamsSchema,
  layoutResponseSchema,
  saveLayoutRequestSchema,
} from "@er-diagram/contracts";
import type { LayoutApplication } from "@er-diagram/core";
import type { FastifyInstance, FastifyReply } from "fastify";

import { parseRequest, parseResponse, sendLayoutApplicationError } from "./http-errors.js";

export function registerLayoutRoutes(
  server: FastifyInstance,
  application: LayoutApplication,
): void {
  server.get("/api/v1/projects/:projectId/layouts/:viewKey", async (request, reply) => {
    const { projectId, viewKey } = parseRequest(layoutParamsSchema, request.params);
    const result = await application.getLayout(projectId, viewKey);
    if (!result.ok) return sendLayoutApplicationError(request, reply, result.error);
    return reply.send(parseResponse(layoutResponseSchema, result.value));
  });

  server.put("/api/v1/projects/:projectId/layouts/:viewKey", async (request, reply) => {
    const { projectId, viewKey } = parseRequest(layoutParamsSchema, request.params);
    const command = parseRequest(saveLayoutRequestSchema, request.body);
    echoCommandId(reply, command.commandId);
    const result = await application.saveLayout({
      projectId,
      viewKey,
      expectedLayoutRevisionNo: command.expectedLayoutRevisionNo,
      layout: command.layout,
    });
    if (!result.ok) return sendLayoutApplicationError(request, reply, result.error);
    return reply.send(parseResponse(layoutMutationResponseSchema, result.value));
  });
}

function echoCommandId(reply: FastifyReply, commandId: string): void {
  reply.header("x-command-id", commandId);
}
