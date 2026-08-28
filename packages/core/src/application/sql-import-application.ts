import { sha256Utf8 } from "../hash.js";
import { DBML_PARSER_VERSION } from "../schema-graph.js";
import { canonicalStringify } from "../schema-semantics.js";
import {
  evaluateSqlImportDataPolicy,
  type OriginalSqlRetentionMode,
  type SqlImportDataPolicyDecision,
} from "../sql-data-exclusion.js";
import { convertSqlImport, type SqlImportConversionResult } from "../sql-import.js";
import type { Project, SchemaRevision } from "./project.js";
import {
  ProjectStateReadError,
  pruneProjectRevisions,
  readProjectState,
  summarizeDiagnostics,
} from "./project-state.js";
import {
  type ApplySqlImportCommand,
  type CreateProjectFromSqlImportCommand,
  type CreateSqlImportApplicationOptions,
  isCreateProjectSqlImportEnvelope,
  type PreviewStandaloneSqlImportCommand,
  type PreviewSqlImportCommand,
  SQL_IMPORT_CREATE_PREVIEW_VERSION,
  SQL_IMPORT_PREVIEW_VERSION,
  type SqlImportApplication,
  type SqlImportApplicationError,
  type SqlImportApplicationResult,
  type SqlImportApplyMutation,
  type SqlImportArtifact,
  type SqlImportCreateArtifactEnvelope,
  type SqlImportCreatePreviewEvidence,
  SqlImportPersistenceInvariantError,
  type SqlImportPersistencePort,
  type SqlImportPersistenceReader,
  type SqlImportPersistenceTransaction,
  type SqlImportPreviewEvidence,
  type SqlImportPreviewMutation,
  type SqlImportStandalonePreviewMutation,
} from "./sql-import.js";

class ExpectedSqlImportFailure extends Error {
  constructor(readonly applicationError: SqlImportApplicationError) {
    super(applicationError.message);
    this.name = "ExpectedSqlImportFailure";
  }
}

export function createSqlImportApplication(
  options: CreateSqlImportApplicationOptions,
): SqlImportApplication {
  return {
    previewStandalone: (command) => previewStandaloneSqlImport(command),
    createProjectFromPreview: (command) => createProjectFromSqlImport(options, command),
    preview: (command) => previewSqlImport(options, command),
    apply: (command) => applySqlImport(options, command),
  };
}

export async function computeSqlImportCreatePreviewHash(input: {
  readonly evidence: SqlImportCreatePreviewEvidence;
  readonly previewPolicy: SqlImportDataPolicyDecision;
  readonly originalSqlRetention: OriginalSqlRetentionMode;
}): Promise<string> {
  return sha256Utf8(sqlImportCreatePreviewHashPreimage(input));
}

export function sqlImportCreatePreviewHashPreimage(input: {
  readonly evidence: SqlImportCreatePreviewEvidence;
  readonly previewPolicy: SqlImportDataPolicyDecision;
  readonly originalSqlRetention: OriginalSqlRetentionMode;
}): string {
  return canonicalStringify({
    operation: "CREATE_PROJECT",
    previewVersion: SQL_IMPORT_CREATE_PREVIEW_VERSION,
    evidence: input.evidence,
    previewPolicy: input.previewPolicy,
    originalSqlRetention: input.originalSqlRetention,
  });
}

export async function computeSqlImportPreviewHash(input: {
  readonly evidence: SqlImportPreviewEvidence;
  readonly previewPolicy: SqlImportDataPolicyDecision;
  readonly originalSqlRetention: OriginalSqlRetentionMode;
}): Promise<string> {
  return sha256Utf8(sqlImportPreviewHashPreimage(input));
}

export function sqlImportPreviewHashPreimage(input: {
  readonly evidence: SqlImportPreviewEvidence;
  readonly previewPolicy: SqlImportDataPolicyDecision;
  readonly originalSqlRetention: OriginalSqlRetentionMode;
}): string {
  return canonicalStringify({
    previewVersion: SQL_IMPORT_PREVIEW_VERSION,
    evidence: input.evidence,
    previewPolicy: input.previewPolicy,
    originalSqlRetention: input.originalSqlRetention,
  });
}

