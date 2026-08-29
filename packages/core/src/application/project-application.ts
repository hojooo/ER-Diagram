import type { Diagnostic } from "@er-diagram/contracts";
import { parseDbmlV2 } from "../dbml-parser.js";
import { DBML_PARSER_VERSION } from "../schema-graph.js";
import type {
  CreateProjectApplicationOptions,
  CreateProjectCommand,
  DeleteProjectCommand,
  DiagnosticSummary,
  DraftValidity,
  DuplicateProjectCommand,
  Project,
  ProjectApplication,
  ProjectApplicationError,
  ProjectApplicationResult,
  ProjectMutation,
  ProjectPersistencePort,
  ProjectPersistenceReader,
  ProjectPersistenceTransaction,
  ProjectSourceParser,
  ProjectState,
  ProjectSummary,
  RenameProjectCommand,
  RestoreRevisionCommand,
  SaveDraftCommand,
  SchemaRevision,
} from "./project.js";
import {
  ProjectStateReadError,
  pruneProjectRevisions,
  readProjectState,
  summarizeDiagnostics,
} from "./project-state.js";

interface ValidatedSource {
  readonly source: string;
  readonly sourceHash: string;
  readonly validity: DraftValidity;
  readonly diagnostics: readonly Diagnostic[];
  readonly diagnosticSummary: DiagnosticSummary;
}

class ExpectedProjectFailure extends Error {
  readonly applicationError: ProjectApplicationError;

  constructor(applicationError: ProjectApplicationError) {
    super(applicationError.message);
    this.name = "ExpectedProjectFailure";
    this.applicationError = applicationError;
  }
}

export function createProjectApplication(
  options: CreateProjectApplicationOptions,
): ProjectApplication {
  const parseSource = options.parseSource ?? parseDbmlV2;

  return {
    listProjects: async () => readResult(() => listProjectSummaries(options.persistence)),
    getProject: async (projectId) =>
      readResult(() => readProjectState(options.persistence, projectId)),
    createProject: async (command) => createProject(options, parseSource, command),
    renameProject: async (command) => renameProject(options, command),
    duplicateProject: async (command) => duplicateProject(options, parseSource, command),
    deleteProject: async (command) => deleteProject(options, command),
    saveDraft: async (command) => saveDraft(options, parseSource, command),
    listRevisions: async (projectId) =>
      readResult(() => {
        readProjectState(options.persistence, projectId);
        return options.persistence.listRevisions(projectId);
      }),
    restoreRevision: async (command) => restoreRevision(options, parseSource, command),
  };
}

async function createProject(
  options: CreateProjectApplicationOptions,
  parseSource: ProjectSourceParser,
  command: CreateProjectCommand,
): Promise<ProjectApplicationResult<ProjectMutation>> {
  const name = normalizeName(command.name);
  if (!name) return failure(invalidName());

  const validated = await validateSource(parseSource, command.source);
  const createdAt = options.now();
  const projectId = options.generateId();
  const revisionId = options.generateId();
  const revision = createRevision({
    id: revisionId,
    projectId,
    revisionNo: 1,
    validated,
    origin: "SOURCE_EDIT",
    createdAt,
  });
  const project: Project = {
    id: projectId,
    name,
    primaryDialect: command.primaryDialect,
    draftSource: validated.source,
    draftHash: validated.sourceHash,
    lastValidRevisionId: validated.validity === "VALID" ? revisionId : null,
    parserVersion: DBML_PARSER_VERSION,
    schemaRevisionNo: 1,
    layoutRevisionNo: 0,
    createdAt,
    updatedAt: createdAt,
  };

  return transactionResult(options.persistence, (transaction) => {
    transaction.insertProject(project);
    transaction.insertRevision(revision);
    return mutation(readProjectState(transaction, projectId), validated.diagnostics, true);
  });
}

