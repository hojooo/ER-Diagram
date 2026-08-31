import { existsSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

import {
  DEFAULT_SERVER_RESOURCE_LIMITS,
  parseServerResourceLimits,
  type ServerResourceLimits,
} from "./resource-limits.js";

export const DEFAULT_PRODUCTION_SHUTDOWN_TIMEOUT_MS = 30_000;
export const MAX_HSTS_AGE_SECONDS = 63_072_000;

export type StartupMigrationMode = "MANUAL" | "APPLY_WITH_BACKUP";
export type OperationalLogMode = "INFO" | "OFF";

export interface ProductionConfiguration {
  readonly shutdownTimeoutMs: number;
  readonly startupMigration: {
    readonly mode: StartupMigrationMode;
    readonly backupOutput: string | null;
  };
  readonly trustedProxyCidrs: readonly string[];
  readonly hstsMaxAgeSeconds: number;
  readonly operationalLog: OperationalLogMode;
  readonly resourceLimits: ServerResourceLimits;
}

export class ProductionConfigurationError extends Error {
  readonly code = "SERVER_CONFIGURATION_INVALID" as const;
  override readonly cause: unknown;

  constructor(cause?: unknown) {
    super("The production server configuration is invalid.");
    this.name = "ProductionConfigurationError";
    this.cause = cause;
  }
}

const RESOURCE_ENVIRONMENT_KEYS = {
  maxSourceBytes: "ER_DIAGRAM_MAX_SOURCE_BYTES",
  maxGeneratedOutputBytes: "ER_DIAGRAM_MAX_GENERATED_OUTPUT_BYTES",
  dbmlParserTimeoutMs: "ER_DIAGRAM_DBML_PARSER_TIMEOUT_MS",
  sqlConversionTimeoutMs: "ER_DIAGRAM_SQL_CONVERSION_TIMEOUT_MS",
  visualTransformTimeoutMs: "ER_DIAGRAM_VISUAL_TRANSFORM_TIMEOUT_MS",
  layoutTimeoutMs: "ER_DIAGRAM_LAYOUT_TIMEOUT_MS",
  maxTables: "ER_DIAGRAM_MAX_TABLES",
  maxReferences: "ER_DIAGRAM_MAX_REFERENCES",
  maxSchemaElements: "ER_DIAGRAM_MAX_SCHEMA_ELEMENTS",
  maxLayoutNodes: "ER_DIAGRAM_MAX_LAYOUT_NODES",
  maxLayoutEdges: "ER_DIAGRAM_MAX_LAYOUT_EDGES",
  maxRequestBodyBytes: "ER_DIAGRAM_MAX_REQUEST_BODY_BYTES",
  workerPoolSize: "ER_DIAGRAM_WORKER_POOL_SIZE",
  maxWorkerQueue: "ER_DIAGRAM_MAX_WORKER_QUEUE",
  workerQueueTimeoutMs: "ER_DIAGRAM_WORKER_QUEUE_TIMEOUT_MS",
  workerMaxOldGenerationSizeMb: "ER_DIAGRAM_WORKER_MAX_OLD_GENERATION_SIZE_MB",
  workerMaxYoungGenerationSizeMb: "ER_DIAGRAM_WORKER_MAX_YOUNG_GENERATION_SIZE_MB",
  workerStackSizeMb: "ER_DIAGRAM_WORKER_STACK_SIZE_MB",
} as const;

const BUNDLE_ENVIRONMENT_KEYS = {
  maxArchiveBytes: "ER_DIAGRAM_BUNDLE_MAX_ARCHIVE_BYTES",
  maxExpandedBytes: "ER_DIAGRAM_BUNDLE_MAX_EXPANDED_BYTES",
  maxEntryBytes: "ER_DIAGRAM_BUNDLE_MAX_ENTRY_BYTES",
  maxEntries: "ER_DIAGRAM_BUNDLE_MAX_ENTRIES",
} as const;

const LIFECYCLE_ENVIRONMENT_KEYS = [
  "ER_DIAGRAM_STARTUP_MIGRATION",
  "ER_DIAGRAM_STARTUP_MIGRATION_BACKUP_OUTPUT",
  "ER_DIAGRAM_SHUTDOWN_TIMEOUT_MS",
  "ER_DIAGRAM_TRUST_PROXY_CIDRS",
  "ER_DIAGRAM_HSTS_MAX_AGE_SECONDS",
  "ER_DIAGRAM_OPERATIONAL_LOG",
] as const;

const ALLOWED_ENVIRONMENT_KEYS = new Set<string>([
  ...LIFECYCLE_ENVIRONMENT_KEYS,
  ...Object.values(RESOURCE_ENVIRONMENT_KEYS),
  ...Object.values(BUNDLE_ENVIRONMENT_KEYS),
]);

export const DEFAULT_PRODUCTION_CONFIGURATION: ProductionConfiguration = Object.freeze({
  shutdownTimeoutMs: DEFAULT_PRODUCTION_SHUTDOWN_TIMEOUT_MS,
  startupMigration: Object.freeze({ mode: "MANUAL", backupOutput: null }),
  trustedProxyCidrs: Object.freeze([]),
  hstsMaxAgeSeconds: 0,
  operationalLog: "INFO",
  resourceLimits: DEFAULT_SERVER_RESOURCE_LIMITS,
});

export function parseProductionConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): ProductionConfiguration {
  try {
    assertKnownEnvironmentKeys(environment);
    const migrationMode = optionalEnum(
      environment.ER_DIAGRAM_STARTUP_MIGRATION,
      ["MANUAL", "APPLY_WITH_BACKUP"],
      "MANUAL",
    );
    const backupOutput = optionalString(environment.ER_DIAGRAM_STARTUP_MIGRATION_BACKUP_OUTPUT);
    if (migrationMode === "APPLY_WITH_BACKUP") {
      if (backupOutput === null || !path.isAbsolute(backupOutput) || existsSync(backupOutput)) {
        invalidConfiguration();
      }
    } else if (backupOutput !== null) {
      invalidConfiguration();
    }

    const trustedProxyCidrs = parseTrustedProxyCidrs(environment.ER_DIAGRAM_TRUST_PROXY_CIDRS);
    const hstsMaxAgeSeconds = optionalNonnegativeInteger(
      environment.ER_DIAGRAM_HSTS_MAX_AGE_SECONDS,
      0,
    );
    if (
      hstsMaxAgeSeconds > MAX_HSTS_AGE_SECONDS ||
      (hstsMaxAgeSeconds > 0 && trustedProxyCidrs.length === 0)
    ) {
      invalidConfiguration();
    }

    const resourceLimits = parseResourceLimits(environment);
    return Object.freeze({
      shutdownTimeoutMs: optionalPositiveInteger(
        environment.ER_DIAGRAM_SHUTDOWN_TIMEOUT_MS,
        DEFAULT_PRODUCTION_SHUTDOWN_TIMEOUT_MS,
      ),
      startupMigration: Object.freeze({ mode: migrationMode, backupOutput }),
      trustedProxyCidrs: Object.freeze(trustedProxyCidrs),
      hstsMaxAgeSeconds,
      operationalLog: optionalEnum(environment.ER_DIAGRAM_OPERATIONAL_LOG, ["INFO", "OFF"], "INFO"),
      resourceLimits,
    });
  } catch (error) {
    if (error instanceof ProductionConfigurationError) throw error;
    throw new ProductionConfigurationError(error);
  }
}

