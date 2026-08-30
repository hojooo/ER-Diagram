import {
  type DiagramLayout,
  type DiagramPosition,
  type DiagramViewport,
  LayoutPersistenceInvariantError,
  type LayoutPersistencePort,
  type LayoutPersistenceTransaction,
} from "@er-diagram/core";
import { and, eq } from "drizzle-orm";

import { diagramLayouts, projects } from "./schema.js";
import type { SqliteDatabase, SqliteStorage, SqliteTransaction } from "./sqlite-storage.js";

type LayoutDatabase = SqliteDatabase | SqliteTransaction;
type StoredLayout = typeof diagramLayouts.$inferSelect;

class SqliteLayoutReader<TDatabase extends LayoutDatabase> {
  constructor(protected readonly database: TDatabase) {}

  getProjectLayoutRevisionNo(projectId: string): number | null {
    const row = this.database
      .select({ layoutRevisionNo: projects.layoutRevisionNo })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    return row?.layoutRevisionNo ?? null;
  }

  getLayout(projectId: string, viewKey: string): DiagramLayout | null {
    const row = this.database
      .select()
      .from(diagramLayouts)
      .where(and(eq(diagramLayouts.projectId, projectId), eq(diagramLayouts.viewKey, viewKey)))
      .get();
    return row ? mapStoredLayout(row) : null;
  }
}

class SqliteLayoutTransaction
  extends SqliteLayoutReader<SqliteTransaction>
  implements LayoutPersistenceTransaction
{
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

  updateProjectLayoutRevision(
    projectId: string,
    expectedLayoutRevisionNo: number,
    nextLayoutRevisionNo: number,
  ): boolean {
    const result = this.database
      .update(projects)
      .set({ layoutRevisionNo: nextLayoutRevisionNo })
      .where(
        and(eq(projects.id, projectId), eq(projects.layoutRevisionNo, expectedLayoutRevisionNo)),
      )
      .run();
    return result.changes === 1;
  }
}

class SqliteLayoutRepository
  extends SqliteLayoutReader<SqliteDatabase>
  implements LayoutPersistencePort
{
  constructor(private readonly storage: SqliteStorage) {
    super(storage.database);
  }

  transaction<T>(operation: (transaction: LayoutPersistenceTransaction) => T): T {
    return this.storage.transaction((transaction) =>
      operation(new SqliteLayoutTransaction(transaction)),
    );
  }
}

export function createSqliteLayoutRepository(storage: SqliteStorage): LayoutPersistencePort {
  return new SqliteLayoutRepository(storage);
}

export function mapStoredLayout(row: StoredLayout): DiagramLayout {
  return {
    projectId: row.projectId,
    viewKey: row.viewKey,
    positions: parsePositions(row.positions, row.projectId),
    collapsedGroupKeys: parseKeyList(row.collapsedGroupKeys, row.projectId),
    hiddenElementKeys: parseKeyList(row.hiddenElementKeys, row.projectId),
    viewport: parseViewport(row.viewport, row.projectId),
    detailLevel: row.detailLevel,
    baseSchemaHash: row.baseSchemaHash,
    revisionNo: row.revisionNo,
  };
}

export function toStoredLayout(layout: DiagramLayout): typeof diagramLayouts.$inferInsert {
  return {
    projectId: layout.projectId,
    viewKey: layout.viewKey,
    positions: Object.fromEntries(
      Object.entries(layout.positions).map(([key, position]) => [key, { ...position }]),
    ),
    collapsedGroupKeys: [...layout.collapsedGroupKeys],
    hiddenElementKeys: [...layout.hiddenElementKeys],
    viewport: { ...layout.viewport },
    detailLevel: layout.detailLevel,
    baseSchemaHash: layout.baseSchemaHash,
    revisionNo: layout.revisionNo,
  };
}

function parsePositions(
  value: unknown,
  projectId: string,
): Readonly<Record<string, DiagramPosition>> {
  if (!isRecord(value)) return invalid(projectId, "positions");
  const positions: Array<readonly [string, DiagramPosition]> = [];
  for (const key of Object.keys(value).sort(compareStrings)) {
    const position = value[key];
    if (
      key.trim().length === 0 ||
      !isExactRecord(position, ["x", "y"]) ||
      !isFiniteNumber(position.x) ||
      !isFiniteNumber(position.y)
    ) {
      return invalid(projectId, "positions");
    }
    positions.push([key, { x: position.x, y: position.y }]);
  }
  return Object.fromEntries(positions);
}

function parseKeyList(value: unknown, projectId: string): readonly string[] {
  if (!Array.isArray(value)) return invalid(projectId, "element key list");
  const unique = new Set<string>();
  for (const key of value) {
    if (typeof key !== "string" || key.trim().length === 0 || unique.has(key)) {
      return invalid(projectId, "element key list");
    }
    unique.add(key);
  }
  return [...unique].sort(compareStrings);
}

function parseViewport(value: unknown, projectId: string): DiagramViewport {
  if (
    !isExactRecord(value, ["x", "y", "zoom"]) ||
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y) ||
    !isFiniteNumber(value.zoom) ||
    value.zoom <= 0
  ) {
    return invalid(projectId, "viewport");
  }
  return { x: value.x, y: value.y, zoom: value.zoom };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).sort(compareStrings).join(",") === [...keys].sort(compareStrings).join(",")
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function invalid(projectId: string, field: string): never {
  throw new LayoutPersistenceInvariantError(
    projectId,
    `Stored diagram layout has invalid ${field}.`,
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
