import {
  type DbmlParserWorkerResponse,
  dbmlParserWorkerRequestSchema,
  dbmlParserWorkerResponseSchema,
} from "@er-diagram/contracts";
import { DBML_PARSER_VERSION, parseDbmlV2 } from "@er-diagram/core";

import { hashDbmlSource } from "./source-hash.js";

export class DbmlParserWorkerRequestError extends Error {
  constructor(
    readonly code: "PARSER_WORKER_REQUEST_HASH_MISMATCH" | "PARSER_WORKER_REQUEST_INVALID",
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
  const actualSourceHash = await hashDbmlSource(request.source);
  if (actualSourceHash !== request.sourceHash) {
    throw new DbmlParserWorkerRequestError(
      "PARSER_WORKER_REQUEST_HASH_MISMATCH",
      "The DBML parser worker request hash did not match its source.",
    );
  }

  const result = await parseDbmlV2(request.source, request.filepath);
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
