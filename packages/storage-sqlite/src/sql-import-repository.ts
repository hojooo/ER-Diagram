import { createHash } from "node:crypto";
import {
  isCreateProjectSqlImportEnvelope,
  parseSqlImportArtifactEnvelope,
  type SqlImportArtifact,
  type SqlImportPersistencePort,
  type SqlImportPersistenceTransaction,
  SqlImportPersistenceInvariantError,
  sqlImportCreatePreviewHashPreimage,
  sqlImportPreviewHashPreimage,
} from "@er-diagram/core";
import { and, eq } from "drizzle-orm";

import {
  type ProjectDatabase,
  SqliteProjectReader,
  SqliteProjectTransaction,
} from "./project-repository.js";
import { importArtifacts } from "./schema.js";
import type { SqliteDatabase, SqliteStorage } from "./sqlite-storage.js";

type StoredImportArtifact = typeof importArtifacts.$inferSelect;

class SqliteSqlImportReader<
  TDatabase extends ProjectDatabase,
> extends SqliteProjectReader<TDatabase> {
  getImportArtifact(projectId: string, artifactId: string): SqlImportArtifact | null {
    const row = this.database
      .select()
      .from(importArtifacts)
      .where(and(eq(importArtifacts.projectId, projectId), eq(importArtifacts.id, artifactId)))
      .get();
    return row ? mapImportArtifact(row) : null;
  }
}

class SqliteSqlImportTransaction
  extends SqliteProjectTransaction
  implements SqlImportPersistenceTransaction
{
  getImportArtifact(projectId: string, artifactId: string): SqlImportArtifact | null {
    const row = this.database
      .select()
      .from(importArtifacts)
      .where(and(eq(importArtifacts.projectId, projectId), eq(importArtifacts.id, artifactId)))
      .get();
    return row ? mapImportArtifact(row) : null;
  }

  insertImportArtifact(artifact: SqlImportArtifact): void {
    this.database.insert(importArtifacts).values(toStoredImportArtifact(artifact)).run();
  }

  markImportArtifactApplied(artifact: SqlImportArtifact, expectedStatus: "PREVIEWED"): boolean {
    const result = this.database
      .update(importArtifacts)
      .set({
        report: { ...artifact.envelope },
        status: artifact.status,
        appliedAt: artifact.appliedAt,
      })
      .where(
        and(
          eq(importArtifacts.id, artifact.id),
          eq(importArtifacts.projectId, artifact.projectId),
          eq(importArtifacts.status, expectedStatus),
        ),
      )
      .run();
    return result.changes === 1;
  }
}

class SqliteSqlImportRepository
  extends SqliteSqlImportReader<SqliteDatabase>
  implements SqlImportPersistencePort
{
  constructor(private readonly storage: SqliteStorage) {
    super(storage.database);
  }

  transaction<T>(operation: (transaction: SqlImportPersistenceTransaction) => T): T {
    return this.storage.transaction((transaction) =>
      operation(new SqliteSqlImportTransaction(transaction)),
    );
  }
}

export function createSqliteSqlImportRepository(storage: SqliteStorage): SqlImportPersistencePort {
  return new SqliteSqlImportRepository(storage);
}

export function toStoredImportArtifact(
  artifact: SqlImportArtifact,
): typeof importArtifacts.$inferInsert {
  return {
    id: artifact.id,
    projectId: artifact.projectId,
    dialect: artifact.dialect,
    originalSql: artifact.originalSql,
    originalHash: artifact.originalHash,
    generatedDbml: artifact.generatedDbml,
    parserVersion: artifact.parserVersion,
    report: { ...artifact.envelope },
    status: artifact.status,
    createdAt: artifact.createdAt,
    appliedAt: artifact.appliedAt,
  };
}

export function mapImportArtifact(row: StoredImportArtifact): SqlImportArtifact {
  const envelope = parseSqlImportArtifactEnvelope(row.projectId, row.report);
  const invalid = (message: string): never => {
    throw new SqlImportPersistenceInvariantError(row.projectId, message);
  };
  const report = envelope.evidence.report;
  if (
    envelope.evidence.dialect !== row.dialect ||
    envelope.evidence.sourceHash !== row.originalHash ||
    report.sourceHash !== row.originalHash ||
    report.parserInputHash !== row.originalHash ||
    report.dialect !== row.dialect ||
    report.parserVersions.dbmlParse !== row.parserVersion ||
    report.candidateDbmlHash !== envelope.evidence.candidateDbmlHash
  ) {
    return invalid("Stored SQL import artifact row does not match its preview evidence.");
  }
  if (
    !isCreateProjectSqlImportEnvelope(envelope) &&
    envelope.evidence.projectId !== row.projectId
  ) {
    return invalid("Stored SQL import artifact row does not match its project evidence.");
  }
  const previewHash = sha256(
    isCreateProjectSqlImportEnvelope(envelope)
      ? sqlImportCreatePreviewHashPreimage({
          evidence: envelope.evidence,
          previewPolicy: envelope.previewPolicy,
          originalSqlRetention: envelope.originalSqlRetention,
        })
      : sqlImportPreviewHashPreimage({
          evidence: envelope.evidence,
          previewPolicy: envelope.previewPolicy,
          originalSqlRetention: envelope.originalSqlRetention,
        }),
  );
  if (previewHash !== envelope.previewHash) {
    return invalid("Stored SQL import preview hash does not match its evidence.");
  }

  if (envelope.originalSqlRetention === "RETAIN") {
    if (row.originalSql === null || sha256(row.originalSql) !== row.originalHash) {
      return invalid("Stored retained SQL does not match its original hash.");
    }
  } else if (row.originalSql !== null) {
    return invalid("Discarded SQL import unexpectedly retains original source.");
  }

  if (isCreateProjectSqlImportEnvelope(envelope) && row.status !== "APPLIED") {
    return invalid("Created-project SQL import artifact must already be applied.");
  }

  if (row.status === "FAILED") {
    if (
      row.generatedDbml !== null ||
      envelope.evidence.candidateDbmlHash !== null ||
      envelope.appliedPolicy !== null ||
      row.appliedAt !== null
    ) {
      return invalid("Failed SQL import artifact contains successful preview state.");
    }
  } else if (
    row.generatedDbml === null ||
    envelope.evidence.candidateDbmlHash === null ||
    sha256(row.generatedDbml) !== envelope.evidence.candidateDbmlHash
  ) {
    return invalid("Stored candidate DBML does not match its preview evidence.");
  }

  if (row.status === "APPLIED") {
    if (row.appliedAt === null || envelope.appliedPolicy === null) {
      return invalid("Applied SQL import artifact is missing its applied policy or timestamp.");
    }
  } else if (row.appliedAt !== null || envelope.appliedPolicy !== null) {
    return invalid("Unapplied SQL import artifact contains applied state.");
  }

  return {
    id: row.id,
    projectId: row.projectId,
    dialect: row.dialect,
    originalSql: row.originalSql,
    originalHash: row.originalHash,
    generatedDbml: row.generatedDbml,
    parserVersion: row.parserVersion,
    envelope,
    status: row.status,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
