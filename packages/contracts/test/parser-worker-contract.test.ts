import { describe, expect, it } from "vitest";

import { dbmlParserWorkerRequestSchema, dbmlParserWorkerResponseSchema } from "../src/index.js";

const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";
const SOURCE = "Table users { id int [pk] }";
const SOURCE_HASH = "a".repeat(64);
const PARSER_INPUT_HASH = "b".repeat(64);
const cloneStructured = (globalThis as unknown as { structuredClone<T>(value: T): T })
  .structuredClone;

const diagnostic = {
  code: "DBML_PARSE_SYNTAX_UNEXPECTED_TOKEN",
  message: "Unexpected token.",
  severity: "ERROR" as const,
  range: {
    filepath: "/main.dbml",
    startOffset: 6,
    endOffset: 11,
    startLine: 1,
    startColumn: 7,
    endLine: 1,
    endColumn: 12,
  },
};

describe("DBML parser worker transport contract", () => {
  it("accepts a strict parse request with an RFC UUID and lowercase SHA-256 hash", () => {
    const request = dbmlParserWorkerRequestSchema.parse({
      type: "PARSE_DBML",
      requestId: REQUEST_ID,
      filepath: "/main.dbml",
      source: SOURCE,
      sourceHash: SOURCE_HASH,
    });

    expect(request).toEqual({
      type: "PARSE_DBML",
      requestId: REQUEST_ID,
      filepath: "/main.dbml",
      source: SOURCE,
      sourceHash: SOURCE_HASH,
    });
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    expect(cloneStructured(request)).toEqual(request);
  });

  it.each([
    ["invalid UUID", { requestId: "request-1" }],
    ["non-entrypoint filepath", { filepath: "shared.dbml" }],
    ["uppercase hash", { sourceHash: "A".repeat(64) }],
    ["short hash", { sourceHash: "a".repeat(63) }],
    ["unknown field", { parserMode: "dbmlv2" }],
  ])("rejects a request with %s", (_name, override) => {
    expect(
      dbmlParserWorkerRequestSchema.safeParse({
        type: "PARSE_DBML",
        requestId: REQUEST_ID,
        filepath: "/main.dbml",
        source: SOURCE,
        sourceHash: SOURCE_HASH,
        ...override,
      }).success,
    ).toBe(false);
  });

  it("accepts an opaque success graph without duplicating the Core contract", () => {
    const graph = {
      parserVersion: "9.1.1",
      schemaHash: "semantic-hash",
      tables: [],
      diagnostics: [],
    };
    const response = dbmlParserWorkerResponseSchema.parse({
      type: "DBML_PARSE_RESULT",
      requestId: REQUEST_ID,
      ok: true,
      sourceHash: SOURCE_HASH,
      parserInputHash: PARSER_INPUT_HASH,
      parserVersion: "9.1.1",
      diagnostics: [],
      graph,
    });

    expect(response).toEqual({
      type: "DBML_PARSE_RESULT",
      requestId: REQUEST_ID,
      ok: true,
      sourceHash: SOURCE_HASH,
      parserInputHash: PARSER_INPUT_HASH,
      parserVersion: "9.1.1",
      diagnostics: [],
      graph,
    });
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    expect(cloneStructured(response)).toEqual(response);
  });

  it("accepts a diagnostic failure and forbids a partial graph", () => {
    const failure = dbmlParserWorkerResponseSchema.parse({
      type: "DBML_PARSE_RESULT",
      requestId: REQUEST_ID,
      ok: false,
      sourceHash: SOURCE_HASH,
      parserInputHash: PARSER_INPUT_HASH,
      parserVersion: "9.1.1",
      diagnostics: [diagnostic],
    });

    expect(failure).toMatchObject({ ok: false, diagnostics: [diagnostic] });
    expect(
      dbmlParserWorkerResponseSchema.safeParse({ ...failure, graph: { tables: [] } }).success,
    ).toBe(false);
  });

  it.each([
    ["missing graph", { graph: undefined }],
    ["invalid parser-input hash", { parserInputHash: "not-a-hash" }],
    ["unknown field", { nativeReport: {} }],
    [
      "invalid diagnostic range",
      { diagnostics: [{ ...diagnostic, range: { ...diagnostic.range, endOffset: 1 } }] },
    ],
  ])("rejects a malformed success response with %s", (_name, override) => {
    const response = {
      type: "DBML_PARSE_RESULT",
      requestId: REQUEST_ID,
      ok: true,
      sourceHash: SOURCE_HASH,
      parserInputHash: PARSER_INPUT_HASH,
      parserVersion: "9.1.1",
      diagnostics: [],
      graph: {},
      ...override,
    };

    expect(dbmlParserWorkerResponseSchema.safeParse(response).success).toBe(false);
  });
});
