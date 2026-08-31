import {
  type DiagramLayout,
  type ProjectBundlePersistencePort,
  type ProjectBundlePersistenceReader,
  type ProjectBundlePersistenceTransaction,
  ProjectBundlePersistenceInvariantError,
  type SqlImportArtifact,
} from "@er-diagram/core";
import { asc, eq } from "drizzle-orm";

import { mapStoredLayout, toStoredLayout } from "./layout-repository.js";
import {
  type ProjectDatabase,
  SqliteProjectReader,
  SqliteProjectTransaction,
} from "./project-repository.js";
import { diagramLayouts, importArtifacts } from "./schema.js";
import { mapImportArtifact, toStoredImportArtifact } from "./sql-import-repository.js";
import type { SqliteStorage } from "./sqlite-storage.js";

class SqliteProjectBundleReader<TDatabase extends ProjectDatabase>
  extends SqliteProjectReader<TDatabase>
  implements ProjectBundlePersistenceReader
{
  listLayouts(projectId: string): readonly DiagramLayout[] {
    try {
      return this.database
        .select()
        .from(diagramLayouts)
        .where(eq(diagramLayouts.projectId, projectId))
        .orderBy(asc(diagramLayouts.viewKey))
        .all()
        .map(mapStoredLayout);
    } catch (error) {
      if (error instanceof ProjectBundlePersistenceInvariantError) throw error;
      throw new ProjectBundlePersistenceInvariantError(
        projectId,
        "Stored diagram layout is invalid for portable bundle export.",
      );
    }
  }

  listImportArtifacts(projectId: string): readonly SqlImportArtifact[] {
    try {
      return this.database
        .select()
        .from(importArtifacts)
        .where(eq(importArtifacts.projectId, projectId))
        .orderBy(asc(importArtifacts.createdAt), asc(importArtifacts.id))
        .all()
        .map(mapImportArtifact);
    } catch (error) {
      if (error instanceof ProjectBundlePersistenceInvariantError) throw error;
      throw new ProjectBundlePersistenceInvariantError(
        projectId,
        "Stored SQL import artifact is invalid for portable bundle export.",
      );
    }
  }
}

class SqliteProjectBundleTransaction
  extends SqliteProjectTransaction
  implements ProjectBundlePersistenceTransaction
{
  listLayouts(projectId: string): readonly DiagramLayout[] {
    try {
      return this.database
        .select()
        .from(diagramLayouts)
        .where(eq(diagramLayouts.projectId, projectId))
        .orderBy(asc(diagramLayouts.viewKey))
        .all()
        .map(mapStoredLayout);
    } catch {
      throw new ProjectBundlePersistenceInvariantError(
        projectId,
        "Stored diagram layout is invalid for portable bundle transaction.",
      );
    }
  }

  listImportArtifacts(projectId: string): readonly SqlImportArtifact[] {
    try {
      return this.database
        .select()
        .from(importArtifacts)
        .where(eq(importArtifacts.projectId, projectId))
        .orderBy(asc(importArtifacts.createdAt), asc(importArtifacts.id))
        .all()
        .map(mapImportArtifact);
    } catch {
      throw new ProjectBundlePersistenceInvariantError(
        projectId,
        "Stored SQL import artifact is invalid for portable bundle transaction.",
      );
    }
  }

  insertLayout(layout: DiagramLayout): void {
    this.database.insert(diagramLayouts).values(toStoredLayout(layout)).run();
  }

  insertImportArtifact(artifact: SqlImportArtifact): void {
    this.database.insert(importArtifacts).values(toStoredImportArtifact(artifact)).run();
  }
}

class SqliteProjectBundleRepository
  extends SqliteProjectBundleReader<ProjectDatabase>
  implements ProjectBundlePersistencePort
{
  constructor(private readonly storage: SqliteStorage) {
    super(storage.database);
  }

  transaction<T>(operation: (transaction: ProjectBundlePersistenceTransaction) => T): T {
    try {
      return this.storage.transaction((transaction) =>
        operation(new SqliteProjectBundleTransaction(transaction)),
      );
    } catch (error) {
      if (error instanceof ProjectBundlePersistenceInvariantError) throw error;
      throw new ProjectBundlePersistenceInvariantError(
        undefined,
        "Portable bundle transaction failed.",
      );
    }
  }
}

export function createSqliteProjectBundleRepository(
  storage: SqliteStorage,
): ProjectBundlePersistencePort {
  return new SqliteProjectBundleRepository(storage);
}
