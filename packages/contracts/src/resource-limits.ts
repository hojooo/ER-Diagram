import { z } from "zod";

export const RESOURCE_LIMITS_VERSION = 1 as const;

const MEBIBYTE = 1024 * 1024;
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const bundleResourceLimitsSchema = z
  .object({
    maxArchiveBytes: positiveSafeIntegerSchema,
    maxExpandedBytes: positiveSafeIntegerSchema,
    maxEntryBytes: positiveSafeIntegerSchema,
    maxEntries: positiveSafeIntegerSchema,
  })
  .strict()
  .superRefine((limits, context) => {
    if (limits.maxEntryBytes > limits.maxArchiveBytes) {
      context.addIssue({
        code: "custom",
        message: "A bundle entry limit must not exceed the archive limit.",
        path: ["maxEntryBytes"],
      });
    }
    if (limits.maxArchiveBytes > limits.maxExpandedBytes) {
      context.addIssue({
        code: "custom",
        message: "The archive limit must not exceed the expanded bundle limit.",
        path: ["maxArchiveBytes"],
      });
    }
  });

export const runtimeResourceLimitsSchema = z
  .object({
    maxSourceBytes: positiveSafeIntegerSchema,
    maxGeneratedOutputBytes: positiveSafeIntegerSchema,
    dbmlParserTimeoutMs: positiveSafeIntegerSchema,
    sqlConversionTimeoutMs: positiveSafeIntegerSchema,
    visualTransformTimeoutMs: positiveSafeIntegerSchema,
    layoutTimeoutMs: positiveSafeIntegerSchema,
    maxTables: positiveSafeIntegerSchema,
    maxReferences: positiveSafeIntegerSchema,
    maxSchemaElements: positiveSafeIntegerSchema,
    maxLayoutNodes: positiveSafeIntegerSchema,
    maxLayoutEdges: positiveSafeIntegerSchema,
    bundle: bundleResourceLimitsSchema,
  })
  .strict()
  .superRefine((limits, context) => {
    if (limits.maxSourceBytes > limits.maxGeneratedOutputBytes) {
      context.addIssue({
        code: "custom",
        message: "The source limit must not exceed the generated output limit.",
        path: ["maxSourceBytes"],
      });
    }
    if (limits.maxTables > limits.maxSchemaElements) {
      context.addIssue({
        code: "custom",
        message: "The table limit must not exceed the total schema element limit.",
        path: ["maxTables"],
      });
    }
    if (limits.maxReferences > limits.maxSchemaElements) {
      context.addIssue({
        code: "custom",
        message: "The reference limit must not exceed the total schema element limit.",
        path: ["maxReferences"],
      });
    }
  });

export type RuntimeResourceLimits = z.infer<typeof runtimeResourceLimitsSchema>;

export const runtimeConfigResponseSchema = z
  .object({
    configVersion: z.literal(RESOURCE_LIMITS_VERSION),
    resourceLimits: runtimeResourceLimitsSchema,
  })
  .strict();

export type RuntimeConfigResponse = z.infer<typeof runtimeConfigResponseSchema>;

export const dbmlParserWorkerLimitsSchema = z
  .object({
    maxSourceBytes: positiveSafeIntegerSchema,
    maxTables: positiveSafeIntegerSchema,
    maxReferences: positiveSafeIntegerSchema,
    maxSchemaElements: positiveSafeIntegerSchema,
  })
  .strict();

export type DbmlParserWorkerLimits = z.infer<typeof dbmlParserWorkerLimitsSchema>;

export const DEFAULT_RUNTIME_RESOURCE_LIMITS = runtimeResourceLimitsSchema.parse({
  maxSourceBytes: 5 * MEBIBYTE,
  maxGeneratedOutputBytes: 16 * MEBIBYTE,
  dbmlParserTimeoutMs: 5_000,
  sqlConversionTimeoutMs: 15_000,
  visualTransformTimeoutMs: 5_000,
  layoutTimeoutMs: 10_000,
  maxTables: 2_000,
  maxReferences: 10_000,
  maxSchemaElements: 100_000,
  maxLayoutNodes: 2_500,
  maxLayoutEdges: 10_000,
  bundle: {
    maxArchiveBytes: 256 * MEBIBYTE,
    maxExpandedBytes: 1024 * MEBIBYTE,
    maxEntryBytes: 16 * MEBIBYTE,
    maxEntries: 2_048,
  },
});

/** Returns the byte length produced by the platform UTF-8 encoder. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
