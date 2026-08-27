import { type ErrorResponse, errorResponseSchema } from "@er-diagram/contracts";
import type { ProjectApplicationError } from "@er-diagram/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

interface ContractParseSuccess<T> {
  readonly success: true;
  readonly data: T;
}

interface ContractParseFailure {
  readonly success: false;
}

export interface ContractSchema<T> {
  safeParse(value: unknown): ContractParseSuccess<T> | ContractParseFailure;
}

class HttpRequestValidationError extends Error {
  constructor() {
    super("The request did not match the required contract.");
    this.name = "HttpRequestValidationError";
  }
}

export function parseRequest<T>(schema: ContractSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpRequestValidationError();
  return parsed.data;
}

export function parseResponse<T>(schema: ContractSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("The server produced an invalid response contract.");
  return parsed.data;
}

export function sendProjectApplicationError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: ProjectApplicationError,
): FastifyReply {
  switch (error.code) {
    case "PROJECT_NOT_FOUND":
    case "PROJECT_REVISION_NOT_FOUND":
      return sendError(request, reply, 404, error.code, error.message);
    case "PROJECT_SCHEMA_REVISION_CONFLICT":
      return sendError(request, reply, 409, error.code, error.message, {
        currentRevisionNo: error.currentSchemaRevisionNo,
      });
    case "PROJECT_NAME_INVALID":
      return sendError(request, reply, 422, error.code, error.message);
    case "PROJECT_STORAGE_INVARIANT_VIOLATION":
      return sendError(
        request,
        reply,
        500,
        error.code,
        "Stored project data failed an integrity check.",
      );
  }
  return assertNever(error);
}

export function registerHttpErrorHandlers(server: FastifyInstance): void {
  server.setNotFoundHandler((request, reply) =>
    sendError(request, reply, 404, "ROUTE_NOT_FOUND", "The requested route was not found."),
  );

  server.setErrorHandler((error, request, reply) => {
    if (isBodyTooLarge(error)) {
      return sendError(
        request,
        reply,
        413,
        "REQUEST_BODY_TOO_LARGE",
        "The request body exceeds the configured limit.",
      );
    }
    if (error instanceof HttpRequestValidationError || isFastifyBadRequest(error)) {
      return sendError(
        request,
        reply,
        400,
        "REQUEST_VALIDATION_FAILED",
        "The request did not match the required contract.",
      );
    }
    return sendError(
      request,
      reply,
      500,
      "INTERNAL_SERVER_ERROR",
      "An unexpected server error occurred.",
    );
  });
}

interface ErrorResponseOptions {
  readonly currentRevisionNo?: number;
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  options: ErrorResponseOptions = {},
): FastifyReply {
  const base: ErrorResponse = {
    code,
    message,
    correlationId: request.id,
  };
  const response =
    options.currentRevisionNo === undefined
      ? base
      : { ...base, currentRevisionNo: options.currentRevisionNo };
  return reply.code(statusCode).send(errorResponseSchema.parse(response));
}

function isBodyTooLarge(error: unknown): boolean {
  return (
    readErrorProperty(error, "code") === "FST_ERR_CTP_BODY_TOO_LARGE" ||
    readErrorProperty(error, "statusCode") === 413
  );
}

function isFastifyBadRequest(error: unknown): boolean {
  return readErrorProperty(error, "statusCode") === 400;
}

function readErrorProperty(error: unknown, property: string): unknown {
  if (typeof error !== "object" || error === null || !(property in error)) return undefined;
  return (error as Record<string, unknown>)[property];
}

function assertNever(value: never): never {
  throw new Error(`Unhandled project application error: ${String(value)}`);
}
