import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

import { openSqliteStorage, SQLITE_STORAGE_SCHEMA_VERSION } from "./sqlite-storage.js";
import { createSqliteVolumeBackup, fsyncDirectory } from "./volume-backup.js";
import { acquireSqliteVolumeLock } from "./volume-lock.js";
import {
  type ApplySqliteVolumeMigrationOptions,
  type ApplySqliteVolumeRestoreOptions,
  type PlanSqliteVolumeMigrationOptions,
  type PlanSqliteVolumeRestoreOptions,
  SQLITE_VOLUME_RECOVERY_PLAN_VERSION,
  SqliteVolumeRecoveryError,
  type SqliteVolumeRecoveryPlanV1,
  type SqliteVolumeRecoveryResult,
} from "./volume-recovery-types.js";
import {
  bundledMigrationSetHash,
  computeRecoveryPlanHash,
  recoveryError,
  sha256Utf8,
  type ValidatedSqliteVolumeBackup,
  type ValidatedSqliteVolumeDatabase,
  validateSqliteVolumeBackup,
  validateSqliteVolumeDatabase,
} from "./volume-recovery-validation.js";

interface PreparedRecovery {
  readonly plan: SqliteVolumeRecoveryPlanV1;
  readonly candidateDirectory: string;
  readonly candidatePath: string;
  readonly backup: ValidatedSqliteVolumeBackup;
}

export async function planSqliteVolumeRestore(
  options: PlanSqliteVolumeRestoreOptions,
): Promise<SqliteVolumeRecoveryPlanV1> {
  const targetPath = normalizeTargetPath(options.database);
  const prepared = await prepareRestore(options.backup, targetPath, "RESTORE", tmpdir());
  try {
    return prepared.plan;
  } finally {
    rmSync(prepared.candidateDirectory, { force: true, recursive: true });
  }
}

export async function applySqliteVolumeRestore(
  options: ApplySqliteVolumeRestoreOptions,
): Promise<SqliteVolumeRecoveryResult> {
  const targetPath = normalizeTargetPath(options.database);
  const targetExists = existsSync(targetPath);
  if (targetExists && options.safetyBackupOutput === undefined) {
    throw recoveryError(
      "SQLITE_VOLUME_INVALID_PATH",
      "Existing SQLite targets require an explicit safety backup output.",
    );
  }
  const prepared = await prepareRestore(
    options.backup,
    targetPath,
    "RESTORE",
    path.dirname(targetPath),
  );
  let volumeLock: ReturnType<typeof acquireSqliteVolumeLock> | undefined;
  let safetyBackup = null;
  try {
    volumeLock = acquireSqliteVolumeLock(targetPath);
    assertPlanHash(prepared.plan, options.planHash);
    if (targetExists) {
      assertOfflineTarget(targetPath);
      const expected = prepared.plan.expectedTargetDatabaseSha256;
      if (expected === null) return planConflict();
      const safety = await createSqliteVolumeBackup({
        database: targetPath,
        output: options.safetyBackupOutput as string,
      });
      safetyBackup = safety.manifest;
      if (safety.manifest.database.sha256 !== expected) return planConflict();
    } else if (prepared.plan.expectedTargetDatabaseSha256 !== null || existsSync(targetPath)) {
      return planConflict();
    }
    await atomicallyReplaceDatabase(
      targetPath,
      prepared.candidatePath,
      prepared.plan.candidateDatabaseSha256,
      targetExists,
    );
    return { applied: true, plan: prepared.plan, safetyBackup };
  } finally {
    volumeLock?.release();
    rmSync(prepared.candidateDirectory, { force: true, recursive: true });
  }
}

