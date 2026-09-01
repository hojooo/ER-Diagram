import {
  correlationIdSchema,
  createProjectRequestSchema,
  type Diagnostic,
  type DiagramLayoutValue,
  deleteProjectRequestSchema,
  diagramViewKeySchema,
  errorResponseSchema,
  type LayoutMutationResponse,
  type LayoutResponse,
  layoutMutationResponseSchema,
  layoutResponseSchema,
  type OriginalSqlRetentionMode,
  type PrimaryDialect,
  type ProjectMutationResponse,
  type ProjectResponse,
  type ProjectRevisionsResponse,
  type ProjectsResponse,
  projectIdSchema,
  projectMutationResponseSchema,
  projectResponseSchema,
  projectRevisionsResponseSchema,
  projectsResponseSchema,
  type RuntimeConfigResponse,
  runtimeConfigResponseSchema,
  renameProjectRequestSchema,
  restoreRevisionRequestSchema,
  revisionParamsSchema,
  type SqlDataStatementHandling,
  type SqlExportResponse,
  type SqlExportSourceSelection,
  type SqlImportApplyResponse,
  type SqlImportPreviewResponse,
  type SqlImportStandalonePreviewResponse,
  saveDraftRequestSchema,
  saveLayoutRequestSchema,
  sqlExportRequestSchema,
  sqlExportResponseSchema,
  sqlImportApplyRequestSchema,
  sqlImportApplyResponseSchema,
  sqlImportPreviewRequestSchema,
  sqlImportPreviewResponseSchema,
  sqlImportStandalonePreviewRequestSchema,
  sqlImportStandalonePreviewResponseSchema,
  type VisualCommand,
  type VisualCommandMutationResponse,
  type VisualCommandPartialImpact,
  visualCommandMutationResponseSchema,
  visualCommandRequestSchema,
  utf8ByteLength,
} from "@er-diagram/contracts";

export interface CreateProjectInput {
  readonly name: string;
  readonly primaryDialect: PrimaryDialect;
  readonly source: string;
}

export interface RenameProjectInput {
  readonly projectId: string;
  readonly name: string;
  readonly expectedSchemaRevisionNo: number;
}

export interface DuplicateProjectInput {
  readonly sourceProjectId: string;
  readonly name: string;
  readonly expectedSchemaRevisionNo: number;
}

export interface DeleteProjectInput {
  readonly projectId: string;
  readonly expectedSchemaRevisionNo: number;
}

export interface SaveDraftInput {
  readonly projectId: string;
  readonly source: string;
  readonly expectedSchemaRevisionNo: number;
  readonly commandId?: string;
}

export interface RestoreRevisionInput {
  readonly projectId: string;
  readonly revisionNo: number;
  readonly expectedSchemaRevisionNo: number;
  readonly commandId?: string;
}

export interface GetLayoutInput {
  readonly projectId: string;
  readonly viewKey: string;
}

export interface SaveLayoutInput extends GetLayoutInput {
  readonly expectedLayoutRevisionNo: number;
  readonly layout: DiagramLayoutValue;
}

export interface PreviewStandaloneSqlImportInput {
  readonly dialect: PrimaryDialect;
  readonly source: string;
  readonly originalSqlRetention?: OriginalSqlRetentionMode;
}

export interface CreateProjectFromSqlImportInput {
  readonly name: string;
  readonly primaryDialect: PrimaryDialect;
  readonly source: string;
  readonly previewHash: string;
  readonly originalSqlRetention?: OriginalSqlRetentionMode;
  readonly dataStatementHandling?: SqlDataStatementHandling;
}

export interface PreviewProjectSqlImportInput extends PreviewStandaloneSqlImportInput {
  readonly projectId: string;
  readonly expectedSchemaRevisionNo: number;
}

export interface ApplyProjectSqlImportInput {
  readonly projectId: string;
  readonly expectedSchemaRevisionNo: number;
  readonly artifactId: string;
  readonly previewHash: string;
  readonly source: string;
  readonly dataStatementHandling?: SqlDataStatementHandling;
}

export interface ExportProjectSqlInput {
  readonly projectId: string;
  readonly expectedSchemaRevisionNo: number;
  readonly sourceSelection: SqlExportSourceSelection;
}

export interface ApplyVisualCommandInput {
  readonly projectId: string;
  readonly command: VisualCommand;
}

