// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { App, createAppRoutes } from "../src/App.js";
import type {
  CreateProjectInput,
  DeleteProjectInput,
  DuplicateProjectInput,
  SaveLayoutInput,
  ProjectApi,
  RenameProjectInput,
  SaveDraftInput,
} from "../src/projects/project-api.js";
import { ProjectApiError } from "../src/projects/project-api.js";
import type { SourceEditorComponent } from "../src/source-editor/editor-contract.js";
import type { DbmlParserWorkerClient } from "../src/source-editor/parser-worker-client.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const COPY_ID = "019d3f4e-7b6c-7def-9abc-0123456789ab";
const REVISION_ID = "019d3f4e-7b6c-7eee-8abc-0123456789ab";
const CREATED_AT = "2026-08-27T01:02:03.004Z";

afterEach(cleanup);

function projectState(
  overrides: {
    id?: string;
    name?: string;
    dialect?: "POSTGRESQL" | "MYSQL";
    validity?: "VALID" | "INVALID";
    source?: string;
  } = {},
) {
  const id = overrides.id ?? PROJECT_ID;
  const validity = overrides.validity ?? "VALID";
  const source = overrides.source ?? "Table users { id int [pk] }";
  const diagnosticSummary = {
    errors: validity === "INVALID" ? 1 : 0,
    warnings: 1,
    infos: 2,
    parserVersion: "9.1.1",
  };
  const revision = {
    id: REVISION_ID,
    projectId: id,
    revisionNo: 1,
    source,
    sourceHash: `hash-${id}`,
    validity,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary,
    createdAt: CREATED_AT,
  };
  return {
    project: {
      id,
      name: overrides.name ?? "Customer schema",
      primaryDialect: overrides.dialect ?? ("POSTGRESQL" as const),
      draftSource: source,
      draftHash: revision.sourceHash,
      lastValidRevisionId: validity === "VALID" ? REVISION_ID : null,
      parserVersion: "9.1.1",
      schemaRevisionNo: 1,
      layoutRevisionNo: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision: revision,
    lastValidRevision: validity === "VALID" ? revision : null,
  };
}

function summary(state: ReturnType<typeof projectState>) {
  return {
    id: state.project.id,
    name: state.project.name,
    primaryDialect: state.project.primaryDialect,
    parserVersion: state.project.parserVersion,
    schemaRevisionNo: state.project.schemaRevisionNo,
    layoutRevisionNo: state.project.layoutRevisionNo,
    draftValidity: state.currentRevision.validity,
    diagnosticSummary: state.currentRevision.diagnosticSummary,
    createdAt: state.project.createdAt,
    updatedAt: state.project.updatedAt,
  };
}

class FakeProjectApi implements ProjectApi {
  projects = [projectState()];
  listError: unknown;
  mutationError: unknown;
  readonly createInputs: CreateProjectInput[] = [];
  readonly renameInputs: RenameProjectInput[] = [];
  readonly duplicateInputs: DuplicateProjectInput[] = [];
  readonly deleteInputs: DeleteProjectInput[] = [];
  readonly saveDraftInputs: SaveDraftInput[] = [];

  async listProjects() {
    if (this.listError) throw this.listError;
    return { projects: this.projects.map(summary) };
  }

  async getProject(projectId: string) {
    const state = this.projects.find((candidate) => candidate.project.id === projectId);
    if (!state) {
      throw new ProjectApiError("Project not found.", {
        code: "PROJECT_NOT_FOUND",
        status: 404,
      });
    }
    return { state };
  }

  async getLayout() {
    return { layout: null, currentLayoutRevisionNo: 0 };
  }

  applyVisualCommand: ProjectApi["applyVisualCommand"] = async () => {
    throw new Error("Not used.");
  };

  async saveLayout(input: SaveLayoutInput) {
    return {
      state: {
        layout: {
          projectId: input.projectId,
          viewKey: input.viewKey,
          revisionNo: input.expectedLayoutRevisionNo + 1,
          ...input.layout,
        },
        currentLayoutRevisionNo: input.expectedLayoutRevisionNo + 1,
      },
      layoutUpdated: true,
    };
  }

  async createProject(input: CreateProjectInput) {
    this.createInputs.push(input);
    if (this.mutationError) throw this.mutationError;
    const state = projectState({
      name: input.name,
      dialect: input.primaryDialect,
      source: input.source,
    });
    this.projects = [
      state,
      ...this.projects.filter((item) => item.project.id !== state.project.id),
    ];
    return { state, diagnostics: [], revisionCreated: true };
  }

  async renameProject(input: RenameProjectInput) {
    this.renameInputs.push(input);
    if (this.mutationError) throw this.mutationError;
    const current = this.projects.find((item) => item.project.id === input.projectId);
    if (!current) throw new Error("PROJECT_NOT_FOUND");
    const state = { ...current, project: { ...current.project, name: input.name } };
    this.projects = this.projects.map((item) =>
      item.project.id === input.projectId ? state : item,
    );
    return { state };
  }

  async duplicateProject(input: DuplicateProjectInput) {
    this.duplicateInputs.push(input);
    if (this.mutationError) throw this.mutationError;
    const state = projectState({ id: COPY_ID, name: input.name });
    this.projects = [state, ...this.projects];
    return { state, diagnostics: [], revisionCreated: true };
  }

  async saveDraft(input: SaveDraftInput) {
    this.saveDraftInputs.push(input);
    if (this.mutationError) throw this.mutationError;
    const current = this.projects.find((item) => item.project.id === input.projectId);
    if (!current) throw new Error("PROJECT_NOT_FOUND");
    return { state: current, diagnostics: [], revisionCreated: false };
  }

  async deleteProject(input: DeleteProjectInput) {
    this.deleteInputs.push(input);
    if (this.mutationError) throw this.mutationError;
    this.projects = this.projects.filter((item) => item.project.id !== input.projectId);
  }

  async previewStandaloneSqlImport(): Promise<never> {
    throw new Error("SQL import is not used by this fixture.");
  }

  async createProjectFromSqlImport(): Promise<never> {
    throw new Error("SQL import is not used by this fixture.");
  }

  async previewProjectSqlImport(): Promise<never> {
    throw new Error("SQL import is not used by this fixture.");
  }

  async applyProjectSqlImport(): Promise<never> {
    throw new Error("SQL import is not used by this fixture.");
  }

  async exportProjectSql(): Promise<never> {
    throw new Error("SQL export is not used by this fixture.");
  }
}

function renderApp(api: ProjectApi, initialEntry = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    createAppRoutes({
      includeLayoutSpike: true,
      workspaceAdapters: {
        SourceEditor: TestSourceEditor,
        createParserClient: () => new UnavailableParserClient(),
      },
    }),
    { initialEntries: [initialEntry] },
  );
  return render(<App api={api} queryClient={queryClient} router={router} />);
}

