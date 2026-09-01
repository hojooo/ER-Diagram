import { chmodSync, closeSync, constants, lstatSync, openSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

import { SqliteVolumeRecoveryError } from "./volume-recovery-types.js";

export interface SqliteVolumeLock {
  readonly filename: string;
  isHeld(): boolean;
  release(): void;
}

export function acquireSqliteVolumeLock(databaseFilename: string): SqliteVolumeLock {
  const database = normalizeDatabasePath(databaseFilename);
  const filename = `${database}.lock`;
  ensurePrivateRegularLockFile(filename);

  let client: BetterSqlite3.Database | undefined;
  try {
    client = new BetterSqlite3(filename, { fileMustExist: true, timeout: 0 });
    client.pragma("busy_timeout = 0");
    client.pragma("journal_mode = DELETE");
    client.exec(
      "CREATE TABLE IF NOT EXISTS lifecycle_lock (singleton INTEGER PRIMARY KEY CHECK (singleton = 1)) STRICT",
    );
    client.exec("BEGIN EXCLUSIVE");
    return new HeldSqliteVolumeLock(filename, client);
  } catch (error) {
    if (client?.open) client.close();
    if (isLockContention(error)) {
      throw lockError(
        "SQLITE_VOLUME_LOCKED",
        "The SQLite volume is already owned by another process.",
        error,
      );
    }
    throw lockError(
      "SQLITE_VOLUME_LOCK_FAILED",
      "The SQLite volume lifecycle lock could not be acquired.",
      error,
    );
  }
}

class HeldSqliteVolumeLock implements SqliteVolumeLock {
  readonly filename: string;
  readonly #client: BetterSqlite3.Database;
  #held = true;

  constructor(filename: string, client: BetterSqlite3.Database) {
    this.filename = filename;
    this.#client = client;
  }

  isHeld(): boolean {
    return this.#held && this.#client.open && this.#client.inTransaction;
  }

  release(): void {
    if (!this.#held) return;
    this.#held = false;
    try {
      if (this.#client.open && this.#client.inTransaction) this.#client.exec("ROLLBACK");
    } finally {
      if (this.#client.open) this.#client.close();
    }
  }
}

function ensurePrivateRegularLockFile(filename: string): void {
  try {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        filename,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      chmodSync(filename, 0o600);
    } catch (error) {
      if (nativeErrorCode(error) !== "EEXIST") throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }

    const metadata = lstatSync(filename);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("The lifecycle lock sidecar is not a private regular file.");
    }
  } catch (error) {
    throw lockError(
      "SQLITE_VOLUME_LOCK_FAILED",
      "The SQLite volume lifecycle lock is invalid.",
      error,
    );
  }
}

function normalizeDatabasePath(filename: string): string {
  if (filename.trim().length === 0 || filename === ":memory:" || filename.startsWith("file:")) {
    throw lockError(
      "SQLITE_VOLUME_LOCK_FAILED",
      "The SQLite volume lifecycle lock requires a durable database path.",
    );
  }
  return path.resolve(filename);
}

function isLockContention(error: unknown): boolean {
  const code = nativeErrorCode(error);
  return code?.startsWith("SQLITE_BUSY") === true || code?.startsWith("SQLITE_LOCKED") === true;
}

function nativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function lockError(
  code: "SQLITE_VOLUME_LOCKED" | "SQLITE_VOLUME_LOCK_FAILED",
  message: string,
  cause?: unknown,
): SqliteVolumeRecoveryError {
  return new SqliteVolumeRecoveryError(code, message, cause);
}
