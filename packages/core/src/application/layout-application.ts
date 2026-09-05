import {
  type CreateLayoutApplicationOptions,
  type DiagramLayout,
  type DiagramLayoutValue,
  type LayoutApplication,
  type LayoutApplicationError,
  type LayoutApplicationResult,
  type LayoutMutation,
  type LayoutPersistencePort,
  LayoutPersistenceInvariantError,
  type LayoutPersistenceReader,
  type LayoutPersistenceTransaction,
  type LayoutState,
  type SaveLayoutCommand,
} from "./layout.js";

const SHA_256_HEX = /^[0-9a-f]{64}$/;
const DETAIL_LEVELS = new Set(["NAME_ONLY", "KEYS_ONLY", "FULL"]);

class ExpectedLayoutFailure extends Error {
  constructor(readonly applicationError: LayoutApplicationError) {
    super(applicationError.message);
    this.name = "ExpectedLayoutFailure";
  }
}

export function createLayoutApplication(
  options: CreateLayoutApplicationOptions,
): LayoutApplication {
  return {
    getLayout: async (projectId, viewKey) =>
      readResult(projectId, () => readLayoutState(options.persistence, projectId, viewKey)),
    saveLayout: async (command) => saveLayout(options.persistence, command),
  };
}

function saveLayout(
  persistence: LayoutPersistencePort,
  command: SaveLayoutCommand,
): LayoutApplicationResult<LayoutMutation> {
  const input = normalizeInput(command);
  if (!input.ok) return input;

  return transactionResult(persistence, command.projectId, (transaction) => {
    const currentRevisionNo = requireProject(transaction, command.projectId);
    expectRevision(command, currentRevisionNo);
    const existing = readStoredLayout(
      transaction,
      command.projectId,
      command.viewKey,
      currentRevisionNo,
    );
    if (existing && layoutValuesEqual(existing, input.value)) {
      return {
        state: { layout: existing, currentLayoutRevisionNo: currentRevisionNo },
        layoutUpdated: false,
      };
    }

    const nextRevisionNo = currentRevisionNo + 1;
    if (!Number.isSafeInteger(nextRevisionNo)) {
      throw new ExpectedLayoutFailure(invariant(command.projectId, "Layout revision overflowed."));
    }
    const layout: DiagramLayout = {
      projectId: command.projectId,
      viewKey: command.viewKey,
      ...input.value,
      revisionNo: nextRevisionNo,
    };
    transaction.upsertLayout(layout);
    if (
      !transaction.updateProjectLayoutRevision(command.projectId, currentRevisionNo, nextRevisionNo)
    ) {
      const latest = transaction.getProjectLayoutRevisionNo(command.projectId);
      if (latest === null) throw new ExpectedLayoutFailure(projectNotFound(command.projectId));
      throw new ExpectedLayoutFailure(conflict(command, latest));
    }
    return {
      state: { layout, currentLayoutRevisionNo: nextRevisionNo },
      layoutUpdated: true,
    };
  });
}

function readLayoutState(
  reader: LayoutPersistenceReader,
  projectId: string,
  viewKey: string,
): LayoutState {
  validateIdentity(projectId, viewKey);
  const currentLayoutRevisionNo = requireProject(reader, projectId);
  return {
    layout: readStoredLayout(reader, projectId, viewKey, currentLayoutRevisionNo),
    currentLayoutRevisionNo,
  };
}

function readStoredLayout(
  reader: LayoutPersistenceReader,
  projectId: string,
  viewKey: string,
  currentRevisionNo: number,
): DiagramLayout | null {
  const layout = reader.getLayout(projectId, viewKey);
  if (!layout) return null;
  if (
    layout.projectId !== projectId ||
    layout.viewKey !== viewKey ||
    !Number.isSafeInteger(layout.revisionNo) ||
    layout.revisionNo < 0 ||
    layout.revisionNo > currentRevisionNo
  ) {
    throw new ExpectedLayoutFailure(
      invariant(projectId, "Stored layout identity or revision is inconsistent."),
    );
  }
  const normalized = normalizeLayoutValue(layout);
  if (!normalized.ok) {
    throw new ExpectedLayoutFailure(invariant(projectId, normalized.error.message));
  }
  return { projectId, viewKey, ...normalized.value, revisionNo: layout.revisionNo };
}

function normalizeInput(command: SaveLayoutCommand): LayoutApplicationResult<DiagramLayoutValue> {
  try {
    validateIdentity(command.projectId, command.viewKey);
  } catch (error) {
    if (error instanceof ExpectedLayoutFailure) return failure(error.applicationError);
    throw error;
  }
  if (
    !Number.isSafeInteger(command.expectedLayoutRevisionNo) ||
    command.expectedLayoutRevisionNo < 0
  ) {
    return failure(invalid("Expected layout revision must be a non-negative safe integer."));
  }
  return normalizeLayoutValue(command.layout);
}

