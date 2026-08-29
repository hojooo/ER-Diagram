import { convertDbmlToSqlExport } from "../sql-export.js";
import { ProjectStateReadError, readProjectState } from "./project-state.js";
import type {
  CreateSqlExportApplicationOptions,
  ProjectSqlExport,
  SqlExportApplication,
  SqlExportApplicationError,
  SqlExportApplicationResult,
} from "./sql-export.js";
import type { ProjectState } from "./project.js";

export function createSqlExportApplication(
  options: CreateSqlExportApplicationOptions,
): SqlExportApplication {
  const convert = options.convert ?? convertDbmlToSqlExport;
  return {
    exportProject: async (command) => {
      let state: ProjectState;
      try {
        state = readProjectState(options.persistence, command.projectId);
      } catch (error) {
        if (!(error instanceof ProjectStateReadError)) throw error;
        return failure(
          error.reason === "NOT_FOUND"
            ? {
                code: "SQL_EXPORT_PROJECT_NOT_FOUND",
                message: "Project was not found.",
                projectId: command.projectId,
              }
            : {
                code: "SQL_EXPORT_STORAGE_INVARIANT_VIOLATION",
                message: "Stored project data failed an integrity check.",
                projectId: command.projectId,
              },
        );
      }

      if (state.project.schemaRevisionNo !== command.expectedSchemaRevisionNo) {
        return failure({
          code: "SQL_EXPORT_SCHEMA_REVISION_CONFLICT",
          message: "Project schema revision is stale.",
          projectId: command.projectId,
          expectedSchemaRevisionNo: command.expectedSchemaRevisionNo,
          currentSchemaRevisionNo: state.project.schemaRevisionNo,
        });
      }

      const revision =
        command.sourceSelection === "CURRENT_DRAFT"
          ? state.currentRevision
          : state.lastValidRevision;
      if (command.sourceSelection === "CURRENT_DRAFT" && revision?.validity !== "VALID") {
        return failure({
          code: "SQL_EXPORT_CURRENT_DRAFT_INVALID",
          message: "The current draft is invalid. Select the last-valid revision explicitly.",
          projectId: command.projectId,
        });
      }
      if (!revision) {
        return failure({
          code: "SQL_EXPORT_LAST_VALID_NOT_FOUND",
          message: "This project does not have a last-valid revision to export.",
          projectId: command.projectId,
        });
      }

      const conversion = await convert({
        primaryDialect: state.project.primaryDialect,
        targetDialect: state.project.primaryDialect,
        source: revision.source,
        filepath: "/main.dbml",
        hasPersistedLayout: state.project.layoutRevisionNo > 0,
      });
      const value: ProjectSqlExport = {
        sourceSelection: command.sourceSelection,
        revisionNo: revision.revisionNo,
        sourceHash: revision.sourceHash,
        report: conversion.report,
        candidate: conversion.candidate,
      };
      return { ok: true, value };
    },
  };
}

function failure(error: SqlExportApplicationError): SqlExportApplicationResult<never> {
  return { ok: false, error };
}
