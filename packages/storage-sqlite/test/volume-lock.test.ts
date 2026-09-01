import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireSqliteVolumeLock,
  applySqliteVolumeMigration,
  applySqliteVolumeRestore,
  createSqliteVolumeBackup,
  openSqliteStorage,
  planSqliteVolumeMigration,
  planSqliteVolumeRestore,
  type SqliteVolumeRecoveryError,
} from "../src/index.js";

const temporaryDirectories = new Set<string>();

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "er-diagram-volume-lock-"));
  temporaryDirectories.add(directory);
  return path.join(directory, "database.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

describe("SQLite volume lifecycle lock", () => {
  it("holds one crash-safe exclusive lease per database path", () => {
    const database = temporaryDatabasePath();
    const first = acquireSqliteVolumeLock(database);

    expect(first.isHeld()).toBe(true);
    expect(lstatSync(`${database}.lock`).mode & 0o777).toBe(0o600);
    expect(() => acquireSqliteVolumeLock(database)).toThrowError(
      expect.objectContaining<Partial<SqliteVolumeRecoveryError>>({
        code: "SQLITE_VOLUME_LOCKED",
      }),
    );

    first.release();
    expect(first.isHeld()).toBe(false);
    expect(() => first.release()).not.toThrow();

    const second = acquireSqliteVolumeLock(database);
    expect(second.isHeld()).toBe(true);
    second.release();
  });

  it("fails closed for symlink and permissive lock sidecars", () => {
    const symlinkDatabase = temporaryDatabasePath();
    symlinkSync(path.basename(symlinkDatabase), `${symlinkDatabase}.lock`);
    expect(() => acquireSqliteVolumeLock(symlinkDatabase)).toThrowError(
      expect.objectContaining<Partial<SqliteVolumeRecoveryError>>({
        code: "SQLITE_VOLUME_LOCK_FAILED",
      }),
    );

    const permissiveDatabase = temporaryDatabasePath();
    const permissive = acquireSqliteVolumeLock(permissiveDatabase);
    permissive.release();
    chmodSync(`${permissiveDatabase}.lock`, 0o644);
    expect(() => acquireSqliteVolumeLock(permissiveDatabase)).toThrowError(
      expect.objectContaining<Partial<SqliteVolumeRecoveryError>>({
        code: "SQLITE_VOLUME_LOCK_FAILED",
      }),
    );
  });

  it("blocks offline migration apply while a production lease is held", async () => {
    const database = temporaryDatabasePath();
    openSqliteStorage({ filename: database }).close();
    const backupOutput = path.join(path.dirname(database), "unused-backup");
    const plan = await planSqliteVolumeMigration({ database, backupOutput });
    const production = acquireSqliteVolumeLock(database);

    try {
      await expect(
        applySqliteVolumeMigration({ database, backupOutput, planHash: plan.planHash }),
      ).rejects.toMatchObject({ code: "SQLITE_VOLUME_LOCKED" });
    } finally {
      production.release();
    }
  });

  it("blocks offline restore apply while a production lease is held", async () => {
    const source = temporaryDatabasePath();
    openSqliteStorage({ filename: source }).close();
    const backup = path.join(path.dirname(source), "restore-backup");
    await createSqliteVolumeBackup({ database: source, output: backup });

    const target = temporaryDatabasePath();
    openSqliteStorage({ filename: target }).close();
    const plan = await planSqliteVolumeRestore({ backup, database: target });
    const production = acquireSqliteVolumeLock(target);

    try {
      await expect(
        applySqliteVolumeRestore({
          backup,
          database: target,
          planHash: plan.planHash,
          safetyBackupOutput: path.join(path.dirname(target), "restore-safety"),
        }),
      ).rejects.toMatchObject({ code: "SQLITE_VOLUME_LOCKED" });
    } finally {
      production.release();
    }
  });

  it("allows online backup and recovery dry-run while the production lease is held", async () => {
    const database = temporaryDatabasePath();
    openSqliteStorage({ filename: database }).close();
    const backup = path.join(path.dirname(database), "online-backup");
    const production = acquireSqliteVolumeLock(database);

    try {
      await expect(createSqliteVolumeBackup({ database, output: backup })).resolves.toMatchObject({
        manifest: { database: { storageSchemaVersion: 2 } },
      });
      await expect(planSqliteVolumeRestore({ backup, database })).resolves.toMatchObject({
        operation: "RESTORE",
      });
    } finally {
      production.release();
    }
  });

  it("releases the operating-system lease after an owning process crashes", async () => {
    const database = temporaryDatabasePath();
    const initialized = acquireSqliteVolumeLock(database);
    initialized.release();
    const modulePath = createRequire(import.meta.url).resolve("better-sqlite3");
    const owner = spawn(
      process.execPath,
      [
        "-e",
        `
        const Database = require(${JSON.stringify(modulePath)});
        const database = new Database(${JSON.stringify(`${database}.lock`)}, { timeout: 0 });
        database.pragma("busy_timeout = 0");
        database.exec("BEGIN EXCLUSIVE");
        process.stdout.write("LOCKED\\n");
        setInterval(() => undefined, 1_000);
      `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise<void>((resolve, reject) => {
      let output = "";
      owner.stdout.setEncoding("utf8");
      owner.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("LOCKED\n")) resolve();
      });
      owner.once("error", reject);
      owner.once("exit", (code) => {
        if (!output.includes("LOCKED\n")) reject(new Error(`Lock owner exited early: ${code}`));
      });
    });

    expect(() => acquireSqliteVolumeLock(database)).toThrowError(
      expect.objectContaining({ code: "SQLITE_VOLUME_LOCKED" }),
    );
    owner.kill("SIGKILL");
    await new Promise<void>((resolve, reject) => {
      owner.once("exit", () => resolve());
      owner.once("error", reject);
    });

    const recovered = acquireSqliteVolumeLock(database);
    expect(recovered.isHeld()).toBe(true);
    recovered.release();
  });
});
