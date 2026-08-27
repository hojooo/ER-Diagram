import type { Diagnostic, PrimaryDialect } from "@er-diagram/contracts";
import type { DbmlParseResult } from "../dbml-parser.js";

export const NON_CHECKPOINT_REVISION_LIMIT = 100;

export type DraftValidity = "VALID" | "INVALID";
export type SchemaRevisionOrigin =
  | "SOURCE_EDIT"
  | "VISUAL_COMMAND"
  | "SQL_IMPORT"
  | "RESTORE"
  | "PARSER_MIGRATION";

export interface DiagnosticSummary {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  readonly parserVersion: string;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly primaryDialect: PrimaryDialect;
  readonly draftSource: string;
  readonly draftHash: string;
  readonly lastValidRevisionId: string | null;
  readonly parserVersion: string;
  readonly schemaRevisionNo: number;
  readonly layoutRevisionNo: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SchemaRevision {
  readonly id: string;
  readonly projectId: string;
  readonly revisionNo: number;
  readonly source: string;
  readonly sourceHash: string;
  readonly validity: DraftValidity;
  readonly origin: SchemaRevisionOrigin;
  readonly parserVersion: string;
  readonly diagnosticSummary: DiagnosticSummary;
  readonly createdAt: string;
}

export interface ProjectState {
  readonly project: Project;
  readonly currentRevision: SchemaRevision;
  readonly lastValidRevision: SchemaRevision | null;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly primaryDialect: PrimaryDialect;
  readonly parserVersion: string;
  readonly schemaRevisionNo: number;
  readonly layoutRevisionNo: number;
  readonly draftValidity: DraftValidity;
  readonly diagnosticSummary: DiagnosticSummary;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectMutation {
  readonly state: ProjectState;
  readonly diagnostics: readonly Diagnostic[];
  readonly revisionCreated: boolean;
}

export interface CreateProjectCommand {
  readonly name: string;
  readonly primaryDialect: PrimaryDialect;
  readonly source: string;
}

export interface RenameProjectCommand {
  readonly projectId: string;
  readonly name: string;
  readonly expectedSchemaRevisionNo: number;
}

export interface DuplicateProjectCommand {
  readonly sourceProjectId: string;
  readonly name: string;
  readonly expectedSchemaRevisionNo: number;
}

export interface DeleteProjectCommand {
  readonly projectId: string;
  readonly expectedSchemaRevisionNo: number;
}

export interface SaveDraftCommand {
  readonly projectId: string;
  readonly source: string;
  readonly expectedSchemaRevisionNo: number;
}

export interface RestoreRevisionCommand {
  readonly projectId: string;
  readonly revisionNo: number;
  readonly expectedSchemaRevisionNo: number;
}

export type ProjectApplicationError =
  | {
      readonly code: "PROJECT_NOT_FOUND";
      readonly message: string;
      readonly projectId: string;
    }
  | {
      readonly code: "PROJECT_REVISION_NOT_FOUND";
      readonly message: string;
      readonly projectId: string;
      readonly revisionNo: number;
    }
  | {
      readonly code: "PROJECT_SCHEMA_REVISION_CONFLICT";
      readonly message: string;
      readonly projectId: string;
      readonly expectedSchemaRevisionNo: number;
      readonly currentSchemaRevisionNo: number;
    }
  | {
      readonly code: "PROJECT_NAME_INVALID";
      readonly message: string;
    }
  | {
      readonly code: "PROJECT_STORAGE_INVARIANT_VIOLATION";
      readonly message: string;
      readonly projectId: string;
    };

export type ProjectApplicationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProjectApplicationError };

export interface ProjectPersistenceReader {
  listProjects(): readonly Project[];
  getProject(projectId: string): Project | null;
  getRevisionById(projectId: string, revisionId: string): SchemaRevision | null;
  getRevisionByNumber(projectId: string, revisionNo: number): SchemaRevision | null;
  listRevisions(projectId: string): readonly SchemaRevision[];
}

export interface ProjectPersistenceTransaction extends ProjectPersistenceReader {
  insertProject(project: Project): void;
  insertRevision(revision: SchemaRevision): void;
  updateProject(project: Project, expectedSchemaRevisionNo: number): boolean;
  deleteProject(projectId: string, expectedSchemaRevisionNo: number): boolean;
  deleteRevisions(projectId: string, revisionIds: readonly string[]): number;
}

export interface ProjectPersistencePort extends ProjectPersistenceReader {
  transaction<T>(operation: (transaction: ProjectPersistenceTransaction) => T): T;
}

export interface ProjectApplication {
  listProjects(): Promise<ProjectApplicationResult<readonly ProjectSummary[]>>;
  getProject(projectId: string): Promise<ProjectApplicationResult<ProjectState>>;
  createProject(command: CreateProjectCommand): Promise<ProjectApplicationResult<ProjectMutation>>;
  renameProject(command: RenameProjectCommand): Promise<ProjectApplicationResult<ProjectState>>;
  duplicateProject(
    command: DuplicateProjectCommand,
  ): Promise<ProjectApplicationResult<ProjectMutation>>;
  deleteProject(
    command: DeleteProjectCommand,
  ): Promise<ProjectApplicationResult<{ readonly projectId: string }>>;
  saveDraft(command: SaveDraftCommand): Promise<ProjectApplicationResult<ProjectMutation>>;
  listRevisions(projectId: string): Promise<ProjectApplicationResult<readonly SchemaRevision[]>>;
  restoreRevision(
    command: RestoreRevisionCommand,
  ): Promise<ProjectApplicationResult<ProjectMutation>>;
}

export type ProjectSourceParser = (source: string, filepath?: string) => Promise<DbmlParseResult>;

export interface CreateProjectApplicationOptions {
  readonly persistence: ProjectPersistencePort;
  readonly generateId: () => string;
  readonly now: () => string;
  readonly parseSource?: ProjectSourceParser;
}