interface PreparedStandalonePreview {
  readonly conversion: SqlImportConversionResult;
  readonly evidence: SqlImportCreatePreviewEvidence;
  readonly previewPolicy: SqlImportDataPolicyDecision;
  readonly previewHash: string;
  readonly originalSqlRetention: OriginalSqlRetentionMode;
}

async function previewStandaloneSqlImport(
  command: PreviewStandaloneSqlImportCommand,
): Promise<SqlImportApplicationResult<SqlImportStandalonePreviewMutation>> {
  const prepared = await prepareStandalonePreview(command);
  return success(toStandalonePreviewMutation(prepared));
}

async function createProjectFromSqlImport(
  options: CreateSqlImportApplicationOptions,
  command: CreateProjectFromSqlImportCommand,
): Promise<SqlImportApplicationResult<SqlImportApplyMutation>> {
  const name = normalizeProjectName(command.name);
  if (!name) {
    return failure({
      code: "SQL_IMPORT_PROJECT_NAME_INVALID",
      message: "Project name must not be blank.",
    });
  }

  const prepared = await prepareStandalonePreview({
    dialect: command.primaryDialect,
    source: command.source,
    ...(command.filepath === undefined ? {} : { filepath: command.filepath }),
    ...(command.originalSqlRetention === undefined
      ? {}
      : { originalSqlRetention: command.originalSqlRetention }),
  });
  if (prepared.previewHash !== command.previewHash) {
    return failure({
      code: "SQL_IMPORT_CREATE_PREVIEW_MISMATCH",
      message: "SQL import preview evidence no longer matches the create request.",
    });
  }
  if (!prepared.conversion.ok) {
    return failure({
      code: "SQL_IMPORT_CREATE_CONVERSION_FAILED",
      message: "A failed SQL import preview cannot create a project.",
    });
  }

  const appliedPolicy = evaluateSqlImportDataPolicy(
    prepared.conversion,
    command.dataStatementHandling,
  );
  const readinessFailure = createApplyReadinessError(appliedPolicy);
  if (readinessFailure) return failure(readinessFailure);

  const projectId = options.generateId();
  const revisionId = options.generateId();
  const artifactId = options.generateId();
  const appliedAt = options.now();
  const diagnostics = prepared.conversion.candidate.graph.diagnostics;
  const revision: SchemaRevision = {
    id: revisionId,
    projectId,
    revisionNo: 1,
    source: prepared.conversion.candidate.dbml,
    sourceHash: prepared.conversion.candidate.dbmlHash,
    validity: "VALID",
    origin: "SQL_IMPORT",
    parserVersion: DBML_PARSER_VERSION,
    diagnosticSummary: summarizeDiagnostics(diagnostics),
    createdAt: appliedAt,
  };
  const project: Project = {
    id: projectId,
    name,
    primaryDialect: command.primaryDialect,
    draftSource: revision.source,
    draftHash: revision.sourceHash,
    lastValidRevisionId: revision.id,
    parserVersion: revision.parserVersion,
    schemaRevisionNo: 1,
    layoutRevisionNo: 0,
    createdAt: appliedAt,
    updatedAt: appliedAt,
  };
  const envelope: SqlImportCreateArtifactEnvelope = {
    operation: "CREATE_PROJECT",
    previewVersion: SQL_IMPORT_CREATE_PREVIEW_VERSION,
    evidence: prepared.evidence,
    previewHash: prepared.previewHash,
    previewPolicy: prepared.previewPolicy,
    appliedPolicy,
    originalSqlRetention: prepared.originalSqlRetention,
  };
  const artifact: SqlImportArtifact = {
    id: artifactId,
    projectId,
    dialect: command.primaryDialect,
    originalSql: prepared.originalSqlRetention === "RETAIN" ? command.source : null,
    originalHash: prepared.evidence.sourceHash,
    generatedDbml: revision.source,
    parserVersion: DBML_PARSER_VERSION,
    envelope,
    status: "APPLIED",
    createdAt: appliedAt,
    appliedAt,
  };

  return transactionResult(options.persistence, projectId, (transaction) => {
    transaction.insertProject(project);
    transaction.insertRevision(revision);
    transaction.insertImportArtifact(artifact);
    return {
      artifactId,
      artifactStatus: "APPLIED" as const,
      previewHash: prepared.previewHash,
      appliedAt,
      policy: appliedPolicy,
      state: readProjectState(transaction, projectId),
      diagnostics,
      revisionCreated: true as const,
    };
  });
}

