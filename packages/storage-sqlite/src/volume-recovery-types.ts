export const SQLITE_VOLUME_BACKUP_FORMAT_VERSION = 1 as const;
export const SQLITE_VOLUME_RECOVERY_PLAN_VERSION = 1 as const;

export interface SqliteVolumeBackupInventory {
  readonly projects: number;
  readonly schemaRevisions: number;
  readonly diagramLayouts: number;
  readonly importArtifacts: number;
  readonly visualCommandReceipts: number;
  readonly appMetadata: number;
  readonly drizzleMigrations: number;
}

export interface SqliteVolumeBackupManifestV1 {
  readonly format: "ER_DIAGRAM_SQLITE_VOLUME_BACKUP";
  readonly backupFormatVersion: 1;
  readonly backupHash: string;
  readonly createdAt: string;
  readonly database: {
    readonly path: "database.sqlite";
    readonly bytes: number;
    readonly sha256: string;
    readonly storageSchemaVersion: number;
    readonly migrationHistoryHash: string;
    readonly sqliteVersion: string;
    readonly pageSize: number;
    readonly pageCount: number;
  };
  readonly inventory: SqliteVolumeBackupInventory;
}

export interface SqliteVolumeRecoveryPlanV1 {
  readonly planVersion: 1;
  readonly operation: "RESTORE" | "MIGRATE";
  readonly sourceBackupHash: string;
  readonly targetPathHash: string;
  readonly expectedTargetDatabaseSha256: string | null;
  readonly sourceStorageSchemaVersion: number;
  readonly resultStorageSchemaVersion: number;
  readonly bundledMigrationSetHash: string;
  readonly requiresMigration: boolean;
  readonly candidateDatabaseSha256: string;
  readonly planHash: string;
}

export type SqliteVolumeRecoveryErrorCode =
  | "SQLITE_VOLUME_INVALID_PATH"
  | "SQLITE_VOLUME_BACKUP_INVALID"
  | "SQLITE_VOLUME_CHECKSUM_MISMATCH"
  | "SQLITE_VOLUME_SCHEMA_UNSUPPORTED"
  | "SQLITE_VOLUME_DESTINATION_EXISTS"
  | "SQLITE_VOLUME_TARGET_BUSY"
  | "SQLITE_VOLUME_RECOVERY_PLAN_CONFLICT"
  | "SQLITE_VOLUME_INTEGRITY_FAILED"
  | "SQLITE_VOLUME_MIGRATION_FAILED"
  | "SQLITE_VOLUME_ATOMIC_APPLY_FAILED"
  | "SQLITE_VOLUME_BACKUP_FAILED";

export class SqliteVolumeRecoveryError extends Error {
  readonly code: SqliteVolumeRecoveryErrorCode;
  override readonly cause: unknown;

  constructor(code: SqliteVolumeRecoveryErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "SqliteVolumeRecoveryError";
    this.code = code;
    this.cause = cause;
  }
}

export interface CreateSqliteVolumeBackupOptions {
  readonly database: string;
  readonly output: string;
  readonly now?: () => Date;
}

export interface PlanSqliteVolumeRestoreOptions {
  readonly backup: string;
  readonly database: string;
}

export interface ApplySqliteVolumeRestoreOptions extends PlanSqliteVolumeRestoreOptions {
  readonly planHash: string;
  readonly safetyBackupOutput?: string;
}

export interface PlanSqliteVolumeMigrationOptions {
  readonly database: string;
  readonly backupOutput: string;
}

export interface ApplySqliteVolumeMigrationOptions extends PlanSqliteVolumeMigrationOptions {
  readonly planHash: string;
}

export interface SqliteVolumeBackupResult {
  readonly output: string;
  readonly manifest: SqliteVolumeBackupManifestV1;
}

export interface SqliteVolumeRecoveryResult {
  readonly applied: boolean;
  readonly plan: SqliteVolumeRecoveryPlanV1;
  readonly safetyBackup: SqliteVolumeBackupManifestV1 | null;
}