export async function planSqliteVolumeMigration(
  options: PlanSqliteVolumeMigrationOptions,
): Promise<SqliteVolumeRecoveryPlanV1> {
  const targetPath = normalizeExistingTargetPath(options.database);
  const target = await ephemeralSnapshot(targetPath);
  if (target.storageSchemaVersion === SQLITE_STORAGE_SCHEMA_VERSION) {
    return createPlan({
      operation: "MIGRATE",
      sourceBackupHash: target.sha256,
      targetPath,
      expectedTargetDatabaseSha256: target.sha256,
      sourceStorageSchemaVersion: target.storageSchemaVersion,
      candidateDatabaseSha256: target.sha256,
    });
  }
  const backup = await createSqliteVolumeBackup({
    database: targetPath,
    output: options.backupOutput,
  });
  const prepared = await prepareRestore(options.backupOutput, targetPath, "MIGRATE", tmpdir());
  try {
    if (prepared.plan.expectedTargetDatabaseSha256 !== backup.manifest.database.sha256) {
      return planConflict();
    }
    return prepared.plan;
  } finally {
    rmSync(prepared.candidateDirectory, { force: true, recursive: true });
  }
}

export async function applySqliteVolumeMigration(
  options: ApplySqliteVolumeMigrationOptions,
): Promise<SqliteVolumeRecoveryResult> {
  const targetPath = normalizeExistingTargetPath(options.database);
  const volumeLock = acquireSqliteVolumeLock(targetPath);
  try {
    const current = await ephemeralSnapshot(targetPath);
    if (current.storageSchemaVersion === SQLITE_STORAGE_SCHEMA_VERSION) {
      const plan = createPlan({
        operation: "MIGRATE",
        sourceBackupHash: current.sha256,
        targetPath,
        expectedTargetDatabaseSha256: current.sha256,
        sourceStorageSchemaVersion: current.storageSchemaVersion,
        candidateDatabaseSha256: current.sha256,
      });
      assertPlanHash(plan, options.planHash);
      return { applied: false, plan, safetyBackup: null };
    }

    const prepared = await prepareRestore(
      options.backupOutput,
      targetPath,
      "MIGRATE",
      path.dirname(targetPath),
    );
    try {
      assertPlanHash(prepared.plan, options.planHash);
      assertOfflineTarget(targetPath);
      const afterLock = await ephemeralSnapshot(targetPath);
      if (
        afterLock.sha256 !== prepared.plan.expectedTargetDatabaseSha256 ||
        afterLock.sha256 !== prepared.backup.manifest.database.sha256
      ) {
        return planConflict();
      }
      await atomicallyReplaceDatabase(
        targetPath,
        prepared.candidatePath,
        prepared.plan.candidateDatabaseSha256,
        true,
      );
      return {
        applied: true,
        plan: prepared.plan,
        safetyBackup: prepared.backup.manifest,
      };
    } finally {
      rmSync(prepared.candidateDirectory, { force: true, recursive: true });
    }
  } finally {
    volumeLock.release();
  }
}

async function prepareRestore(
  backupDirectory: string,
  targetPath: string,
  operation: "RESTORE" | "MIGRATE",
  stagingParent: string,
): Promise<PreparedRecovery> {
  const backup = await validateSqliteVolumeBackup(path.resolve(backupDirectory));
  const candidateDirectory = mkdtempSync(
    path.join(stagingParent, `.er-diagram-${operation.toLowerCase()}-candidate-`),
  );
  chmodSync(candidateDirectory, 0o700);
  const candidatePath = path.join(candidateDirectory, "database.sqlite");
  try {
    copyFileSync(backup.databasePath, candidatePath, constants.COPYFILE_EXCL);
    chmodSync(candidatePath, 0o600);
    if (backup.database.storageSchemaVersion < SQLITE_STORAGE_SCHEMA_VERSION) {
      migrateCandidate(candidatePath);
    }
    normalizeStandaloneDatabase(candidatePath);
    fsyncFile(candidatePath);
    fsyncDirectory(candidateDirectory);
    const candidate = await validateSqliteVolumeDatabase(candidatePath);
    if (candidate.storageSchemaVersion !== SQLITE_STORAGE_SCHEMA_VERSION) {
      throw recoveryError(
        "SQLITE_VOLUME_MIGRATION_FAILED",
        "SQLite recovery candidate did not reach the current storage schema.",
      );
    }
    const target = existsSync(targetPath) ? await ephemeralSnapshot(targetPath) : null;
    const plan = createPlan({
      operation,
      sourceBackupHash: backup.manifest.backupHash,
      targetPath,
      expectedTargetDatabaseSha256: target?.sha256 ?? null,
      sourceStorageSchemaVersion: backup.database.storageSchemaVersion,
      candidateDatabaseSha256: candidate.sha256,
    });
    return { plan, candidateDirectory, candidatePath, backup };
  } catch (error) {
    rmSync(candidateDirectory, { force: true, recursive: true });
    if (error instanceof SqliteVolumeRecoveryError) throw error;
    throw recoveryError(
      "SQLITE_VOLUME_MIGRATION_FAILED",
      "SQLite recovery candidate preparation failed.",
      error,
    );
  }
}

