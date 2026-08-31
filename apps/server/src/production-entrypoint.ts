#!/usr/bin/env node
import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  APP_METADATA_STORAGE_SCHEMA_VERSION_KEY,
  acquireSqliteVolumeLock,
  applySqliteVolumeMigration,
  openSqliteStorage,
  planSqliteVolumeMigration,
  SQLITE_STORAGE_SCHEMA_VERSION,
  type SqliteStorage,
  type SqliteVolumeLock,
  SqliteVolumeRecoveryError,
  validateSqliteVolumeDatabase,
} from "@er-diagram/storage-sqlite";
import type { FastifyInstance } from "fastify";

import {
  createJsonLineOperationalLogSink,
  flushOperationalLog,
  NOOP_OPERATIONAL_LOG_SINK,
  OPERATIONAL_LOG_VERSION,
  type OperationalLogSink,
  type ServerLifecycleState,
  utcTimestamp,
  writeOperationalLog,
} from "./operational-logging.js";
import {
  DEFAULT_PRODUCTION_CONFIGURATION,
  type ProductionConfiguration,
  ProductionConfigurationError,
  parseProductionConfiguration,
} from "./production-config.js";
import { createResourceExecutor, type ResourceExecutor } from "./resource-executor.js";
import { createSqliteServer } from "./sqlite-server.js";

export const PRODUCTION_SERVER_HOST = "0.0.0.0";
export const PRODUCTION_SERVER_PORT = 8080;
export const PRODUCTION_DATABASE_FILENAME = "/data/er-diagram.sqlite";
export const PRODUCTION_WEB_ROOT = "/app/web";

export type ProductionServerStartupErrorCode =
  | "SERVER_CONFIGURATION_INVALID"
  | "SERVER_STATIC_ASSETS_INVALID"
  | "SERVER_STORAGE_INVALID"
  | "SERVER_STORAGE_LOCKED"
  | "SERVER_STORAGE_MIGRATION_FAILED"
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

export interface CreateProductionServerOptions {
  readonly databaseFilename?: string;
  readonly staticWebRoot?: string;
  readonly configuration?: ProductionConfiguration;
  readonly operationalLogSink?: OperationalLogSink;
}

export interface ProductionRuntime {
  readonly server: FastifyInstance;
  readonly state: ServerLifecycleState;
  shutdown(reasonCode?: string): Promise<void>;
}

