import type {
  DiagnosticSummary,
  Project,
  ProjectPersistencePort,
  ProjectPersistenceTransaction,
  SchemaRevision,
} from "@er-diagram/core";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { projects, schemaRevisions } from "./schema.js";
import {
  type SqliteDatabase,
  type SqliteStorage,
  SqliteStorageError,
  type SqliteTransaction,
} from "./sqlite-storage.js";

type ProjectDatabase = SqliteDatabase | SqliteTransaction;
type StoredProject = typeof projects.$inferSelect;
type StoredRevision = typeof schemaRevisions.$inferSelect;

class SqliteProjectReader<TDatabase extends ProjectDatabase> {
  protected readonly database: TDatabase;

  constructor(database: TDatabase) {
    this.database = database;
  }

  listProjects(): readonly Project[] {
    return this.database
      .select()
      .from(projects)
      .orderBy(desc(projects.updatedAt), asc(projects.id))
      .all()
      .map(mapProject);
  }

  getProject(projectId: string): Project | null {
    const row = this.database.select().from(projects).where(eq(projects.id, projectId)).get();
    return row ? mapProject(row) : null;
  }

  getRevisionById(projectId: string, revisionId: string): SchemaRevision | null {
    const row = this.database
      .select()
      .from(schemaRevisions)
      .where(and(eq(schemaRevisions.projectId, projectId), eq(schemaRevisions.id, revisionId)))
      .get();
    return row ? mapRevision(row) : null;
  }

  getRevisionByNumber(projectId: string, revisionNo: number): SchemaRevision | null {
    const row = this.database
      .select()
      .from(schemaRevisions)
      .where(
        and(eq(schemaRevisions.projectId, projectId), eq(schemaRevisions.revisionNo, revisionNo)),
      )
      .get();
    return row ? mapRevision(row) : null;
  }

  listRevisions(projectId: string): readonly SchemaRevision[] {
    return this.database
      .select()
      .from(schemaRevisions)
      .where(eq(schemaRevisions.projectId, projectId))
      .orderBy(desc(schemaRevisions.revisionNo), asc(schemaRevisions.id))
      .all()
      .map(mapRevision);
  }
}

class SqliteProjectTransaction
  extends SqliteProjectReader<SqliteTransaction>
  implements ProjectPersistenceTransaction
{
  insertProject(project: Project): void {
    this.database.insert(projects).values(project).run();
  }

  insertRevision(revision: SchemaRevision): void {
    this.database
      .insert(schemaRevisions)
      .values({
        id: revision.id,
        projectId: revision.projectId,
        revisionNo: revision.revisionNo,
        source: revision.source,
        sourceHash: revision.sourceHash,
        validity: revision.validity,
        origin: revision.origin,
        parserVersion: revision.parserVersion,
        diagnosticSummary: { ...revision.diagnosticSummary },
        createdAt: revision.createdAt,
      })
      .run();
  }

  updateProject(project: Project, expectedSchemaRevisionNo: number): boolean {
    const result = this.database
      .update(projects)
      .set({
        name: project.name,
        primaryDialect: project.primaryDialect,
        draftSource: project.draftSource,
        draftHash: project.draftHash,
        lastValidRevisionId: project.lastValidRevisionId,
        parserVersion: project.parserVersion,
        schemaRevisionNo: project.schemaRevisionNo,
        layoutRevisionNo: project.layoutRevisionNo,
        updatedAt: project.updatedAt,
      })
      .where(
        and(eq(projects.id, project.id), eq(projects.schemaRevisionNo, expectedSchemaRevisionNo)),
      )
      .run();
    return result.changes === 1;
  }

  deleteProject(projectId: string, expectedSchemaRevisionNo: number): boolean {
    const result = this.database
      .delete(projects)
      .where(
        and(eq(projects.id, projectId), eq(projects.schemaRevisionNo, expectedSchemaRevisionNo)),
      )
      .run();
    return result.changes === 1;
  }

  deleteRevisions(projectId: string, revisionIds: readonly string[]): number {
    if (revisionIds.length === 0) return 0;
    return this.database
      .delete(schemaRevisions)
      .where(
        and(
          eq(schemaRevisions.projectId, projectId),
          inArray(schemaRevisions.id, [...revisionIds]),
        ),
      )
      .run().changes;
  }
}

class SqliteProjectRepository
  extends SqliteProjectReader<SqliteDatabase>
  implements ProjectPersistencePort
{
  readonly #storage: SqliteStorage;

  constructor(storage: SqliteStorage) {
    super(storage.database);
    this.#storage = storage;
  }

  transaction<T>(operation: (transaction: ProjectPersistenceTransaction) => T): T {
    return this.#storage.transaction((transaction) =>
      operation(new SqliteProjectTransaction(transaction)),
    );
  }
}

export function createSqliteProjectRepository(storage: SqliteStorage): ProjectPersistencePort {
  return new SqliteProjectRepository(storage);
}

function mapProject(row: StoredProject): Project {
  return {
    id: row.id,
    name: row.name,
    primaryDialect: row.primaryDialect,
    draftSource: row.draftSource,
    draftHash: row.draftHash,
    lastValidRevisionId: row.lastValidRevisionId,
    parserVersion: row.parserVersion,
    schemaRevisionNo: row.schemaRevisionNo,
    layoutRevisionNo: row.layoutRevisionNo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapRevision(row: StoredRevision): SchemaRevision {
  return {
    id: row.id,
    projectId: row.projectId,
    revisionNo: row.revisionNo,
    source: row.source,
    sourceHash: row.sourceHash,
    validity: row.validity,
    origin: row.origin,
    parserVersion: row.parserVersion,
    diagnosticSummary: parseDiagnosticSummary(row.diagnosticSummary, row.id),
    createdAt: row.createdAt,
  };
}

function parseDiagnosticSummary(value: unknown, revisionId: string): DiagnosticSummary {
  if (!isRecord(value)) throwInvalidDiagnosticSummary(revisionId);
  const keys = Object.keys(value).sort(compareStrings);
  if (keys.join(",") !== "errors,infos,parserVersion,warnings") {
    throwInvalidDiagnosticSummary(revisionId);
  }
  if (
    !isNonNegativeInteger(value.errors) ||
    !isNonNegativeInteger(value.warnings) ||
    !isNonNegativeInteger(value.infos) ||
    typeof value.parserVersion !== "string" ||
    value.parserVersion.length === 0
  ) {
    throwInvalidDiagnosticSummary(revisionId);
  }
  return {
    errors: value.errors,
    warnings: value.warnings,
    infos: value.infos,
    parserVersion: value.parserVersion,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function throwInvalidDiagnosticSummary(revisionId: string): never {
  throw new SqliteStorageError(
    "SQLITE_PROJECT_DATA_INVALID",
    `Schema revision has an invalid diagnostic summary: ${revisionId}`,
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
