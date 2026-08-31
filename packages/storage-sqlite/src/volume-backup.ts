import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import BetterSqlite3, { type Database as BetterSqliteDatabase } from "better-sqlite3";

import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite-storage.js";
import {
  type CreateSqliteVolumeBackupOptions,
  SQLITE_VOLUME_BACKUP_FORMAT_VERSION,
  type SqliteVolumeBackupManifestV1,
  type SqliteVolumeBackupResult,
  SqliteVolumeRecoveryError,
} from "./volume-recovery-types.js";
import {
  canonicalSqliteVolumeJsonFile,
  computeBackupHash,
  recoveryError,
  validateSqliteVolumeBackup,
  validateSqliteVolumeDatabase,
} from "./volume-recovery-validation.js";

const DATABASE_FILENAME = "database.sqlite";
const MANIFEST_FILENAME = "manifest.json";

export async function createSqliteVolumeBackup(
  options: CreateSqliteVolumeBackupOptions,
): Promise<SqliteVolumeBackupResult> {
  const sourcePath = normalizeDatabasePath(options.database);
  const outputPath = normalizeOutputPath(options.output);
  assertDestinationAbsent(outputPath);
  const parent = path.dirname(outputPath);
  assertParentDirectory(parent);
  const staging = mkdtempSync(path.join(parent, `.${path.basename(outputPath)}.staging-`));
  chmodSync(staging, 0o700);
  const databasePath = path.join(staging, DATABASE_FILENAME);
  let committed = false;
  let source: BetterSqliteDatabase | undefined;
  try {
    source = new BetterSqlite3(sourcePath, {
      fileMustExist: true,
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
    source.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    await source.backup(databasePath);
    source.close();
    source = undefined;
    normalizeStandaloneSnapshot(databasePath);
    chmodSync(databasePath, 0o600);

    const database = await validateSqliteVolumeDatabase(databasePath);
    const withoutBackupHash: Omit<SqliteVolumeBackupManifestV1, "backupHash"> = {
      format: "ER_DIAGRAM_SQLITE_VOLUME_BACKUP" as const,
      backupFormatVersion: SQLITE_VOLUME_BACKUP_FORMAT_VERSION,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      database: {
        path: DATABASE_FILENAME,
        bytes: database.bytes,
        sha256: database.sha256,
        storageSchemaVersion: database.storageSchemaVersion,
        migrationHistoryHash: database.migrationHistoryHash,
        sqliteVersion: database.sqliteVersion,
        pageSize: database.pageSize,
        pageCount: database.pageCount,
      },
      inventory: database.inventory,
    };
    const manifest: SqliteVolumeBackupManifestV1 = {
      ...withoutBackupHash,
      backupHash: computeBackupHash(withoutBackupHash),
    };
    const manifestPath = path.join(staging, MANIFEST_FILENAME);
    writeFileSync(manifestPath, canonicalSqliteVolumeJsonFile(manifest), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(manifestPath, 0o600);
    fsyncFile(databasePath);
    fsyncFile(manifestPath);
    fsyncDirectory(staging);
    await validateSqliteVolumeBackup(staging);
    assertDestinationAbsent(outputPath);
    renameSync(staging, outputPath);
    fsyncDirectory(parent);
    committed = true;
    return { output: outputPath, manifest };
  } catch (error) {
    if (error instanceof SqliteVolumeRecoveryError) throw error;
    throw recoveryError(
      "SQLITE_VOLUME_BACKUP_FAILED",
      "SQLite online volume backup failed.",
      error,
    );
  } finally {
    if (source?.open) source.close();
    if (!committed) rmSync(staging, { force: true, recursive: true });
  }
}

function normalizeStandaloneSnapshot(filename: string): void {
  const snapshot = new BetterSqlite3(filename, { fileMustExist: true });
  try {
    snapshot.pragma("wal_checkpoint(TRUNCATE)");
    snapshot.pragma("journal_mode = DELETE");
  } finally {
    snapshot.close();
  }
}

function normalizeDatabasePath(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw recoveryError("SQLITE_VOLUME_INVALID_PATH", "SQLite database path is invalid.");
  }
  const resolved = path.resolve(value);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(resolved);
  } catch (error) {
    throw recoveryError("SQLITE_VOLUME_INVALID_PATH", "SQLite database path is invalid.", error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw recoveryError("SQLITE_VOLUME_INVALID_PATH", "SQLite database must be a regular file.");
  }
  return resolved;
}

function normalizeOutputPath(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw recoveryError("SQLITE_VOLUME_INVALID_PATH", "SQLite backup output path is invalid.");
  }
  const resolved = path.resolve(value);
  if (path.basename(resolved) === "." || path.basename(resolved) === path.parse(resolved).root) {
    throw recoveryError("SQLITE_VOLUME_INVALID_PATH", "SQLite backup output path is invalid.");
  }
  return resolved;
}

function assertDestinationAbsent(destination: string): void {
  if (existsSync(destination)) {
    throw recoveryError(
      "SQLITE_VOLUME_DESTINATION_EXISTS",
      "SQLite backup destination already exists.",
    );
  }
}

function assertParentDirectory(parent: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(parent);
  } catch (error) {
    throw recoveryError(
      "SQLITE_VOLUME_INVALID_PATH",
      "SQLite backup parent path is invalid.",
      error,
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw recoveryError(
      "SQLITE_VOLUME_INVALID_PATH",
      "SQLite backup parent must be a real directory.",
    );
  }
}

function fsyncFile(filename: string): void {
  const descriptor = openSync(filename, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