function normalizeLayoutValue(
  layout: DiagramLayoutValue,
): LayoutApplicationResult<DiagramLayoutValue> {
  const positions: Array<
    readonly [
      string,
      { readonly x: number; readonly y: number; readonly width?: number; readonly height?: number },
    ]
  > = [];
  if (!isRecord(layout.positions)) return failure(invalid("Layout positions must be an object."));
  for (const key of Object.keys(layout.positions).sort(compareStrings)) {
    const position = layout.positions[key];
    if (
      !isNonBlank(key) ||
      !position ||
      !isFiniteNumber(position.x) ||
      !isFiniteNumber(position.y) ||
      !validPlacementDimensions(key, position.width, position.height)
    ) {
      return failure(invalid("Layout positions contain an invalid key or coordinate."));
    }
    positions.push([
      key,
      position.width === undefined
        ? { x: position.x, y: position.y }
        : {
            x: position.x,
            y: position.y,
            width: position.width,
            height: position.height as number,
          },
    ]);
  }
  const collapsed = normalizeKeyList(layout.collapsedGroupKeys, "collapsed group keys");
  if (!collapsed.ok) return collapsed;
  const hidden = normalizeKeyList(layout.hiddenElementKeys, "hidden element keys");
  if (!hidden.ok) return hidden;
  if (
    !layout.viewport ||
    !isFiniteNumber(layout.viewport.x) ||
    !isFiniteNumber(layout.viewport.y) ||
    !isFiniteNumber(layout.viewport.zoom) ||
    layout.viewport.zoom <= 0
  ) {
    return failure(invalid("Layout viewport must contain finite coordinates and positive zoom."));
  }
  if (!DETAIL_LEVELS.has(layout.detailLevel)) {
    return failure(invalid("Layout detail level is invalid."));
  }
  if (!SHA_256_HEX.test(layout.baseSchemaHash)) {
    return failure(invalid("Layout base schema hash must be a lowercase SHA-256 value."));
  }
  return success({
    positions: Object.fromEntries(positions),
    collapsedGroupKeys: collapsed.value,
    hiddenElementKeys: hidden.value,
    viewport: { ...layout.viewport },
    detailLevel: layout.detailLevel,
    baseSchemaHash: layout.baseSchemaHash,
  });
}

function validPlacementDimensions(
  key: string,
  width: number | undefined,
  height: number | undefined,
): boolean {
  if (width === undefined && height === undefined) return true;
  return (
    key.startsWith("table:[") &&
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    (width ?? 0) > 0 &&
    (height ?? 0) > 0
  );
}

function normalizeKeyList(
  values: readonly string[],
  label: string,
): LayoutApplicationResult<readonly string[]> {
  if (!Array.isArray(values)) return failure(invalid(`Layout ${label} must be an array.`));
  const unique = new Set<string>();
  for (const value of values) {
    if (!isNonBlank(value)) return failure(invalid(`Layout ${label} contain an invalid key.`));
    if (unique.has(value)) return failure(invalid(`Layout ${label} must not contain duplicates.`));
    unique.add(value);
  }
  return success([...unique].sort(compareStrings));
}

function layoutValuesEqual(layout: DiagramLayout, input: DiagramLayoutValue): boolean {
  return JSON.stringify(toComparable(layout)) === JSON.stringify(toComparable(input));
}

function toComparable(layout: DiagramLayoutValue): DiagramLayoutValue {
  return {
    positions: layout.positions,
    collapsedGroupKeys: layout.collapsedGroupKeys,
    hiddenElementKeys: layout.hiddenElementKeys,
    viewport: layout.viewport,
    detailLevel: layout.detailLevel,
    baseSchemaHash: layout.baseSchemaHash,
  };
}

function requireProject(reader: LayoutPersistenceReader, projectId: string): number {
  const revision = reader.getProjectLayoutRevisionNo(projectId);
  if (revision === null) throw new ExpectedLayoutFailure(projectNotFound(projectId));
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ExpectedLayoutFailure(
      invariant(projectId, "Stored project layout revision is invalid."),
    );
  }
  return revision;
}

function expectRevision(command: SaveLayoutCommand, current: number): void {
  if (command.expectedLayoutRevisionNo !== current) {
    throw new ExpectedLayoutFailure(conflict(command, current));
  }
}

function validateIdentity(projectId: string, viewKey: string): void {
  if (!isNonBlank(projectId) || !isNonBlank(viewKey)) {
    throw new ExpectedLayoutFailure(invalid("Project ID and view key must not be blank."));
  }
}

function projectNotFound(projectId: string): LayoutApplicationError {
  return { code: "LAYOUT_PROJECT_NOT_FOUND", message: "Project was not found.", projectId };
}

function conflict(command: SaveLayoutCommand, current: number): LayoutApplicationError {
  return {
    code: "LAYOUT_REVISION_CONFLICT",
    message: `Expected layout revision ${command.expectedLayoutRevisionNo}, current revision is ${current}.`,
    projectId: command.projectId,
    expectedLayoutRevisionNo: command.expectedLayoutRevisionNo,
    currentLayoutRevisionNo: current,
  };
}

function invalid(message: string): LayoutApplicationError {
  return { code: "LAYOUT_INPUT_INVALID", message };
}

function invariant(projectId: string, message: string): LayoutApplicationError {
  return { code: "LAYOUT_STORAGE_INVARIANT_VIOLATION", message, projectId };
}

function readResult<T>(projectId: string, operation: () => T): LayoutApplicationResult<T> {
  try {
    return success(operation());
  } catch (error) {
    return mapFailure(error, projectId);
  }
}

function transactionResult<T>(
  persistence: LayoutPersistencePort,
  projectId: string,
  operation: (transaction: LayoutPersistenceTransaction) => T,
): LayoutApplicationResult<T> {
  try {
    return success(persistence.transaction(operation));
  } catch (error) {
    return mapFailure(error, projectId);
  }
}

function mapFailure<T>(error: unknown, projectId: string): LayoutApplicationResult<T> {
  if (error instanceof ExpectedLayoutFailure) return failure(error.applicationError);
  if (error instanceof LayoutPersistenceInvariantError) {
    return failure(invariant(projectId, error.message));
  }
  throw error;
}

function success<T>(value: T): LayoutApplicationResult<T> {
  return { ok: true, value };
}

function failure<T = never>(error: LayoutApplicationError): LayoutApplicationResult<T> {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