async function saveDraft(
  options: CreateProjectApplicationOptions,
  parseSource: ProjectSourceParser,
  command: SaveDraftCommand,
): Promise<ProjectApplicationResult<ProjectMutation>> {
  const preflight = readResult(() => readProjectState(options.persistence, command.projectId));
  if (!preflight.ok) return preflight;
  const preflightConflict = revisionConflict(
    preflight.value.project,
    command.expectedSchemaRevisionNo,
  );
  if (preflightConflict) return failure(preflightConflict);

  const validated = await validateSource(parseSource, command.source);
  const revisionId = options.generateId();
  const updatedAt = options.now();

  return transactionResult(options.persistence, (transaction) => {
    const state = readProjectState(transaction, command.projectId);
    expectRevision(state.project, command.expectedSchemaRevisionNo);
    if (
      state.project.draftSource === validated.source &&
      state.project.draftHash === validated.sourceHash &&
      state.project.parserVersion === DBML_PARSER_VERSION
    ) {
      return mutation(state, validated.diagnostics, false);
    }

    const revisionNo = state.project.schemaRevisionNo + 1;
    const revision = createRevision({
      id: revisionId,
      projectId: state.project.id,
      revisionNo,
      validated,
      origin: "SOURCE_EDIT",
      createdAt: updatedAt,
    });
    transaction.insertRevision(revision);
    const updated: Project = {
      ...state.project,
      draftSource: validated.source,
      draftHash: validated.sourceHash,
      lastValidRevisionId:
        validated.validity === "VALID" ? revision.id : state.project.lastValidRevisionId,
      parserVersion: DBML_PARSER_VERSION,
      schemaRevisionNo: revisionNo,
      updatedAt,
    };
    updateProjectOrFail(transaction, updated, command.expectedSchemaRevisionNo);
    pruneProjectRevisions(transaction, updated);
    return mutation(readProjectState(transaction, updated.id), validated.diagnostics, true);
  });
}

async function renameProject(
  options: CreateProjectApplicationOptions,
  command: RenameProjectCommand,
): Promise<ProjectApplicationResult<ProjectState>> {
  const name = normalizeName(command.name);
  if (!name) return failure(invalidName());
  const updatedAt = options.now();

  return transactionResult(options.persistence, (transaction) => {
    const state = readProjectState(transaction, command.projectId);
    expectRevision(state.project, command.expectedSchemaRevisionNo);
    if (state.project.name === name) return state;

    updateProjectOrFail(
      transaction,
      { ...state.project, name, updatedAt },
      command.expectedSchemaRevisionNo,
    );
    return readProjectState(transaction, command.projectId);
  });
}

async function deleteProject(
  options: CreateProjectApplicationOptions,
  command: DeleteProjectCommand,
): Promise<ProjectApplicationResult<{ readonly projectId: string }>> {
  return transactionResult(options.persistence, (transaction) => {
    const state = readProjectState(transaction, command.projectId);
    expectRevision(state.project, command.expectedSchemaRevisionNo);
    if (!transaction.deleteProject(command.projectId, command.expectedSchemaRevisionNo)) {
      throw currentConflict(transaction, command.projectId, command.expectedSchemaRevisionNo);
    }
    return { projectId: command.projectId };
  });
}

async function duplicateProject(
  options: CreateProjectApplicationOptions,
  parseSource: ProjectSourceParser,
  command: DuplicateProjectCommand,
): Promise<ProjectApplicationResult<ProjectMutation>> {
  const name = normalizeName(command.name);
  if (!name) return failure(invalidName());

  const preflight = readResult(() =>
    readProjectState(options.persistence, command.sourceProjectId),
  );
  if (!preflight.ok) return preflight;
  const conflict = revisionConflict(preflight.value.project, command.expectedSchemaRevisionNo);
  if (conflict) return failure(conflict);

  const currentValidation = await validateSource(parseSource, preflight.value.project.draftSource);
  let lastValidValidation: ValidatedSource | null = null;
  if (currentValidation.validity === "INVALID" && preflight.value.lastValidRevision) {
    lastValidValidation = await validateSource(
      parseSource,
      preflight.value.lastValidRevision.source,
    );
    if (lastValidValidation.validity !== "VALID") {
      return failure(
        invariant(
          command.sourceProjectId,
          "Stored last-valid revision no longer validates with the current parser.",
        ),
      );
    }
  }

  const createdAt = options.now();
  const projectId = options.generateId();
  const firstRevisionId = options.generateId();
  const secondRevisionId = lastValidValidation ? options.generateId() : null;

  return transactionResult(options.persistence, (transaction) => {
    const sourceState = readProjectState(transaction, command.sourceProjectId);
    expectRevision(sourceState.project, command.expectedSchemaRevisionNo);

    const revisions: SchemaRevision[] = [];
    let currentRevision: SchemaRevision;
    let lastValidRevisionId: string | null;
    if (lastValidValidation && secondRevisionId) {
      const validRevision = createRevision({
        id: firstRevisionId,
        projectId,
        revisionNo: 1,
        validated: lastValidValidation,
        origin: "SOURCE_EDIT",
        createdAt,
      });
      currentRevision = createRevision({
        id: secondRevisionId,
        projectId,
        revisionNo: 2,
        validated: currentValidation,
        origin: "SOURCE_EDIT",
        createdAt,
      });
      revisions.push(validRevision, currentRevision);
      lastValidRevisionId = validRevision.id;
    } else {
      currentRevision = createRevision({
        id: firstRevisionId,
        projectId,
        revisionNo: 1,
        validated: currentValidation,
        origin: "SOURCE_EDIT",
        createdAt,
      });
      revisions.push(currentRevision);
      lastValidRevisionId = currentValidation.validity === "VALID" ? currentRevision.id : null;
    }

    const project: Project = {
      id: projectId,
      name,
      primaryDialect: sourceState.project.primaryDialect,
      draftSource: currentValidation.source,
      draftHash: currentValidation.sourceHash,
      lastValidRevisionId,
      parserVersion: DBML_PARSER_VERSION,
      schemaRevisionNo: currentRevision.revisionNo,
      layoutRevisionNo: 0,
      createdAt,
      updatedAt: createdAt,
    };
    transaction.insertProject(project);
    for (const revision of revisions) transaction.insertRevision(revision);
    return mutation(readProjectState(transaction, projectId), currentValidation.diagnostics, true);
  });
}