function parseResourceLimits(
  environment: Readonly<Record<string, string | undefined>>,
): ServerResourceLimits {
  const resourceValues = Object.fromEntries(
    Object.entries(RESOURCE_ENVIRONMENT_KEYS).map(([property, environmentKey]) => [
      property,
      optionalPositiveInteger(
        environment[environmentKey],
        DEFAULT_SERVER_RESOURCE_LIMITS[property as keyof typeof RESOURCE_ENVIRONMENT_KEYS],
      ),
    ]),
  );
  const bundleValues = Object.fromEntries(
    Object.entries(BUNDLE_ENVIRONMENT_KEYS).map(([property, environmentKey]) => [
      property,
      optionalPositiveInteger(
        environment[environmentKey],
        DEFAULT_SERVER_RESOURCE_LIMITS.bundle[property as keyof typeof BUNDLE_ENVIRONMENT_KEYS],
      ),
    ]),
  );
  return parseServerResourceLimits({ ...resourceValues, bundle: bundleValues });
}

function assertKnownEnvironmentKeys(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  for (const key of Object.keys(environment)) {
    if (key.startsWith("ER_DIAGRAM_") && !ALLOWED_ENVIRONMENT_KEYS.has(key)) {
      invalidConfiguration();
    }
  }
}

function parseTrustedProxyCidrs(value: string | undefined): string[] {
  if (value === undefined) return [];
  if (value.length === 0) invalidConfiguration();
  const cidrs = value.split(",").map((entry) => entry.trim());
  if (cidrs.some((entry) => entry.length === 0) || new Set(cidrs).size !== cidrs.length) {
    invalidConfiguration();
  }
  for (const cidr of cidrs) assertIpOrCidr(cidr);
  return cidrs;
}

function assertIpOrCidr(value: string): void {
  const separator = value.lastIndexOf("/");
  const address = separator === -1 ? value : value.slice(0, separator);
  const version = isIP(address);
  if (version === 0) invalidConfiguration();
  if (separator === -1) return;
  const prefixText = value.slice(separator + 1);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(prefixText)) invalidConfiguration();
  const prefix = Number(prefixText);
  if (prefix > (version === 4 ? 32 : 128)) invalidConfiguration();
}

function optionalString(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value.trim().length === 0 || value !== value.trim()) invalidConfiguration();
  return value;
}

function optionalPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = parseInteger(value);
  if (parsed <= 0) invalidConfiguration();
  return parsed;
}

function optionalNonnegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return parseInteger(value);
}

function parseInteger(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) invalidConfiguration();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalidConfiguration();
  return parsed;
}

function optionalEnum<const TValue extends string>(
  value: string | undefined,
  values: readonly TValue[],
  fallback: TValue,
): TValue {
  if (value === undefined) return fallback;
  if ((values as readonly string[]).includes(value)) return value as TValue;
  invalidConfiguration();
}

function invalidConfiguration(): never {
  throw new ProductionConfigurationError();
}