function createPlan(input: {
  readonly operation: "RESTORE" | "MIGRATE";
  readonly sourceBackupHash: string;
  readonly targetPath: string;
  readonly expectedTargetDatabaseSha256: string | null;
  readonly sourceStorageSchemaVersion: number;
  readonly candidateDatabaseSha256: string;
}): SqliteVolumeRecoveryPlanV1 {
  const withoutPlanHash = {
    planVersion: SQLITE_VOLUME_RECOVERY_PLAN_VERSION,
    operation: input.operation,
    sourceBackupHash: input.sourceBackupHash,
    targetPathHash: sha256Utf8(normalizedPathEvidence(input.targetPath)),
    expectedTargetDatabaseSha256: input.expectedTargetDatabaseSha256,
    sourceStorageSchemaVersion: input.sourceStorageSchemaVersion,
    resultStorageSchemaVersion: SQLITE_STORAGE_SCHEMA_VERSION,
    bundledMigrationSetHash: bundledMigrationSetHash(),
    requiresMigration: input.sourceStorageSchemaVersion !== SQLITE_STORAGE_SCHEMA_VERSION,
    candidateDatabaseSha256: input.candidateDatabaseSha256,
  } as const;
  return { ...withoutPlanHash, planHash: computeRecoveryPlanHash(withoutPlanHash) };
}

async function ephemeralSnapshot(filename: string): Promise<ValidatedSqliteVolumeDatabase> {
  const root = mkdtempSync(path.join(tmpdir(), "er-diagram-volume-snapshot-"));
  chmodSync(root, 0o700);
  const output = path.join(root, "snapshot");
  try {
    await createSqliteVolumeBackup({ database: filename, output });
    const databasePath = path.join(output, "database.sqlite");
    return await validateSqliteVolumeDatabase(databasePath);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function migrateCandidate(filename: string): void {
  try {
    const storage = openSqliteStorage({ filename });
    storage.close();
  } catch (error) {
    throw recoveryError(
      "SQLITE_VOLUME_MIGRATION_FAILED",
      "SQLite recovery candidate migration failed.",
      error,
    );
  }
}

function normalizeStandaloneDatabase(filename: string): void {
  const database = new BetterSqlite3(filename, { fileMustExist: true });
  try {
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.pragma("journal_mode = DELETE");
  } finally {
    database.close();
  }
  rmSync(`${filename}-wal`, { force: true });
  rmSync(`${filename}-shm`, { force: true });
}

function assertOfflineTarget(filename: string): void {
  let database: BetterSqlite3.Database | undefined;
  try {
    database = new BetterSqlite3(filename, { fileMustExist: true, timeout: 0 });
    database.pragma("busy_timeout = 0");
    const checkpoint = database.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy: number;
    }>;
    if ((checkpoint[0]?.busy ?? 1) !== 0) targetBusy();
    database.exec("BEGIN EXCLUSIVE");
    database.exec("ROLLBACK");
  } catch (error) {
    if (database?.inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original lock failure.
      }
    }
    if (error instanceof SqliteVolumeRecoveryError) throw error;
    targetBusy(error);
  } finally {
    if (database?.open) database.close();
  }
}

