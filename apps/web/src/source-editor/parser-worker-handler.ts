import {
  type DbmlParserWorkerResponse,
  dbmlParserWorkerRequestSchema,
  dbmlParserWorkerResponseSchema,
  utf8ByteLength,
} from "@er-diagram/contracts";
import { DBML_PARSER_VERSION, measureSchemaGraph, parseDbmlV2 } from "@er-diagram/core";

import { hashDbmlSource } from "./source-hash.js";

export class DbmlParserWorkerRequestError extends Error {
  constructor(
    readonly code:
      | "PARSER_WORKER_COMPLEXITY_LIMIT"
      | "PARSER_WORKER_REQUEST_HASH_MISMATCH"
      | "PARSER_WORKER_REQUEST_INVALID"
      | "PARSER_WORKER_SOURCE_LIMIT",
    message: string,
  ) {
    super(message);
    this.name = "DbmlParserWorkerRequestError";
  }
}

export async function handleDbmlParserWorkerRequest(
  input: unknown,
): Promise<DbmlParserWorkerResponse> {
  const parsed = dbmlParserWorkerRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new DbmlParserWorkerRequestError(
      "PARSER_WORKER_REQUEST_INVALID",
      "The DBML parser worker request was invalid.",
    );
  }

  const request = parsed.data;
  if (utf8ByteLength(request.source) > request.limits.maxSourceBytes) {
    throw new DbmlParserWorkerRequestError(
      "PARSER_WORKER_SOURCE_LIMIT",
      "The DBML source exceeded the configured worker limit.",
    );
  }
  const actualSourceHash = await hashDbmlSource(request.source);
  if (actualSourceHash !== request.sourceHash) {
    throw new DbmlParserWorkerRequestError(
      "PARSER_WORKER_REQUEST_HASH_MISMATCH",
      "The DBML parser worker request hash did not match its source.",
    );
  }

  const result = await parseDbmlV2(request.source, request.filepath);
  if (result.ok) {
    const metrics = measureSchemaGraph(result.graph);
    if (
      metrics.tables > request.limits.maxTables ||
      metrics.references > request.limits.maxReferences ||
      metrics.totalElements > request.limits.maxSchemaElements
    ) {
      throw new DbmlParserWorkerRequestError(
        "PARSER_WORKER_COMPLEXITY_LIMIT",
        "The parsed schema exceeded the configured worker limit.",
      );
    }
  }
  const response = result.ok
    ? {
        type: "DBML_PARSE_RESULT" as const,
        requestId: request.requestId,
        ok: true as const,
        sourceHash: result.sourceHash,
        parserInputHash: result.parserInputHash,
        parserVersion: DBML_PARSER_VERSION,
        diagnostics: result.graph.diagnostics,
        graph: result.graph,
      }
    : {
        type: "DBML_PARSE_RESULT" as const,
        requestId: request.requestId,
        ok: false as const,
        sourceHash: result.sourceHash,
        parserInputHash: result.parserInputHash,
        parserVersion: DBML_PARSER_VERSION,
        diagnostics: result.diagnostics,
      };

  return dbmlParserWorkerResponseSchema.parse(response);
}
