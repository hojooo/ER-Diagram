import { describe, expect, it } from "vitest";

import {
  DEFAULT_RUNTIME_RESOURCE_LIMITS,
  RESOURCE_LIMITS_VERSION,
  runtimeConfigResponseSchema,
  runtimeResourceLimitsSchema,
  utf8ByteLength,
} from "../src/index.js";

const cloneStructured = (globalThis as unknown as { structuredClone<T>(value: T): T })
  .structuredClone;

describe("runtime resource limit contract", () => {
  it("publishes the balanced P0 profile as strict cloneable plain data", () => {
    const response = runtimeConfigResponseSchema.parse({
      configVersion: RESOURCE_LIMITS_VERSION,
      resourceLimits: DEFAULT_RUNTIME_RESOURCE_LIMITS,
    });

    expect(response.resourceLimits).toMatchObject({
      maxSourceBytes: 5 * 1024 * 1024,
      maxGeneratedOutputBytes: 16 * 1024 * 1024,
      dbmlParserTimeoutMs: 5_000,
      sqlConversionTimeoutMs: 15_000,
      visualTransformTimeoutMs: 5_000,
      layoutTimeoutMs: 10_000,
      maxTables: 2_000,
      maxReferences: 10_000,
      maxSchemaElements: 100_000,
      maxLayoutNodes: 2_500,
      maxLayoutEdges: 10_000,
    });
    expect(cloneStructured(response)).toEqual(response);
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    expect(runtimeConfigResponseSchema.safeParse({ ...response, extra: true }).success).toBe(false);
  });

  it("rejects unsafe integer and inconsistent byte/count relationships", () => {
    expect(
      runtimeResourceLimitsSchema.safeParse({
        ...DEFAULT_RUNTIME_RESOURCE_LIMITS,
        maxSourceBytes: DEFAULT_RUNTIME_RESOURCE_LIMITS.maxGeneratedOutputBytes + 1,
      }).success,
    ).toBe(false);
    expect(
      runtimeResourceLimitsSchema.safeParse({
        ...DEFAULT_RUNTIME_RESOURCE_LIMITS,
        maxTables: DEFAULT_RUNTIME_RESOURCE_LIMITS.maxSchemaElements + 1,
      }).success,
    ).toBe(false);
    expect(
      runtimeResourceLimitsSchema.safeParse({
        ...DEFAULT_RUNTIME_RESOURCE_LIMITS,
        bundle: {
          ...DEFAULT_RUNTIME_RESOURCE_LIMITS.bundle,
          maxEntryBytes: DEFAULT_RUNTIME_RESOURCE_LIMITS.bundle.maxArchiveBytes + 1,
        },
      }).success,
    ).toBe(false);
    expect(
      runtimeResourceLimitsSchema.safeParse({
        ...DEFAULT_RUNTIME_RESOURCE_LIMITS,
        layoutTimeoutMs: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });

  it("counts UTF-8 bytes across ASCII, Unicode, emoji, CRLF, and lone surrogates", () => {
    expect([
      utf8ByteLength("ascii\r\n"),
      utf8ByteLength("한글"),
      utf8ByteLength("😀"),
      utf8ByteLength("a😀한\r\n"),
      utf8ByteLength("\ud800"),
      utf8ByteLength("\udc00"),
    ]).toEqual([7, 6, 4, 10, 3, 3]);
  });
});
