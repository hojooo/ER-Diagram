#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  applySqliteVolumeMigration,
  applySqliteVolumeRestore,
  canonicalSqliteVolumeJsonFile,
  createSqliteVolumeBackup,
  planSqliteVolumeMigration,
  planSqliteVolumeRestore,
  SqliteVolumeRecoveryError,
} from "@er-diagram/storage-sqlite";

interface RecoveryCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

const processIo: RecoveryCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

export async function runVolumeRecoveryCli(
  argv: readonly string[],
  io: RecoveryCliIo = processIo,
): Promise<number> {
  try {
    const [operation, ...args] = argv;
    if (operation === "backup") {
      const values = parseCommandOptions(args, {
        database: { type: "string" },
        output: { type: "string" },
      });
      const result = await createSqliteVolumeBackup({
        database: requiredString(values.database, "--database"),
        output: requiredString(values.output, "--output"),
      });
      io.stdout(canonicalSqliteVolumeJsonFile({ ok: true, manifest: result.manifest }));
      return 0;
    }
    if (operation === "restore") {
      const values = parseCommandOptions(args, {
        backup: { type: "string" },
        database: { type: "string" },
        apply: { type: "boolean", default: false },
        "plan-hash": { type: "string" },
        "safety-backup-output": { type: "string" },
      });
      const backup = requiredString(values.backup, "--backup");
      const database = requiredString(values.database, "--database");
      if (values.apply === true) {
        const result = await applySqliteVolumeRestore({
          backup,
          database,
          planHash: requiredString(values["plan-hash"], "--plan-hash"),
          ...(typeof values["safety-backup-output"] === "string"
            ? { safetyBackupOutput: values["safety-backup-output"] }
            : {}),
        });
        io.stdout(canonicalSqliteVolumeJsonFile({ ok: true, mode: "APPLY", ...result }));
        return 0;
      }
      rejectApplyOnlyOption(values["plan-hash"], "--plan-hash");
      rejectApplyOnlyOption(values["safety-backup-output"], "--safety-backup-output");
      const plan = await planSqliteVolumeRestore({ backup, database });
      io.stdout(canonicalSqliteVolumeJsonFile({ ok: true, mode: "DRY_RUN", plan }));
      return 0;
    }
    if (operation === "migrate") {
      const values = parseCommandOptions(args, {
        database: { type: "string" },
        "backup-output": { type: "string" },
        apply: { type: "boolean", default: false },
        "plan-hash": { type: "string" },
      });
      const database = requiredString(values.database, "--database");
      const backupOutput = requiredString(values["backup-output"], "--backup-output");
      if (values.apply === true) {
        const result = await applySqliteVolumeMigration({
          database,
          backupOutput,
          planHash: requiredString(values["plan-hash"], "--plan-hash"),
        });
        io.stdout(canonicalSqliteVolumeJsonFile({ ok: true, mode: "APPLY", ...result }));
        return 0;
      }
      rejectApplyOnlyOption(values["plan-hash"], "--plan-hash");
      const plan = await planSqliteVolumeMigration({ database, backupOutput });
      io.stdout(canonicalSqliteVolumeJsonFile({ ok: true, mode: "DRY_RUN", plan }));
      return 0;
    }
    throw new RecoveryCliArgumentError("Expected one operation: backup, restore, or migrate.");
  } catch (error) {
    const publicError = toPublicCliError(error);
    io.stderr(canonicalSqliteVolumeJsonFile({ ok: false, error: publicError }));
    return 1;
  }
}

function parseCommandOptions(
  args: readonly string[],
  options: Record<
    string,
    { readonly type: "string" | "boolean"; readonly default?: string | boolean }
  >,
): Record<string, string | boolean | undefined> {
  try {
    const parsed = parseArgs({
      args: [...args],
      options,
      allowPositionals: false,
      strict: true,
    });
    return parsed.values as Record<string, string | boolean | undefined>;
  } catch {
    throw new RecoveryCliArgumentError("Recovery CLI arguments are invalid.");
  }
}

function requiredString(value: unknown, option: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RecoveryCliArgumentError(`${option} is required.`);
  }
  return value;
}

function rejectApplyOnlyOption(value: unknown, option: string): void {
  if (value !== undefined) {
    throw new RecoveryCliArgumentError(`${option} is valid only with --apply.`);
  }
}

class RecoveryCliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryCliArgumentError";
  }
}

function toPublicCliError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof SqliteVolumeRecoveryError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof RecoveryCliArgumentError) {
    return { code: "SQLITE_VOLUME_CLI_INVALID_ARGUMENT", message: error.message };
  }
  return {
    code: "SQLITE_VOLUME_INTERNAL_ERROR",
    message: "SQLite volume recovery failed.",
  };
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))
) {
  process.exitCode = await runVolumeRecoveryCli(process.argv.slice(2));
}
