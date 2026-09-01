import { z } from "./zod.js";

export const SQLITE_VOLUME_BACKUP_FORMAT_VERSION = 1 as const;
export const SQLITE_VOLUME_RECOVERY_PLAN_VERSION = 1 as const;

const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const utcIsoTimestampSchema = z.iso.datetime({ precision: 3 });

export const sqliteVolumeBackupInventorySchema = z
  .object({
    projects: nonnegativeSafeIntegerSchema,
    schemaRevisions: nonnegativeSafeIntegerSchema,
    diagramLayouts: nonnegativeSafeIntegerSchema,
    importArtifacts: nonnegativeSafeIntegerSchema,
    visualCommandReceipts: nonnegativeSafeIntegerSchema,
    appMetadata: nonnegativeSafeIntegerSchema,
    drizzleMigrations: nonnegativeSafeIntegerSchema,
  })
  .strict();
export type SqliteVolumeBackupInventory = z.infer<typeof sqliteVolumeBackupInventorySchema>;

export const sqliteVolumeBackupManifestV1Schema = z
  .object({
    format: z.literal("ER_DIAGRAM_SQLITE_VOLUME_BACKUP"),
    backupFormatVersion: z.literal(SQLITE_VOLUME_BACKUP_FORMAT_VERSION),
    backupHash: sha256HexSchema,
    createdAt: utcIsoTimestampSchema,
    database: z
      .object({
        path: z.literal("database.sqlite"),
        bytes: positiveSafeIntegerSchema,
        sha256: sha256HexSchema,
        storageSchemaVersion: positiveSafeIntegerSchema,
        migrationHistoryHash: sha256HexSchema,
        sqliteVersion: z.string().min(1),
        pageSize: positiveSafeIntegerSchema,
        pageCount: positiveSafeIntegerSchema,
      })
      .strict(),
    inventory: sqliteVolumeBackupInventorySchema,
  })
  .strict();
export type SqliteVolumeBackupManifestV1 = z.infer<typeof sqliteVolumeBackupManifestV1Schema>;

export const sqliteVolumeRecoveryPlanV1Schema = z
  .object({
    planVersion: z.literal(SQLITE_VOLUME_RECOVERY_PLAN_VERSION),
    operation: z.enum(["RESTORE", "MIGRATE"]),
    sourceBackupHash: sha256HexSchema,
    targetPathHash: sha256HexSchema,
    expectedTargetDatabaseSha256: sha256HexSchema.nullable(),
    sourceStorageSchemaVersion: positiveSafeIntegerSchema,
    resultStorageSchemaVersion: positiveSafeIntegerSchema,
    bundledMigrationSetHash: sha256HexSchema,
    requiresMigration: z.boolean(),
    candidateDatabaseSha256: sha256HexSchema,
    planHash: sha256HexSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.sourceStorageSchemaVersion > plan.resultStorageSchemaVersion) {
      context.addIssue({
        code: "custom",
        message: "A recovery plan cannot downgrade the storage schema.",
        path: ["resultStorageSchemaVersion"],
      });
    }
    if (
      plan.requiresMigration !==
      (plan.sourceStorageSchemaVersion !== plan.resultStorageSchemaVersion)
    ) {
      context.addIssue({
        code: "custom",
        message: "requiresMigration must match the storage schema version transition.",
        path: ["requiresMigration"],
      });
    }
  });
export type SqliteVolumeRecoveryPlanV1 = z.infer<typeof sqliteVolumeRecoveryPlanV1Schema>;
