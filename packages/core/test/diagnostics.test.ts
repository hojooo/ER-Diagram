import { diagnosticSchema, sourceRangeSchema } from "@er-diagram/contracts";
import { describe, expect, it } from "vitest";
import { parseDbmlProjectV2, parseDbmlV2 } from "../src/index.js";
import { normalizeDbmlDiagnostics } from "../src/dbml-diagnostics.js";

describe("DBML diagnostics", () => {
  it("classifies lexical errors with an exact single-file range", async () => {
    const source = "Table users { id int @ }";
    const result = await parseDbmlV2(source, "/custom/schema.dbml");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect("graph" in result).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        code: "DBML_PARSE_LEXICAL_UNKNOWN_SYMBOL",
        message: "Unexpected token '@'",
        severity: "ERROR",
        range: {
          filepath: "/custom/schema.dbml",
          startOffset: 21,
          endOffset: 22,
          startLine: 1,
          startColumn: 22,
          endLine: 1,
          endColumn: 23,
        },
      },
    ]);
  });

  it("classifies a syntax EOF as a zero-length UTF-16 range", async () => {
    const source = "Table users {\n id int";
    const result = await parseDbmlV2(source);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "DBML_PARSE_SYNTAX_UNEXPECTED_TOKEN",
        severity: "ERROR",
        range: {
          filepath: "/main.dbml",
          startOffset: source.length,
          endOffset: source.length,
          startLine: 2,
          startColumn: 8,
          endLine: 2,
          endColumn: 8,
        },
      }),
    ]);
  });

  it("classifies duplicate symbols and unresolved references as semantic errors", async () => {
    const duplicateSource = "Table users { id int }\nTable users { id int }";
    const unresolvedSource = "Table users { id int }\nRef: users.id > missing.id";

    const duplicate = await parseDbmlV2(duplicateSource);
    const unresolved = await parseDbmlV2(unresolvedSource);

    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.diagnostics).toEqual([
        expect.objectContaining({
          code: "DBML_SEMANTIC_DUPLICATE_NAME",
          severity: "ERROR",
          range: expect.objectContaining({
            filepath: "/main.dbml",
            startOffset: 29,
            endOffset: 34,
            startLine: 2,
            startColumn: 7,
            endLine: 2,
            endColumn: 12,
          }),
        }),
      ]);
    }

    expect(unresolved.ok).toBe(false);
    if (!unresolved.ok) {
      const missingStart = unresolvedSource.indexOf("missing");
      expect(unresolved.diagnostics).toEqual([
        expect.objectContaining({
          code: "DBML_SEMANTIC_BINDING_ERROR",
          severity: "ERROR",
          range: expect.objectContaining({
            filepath: "/main.dbml",
            startOffset: missingStart,
            endOffset: missingStart + "missing".length,
            startLine: 2,
            startColumn: 17,
            endLine: 2,
            endColumn: 24,
          }),
        }),
      ]);
    }
  });

  it("keeps compiler warnings on a valid graph without changing semantic hash", async () => {
    const schemaOnly = "Table users { id int [not null] }";
    const withRecordsWarning = `${schemaOnly}\nRecords users(id) {\n null\n}`;

    const clean = await parseDbmlV2(schemaOnly);
    const warned = await parseDbmlV2(withRecordsWarning);

    expect(clean.ok && warned.ok).toBe(true);
    if (!clean.ok || !warned.ok) return;
    expect(warned.graph.schemaHash).toBe(clean.graph.schemaHash);
    expect(warned.graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "DBML_SEMANTIC_INVALID_RECORDS_FIELD",
        severity: "WARNING",
        range: expect.objectContaining({
          filepath: "/main.dbml",
          startOffset: withRecordsWarning.lastIndexOf("null"),
          endOffset: withRecordsWarning.lastIndexOf("null") + 4,
          startLine: 3,
          startColumn: 2,
          endLine: 3,
          endColumn: 6,
        }),
      }),
    ]);
  });

  it("keeps compiler info diagnostics but excludes parser quick-fix objects", async () => {
    const source = `Table users { id int }
Table posts { user_id int }
Ref: posts.user_id - users.id`;
    const result = await parseDbmlV2(source);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.diagnostics.length).toBeGreaterThan(0);
    expect(result.graph.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DBML_SEMANTIC_INVALID_REF_RELATIONSHIP",
          severity: "INFO",
        }),
      ]),
    );
    expect(JSON.stringify(result.graph.diagnostics)).not.toContain("quickFix");
    expect(JSON.stringify(result.graph.diagnostics)).not.toContain("nodeOrToken");
  });

  it("uses UTF-16 offsets and the caller filepath for Unicode CRLF diagnostics", async () => {
    const source = `Table "🚀" {\r\n  id int\r\n  @\r\n}`;
    const result = await parseDbmlV2(source, "schema/emoji.dbml");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DBML_PARSE_LEXICAL_UNKNOWN_SYMBOL",
          range: {
            filepath: "schema/emoji.dbml",
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

  it("preserves each original multifile key in diagnostics", async () => {
    const result = await parseDbmlProjectV2({
      entrypoint: "schema/main.dbml",
      files: {
        "schema/main.dbml": "use * from './shared'\nRef: users.id > missing.id",
        "schema/shared.dbml": "Table users { id int }\nTable users { second int }",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      new Set(result.diagnostics.flatMap((diagnostic) => diagnostic.range?.filepath ?? [])),
    ).toEqual(new Set(["schema/main.dbml", "schema/shared.dbml"]));
    expect(
      result.diagnostics.every((diagnostic) => diagnosticSchema.safeParse(diagnostic).success),
    ).toBe(true);
  });

  it("rejects canonical filepath collisions and missing entrypoints without a source range", async () => {
    const collision = await parseDbmlProjectV2({
      entrypoint: "schema/main.dbml",
      files: {
        "schema/main.dbml": "Table one { id int }",
        "/schema/main.dbml": "Table two { id int }",
      },
    });
    const missing = await parseDbmlProjectV2({
      entrypoint: "/missing.dbml",
      files: { "/main.dbml": "Table users { id int }" },
    });

    expect(collision).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "DBML_SEMANTIC_FILEPATH_COLLISION",
          severity: "ERROR",
        },
      ],
    });
    expect(missing).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "DBML_SEMANTIC_ENTRYPOINT_NOT_FOUND",
          severity: "ERROR",
        },
      ],
    });
  });

  it("validates every graph source-map range with the shared contract", async () => {
    const result = await parseDbmlV2(`Project sample {
  Note: "plain data"
}
Table users {
  id int [pk]
}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      Object.values(result.graph.sourceMap).every(
        (range) => sourceRangeSchema.safeParse(range).success,
      ),
    ).toBe(true);
    expect(structuredClone(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it("fails closed when a native diagnostic range cannot be mapped to its source", () => {
    const diagnostics = normalizeDbmlDiagnostics(
      {
        errors: [
          {
            code: 1000,
            diagnostic: "Unexpected token '@'",
            nodeOrToken: {
              filepath: { absolute: "/internal.dbml" },
              start: 99,
              end: 100,
              startPos: { offset: 99, line: 0, column: 99 },
              endPos: { offset: 100, line: 0, column: 100 },
            },
          },
        ],
        warnings: [],
        infos: [],
      },
      {
        fallbackPublicFilepath: "/main.dbml",
        publicFilepathByCompilerPath: new Map([["/internal.dbml", "/main.dbml"]]),
        sourceByPublicFilepath: new Map([["/main.dbml", "Table users { id int }"]]),
      },
    );

    expect(diagnostics).toEqual([
      {
        code: "DBML_PARSE_INTERNAL_DIAGNOSTIC_RANGE",
        message: "DBML compiler returned an invalid diagnostic source range.",
        severity: "ERROR",
      },
    ]);
  });

  it("sorts, deduplicates, and names unknown native diagnostics deterministically", () => {
    const source = "@ x";
    const node = (start: number, end: number) => ({
      filepath: { absolute: "/internal.dbml" },
      start,
      end,
      startPos: { offset: start, line: 0, column: start },
      endPos: { offset: end, line: 0, column: end },
    });
    const unknownSyntax = {
      code: 1999,
      diagnostic: "Unknown syntax diagnostic",
      nodeOrToken: node(2, 3),
    };

    const diagnostics = normalizeDbmlDiagnostics(
      {
        errors: [unknownSyntax, unknownSyntax],
        warnings: [
          {
            code: 3999,
            diagnostic: "Unknown semantic diagnostic",
            nodeOrToken: node(0, 1),
          },
        ],
        infos: [],
      },
      {
        fallbackPublicFilepath: "/main.dbml",
        publicFilepathByCompilerPath: new Map([["/internal.dbml", "/main.dbml"]]),
        sourceByPublicFilepath: new Map([["/main.dbml", source]]),
      },
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "DBML_PARSE_SYNTAX_NATIVE_1999",
        severity: "ERROR",
      }),
      expect.objectContaining({
        code: "DBML_SEMANTIC_NATIVE_3999",
        severity: "WARNING",
      }),
    ]);
  });
});
