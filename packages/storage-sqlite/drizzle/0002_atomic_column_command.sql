CREATE TABLE "__new_visual_command_receipts" (
  "project_id" TEXT NOT NULL,
  "command_id" TEXT NOT NULL,
  "command_kind" TEXT NOT NULL,
  "command_hash" TEXT NOT NULL,
  "expected_schema_revision_no" INTEGER NOT NULL,
  "applied_schema_revision_no" INTEGER NOT NULL,
  "applied_layout_revision_no" INTEGER NOT NULL,
  "revision_created" INTEGER NOT NULL,
  "layout_migrated" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL,
  CONSTRAINT "visual_command_receipts_pk" PRIMARY KEY ("project_id", "command_id"),
  CONSTRAINT "visual_command_receipts_project_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE CASCADE,
  CONSTRAINT "visual_command_receipts_command_id_uuid" CHECK (
    length("command_id") = 36
    AND "command_id" = lower("command_id")
    AND substr("command_id", 9, 1) = '-'
    AND substr("command_id", 14, 1) = '-'
    AND substr("command_id", 19, 1) = '-'
    AND substr("command_id", 24, 1) = '-'
    AND length(replace("command_id", '-', '')) = 32
    AND replace("command_id", '-', '') NOT GLOB '*[^0-9a-f]*'
    AND substr("command_id", 15, 1) IN ('1', '2', '3', '4', '5', '6', '7', '8')
    AND substr("command_id", 20, 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT "visual_command_receipts_command_kind" CHECK (
    "command_kind" IN (
      'CREATE_TABLE', 'UPDATE_TABLE', 'RENAME_TABLE', 'DELETE_TABLE',
      'CREATE_COLUMN', 'ALTER_COLUMN', 'UPDATE_COLUMN', 'RENAME_COLUMN', 'REORDER_COLUMN',
      'DELETE_COLUMN', 'CREATE_REFERENCE', 'UPDATE_REFERENCE', 'DELETE_REFERENCE',
      'CREATE_INDEX', 'UPDATE_INDEX', 'DELETE_INDEX',
      'CREATE_CHECK', 'UPDATE_CHECK', 'DELETE_CHECK',
      'UPDATE_GROUP_MEMBERSHIP', 'UPDATE_DIAGRAM_VIEW'
    )
  ),
  CONSTRAINT "visual_command_receipts_command_hash" CHECK (
    length("command_hash") = 64
    AND "command_hash" = lower("command_hash")
    AND "command_hash" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT "visual_command_receipts_expected_schema_revision_no"
    CHECK ("expected_schema_revision_no" > 0),
  CONSTRAINT "visual_command_receipts_applied_schema_revision_no"
    CHECK ("applied_schema_revision_no" > 0),
  CONSTRAINT "visual_command_receipts_applied_layout_revision_no"
    CHECK ("applied_layout_revision_no" >= 0),
  CONSTRAINT "visual_command_receipts_revision_created" CHECK ("revision_created" IN (0, 1)),
  CONSTRAINT "visual_command_receipts_layout_migrated" CHECK ("layout_migrated" IN (0, 1)),
  CONSTRAINT "visual_command_receipts_schema_revision_transition" CHECK (
    ("revision_created" = 1 AND "applied_schema_revision_no" = "expected_schema_revision_no" + 1)
    OR ("revision_created" = 0 AND "applied_schema_revision_no" = "expected_schema_revision_no")
  ),
  CONSTRAINT "visual_command_receipts_created_at_utc" CHECK (
    length("created_at") = 24
    AND "created_at" GLOB '????-??-??T??:??:??.???Z'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', "created_at") = "created_at"
  )
) STRICT;
--> statement-breakpoint
INSERT INTO "__new_visual_command_receipts" (
  "project_id", "command_id", "command_kind", "command_hash",
  "expected_schema_revision_no", "applied_schema_revision_no",
  "applied_layout_revision_no", "revision_created", "layout_migrated", "created_at"
)
SELECT
  "project_id", "command_id", "command_kind", "command_hash",
  "expected_schema_revision_no", "applied_schema_revision_no",
  "applied_layout_revision_no", "revision_created", "layout_migrated", "created_at"
FROM "visual_command_receipts";
--> statement-breakpoint
DROP TABLE "visual_command_receipts";
--> statement-breakpoint
ALTER TABLE "__new_visual_command_receipts" RENAME TO "visual_command_receipts";
--> statement-breakpoint
UPDATE "app_metadata" SET "value" = '3' WHERE "key" = 'storage_schema_version';