async function prepareStandalonePreview(
  command: PreviewStandaloneSqlImportCommand,
): Promise<PreparedStandalonePreview> {
  const originalSqlRetention = command.originalSqlRetention ?? "DISCARD";
  const conversion = await convertSqlImport(command);
  const previewPolicy = evaluateSqlImportDataPolicy(conversion);
  const evidence: SqlImportCreatePreviewEvidence = {
    dialect: command.dialect,
    sourceHash: conversion.report.sourceHash,
    candidateDbmlHash: conversion.ok ? conversion.candidate.dbmlHash : null,
    report: conversion.report,
  };
  const previewHash = await computeSqlImportCreatePreviewHash({
    evidence,
    previewPolicy,
    originalSqlRetention,
  });
  return { conversion, evidence, previewPolicy, previewHash, originalSqlRetention };
}

function toStandalonePreviewMutation(
  prepared: PreparedStandalonePreview,
): SqlImportStandalonePreviewMutation {
  return {
    previewStatus: prepared.conversion.ok ? "PREVIEWED" : "FAILED",
    previewHash: prepared.previewHash,
    originalSqlRetention: prepared.originalSqlRetention,
    report: prepared.conversion.report,
    policy: prepared.previewPolicy,
    candidate: prepared.conversion.ok
      ? {
          dbml: prepared.conversion.candidate.dbml,
          dbmlHash: prepared.conversion.candidate.dbmlHash,
        }
      : null,
  };
}

async function previewSqlImport(
  options: CreateSqlImportApplicationOptions,
  command: PreviewSqlImportCommand,
): Promise<SqlImportApplicationResult<SqlImportPreviewMutation>> {
  const preflight = readResult(command.projectId, () => {
    const state = readProjectState(options.persistence, command.projectId);
    expectRevision(state.project, command.expectedSchemaRevisionNo);
    expectDialect(state.project, command.dialect);
    return state;
  });
  if (!preflight.ok) return preflight;

  const retention = command.originalSqlRetention ?? "DISCARD";
  const conversion = await convertSqlImport(command);
  const previewPolicy = evaluateSqlImportDataPolicy(conversion);
  const evidence = createEvidence(
    command.projectId,
    command.expectedSchemaRevisionNo,
    command.dialect,
    conversion,
  );
  const previewHash = await computeSqlImportPreviewHash({
    evidence,
    previewPolicy,
    originalSqlRetention: retention,
  });
  const artifactId = options.generateId();
  const createdAt = options.now();
  const artifact: SqlImportArtifact = {
    id: artifactId,
    projectId: command.projectId,
    dialect: command.dialect,
    originalSql: retention === "RETAIN" ? command.source : null,
    originalHash: conversion.report.sourceHash,
    generatedDbml: conversion.ok ? conversion.candidate.dbml : null,
    parserVersion: DBML_PARSER_VERSION,
    envelope: {
      previewVersion: SQL_IMPORT_PREVIEW_VERSION,
      evidence,
      previewHash,
      previewPolicy,
      appliedPolicy: null,
      originalSqlRetention: retention,
    },
    status: conversion.ok ? "PREVIEWED" : "FAILED",
    createdAt,
    appliedAt: null,
  };

  return transactionResult(options.persistence, command.projectId, (transaction) => {
    const current = readProjectState(transaction, command.projectId);
    expectRevision(current.project, command.expectedSchemaRevisionNo);
    expectDialect(current.project, command.dialect);
    transaction.insertImportArtifact(artifact);
    return toPreviewMutation(artifact);
  });
}