async function restoreRevision(
  options: CreateProjectApplicationOptions,
  parseSource: ProjectSourceParser,
  command: RestoreRevisionCommand,
): Promise<ProjectApplicationResult<ProjectMutation>> {
  const preflight = readResult(() => {
    const state = readProjectState(options.persistence, command.projectId);
    expectRevision(state.project, command.expectedSchemaRevisionNo);
    const target = options.persistence.getRevisionByNumber(command.projectId, command.revisionNo);
    if (!target) throw new ExpectedProjectFailure(revisionNotFound(command));
    return target;
  });
  if (!preflight.ok) return preflight;

  const validated = await validateSource(parseSource, preflight.value.source);
  const revisionId = options.generateId();
  const updatedAt = options.now();

  return transactionResult(options.persistence, (transaction) => {
    const state = readProjectState(transaction, command.projectId);
    expectRevision(state.project, command.expectedSchemaRevisionNo);
    const target = transaction.getRevisionByNumber(command.projectId, command.revisionNo);
    if (!target) throw new ExpectedProjectFailure(revisionNotFound(command));
    if (target.id !== preflight.value.id || target.sourceHash !== preflight.value.sourceHash) {
      throw new ExpectedProjectFailure(
        invariant(command.projectId, "Revision identity changed while restore was being prepared."),
      );
    }

    const revisionNo = state.project.schemaRevisionNo + 1;
    const revision = createRevision({
      id: revisionId,
      projectId: command.projectId,
      revisionNo,
      validated,
      origin: "RESTORE",
      createdAt: updatedAt,
    });
    transaction.insertRevision(revision);
    const updated: Project = {
      ...state.project,
      draftSource: validated.source,
      draftHash: validated.sourceHash,
      lastValidRevisionId:
        validated.validity === "VALID" ? revision.id : state.project.lastValidRevisionId,
      parserVersion: DBML_PARSER_VERSION,
      schemaRevisionNo: revisionNo,
      updatedAt,
    };
    updateProjectOrFail(transaction, updated, command.expectedSchemaRevisionNo);
    pruneProjectRevisions(transaction, updated);
    return mutation(readProjectState(transaction, command.projectId), validated.diagnostics, true);
  });
}

async function validateSource(
  parseSource: ProjectSourceParser,
  source: string,
): Promise<ValidatedSource> {
  const parsed = await parseSource(source);
  const diagnostics = parsed.ok ? parsed.graph.diagnostics : parsed.diagnostics;
  return {
    source,
    sourceHash: parsed.sourceHash,
    validity: parsed.ok ? "VALID" : "INVALID",
    diagnostics,
    diagnosticSummary: summarizeDiagnostics(diagnostics),
  };
}

function createRevision(input: {
  readonly id: string;
  readonly projectId: string;
  readonly revisionNo: number;
  readonly validated: ValidatedSource;
  readonly origin: SchemaRevision["origin"];
  readonly createdAt: string;
}): SchemaRevision {
  return {
    id: input.id,
    projectId: input.projectId,
    revisionNo: input.revisionNo,
    source: input.validated.source,
    sourceHash: input.validated.sourceHash,
    validity: input.validated.validity,
    origin: input.origin,
    parserVersion: DBML_PARSER_VERSION,
    diagnosticSummary: input.validated.diagnosticSummary,
    createdAt: input.createdAt,
  };
}

