import { fileURLToPath } from "node:url";
import BetterSqlite3, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { sqliteSchema } from "./schema.js";

export const SQLITE_STORAGE_SCHEMA_VERSION = 2;
export const APP_METADATA_STORAGE_SCHEMA_VERSION_KEY = "storage_schema_version";
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));
const WRITE_PROBE_KEY = "__er_diagram_write_probe__";

export type SqliteStorageErrorCode =
  | "SQLITE_INVALID_PATH"
  | "SQLITE_OPEN_FAILED"
  | "SQLITE_PRAGMA_FAILED"
  | "SQLITE_MIGRATION_FAILED"
  | "SQLITE_SCHEMA_VERSION_UNSUPPORTED"
  | "SQLITE_NOT_WRITABLE"
  | "SQLITE_PROJECT_DATA_INVALID"
  | "SQLITE_ASYNC_TRANSACTION_UNSUPPORTED";

export class SqliteStorageError extends Error {
  readonly code: SqliteStorageErrorCode;
  override readonly cause: unknown;

  constructor(code: SqliteStorageErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "SqliteStorageError";
    this.code = code;
    this.cause = cause;
  }
}

export interface OpenSqliteStorageOptions {
  readonly filename: string;
}

export interface InitializeSqliteStorageOptions {
  readonly migrationsFolder?: string;
}

export type SqliteDatabase = BetterSQLite3Database<typeof sqliteSchema>;
export type SqliteTransaction = Parameters<Parameters<SqliteDatabase["transaction"]>[0]>[0];

export interface SqliteStorage {
  readonly database: SqliteDatabase;
  transaction<T>(operation: (transaction: SqliteTransaction) => T): T;
  close(): void;
}

function nativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function storageError(
  fallbackCode: SqliteStorageErrorCode,
  message: string,
  cause: unknown,
): SqliteStorageError {
  if (cause instanceof SqliteStorageError) return cause;
  const nativeCode = nativeErrorCode(cause);
  if (nativeCode?.startsWith("SQLITE_READONLY")) {
    return new SqliteStorageError("SQLITE_NOT_WRITABLE", "SQLite database is not writable", cause);
  }
  return new SqliteStorageError(fallbackCode, message, cause);
}

function assertDurableFilename(filename: string): void {
  const normalized = filename.trim().toLowerCase();
  const isMemoryUri =
    normalized.startsWith("file:") &&
    (normalized.includes(":memory:") || normalized.includes("mode=memory"));
  if (normalized.length === 0 || normalized === ":memory:" || isMemoryUri) {
    throw new SqliteStorageError(
      "SQLITE_INVALID_PATH",
      "SQLite storage requires a durable file-backed database path",
    );
  }
}

function configureConnection(client: BetterSqliteDatabase): void {
  try {
    client.pragma("foreign_keys = ON");
    client.pragma("journal_mode = WAL");
    client.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

    const foreignKeys = Number(client.pragma("foreign_keys", { simple: true }));
    const journalMode = String(client.pragma("journal_mode", { simple: true })).toLowerCase();
    const busyTimeout = Number(client.pragma("busy_timeout", { simple: true }));
    if (foreignKeys !== 1 || journalMode !== "wal" || busyTimeout !== SQLITE_BUSY_TIMEOUT_MS) {
      throw new Error(
        `Unexpected SQLite PRAGMA state: foreign_keys=${foreignKeys}, journal_mode=${journalMode}, busy_timeout=${busyTimeout}`,
      );
    }
  } catch (error) {
    throw storageError("SQLITE_PRAGMA_FAILED", "Failed to configure SQLite connection", error);
  }
}

function validateMigratedDatabase(client: BetterSqliteDatabase): void {
  try {
    const metadata = client
      .prepare<[string], { value: string }>("SELECT value FROM app_metadata WHERE key = ?")
      .get(APP_METADATA_STORAGE_SCHEMA_VERSION_KEY);
    if (metadata?.value !== String(SQLITE_STORAGE_SCHEMA_VERSION)) {
      throw new SqliteStorageError(
        "SQLITE_SCHEMA_VERSION_UNSUPPORTED",
        `Expected SQLite storage schema version ${SQLITE_STORAGE_SCHEMA_VERSION}, received ${metadata?.value ?? "missing"}`,
      );
    }

    const foreignKeyViolations = client.pragma("foreign_key_check") as unknown[];
    const quickCheck = String(client.pragma("quick_check", { simple: true }));
    if (foreignKeyViolations.length > 0 || quickCheck !== "ok") {
      throw new SqliteStorageError(
        "SQLITE_MIGRATION_FAILED",
        "SQLite integrity validation failed after migration",
      );
    }
  } catch (error) {
    throw storageError(
      "SQLITE_MIGRATION_FAILED",
      "Failed to validate migrated SQLite database",
      error,
    );
  }
}

function assertWritable(client: BetterSqliteDatabase): void {
  try {
    client.exec("BEGIN IMMEDIATE");
    client
      .prepare(
        `INSERT INTO app_metadata (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(WRITE_PROBE_KEY, "1");
    client.exec("ROLLBACK");
  } catch (error) {
    if (client.inTransaction) {
      try {
        client.exec("ROLLBACK");
      } catch {
        // Preserve the original write failure.
      }
    }
    throw storageError("SQLITE_NOT_WRITABLE", "SQLite database is not writable", error);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

class OpenSqliteStorage implements SqliteStorage {
  readonly database: SqliteDatabase;
  readonly #client: BetterSqliteDatabase;

  constructor(client: BetterSqliteDatabase, database: SqliteDatabase) {
    this.#client = client;
    this.database = database;
  }

  transaction<T>(operation: (transaction: SqliteTransaction) => T): T {
    return this.database.transaction(
      (transaction) => {
        const result = operation(transaction);
        if (isPromiseLike(result)) {
          throw new SqliteStorageError(
            "SQLITE_ASYNC_TRANSACTION_UNSUPPORTED",
            "SQLite transaction callbacks must be synchronous",
          );
        }
        return result;
      },
      { behavior: "immediate" },
    );
  }

  close(): void {
    if (this.#client.open) this.#client.close();
  }
}

/** @internal Public package consumers should use openSqliteStorage(). */
export function initializeSqliteStorage(
  client: BetterSqliteDatabase,
  options: InitializeSqliteStorageOptions = {},
): SqliteStorage {
  try {
    configureConnection(client);
    const database = drizzle({ client, schema: sqliteSchema });
    try {
      migrate(database, {
        migrationsFolder: options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER,
      });
    } catch (error) {
      throw storageError("SQLITE_MIGRATION_FAILED", "Failed to migrate SQLite database", error);
    }
    validateMigratedDatabase(client);
    assertWritable(client);
    return new OpenSqliteStorage(client, database);
  } catch (error) {
    if (client.open) {
      try {
        client.close();
      } catch {
        // Preserve the initialization failure that triggered cleanup.
      }
    }
    throw error;
  }
}

export function openSqliteStorage(options: OpenSqliteStorageOptions): SqliteStorage {
  assertDurableFilename(options.filename);

  let client: BetterSqliteDatabase;
  try {
    client = new BetterSqlite3(options.filename, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  } catch (error) {
    throw storageError("SQLITE_OPEN_FAILED", "Failed to open SQLite database", error);
  }

  return initializeSqliteStorage(client);
}
