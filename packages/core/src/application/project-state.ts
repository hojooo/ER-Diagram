import type { Diagnostic } from "@er-diagram/contracts";
import { DBML_PARSER_VERSION } from "../schema-graph.js";
import {
  type DiagnosticSummary,
  NON_CHECKPOINT_REVISION_LIMIT,
  type Project,
  type ProjectPersistenceReader,
  type ProjectPersistenceTransaction,
  type ProjectState,
} from "./project.js";

export class ProjectStateReadError extends Error {
  constructor(
    readonly reason: "NOT_FOUND" | "INVARIANT",
    readonly projectId: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectStateReadError";
  }
}

export function readProjectState(
  reader: ProjectPersistenceReader,
  projectId: string,
): ProjectState {
  const project = reader.getProject(projectId);
  if (!project) {
    throw new ProjectStateReadError("NOT_FOUND", projectId, "Project was not found.");
  }
  const currentRevision = reader.getRevisionByNumber(projectId, project.schemaRevisionNo);
  if (!currentRevision) {
    throw invariant(projectId, `Current revision ${project.schemaRevisionNo} does not exist.`);
  }
  if (
    currentRevision.source !== project.draftSource ||
    currentRevision.sourceHash !== project.draftHash ||
    currentRevision.parserVersion !== project.parserVersion
  ) {
    throw invariant(projectId, "Project draft does not match its current revision.");
  }

  let lastValidRevision = null;
  if (project.lastValidRevisionId) {
    lastValidRevision = reader.getRevisionById(projectId, project.lastValidRevisionId);
    if (lastValidRevision?.validity !== "VALID") {
      throw invariant(projectId, "Project last-valid pointer does not reference a valid revision.");
    }
    if (lastValidRevision.revisionNo > currentRevision.revisionNo) {
      throw invariant(projectId, "Project last-valid revision is newer than its current revision.");
    }
  }
  if (currentRevision.validity === "VALID" && project.lastValidRevisionId !== currentRevision.id) {
    throw invariant(projectId, "A valid current revision must also be the last-valid revision.");
  }

  return { project, currentRevision, lastValidRevision };
}

export function summarizeDiagnostics(diagnostics: readonly Diagnostic[]): DiagnosticSummary {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "ERROR") errors += 1;
    else if (diagnostic.severity === "WARNING") warnings += 1;
    else infos += 1;
  }
  return { errors, warnings, infos, parserVersion: DBML_PARSER_VERSION };
}

export function pruneProjectRevisions(
  transaction: ProjectPersistenceTransaction,
  project: Project,
): void {
  const nonCheckpoints = transaction
    .listRevisions(project.id)
    .filter(
      (revision) => revision.origin === "SOURCE_EDIT" || revision.origin === "VISUAL_COMMAND",
    );
  const protectedIds = new Set(
    nonCheckpoints.slice(0, NON_CHECKPOINT_REVISION_LIMIT).map(({ id }) => id),
  );
  if (project.lastValidRevisionId) protectedIds.add(project.lastValidRevisionId);
  const revisionIds = nonCheckpoints.filter(({ id }) => !protectedIds.has(id)).map(({ id }) => id);
  if (revisionIds.length === 0) return;

  const deleted = transaction.deleteRevisions(project.id, revisionIds);
  if (deleted !== revisionIds.length) {
    throw invariant(project.id, "Revision retention did not delete the expected rows.");
  }
}

function invariant(projectId: string, message: string): ProjectStateReadError {
  return new ProjectStateReadError("INVARIANT", projectId, message);
}
