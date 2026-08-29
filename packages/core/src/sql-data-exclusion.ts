import {
  convertSqlImport,
  type SqlImportConversionInput,
  type SqlImportConversionResult,
} from "./sql-import.js";

export const SQL_DATA_POLICY_VERSION = 1 as const;

export type SqlDataStatementHandling = "REJECT" | "CONFIRM_DDL_ONLY";

export type OriginalSqlRetentionMode = "DISCARD" | "RETAIN";

export type SqlImportApplyReadiness =
  | "READY"
  | "CONVERSION_FAILED"
  | "NO_SCHEMA_ELEMENTS"
  | "DATA_EXCLUSION_CONFIRMATION_REQUIRED";

export interface SqlImportPreparationInput extends SqlImportConversionInput {
  readonly dataStatementHandling?: SqlDataStatementHandling;
  readonly originalSqlRetention?: OriginalSqlRetentionMode;
}

export interface SqlImportDataPolicyDecision {
  readonly policyVersion: typeof SQL_DATA_POLICY_VERSION;
  readonly dataStatementNos: number[];
  readonly dataHandling: "NOT_PRESENT" | "CONFIRMATION_REQUIRED" | "CONFIRMED_DDL_ONLY";
  readonly applyReadiness: SqlImportApplyReadiness;
}

export interface SqlImportArtifactSource {
  readonly retention: OriginalSqlRetentionMode;
  readonly originalHash: string;
  readonly originalSql: string | null;
}

export interface PreparedSqlImport {
  readonly conversion: SqlImportConversionResult;
  readonly policy: SqlImportDataPolicyDecision;
  readonly artifactSource: SqlImportArtifactSource;
}

export async function prepareSqlImportForApply(
  input: SqlImportPreparationInput,
): Promise<PreparedSqlImport> {
  const conversion = await convertSqlImport(input);
  const originalSqlRetention = input.originalSqlRetention ?? "DISCARD";

  return {
    conversion,
    policy: evaluateSqlImportDataPolicy(conversion, input.dataStatementHandling),
    artifactSource: {
      retention: originalSqlRetention,
      originalHash: conversion.report.sourceHash,
      originalSql: originalSqlRetention === "RETAIN" ? input.source : null,
    },
  };
}

export function evaluateSqlImportDataPolicy(
  conversion: SqlImportConversionResult,
  dataStatementHandling: SqlDataStatementHandling = "REJECT",
): SqlImportDataPolicyDecision {
  const dataStatementNos = conversion.report.statements
    .filter(({ kind }) => kind === "DML" || kind === "COPY")
    .map(({ statementNo }) => statementNo);
  const hasDataStatements = dataStatementNos.length > 0;

  return {
    policyVersion: SQL_DATA_POLICY_VERSION,
    dataStatementNos,
    dataHandling: dataHandling(hasDataStatements, dataStatementHandling),
    applyReadiness: applyReadiness(conversion, hasDataStatements, dataStatementHandling),
  };
}

function dataHandling(
  hasDataStatements: boolean,
  handling: SqlDataStatementHandling,
): SqlImportDataPolicyDecision["dataHandling"] {
  if (!hasDataStatements) return "NOT_PRESENT";
  return handling === "CONFIRM_DDL_ONLY" ? "CONFIRMED_DDL_ONLY" : "CONFIRMATION_REQUIRED";
}

function applyReadiness(
  conversion: SqlImportConversionResult,
  hasDataStatements: boolean,
  handling: SqlDataStatementHandling,
): SqlImportApplyReadiness {
  if (!conversion.ok) return "CONVERSION_FAILED";

  const hasSchemaElements =
    conversion.candidate.graph.tables.length + conversion.candidate.graph.enums.length > 0;
  if (!hasSchemaElements) return "NO_SCHEMA_ELEMENTS";

  if (hasDataStatements && handling !== "CONFIRM_DDL_ONLY") {
    return "DATA_EXCLUSION_CONFIRMATION_REQUIRED";
  }
  return "READY";
}
