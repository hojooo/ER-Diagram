import { describe, expect, it } from "vitest";

import {
  SQLITE_VOLUME_BACKUP_FORMAT_VERSION,
  SQLITE_VOLUME_RECOVERY_PLAN_VERSION,
  sqliteVolumeBackupManifestV1Schema,
  sqliteVolumeRecoveryPlanV1Schema,
} from "../src/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const CREATED_AT = "2026-08-31T01:02:03.000Z";

function manifest() {
  return {
    format: "ER_DIAGRAM_SQLITE_VOLUME_BACKUP" as const,
    backupFormatVersion: SQLITE_VOLUME_BACKUP_FORMAT_VERSION,
    backupHash: HASH_A,
    createdAt: CREATED_AT,
    database: {
      path: "database.sqlite" as const,
      bytes: 16_384,
      sha256: HASH_B,
      storageSchemaVersion: 2,
      migrationHistoryHash: HASH_C,
      sqliteVersion: "3.50.4",
      pageSize: 4_096,
      pageCount: 4,
    },
    inventory: {
      projects: 2,
      schemaRevisions: 4,
      diagramLayouts: 3,
      importArtifacts: 1,
      visualCommandReceipts: 2,
      appMetadata: 2,
      drizzleMigrations: 2,
    },
  };
}

function recoveryPlan() {
  return {
    planVersion: SQLITE_VOLUME_RECOVERY_PLAN_VERSION,
    operation: "RESTORE" as const,
    sourceBackupHash: HASH_A,
    targetPathHash: HASH_B,
    expectedTargetDatabaseSha256: HASH_C,
    sourceStorageSchemaVersion: 1,
    resultStorageSchemaVersion: 2,
    bundledMigrationSetHash: HASH_D,
    requiresMigration: true,
    candidateDatabaseSha256: HASH_B,
    planHash: HASH_C,
  };
}

describe("SQLite volume backup contracts", () => {
  it("accepts strict versioned manifest and recovery plan plain data", () => {
    const parsed = {
      manifest: sqliteVolumeBackupManifestV1Schema.parse(manifest()),
      plan: sqliteVolumeRecoveryPlanV1Schema.parse(recoveryPlan()),
    };
    const clone = Reflect.get(globalThis, "structuredClone") as
      | ((value: unknown) => unknown)
      | undefined;
    expect(clone).toBeTypeOf("function");
    expect(clone?.(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("rejects unknown fields, malformed hashes and unsafe integer evidence", () => {
    expect(
      sqliteVolumeBackupManifestV1Schema.safeParse({ ...manifest(), extra: true }).success,
    ).toBe(false);
    expect(
      sqliteVolumeBackupManifestV1Schema.safeParse({
        ...manifest(),
        database: { ...manifest().database, sha256: HASH_B.toUpperCase() },
      }).success,
    ).toBe(false);
    expect(
      sqliteVolumeBackupManifestV1Schema.safeParse({
        ...manifest(),
        inventory: { ...manifest().inventory, projects: Number.MAX_SAFE_INTEGER + 1 },
      }).success,
    ).toBe(false);
    expect(
      sqliteVolumeRecoveryPlanV1Schema.safeParse({ ...recoveryPlan(), extra: true }).success,
    ).toBe(false);
  });

  it("rejects downgrade and inconsistent migration evidence", () => {
    expect(
      sqliteVolumeRecoveryPlanV1Schema.safeParse({
        ...recoveryPlan(),
        sourceStorageSchemaVersion: 2,
        resultStorageSchemaVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      sqliteVolumeRecoveryPlanV1Schema.safeParse({
        ...recoveryPlan(),
        sourceStorageSchemaVersion: 2,
        resultStorageSchemaVersion: 2,
        requiresMigration: true,
      }).success,
    ).toBe(false);
  });
});