export async function createProductionRuntime(
  options: CreateProductionServerOptions = {},
): Promise<ProductionRuntime> {
  const databaseFilename = options.databaseFilename ?? PRODUCTION_DATABASE_FILENAME;
  const staticWebRoot = options.staticWebRoot ?? PRODUCTION_WEB_ROOT;
  const configuration = options.configuration ?? DEFAULT_PRODUCTION_CONFIGURATION;
  const operationalLogSink =
    options.operationalLogSink ??
    (configuration.operationalLog === "INFO"
      ? createJsonLineOperationalLogSink()
      : NOOP_OPERATIONAL_LOG_SINK);
  let state: ServerLifecycleState = "STARTING";
  let volumeLock: SqliteVolumeLock | undefined;
  let storage: SqliteStorage | undefined;
  let resourceExecutor: ResourceExecutor | undefined;
  let resourcesClosed = false;
  let shutdownPromise: Promise<void> | undefined;
  let server: FastifyInstance | undefined;

  writeLifecycleLog(operationalLogSink, state);
  try {
    assertStaticWebRoot(staticWebRoot);
    await prepareProductionDatabase(databaseFilename, configuration);
    volumeLock = acquireProductionVolumeLock(databaseFilename);
    if (existsSync(databaseFilename)) await assertCurrentDatabase(databaseFilename);
    storage = openSqliteStorage({ filename: databaseFilename });
    resourceExecutor = createResourceExecutor({
      limits: configuration.resourceLimits,
      operationalLogSink,
      workerUrl: resolveProductionWorkerUrl(),
    });

    const closeOwnedResources = async (): Promise<void> => {
      if (resourcesClosed) return;
      resourcesClosed = true;
      try {
        storage?.close();
      } finally {
        state = "STOPPED";
        writeLifecycleLog(operationalLogSink, state);
        await flushOperationalLog(operationalLogSink);
        volumeLock?.release();
      }
    };

    server = createSqliteServer({
      storage,
      resourceLimits: configuration.resourceLimits,
      resourceExecutor,
      operationalLogSink,
      staticWeb: { rootDirectory: staticWebRoot },
      readinessProbe: () =>
        state === "READY" && volumeLock?.isHeld() === true && hasCurrentStorageMetadata(storage),
      trustedProxyCidrs: configuration.trustedProxyCidrs,
      hstsMaxAgeSeconds: configuration.hstsMaxAgeSeconds,
      closeOwnedResources,
    });
    state = "READY";
    writeLifecycleLog(operationalLogSink, state);

    return Object.freeze({
      server,
      get state() {
        return state;
      },
      shutdown(reasonCode = "REQUESTED") {
        if (shutdownPromise) return shutdownPromise;
        if (state === "STOPPED") return Promise.resolve();
        state = "SHUTTING_DOWN";
        writeLifecycleLog(operationalLogSink, state, reasonCode);
        shutdownPromise = (async () => {
          try {
            await server?.close();
          } catch (error) {
            state = "FAILED";
            writeLifecycleLog(operationalLogSink, state, "SHUTDOWN_FAILED");
            await closeOwnedResources();
            await flushOperationalLog(operationalLogSink);
            throw error;
          }
        })();
        return shutdownPromise;
      },
    } satisfies ProductionRuntime);
  } catch (error) {
    state = "FAILED";
    writeLifecycleLog(operationalLogSink, state, "STARTUP_FAILED");
    try {
      await server?.close();
    } catch {
      // Preserve the startup failure while completing best-effort cleanup below.
    }
    try {
      try {
        await resourceExecutor?.close();
      } finally {
        storage?.close();
      }
    } finally {
      await flushOperationalLog(operationalLogSink);
      volumeLock?.release();
    }
    throw normalizeStartupError(error);
  }
}