async function applySqlImport(
  options: CreateSqlImportApplicationOptions,
  command: ApplySqlImportCommand,
): Promise<SqlImportApplicationResult<SqlImportApplyMutation>> {
  const preflight = readResult(command.projectId, () => {
    const state = readProjectState(options.persistence, command.projectId);
    expectRevision(state.project, command.expectedSchemaRevisionNo);
    const artifact = requireArtifact(options.persistence, command.projectId, command.artifactId);
    return { state, artifact };
  });
  if (!preflight.ok) return preflight;

  const integrityFailure = await validateArtifactIntegrity(preflight.value.artifact);
  if (integrityFailure) return failure(integrityFailure);
  const artifact = preflight.value.artifact;
  if (isCreateProjectSqlImportEnvelope(artifact.envelope)) {
    return failure(previewMismatch(command.projectId, command.artifactId));
  }
  if (artifact.status === "APPLIED") {
    return failure(alreadyApplied(command.projectId, command.artifactId));
  }
  if (artifact.status === "FAILED") {
    return failure(conversionFailed(command.projectId, command.artifactId));
  }
  if (artifact.status !== "PREVIEWED") {
    return failure(previewMismatch(command.projectId, command.artifactId));
  }
  if (
    artifact.envelope.evidence.baseSchemaRevisionNo !== command.expectedSchemaRevisionNo ||
    artifact.envelope.previewHash !== command.previewHash
  ) {
    return failure(previewMismatch(command.projectId, command.artifactId));
  }
  const suppliedSourceHash = await sha256Utf8(command.source);
  if (suppliedSourceHash !== artifact.originalHash) {
    return failure(previewMismatch(command.projectId, command.artifactId));
  }

  const conversion = await convertSqlImport({
    dialect: artifact.dialect,
    source: command.source,
    filepath: artifact.envelope.evidence.report.sourceFilepath,
  });
  const previewPolicy = evaluateSqlImportDataPolicy(conversion);
  const freshEvidence = createEvidence(
    command.projectId,
    command.expectedSchemaRevisionNo,
    artifact.dialect,
    conversion,
  );
  const freshPreviewHash = await computeSqlImportPreviewHash({
    evidence: freshEvidence,
    previewPolicy,
    originalSqlRetention: artifact.envelope.originalSqlRetention,
  });
  if (
    freshPreviewHash !== artifact.envelope.previewHash ||
    canonicalStringify(freshEvidence) !== canonicalStringify(artifact.envelope.evidence) ||
    canonicalStringify(previewPolicy) !== canonicalStringify(artifact.envelope.previewPolicy)
  ) {
    return failure(previewMismatch(command.projectId, command.artifactId));
  }
  if (!conversion.ok || artifact.generatedDbml !== conversion.candidate.dbml) {
    return failure(previewMismatch(command.projectId, command.artifactId));
  }

  const appliedPolicy = evaluateSqlImportDataPolicy(conversion, command.dataStatementHandling);
  const readinessFailure = applyReadinessError(command, appliedPolicy);
  if (readinessFailure) return failure(readinessFailure);

  const revisionId = options.generateId();
  const appliedAt = options.now();
  return transactionResult(options.persistence, command.projectId, (transaction) => {
    const current = readProjectState(transaction, command.projectId);
    expectRevision(current.project, command.expectedSchemaRevisionNo);
    expectDialect(current.project, artifact.dialect);
    const stored = requireArtifact(transaction, command.projectId, command.artifactId);
    if (
      isCreateProjectSqlImportEnvelope(stored.envelope) ||
      stored.status !== "PREVIEWED" ||
      canonicalStringify(stored) !== canonicalStringify(artifact)
    ) {
      if (stored.status === "APPLIED") {
        throw new ExpectedSqlImportFailure(alreadyApplied(command.projectId, command.artifactId));
      }
      throw new ExpectedSqlImportFailure(previewMismatch(command.projectId, command.artifactId));
    }

    const revisionNo = nextRevisionNo(current.project);
    const diagnostics = conversion.candidate.graph.diagnostics;
    const revision: SchemaRevision = {
      id: revisionId,
      projectId: command.projectId,
      revisionNo,
      source: conversion.candidate.dbml,
      sourceHash: conversion.candidate.dbmlHash,
      validity: "VALID",
      origin: "SQL_IMPORT",
      parserVersion: DBML_PARSER_VERSION,
      diagnosticSummary: summarizeDiagnostics(diagnostics),
      createdAt: appliedAt,
    };
    const project: Project = {
      ...current.project,
      draftSource: revision.source,
      draftHash: revision.sourceHash,
      lastValidRevisionId: revision.id,
      parserVersion: revision.parserVersion,
      schemaRevisionNo: revision.revisionNo,
      updatedAt: appliedAt,
    };
    const appliedArtifact: SqlImportArtifact = {
      ...stored,
      envelope: { ...stored.envelope, appliedPolicy },
      status: "APPLIED",
      appliedAt,
    };

    transaction.insertRevision(revision);
    updateProjectOrFail(transaction, project, command.expectedSchemaRevisionNo);
    if (!transaction.markImportArtifactApplied(appliedArtifact, "PREVIEWED")) {
      throw new ExpectedSqlImportFailure(previewMismatch(command.projectId, command.artifactId));
    }
    pruneProjectRevisions(transaction, project);
    return {
      artifactId: command.artifactId,
      artifactStatus: "APPLIED" as const,
      previewHash: artifact.envelope.previewHash,
      appliedAt,
      policy: appliedPolicy,
      state: readProjectState(transaction, command.projectId),
      diagnostics,
      revisionCreated: true as const,
    };
  });
}