export interface ProjectApi {
  getRuntimeConfig(): Promise<RuntimeConfigResponse>;
  listProjects(): Promise<ProjectsResponse>;
  getProject(projectId: string): Promise<ProjectResponse>;
  listRevisions(projectId: string): Promise<ProjectRevisionsResponse>;
  createProject(input: CreateProjectInput): Promise<ProjectMutationResponse>;
  renameProject(input: RenameProjectInput): Promise<ProjectResponse>;
  duplicateProject(input: DuplicateProjectInput): Promise<ProjectMutationResponse>;
  saveDraft(input: SaveDraftInput): Promise<ProjectMutationResponse>;
  restoreRevision(input: RestoreRevisionInput): Promise<ProjectMutationResponse>;
  getLayout(input: GetLayoutInput): Promise<LayoutResponse>;
  saveLayout(input: SaveLayoutInput): Promise<LayoutMutationResponse>;
  deleteProject(input: DeleteProjectInput): Promise<void>;
  previewStandaloneSqlImport(
    input: PreviewStandaloneSqlImportInput,
  ): Promise<SqlImportStandalonePreviewResponse>;
  createProjectFromSqlImport(
    input: CreateProjectFromSqlImportInput,
  ): Promise<SqlImportApplyResponse>;
  previewProjectSqlImport(input: PreviewProjectSqlImportInput): Promise<SqlImportPreviewResponse>;
  applyProjectSqlImport(input: ApplyProjectSqlImportInput): Promise<SqlImportApplyResponse>;
  exportProjectSql(input: ExportProjectSqlInput): Promise<SqlExportResponse>;
  applyVisualCommand(input: ApplyVisualCommandInput): Promise<VisualCommandMutationResponse>;
}

export class ProjectApiError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly correlationId: string | undefined;
  readonly currentRevisionNo: number | undefined;
  readonly diagnostics: Diagnostic[] | undefined;
  readonly partialImpact: VisualCommandPartialImpact | undefined;

  constructor(
    message: string,
    options: {
      readonly status: number | null;
      readonly code: string;
      readonly correlationId?: string;
      readonly currentRevisionNo?: number;
      readonly diagnostics?: Diagnostic[];
      readonly partialImpact?: VisualCommandPartialImpact;
    },
  ) {
    super(message);
    this.name = "ProjectApiError";
    this.status = options.status;
    this.code = options.code;
    this.correlationId = options.correlationId;
    this.currentRevisionNo = options.currentRevisionNo;
    this.diagnostics = options.diagnostics;
    this.partialImpact = options.partialImpact;
  }
}

interface HttpProjectApiOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly basePath?: string;
  readonly generateCommandId?: () => string;
}