function resolveProductionWorkerUrl(): URL {
  const packaged = new URL("./resource-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(packaged))) return packaged;
  const builtFromSource = new URL("../dist/resource-worker.js", import.meta.url);
  return existsSync(fileURLToPath(builtFromSource)) ? builtFromSource : packaged;
}

export async function createProductionServer(
  options: CreateProductionServerOptions = {},
): Promise<FastifyInstance> {
  return (await createProductionRuntime(options)).server;
}

export async function runProductionServer(): Promise<void> {
  let configuration: ProductionConfiguration;
  try {
    configuration = parseProductionConfiguration(process.env);
  } catch (error) {
    throw normalizeStartupError(error);
  }

  const runtime = await createProductionRuntime({ configuration });
  try {
    await runtime.server.listen({ host: PRODUCTION_SERVER_HOST, port: PRODUCTION_SERVER_PORT });
  } catch (error) {
    await runtime.shutdown("LISTEN_FAILED");
    throw startupError("SERVER_STARTUP_FAILED", "The packaged server failed to listen.", error);
  }
  installProductionSignalHandlers(runtime, configuration.shutdownTimeoutMs);
}

export function installProductionSignalHandlers(
  runtime: ProductionRuntime,
  shutdownTimeoutMs: number,
): () => void {
  let signalCount = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cleanup = (): void => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    if (timeout) clearTimeout(timeout);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    signalCount += 1;
    if (signalCount > 1) {
      cleanup();
      process.exit(1);
    }
    timeout = setTimeout(() => {
      cleanup();
      process.exit(1);
    }, shutdownTimeoutMs);
    void runtime.shutdown(signal).then(
      () => {
        cleanup();
        process.exitCode = 0;
      },
      () => {
        cleanup();
        process.exitCode = 1;
      },
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  return cleanup;
}

async function prepareProductionDatabase(
  databaseFilename: string,
  configuration: ProductionConfiguration,
): Promise<void> {
  if (!existsSync(databaseFilename)) return;
  const validated = await validateExistingDatabase(databaseFilename);
  if (validated.storageSchemaVersion === SQLITE_STORAGE_SCHEMA_VERSION) return;
  if (configuration.startupMigration.mode === "MANUAL") {
    throw startupError(
      "SERVER_STORAGE_MIGRATION_REQUIRED",
      "The SQLite volume requires an explicit storage migration before startup.",
    );
  }
  const backupOutput = configuration.startupMigration.backupOutput;
  if (backupOutput === null || existsSync(backupOutput)) {
    throw startupError(
      "SERVER_CONFIGURATION_INVALID",
      "The startup migration backup destination is invalid.",
    );
  }
  try {
    const plan = await planSqliteVolumeMigration({
      database: databaseFilename,
      backupOutput,
    });
    await applySqliteVolumeMigration({
      database: databaseFilename,
      backupOutput,
      planHash: plan.planHash,
    });
  } catch (error) {
    throw startupError(
      "SERVER_STORAGE_MIGRATION_FAILED",
      "The SQLite volume migration could not be applied safely.",
      error,
    );
  }
}

async function assertCurrentDatabase(databaseFilename: string): Promise<void> {
  const database = await validateExistingDatabase(databaseFilename);
  if (database.storageSchemaVersion !== SQLITE_STORAGE_SCHEMA_VERSION) {
    throw startupError(
      "SERVER_STORAGE_MIGRATION_REQUIRED",
      "The SQLite volume requires an explicit storage migration before startup.",
    );
  }
}

async function validateExistingDatabase(databaseFilename: string) {
  try {
    return await validateSqliteVolumeDatabase(databaseFilename);
  } catch (error) {
    if (
      error instanceof SqliteVolumeRecoveryError &&
      error.code === "SQLITE_VOLUME_SCHEMA_UNSUPPORTED"
    ) {
      throw startupError(
        "SERVER_STORAGE_MIGRATION_REQUIRED",
        "The SQLite volume requires an explicit storage migration before startup.",
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

function acquireProductionVolumeLock(databaseFilename: string): SqliteVolumeLock {
  try {
    return acquireSqliteVolumeLock(databaseFilename);
  } catch (error) {
    if (error instanceof SqliteVolumeRecoveryError && error.code === "SQLITE_VOLUME_LOCKED") {
      throw startupError(
        "SERVER_STORAGE_LOCKED",
        "The SQLite volume is already owned by another runtime.",
        error,
      );
    }
    throw startupError(
      "SERVER_STORAGE_INVALID",
      "The SQLite volume lifecycle lock is invalid.",
      error,
    );
  }
}

function hasCurrentStorageMetadata(storage: SqliteStorage | undefined): boolean {
  if (!storage) return false;
  try {
    const metadata = storage.database.get<{ value?: unknown }>(
      `SELECT value FROM app_metadata WHERE key = '${APP_METADATA_STORAGE_SCHEMA_VERSION_KEY}'`,
    );
    return metadata?.value === String(SQLITE_STORAGE_SCHEMA_VERSION);
  } catch {
    return false;
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

function writeLifecycleLog(
  sink: OperationalLogSink,
  state: ServerLifecycleState,
  reasonCode?: string,
): void {
  writeOperationalLog(sink, {
    logVersion: OPERATIONAL_LOG_VERSION,
    event: "SERVER_LIFECYCLE",
    timestamp: utcTimestamp(),
    state,
    ...(reasonCode === undefined ? {} : { reasonCode: safeReasonCode(reasonCode) }),
  });
}

function safeReasonCode(value: string): string {
  return /^[A-Z][A-Z0-9_]*$/u.test(value) ? value : "UNSPECIFIED";
}

function normalizeStartupError(error: unknown): ProductionServerStartupError {
  if (error instanceof ProductionServerStartupError) return error;
  if (error instanceof ProductionConfigurationError) {
    return startupError(
      "SERVER_CONFIGURATION_INVALID",
      "The production server configuration is invalid.",
      error,
    );
  }
  return startupError("SERVER_STARTUP_FAILED", "The packaged server failed to start.", error);
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
  const startupFailure = normalizeStartupError(error);
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
