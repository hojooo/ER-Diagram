import {
  type DiagramLayout,
  VisualCommandPersistenceInvariantError,
  type VisualCommandPersistencePort,
  type VisualCommandPersistenceReader,
  type VisualCommandPersistenceTransaction,
  type VisualCommandReceipt,
} from "@er-diagram/core";
import { and, asc, eq } from "drizzle-orm";

import { mapStoredLayout, toStoredLayout } from "./layout-repository.js";
import {
  type ProjectDatabase,
  SqliteProjectReader,
  SqliteProjectTransaction,
} from "./project-repository.js";
import { diagramLayouts, VISUAL_COMMAND_KINDS, visualCommandReceipts } from "./schema.js";
import type { SqliteStorage } from "./sqlite-storage.js";

type StoredReceipt = typeof visualCommandReceipts.$inferSelect;

class SqliteVisualCommandReader<TDatabase extends ProjectDatabase>
  extends SqliteProjectReader<TDatabase>
  implements VisualCommandPersistenceReader
{
  getVisualCommandReceipt(projectId: string, commandId: string): VisualCommandReceipt | null {
    return selectReceipt(this.database, projectId, commandId);
  }

  listLayouts(projectId: string): readonly DiagramLayout[] {
    return selectLayouts(this.database, projectId);
  }
}

class SqliteVisualCommandTransaction
  extends SqliteProjectTransaction
  implements VisualCommandPersistenceTransaction
{
  getVisualCommandReceipt(projectId: string, commandId: string): VisualCommandReceipt | null {
    return selectReceipt(this.database, projectId, commandId);
  }

  listLayouts(projectId: string): readonly DiagramLayout[] {
    return selectLayouts(this.database, projectId);
  }

  insertVisualCommandReceipt(receipt: VisualCommandReceipt): void {
    this.database
      .insert(visualCommandReceipts)
      .values({
        projectId: receipt.projectId,
        commandId: receipt.commandId,
        commandKind: receipt.commandKind,
        commandHash: receipt.commandHash,
        expectedSchemaRevisionNo: receipt.expectedSchemaRevisionNo,
        appliedSchemaRevisionNo: receipt.appliedSchemaRevisionNo,
        appliedLayoutRevisionNo: receipt.appliedLayoutRevisionNo,
        revisionCreated: receipt.revisionCreated,
        layoutMigrated: receipt.layoutMigrated,
        createdAt: receipt.createdAt,
      })
      .run();
  }

  upsertLayout(layout: DiagramLayout): void {
    const values = toStoredLayout(layout);
    this.database
      .insert(diagramLayouts)
      .values(values)
      .onConflictDoUpdate({
        target: [diagramLayouts.projectId, diagramLayouts.viewKey],
        set: {
          positions: values.positions,
          collapsedGroupKeys: values.collapsedGroupKeys,
          hiddenElementKeys: values.hiddenElementKeys,
          viewport: values.viewport,
          detailLevel: values.detailLevel,
          baseSchemaHash: values.baseSchemaHash,
          revisionNo: values.revisionNo,
        },
      })
      .run();
  }
}

class SqliteVisualCommandRepository
  extends SqliteVisualCommandReader<ProjectDatabase>
  implements VisualCommandPersistencePort
{
  constructor(private readonly storage: SqliteStorage) {
    super(storage.database);
  }

  transaction<T>(operation: (transaction: VisualCommandPersistenceTransaction) => T): T {
    return this.storage.transaction((transaction) =>
      operation(new SqliteVisualCommandTransaction(transaction)),
    );
  }
}

export function createSqliteVisualCommandRepository(
  storage: SqliteStorage,
): VisualCommandPersistencePort {
  return new SqliteVisualCommandRepository(storage);
}

function selectReceipt(
  database: ProjectDatabase,
  projectId: string,
  commandId: string,
): VisualCommandReceipt | null {
  const row = database
    .select()
    .from(visualCommandReceipts)
    .where(
      and(
        eq(visualCommandReceipts.projectId, projectId),
        eq(visualCommandReceipts.commandId, commandId),
      ),
    )
    .get();
  return row ? mapReceipt(row) : null;
}

function selectLayouts(database: ProjectDatabase, projectId: string): readonly DiagramLayout[] {
  const rows = database
    .select()
    .from(diagramLayouts)
    .where(eq(diagramLayouts.projectId, projectId))
    .orderBy(asc(diagramLayouts.viewKey))
    .all();
  try {
    return rows.map(mapStoredLayout);
  } catch {
    throw new VisualCommandPersistenceInvariantError(
      projectId,
      "Stored diagram layout is invalid for visual command migration.",
    );
  }
}

function mapReceipt(row: StoredReceipt): VisualCommandReceipt {
  if (
    !isCanonicalUuid(row.commandId) ||
    !VISUAL_COMMAND_KINDS.includes(row.commandKind) ||
    !isSha256(row.commandHash) ||
    !Number.isSafeInteger(row.expectedSchemaRevisionNo) ||
    row.expectedSchemaRevisionNo < 1 ||
    !Number.isSafeInteger(row.appliedSchemaRevisionNo) ||
    row.appliedSchemaRevisionNo < 1 ||
    !Number.isSafeInteger(row.appliedLayoutRevisionNo) ||
    row.appliedLayoutRevisionNo < 0 ||
    !isUtcIsoTimestamp(row.createdAt) ||
    (row.revisionCreated
      ? row.appliedSchemaRevisionNo !== row.expectedSchemaRevisionNo + 1
      : row.appliedSchemaRevisionNo !== row.expectedSchemaRevisionNo)
  ) {
    throw new VisualCommandPersistenceInvariantError(
      row.projectId,
      "Stored visual command receipt is invalid.",
    );
  }
  return {
    projectId: row.projectId,
    commandId: row.commandId,
    commandKind: row.commandKind,
    commandHash: row.commandHash,
    expectedSchemaRevisionNo: row.expectedSchemaRevisionNo,
    appliedSchemaRevisionNo: row.appliedSchemaRevisionNo,
    appliedLayoutRevisionNo: row.appliedLayoutRevisionNo,
    revisionCreated: row.revisionCreated,
    layoutMigrated: row.layoutMigrated,
    createdAt: row.createdAt,
  };
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function isUtcIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}
