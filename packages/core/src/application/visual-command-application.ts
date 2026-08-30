import {
  type VisualCommand,
  visualCommandKindSchema,
  visualCommandSchema,
} from "@er-diagram/contracts";
import { sha256Utf8 } from "../hash.js";
import { DBML_PARSER_VERSION } from "../schema-graph.js";
import { canonicalStringify } from "../schema-semantics.js";
import type { DiagramLayout } from "./layout.js";
import type { Project, ProjectState, SchemaRevision } from "./project.js";
import {
  ProjectStateReadError,
  pruneProjectRevisions,
  readProjectState,
  summarizeDiagnostics,
} from "./project-state.js";
import {
  type ApplyVisualCommandCommand,
  type CreateVisualCommandApplicationOptions,
  type VisualCommandApplication,
  type VisualCommandApplicationError,
  type VisualCommandApplicationResult,
  type VisualCommandMutation,
  VisualCommandPersistenceInvariantError,
  type VisualCommandPersistencePort,
  type VisualCommandPersistenceReader,
  type VisualCommandPersistenceTransaction,
  type VisualCommandReceipt,
  type VisualCommandTransformDiagnostic,
  type VisualCommandTransformResult,
} from "./visual-command.js";

const SHA_256_HEX = /^[0-9a-f]{64}$/u;
const VISUAL_COMMAND_FILEPATH = "/main.dbml";

class ExpectedVisualCommandFailure extends Error {
  constructor(readonly applicationError: VisualCommandApplicationError) {
    super(applicationError.message);
    this.name = "ExpectedVisualCommandFailure";
  }
}

interface PreparedVisualCommand {
  readonly command: VisualCommand;
  readonly commandId: string;
  readonly commandHash: string;
}

interface LayoutMigration {
  readonly layouts: readonly DiagramLayout[];
  readonly nextLayoutRevisionNo: number;
  readonly migrated: boolean;
}

export function createVisualCommandApplication(
  options: CreateVisualCommandApplicationOptions,
): VisualCommandApplication {
  return {
    apply: async (input) => applyVisualCommand(options, input),
  };
}

export async function computeVisualCommandHash(command: VisualCommand): Promise<string> {
  const { commandId: _commandId, ...payload } = command;
  return sha256Utf8(canonicalStringify(payload));
}

