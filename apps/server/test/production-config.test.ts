import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRODUCTION_CONFIGURATION,
  type ProductionConfigurationError,
  parseProductionConfiguration,
} from "../src/production-config.js";
import { DEFAULT_SERVER_RESOURCE_LIMITS } from "../src/resource-limits.js";

describe("production environment configuration", () => {
  it("uses the fixed safe production defaults", () => {
    const config = parseProductionConfiguration({});

    expect(config).toEqual(DEFAULT_PRODUCTION_CONFIGURATION);
    expect(config).toMatchObject({
      shutdownTimeoutMs: 30_000,
      startupMigration: { mode: "MANUAL", backupOutput: null },
      trustedProxyCidrs: [],
      hstsMaxAgeSeconds: 0,
      operationalLog: "INFO",
      resourceLimits: DEFAULT_SERVER_RESOURCE_LIMITS,
    });
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
    expect(structuredClone(config)).toEqual(config);
  });

  it("maps every lifecycle, proxy, and resource limit override", () => {
    const config = parseProductionConfiguration({
      ER_DIAGRAM_STARTUP_MIGRATION: "APPLY_WITH_BACKUP",
      ER_DIAGRAM_STARTUP_MIGRATION_BACKUP_OUTPUT: "/data/backups/pre-v2",
      ER_DIAGRAM_SHUTDOWN_TIMEOUT_MS: "45000",
      ER_DIAGRAM_TRUST_PROXY_CIDRS: "127.0.0.1,10.0.0.0/8,2001:db8::/32",
      ER_DIAGRAM_HSTS_MAX_AGE_SECONDS: "31536000",
      ER_DIAGRAM_OPERATIONAL_LOG: "OFF",
      ER_DIAGRAM_MAX_SOURCE_BYTES: "100",
      ER_DIAGRAM_MAX_GENERATED_OUTPUT_BYTES: "200",
      ER_DIAGRAM_DBML_PARSER_TIMEOUT_MS: "300",
      ER_DIAGRAM_SQL_CONVERSION_TIMEOUT_MS: "400",
      ER_DIAGRAM_VISUAL_TRANSFORM_TIMEOUT_MS: "500",
      ER_DIAGRAM_LAYOUT_TIMEOUT_MS: "600",
      ER_DIAGRAM_MAX_TABLES: "10",
      ER_DIAGRAM_MAX_REFERENCES: "20",
      ER_DIAGRAM_MAX_SCHEMA_ELEMENTS: "30",
      ER_DIAGRAM_MAX_LAYOUT_NODES: "40",
      ER_DIAGRAM_MAX_LAYOUT_EDGES: "50",
      ER_DIAGRAM_BUNDLE_MAX_ARCHIVE_BYTES: "1000",
      ER_DIAGRAM_BUNDLE_MAX_EXPANDED_BYTES: "2000",
      ER_DIAGRAM_BUNDLE_MAX_ENTRY_BYTES: "900",
      ER_DIAGRAM_BUNDLE_MAX_ENTRIES: "60",
      ER_DIAGRAM_MAX_REQUEST_BODY_BYTES: "300",
      ER_DIAGRAM_WORKER_POOL_SIZE: "3",
      ER_DIAGRAM_MAX_WORKER_QUEUE: "9",
      ER_DIAGRAM_WORKER_QUEUE_TIMEOUT_MS: "700",
      ER_DIAGRAM_WORKER_MAX_OLD_GENERATION_SIZE_MB: "512",
      ER_DIAGRAM_WORKER_MAX_YOUNG_GENERATION_SIZE_MB: "64",
      ER_DIAGRAM_WORKER_STACK_SIZE_MB: "8",
    });

    expect(config).toMatchObject({
      shutdownTimeoutMs: 45_000,
      startupMigration: {
        mode: "APPLY_WITH_BACKUP",
        backupOutput: "/data/backups/pre-v2",
      },
      trustedProxyCidrs: ["127.0.0.1", "10.0.0.0/8", "2001:db8::/32"],
      hstsMaxAgeSeconds: 31_536_000,
      operationalLog: "OFF",
      resourceLimits: {
        maxSourceBytes: 100,
        maxGeneratedOutputBytes: 200,
        maxRequestBodyBytes: 300,
        workerPoolSize: 3,
        bundle: {
          maxArchiveBytes: 1_000,
          maxExpandedBytes: 2_000,
          maxEntryBytes: 900,
          maxEntries: 60,
        },
      },
    });
  });

  it.each([
    { ER_DIAGRAM_UNKNOWN: "1" },
    { ER_DIAGRAM_SHUTDOWN_TIMEOUT_MS: "" },
    { ER_DIAGRAM_SHUTDOWN_TIMEOUT_MS: "+1" },
    { ER_DIAGRAM_SHUTDOWN_TIMEOUT_MS: "1.5" },
    { ER_DIAGRAM_SHUTDOWN_TIMEOUT_MS: "1e3" },
    { ER_DIAGRAM_TRUST_PROXY_CIDRS: "proxy.local" },
    { ER_DIAGRAM_TRUST_PROXY_CIDRS: "10.0.0.0/33" },
    { ER_DIAGRAM_HSTS_MAX_AGE_SECONDS: "1" },
    { ER_DIAGRAM_STARTUP_MIGRATION: "ALWAYS" },
    { ER_DIAGRAM_STARTUP_MIGRATION: "APPLY_WITH_BACKUP" },
    { ER_DIAGRAM_STARTUP_MIGRATION_BACKUP_OUTPUT: "/data/unused" },
    {
      ER_DIAGRAM_STARTUP_MIGRATION: "APPLY_WITH_BACKUP",
      ER_DIAGRAM_STARTUP_MIGRATION_BACKUP_OUTPUT: "relative/backup",
    },
    {
      ER_DIAGRAM_MAX_SOURCE_BYTES: "200",
      ER_DIAGRAM_MAX_GENERATED_OUTPUT_BYTES: "100",
    },
  ])("rejects invalid or ambiguous configuration %#", (environment) => {
    expect(() => parseProductionConfiguration(environment)).toThrowError(
      expect.objectContaining<Partial<ProductionConfigurationError>>({
        code: "SERVER_CONFIGURATION_INVALID",
      }),
    );
  });

  it("rejects an existing startup migration backup destination", () => {
    const existing = mkdtempSync(path.join(tmpdir(), "er-diagram-existing-migration-backup-"));
    try {
      expect(() =>
        parseProductionConfiguration({
          ER_DIAGRAM_STARTUP_MIGRATION: "APPLY_WITH_BACKUP",
          ER_DIAGRAM_STARTUP_MIGRATION_BACKUP_OUTPUT: existing,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<ProductionConfigurationError>>({
          code: "SERVER_CONFIGURATION_INVALID",
        }),
      );
    } finally {
      rmSync(existing, { force: true, recursive: true });
    }
  });
});