function createEvidence(
  projectId: string,
  baseSchemaRevisionNo: number,
  dialect: SqlImportPreviewEvidence["dialect"],
  conversion: SqlImportConversionResult,
): SqlImportPreviewEvidence {
  return {
    projectId,
    baseSchemaRevisionNo,
    dialect,
    sourceHash: conversion.report.sourceHash,
    candidateDbmlHash: conversion.ok ? conversion.candidate.dbmlHash : null,
    report: conversion.report,
  };
}

function toPreviewMutation(artifact: SqlImportArtifact): SqlImportPreviewMutation {
  if (isCreateProjectSqlImportEnvelope(artifact.envelope)) {
    throw new SqlImportPersistenceInvariantError(
      artifact.projectId,
      "Created-project artifact cannot be returned as a replace preview.",
    );
  }
  return {
    artifactId: artifact.id,
    artifactStatus: artifact.status === "FAILED" ? "FAILED" : "PREVIEWED",
    createdAt: artifact.createdAt,
    baseSchemaRevisionNo: artifact.envelope.evidence.baseSchemaRevisionNo,
    previewHash: artifact.envelope.previewHash,
    originalSqlRetention: artifact.envelope.originalSqlRetention,
    report: artifact.envelope.evidence.report,
    policy: artifact.envelope.previewPolicy,
    candidate:
      artifact.status === "FAILED" || artifact.generatedDbml === null
        ? null
        : {
            dbml: artifact.generatedDbml,
            dbmlHash: artifact.envelope.evidence.candidateDbmlHash as string,
          },
  };
}