async function applyVisualCommand(
  options: CreateVisualCommandApplicationOptions,
  input: ApplyVisualCommandCommand,
): Promise<VisualCommandApplicationResult<VisualCommandMutation>> {
  if (typeof input.projectId !== "string" || input.projectId.trim().length === 0) {
    return failure(invalid("Project ID must not be blank."));
  }

  const parsed = visualCommandSchema.safeParse(input.command);
  if (!parsed.success) {
    return failure(invalid("Visual command payload is invalid."));
  }
  const prepared: PreparedVisualCommand = {
    command: parsed.data,
    commandId: parsed.data.commandId.toLowerCase(),
    commandHash: await computeVisualCommandHash(parsed.data),
  };

  const preflight = readResult(input.projectId, () => {
    const state = readProjectState(options.persistence, input.projectId);
    const receipt = readReceipt(options.persistence, input.projectId, prepared.commandId);
    if (receipt) return { state, replay: replayOrConflict(state, receipt, prepared) };
    expectSchemaRevision(state.project, prepared.command.expectedSchemaRevisionNo);
    expectValidDraft(state);
    return { state, replay: null };
  });
  if (!preflight.ok) return preflight;
  if (preflight.value.replay) return success(preflight.value.replay);

  const beforeSource = preflight.value.state.project.draftSource;

  const transformed = await options.transform(
    beforeSource,
    prepared.command,
    VISUAL_COMMAND_FILEPATH,
  );
  const validatedTransform = validateTransform(
    input.projectId,
    beforeSource,
    prepared.command,
    transformed,
  );
  if (!validatedTransform.ok) return validatedTransform;

  const nextSourceHash = validatedTransform.value.changed
    ? await sha256Utf8(validatedTransform.value.source)
    : null;
  const revisionId = validatedTransform.value.changed ? options.generateId() : null;
  const createdAt = options.now();

  return transactionResult(options.persistence, input.projectId, (transaction) => {
    const state = readProjectState(transaction, input.projectId);
    const existingReceipt = readReceipt(transaction, input.projectId, prepared.commandId);
    if (existingReceipt) return replayOrConflict(state, existingReceipt, prepared);
    expectSchemaRevision(state.project, prepared.command.expectedSchemaRevisionNo);
    expectValidDraft(state);

    if (state.project.draftSource !== validatedTransform.value.beforeSource) {
      throw new ExpectedVisualCommandFailure(
        conflict(
          state.project,
          prepared.command.expectedSchemaRevisionNo,
          "Project source changed while the visual command was being prepared.",
        ),
      );
    }

    if (!validatedTransform.value.changed) {
      const receipt = createReceipt({
        project: state.project,
        prepared,
        revisionCreated: false,
        layoutMigrated: false,
        appliedSchemaRevisionNo: state.project.schemaRevisionNo,
        appliedLayoutRevisionNo: state.project.layoutRevisionNo,
        createdAt,
      });
      transaction.insertVisualCommandReceipt(receipt);
      return mutation(readProjectState(transaction, input.projectId), receipt, false);
    }

    if (!revisionId || !nextSourceHash) {
      throw new ExpectedVisualCommandFailure(
        invariant(input.projectId, "Prepared visual command revision data is missing."),
      );
    }
    const nextSchemaRevisionNo = state.project.schemaRevisionNo + 1;
    if (!Number.isSafeInteger(nextSchemaRevisionNo)) {
      throw new ExpectedVisualCommandFailure(
        invariant(input.projectId, "Schema revision overflowed."),
      );
    }

    const migration = prepareLayoutMigration(
      transaction,
      state.project,
      prepared.command,
      validatedTransform.value.transform,
    );
    for (const layout of migration.layouts) transaction.upsertLayout(layout);

    const revision: SchemaRevision = {
      id: revisionId,
      projectId: input.projectId,
      revisionNo: nextSchemaRevisionNo,
      source: validatedTransform.value.source,
      sourceHash: nextSourceHash,
      validity: "VALID",
      origin: "VISUAL_COMMAND",
      parserVersion: DBML_PARSER_VERSION,
      diagnosticSummary: summarizeDiagnostics(validatedTransform.value.transform.diagnostics),
      createdAt,
    };
    transaction.insertRevision(revision);

    const updatedProject: Project = {
      ...state.project,
      draftSource: revision.source,
      draftHash: revision.sourceHash,
      lastValidRevisionId: revision.id,
      parserVersion: DBML_PARSER_VERSION,
      schemaRevisionNo: revision.revisionNo,
      layoutRevisionNo: migration.nextLayoutRevisionNo,
      updatedAt: createdAt,
    };
    if (!transaction.updateProject(updatedProject, prepared.command.expectedSchemaRevisionNo)) {
      const current = transaction.getProject(input.projectId);
      if (!current) {
        throw new ExpectedVisualCommandFailure(projectNotFound(input.projectId));
      }
      throw new ExpectedVisualCommandFailure(
        conflict(current, prepared.command.expectedSchemaRevisionNo),
      );
    }

    const receipt = createReceipt({
      project: updatedProject,
      prepared,
      revisionCreated: true,
      layoutMigrated: migration.migrated,
      appliedSchemaRevisionNo: updatedProject.schemaRevisionNo,
      appliedLayoutRevisionNo: updatedProject.layoutRevisionNo,
      createdAt,
    });
    transaction.insertVisualCommandReceipt(receipt);
    pruneProjectRevisions(transaction, updatedProject);
    return mutation(readProjectState(transaction, input.projectId), receipt, false);
  });
}

function validateTransform(
  projectId: string,
  beforeSource: string,
  command: VisualCommand,
  transform: VisualCommandTransformResult,
): VisualCommandApplicationResult<{
  readonly changed: boolean;
  readonly beforeSource: string;
  readonly source: string;
  readonly transform: Extract<VisualCommandTransformResult, { readonly ok: true }>;
}> {
  if (!transform.ok) {
    return failure({
      code: "VISUAL_COMMAND_TRANSFORM_FAILED",
      message: "Visual command could not be applied to the canonical source.",
      projectId,
      diagnostics: transform.diagnostics,
      ...(transform.partialImpact ? { partialImpact: transform.partialImpact } : {}),
    });
  }

  const invalidReason = transformInvariantReason(beforeSource, command, transform);
  if (invalidReason) {
    return failure({
      code: "VISUAL_COMMAND_TRANSFORM_FAILED",
      message: "Visual command transform result failed application verification.",
      projectId,
      diagnostics: [transformInvariantDiagnostic(invalidReason)],
    });
  }
  return success({
    changed: transform.changed,
    beforeSource,
    source: transform.source,
    transform,
  });
}

