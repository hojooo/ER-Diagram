export { createSqliteLayoutRepository } from "./layout-repository.js";
export { createSqliteProjectRepository } from "./project-repository.js";
export {
  appMetadata,
  DETAIL_LEVELS,
  type DiagramPosition,
  type DiagramViewport,
  DRAFT_VALIDITIES,
  diagramLayouts,
  IMPORT_STATUSES,
  importArtifacts,
  PRIMARY_DIALECTS,
  projects,
  REVISION_ORIGINS,
  type StoredJsonObject,
  schemaRevisions,
  sqliteSchema,
  VISUAL_COMMAND_KINDS,
  visualCommandReceipts,
} from "./schema.js";
export { createSqliteSqlImportRepository } from "./sql-import-repository.js";
export {
  APP_METADATA_STORAGE_SCHEMA_VERSION_KEY,
  type OpenSqliteStorageOptions,
  openSqliteStorage,
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_STORAGE_SCHEMA_VERSION,
  type SqliteDatabase,
  type SqliteStorage,
  SqliteStorageError,
  type SqliteStorageErrorCode,
  type SqliteTransaction,
} from "./sqlite-storage.js";
export { generateUuidV7, toUtcIsoTimestamp } from "./uuid-v7.js";
export { createSqliteVisualCommandRepository } from "./visual-command-repository.js";

export const storageSqlitePackage = "@er-diagram/storage-sqlite";
