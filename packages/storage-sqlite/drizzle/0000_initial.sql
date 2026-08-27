CREATE TABLE "projects" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "primary_dialect" TEXT NOT NULL,
  "draft_source" TEXT NOT NULL,
  "draft_hash" TEXT NOT NULL,
  "last_valid_revision_id" TEXT,
  "parser_version" TEXT NOT NULL,
  "schema_revision_no" INTEGER NOT NULL DEFAULT 0,
  "layout_revision_no" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  CONSTRAINT "projects_id_uuid_v7" CHECK (
    length("id") = 36
    AND "id" = lower("id")
    AND substr("id", 9, 1) = '-'
    AND substr("id", 14, 1) = '-'
    AND substr("id", 19, 1) = '-'
    AND substr("id", 24, 1) = '-'
    AND length(replace("id", '-', '')) = 32
    AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*'
    AND substr("id", 15, 1) = '7'
    AND substr("id", 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT "projects_name_nonempty" CHECK (length(trim("name")) > 0),
  CONSTRAINT "projects_primary_dialect" CHECK ("primary_dialect" IN ('POSTGRESQL', 'MYSQL')),
  CONSTRAINT "projects_draft_hash_nonempty" CHECK (length("draft_hash") > 0),
  CONSTRAINT "projects_parser_version_nonempty" CHECK (length("parser_version") > 0),
  CONSTRAINT "projects_schema_revision_no" CHECK ("schema_revision_no" >= 0),
  CONSTRAINT "projects_layout_revision_no" CHECK ("layout_revision_no" >= 0),
  CONSTRAINT "projects_created_at_utc" CHECK (
    length("created_at") = 24
    AND "created_at" GLOB '????-??-??T??:??:??.???Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") = "created_at"
  ),
  CONSTRAINT "projects_updated_at_utc" CHECK (
    length("updated_at") = 24
    AND "updated_at" GLOB '????-??-??T??:??:??.???Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', "updated_at") = "updated_at"
  ),
  CONSTRAINT "projects_updated_after_created" CHECK ("updated_at" >= "created_at"),
  CONSTRAINT "projects_last_valid_revision_fk"
    FOREIGN KEY ("id", "last_valid_revision_id")
    REFERENCES "schema_revisions" ("project_id", "id")
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
) STRICT;
--> statement-breakpoint
CREATE TABLE "schema_revisions" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "project_id" TEXT NOT NULL,
  "revision_no" INTEGER NOT NULL,
  "source" TEXT NOT NULL,
  "source_hash" TEXT NOT NULL,
  "validity" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "parser_version" TEXT NOT NULL,
  "diagnostic_summary_json" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  CONSTRAINT "schema_revisions_id_uuid_v7" CHECK (
    length("id") = 36
    AND "id" = lower("id")
    AND substr("id", 9, 1) = '-'
    AND substr("id", 14, 1) = '-'
    AND substr("id", 19, 1) = '-'
    AND substr("id", 24, 1) = '-'
    AND length(replace("id", '-', '')) = 32
    AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*'
    AND substr("id", 15, 1) = '7'
    AND substr("id", 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT "schema_revisions_revision_no" CHECK ("revision_no" > 0),
  CONSTRAINT "schema_revisions_source_hash_nonempty" CHECK (length("source_hash") > 0),
  CONSTRAINT "schema_revisions_validity" CHECK ("validity" IN ('VALID', 'INVALID')),
  CONSTRAINT "schema_revisions_origin" CHECK (
    "origin" IN ('SOURCE_EDIT', 'VISUAL_COMMAND', 'SQL_IMPORT', 'RESTORE', 'PARSER_MIGRATION')
  ),
  CONSTRAINT "schema_revisions_parser_version_nonempty" CHECK (length("parser_version") > 0),
  CONSTRAINT "schema_revisions_diagnostic_summary_json" CHECK (json_valid("diagnostic_summary_json")),
  CONSTRAINT "schema_revisions_created_at_utc" CHECK (
    length("created_at") = 24
    AND "created_at" GLOB '????-??-??T??:??:??.???Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") = "created_at"
  ),
  CONSTRAINT "schema_revisions_project_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
  CONSTRAINT "schema_revisions_project_revision_uq" UNIQUE ("project_id", "revision_no"),
  CONSTRAINT "schema_revisions_project_id_uq" UNIQUE ("project_id", "id")
) STRICT;
--> statement-breakpoint
CREATE INDEX "schema_revisions_non_checkpoint_idx"
  ON "schema_revisions" ("project_id", "revision_no" DESC)
  WHERE "origin" IN ('SOURCE_EDIT', 'VISUAL_COMMAND');
--> statement-breakpoint
CREATE TABLE "diagram_layouts" (
  "project_id" TEXT NOT NULL,
  "view_key" TEXT NOT NULL,
  "positions_json" TEXT NOT NULL,
  "collapsed_group_keys_json" TEXT NOT NULL,
  "hidden_element_keys_json" TEXT NOT NULL,
  "viewport_json" TEXT NOT NULL,
  "detail_level" TEXT NOT NULL,
  "base_schema_hash" TEXT NOT NULL,
  "revision_no" INTEGER NOT NULL,
  CONSTRAINT "diagram_layouts_pk" PRIMARY KEY ("project_id", "view_key"),
  CONSTRAINT "diagram_layouts_project_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
  CONSTRAINT "diagram_layouts_view_key_nonempty" CHECK (length("view_key") > 0),
  CONSTRAINT "diagram_layouts_positions_json" CHECK (json_valid("positions_json")),
  CONSTRAINT "diagram_layouts_collapsed_group_keys_json" CHECK (json_valid("collapsed_group_keys_json")),
  CONSTRAINT "diagram_layouts_hidden_element_keys_json" CHECK (json_valid("hidden_element_keys_json")),
  CONSTRAINT "diagram_layouts_viewport_json" CHECK (json_valid("viewport_json")),
  CONSTRAINT "diagram_layouts_detail_level" CHECK ("detail_level" IN ('NAME_ONLY', 'KEYS_ONLY', 'FULL')),
  CONSTRAINT "diagram_layouts_base_schema_hash_nonempty" CHECK (length("base_schema_hash") > 0),
  CONSTRAINT "diagram_layouts_revision_no" CHECK ("revision_no" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE "import_artifacts" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "project_id" TEXT NOT NULL,
  "dialect" TEXT NOT NULL,
  "original_sql" TEXT,
  "original_hash" TEXT NOT NULL,
  "generated_dbml" TEXT,
  "parser_version" TEXT NOT NULL,
  "report_json" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "applied_at" TEXT,
  CONSTRAINT "import_artifacts_id_uuid_v7" CHECK (
    length("id") = 36
    AND "id" = lower("id")
    AND substr("id", 9, 1) = '-'
    AND substr("id", 14, 1) = '-'
    AND substr("id", 19, 1) = '-'
    AND substr("id", 24, 1) = '-'
    AND length(replace("id", '-', '')) = 32
    AND replace("id", '-', '') NOT GLOB '*[^0-9a-f]*'
    AND substr("id", 15, 1) = '7'
    AND substr("id", 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT "import_artifacts_project_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
  CONSTRAINT "import_artifacts_dialect" CHECK ("dialect" IN ('POSTGRESQL', 'MYSQL')),
  CONSTRAINT "import_artifacts_original_hash_nonempty" CHECK (length("original_hash") > 0),
  CONSTRAINT "import_artifacts_parser_version_nonempty" CHECK (length("parser_version") > 0),
  CONSTRAINT "import_artifacts_report_json" CHECK (json_valid("report_json")),
  CONSTRAINT "import_artifacts_status" CHECK (
    "status" IN ('PREVIEWED', 'APPLIED', 'CANCELLED', 'FAILED')
  ),
  CONSTRAINT "import_artifacts_generated_dbml" CHECK (
    "status" = 'FAILED' OR "generated_dbml" IS NOT NULL
  ),
  CONSTRAINT "import_artifacts_applied_at" CHECK (
    ("status" = 'APPLIED' AND "applied_at" IS NOT NULL)
    OR ("status" <> 'APPLIED' AND "applied_at" IS NULL)
  ),
  CONSTRAINT "import_artifacts_created_at_utc" CHECK (
    length("created_at") = 24
    AND "created_at" GLOB '????-??-??T??:??:??.???Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") = "created_at"
  ),
  CONSTRAINT "import_artifacts_applied_at_utc" CHECK (
    "applied_at" IS NULL OR (
      length("applied_at") = 24
      AND "applied_at" GLOB '????-??-??T??:??:??.???Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', "applied_at") = "applied_at"
      AND "applied_at" >= "created_at"
    )
  )
) STRICT;
--> statement-breakpoint
CREATE INDEX "import_artifacts_project_created_idx"
  ON "import_artifacts" ("project_id", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE "app_metadata" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "value" TEXT NOT NULL
) STRICT;
--> statement-breakpoint
INSERT INTO "app_metadata" ("key", "value") VALUES ('storage_schema_version', '1');
