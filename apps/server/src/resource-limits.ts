import {
  DEFAULT_RUNTIME_RESOURCE_LIMITS,
  type RuntimeResourceLimits,
  runtimeResourceLimitsSchema,
} from "@er-diagram/contracts";

const MEBIBYTE = 1024 * 1024;

export interface ServerResourceLimits extends RuntimeResourceLimits {
  readonly maxRequestBodyBytes: number;
  readonly workerPoolSize: number;
  readonly maxWorkerQueue: number;
  readonly workerQueueTimeoutMs: number;
  readonly workerMaxOldGenerationSizeMb: number;
  readonly workerMaxYoungGenerationSizeMb: number;
  readonly workerStackSizeMb: number;
}

export const DEFAULT_SERVER_RESOURCE_LIMITS: ServerResourceLimits = Object.freeze({
  ...DEFAULT_RUNTIME_RESOURCE_LIMITS,
  bundle: Object.freeze({ ...DEFAULT_RUNTIME_RESOURCE_LIMITS.bundle }),
  maxRequestBodyBytes: 32 * MEBIBYTE,
  workerPoolSize: 2,
  maxWorkerQueue: 8,
  workerQueueTimeoutMs: 5_000,
  workerMaxOldGenerationSizeMb: 256,
  workerMaxYoungGenerationSizeMb: 32,
  workerStackSizeMb: 4,
});

const SERVER_ONLY_KEYS = [
  "maxRequestBodyBytes",
  "workerPoolSize",
  "maxWorkerQueue",
  "workerQueueTimeoutMs",
  "workerMaxOldGenerationSizeMb",
  "workerMaxYoungGenerationSizeMb",
  "workerStackSizeMb",
] as const;

const RUNTIME_KEYS = [
  "maxSourceBytes",
  "maxGeneratedOutputBytes",
  "dbmlParserTimeoutMs",
  "sqlConversionTimeoutMs",
  "visualTransformTimeoutMs",
  "layoutTimeoutMs",
  "maxTables",
  "maxReferences",
  "maxSchemaElements",
  "maxLayoutNodes",
  "maxLayoutEdges",
  "bundle",
] as const;

export function parseServerResourceLimits(input: unknown): ServerResourceLimits {
  if (!isPlainRecord(input)) throw new TypeError("Server resource limits must be an object.");
  const allowed = new Set<string>([...RUNTIME_KEYS, ...SERVER_ONLY_KEYS]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new TypeError("Server resource limits contain an unknown field.");
  }

  const runtime = runtimeResourceLimitsSchema.parse(
    Object.fromEntries(RUNTIME_KEYS.map((key) => [key, input[key]])),
  );
  for (const key of SERVER_ONLY_KEYS) assertPositiveSafeInteger(input[key], key);
  const limits = {
    ...runtime,
    bundle: Object.freeze({ ...runtime.bundle }),
    maxRequestBodyBytes: input.maxRequestBodyBytes as number,
    workerPoolSize: input.workerPoolSize as number,
    maxWorkerQueue: input.maxWorkerQueue as number,
    workerQueueTimeoutMs: input.workerQueueTimeoutMs as number,
    workerMaxOldGenerationSizeMb: input.workerMaxOldGenerationSizeMb as number,
    workerMaxYoungGenerationSizeMb: input.workerMaxYoungGenerationSizeMb as number,
    workerStackSizeMb: input.workerStackSizeMb as number,
  } satisfies ServerResourceLimits;
  if (limits.maxSourceBytes > limits.maxRequestBodyBytes) {
    throw new RangeError("The source byte limit must not exceed the raw request body limit.");
  }
  return Object.freeze(limits);
}

export function toRuntimeResourceLimits(limits: ServerResourceLimits): RuntimeResourceLimits {
  return runtimeResourceLimitsSchema.parse(
    Object.fromEntries(RUNTIME_KEYS.map((key) => [key, limits[key]])),
  );
}

function assertPositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
