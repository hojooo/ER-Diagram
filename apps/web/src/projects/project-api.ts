import {
  correlationIdSchema,
  createProjectRequestSchema,
  deleteProjectRequestSchema,
  errorResponseSchema,
  type PrimaryDialect,
  type ProjectMutationResponse,
  type ProjectResponse,
  type ProjectsResponse,
  projectIdSchema,
  projectMutationResponseSchema,
  projectResponseSchema,
  projectsResponseSchema,
  renameProjectRequestSchema,
  saveDraftRequestSchema,
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
}

export interface ProjectApi {
  listProjects(): Promise<ProjectsResponse>;
  getProject(projectId: string): Promise<ProjectResponse>;
  createProject(input: CreateProjectInput): Promise<ProjectMutationResponse>;
  renameProject(input: RenameProjectInput): Promise<ProjectResponse>;
  duplicateProject(input: DuplicateProjectInput): Promise<ProjectMutationResponse>;
  saveDraft(input: SaveDraftInput): Promise<ProjectMutationResponse>;
  deleteProject(input: DeleteProjectInput): Promise<void>;
}

export class ProjectApiError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly correlationId: string | undefined;
  readonly currentRevisionNo: number | undefined;

  constructor(
    message: string,
    options: {
      readonly status: number | null;
      readonly code: string;
      readonly correlationId?: string;
      readonly currentRevisionNo?: number;
    },
  ) {
    super(message);
    this.name = "ProjectApiError";
    this.status = options.status;
    this.code = options.code;
    this.correlationId = options.correlationId;
    this.currentRevisionNo = options.currentRevisionNo;
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

  return {
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
    createProject: (input) => {
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
      const projectId = parseClientInput(projectIdSchema, input.projectId);
      const commandId = generateCommandId();
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