interface RuntimeSchema<T> {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

interface RequestOptions<T> {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly expectedStatus: number;
  readonly responseSchema?: RuntimeSchema<T>;
  readonly body?: unknown;
  readonly commandId?: string;
}

const DEFAULT_BASE_PATH = "/api/v1";

export function createHttpProjectApi(options: HttpProjectApiOptions = {}): ProjectApi {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const basePath = normalizeBasePath(options.basePath ?? DEFAULT_BASE_PATH);
  const generateCommandId = options.generateCommandId ?? generateBrowserUuid;
  let runtimeConfig: RuntimeConfigResponse | undefined;
  let runtimeConfigRequest: Promise<RuntimeConfigResponse> | undefined;

  const getRuntimeConfig = (): Promise<RuntimeConfigResponse> => {
    if (runtimeConfig) return Promise.resolve(runtimeConfig);
    if (runtimeConfigRequest) return runtimeConfigRequest;
    runtimeConfigRequest = request(fetcher, basePath, {
      method: "GET",
      path: "/runtime-config",
      expectedStatus: 200,
      responseSchema: runtimeConfigResponseSchema,
    }).then(
      (response) => {
        runtimeConfig = response;
        return response;
      },
      (error: unknown) => {
        runtimeConfigRequest = undefined;
        throw error;
      },
    );
    return runtimeConfigRequest;
  };

  const assertSourceWithinConfiguredLimit = (source: string): void => {
    const limit = runtimeConfig?.resourceLimits.maxSourceBytes;
    if (limit !== undefined && utf8ByteLength(source) > limit) {
      throw new ProjectApiError(`Source exceeds the configured ${limit} byte limit.`, {
        status: null,
        code: "RESOURCE_SOURCE_TOO_LARGE",
      });
    }
  };

  return {
    getRuntimeConfig,
    listProjects: () =>
      request(fetcher, basePath, {
        method: "GET",
        path: "/projects",
        expectedStatus: 200,
        responseSchema: projectsResponseSchema,
      }),
    getProject: (projectId) => {
      const parsedProjectId = parseClientInput(projectIdSchema, projectId);
      return request(fetcher, basePath, {
        method: "GET",
        path: `/projects/${encodeURIComponent(parsedProjectId)}`,
        expectedStatus: 200,
        responseSchema: projectResponseSchema,
      });
    },
    listRevisions: (projectId) => {
      const parsedProjectId = parseClientInput(projectIdSchema, projectId);
      return request(fetcher, basePath, {
        method: "GET",
        path: `/projects/${encodeURIComponent(parsedProjectId)}/revisions`,
        expectedStatus: 200,
        responseSchema: projectRevisionsResponseSchema,
      });
    },
    createProject: (input) => {
      assertSourceWithinConfiguredLimit(input.source);
      const commandId = generateCommandId();
      const body = parseClientInput(createProjectRequestSchema, {
        operation: "CREATE",
        commandId,
        name: input.name,
        primaryDialect: input.primaryDialect,
        source: input.source,
      });
      return request(fetcher, basePath, {
        method: "POST",
        path: "/projects",
        expectedStatus: 201,
        responseSchema: projectMutationResponseSchema,
        body,
        commandId,
      });
    },
    renameProject: (input) => {
      const projectId = parseClientInput(projectIdSchema, input.projectId);
      const commandId = generateCommandId();
      const body = parseClientInput(renameProjectRequestSchema, {
        commandId,
        name: input.name,
        expectedSchemaRevisionNo: input.expectedSchemaRevisionNo,
      });
      return request(fetcher, basePath, {
        method: "PATCH",
        path: `/projects/${encodeURIComponent(projectId)}`,
        expectedStatus: 200,
        responseSchema: projectResponseSchema,
        body,
        commandId,
      });
    },
    duplicateProject: (input) => {
      const commandId = generateCommandId();
      const body = parseClientInput(createProjectRequestSchema, {
        operation: "DUPLICATE",
        commandId,
        sourceProjectId: input.sourceProjectId,
        name: input.name,
        expectedSchemaRevisionNo: input.expectedSchemaRevisionNo,
      });
      return request(fetcher, basePath, {
        method: "POST",
        path: "/projects",
        expectedStatus: 201,
        responseSchema: projectMutationResponseSchema,
        body,
        commandId,
      });
    },
    saveDraft: (input) => {
      assertSourceWithinConfiguredLimit(input.source);
      const projectId = parseClientInput(projectIdSchema, input.projectId);
      const commandId = input.commandId ?? generateCommandId();
      const body = parseClientInput(saveDraftRequestSchema, {
        commandId,
        source: input.source,
        expectedSchemaRevisionNo: input.expectedSchemaRevisionNo,
      });
      return request(fetcher, basePath, {
        method: "PUT",
        path: `/projects/${encodeURIComponent(projectId)}/draft`,
        expectedStatus: 200,
        responseSchema: projectMutationResponseSchema,
        body,
        commandId,
      });
    },
    restoreRevision: (input) => {
      const { projectId, revisionNo } = parseClientInput(revisionParamsSchema, {
        projectId: input.projectId,
        revisionNo: input.revisionNo,
      });
      const commandId = input.commandId ?? generateCommandId();
      const body = parseClientInput(restoreRevisionRequestSchema, {
        commandId,
        expectedSchemaRevisionNo: input.expectedSchemaRevisionNo,
      });
      return request(fetcher, basePath, {
        method: "POST",
        path: `/projects/${encodeURIComponent(projectId)}/revisions/${revisionNo}/restore`,
        expectedStatus: 200,
        responseSchema: projectMutationResponseSchema,
        body,
        commandId,
      });
    },
    getLayout: (input) => {
      const projectId = parseClientInput(projectIdSchema, input.projectId);
      const viewKey = parseClientInput(diagramViewKeySchema, input.viewKey);
      return request(fetcher, basePath, {
        method: "GET",
        path: `/projects/${encodeURIComponent(projectId)}/layouts/${encodeURIComponent(viewKey)}`,
        expectedStatus: 200,
        responseSchema: layoutResponseSchema,
      });
    },
    saveLayout: (input) => {
      const projectId = parseClientInput(projectIdSchema, input.projectId);
      const viewKey = parseClientInput(diagramViewKeySchema, input.viewKey);
      const commandId = generateCommandId();
      const body = parseClientInput(saveLayoutRequestSchema, {
        commandId,
        expectedLayoutRevisionNo: input.expectedLayoutRevisionNo,
        layout: input.layout,
      });
      return request(fetcher, basePath, {
        method: "PUT",
        path: `/projects/${encodeURIComponent(projectId)}/layouts/${encodeURIComponent(viewKey)}`,
        expectedStatus: 200,
        responseSchema: layoutMutationResponseSchema,
        body,
        commandId,
      });
    },
    deleteProject: async (input) => {
      const projectId = parseClientInput(projectIdSchema, input.projectId);
      const commandId = generateCommandId();
      const body = parseClientInput(deleteProjectRequestSchema, {
        commandId,
        expectedSchemaRevisionNo: input.expectedSchemaRevisionNo,
      });
      await request(fetcher, basePath, {
        method: "DELETE",
        path: `/projects/${encodeURIComponent(projectId)}`,
        expectedStatus: 204,
        body,
        commandId,
      });
    },
    previewStandaloneSqlImport: (input) => {
      assertSourceWithinConfiguredLimit(input.source);
      const commandId = generateCommandId();
      const body = parseClientInput(sqlImportStandalonePreviewRequestSchema, {
        commandId,
        dialect: input.dialect,
        source: input.source,
        ...(input.originalSqlRetention === undefined
          ? {}
          : { originalSqlRetention: input.originalSqlRetention }),
      });
      return request(fetcher, basePath, {
        method: "POST",
        path: "/sql-import/preview",
        expectedStatus: 200,
        responseSchema: sqlImportStandalonePreviewResponseSchema,
        body,
        commandId,
      });
    },
    createProjectFromSqlImport: (input) => {
      assertSourceWithinConfiguredLimit(input.source);
      const commandId = generateCommandId();
      const body = parseClientInput(createProjectRequestSchema, {
        operation: "CREATE_FROM_SQL_IMPORT",
        commandId,
        name: input.name,
        primaryDialect: input.primaryDialect,
        source: input.source,
        previewHash: input.previewHash,
        ...(input.originalSqlRetention === undefined
          ? {}
          : { originalSqlRetention: input.originalSqlRetention }),
        ...(input.dataStatementHandling === undefined
          ? {}
          : { dataStatementHandling: input.dataStatementHandling }),
      });
      return request(fetcher, basePath, {
        method: "POST",
        path: "/projects",
        expectedStatus: 201,
        responseSchema: sqlImportApplyResponseSchema,
        body,
        commandId,
      });
    },
    previewProjectSqlImport: (input) => {
      assertSourceWithinConfiguredLimit(input.source);
      const projectId = parseClientInput(projectIdSchema, input.projectId);
      const commandId = generateCommandId();
      const body = parseClientInput(sqlImportPreviewRequestSchema, {
        commandId,
        expectedSchemaRevisionNo: input.expectedSchemaRevisionNo,
        dialect: input.dialect,
        source: input.source,
        ...(input.originalSqlRetention === undefined
          ? {}
          : { originalSqlRetention: input.originalSqlRetention }),
      });
      return request(fetcher, basePath, {
        method: "POST",
        path: `/projects/${encodeURIComponent(projectId)}/sql-import/preview`,
        expectedStatus: 200,
        responseSchema: sqlImportPreviewResponseSchema,
        body,
        commandId,
      });
    },
    applyProjectSqlImport: (input) => {
      assertSourceWithinConfiguredLimit(input.source);
      const projectId = parseClientInput(projectIdSchema, input.projectId);
      const commandId = generateCommandId();
      const body = parseClientInput(sqlImportApplyRequestSchema, {
        commandId,
        expectedSchemaRevisionNo: input.expectedSchemaRevisionNo,
        artifactId: input.artifactId,
        previewHash: input.previewHash,
        source: input.source,
        ...(input.dataStatementHandling === undefined
          ? {}
          : { dataStatementHandling: input.dataStatementHandling }),
      });
      return request(fetcher, basePath, {
        method: "POST",
        path: `/projects/${encodeURIComponent(projectId)}/sql-import/apply`,
        expectedStatus: 200,
        responseSchema: sqlImportApplyResponseSchema,
        body,
        commandId,
      });
    },
    exportProjectSql: (input) => {
      const projectId = parseClientInput(projectIdSchema, input.projectId);
      const body = parseClientInput(sqlExportRequestSchema, {
        expectedSchemaRevisionNo: input.expectedSchemaRevisionNo,
        sourceSelection: input.sourceSelection,
      });
      return request(fetcher, basePath, {
        method: "POST",
        path: `/projects/${encodeURIComponent(projectId)}/sql-export`,
        expectedStatus: 200,
        responseSchema: sqlExportResponseSchema,
        body,
      });
    },
    applyVisualCommand: (input) => {
      const projectId = parseClientInput(projectIdSchema, input.projectId);
      const body = parseClientInput(visualCommandRequestSchema, input.command);
      return request(fetcher, basePath, {
        method: "POST",
        path: `/projects/${encodeURIComponent(projectId)}/visual-commands`,
        expectedStatus: 200,
        responseSchema: visualCommandMutationResponseSchema,
        body,
        commandId: body.commandId,
      });
    },
  };
}

async function request<T = void>(
  fetcher: typeof globalThis.fetch,
  basePath: string,
  options: RequestOptions<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`${basePath}${options.path}`, {
      method: options.method,
      headers: options.body === undefined ? { accept: "application/json" } : jsonHeaders(),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ProjectApiError("The server could not be reached.", {
      status: null,
      code: "CLIENT_NETWORK_ERROR",
    });
  }

  if (!response.ok) {
    throw await toPublicApiError(response);
  }

  if (response.status !== options.expectedStatus) {
    throw new ProjectApiError("The server returned an unexpected status.", {
      status: response.status,
      code: "CLIENT_HTTP_STATUS_MISMATCH",
      ...correlationFromHeader(response),
    });
  }

  if (options.commandId !== undefined) {
    const echoedCommandId = response.headers.get("x-command-id");
    if (echoedCommandId !== options.commandId) {
      throw new ProjectApiError("The server returned an unexpected command identifier.", {
        status: response.status,
        code: "CLIENT_COMMAND_ID_MISMATCH",
        ...correlationFromHeader(response),
      });
    }
  }

  if (options.responseSchema === undefined) return undefined as T;
  const payload = await readJson(response);
  return parseResponse(options.responseSchema, payload, response);
}

async function toPublicApiError(response: Response): Promise<ProjectApiError> {
  const payload = await readJsonSafely(response);
  const parsed = errorResponseSchema.safeParse(payload);
  if (parsed.success) {
    return new ProjectApiError(parsed.data.message, {
      status: response.status,
      code: parsed.data.code,
      correlationId: parsed.data.correlationId,
      ...(parsed.data.currentRevisionNo === undefined
        ? {}
        : { currentRevisionNo: parsed.data.currentRevisionNo }),
      ...(parsed.data.diagnostics === undefined ? {} : { diagnostics: parsed.data.diagnostics }),
      ...(parsed.data.partialImpact === undefined
        ? {}
        : { partialImpact: parsed.data.partialImpact }),
    });
  }
  return new ProjectApiError("The server could not complete the request.", {
    status: response.status,
    code: "CLIENT_HTTP_ERROR",
    ...correlationFromHeader(response),
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProjectApiError("The server response did not match the public contract.", {
      status: response.status,
      code: "CLIENT_CONTRACT_ERROR",
      ...correlationFromHeader(response),
    });
  }
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function parseResponse<T>(schema: RuntimeSchema<T>, payload: unknown, response: Response): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ProjectApiError("The server response did not match the public contract.", {
      status: response.status,
      code: "CLIENT_CONTRACT_ERROR",
      ...correlationFromHeader(response),
    });
  }
  return parsed.data;
}

function parseClientInput<T>(schema: RuntimeSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ProjectApiError("The request did not match the public contract.", {
      status: null,
      code: "CLIENT_REQUEST_VALIDATION_ERROR",
    });
  }
  return parsed.data;
}

function correlationFromHeader(response: Response): { readonly correlationId?: string } {
  const parsed = correlationIdSchema.safeParse(response.headers.get("x-correlation-id"));
  return parsed.success ? { correlationId: parsed.data } : {};
}

function jsonHeaders(): HeadersInit {
  return { accept: "application/json", "content-type": "application/json" };
}

function normalizeBasePath(basePath: string): string {
  if (basePath === "/") return "";
  return basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
}

function generateBrowserUuid(): string {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