function transformInvariantReason(
  beforeSource: string,
  command: VisualCommand,
  transform: Extract<VisualCommandTransformResult, { readonly ok: true }>,
): string | null {
  if (
    !SHA_256_HEX.test(transform.beforeSchemaHash) ||
    !SHA_256_HEX.test(transform.afterSchemaHash)
  ) {
    return "Transformer returned an invalid semantic hash.";
  }
  if (transform.diagnostics.some(({ severity }) => severity === "ERROR")) {
    return "Transformer returned an error diagnostic for a successful result.";
  }
  if (!transform.changed) {
    if (
      transform.source !== beforeSource ||
      transform.beforeSchemaHash !== transform.afterSchemaHash ||
      transform.semanticDiff.changes.length > 0 ||
      transform.semanticDiff.renameCandidates.length > 0
    ) {
      return "Transformer no-op result changed source or semantics.";
    }
    return null;
  }
  if (
    transform.source === beforeSource ||
    transform.beforeSchemaHash === transform.afterSchemaHash ||
    transform.semanticDiff.changes.length === 0
  ) {
    return "Transformer changed result did not change source and semantics together.";
  }

  const expectedRenameKind =
    command.kind === "RENAME_TABLE" ? "table" : command.kind === "RENAME_COLUMN" ? "column" : null;
  if (!expectedRenameKind) {
    return transform.semanticDiff.renameCandidates.length === 0
      ? null
      : "Only explicit rename commands may return rename candidates.";
  }
  const [candidate] = transform.semanticDiff.renameCandidates;
  if (
    transform.semanticDiff.renameCandidates.length !== 1 ||
    candidate?.elementKind !== expectedRenameKind ||
    candidate.confidence !== "HIGH" ||
    candidate.reason !== "UNIQUE_EXACT_STRUCTURE"
  ) {
    return "Explicit rename must return exactly one high-confidence rename candidate.";
  }
  return null;
}

function transformInvariantDiagnostic(message: string): VisualCommandTransformDiagnostic {
  return {
    code: "VISUAL_APPLICATION_TRANSFORM_INVARIANT",
    message,
    severity: "ERROR",
  };
}

function prepareLayoutMigration(
  transaction: VisualCommandPersistenceTransaction,
  project: Project,
  command: VisualCommand,
  transform: Extract<VisualCommandTransformResult, { readonly ok: true }>,
): LayoutMigration {
  if (command.kind !== "RENAME_TABLE" && command.kind !== "RENAME_COLUMN") {
    return { layouts: [], nextLayoutRevisionNo: project.layoutRevisionNo, migrated: false };
  }
  const candidate = transform.semanticDiff.renameCandidates[0];
  if (!candidate) {
    throw new ExpectedVisualCommandFailure(
      invariant(project.id, "Explicit rename is missing its semantic rename candidate."),
    );
  }

  const changedLayouts: DiagramLayout[] = [];
  for (const layout of transaction.listLayouts(project.id)) {
    const positions = { ...layout.positions };
    const oldPosition = positions[candidate.beforeKey];
    const newPosition = positions[candidate.afterKey];
    let changed = false;
    if (oldPosition) {
      if (newPosition && !samePosition(oldPosition, newPosition)) {
        throw new ExpectedVisualCommandFailure({
          code: "VISUAL_COMMAND_LAYOUT_MIGRATION_CONFLICT",
          message: "Layout already contains a different position for the renamed element.",
          projectId: project.id,
          viewKey: layout.viewKey,
          beforeKey: candidate.beforeKey,
          afterKey: candidate.afterKey,
        });
      }
      if (!newPosition) {
        positions[candidate.afterKey] = { ...oldPosition };
        changed = true;
      }
    }

    const hiddenElementKeys = new Set(layout.hiddenElementKeys);
    if (hiddenElementKeys.has(candidate.beforeKey) && !hiddenElementKeys.has(candidate.afterKey)) {
      hiddenElementKeys.add(candidate.afterKey);
      changed = true;
    }
    let baseSchemaHash = layout.baseSchemaHash;
    if (baseSchemaHash === transform.beforeSchemaHash) {
      baseSchemaHash = transform.afterSchemaHash;
      changed = true;
    }
    if (!changed) continue;
    changedLayouts.push({
      ...layout,
      positions: Object.fromEntries(
        Object.entries(positions).sort(([left], [right]) => compareStrings(left, right)),
      ),
      hiddenElementKeys: [...hiddenElementKeys].sort(compareStrings),
      baseSchemaHash,
    });
  }
  if (changedLayouts.length === 0) {
    return { layouts: [], nextLayoutRevisionNo: project.layoutRevisionNo, migrated: false };
  }

  const nextLayoutRevisionNo = project.layoutRevisionNo + 1;
  if (!Number.isSafeInteger(nextLayoutRevisionNo)) {
    throw new ExpectedVisualCommandFailure(
      invariant(project.id, "Layout revision overflowed during rename migration."),
    );
  }
  return {
    layouts: changedLayouts.map((layout) => ({ ...layout, revisionNo: nextLayoutRevisionNo })),
    nextLayoutRevisionNo,
    migrated: true,
  };
}

