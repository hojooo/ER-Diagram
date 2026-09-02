import { createHash } from "node:crypto";

export const P0_RELEASE_EVIDENCE_VERSION = 1 as const;
export const P0_RELEASE_VERSION = "0.1.0" as const;
export const P0_RELEASE_TAG = "v0.1.0" as const;
export const P0_RELEASE_IMAGE = "ghcr.io/hojooo/er-diagram:0.1.0" as const;

export type P0ReleaseAssertionId =
  | "APP_METADATA_AND_MIGRATIONS"
  | "BACKUP_WHILE_RUNNING"
  | "IMAGE_SOURCE_MAPPING"
  | "IMPORT_ARTIFACT_RETAINED_SQL"
  | "INVALID_DRAFT_LAST_VALID"
  | "LAYOUT_PRESERVED"
  | "ORBSTACK_CONTEXT"
  | "PROJECT_AND_REVISION_IDENTITY"
  | "RESTORE_PLAN_APPLIED"
  | "SOURCE_VOLUME_REMOVED"
  | "TARGET_RESTART"
  | "VISUAL_RECEIPT";

export interface P0ReleaseEvidenceProfile {
  readonly evidenceVersion: 1;
  readonly releaseState: "P0_RELEASE_CANDIDATE";
  readonly release: {
    readonly version: "0.1.0";
    readonly tag: "v0.1.0";
    readonly imageReference: "ghcr.io/hojooo/er-diagram:0.1.0";
    readonly requiredDockerContext: "orbstack";
  };
  readonly mapping: {
    readonly imageVersionFromTag: "REMOVE_SINGLE_V_PREFIX";
    readonly releaseRevision: "FULL_LOWERCASE_COMMIT_SHA";
    readonly workspaceVersionOwnsRelease: false;
  };
  readonly inventory: {
    readonly projects: 2;
    readonly schemaRevisions: 4;
    readonly diagramLayouts: 1;
    readonly importArtifacts: 1;
    readonly visualCommandReceipts: 1;
    readonly appMetadata: 1;
    readonly drizzleMigrations: 2;
  };
  readonly evidence: {
    readonly requiredFields: readonly string[];
    readonly forbiddenContent: readonly string[];
  };
  readonly assertions: readonly P0ReleaseAssertionId[];
}

const assertions = [
  "APP_METADATA_AND_MIGRATIONS",
  "BACKUP_WHILE_RUNNING",
  "IMAGE_SOURCE_MAPPING",
  "IMPORT_ARTIFACT_RETAINED_SQL",
  "INVALID_DRAFT_LAST_VALID",
  "LAYOUT_PRESERVED",
  "ORBSTACK_CONTEXT",
  "PROJECT_AND_REVISION_IDENTITY",
  "RESTORE_PLAN_APPLIED",
  "SOURCE_VOLUME_REMOVED",
  "TARGET_RESTART",
  "VISUAL_RECEIPT",
] as const satisfies readonly P0ReleaseAssertionId[];

export const p0ReleaseEvidenceProfile = {
  evidenceVersion: P0_RELEASE_EVIDENCE_VERSION,
  releaseState: "P0_RELEASE_CANDIDATE",
  release: {
    version: P0_RELEASE_VERSION,
    tag: P0_RELEASE_TAG,
    imageReference: P0_RELEASE_IMAGE,
    requiredDockerContext: "orbstack",
  },
  mapping: {
    imageVersionFromTag: "REMOVE_SINGLE_V_PREFIX",
    releaseRevision: "FULL_LOWERCASE_COMMIT_SHA",
    workspaceVersionOwnsRelease: false,
  },
  inventory: {
    projects: 2,
    schemaRevisions: 4,
    diagramLayouts: 1,
    importArtifacts: 1,
    visualCommandReceipts: 1,
    appMetadata: 1,
    drizzleMigrations: 2,
  },
  evidence: {
    requiredFields: [
      "assertions",
      "backupHash",
      "candidateDatabaseSha256",
      "evidenceVersion",
      "imageConfigDigest",
      "imageReference",
      "inventory",
      "profileHash",
      "recoveryPlanHash",
      "releaseState",
      "revision",
      "sourceDatabaseSha256",
      "version",
    ],
    forbiddenContent: [
      "CONTAINER_OR_VOLUME_NAME",
      "FILESYSTEM_PATH",
      "NATIVE_ERROR",
      "SOURCE_TEXT",
      "SQL_TEXT",
    ],
  },
  assertions,
} as const satisfies P0ReleaseEvidenceProfile;

export const P0_RELEASE_EVIDENCE_PROFILE_HASH = createHash("sha256")
  .update(JSON.stringify(p0ReleaseEvidenceProfile), "utf8")
  .digest("hex");