async function validateArtifactIntegrity(
  artifact: SqlImportArtifact,
): Promise<SqlImportApplicationError | null> {
  const { envelope } = artifact;
  const invalid = () =>
    invariant(artifact.projectId, "Stored SQL import artifact is inconsistent.");
  if (isCreateProjectSqlImportEnvelope(envelope)) return invalid();
  if (
    envelope.previewVersion !== SQL_IMPORT_PREVIEW_VERSION ||
    envelope.evidence.projectId !== artifact.projectId ||
    envelope.evidence.dialect !== artifact.dialect ||
    envelope.evidence.sourceHash !== artifact.originalHash ||
    envelope.evidence.report.sourceHash !== artifact.originalHash ||
    envelope.evidence.report.parserInputHash !== artifact.originalHash ||
    envelope.evidence.report.dialect !== artifact.dialect ||
    envelope.evidence.report.candidateDbmlHash !== envelope.evidence.candidateDbmlHash ||
    artifact.parserVersion !== envelope.evidence.report.parserVersions.dbmlParse
  ) {
    return invalid();
  }
  const expectedPreviewHash = await computeSqlImportPreviewHash({
    evidence: envelope.evidence,
    previewPolicy: envelope.previewPolicy,
    originalSqlRetention: envelope.originalSqlRetention,
  });
  if (expectedPreviewHash !== envelope.previewHash) return invalid();

  if (envelope.originalSqlRetention === "RETAIN") {
    if (
      artifact.originalSql === null ||
      (await sha256Utf8(artifact.originalSql)) !== artifact.originalHash
    ) {
      return invalid();
    }
  } else if (artifact.originalSql !== null) {
    return invalid();
  }

  if (artifact.status === "FAILED") {
    if (
      artifact.generatedDbml !== null ||
      envelope.evidence.candidateDbmlHash !== null ||
      envelope.appliedPolicy !== null ||
      artifact.appliedAt !== null
    ) {
      return invalid();
    }
  } else {
    if (
      artifact.generatedDbml === null ||
      envelope.evidence.candidateDbmlHash === null ||
      (await sha256Utf8(artifact.generatedDbml)) !== envelope.evidence.candidateDbmlHash
    ) {
      return invalid();
    }
  }
  if (artifact.status === "APPLIED") {
    if (artifact.appliedAt === null || envelope.appliedPolicy === null) return invalid();
  } else if (artifact.appliedAt !== null || envelope.appliedPolicy !== null) {
    return invalid();
  }
  return null;
}

function applyReadinessError(
  command: ApplySqlImportCommand,
  policy: SqlImportDataPolicyDecision,
): SqlImportApplicationError | null {
  switch (policy.applyReadiness) {
    case "READY":
      return null;
    case "CONVERSION_FAILED":
      return conversionFailed(command.projectId, command.artifactId);
    case "NO_SCHEMA_ELEMENTS":
      return {
        code: "SQL_IMPORT_NO_SCHEMA_ELEMENTS",
        message: "SQL import does not contain an applicable table or enum.",
        projectId: command.projectId,
        artifactId: command.artifactId,
      };
    case "DATA_EXCLUSION_CONFIRMATION_REQUIRED":
      return {
        code: "SQL_IMPORT_DATA_CONFIRMATION_REQUIRED",
        message: "DDL-only import requires explicit data-statement exclusion confirmation.",
        projectId: command.projectId,
        artifactId: command.artifactId,
      };
  }
}

function createApplyReadinessError(
  policy: SqlImportDataPolicyDecision,
): SqlImportApplicationError | null {
  switch (policy.applyReadiness) {
    case "READY":
      return null;
    case "CONVERSION_FAILED":
      return {
        code: "SQL_IMPORT_CREATE_CONVERSION_FAILED",
        message: "A failed SQL import preview cannot create a project.",
      };
    case "NO_SCHEMA_ELEMENTS":
      return {
        code: "SQL_IMPORT_CREATE_NO_SCHEMA_ELEMENTS",
        message: "SQL import does not contain an applicable table or enum.",
      };
    case "DATA_EXCLUSION_CONFIRMATION_REQUIRED":
      return {
        code: "SQL_IMPORT_CREATE_DATA_CONFIRMATION_REQUIRED",
        message: "DDL-only import requires explicit data-statement exclusion confirmation.",
      };
  }
}

function normalizeProjectName(name: string): string | null {
  const normalized = name.trim();
  return normalized.length > 0 ? normalized : null;
}

function requireArtifact(
  reader: SqlImportPersistenceReader,
  projectId: string,
  artifactId: string,
): SqlImportArtifact {
  const artifact = reader.getImportArtifact(projectId, artifactId);
  if (artifact) return artifact;
  throw new ExpectedSqlImportFailure({
    code: "SQL_IMPORT_ARTIFACT_NOT_FOUND",
    message: "SQL import preview artifact was not found.",
    projectId,
    artifactId,
  });
}