function createReceipt(input: {
  readonly project: Project;
  readonly prepared: PreparedVisualCommand;
  readonly revisionCreated: boolean;
  readonly layoutMigrated: boolean;
  readonly appliedSchemaRevisionNo: number;
  readonly appliedLayoutRevisionNo: number;
  readonly createdAt: string;
}): VisualCommandReceipt {
  return {
    projectId: input.project.id,
    commandId: input.prepared.commandId,
    commandKind: input.prepared.command.kind,
    commandHash: input.prepared.commandHash,
    expectedSchemaRevisionNo: input.prepared.command.expectedSchemaRevisionNo,
    appliedSchemaRevisionNo: input.appliedSchemaRevisionNo,
    appliedLayoutRevisionNo: input.appliedLayoutRevisionNo,
    revisionCreated: input.revisionCreated,
    layoutMigrated: input.layoutMigrated,
    createdAt: input.createdAt,
  };
}

function readReceipt(
  reader: VisualCommandPersistenceReader,
  projectId: string,
  commandId: string,
): VisualCommandReceipt | null {
  const receipt = reader.getVisualCommandReceipt(projectId, commandId);
  if (!receipt) return null;
  if (
    receipt.projectId !== projectId ||
    receipt.commandId !== commandId ||
    !isCanonicalUuid(receipt.commandId) ||
    !visualCommandKindSchema.safeParse(receipt.commandKind).success ||
    !SHA_256_HEX.test(receipt.commandHash) ||
    !Number.isSafeInteger(receipt.expectedSchemaRevisionNo) ||
    receipt.expectedSchemaRevisionNo < 1 ||
    !Number.isSafeInteger(receipt.appliedSchemaRevisionNo) ||
    receipt.appliedSchemaRevisionNo < receipt.expectedSchemaRevisionNo ||
    !Number.isSafeInteger(receipt.appliedLayoutRevisionNo) ||
    receipt.appliedLayoutRevisionNo < 0 ||
    typeof receipt.revisionCreated !== "boolean" ||
    typeof receipt.layoutMigrated !== "boolean" ||
    !isUtcIsoTimestamp(receipt.createdAt) ||
    (receipt.revisionCreated
      ? receipt.appliedSchemaRevisionNo !== receipt.expectedSchemaRevisionNo + 1
      : receipt.appliedSchemaRevisionNo !== receipt.expectedSchemaRevisionNo)
  ) {
    throw new VisualCommandPersistenceInvariantError(
      projectId,
      "Stored visual command receipt is inconsistent.",
    );
  }
  return receipt;
}

