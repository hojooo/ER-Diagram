import { type SQL, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const PRIMARY_DIALECTS = ["POSTGRESQL", "MYSQL"] as const;
export const DRAFT_VALIDITIES = ["VALID", "INVALID"] as const;
export const REVISION_ORIGINS = [
  "SOURCE_EDIT",
  "VISUAL_COMMAND",
  "SQL_IMPORT",
  "RESTORE",
  "PARSER_MIGRATION",
] as const;
export const DETAIL_LEVELS = ["NAME_ONLY", "KEYS_ONLY", "FULL"] as const;
export const IMPORT_STATUSES = ["PREVIEWED", "APPLIED", "CANCELLED", "FAILED"] as const;
export const VISUAL_COMMAND_KINDS = [
  "CREATE_TABLE",
  "UPDATE_TABLE",
  "RENAME_TABLE",
  "DELETE_TABLE",
  "CREATE_COLUMN",
  "UPDATE_COLUMN",
  "RENAME_COLUMN",
  "REORDER_COLUMN",
  "DELETE_COLUMN",
  "CREATE_REFERENCE",
  "UPDATE_REFERENCE",
  "DELETE_REFERENCE",
  "CREATE_INDEX",
  "UPDATE_INDEX",
  "DELETE_INDEX",
  "CREATE_CHECK",
  "UPDATE_CHECK",
  "DELETE_CHECK",
  "UPDATE_GROUP_MEMBERSHIP",
  "UPDATE_DIAGRAM_VIEW",
] as const;

export interface DiagramPosition {
  readonly x: number;
  readonly y: number;
}

export interface DiagramViewport extends DiagramPosition {
  readonly zoom: number;
}

export type StoredJsonObject = Readonly<Record<string, unknown>>;

function uuidV7Text(column: AnySQLiteColumn): SQL {
  return sql`length(${column}) = 36
    AND ${column} = lower(${column})
    AND substr(${column}, 9, 1) = '-'
    AND substr(${column}, 14, 1) = '-'
    AND substr(${column}, 19, 1) = '-'
    AND substr(${column}, 24, 1) = '-'
    AND length(replace(${column}, '-', '')) = 32
    AND replace(${column}, '-', '') NOT GLOB '*[^0-9a-f]*'
    AND substr(${column}, 15, 1) = '7'
    AND substr(${column}, 20, 1) IN ('8', '9', 'a', 'b')`;
}

function uuidText(column: AnySQLiteColumn): SQL {
  return sql`length(${column}) = 36
    AND ${column} = lower(${column})
    AND substr(${column}, 9, 1) = '-'
    AND substr(${column}, 14, 1) = '-'
    AND substr(${column}, 19, 1) = '-'
    AND substr(${column}, 24, 1) = '-'
    AND length(replace(${column}, '-', '')) = 32
    AND replace(${column}, '-', '') NOT GLOB '*[^0-9a-f]*'
    AND substr(${column}, 15, 1) IN ('1', '2', '3', '4', '5', '6', '7', '8')
    AND substr(${column}, 20, 1) IN ('8', '9', 'a', 'b')`;
}

function utcIsoTimestamp(column: AnySQLiteColumn): SQL {
  return sql`length(${column}) = 24
    AND ${column} GLOB '????-??-??T??:??:??.???Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) = ${column}`;
}

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    primaryDialect: text("primary_dialect", { enum: PRIMARY_DIALECTS }).notNull(),
    draftSource: text("draft_source").notNull(),
    draftHash: text("draft_hash").notNull(),
    lastValidRevisionId: text("last_valid_revision_id"),
    parserVersion: text("parser_version").notNull(),
    schemaRevisionNo: integer("schema_revision_no").notNull().default(0),
    layoutRevisionNo: integer("layout_revision_no").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("projects_id_uuid_v7", uuidV7Text(table.id)),
    check("projects_name_nonempty", sql`length(trim(${table.name})) > 0`),
    check("projects_primary_dialect", sql`${table.primaryDialect} IN ('POSTGRESQL', 'MYSQL')`),
    check("projects_draft_hash_nonempty", sql`length(${table.draftHash}) > 0`),
    check("projects_parser_version_nonempty", sql`length(${table.parserVersion}) > 0`),
    check("projects_schema_revision_no", sql`${table.schemaRevisionNo} >= 0`),
    check("projects_layout_revision_no", sql`${table.layoutRevisionNo} >= 0`),
    check("projects_created_at_utc", utcIsoTimestamp(table.createdAt)),
    check("projects_updated_at_utc", utcIsoTimestamp(table.updatedAt)),
    check("projects_updated_after_created", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

// The initial SQL migration owns the deferrable projects -> schema_revisions composite FK.
// Drizzle's SQLite foreign-key builder cannot express DEFERRABLE, and duplicating it here creates
// a circular inferred table type. Storage behavior tests keep the physical constraint fail-closed.

export const schemaRevisions = sqliteTable(
  "schema_revisions",
  {
    id: text("id").primaryKey().notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    revisionNo: integer("revision_no").notNull(),
    source: text("source").notNull(),
    sourceHash: text("source_hash").notNull(),
    validity: text("validity", { enum: DRAFT_VALIDITIES }).notNull(),
    origin: text("origin", { enum: REVISION_ORIGINS }).notNull(),
    parserVersion: text("parser_version").notNull(),
    diagnosticSummary: text("diagnostic_summary_json", { mode: "json" })
      .$type<StoredJsonObject>()
      .notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("schema_revisions_id_uuid_v7", uuidV7Text(table.id)),
    check("schema_revisions_revision_no", sql`${table.revisionNo} > 0`),
    check("schema_revisions_source_hash_nonempty", sql`length(${table.sourceHash}) > 0`),
    check("schema_revisions_validity", sql`${table.validity} IN ('VALID', 'INVALID')`),
    check(
      "schema_revisions_origin",
      sql`${table.origin} IN ('SOURCE_EDIT', 'VISUAL_COMMAND', 'SQL_IMPORT', 'RESTORE', 'PARSER_MIGRATION')`,
    ),
    check("schema_revisions_parser_version_nonempty", sql`length(${table.parserVersion}) > 0`),
    check("schema_revisions_diagnostic_summary_json", sql`json_valid(${table.diagnosticSummary})`),
    check("schema_revisions_created_at_utc", utcIsoTimestamp(table.createdAt)),
    uniqueIndex("schema_revisions_project_revision_uq").on(table.projectId, table.revisionNo),
    uniqueIndex("schema_revisions_project_id_uq").on(table.projectId, table.id),
    index("schema_revisions_non_checkpoint_idx")
      .on(table.projectId, sql`${table.revisionNo} DESC`)
      .where(sql`${table.origin} IN ('SOURCE_EDIT', 'VISUAL_COMMAND')`),
  ],
);

export const diagramLayouts = sqliteTable(
  "diagram_layouts",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    viewKey: text("view_key").notNull(),
    positions: text("positions_json", { mode: "json" })
      .$type<Readonly<Record<string, DiagramPosition>>>()
      .notNull(),
    collapsedGroupKeys: text("collapsed_group_keys_json", { mode: "json" })
      .$type<readonly string[]>()
      .notNull(),
    hiddenElementKeys: text("hidden_element_keys_json", { mode: "json" })
      .$type<readonly string[]>()
      .notNull(),
    viewport: text("viewport_json", { mode: "json" }).$type<DiagramViewport>().notNull(),
    detailLevel: text("detail_level", { enum: DETAIL_LEVELS }).notNull(),
    baseSchemaHash: text("base_schema_hash").notNull(),
    revisionNo: integer("revision_no").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.viewKey] }),
    check("diagram_layouts_view_key_nonempty", sql`length(${table.viewKey}) > 0`),
    check("diagram_layouts_positions_json", sql`json_valid(${table.positions})`),
    check(
      "diagram_layouts_collapsed_group_keys_json",
      sql`json_valid(${table.collapsedGroupKeys})`,
    ),
    check("diagram_layouts_hidden_element_keys_json", sql`json_valid(${table.hiddenElementKeys})`),
    check("diagram_layouts_viewport_json", sql`json_valid(${table.viewport})`),
    check(
      "diagram_layouts_detail_level",
      sql`${table.detailLevel} IN ('NAME_ONLY', 'KEYS_ONLY', 'FULL')`,
    ),
    check("diagram_layouts_base_schema_hash_nonempty", sql`length(${table.baseSchemaHash}) > 0`),
    check("diagram_layouts_revision_no", sql`${table.revisionNo} >= 0`),
  ],
);

