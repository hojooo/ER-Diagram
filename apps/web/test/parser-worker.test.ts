import { DEFAULT_RUNTIME_RESOURCE_LIMITS } from "@er-diagram/contracts";
import { sha256Utf8 } from "@er-diagram/core";
import { describe, expect, it } from "vitest";

import { handleDbmlParserWorkerRequest } from "../src/source-editor/parser-worker-handler.js";

const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("DBML parser worker handler", () => {
  it("returns a serializable normalized graph for valid DBML", async () => {
    const source = "Table users { id int [pk] }";
    const response = await parse(source);

    expect(response).toMatchObject({
      type: "DBML_PARSE_RESULT",
      requestId: REQUEST_ID,
      ok: true,
      sourceHash: await sha256Utf8(source),
      parserInputHash: await sha256Utf8(source),
      parserVersion: "9.1.1",
      diagnostics: [],
    });
    if (!response.ok) return;
    expect(response.graph).toMatchObject({ parserVersion: "9.1.1", tables: [{ name: "users" }] });
    expect(structuredClone(response)).toEqual(response);
  });

  it("returns diagnostics without a graph for invalid Unicode and CRLF DBML", async () => {
    const source = `Table "사용자😀" {\r\n  id int\r\n  @\r\n}`;
    const response = await parse(source);

    expect(response.ok).toBe(false);
    expect("graph" in response).toBe(false);
    expect(response.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DBML_PARSE_LEXICAL_UNKNOWN_SYMBOL",
          severity: "ERROR",
          range: {
            filepath: "/main.dbml",
            startOffset: source.indexOf("@"),
            endOffset: source.indexOf("@") + 1,
            startLine: 3,
            startColumn: 3,
            endLine: 3,
            endColumn: 4,
          },
        }),
      ]),
    );
  });

  it("preserves warning diagnostics on a successful graph", async () => {
    const source = "Table users { id int [not null] }\nRecords users(id) {\n null\n}";
    const response = await parse(source);

    expect(response.ok).toBe(true);
    expect(response.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DBML_SEMANTIC_INVALID_RECORDS_FIELD",
          severity: "WARNING",
        }),
      ]),
    );
  });

  it("rejects a request whose supplied source hash does not match its bytes", async () => {
    await expect(
      handleDbmlParserWorkerRequest({
        type: "PARSE_DBML",
        requestId: REQUEST_ID,
        filepath: "/main.dbml",
        source: "Table users { id int }",
        sourceHash: "a".repeat(64),
        limits: workerLimits(),
      }),
    ).rejects.toMatchObject({ code: "PARSER_WORKER_REQUEST_HASH_MISMATCH" });
  });
});

async function parse(source: string) {
  return handleDbmlParserWorkerRequest({
    type: "PARSE_DBML",
    requestId: REQUEST_ID,
    filepath: "/main.dbml",
    source,
    sourceHash: await sha256Utf8(source),
    limits: workerLimits(),
  });
}

function workerLimits() {
  return {
    maxSourceBytes: DEFAULT_RUNTIME_RESOURCE_LIMITS.maxSourceBytes,
    maxTables: DEFAULT_RUNTIME_RESOURCE_LIMITS.maxTables,
    maxReferences: DEFAULT_RUNTIME_RESOURCE_LIMITS.maxReferences,
    maxSchemaElements: DEFAULT_RUNTIME_RESOURCE_LIMITS.maxSchemaElements,
  };
}
