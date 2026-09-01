import { createHash } from "node:crypto";
import {
  constants,
  createReadStream,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import BetterSqlite3, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { mapStoredLayout } from "./layout-repository.js";
import { mapProject, mapRevision } from "./project-repository.js";
import {
  appMetadata,
  diagramLayouts,
  importArtifacts,
  projects,
  schemaRevisions,
  sqliteSchema,
  visualCommandReceipts,
} from "./schema.js";
import { mapImportArtifact } from "./sql-import-repository.js";
import {
  APP_METADATA_STORAGE_SCHEMA_VERSION_KEY,
  DEFAULT_SQLITE_MIGRATIONS_FOLDER,
  SQLITE_STORAGE_SCHEMA_VERSION,
} from "./sqlite-storage.js";
import { mapStoredVisualCommandReceipt } from "./visual-command-repository.js";
import {
  SQLITE_VOLUME_BACKUP_FORMAT_VERSION,
  type SqliteVolumeBackupInventory,
  type SqliteVolumeBackupManifestV1,
  SqliteVolumeRecoveryError,
  type SqliteVolumeRecoveryPlanV1,
} from "./volume-recovery-types.js";

const MANIFEST_FILENAME = "manifest.json";
const DATABASE_FILENAME = "database.sqlite";
const MANIFEST_MAX_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const PRODUCT_TABLE_COLUMNS = {
  app_metadata: ["key", "value"],
  diagram_layouts: [
    "project_id",
    "view_key",
    "positions_json",
    "collapsed_group_keys_json",
    "hidden_element_keys_json",
    "viewport_json",
    "detail_level",
    "base_schema_hash",
    "revision_no",
  ],
  import_artifacts: [
    "id",
    "project_id",
    "dialect",
    "original_sql",
    "original_hash",
    "generated_dbml",
    "parser_version",
    "report_json",
    "status",
    "created_at",
    "applied_at",
  ],
  projects: [
    "id",
    "name",
    "primary_dialect",
    "draft_source",
    "draft_hash",
    "last_valid_revision_id",
    "parser_version",
    "schema_revision_no",
    "layout_revision_no",
    "created_at",
    "updated_at",
  ],
  schema_revisions: [
    "id",
    "project_id",
    "revision_no",
    "source",
    "source_hash",
    "validity",
    "origin",
    "parser_version",
    "diagnostic_summary_json",
    "created_at",
  ],
  visual_command_receipts: [
    "project_id",
    "command_id",
    "command_kind",
    "command_hash",
    "expected_schema_revision_no",
    "applied_schema_revision_no",
    "applied_layout_revision_no",
    "revision_created",
    "layout_migrated",
    "created_at",
  ],
} as const;

const COMMON_PRODUCT_TABLES = [
  "app_metadata",
  "diagram_layouts",
  "import_artifacts",
  "projects",
  "schema_revisions",
] as const;
const EXPECTED_INDEXES = [
  "import_artifacts_project_created_idx",
  "schema_revisions_non_checkpoint_idx",
] as const;

interface MigrationEvidence {
  readonly hash: string;
  readonly createdAt: number;
}

export interface ValidatedSqliteVolumeDatabase {
  readonly filename: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly storageSchemaVersion: number;
  readonly migrationHistoryHash: string;
  readonly sqliteVersion: string;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly inventory: SqliteVolumeBackupInventory;
}

export interface ValidatedSqliteVolumeBackup {
  readonly directory: string;
  readonly databasePath: string;
  readonly manifestPath: string;
  readonly manifest: SqliteVolumeBackupManifestV1;
  readonly database: ValidatedSqliteVolumeDatabase;
}

export function canonicalSqliteVolumeJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalSqliteVolumeJsonFile(value: unknown): string {
  return `${canonicalSqliteVolumeJson(value)}\n`;
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function sha256File(filename: string, enforceTrustedFile = false): Promise<string> {
  if (enforceTrustedFile) assertTrustedRegularFile(filename, 0o600);
  const hash = createHash("sha256");
  const stream = createReadStream(filename);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function bundledMigrationEvidence(): readonly MigrationEvidence[] {
  return readMigrationFiles({ migrationsFolder: DEFAULT_SQLITE_MIGRATIONS_FOLDER }).map(
    ({ hash, folderMillis }) => ({ hash, createdAt: folderMillis }),
  );
}

export function bundledMigrationSetHash(): string {
  return sha256Utf8(canonicalSqliteVolumeJson(bundledMigrationEvidence()));
}

export function computeBackupHash(
  manifest: Omit<SqliteVolumeBackupManifestV1, "backupHash">,
): string {
  return sha256Utf8(canonicalSqliteVolumeJson(manifest));
}

export function computeRecoveryPlanHash(
  plan: Omit<SqliteVolumeRecoveryPlanV1, "planHash">,
): string {
  return sha256Utf8(canonicalSqliteVolumeJson(plan));
}

export async function validateSqliteVolumeDatabase(
  filename: string,
): Promise<ValidatedSqliteVolumeDatabase> {
  assertExistingRegularFile(filename);
  let client: BetterSqliteDatabase | undefined;
  try {
    client = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
    const integrityRows = client.pragma("integrity_check") as Array<Record<string, unknown>>;
    if (
      integrityRows.length !== 1 ||
      Object.values(integrityRows[0] ?? {}).length !== 1 ||
      Object.values(integrityRows[0] ?? {})[0] !== "ok"
    ) {
      throw recoveryError(
        "SQLITE_VOLUME_INTEGRITY_FAILED",
        "SQLite database integrity validation failed.",
      );
    }
    if ((client.pragma("foreign_key_check") as unknown[]).length > 0) {
      throw recoveryError(
        "SQLITE_VOLUME_INTEGRITY_FAILED",
        "SQLite foreign-key validation failed.",
      );
    }

    const storageSchemaVersion = readStorageSchemaVersion(client);
    const migrations = readAppliedMigrations(client);
    assertSupportedMigrationPrefix(storageSchemaVersion, migrations);
    assertPhysicalSchema(client, storageSchemaVersion);
    const inventory = assertProductData(client, storageSchemaVersion, migrations.length);
    const stat = lstatSync(filename);
    const pageSize = readPositiveSafePragma(client, "page_size");
    const pageCount = readPositiveSafePragma(client, "page_count");
    const sqliteVersion = client
      .prepare<[], { version: string }>("SELECT sqlite_version() AS version")
      .get()?.version;
    if (typeof sqliteVersion !== "string" || sqliteVersion.length === 0) {
      throw recoveryError(
        "SQLITE_VOLUME_INTEGRITY_FAILED",
        "SQLite version evidence is unavailable.",
      );
    }
    client.close();
    client = undefined;
    return {
      filename,
      sha256: await sha256File(filename),
      bytes: assertSafePositiveInteger(stat.size, "database byte size"),
      storageSchemaVersion,
      migrationHistoryHash: sha256Utf8(canonicalSqliteVolumeJson(migrations)),
      sqliteVersion,
      pageSize,
      pageCount,
      inventory,
    };
  } catch (error) {
    if (error instanceof SqliteVolumeRecoveryError) throw error;
    throw recoveryError(
      "SQLITE_VOLUME_INTEGRITY_FAILED",
      "SQLite volume validation failed.",
      error,
    );
  } finally {
    if (client?.open) client.close();
  }
}

export async function validateSqliteVolumeBackup(
  directory: string,
): Promise<ValidatedSqliteVolumeBackup> {
  assertTrustedDirectory(directory);
  const entries = readdirSync(directory).sort(compareCodeUnits);
  if (
    canonicalSqliteVolumeJson(entries) !==
    canonicalSqliteVolumeJson([DATABASE_FILENAME, MANIFEST_FILENAME])
  ) {
    throw recoveryError(
      "SQLITE_VOLUME_BACKUP_INVALID",
      "SQLite volume backup contains unexpected entries.",
    );
  }
  const databasePath = path.join(directory, DATABASE_FILENAME);
  const manifestPath = path.join(directory, MANIFEST_FILENAME);
  assertTrustedRegularFile(databasePath, 0o600);
  assertTrustedRegularFile(manifestPath, 0o600);

  const manifestStat = lstatSync(manifestPath);
  if (manifestStat.size > MANIFEST_MAX_BYTES) {
    throw recoveryError(
      "SQLITE_VOLUME_BACKUP_INVALID",
      "SQLite volume backup manifest is too large.",
    );
  }
  const manifestBytes = readFileNoFollow(manifestPath);
  let manifest: SqliteVolumeBackupManifestV1;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
    const parsed = parseBackupManifest(JSON.parse(text));
    if (text !== canonicalSqliteVolumeJsonFile(parsed)) {
      throw new Error("Manifest is not canonical JSON with one trailing line feed.");
    }
    manifest = parsed;
  } catch (error) {
    throw recoveryError(
      "SQLITE_VOLUME_BACKUP_INVALID",
      "SQLite volume backup manifest is invalid.",
      error,
    );
  }

  const { backupHash: _backupHash, ...withoutBackupHash } = manifest;
  if (computeBackupHash(withoutBackupHash) !== manifest.backupHash) {
    throw recoveryError(
      "SQLITE_VOLUME_CHECKSUM_MISMATCH",
      "SQLite volume backup manifest hash does not match its evidence.",
    );
  }
  const database = await validateSqliteVolumeDatabase(databasePath);
  if (
    database.bytes !== manifest.database.bytes ||
    database.sha256 !== manifest.database.sha256 ||
    database.storageSchemaVersion !== manifest.database.storageSchemaVersion ||
    database.migrationHistoryHash !== manifest.database.migrationHistoryHash ||
    database.sqliteVersion !== manifest.database.sqliteVersion ||
    database.pageSize !== manifest.database.pageSize ||
    database.pageCount !== manifest.database.pageCount ||
    canonicalSqliteVolumeJson(database.inventory) !== canonicalSqliteVolumeJson(manifest.inventory)
  ) {
    throw recoveryError(
      "SQLITE_VOLUME_CHECKSUM_MISMATCH",
      "SQLite volume backup database does not match its manifest.",
    );
  }
  return { directory, databasePath, manifestPath, manifest, database };
}

export function parseRecoveryPlan(value: unknown): SqliteVolumeRecoveryPlanV1 {
  const record = exactRecord(value, [
    "planVersion",
    "operation",
    "sourceBackupHash",
    "targetPathHash",
    "expectedTargetDatabaseSha256",
    "sourceStorageSchemaVersion",
    "resultStorageSchemaVersion",
    "bundledMigrationSetHash",
    "requiresMigration",
    "candidateDatabaseSha256",
    "planHash",
  ]);
  const operation = record.operation;
  if (record.planVersion !== 1 || (operation !== "RESTORE" && operation !== "MIGRATE")) {
    return invalidBackup("SQLite volume recovery plan version or operation is invalid.");
  }
  const sourceStorageSchemaVersion = positiveSafeInteger(record.sourceStorageSchemaVersion);
  const resultStorageSchemaVersion = positiveSafeInteger(record.resultStorageSchemaVersion);
  if (
    sourceStorageSchemaVersion > resultStorageSchemaVersion ||
    record.requiresMigration !== (sourceStorageSchemaVersion !== resultStorageSchemaVersion)
  ) {
    return invalidBackup("SQLite volume recovery plan migration evidence is inconsistent.");
  }
  return {
    planVersion: 1,
    operation,
    sourceBackupHash: sha256(record.sourceBackupHash),
    targetPathHash: sha256(record.targetPathHash),
    expectedTargetDatabaseSha256:
      record.expectedTargetDatabaseSha256 === null
        ? null
        : sha256(record.expectedTargetDatabaseSha256),
    sourceStorageSchemaVersion,
    resultStorageSchemaVersion,
    bundledMigrationSetHash: sha256(record.bundledMigrationSetHash),
    requiresMigration: record.requiresMigration,
    candidateDatabaseSha256: sha256(record.candidateDatabaseSha256),
    planHash: sha256(record.planHash),
  };
}

function assertProductData(
  client: BetterSqliteDatabase,
  storageSchemaVersion: number,
  drizzleMigrations: number,
): SqliteVolumeBackupInventory {
  const database = drizzle({ client, schema: sqliteSchema });
  const projectValues = database.select().from(projects).all().map(mapProject);
  const revisionValues = database.select().from(schemaRevisions).all().map(mapRevision);
  const layoutValues = database.select().from(diagramLayouts).all().map(mapStoredLayout);
  const artifactValues = database.select().from(importArtifacts).all().map(mapImportArtifact);
  const receiptValues =
    storageSchemaVersion >= 2
      ? database.select().from(visualCommandReceipts).all().map(mapStoredVisualCommandReceipt)
      : [];
  const metadataValues = database.select().from(appMetadata).all();
  const projectsById = new Map(projectValues.map((project) => [project.id, project]));
  const revisionsByProject = new Map<string, Map<number, (typeof revisionValues)[number]>>();
  const revisionsById = new Map(revisionValues.map((revision) => [revision.id, revision]));

  for (const revision of revisionValues) {
    if (sha256Utf8(revision.source) !== revision.sourceHash) {
      throw recoveryError(
        "SQLITE_VOLUME_INTEGRITY_FAILED",
        "Stored schema revision source hash is invalid.",
      );
    }
    const revisions = revisionsByProject.get(revision.projectId) ?? new Map();
    revisions.set(revision.revisionNo, revision);
    revisionsByProject.set(revision.projectId, revisions);
  }
  for (const project of projectValues) {
    const current = revisionsByProject.get(project.id)?.get(project.schemaRevisionNo);
    if (
      current === undefined ||
      project.draftSource !== current.source ||
      project.draftHash !== current.sourceHash ||
      sha256Utf8(project.draftSource) !== project.draftHash
    ) {
      throw recoveryError(
        "SQLITE_VOLUME_INTEGRITY_FAILED",
        "Stored project current revision evidence is inconsistent.",
      );
    }
    if (project.lastValidRevisionId !== null) {
      const lastValid = revisionsById.get(project.lastValidRevisionId);
      if (
        lastValid?.projectId !== project.id ||
        lastValid.validity !== "VALID" ||
        lastValid.revisionNo > project.schemaRevisionNo
      ) {
        throw recoveryError(
          "SQLITE_VOLUME_INTEGRITY_FAILED",
          "Stored project last-valid revision evidence is inconsistent.",
        );
      }
    }
  }
  for (const layout of layoutValues) {
    const project = projectsById.get(layout.projectId);
    if (project === undefined || layout.revisionNo > project.layoutRevisionNo) {
      throw recoveryError(
        "SQLITE_VOLUME_INTEGRITY_FAILED",
        "Stored diagram layout revision evidence is inconsistent.",
      );
    }
  }
  for (const receipt of receiptValues) {
    const project = projectsById.get(receipt.projectId);
    if (
      project === undefined ||
      receipt.appliedSchemaRevisionNo > project.schemaRevisionNo ||
      receipt.appliedLayoutRevisionNo > project.layoutRevisionNo
    ) {
      throw recoveryError(
        "SQLITE_VOLUME_INTEGRITY_FAILED",
        "Stored visual command receipt revision evidence is inconsistent.",
      );
    }
  }
  for (const artifact of artifactValues) {
    if (!projectsById.has(artifact.projectId)) {
      throw recoveryError(
        "SQLITE_VOLUME_INTEGRITY_FAILED",
        "Stored SQL import artifact project evidence is inconsistent.",
      );
    }
  }

  return {
    projects: projectValues.length,
    schemaRevisions: revisionValues.length,
    diagramLayouts: layoutValues.length,
    importArtifacts: artifactValues.length,
    visualCommandReceipts: receiptValues.length,
    appMetadata: metadataValues.length,
    drizzleMigrations,
  };
}

function readStorageSchemaVersion(client: BetterSqliteDatabase): number {
  const row = client
    .prepare<[string], { value: string }>("SELECT value FROM app_metadata WHERE key = ?")
    .get(APP_METADATA_STORAGE_SCHEMA_VERSION_KEY);
  const value = Number(row?.value);
  if (!Number.isSafeInteger(value) || value < 1 || value > SQLITE_STORAGE_SCHEMA_VERSION) {
    throw recoveryError(
      "SQLITE_VOLUME_SCHEMA_UNSUPPORTED",
      "SQLite storage schema version is not supported by this release.",
    );
  }
  return value;
}

function readAppliedMigrations(client: BetterSqliteDatabase): readonly MigrationEvidence[] {
  const rows = client
    .prepare<[], { hash: string; createdAt: number }>(
      "SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at, id",
    )
    .all();
  return rows.map((row) => ({
    hash: sha256(row.hash),
    createdAt: positiveSafeInteger(row.createdAt),
  }));
}

function assertSupportedMigrationPrefix(
  storageSchemaVersion: number,
  applied: readonly MigrationEvidence[],
): void {
  const bundled = bundledMigrationEvidence();
  if (
    applied.length !== storageSchemaVersion ||
    applied.length > bundled.length ||
    canonicalSqliteVolumeJson(applied) !==
      canonicalSqliteVolumeJson(bundled.slice(0, applied.length))
  ) {
    throw recoveryError(
      "SQLITE_VOLUME_SCHEMA_UNSUPPORTED",
      "SQLite migration history is not a supported bundled prefix.",
    );
  }
}

function assertPhysicalSchema(client: BetterSqliteDatabase, storageSchemaVersion: number): void {
  const expectedTables = [
    "__drizzle_migrations",
    ...COMMON_PRODUCT_TABLES,
    ...(storageSchemaVersion >= 2 ? (["visual_command_receipts"] as const) : []),
  ].sort(compareCodeUnits);
  const tables = client
    .prepare<[], { name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  if (
    canonicalSqliteVolumeJson(tables.map(({ name }) => name)) !==
    canonicalSqliteVolumeJson(expectedTables)
  ) {
    throw recoveryError(
      "SQLITE_VOLUME_SCHEMA_UNSUPPORTED",
      "SQLite table inventory does not match the supported storage schema.",
    );
  }
  const productTableNames = expectedTables.filter((name) => name !== "__drizzle_migrations");
  for (const tableName of productTableNames) {
    const sql = tables.find(({ name }) => name === tableName)?.sql;
    if (typeof sql !== "string" || !sql.trimEnd().toUpperCase().endsWith("STRICT")) {
      throw recoveryError(
        "SQLITE_VOLUME_SCHEMA_UNSUPPORTED",
        "SQLite product table strictness does not match the supported storage schema.",
      );
    }
    const expectedColumns = PRODUCT_TABLE_COLUMNS[tableName as keyof typeof PRODUCT_TABLE_COLUMNS];
    const columns = client.pragma(`table_info(${JSON.stringify(tableName)})`) as Array<{
      name: string;
    }>;
    if (
      canonicalSqliteVolumeJson(columns.map(({ name }) => name)) !==
      canonicalSqliteVolumeJson(expectedColumns)
    ) {
      throw recoveryError(
        "SQLITE_VOLUME_SCHEMA_UNSUPPORTED",
        "SQLite product table columns do not match the supported storage schema.",
      );
    }
  }
  const indexes = client
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
  if (canonicalSqliteVolumeJson(indexes) !== canonicalSqliteVolumeJson(EXPECTED_INDEXES)) {
    throw recoveryError(
      "SQLITE_VOLUME_SCHEMA_UNSUPPORTED",
      "SQLite index inventory does not match the supported storage schema.",
    );
  }
}

function parseBackupManifest(value: unknown): SqliteVolumeBackupManifestV1 {
  const root = exactRecord(value, [
    "format",
    "backupFormatVersion",
    "backupHash",
    "createdAt",
    "database",
    "inventory",
  ]);
  if (
    root.format !== "ER_DIAGRAM_SQLITE_VOLUME_BACKUP" ||
    root.backupFormatVersion !== SQLITE_VOLUME_BACKUP_FORMAT_VERSION
  ) {
    return invalidBackup("SQLite volume backup format version is invalid.");
  }
  const database = exactRecord(root.database, [
    "path",
    "bytes",
    "sha256",
    "storageSchemaVersion",
    "migrationHistoryHash",
    "sqliteVersion",
    "pageSize",
    "pageCount",
  ]);
  const inventory = exactRecord(root.inventory, [
    "projects",
    "schemaRevisions",
    "diagramLayouts",
    "importArtifacts",
    "visualCommandReceipts",
    "appMetadata",
    "drizzleMigrations",
  ]);
  if (
    database.path !== DATABASE_FILENAME ||
    typeof database.sqliteVersion !== "string" ||
    database.sqliteVersion.length === 0
  ) {
    return invalidBackup("SQLite volume backup database evidence is invalid.");
  }
  return {
    format: "ER_DIAGRAM_SQLITE_VOLUME_BACKUP",
    backupFormatVersion: 1,
    backupHash: sha256(root.backupHash),
    createdAt: utcIsoTimestamp(root.createdAt),
    database: {
      path: DATABASE_FILENAME,
      bytes: positiveSafeInteger(database.bytes),
      sha256: sha256(database.sha256),
      storageSchemaVersion: positiveSafeInteger(database.storageSchemaVersion),
      migrationHistoryHash: sha256(database.migrationHistoryHash),
      sqliteVersion: database.sqliteVersion,
      pageSize: positiveSafeInteger(database.pageSize),
      pageCount: positiveSafeInteger(database.pageCount),
    },
    inventory: {
      projects: nonnegativeSafeInteger(inventory.projects),
      schemaRevisions: nonnegativeSafeInteger(inventory.schemaRevisions),
      diagramLayouts: nonnegativeSafeInteger(inventory.diagramLayouts),
      importArtifacts: nonnegativeSafeInteger(inventory.importArtifacts),
      visualCommandReceipts: nonnegativeSafeInteger(inventory.visualCommandReceipts),
      appMetadata: nonnegativeSafeInteger(inventory.appMetadata),
      drizzleMigrations: nonnegativeSafeInteger(inventory.drizzleMigrations),
    },
  };
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON cannot contain non-finite numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError("Canonical JSON only supports plain data.");
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort(compareCodeUnits)
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function assertTrustedDirectory(directory: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    throw recoveryError(
      "SQLITE_VOLUME_INVALID_PATH",
      "SQLite volume backup path is invalid.",
      error,
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    throw recoveryError(
      "SQLITE_VOLUME_INVALID_PATH",
      "SQLite volume backup directory must be a private real directory.",
    );
  }
}

function assertExistingRegularFile(filename: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(filename);
  } catch (error) {
    throw recoveryError("SQLITE_VOLUME_INVALID_PATH", "SQLite database path is invalid.", error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw recoveryError("SQLITE_VOLUME_INVALID_PATH", "SQLite database must be a regular file.");
  }
}

function assertTrustedRegularFile(filename: string, expectedMode: number): void {
  assertExistingRegularFile(filename);
  const stat = lstatSync(filename);
  if (stat.nlink !== 1 || (stat.mode & 0o777) !== expectedMode) {
    throw recoveryError(
      "SQLITE_VOLUME_INVALID_PATH",
      "SQLite volume backup files must be private, single-link regular files.",
    );
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error("Backup file changed while it was being validated.");
    }
  } catch (error) {
    throw recoveryError(
      "SQLITE_VOLUME_INVALID_PATH",
      "SQLite volume backup file is unsafe.",
      error,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readFileNoFollow(filename: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    return readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readPositiveSafePragma(client: BetterSqliteDatabase, pragma: string): number {
  return positiveSafeInteger(client.pragma(pragma, { simple: true }));
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidBackup("Expected a strict JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (
    canonicalSqliteVolumeJson(Object.keys(record).sort(compareCodeUnits)) !==
    canonicalSqliteVolumeJson([...keys].sort(compareCodeUnits))
  ) {
    return invalidBackup("SQLite volume evidence contains unknown or missing fields.");
  }
  return record;
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    return invalidBackup("SQLite volume evidence contains an invalid SHA-256 value.");
  }
  return value;
}

function utcIsoTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UTC_ISO_PATTERN.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    return invalidBackup("SQLite volume evidence contains an invalid UTC timestamp.");
  }
  return value;
}

function positiveSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return invalidBackup("SQLite volume evidence contains an invalid positive integer.");
  }
  return value;
}

function nonnegativeSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidBackup("SQLite volume evidence contains an invalid nonnegative integer.");
  }
  return value;
}

function assertSafePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw recoveryError("SQLITE_VOLUME_INTEGRITY_FAILED", `SQLite ${label} is invalid.`);
  }
  return value;
}

function invalidBackup(message: string): never {
  throw recoveryError("SQLITE_VOLUME_BACKUP_INVALID", message);
}

export function recoveryError(
  code: ConstructorParameters<typeof SqliteVolumeRecoveryError>[0],
  message: string,
  cause?: unknown,
): SqliteVolumeRecoveryError {
  return new SqliteVolumeRecoveryError(code, message, cause);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