export const importArtifacts = sqliteTable(
  "import_artifacts",
  {
    id: text("id").primaryKey().notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    dialect: text("dialect", { enum: PRIMARY_DIALECTS }).notNull(),
    originalSql: text("original_sql"),
    originalHash: text("original_hash").notNull(),
    generatedDbml: text("generated_dbml"),
    parserVersion: text("parser_version").notNull(),
    report: text("report_json", { mode: "json" }).$type<StoredJsonObject>().notNull(),
    status: text("status", { enum: IMPORT_STATUSES }).notNull(),
    createdAt: text("created_at").notNull(),
    appliedAt: text("applied_at"),
  },
  (table) => [
    check("import_artifacts_id_uuid_v7", uuidV7Text(table.id)),
    check("import_artifacts_dialect", sql`${table.dialect} IN ('POSTGRESQL', 'MYSQL')`),
    check("import_artifacts_original_hash_nonempty", sql`length(${table.originalHash}) > 0`),
    check("import_artifacts_parser_version_nonempty", sql`length(${table.parserVersion}) > 0`),
    check("import_artifacts_report_json", sql`json_valid(${table.report})`),
    check(
      "import_artifacts_status",
      sql`${table.status} IN ('PREVIEWED', 'APPLIED', 'CANCELLED', 'FAILED')`,
    ),
    check(
      "import_artifacts_generated_dbml",
      sql`${table.status} = 'FAILED' OR ${table.generatedDbml} IS NOT NULL`,
    ),
    check(
      "import_artifacts_applied_at",
      sql`(${table.status} = 'APPLIED' AND ${table.appliedAt} IS NOT NULL)
        OR (${table.status} <> 'APPLIED' AND ${table.appliedAt} IS NULL)`,
    ),
    check("import_artifacts_created_at_utc", utcIsoTimestamp(table.createdAt)),
    check(
      "import_artifacts_applied_at_utc",
      sql`${table.appliedAt} IS NULL OR (${utcIsoTimestamp(table.appliedAt)} AND ${table.appliedAt} >= ${table.createdAt})`,
    ),
    index("import_artifacts_project_created_idx").on(table.projectId, sql`${table.createdAt} DESC`),
  ],
);

