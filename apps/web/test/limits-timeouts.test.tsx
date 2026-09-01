// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  DEFAULT_RUNTIME_CONFIG_RESPONSE,
  DEFAULT_RUNTIME_RESOURCE_LIMITS,
  type ProjectState,
  runtimeResourceLimitsSchema,
} from "@er-diagram/contracts";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, createAppRoutes } from "../src/App.js";
import { requestWorkerLayout } from "../src/diagram/layout-worker-client.js";
import type { DiagramProjection } from "../src/diagram/types.js";
import { createHttpProjectApi } from "../src/projects/project-api.js";
import {
  createDbmlParserWorkerClient,
  type DbmlParserWorkerLike,
} from "../src/source-editor/parser-worker-client.js";
import { createSourceSession } from "../src/source-editor/source-session.js";

const limits = runtimeResourceLimitsSchema.parse({
  ...DEFAULT_RUNTIME_RESOURCE_LIMITS,
  bundle: { ...DEFAULT_RUNTIME_RESOURCE_LIMITS.bundle },
  maxSourceBytes: 4,
});
const runtimeConfig = { ...DEFAULT_RUNTIME_CONFIG_RESPONSE, resourceLimits: limits };

afterEach(cleanup);

describe("runtime resource limits", () => {
  it("does not mount routes until config loads and offers an explicit startup retry", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(jsonResponse(runtimeConfig));
    const api = createHttpProjectApi({ fetch: fetcher });
    const router = createMemoryRouter([{ path: "/", element: <h1>Workspace ready</h1> }]);

    render(<App api={api} queryClient={queryClient()} router={router} />);

    expect(
      await screen.findByRole("heading", { name: "Runtime configuration unavailable" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Workspace ready" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Workspace ready" })).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("blocks oversized API source locally after config without making a mutation request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(runtimeConfig));
    const api = createHttpProjectApi({ fetch: fetcher });
    await api.getRuntimeConfig();

    await expect(
      Promise.resolve().then(() =>
        api.createProject({ name: "Too large", primaryDialect: "POSTGRESQL", source: "😀a" }),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_SOURCE_TOO_LARGE", status: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("checks file.size before reading an oversized DBML file", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/runtime-config")) return jsonResponse(runtimeConfig);
      if (url.endsWith("/projects")) return jsonResponse({ projects: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const api = createHttpProjectApi({ fetch: fetcher });
    const router = createMemoryRouter(createAppRoutes(), { initialEntries: ["/"] });
    render(<App api={api} queryClient={queryClient()} router={router} />);
    await screen.findByRole("heading", { name: "Projects" });

    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.click(screen.getByLabelText("DBML file"));
    const text = vi.fn(async () => "never read");
    const file = { name: "large.dbml", size: 5, type: "text/plain", text } as unknown as File;
    fireEvent.change(screen.getByLabelText("Choose DBML file"), { target: { files: [file] } });

    expect(await screen.findByText(/DBML file exceeds the configured 4 byte limit/)).toBeVisible();
    expect(text).not.toHaveBeenCalled();
  });

  it("rejects parser and layout work before creating browser workers", async () => {
    const parserFactory = vi.fn<() => DbmlParserWorkerLike>();
    const parser = createDbmlParserWorkerClient({
      workerFactory: parserFactory,
      limits: {
        maxSourceBytes: 4,
        maxTables: 1,
        maxReferences: 1,
        maxSchemaElements: 4,
      },
    });
    await expect(parser.parse("😀a")).rejects.toMatchObject({
      code: "PARSER_WORKER_RESOURCE_LIMIT",
    });
    expect(parserFactory).not.toHaveBeenCalled();
    parser.dispose();

    const layoutFactory = vi.fn();
    const oversizedProjection = {
      viewKey: "GLOBAL",
      lod: "NAME_ONLY",
      nodes: [{}],
      edges: [],
    } as unknown as DiagramProjection;
    await expect(
      requestWorkerLayout(oversizedProjection, {
        maxNodes: 0,
        maxEdges: 0,
        workerFactory: layoutFactory,
      }),
    ).rejects.toMatchObject({ code: "LAYOUT_RESOURCE_LIMIT" });
    expect(layoutFactory).not.toHaveBeenCalled();
  });

  it("preserves an oversized Monaco buffer without parsing or saving it", async () => {
    const parseSource = vi.fn();
    const saveDraft = vi.fn();
    const session = createSourceSession({
      initialState: projectState(),
      parseSource,
      saveDraft,
      loadProject: async () => projectState(),
      validateSource: (source) =>
        source === "😀a"
          ? {
              code: "RESOURCE_SOURCE_TOO_LARGE",
              message: "Reduce the source before saving.",
            }
          : null,
      debounceMs: 0,
    });

    session.edit("😀a");
    await session.flushAndWait();

    expect(session.getSnapshot()).toMatchObject({
      source: "😀a",
      persistence: "DIRTY",
      validation: "ERROR",
      validationError: { code: "RESOURCE_SOURCE_TOO_LARGE" },
    });
    expect(parseSource).not.toHaveBeenCalled();
    expect(saveDraft).not.toHaveBeenCalled();
    session.dispose();
  });
});

function queryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function projectState(): ProjectState {
  const revision = {
    id: "019d3f4e-7b6c-7abc-8def-0123456789ab",
    projectId: "019d3f4e-7b6c-7def-9abc-0123456789ab",
    revisionNo: 1,
    source: "",
    sourceHash: "0".repeat(64),
    validity: "VALID" as const,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
    createdAt: "2026-08-30T00:00:00.000Z",
  };
  return {
    project: {
      id: revision.projectId,
      name: "Limits",
      primaryDialect: "POSTGRESQL",
      draftSource: revision.source,
      draftHash: revision.sourceHash,
      lastValidRevisionId: revision.id,
      parserVersion: "9.1.1",
      schemaRevisionNo: 1,
      layoutRevisionNo: 0,
      createdAt: revision.createdAt,
      updatedAt: revision.createdAt,
    },
    currentRevision: revision,
    lastValidRevision: revision,
  };
}
