import type { SqlExportConversionResult } from "../sql-export.js";
import type { ProjectPersistenceReader } from "./project.js";

export type SqlExportSourceSelection = "CURRENT_DRAFT" | "LAST_VALID";

export interface ExportProjectSqlCommand {
  readonly projectId: string;
  readonly expectedSchemaRevisionNo: number;
  readonly sourceSelection: SqlExportSourceSelection;
}

export interface ProjectSqlExport {
  readonly sourceSelection: SqlExportSourceSelection;
  readonly revisionNo: number;
  readonly sourceHash: string;
  readonly report: SqlExportConversionResult["report"];
  readonly candidate: SqlExportConversionResult["candidate"];
}

export type SqlExportApplicationError =
  | {
      readonly code: "SQL_EXPORT_PROJECT_NOT_FOUND";
      readonly message: string;
      readonly projectId: string;
    }
  | {
      readonly code: "SQL_EXPORT_SCHEMA_REVISION_CONFLICT";
      readonly message: string;
      readonly projectId: string;
      readonly expectedSchemaRevisionNo: number;
      readonly currentSchemaRevisionNo: number;
    }
  | {
      readonly code: "SQL_EXPORT_CURRENT_DRAFT_INVALID";
      readonly message: string;
      readonly projectId: string;
    }
  | {
      readonly code: "SQL_EXPORT_LAST_VALID_NOT_FOUND";
      readonly message: string;
      readonly projectId: string;
    }
  | {
      readonly code: "SQL_EXPORT_STORAGE_INVARIANT_VIOLATION";
      readonly message: string;
      readonly projectId: string;
    };

export type SqlExportApplicationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SqlExportApplicationError };

export interface SqlExportApplication {
  exportProject(
    command: ExportProjectSqlCommand,
  ): Promise<SqlExportApplicationResult<ProjectSqlExport>>;
}

export interface CreateSqlExportApplicationOptions {
  readonly persistence: ProjectPersistenceReader;
  readonly convert?: typeof import("../sql-export.js").convertDbmlToSqlExport;
}