async function atomicallyReplaceDatabase(
  targetPath: string,
  candidatePath: string,
  expectedCandidateHash: string,
  targetExists: boolean,
): Promise<void> {
  const parent = path.dirname(targetPath);
  const rollbackPath = `${targetPath}.rollback-${process.pid}-${Date.now()}`;
  const rollbackWal = `${rollbackPath}-wal`;
  const rollbackShm = `${rollbackPath}-shm`;
  const targetWal = `${targetPath}-wal`;
  const targetShm = `${targetPath}-shm`;
  let oldMoved = false;
  let candidateMoved = false;
  try {
    if (targetExists) {
      renameSync(targetPath, rollbackPath);
      oldMoved = true;
      if (existsSync(targetWal)) renameSync(targetWal, rollbackWal);
      if (existsSync(targetShm)) renameSync(targetShm, rollbackShm);
    }
    renameSync(candidatePath, targetPath);
    candidateMoved = true;
    fsyncDirectory(parent);
    const validated = await validateSqliteVolumeDatabase(targetPath);
    if (
      validated.storageSchemaVersion !== SQLITE_STORAGE_SCHEMA_VERSION ||
      validated.sha256 !== expectedCandidateHash
    ) {
      throw recoveryError(
        "SQLITE_VOLUME_ATOMIC_APPLY_FAILED",
        "Applied SQLite recovery candidate failed read-back validation.",
      );
    }
    if (oldMoved) {
      rmSync(rollbackPath, { force: true });
      rmSync(rollbackWal, { force: true });
      rmSync(rollbackShm, { force: true });
      fsyncDirectory(parent);
    }
  } catch (error) {
    try {
      if (candidateMoved && existsSync(targetPath)) rmSync(targetPath, { force: true });
      rmSync(targetWal, { force: true });
      rmSync(targetShm, { force: true });
      if (oldMoved && existsSync(rollbackPath)) {
        renameSync(rollbackPath, targetPath);
        if (existsSync(rollbackWal)) renameSync(rollbackWal, targetWal);
        if (existsSync(rollbackShm)) renameSync(rollbackShm, targetShm);
        fsyncDirectory(parent);
        await validateSqliteVolumeDatabase(targetPath);
      }
    } catch (rollbackError) {
      throw recoveryError(
        "SQLITE_VOLUME_ATOMIC_APPLY_FAILED",
        "SQLite recovery failed and the original target could not be restored automatically.",
        rollbackError,
      );
    }
    if (error instanceof SqliteVolumeRecoveryError) throw error;
    throw recoveryError(
      "SQLITE_VOLUME_ATOMIC_APPLY_FAILED",
      "SQLite recovery candidate could not be applied atomically.",
      error,
    );
  }
}

function normalizeTargetPath(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw recoveryError("SQLITE_VOLUME_INVALID_PATH", "SQLite target path is invalid.");
  }
  const resolved = path.resolve(value);
  const parent = path.dirname(resolved);
  let parentStat: ReturnType<typeof lstatSync>;
  try {
    parentStat = lstatSync(parent);
  } catch (error) {
    throw recoveryError("SQLITE_VOLUME_INVALID_PATH", "SQLite target parent is invalid.", error);
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw recoveryError(
      "SQLITE_VOLUME_INVALID_PATH",
      "SQLite target parent must be a real directory.",
    );
  }
  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw recoveryError("SQLITE_VOLUME_INVALID_PATH", "SQLite target must be a regular file.");
    }
  }
  return resolved;
}

function normalizeExistingTargetPath(value: string): string {
  const resolved = normalizeTargetPath(value);
  if (!existsSync(resolved)) {
    throw recoveryError("SQLITE_VOLUME_INVALID_PATH", "SQLite migration target does not exist.");
  }
  return resolved;
}

function normalizedPathEvidence(value: string): string {
  return path.normalize(path.resolve(value)).normalize("NFC");
}

function assertPlanHash(plan: SqliteVolumeRecoveryPlanV1, expected: string): void {
  if (!/^[0-9a-f]{64}$/u.test(expected) || plan.planHash !== expected) planConflict();
}

function planConflict(): never {
  throw recoveryError(
    "SQLITE_VOLUME_RECOVERY_PLAN_CONFLICT",
    "SQLite recovery evidence changed after dry-run; generate a new plan.",
  );
}

function targetBusy(cause?: unknown): never {
  throw recoveryError(
    "SQLITE_VOLUME_TARGET_BUSY",
    "SQLite target is busy; stop the server before applying recovery.",
    cause,
  );
}

function fsyncFile(filename: string): void {
  const descriptor = openSync(filename, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
