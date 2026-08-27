import { describe, expect, it } from "vitest";
import { diagnosticSchema, sourceRangeSchema } from "../src/index.js";

const validRange = {
  filepath: "/main.dbml",
  startOffset: 4,
  endOffset: 9,
  startLine: 1,
  startColumn: 5,
  endLine: 1,
  endColumn: 10,
};

describe("shared source diagnostic contract", () => {
  it("accepts strict UTF-16 source ranges and plain-data diagnostics", () => {
    const diagnostic = diagnosticSchema.parse({
      code: "DBML_PARSE_SYNTAX_UNEXPECTED_TOKEN",
      message: "Expect a closing brace '}'",
      severity: "ERROR",
      range: validRange,
    });

    expect(sourceRangeSchema.parse(validRange)).toEqual(validRange);
    const clone = Reflect.get(globalThis, "structuredClone");
    expect(clone).toBeTypeOf("function");
    if (typeof clone !== "function") return;
    expect(clone(JSON.parse(JSON.stringify(diagnostic)))).toEqual(diagnostic);
  });

  it("allows diagnostics without a source range for project and internal failures", () => {
    expect(
      diagnosticSchema.parse({
        code: "DBML_SEMANTIC_ENTRYPOINT_NOT_FOUND",
        message: "The DBML entrypoint does not exist.",
        severity: "ERROR",
      }),
    ).toEqual({
      code: "DBML_SEMANTIC_ENTRYPOINT_NOT_FOUND",
      message: "The DBML entrypoint does not exist.",
      severity: "ERROR",
    });
  });

  it.each([
    ["empty filepath", { ...validRange, filepath: "" }],
    ["negative offset", { ...validRange, startOffset: -1 }],
    ["reversed offset", { ...validRange, startOffset: 10, endOffset: 9 }],
    ["reversed line", { ...validRange, startLine: 2, endLine: 1 }],
    ["reversed column", { ...validRange, startColumn: 10, endColumn: 9 }],
    ["unknown field", { ...validRange, parserNode: "must-not-cross-the-boundary" }],
  ])("rejects an invalid range: %s", (_name, range) => {
    expect(sourceRangeSchema.safeParse(range).success).toBe(false);
  });

  it("rejects unknown diagnostic fields", () => {
    expect(
      diagnosticSchema.safeParse({
        code: "DBML_PARSE_INTERNAL_COMPILER_FAILURE",
        message: "DBML compilation failed.",
        severity: "ERROR",
        stack: "parser internals",
      }).success,
    ).toBe(false);
  });
});
