import type { SchemaElementKey } from "../schema-graph.js";
import type { SchemaRenameCandidate } from "../schema-semantics.js";

export type DiagramDetailLevel = "NAME_ONLY" | "KEYS_ONLY" | "FULL";

export interface DiagramPosition {
  readonly x: number;
  readonly y: number;
}

export interface DiagramNodePlacement extends DiagramPosition {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface DiagramViewport extends DiagramPosition {
  readonly zoom: number;
}

export interface DiagramLayoutValue {
  readonly positions: Readonly<Record<SchemaElementKey, DiagramNodePlacement>>;
  readonly collapsedGroupKeys: readonly SchemaElementKey[];
  readonly hiddenElementKeys: readonly SchemaElementKey[];
  readonly viewport: DiagramViewport;
  readonly detailLevel: DiagramDetailLevel;
  readonly baseSchemaHash: string;
}

export interface DiagramLayout extends DiagramLayoutValue {
  readonly projectId: string;
  readonly viewKey: string;
  readonly revisionNo: number;
}

export interface LayoutState {
  readonly layout: DiagramLayout | null;
  readonly currentLayoutRevisionNo: number;
}

export interface LayoutMutation {
  readonly state: LayoutState;
  readonly layoutUpdated: boolean;
}

export interface SaveLayoutCommand {
  readonly projectId: string;
  readonly viewKey: string;
  readonly expectedLayoutRevisionNo: number;
  readonly layout: DiagramLayoutValue;
}

export type LayoutApplicationError =
  | {
      readonly code: "LAYOUT_PROJECT_NOT_FOUND";
      readonly message: string;
      readonly projectId: string;
    }
  | {
      readonly code: "LAYOUT_REVISION_CONFLICT";
      readonly message: string;
      readonly projectId: string;
      readonly expectedLayoutRevisionNo: number;
      readonly currentLayoutRevisionNo: number;
    }
  | {
      readonly code: "LAYOUT_INPUT_INVALID";
      readonly message: string;
    }
  | {
      readonly code: "LAYOUT_STORAGE_INVARIANT_VIOLATION";
      readonly message: string;
      readonly projectId: string;
    };

export type LayoutApplicationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LayoutApplicationError };

export interface LayoutPersistenceReader {
  getProjectLayoutRevisionNo(projectId: string): number | null;
  getLayout(projectId: string, viewKey: string): DiagramLayout | null;
}

export interface LayoutPersistenceTransaction extends LayoutPersistenceReader {
  upsertLayout(layout: DiagramLayout): void;
  updateProjectLayoutRevision(
    projectId: string,
    expectedLayoutRevisionNo: number,
    nextLayoutRevisionNo: number,
  ): boolean;
}

export interface LayoutPersistencePort extends LayoutPersistenceReader {
  transaction<T>(operation: (transaction: LayoutPersistenceTransaction) => T): T;
}

export interface LayoutApplication {
  getLayout(projectId: string, viewKey: string): Promise<LayoutApplicationResult<LayoutState>>;
  saveLayout(command: SaveLayoutCommand): Promise<LayoutApplicationResult<LayoutMutation>>;
}

export interface CreateLayoutApplicationOptions {
  readonly persistence: LayoutPersistencePort;
}

export class LayoutPersistenceInvariantError extends Error {
  constructor(
    readonly projectId: string,
    message: string,
  ) {
    super(message);
    this.name = "LayoutPersistenceInvariantError";
  }
}

export interface LayoutKeyRecovery {
  readonly layout: DiagramLayoutValue;
  readonly recoveredKeys: readonly SchemaElementKey[];
}

export function recoverLayoutStableKeys(
  layout: DiagramLayoutValue,
  renameCandidates: readonly SchemaRenameCandidate[],
): LayoutKeyRecovery {
  const positions = new Map(Object.entries(layout.positions));
  const hiddenElementKeys = new Set(layout.hiddenElementKeys);
  const recoveredKeys: SchemaElementKey[] = [];

  for (const candidate of renameCandidates) {
    if (candidate.confidence !== "HIGH" || candidate.reason !== "UNIQUE_EXACT_STRUCTURE") continue;
    let recovered = false;
    const previousPosition = positions.get(candidate.beforeKey);
    if (previousPosition && !positions.has(candidate.afterKey)) {
      positions.set(candidate.afterKey, { ...previousPosition });
      recovered = true;
    }
    if (hiddenElementKeys.has(candidate.beforeKey) && !hiddenElementKeys.has(candidate.afterKey)) {
      hiddenElementKeys.add(candidate.afterKey);
      recovered = true;
    }
    if (recovered) recoveredKeys.push(candidate.afterKey);
  }

  return {
    layout: {
      ...layout,
      positions: Object.fromEntries(positions),
      hiddenElementKeys: [...hiddenElementKeys],
    },
    recoveredKeys,
  };
}