function listProjectSummaries(reader: ProjectPersistenceReader): readonly ProjectSummary[] {
  return reader.listProjects().map((project) => {
    const state = readProjectState(reader, project.id);
    return {
      id: project.id,
      name: project.name,
      primaryDialect: project.primaryDialect,
      parserVersion: project.parserVersion,
      schemaRevisionNo: project.schemaRevisionNo,
      layoutRevisionNo: project.layoutRevisionNo,
      draftValidity: state.currentRevision.validity,
      diagnosticSummary: state.currentRevision.diagnosticSummary,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  });
}

function updateProjectOrFail(
  transaction: ProjectPersistenceTransaction,
  project: Project,
  expectedSchemaRevisionNo: number,
): void {
  if (transaction.updateProject(project, expectedSchemaRevisionNo)) return;
  throw currentConflict(transaction, project.id, expectedSchemaRevisionNo);
}

function currentConflict(
  reader: ProjectPersistenceReader,
  projectId: string,
  expectedSchemaRevisionNo: number,
): ExpectedProjectFailure {
  const current = reader.getProject(projectId);
  if (!current) return new ExpectedProjectFailure(projectNotFound(projectId));
  return new ExpectedProjectFailure(
    conflict(projectId, expectedSchemaRevisionNo, current.schemaRevisionNo),
  );
}

function expectRevision(project: Project, expectedSchemaRevisionNo: number): void {
  const error = revisionConflict(project, expectedSchemaRevisionNo);
  if (error) throw new ExpectedProjectFailure(error);
}

function revisionConflict(
  project: Project,
  expectedSchemaRevisionNo: number,
): ProjectApplicationError | null {
  return project.schemaRevisionNo === expectedSchemaRevisionNo
    ? null
    : conflict(project.id, expectedSchemaRevisionNo, project.schemaRevisionNo);
}

function mutation(
  state: ProjectState,
  diagnostics: readonly Diagnostic[],
  revisionCreated: boolean,
): ProjectMutation {
  return { state, diagnostics, revisionCreated };
}

function normalizeName(name: string): string | null {
  const normalized = name.trim();
  return normalized.length > 0 ? normalized : null;
}

function invalidName(): ProjectApplicationError {
  return { code: "PROJECT_NAME_INVALID", message: "Project name must not be blank." };
}

function projectNotFound(projectId: string): ProjectApplicationError {
  return { code: "PROJECT_NOT_FOUND", message: `Project was not found: ${projectId}`, projectId };
}

function revisionNotFound(command: RestoreRevisionCommand): ProjectApplicationError {
  return {
    code: "PROJECT_REVISION_NOT_FOUND",
    message: `Project revision was not found: ${command.projectId}#${command.revisionNo}`,
    projectId: command.projectId,
    revisionNo: command.revisionNo,
  };
}

function conflict(
  projectId: string,
  expectedSchemaRevisionNo: number,
  currentSchemaRevisionNo: number,
): ProjectApplicationError {
  return {
    code: "PROJECT_SCHEMA_REVISION_CONFLICT",
    message: `Expected schema revision ${expectedSchemaRevisionNo}, current revision is ${currentSchemaRevisionNo}.`,
    projectId,
    expectedSchemaRevisionNo,
    currentSchemaRevisionNo,
  };
}

function invariant(projectId: string, message: string): ProjectApplicationError {
  return { code: "PROJECT_STORAGE_INVARIANT_VIOLATION", message, projectId };
}

function success<T>(value: T): ProjectApplicationResult<T> {
  return { ok: true, value };
}

function failure<T = never>(error: ProjectApplicationError): ProjectApplicationResult<T> {
  return { ok: false, error };
}

function readResult<T>(operation: () => T): ProjectApplicationResult<T> {
  try {
    return success(operation());
  } catch (error) {
    if (error instanceof ExpectedProjectFailure) return failure(error.applicationError);
    if (error instanceof ProjectStateReadError) return failure(mapProjectStateError(error));
    throw error;
  }
}

function transactionResult<T>(
  persistence: ProjectPersistencePort,
  operation: (transaction: ProjectPersistenceTransaction) => T,
): ProjectApplicationResult<T> {
  try {
    return success(persistence.transaction(operation));
  } catch (error) {
    if (error instanceof ExpectedProjectFailure) return failure(error.applicationError);
    if (error instanceof ProjectStateReadError) return failure(mapProjectStateError(error));
    throw error;
  }
}

function mapProjectStateError(error: ProjectStateReadError): ProjectApplicationError {
  return error.reason === "NOT_FOUND"
    ? projectNotFound(error.projectId)
    : invariant(error.projectId, error.message);
}
