import type { Diagnostic, VisualCommand, VisualCommandKind } from "@er-diagram/contracts";
import type { SchemaElementKey } from "../schema-graph.js";
import type { SchemaGraphDiff } from "../schema-semantics.js";
import type { DiagramLayout } from "./layout.js";
import type {
  ProjectPersistencePort,
  ProjectPersistenceReader,
  ProjectPersistenceTransaction,
  ProjectState,
} from "./project.js";

export interface ApplyVisualCommandCommand {
  readonly projectId: string;
  readonly command: VisualCommand;
}

export interface VisualCommandMutation {
  readonly state: ProjectState;
  readonly revisionCreated: boolean;
  readonly layoutMigrated: boolean;
  readonly replayed: boolean;
  readonly appliedSchemaRevisionNo: number;
  readonly appliedLayoutRevisionNo: number;
}

export interface VisualCommandReceipt {
  readonly projectId: string;
  readonly commandId: string;
  readonly commandKind: VisualCommandKind;
  readonly commandHash: string;
  readonly expectedSchemaRevisionNo: number;
  readonly appliedSchemaRevisionNo: number;
  readonly appliedLayoutRevisionNo: number;
  readonly revisionCreated: boolean;
  readonly layoutMigrated: boolean;
  readonly createdAt: string;
}

export interface VisualCommandTransformDiagnosticRange {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface VisualCommandTransformDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "ERROR" | "WARNING" | "INFO";
  readonly range?: VisualCommandTransformDiagnosticRange;
}

export interface VisualCommandPartialImpact {
  readonly partialKey: SchemaElementKey;
  readonly partialName: string;
  readonly partialElementKey: SchemaElementKey;
  readonly definitionRange: VisualCommandTransformDiagnosticRange;
  readonly affectedTables: readonly {
    readonly tableKey: SchemaElementKey;
    readonly injectionRange: VisualCommandTransformDiagnosticRange;
  }[];
}

export type VisualCommandTransformResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly source: string;
      readonly beforeSchemaHash: string;
      readonly afterSchemaHash: string;
      readonly semanticDiff: SchemaGraphDiff;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly ok: false;
      readonly source: string;
      readonly diagnostics: readonly VisualCommandTransformDiagnostic[];
      readonly partialImpact?: VisualCommandPartialImpact;
    };

export type VisualCommandTransformer = (
  source: string,
  command: VisualCommand,
  filepath?: string,
) => Promise<VisualCommandTransformResult>;

export type VisualCommandApplicationError =
  | {
      readonly code: "VISUAL_COMMAND_PROJECT_NOT_FOUND";
      readonly message: string;
      readonly projectId: string;
    }
  | {
      readonly code: "VISUAL_COMMAND_INVALID";
      readonly message: string;
    }
  | {
      readonly code: "VISUAL_COMMAND_SCHEMA_REVISION_CONFLICT";
      readonly message: string;
      readonly projectId: string;
      readonly expectedSchemaRevisionNo: number;
      readonly currentSchemaRevisionNo: number;
    }
  | {
      readonly code: "VISUAL_COMMAND_DRAFT_INVALID";
      readonly message: string;
      readonly projectId: string;
    }
  | {
      readonly code: "VISUAL_COMMAND_IDEMPOTENCY_CONFLICT";
      readonly message: string;
      readonly projectId: string;
      readonly commandId: string;
    }
  | {
      readonly code: "VISUAL_COMMAND_TRANSFORM_FAILED";
      readonly message: string;
      readonly projectId: string;
      readonly diagnostics: readonly VisualCommandTransformDiagnostic[];
      readonly partialImpact?: VisualCommandPartialImpact;
    }
  | {
      readonly code: "VISUAL_COMMAND_LAYOUT_MIGRATION_CONFLICT";
      readonly message: string;
      readonly projectId: string;
      readonly viewKey: string;
      readonly beforeKey: SchemaElementKey;
      readonly afterKey: SchemaElementKey;
    }
  | {
      readonly code: "VISUAL_COMMAND_STORAGE_INVARIANT_VIOLATION";
      readonly message: string;
      readonly projectId: string;
    };

export type VisualCommandApplicationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: VisualCommandApplicationError };

export interface VisualCommandPersistenceReader extends ProjectPersistenceReader {
  getVisualCommandReceipt(projectId: string, commandId: string): VisualCommandReceipt | null;
  listLayouts(projectId: string): readonly DiagramLayout[];
}

export interface VisualCommandPersistenceTransaction
  extends ProjectPersistenceTransaction,
    VisualCommandPersistenceReader {
  insertVisualCommandReceipt(receipt: VisualCommandReceipt): void;
  upsertLayout(layout: DiagramLayout): void;
}

export interface VisualCommandPersistencePort
  extends Omit<ProjectPersistencePort, "transaction">,
    VisualCommandPersistenceReader {
  transaction<T>(operation: (transaction: VisualCommandPersistenceTransaction) => T): T;
}

export interface VisualCommandApplication {
  apply(
    command: ApplyVisualCommandCommand,
  ): Promise<VisualCommandApplicationResult<VisualCommandMutation>>;
}

export interface CreateVisualCommandApplicationOptions {
  readonly persistence: VisualCommandPersistencePort;
  readonly transform: VisualCommandTransformer;
  readonly generateId: () => string;
  readonly now: () => string;
}

export class VisualCommandPersistenceInvariantError extends Error {
  constructor(
    readonly projectId: string,
    message: string,
  ) {
    super(message);
    this.name = "VisualCommandPersistenceInvariantError";
  }
}
