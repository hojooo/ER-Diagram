import type {
  Diagnostic,
  ProjectBundleManifestV1,
  ProjectBundleReportMode,
  RuntimeResourceLimits,
} from "@er-diagram/contracts";

import type { DbmlParseResult } from "../dbml-parser.js";
import type { DiagramLayout } from "./layout.js";
import type {
  ProjectPersistenceReader,
  ProjectPersistenceTransaction,
  ProjectState,
} from "./project.js";
import type { SqlImportArtifact } from "./sql-import.js";

export interface ProjectBundleStagingSink {
  writeEntry(path: string, content: Uint8Array): Promise<void>;
}

export interface ProjectBundleStagedEntries {
  listPaths(): Promise<readonly string[]>;
  readEntry(path: string): Promise<Uint8Array>;
  /** SQLite commits are synchronous; validated staging adapters must support a bounded reread. */
  readEntrySync(path: string): Uint8Array;
}

export interface ExportProjectBundleCommand {
  readonly projectId: string;
  readonly expectedSchemaRevisionNo: number;
  readonly expectedLayoutRevisionNo: number;
  readonly reportMode?: ProjectBundleReportMode;
  readonly staging: ProjectBundleStagingSink;
}

export interface ImportProjectBundleCommand {
  readonly staging: ProjectBundleStagedEntries;
}

export interface ProjectBundleExportMutation {
  readonly manifest: ProjectBundleManifestV1;
  readonly bundleHash: string;
  readonly entryCount: number;
  readonly expandedBytes: number;
}

export interface ProjectBundleImportMutation {
  readonly bundleSchemaVersion: 1;
  readonly bundleHash: string;
  readonly state: ProjectState;
  readonly diagnostics: readonly Diagnostic[];
  readonly imported: {
    readonly revisionCount: number;
    readonly layoutCount: number;
    readonly reportCount: number;
  };
}

export type ProjectBundleApplicationError =
  | {
      readonly code: "PROJECT_BUNDLE_PROJECT_NOT_FOUND";
      readonly message: string;
      readonly projectId: string;
    }
  | {
      readonly code: "PROJECT_BUNDLE_SCHEMA_REVISION_CONFLICT";
      readonly message: string;
      readonly projectId: string;
      readonly expectedSchemaRevisionNo: number;
      readonly currentSchemaRevisionNo: number;
    }
  | {
      readonly code: "PROJECT_BUNDLE_LAYOUT_REVISION_CONFLICT";
      readonly message: string;
      readonly projectId: string;
      readonly expectedLayoutRevisionNo: number;
      readonly currentLayoutRevisionNo: number;
    }
  | {
      readonly code: "PROJECT_BUNDLE_SNAPSHOT_CONFLICT";
      readonly message: string;
      readonly projectId: string;
    }
  | {
      readonly code: "PROJECT_BUNDLE_INVALID";
      readonly message: string;
    }
  | {
      readonly code: "PROJECT_BUNDLE_PARSER_INCOMPATIBLE";
      readonly message: string;
    }
  | {
      readonly code: "PROJECT_BUNDLE_RESOURCE_LIMIT_EXCEEDED";
      readonly message: string;
      readonly limit: "ENTRY" | "ENTRIES" | "EXPANDED" | "SOURCE";
    }
  | {
      readonly code: "PROJECT_BUNDLE_STORAGE_INVARIANT_VIOLATION";
      readonly message: string;
      readonly projectId?: string;
    };

export type ProjectBundleApplicationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProjectBundleApplicationError };

export interface ProjectBundlePersistenceReader extends ProjectPersistenceReader {
  listLayouts(projectId: string): readonly DiagramLayout[];
  listImportArtifacts(projectId: string): readonly SqlImportArtifact[];
}

export interface ProjectBundlePersistenceTransaction
  extends ProjectPersistenceTransaction,
    ProjectBundlePersistenceReader {
  insertLayout(layout: DiagramLayout): void;
  insertImportArtifact(artifact: SqlImportArtifact): void;
}

export interface ProjectBundlePersistencePort extends ProjectBundlePersistenceReader {
  transaction<T>(operation: (transaction: ProjectBundlePersistenceTransaction) => T): T;
}

export interface ProjectBundleApplication {
  exportBundle(
    command: ExportProjectBundleCommand,
  ): Promise<ProjectBundleApplicationResult<ProjectBundleExportMutation>>;
  importBundle(
    command: ImportProjectBundleCommand,
  ): Promise<ProjectBundleApplicationResult<ProjectBundleImportMutation>>;
}

export interface CreateProjectBundleApplicationOptions {
  readonly persistence: ProjectBundlePersistencePort;
  readonly parseSource: (source: string, filepath?: string) => Promise<DbmlParseResult>;
  readonly resourceLimits: RuntimeResourceLimits;
  readonly generateId: () => string;
  readonly now: () => string;
}

export class ProjectBundlePersistenceInvariantError extends Error {
  constructor(
    readonly projectId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ProjectBundlePersistenceInvariantError";
  }
}
