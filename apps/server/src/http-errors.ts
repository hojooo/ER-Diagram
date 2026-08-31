import {
  type Diagnostic,
  type ErrorResponse,
  errorResponseSchema,
  type VisualCommandPartialImpact,
} from "@er-diagram/contracts";
import type {
  LayoutApplicationError,
  ProjectApplicationError,
  SqlExportApplicationError,
  SqlImportApplicationError,
  VisualCommandApplicationError,
  VisualCommandPartialImpact as CoreVisualCommandPartialImpact,
  VisualCommandTransformDiagnostic,
} from "@er-diagram/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ResourceOperationError } from "./resource-errors.js";

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

export function sendLayoutApplicationError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: LayoutApplicationError,
): FastifyReply {
  switch (error.code) {
    case "LAYOUT_PROJECT_NOT_FOUND":
      return sendError(request, reply, 404, error.code, error.message);
    case "LAYOUT_REVISION_CONFLICT":
      return sendError(request, reply, 409, error.code, error.message, {
        currentRevisionNo: error.currentLayoutRevisionNo,
      });
    case "LAYOUT_INPUT_INVALID":
      return sendError(request, reply, 422, error.code, error.message);
    case "LAYOUT_STORAGE_INVARIANT_VIOLATION":
      return sendError(
        request,
        reply,
        500,
        error.code,
        "Stored layout data failed an integrity check.",
      );
  }
  return assertNever(error);
}

export function sendSqlImportApplicationError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: SqlImportApplicationError,
): FastifyReply {
  switch (error.code) {
    case "SQL_IMPORT_PROJECT_NOT_FOUND":
    case "SQL_IMPORT_ARTIFACT_NOT_FOUND":
      return sendError(request, reply, 404, error.code, error.message);
    case "SQL_IMPORT_SCHEMA_REVISION_CONFLICT":
      return sendError(request, reply, 409, error.code, error.message, {
        currentRevisionNo: error.currentSchemaRevisionNo,
      });
    case "SQL_IMPORT_PREVIEW_MISMATCH":
    case "SQL_IMPORT_ARTIFACT_ALREADY_APPLIED":
    case "SQL_IMPORT_CREATE_PREVIEW_MISMATCH":
      return sendError(request, reply, 409, error.code, error.message);
    case "SQL_IMPORT_DIALECT_MISMATCH":
    case "SQL_IMPORT_CONVERSION_FAILED":
    case "SQL_IMPORT_NO_SCHEMA_ELEMENTS":
    case "SQL_IMPORT_DATA_CONFIRMATION_REQUIRED":
    case "SQL_IMPORT_PROJECT_NAME_INVALID":
    case "SQL_IMPORT_CREATE_CONVERSION_FAILED":
    case "SQL_IMPORT_CREATE_NO_SCHEMA_ELEMENTS":
    case "SQL_IMPORT_CREATE_DATA_CONFIRMATION_REQUIRED":
      return sendError(request, reply, 422, error.code, error.message);
    case "SQL_IMPORT_STORAGE_INVARIANT_VIOLATION":
      return sendError(
        request,
        reply,
        500,
        error.code,
        "Stored SQL import data failed an integrity check.",
      );
  }
  return assertNever(error);
}

export function sendSqlExportApplicationError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: SqlExportApplicationError,
): FastifyReply {
  switch (error.code) {
    case "SQL_EXPORT_PROJECT_NOT_FOUND":
      return sendError(request, reply, 404, error.code, error.message);
    case "SQL_EXPORT_SCHEMA_REVISION_CONFLICT":
      return sendError(request, reply, 409, error.code, error.message, {
        currentRevisionNo: error.currentSchemaRevisionNo,
      });
    case "SQL_EXPORT_CURRENT_DRAFT_INVALID":
    case "SQL_EXPORT_LAST_VALID_NOT_FOUND":
      return sendError(request, reply, 422, error.code, error.message);
    case "SQL_EXPORT_STORAGE_INVARIANT_VIOLATION":
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

export function sendVisualCommandApplicationError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: VisualCommandApplicationError,
): FastifyReply {
  switch (error.code) {
    case "VISUAL_COMMAND_PROJECT_NOT_FOUND":
      return sendError(request, reply, 404, error.code, error.message);
    case "VISUAL_COMMAND_SCHEMA_REVISION_CONFLICT":
      return sendError(request, reply, 409, error.code, error.message, {
        currentRevisionNo: error.currentSchemaRevisionNo,
      });
    case "VISUAL_COMMAND_IDEMPOTENCY_CONFLICT":
    case "VISUAL_COMMAND_LAYOUT_MIGRATION_CONFLICT":
      return sendError(request, reply, 409, error.code, error.message);
    case "VISUAL_COMMAND_INVALID":
    case "VISUAL_COMMAND_DRAFT_INVALID":
      return sendError(request, reply, 422, error.code, error.message);
    case "VISUAL_COMMAND_TRANSFORM_FAILED":
      return sendError(request, reply, 422, error.code, error.message, {
        diagnostics: error.diagnostics.map(toPublicVisualDiagnostic),
        ...(error.partialImpact
          ? { partialImpact: toPublicPartialImpact(error.partialImpact) }
          : {}),
      });
    case "VISUAL_COMMAND_STORAGE_INVARIANT_VIOLATION":
      return sendError(
        request,
        reply,
        500,
        error.code,
        "Stored visual command data failed an integrity check.",
      );
  }
  return assertNever(error);
}

export function registerHttpErrorHandlers(server: FastifyInstance): void {
  server.setNotFoundHandler((request, reply) =>
    sendError(request, reply, 404, "ROUTE_NOT_FOUND", "The requested route was not found."),
  );

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ResourceOperationError) {
      const statusCode =
        error.code === "RESOURCE_SOURCE_TOO_LARGE"
          ? 413
          : error.code === "RESOURCE_COMPLEXITY_LIMIT_EXCEEDED" ||
              error.code === "RESOURCE_OUTPUT_TOO_LARGE"
            ? 422
            : 503;
      if (error.code === "RESOURCE_WORKER_BUSY") reply.header("retry-after", "1");
      return sendError(request, reply, statusCode, error.code, error.message);
    }
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
  readonly diagnostics?: Diagnostic[];
  readonly partialImpact?: VisualCommandPartialImpact;
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
  const response: ErrorResponse = {
    ...base,
    ...(options.currentRevisionNo === undefined
      ? {}
      : { currentRevisionNo: options.currentRevisionNo }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    ...(options.partialImpact === undefined ? {} : { partialImpact: options.partialImpact }),
  };
  return reply.code(statusCode).send(errorResponseSchema.parse(response));
}

function toPublicVisualDiagnostic(diagnostic: VisualCommandTransformDiagnostic): Diagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    ...(diagnostic.range ? { range: { ...diagnostic.range, filepath: "/main.dbml" } } : {}),
  };
}

function toPublicPartialImpact(impact: CoreVisualCommandPartialImpact): VisualCommandPartialImpact {
  return {
    partialKey: impact.partialKey,
    partialName: impact.partialName,
    partialElementKey: impact.partialElementKey,
    definitionRange: { ...impact.definitionRange, filepath: "/main.dbml" },
    affectedTables: impact.affectedTables.map((affectedTable) => ({
      tableKey: affectedTable.tableKey,
      injectionRange: { ...affectedTable.injectionRange, filepath: "/main.dbml" },
    })),
  };
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
  throw new Error(`Unhandled application error: ${String(value)}`);
}