function expectRevision(project: Project, expectedSchemaRevisionNo: number): void {
  if (project.schemaRevisionNo === expectedSchemaRevisionNo) return;
  throw new ExpectedSqlImportFailure({
    code: "SQL_IMPORT_SCHEMA_REVISION_CONFLICT",
    message: `Expected schema revision ${expectedSchemaRevisionNo}, current revision is ${project.schemaRevisionNo}.`,
    projectId: project.id,
    expectedSchemaRevisionNo,
    currentSchemaRevisionNo: project.schemaRevisionNo,
  });
}

function expectDialect(project: Project, importDialect: Project["primaryDialect"]): void {
  if (project.primaryDialect === importDialect) return;
  throw new ExpectedSqlImportFailure({
    code: "SQL_IMPORT_DIALECT_MISMATCH",
    message: "SQL import dialect must match the project primary dialect.",
    projectId: project.id,
    projectDialect: project.primaryDialect,
    importDialect,
  });
}

function nextRevisionNo(project: Project): number {
  const revisionNo = project.schemaRevisionNo + 1;
  if (!Number.isSafeInteger(revisionNo)) {
    throw new ExpectedSqlImportFailure(
      invariant(project.id, "Project schema revision overflowed during SQL import."),
    );
  }
  return revisionNo;
}

function updateProjectOrFail(
  transaction: SqlImportPersistenceTransaction,
  project: Project,
  expectedSchemaRevisionNo: number,
): void {
  if (transaction.updateProject(project, expectedSchemaRevisionNo)) return;
  const current = transaction.getProject(project.id);
  if (!current) throw new ProjectStateReadError("NOT_FOUND", project.id, "Project was not found.");
  expectRevision(current, expectedSchemaRevisionNo);
  throw new ExpectedSqlImportFailure(
    invariant(project.id, "Project update did not affect one row."),
  );
}

function alreadyApplied(projectId: string, artifactId: string): SqlImportApplicationError {
  return {
    code: "SQL_IMPORT_ARTIFACT_ALREADY_APPLIED",
    message: "SQL import preview artifact has already been applied.",
    projectId,
    artifactId,
  };
}

function conversionFailed(projectId: string, artifactId: string): SqlImportApplicationError {
  return {
    code: "SQL_IMPORT_CONVERSION_FAILED",
    message: "A failed SQL import preview cannot be applied.",
    projectId,
    artifactId,
  };
}

function previewMismatch(projectId: string, artifactId: string): SqlImportApplicationError {
  return {
    code: "SQL_IMPORT_PREVIEW_MISMATCH",
    message: "SQL import preview evidence no longer matches the apply request.",
    projectId,
    artifactId,
  };
}

function invariant(projectId: string, message: string): SqlImportApplicationError {
  return { code: "SQL_IMPORT_STORAGE_INVARIANT_VIOLATION", message, projectId };
}

function readResult<T>(projectId: string, operation: () => T): SqlImportApplicationResult<T> {
  try {
    return success(operation());
  } catch (error) {
    return mapFailure(error, projectId);
  }
}

function transactionResult<T>(
  persistence: SqlImportPersistencePort,
  projectId: string,
  operation: (transaction: SqlImportPersistenceTransaction) => T,
): SqlImportApplicationResult<T> {
  try {
    return success(persistence.transaction(operation));
  } catch (error) {
    return mapFailure(error, projectId);
  }
}

function mapFailure<T>(error: unknown, projectId: string): SqlImportApplicationResult<T> {
  if (error instanceof ExpectedSqlImportFailure) return failure(error.applicationError);
  if (error instanceof ProjectStateReadError) {
    return failure(
      error.reason === "NOT_FOUND"
        ? { code: "SQL_IMPORT_PROJECT_NOT_FOUND", message: "Project was not found.", projectId }
        : invariant(projectId, error.message),
    );
  }
  if (error instanceof SqlImportPersistenceInvariantError) {
    return failure(invariant(projectId, error.message));
  }
  throw error;
}

function success<T>(value: T): SqlImportApplicationResult<T> {
  return { ok: true, value };
}

function failure<T = never>(error: SqlImportApplicationError): SqlImportApplicationResult<T> {
  return { ok: false, error };
}
