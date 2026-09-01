#!/usr/bin/env node
import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  openSqliteStorage,
  SQLITE_STORAGE_SCHEMA_VERSION,
  SqliteVolumeRecoveryError,
  validateSqliteVolumeDatabase,
} from "@er-diagram/storage-sqlite";
import type { FastifyInstance } from "fastify";

import { createSqliteServer } from "./sqlite-server.js";

export const PRODUCTION_SERVER_HOST = "0.0.0.0";
export const PRODUCTION_SERVER_PORT = 8080;
export const PRODUCTION_DATABASE_FILENAME = "/data/er-diagram.sqlite";
export const PRODUCTION_WEB_ROOT = "/app/web";

export type ProductionServerStartupErrorCode =
  | "SERVER_STATIC_ASSETS_INVALID"
  | "SERVER_STORAGE_INVALID"
  | "SERVER_STORAGE_MIGRATION_REQUIRED"
  | "SERVER_STARTUP_FAILED";

export class ProductionServerStartupError extends Error {
  readonly code: ProductionServerStartupErrorCode;
  override readonly cause: unknown;

  constructor(code: ProductionServerStartupErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ProductionServerStartupError";
    this.code = code;
    this.cause = cause;
  }
}

interface CreateProductionServerOptions {
  readonly databaseFilename?: string;
  readonly staticWebRoot?: string;
}

export async function createProductionServer(
  options: CreateProductionServerOptions = {},
): Promise<FastifyInstance> {
  const databaseFilename = options.databaseFilename ?? PRODUCTION_DATABASE_FILENAME;
  const staticWebRoot = options.staticWebRoot ?? PRODUCTION_WEB_ROOT;
  assertStaticWebRoot(staticWebRoot);
  await assertCurrentOrNewDatabase(databaseFilename);

  const storage = openSqliteStorage({ filename: databaseFilename });
  try {
    const server = createSqliteServer({
      storage,
      staticWeb: { rootDirectory: staticWebRoot },
    });
    server.addHook("onClose", async () => storage.close());
    return server;
  } catch (error) {
    storage.close();
    throw startupError("SERVER_STARTUP_FAILED", "The packaged server failed to initialize.", error);
  }
}

export async function runProductionServer(): Promise<void> {
  const server = await createProductionServer();
  try {
    await server.listen({ host: PRODUCTION_SERVER_HOST, port: PRODUCTION_SERVER_PORT });
  } catch (error) {
    await server.close();
    throw startupError("SERVER_STARTUP_FAILED", "The packaged server failed to listen.", error);
  }
}

async function assertCurrentOrNewDatabase(databaseFilename: string): Promise<void> {
  if (!existsSync(databaseFilename)) return;
  try {
    const database = await validateSqliteVolumeDatabase(databaseFilename);
    if (database.storageSchemaVersion !== SQLITE_STORAGE_SCHEMA_VERSION) {
      throw startupError(
        "SERVER_STORAGE_MIGRATION_REQUIRED",
        "The SQLite volume requires an explicit storage:migrate operation before startup.",
      );
    }
  } catch (error) {
    if (error instanceof ProductionServerStartupError) throw error;
    if (
      error instanceof SqliteVolumeRecoveryError &&
      error.code === "SQLITE_VOLUME_SCHEMA_UNSUPPORTED"
    ) {
      throw startupError(
        "SERVER_STORAGE_MIGRATION_REQUIRED",
        "The SQLite volume requires an explicit storage:migrate operation before startup.",
        error,
      );
    }
    throw startupError(
      "SERVER_STORAGE_INVALID",
      "The SQLite volume failed startup validation.",
      error,
    );
  }
}

function assertStaticWebRoot(rootDirectory: string): void {
  try {
    const root = lstatSync(rootDirectory);
    const index = lstatSync(join(rootDirectory, "index.html"));
    if (!root.isDirectory() || root.isSymbolicLink() || !index.isFile() || index.isSymbolicLink()) {
      throw new Error("The packaged Web root is not a real directory with an index file.");
    }
  } catch (error) {
    throw startupError(
      "SERVER_STATIC_ASSETS_INVALID",
      "The packaged Web application is unavailable.",
      error,
    );
  }
}

function startupError(
  code: ProductionServerStartupErrorCode,
  message: string,
  cause?: unknown,
): ProductionServerStartupError {
  return new ProductionServerStartupError(code, message, cause);
}

function publicStartupFailure(error: unknown): {
  readonly ok: false;
  readonly error: { readonly code: ProductionServerStartupErrorCode; readonly message: string };
} {
  const startupFailure =
    error instanceof ProductionServerStartupError
      ? error
      : startupError("SERVER_STARTUP_FAILED", "The packaged server failed to start.", error);
  return {
    ok: false,
    error: { code: startupFailure.code, message: startupFailure.message },
  };
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  runProductionServer().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(publicStartupFailure(error))}\n`);
    process.exitCode = 1;
  });
}