const TestSourceEditor: SourceEditorComponent = ({ initialSource, onChange }) => (
  <textarea
    aria-label="DBML source editor"
    defaultValue={initialSource}
    onChange={(event) => onChange(event.currentTarget.value)}
  />
);

class UnavailableParserClient implements DbmlParserWorkerClient {
  async parse(): Promise<never> {
    throw new Error("Worker unavailable in this component test.");
  }

  dispose(): void {}
}

describe("Project Home", () => {
  it("shows an accessible empty state and creates an empty MySQL project", async () => {
    const api = new FakeProjectApi();
    api.projects = [];
    renderApp(api);

    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "Create project" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Enter a project name");
    expect(api.createInputs).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText("Project name"), {
      target: { value: "Orders" },
    });
    fireEvent.change(within(dialog).getByLabelText("Primary dialect"), {
      target: { value: "MYSQL" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));

    await screen.findByRole("heading", { name: "Orders", level: 1 }, { timeout: 3_000 });
    expect(api.createInputs).toEqual([{ name: "Orders", primaryDialect: "MYSQL", source: "" }]);
    expect(screen.getByText("MySQL project")).toBeVisible();
    expect(screen.queryByText("Compound groups, source-defined views")).not.toBeInTheDocument();
  });

  it("creates a project from decoded DBML file content without changing CRLF or Unicode", async () => {
    const api = new FakeProjectApi();
    api.projects = [];
    renderApp(api);
    fireEvent.click(await screen.findByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "Create project" });
    fireEvent.change(within(dialog).getByLabelText("Project name"), {
      target: { value: "Unicode schema" },
    });
    fireEvent.click(within(dialog).getByLabelText("DBML file"));
    const source = 'Table "사용자😀" {\r\n  id int [pk]\r\n}\r\n';
    const file = new File([source], "schema.dbml", { type: "text/plain" });
    fireEvent.change(within(dialog).getByLabelText("Choose DBML file"), {
      target: { files: [file] },
    });
    await within(dialog).findByText("schema.dbml");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create project" }));

    await screen.findByRole("heading", { name: "Unicode schema", level: 1 });
    expect(api.createInputs[0]?.source).toBe(source);
  });

  it("shows project status and supports open, rename, duplicate, and confirmed delete", async () => {
    const api = new FakeProjectApi();
    api.projects = [projectState({ validity: "INVALID" })];
    renderApp(api);

    const card = await screen.findByRole("article", { name: "Customer schema" });
    expect(within(card).getByText("Draft invalid")).toBeVisible();
    expect(within(card).getByText("1 error · 1 warning · 2 info")).toBeVisible();
    expect(within(card).getByText("Parser 9.1.1")).toBeVisible();
    expect(within(card).getByText("Revision 1")).toBeVisible();

    fireEvent.click(within(card).getByRole("button", { name: "Rename Customer schema" }));
    const renameDialog = await screen.findByRole("dialog", { name: "Rename project" });
    fireEvent.change(within(renameDialog).getByLabelText("Project name"), {
      target: { value: "Renamed schema" },
    });
    fireEvent.click(within(renameDialog).getByRole("button", { name: "Save name" }));
    expect(await screen.findByRole("article", { name: "Renamed schema" })).toBeVisible();
    expect(api.renameInputs[0]).toMatchObject({ expectedSchemaRevisionNo: 1 });

    const renamedCard = screen.getByRole("article", { name: "Renamed schema" });
    fireEvent.click(within(renamedCard).getByRole("button", { name: "Duplicate Renamed schema" }));
    const duplicateDialog = await screen.findByRole("dialog", { name: "Duplicate project" });
    fireEvent.click(within(duplicateDialog).getByRole("button", { name: "Duplicate project" }));
    expect(
      await screen.findByRole("heading", { name: "Renamed schema copy", level: 1 }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("link", { name: "Back to projects" }));
    const copyCard = await screen.findByRole("article", { name: "Renamed schema copy" });
    fireEvent.click(within(copyCard).getByRole("button", { name: "Delete Renamed schema copy" }));
    const deleteDialog = await screen.findByRole("dialog", { name: "Delete Renamed schema copy?" });
    expect(
      within(deleteDialog).getByText(/portable project export is not available/i),
    ).toBeVisible();
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "Delete project" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("article", { name: "Renamed schema copy" }),
      ).not.toBeInTheDocument();
    });
    expect(api.deleteInputs[0]).toMatchObject({ expectedSchemaRevisionNo: 1 });
  });

  it("keeps mutation input open on conflict and exposes only the correlation ID", async () => {
    const api = new FakeProjectApi();
    api.mutationError = new ProjectApiError("The project changed.", {
      code: "PROJECT_SCHEMA_REVISION_CONFLICT",
      status: 409,
      correlationId: "123e4567-e89b-42d3-a456-426614174000",
      currentRevisionNo: 2,
    });
    renderApp(api);
    const card = await screen.findByRole("article", { name: "Customer schema" });
    fireEvent.click(within(card).getByRole("button", { name: "Rename Customer schema" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename project" });
    const input = within(dialog).getByLabelText("Project name");
    fireEvent.change(input, { target: { value: "Still editing" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("current revision is 2");
    expect(within(dialog).getByText(/123e4567-e89b-42d3-a456-426614174000/)).toBeVisible();
    expect(input).toHaveValue("Still editing");
    expect(api.renameInputs).toHaveLength(1);
  });

  it("provides retry and not-found states without rendering unsafe errors", async () => {
    const api = new FakeProjectApi();
    api.listError = new Error("sqlite path /private/schema.db");
    renderApp(api);

    expect(await screen.findByRole("alert")).toHaveTextContent("Projects could not be loaded");
    expect(screen.queryByText(/private\/schema\.db/)).not.toBeInTheDocument();
    api.listError = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("article", { name: "Customer schema" })).toBeVisible();

    cleanup();
    const missingApi = new FakeProjectApi();
    missingApi.projects = [];
    renderApp(missingApi, `/projects/${PROJECT_ID}`);
    expect(await screen.findByRole("heading", { name: "Project not found" })).toBeVisible();

    cleanup();
    renderApp(new FakeProjectApi(), "/does-not-exist");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeVisible();
  });

  it("closes a dialog with Escape and returns focus to its trigger", async () => {
    const api = new FakeProjectApi();
    renderApp(api);
    const trigger = await screen.findByRole("button", { name: "New project" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Create project" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(api.createInputs).toHaveLength(0);
  });
});