function replayOrConflict(
  state: ProjectState,
  receipt: VisualCommandReceipt,
  prepared: PreparedVisualCommand,
): VisualCommandMutation {
  if (
    receipt.commandHash !== prepared.commandHash ||
    receipt.commandKind !== prepared.command.kind ||
    receipt.expectedSchemaRevisionNo !== prepared.command.expectedSchemaRevisionNo
  ) {
    throw new ExpectedVisualCommandFailure({
      code: "VISUAL_COMMAND_IDEMPOTENCY_CONFLICT",
      message: "Command ID was already used with a different visual command payload.",
      projectId: state.project.id,
      commandId: prepared.commandId,
    });
  }
  if (
    receipt.appliedSchemaRevisionNo > state.project.schemaRevisionNo ||
    receipt.appliedLayoutRevisionNo > state.project.layoutRevisionNo
  ) {
    throw new ExpectedVisualCommandFailure(
      invariant(state.project.id, "Stored visual command receipt is newer than project state."),
    );
  }
  return mutation(state, receipt, true);
}

function mutation(
  state: ProjectState,
  receipt: VisualCommandReceipt,
  replayed: boolean,
): VisualCommandMutation {
  return {
    state,
    revisionCreated: receipt.revisionCreated,
    layoutMigrated: receipt.layoutMigrated,
    replayed,
    appliedSchemaRevisionNo: receipt.appliedSchemaRevisionNo,
    appliedLayoutRevisionNo: receipt.appliedLayoutRevisionNo,
  };
}

function expectSchemaRevision(project: Project, expected: number): void {
  if (project.schemaRevisionNo !== expected) {
    throw new ExpectedVisualCommandFailure(conflict(project, expected));
  }
}

function expectValidDraft(state: ProjectState): void {
  if (state.currentRevision.validity === "VALID") return;
  throw new ExpectedVisualCommandFailure({
    code: "VISUAL_COMMAND_DRAFT_INVALID",
    message: "Visual commands require a valid current draft.",
    projectId: state.project.id,
  });
}

function projectNotFound(projectId: string): VisualCommandApplicationError {
  return {
    code: "VISUAL_COMMAND_PROJECT_NOT_FOUND",
    message: "Project was not found.",
    projectId,
  };
}

function conflict(
  project: Project,
  expectedSchemaRevisionNo: number,
  message = `Expected schema revision ${expectedSchemaRevisionNo}, current revision is ${project.schemaRevisionNo}.`,
): VisualCommandApplicationError {
  return {
    code: "VISUAL_COMMAND_SCHEMA_REVISION_CONFLICT",
    message,
    projectId: project.id,
    expectedSchemaRevisionNo,
    currentSchemaRevisionNo: project.schemaRevisionNo,
  };
}

function invalid(message: string): VisualCommandApplicationError {
  return { code: "VISUAL_COMMAND_INVALID", message };
}

function invariant(projectId: string, message: string): VisualCommandApplicationError {
  return {
    code: "VISUAL_COMMAND_STORAGE_INVARIANT_VIOLATION",
    message,
    projectId,
  };
}

function mapProjectStateError(error: ProjectStateReadError): VisualCommandApplicationError {
  return error.reason === "NOT_FOUND"
    ? projectNotFound(error.projectId)
    : invariant(error.projectId, error.message);
}

function readResult<T>(projectId: string, operation: () => T): VisualCommandApplicationResult<T> {
  try {
    return success(operation());
  } catch (error) {
    return mapFailure(error, projectId);
  }
}

function transactionResult<T>(
  persistence: VisualCommandPersistencePort,
  projectId: string,
  operation: (transaction: VisualCommandPersistenceTransaction) => T,
): VisualCommandApplicationResult<T> {
  try {
    return success(persistence.transaction(operation));
  } catch (error) {
    return mapFailure(error, projectId);
  }
}

function mapFailure<T>(error: unknown, projectId: string): VisualCommandApplicationResult<T> {
  if (error instanceof ExpectedVisualCommandFailure) return failure(error.applicationError);
  if (error instanceof ProjectStateReadError) return failure(mapProjectStateError(error));
  if (error instanceof VisualCommandPersistenceInvariantError) {
    return failure(invariant(projectId, error.message));
  }
  throw error;
}

function success<T>(value: T): VisualCommandApplicationResult<T> {
  return { ok: true, value };
}

function failure<T = never>(
  error: VisualCommandApplicationError,
): VisualCommandApplicationResult<T> {
  return { ok: false, error };
}

function samePosition(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): boolean {
  return Object.is(left.x, right.x) && Object.is(left.y, right.y);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isUtcIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}
