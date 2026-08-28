import type { Diagnostic, PrimaryDialect } from "@er-diagram/contracts";
import type {
  OriginalSqlRetentionMode,
  SqlDataStatementHandling,
  SqlImportDataPolicyDecision,
} from "../sql-data-exclusion.js";
import type { ConversionReport, SqlImportConversionInput } from "../sql-import.js";
import type {
  ProjectPersistenceReader,
  ProjectPersistenceTransaction,
  ProjectState,
} from "./project.js";

export const SQL_IMPORT_PREVIEW_VERSION = 1 as const;

export type SqlImportArtifactStatus = "PREVIEWED" | "APPLIED" | "CANCELLED" | "FAILED";

export interface SqlImportPreviewEvidence {
  readonly projectId: string;
  readonly baseSchemaRevisionNo: number;
  readonly dialect: PrimaryDialect;
  readonly sourceHash: string;
  readonly candidateDbmlHash: string | null;
  readonly report: ConversionReport;
}

export interface SqlImportArtifactEnvelope {
  readonly previewVersion: typeof SQL_IMPORT_PREVIEW_VERSION;
  readonly evidence: SqlImportPreviewEvidence;
  readonly previewHash: string;
  readonly previewPolicy: SqlImportDataPolicyDecision;
  readonly appliedPolicy: SqlImportDataPolicyDecision | null;
  readonly originalSqlRetention: OriginalSqlRetentionMode;
}

export interface SqlImportArtifact {
  readonly id: string;
  readonly projectId: string;
  readonly dialect: PrimaryDialect;
  readonly originalSql: string | null;
  readonly originalHash: string;
  readonly generatedDbml: string | null;
  readonly parserVersion: string;
  readonly envelope: SqlImportArtifactEnvelope;
  readonly status: SqlImportArtifactStatus;
  readonly createdAt: string;
  readonly appliedAt: string | null;
}

export interface PreviewSqlImportCommand extends SqlImportConversionInput {
  readonly projectId: string;
  readonly expectedSchemaRevisionNo: number;
  readonly originalSqlRetention?: OriginalSqlRetentionMode;
}

export interface ApplySqlImportCommand {
  readonly projectId: string;
  readonly expectedSchemaRevisionNo: number;
  readonly artifactId: string;
  readonly previewHash: string;
  readonly source: string;
  readonly dataStatementHandling?: SqlDataStatementHandling;
}

export interface SqlImportPreviewMutation {
  readonly artifactId: string;
  readonly artifactStatus: "PREVIEWED" | "FAILED";
  readonly createdAt: string;
  readonly baseSchemaRevisionNo: number;
  readonly previewHash: string;
  readonly originalSqlRetention: OriginalSqlRetentionMode;
  readonly report: ConversionReport;
  readonly policy: SqlImportDataPolicyDecision;
  readonly candidate: {
    readonly dbml: string;
    readonly dbmlHash: string;
  } | null;
}

export interface SqlImportApplyMutation {
  readonly artifactId: string;
  readonly artifactStatus: "APPLIED";
  readonly previewHash: string;
  readonly appliedAt: string;
  readonly policy: SqlImportDataPolicyDecision;
  readonly state: ProjectState;
  readonly diagnostics: readonly Diagnostic[];
  readonly revisionCreated: true;
}

export type SqlImportApplicationError =
  | {
      readonly code: "SQL_IMPORT_PROJECT_NOT_FOUND";
      readonly message: string;
      readonly projectId: string;
    }
  | {
      readonly code: "SQL_IMPORT_ARTIFACT_NOT_FOUND";
      readonly message: string;
      readonly projectId: string;
      readonly artifactId: string;
    }
  | {
      readonly code: "SQL_IMPORT_SCHEMA_REVISION_CONFLICT";
      readonly message: string;
      readonly projectId: string;
      readonly expectedSchemaRevisionNo: number;
      readonly currentSchemaRevisionNo: number;
    }
  | {
      readonly code: "SQL_IMPORT_PREVIEW_MISMATCH";
      readonly message: string;
      readonly projectId: string;
      readonly artifactId: string;
    }
  | {
      readonly code: "SQL_IMPORT_ARTIFACT_ALREADY_APPLIED";
      readonly message: string;
      readonly projectId: string;
      readonly artifactId: string;
    }
  | {
      readonly code: "SQL_IMPORT_DIALECT_MISMATCH";
      readonly message: string;
      readonly projectId: string;
      readonly projectDialect: PrimaryDialect;
      readonly importDialect: PrimaryDialect;
    }
  | {
      readonly code: "SQL_IMPORT_CONVERSION_FAILED";
      readonly message: string;
      readonly projectId: string;
      readonly artifactId: string;
    }
  | {
      readonly code: "SQL_IMPORT_NO_SCHEMA_ELEMENTS";
      readonly message: string;
      readonly projectId: string;
      readonly artifactId: string;
    }
  | {
      readonly code: "SQL_IMPORT_DATA_CONFIRMATION_REQUIRED";
      readonly message: string;
      readonly projectId: string;
      readonly artifactId: string;
    }
  | {
      readonly code: "SQL_IMPORT_STORAGE_INVARIANT_VIOLATION";
      readonly message: string;
      readonly projectId: string;
    };

export type SqlImportApplicationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SqlImportApplicationError };

export interface SqlImportPersistenceReader extends ProjectPersistenceReader {
  getImportArtifact(projectId: string, artifactId: string): SqlImportArtifact | null;
}

export interface SqlImportPersistenceTransaction
  extends ProjectPersistenceTransaction,
    SqlImportPersistenceReader {
  insertImportArtifact(artifact: SqlImportArtifact): void;
  markImportArtifactApplied(artifact: SqlImportArtifact, expectedStatus: "PREVIEWED"): boolean;
}

export interface SqlImportPersistencePort extends SqlImportPersistenceReader {
  transaction<T>(operation: (transaction: SqlImportPersistenceTransaction) => T): T;
}

export interface SqlImportApplication {
  preview(
    command: PreviewSqlImportCommand,
  ): Promise<SqlImportApplicationResult<SqlImportPreviewMutation>>;
  apply(
    command: ApplySqlImportCommand,
  ): Promise<SqlImportApplicationResult<SqlImportApplyMutation>>;
}

export interface CreateSqlImportApplicationOptions {
  readonly persistence: SqlImportPersistencePort;
  readonly generateId: () => string;
  readonly now: () => string;
}

export class SqlImportPersistenceInvariantError extends Error {
  constructor(
    readonly projectId: string,
    message: string,
  ) {
    super(message);
    this.name = "SqlImportPersistenceInvariantError";
  }
}