export const visualCommandReceipts = sqliteTable(
  "visual_command_receipts",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    commandId: text("command_id").notNull(),
    commandKind: text("command_kind", { enum: VISUAL_COMMAND_KINDS }).notNull(),
    commandHash: text("command_hash").notNull(),
    expectedSchemaRevisionNo: integer("expected_schema_revision_no").notNull(),
    appliedSchemaRevisionNo: integer("applied_schema_revision_no").notNull(),
    appliedLayoutRevisionNo: integer("applied_layout_revision_no").notNull(),
    revisionCreated: integer("revision_created", { mode: "boolean" }).notNull(),
    layoutMigrated: integer("layout_migrated", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.commandId] }),
    check("visual_command_receipts_command_id_uuid", uuidText(table.commandId)),
    check(
      "visual_command_receipts_command_kind",
      sql`${table.commandKind} IN ('CREATE_TABLE', 'UPDATE_TABLE', 'RENAME_TABLE', 'DELETE_TABLE', 'CREATE_COLUMN', 'UPDATE_COLUMN', 'RENAME_COLUMN', 'REORDER_COLUMN', 'DELETE_COLUMN', 'CREATE_REFERENCE', 'UPDATE_REFERENCE', 'DELETE_REFERENCE', 'CREATE_INDEX', 'UPDATE_INDEX', 'DELETE_INDEX', 'CREATE_CHECK', 'UPDATE_CHECK', 'DELETE_CHECK', 'UPDATE_GROUP_MEMBERSHIP', 'UPDATE_DIAGRAM_VIEW')`,
    ),
    check(
      "visual_command_receipts_command_hash",
      sql`length(${table.commandHash}) = 64
        AND ${table.commandHash} = lower(${table.commandHash})
        AND ${table.commandHash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "visual_command_receipts_expected_schema_revision_no",
      sql`${table.expectedSchemaRevisionNo} > 0`,
    ),
    check(
      "visual_command_receipts_applied_schema_revision_no",
      sql`${table.appliedSchemaRevisionNo} > 0`,
    ),
    check(
      "visual_command_receipts_applied_layout_revision_no",
      sql`${table.appliedLayoutRevisionNo} >= 0`,
    ),
    check("visual_command_receipts_revision_created", sql`${table.revisionCreated} IN (0, 1)`),
    check("visual_command_receipts_layout_migrated", sql`${table.layoutMigrated} IN (0, 1)`),
    check(
      "visual_command_receipts_schema_revision_transition",
      sql`(${table.revisionCreated} = 1 AND ${table.appliedSchemaRevisionNo} = ${table.expectedSchemaRevisionNo} + 1)
        OR (${table.revisionCreated} = 0 AND ${table.appliedSchemaRevisionNo} = ${table.expectedSchemaRevisionNo})`,
    ),
    check("visual_command_receipts_created_at_utc", utcIsoTimestamp(table.createdAt)),
  ],
);

export const appMetadata = sqliteTable("app_metadata", {
  key: text("key").primaryKey().notNull(),
  value: text("value").notNull(),
});

export const sqliteSchema = {
  appMetadata,
  diagramLayouts,
  importArtifacts,
  projects,
  schemaRevisions,
  visualCommandReceipts,
} as const;
