// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { createHash } from "node:crypto";
import type { Diagnostic, ProjectMutationResponse, ProjectState } from "@er-diagram/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, forwardRef, useImperativeHandle, useRef, useState } from "react";
import { createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, createAppRoutes } from "../src/App.js";
import type { ProjectApi, SaveDraftInput } from "../src/projects/project-api.js";
import { ProjectApiError } from "../src/projects/project-api.js";
import type {
  SourceEditorHandle,
  SourceEditorProps,
} from "../src/source-editor/editor-contract.js";
import { DBML_MARKER_OWNER, MonacoDbmlEditor } from "../src/source-editor/monaco-dbml-editor.js";
import type { MonacoRuntime } from "../src/source-editor/monaco-runtime.js";
import type {
  DbmlParserWorkerClient,
  DbmlWorkerParseResult,
} from "../src/source-editor/parser-worker-client.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const CREATED_AT = "2026-08-27T01:02:03.004Z";
const VALID_SOURCE = "Table users {\r\n  id int [pk]\r\n}\r\n";
const SECOND_VALID_SOURCE = "Table users {\r\n  id int [pk]\r\n  email varchar\r\n}\r\n";
const INVALID_SOURCE = "Table users {\r\n  id int [pk]\r\n";
const SERVER_SOURCE = "Table server_state { id int [pk] }";

const navigateToDiagnostic = vi.fn();
const replaceSource = vi.fn();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  navigateToDiagnostic.mockReset();
  replaceSource.mockReset();
});

describe("DBML source workspace", () => {
  it("autosaves valid → invalid → valid source without losing the last-valid graph", async () => {
    const api = new SourceProjectApi(projectState(VALID_SOURCE, 1, "VALID"));
    renderWorkspace(api);

    const editor = await screen.findByLabelText("DBML source editor");
    expect(editor).toHaveValue(domValue(VALID_SOURCE));
    expect(await findWorkspaceStatus("Draft valid")).toBeVisible();
    expect(screen.getByText("Schema actions").nextElementSibling).toHaveTextContent("Available");

    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: INVALID_SOURCE } });
    expect(screen.getByText("Unsaved changes")).toBeVisible();
    expect(screen.getByText("Validation pending")).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(749));
    expect(api.saveDraftInputs).toHaveLength(0);

    await act(() => vi.advanceTimersByTimeAsync(1));
    await settleReact();
    expect(api.saveDraftInputs).toEqual([
      {
        projectId: PROJECT_ID,
        source: INVALID_SOURCE,
        expectedSchemaRevisionNo: 1,
      },
    ]);
    expect(screen.getByText("Saved")).toBeVisible();
    expect(getWorkspaceStatus("Draft invalid")).toBeVisible();
    expect(screen.getByText("Schema actions").nextElementSibling).toHaveTextContent("Disabled");
    expect(screen.getByText("Diagram source").nextElementSibling).toHaveTextContent(
      "Last valid revision",
    );

    const problems = screen.getByRole("heading", { name: "Problems" }).closest("section");
    if (!problems) throw new Error("Problems panel was not rendered.");
    expect(within(problems).getByText("1")).toBeVisible();
    fireEvent.click(within(problems).getByRole("button", { name: /Go to DBML_PARSE/ }));
    expect(navigateToDiagnostic).toHaveBeenCalledOnce();

    fireEvent.change(editor, { target: { value: SECOND_VALID_SOURCE } });
    await act(() => vi.advanceTimersByTimeAsync(750));
    await settleReact();
    expect(api.saveDraftInputs[1]).toEqual({
      projectId: PROJECT_ID,
      source: SECOND_VALID_SOURCE,
      expectedSchemaRevisionNo: 2,
    });
    expect(getWorkspaceStatus("Draft valid")).toBeVisible();
    expect(screen.getByText("Schema revision").nextElementSibling).toHaveTextContent("3");
  });

  it("preserves the local buffer on 409 and retries only after the latest revision loads", async () => {
    const api = new SourceProjectApi(projectState(VALID_SOURCE, 1, "VALID"));
    api.conflictOnce = projectState(SERVER_SOURCE, 2, "VALID");
    renderWorkspace(api);
    const editor = await screen.findByLabelText("DBML source editor");
    await findWorkspaceStatus("Draft valid");

    fireEvent.change(editor, { target: { value: SECOND_VALID_SOURCE } });
    fireEvent.click(screen.getByRole("button", { name: "Save now" }));

    expect(await screen.findByRole("heading", { name: "Draft conflict" })).toBeVisible();
    expect(editor).toHaveValue(domValue(SECOND_VALID_SOURCE));
    const retry = screen.getByRole("button", { name: "Retry local draft" });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await settleReact();

    expect(api.saveDraftInputs[1]).toMatchObject({
      source: SECOND_VALID_SOURCE,
      expectedSchemaRevisionNo: 2,
    });
    expect(screen.getByText("Saved")).toBeVisible();
    expect(editor).toHaveValue(domValue(SECOND_VALID_SOURCE));
  });

  it("loads the server draft only after destructive confirmation", async () => {
    const api = new SourceProjectApi(projectState(VALID_SOURCE, 1, "VALID"));
    api.conflictOnce = projectState(SERVER_SOURCE, 2, "VALID");
    renderWorkspace(api);
    const editor = await screen.findByLabelText("DBML source editor");
    await findWorkspaceStatus("Draft valid");

    fireEvent.change(editor, { target: { value: SECOND_VALID_SOURCE } });
    fireEvent.click(screen.getByRole("button", { name: "Save now" }));
    const trigger = await screen.findByRole("button", { name: "Load server draft" });
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Load server draft?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Load server draft" }));

    expect(replaceSource).toHaveBeenCalledWith(SERVER_SOURCE);
    expect(editor).toHaveValue(domValue(SERVER_SOURCE));
    expect(screen.getByText("Saved")).toBeVisible();
    expect(api.saveDraftInputs).toHaveLength(1);
  });

  it("blocks navigation with Stay focused and proceeds automatically after the write commits", async () => {
    const pendingSave = deferred<ProjectMutationResponse>();
    const api = new SourceProjectApi(projectState(VALID_SOURCE, 1, "VALID"));
    api.nextSave = pendingSave.promise;
    const { router } = renderWorkspace(api);
    const editor = await screen.findByLabelText("DBML source editor");
    await findWorkspaceStatus("Draft valid");

    fireEvent.change(editor, { target: { value: SECOND_VALID_SOURCE } });
    fireEvent.click(screen.getByRole("link", { name: "Back to projects" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave source workspace?" });
    expect(within(dialog).getByRole("button", { name: "Stay" })).toHaveFocus();
    expect(editor).toHaveValue(domValue(SECOND_VALID_SOURCE));
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(router.state.location.pathname).toBe(`/projects/${PROJECT_ID}`);

    fireEvent.click(screen.getByRole("link", { name: "Back to projects" }));
    await screen.findByRole("dialog", { name: "Leave source workspace?" });
    pendingSave.resolve(mutation(SECOND_VALID_SOURCE, 2, "VALID"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("registers beforeunload protection while a local buffer is unsaved", async () => {
    const api = new SourceProjectApi(projectState(VALID_SOURCE, 1, "VALID"));
    renderWorkspace(api);
    const editor = await screen.findByLabelText("DBML source editor");
    await findWorkspaceStatus("Draft valid");

    fireEvent.change(editor, { target: { value: SECOND_VALID_SOURCE } });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Save now" }));
    await waitFor(() => expect(getWorkspaceStatus("Saved")).toBeVisible());
    const savedEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(savedEvent);
    expect(savedEvent.defaultPrevented).toBe(false);
  });
});

describe("Monaco DBML adapter", () => {
  it("registers DBML, preserves CRLF, maps diagnostics and disposes every editor resource", async () => {
    const runtime = new FakeMonacoRuntime();
    const editorHandle = createRef<SourceEditorHandle>();
    const onChange = vi.fn();
    const onSave = vi.fn();
    const source = 'Table "사용자😀" {\r\n  id int\r\n}\r\n';
    const markerDiagnostic: Diagnostic = {
      code: "DBML_PARSE_SYNTAX_UNEXPECTED_TOKEN",
      message: "Unexpected token.",
      severity: "ERROR",
      range: {
        filepath: "/main.dbml",
        startOffset: source.indexOf("😀"),
        endOffset: source.length + 100,
        startLine: 1,
        startColumn: 9,
        endLine: 99,
        endColumn: 1,
      },
    };

    const rendered = render(
      <MonacoDbmlEditor
        ref={editorHandle}
        projectId={PROJECT_ID}
        initialSource={source}
        diagnostics={[markerDiagnostic]}
        onChange={onChange}
        onSave={onSave}
        loadRuntime={async () => runtime.value}
      />,
    );

    await waitFor(() => expect(runtime.createModel).toHaveBeenCalledOnce());
    expect(runtime.registerLanguage).toHaveBeenCalledWith({ id: "dbml", extensions: [".dbml"] });
    expect(runtime.setLanguageConfiguration).toHaveBeenCalledOnce();
    expect(runtime.setMonarchTokensProvider).toHaveBeenCalledOnce();
    expect(runtime.model.getValue()).toBe(source);
    expect(runtime.model.lastEol).toBe(1);
    expect(runtime.createEditor.mock.calls[0]?.[1]).toMatchObject({
      ariaLabel: "DBML source editor",
      model: runtime.model,
      minimap: { enabled: false },
    });
    expect(runtime.setModelMarkers).toHaveBeenCalledWith(runtime.model, DBML_MARKER_OWNER, [
      expect.objectContaining({ severity: 8, code: markerDiagnostic.code }),
    ]);

    expect(editorHandle.current?.navigateToDiagnostic(markerDiagnostic)).toBe(true);
    expect(runtime.editor.setSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        startLineNumber: 1,
        endLineNumber: 4,
        endColumn: 1,
      }),
    );
    expect(runtime.editor.revealRangeInCenter).toHaveBeenCalledOnce();
    expect(runtime.editor.focus).toHaveBeenCalledOnce();
    expect(
      editorHandle.current?.navigateToDiagnostic({
        code: "INTERNAL",
        message: "No range.",
        severity: "ERROR",
      }),
    ).toBe(false);

    act(() => runtime.model.simulateEdit("Table edited { id int }"));
    expect(onChange).toHaveBeenCalledWith("Table edited { id int }");
    const changeCalls = onChange.mock.calls.length;
    act(() => editorHandle.current?.replaceSource("Table server { id int }"));
    expect(runtime.model.getValue()).toBe("Table server { id int }");
    expect(runtime.model.lastEol).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(changeCalls);
    runtime.editor.saveCommand?.();
    expect(onSave).toHaveBeenCalledOnce();

    rendered.unmount();
    expect(runtime.changeListenerDispose).toHaveBeenCalledOnce();
    expect(runtime.editor.dispose).toHaveBeenCalledOnce();
    expect(runtime.model.dispose).toHaveBeenCalledOnce();
    expect(runtime.setModelMarkers).toHaveBeenLastCalledWith(runtime.model, DBML_MARKER_OWNER, []);
  });
});

const FakeSourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(
  function FakeSourceEditor({ initialSource, diagnostics, onChange, onSave }, ref) {
    const [source, setSource] = useState(initialSource);
    const eolRef = useRef(initialSource.includes("\r\n") ? "\r\n" : "\n");
    useImperativeHandle(ref, () => ({
      replaceSource(nextSource) {
        replaceSource(nextSource);
        eolRef.current = nextSource.includes("\r\n") ? "\r\n" : "\n";
        setSource(nextSource);
      },
      navigateToDiagnostic(diagnostic) {
        navigateToDiagnostic(diagnostic);
        return diagnostic.range !== undefined;
      },
      focus() {},
    }));
    return (
      <textarea
        aria-label="DBML source editor"
        value={source}
        data-diagnostic-count={diagnostics.length}
        onChange={(event) => {
          const nextSource =
            eolRef.current === "\r\n"
              ? event.currentTarget.value.replaceAll("\n", "\r\n")
              : event.currentTarget.value;
          setSource(nextSource);
          onChange(nextSource);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            onSave();
          }
        }}
      />
    );
  },
);

class FakeParserClient implements DbmlParserWorkerClient {
  readonly dispose = vi.fn();

  async parse(source: string): Promise<DbmlWorkerParseResult> {
    const sourceHash = sha256(source);
    if (source === INVALID_SOURCE) {
      return {
        type: "DBML_PARSE_RESULT",
        requestId: "550e8400-e29b-41d4-a716-446655440000",
        ok: false,
        sourceHash,
        parserInputHash: sourceHash,
        parserVersion: "9.1.1",
        diagnostics: [diagnostic(source)],
      };
    }
    return {
      type: "DBML_PARSE_RESULT",
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      ok: true,
      sourceHash,
      parserInputHash: sourceHash,
      parserVersion: "9.1.1",
      diagnostics: [],
      graph: {
        parserVersion: "9.1.1",
        schemaHash: sha256(`schema:${source}`),
        project: null,
        notes: [],
        tables: [],
        enums: [],
        references: [],
        groups: [],
        partials: [],
        views: [],
        diagnostics: [],
        sourceMap: {},
      },
    };
  }
}

class SourceProjectApi implements ProjectApi {
  readonly saveDraftInputs: SaveDraftInput[] = [];
  conflictOnce: ProjectState | null = null;
  nextSave: Promise<ProjectMutationResponse> | null = null;

  constructor(public state: ProjectState) {}

  async listProjects() {
    return {
      projects: [
        {
          id: this.state.project.id,
          name: this.state.project.name,
          primaryDialect: this.state.project.primaryDialect,
          parserVersion: this.state.project.parserVersion,
          schemaRevisionNo: this.state.project.schemaRevisionNo,
          layoutRevisionNo: this.state.project.layoutRevisionNo,
          draftValidity: this.state.currentRevision.validity,
          diagnosticSummary: this.state.currentRevision.diagnosticSummary,
          createdAt: this.state.project.createdAt,
          updatedAt: this.state.project.updatedAt,
        },
      ],
    };
  }

  async getProject(projectId: string) {
    if (projectId !== PROJECT_ID) throw new Error("PROJECT_NOT_FOUND");
    return { state: this.state };
  }

  async saveDraft(input: SaveDraftInput) {
    this.saveDraftInputs.push(input);
    if (this.conflictOnce) {
      this.state = this.conflictOnce;
      this.conflictOnce = null;
      throw new ProjectApiError("The project revision is stale.", {
        status: 409,
        code: "PROJECT_SCHEMA_REVISION_CONFLICT",
        currentRevisionNo: this.state.project.schemaRevisionNo,
      });
    }
    if (this.nextSave) {
      const response = await this.nextSave;
      this.nextSave = null;
      this.state = response.state;
      return response;
    }
    const validity = input.source === INVALID_SOURCE ? "INVALID" : "VALID";
    const response = mutation(
      input.source,
      this.state.project.schemaRevisionNo + 1,
      validity,
      validity === "INVALID" ? [diagnostic(input.source)] : [],
      this.state.lastValidRevision,
    );
    this.state = response.state;
    return response;
  }

  async createProject(): Promise<ProjectMutationResponse> {
    throw new Error("Not used in this test.");
  }
  async renameProject() {
    return { state: this.state };
  }
  async duplicateProject(): Promise<ProjectMutationResponse> {
    throw new Error("Not used in this test.");
  }
  async deleteProject(): Promise<void> {}
}

function renderWorkspace(api: SourceProjectApi) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    createAppRoutes({
      workspaceAdapters: {
        SourceEditor: FakeSourceEditor,
        createParserClient: () => new FakeParserClient(),
      },
    }),
    { initialEntries: [`/projects/${PROJECT_ID}`] },
  );
  const rendered = render(<App api={api} queryClient={queryClient} router={router} />);
  return { ...rendered, queryClient, router };
}

function mutation(
  source: string,
  revisionNo: number,
  validity: "VALID" | "INVALID",
  diagnostics: Diagnostic[] = [],
  previousLastValid: ProjectState["lastValidRevision"] = null,
): ProjectMutationResponse {
  return {
    state: projectState(source, revisionNo, validity, previousLastValid),
    diagnostics,
    revisionCreated: true,
  };
}

function projectState(
  source: string,
  revisionNo: number,
  validity: "VALID" | "INVALID",
  previousLastValid: ProjectState["lastValidRevision"] = null,
): ProjectState {
  const currentRevision = revision(source, revisionNo, validity);
  const lastValidRevision = validity === "VALID" ? currentRevision : previousLastValid;
  return {
    project: {
      id: PROJECT_ID,
      name: "Customer schema",
      primaryDialect: "POSTGRESQL",
      draftSource: source,
      draftHash: sha256(source),
      lastValidRevisionId: lastValidRevision?.id ?? null,
      parserVersion: "9.1.1",
      schemaRevisionNo: revisionNo,
      layoutRevisionNo: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision,
    lastValidRevision,
  };
}

function revision(source: string, revisionNo: number, validity: "VALID" | "INVALID") {
  return {
    id: `019d3f4e-7b6c-7a${revisionNo.toString().padStart(2, "0")}-8def-0123456789ab`,
    projectId: PROJECT_ID,
    revisionNo,
    source,
    sourceHash: sha256(source),
    validity,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: {
      errors: validity === "INVALID" ? 1 : 0,
      warnings: 0,
      infos: 0,
      parserVersion: "9.1.1",
    },
    createdAt: CREATED_AT,
  };
}

function diagnostic(source: string): Diagnostic {
  return {
    code: "DBML_PARSE_SYNTAX_UNEXPECTED_TOKEN",
    message: "A closing brace is required.",
    severity: "ERROR",
    range: {
      filepath: "/main.dbml",
      startOffset: source.length,
      endOffset: source.length,
      startLine: 3,
      startColumn: 1,
      endLine: 3,
      endColumn: 1,
    },
  };
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function domValue(source: string): string {
  return source.replaceAll("\r\n", "\n");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

class FakeMonacoRuntime {
  readonly model = new FakeMonacoModel();
  readonly changeListenerDispose = vi.fn();
  readonly registerLanguage = vi.fn();
  readonly setLanguageConfiguration = vi.fn();
  readonly setMonarchTokensProvider = vi.fn();
  readonly createModel = vi.fn((source: string) => {
    this.model.value = source;
    return this.model;
  });
  readonly setModelMarkers = vi.fn();
  readonly editor = {
    saveCommand: undefined as (() => void) | undefined,
    addCommand: vi.fn((_keybinding: number, command: () => void) => {
      this.editor.saveCommand = command;
      return "save-command";
    }),
    setSelection: vi.fn(),
    revealRangeInCenter: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
  };
  readonly createEditor = vi.fn((_container: HTMLElement, _options: unknown) => this.editor);
  readonly value = {
    KeyMod: { CtrlCmd: 2_048 },
    KeyCode: { KeyS: 49 },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
    Uri: { parse: (value: string) => ({ value }) },
    languages: {
      register: this.registerLanguage,
      setLanguageConfiguration: this.setLanguageConfiguration,
      setMonarchTokensProvider: this.setMonarchTokensProvider,
    },
    editor: {
      getModel: vi.fn(() => null),
      createModel: this.createModel,
      create: this.createEditor,
      setModelMarkers: this.setModelMarkers,
    },
  } as unknown as MonacoRuntime;

  constructor() {
    this.model.listenerDisposable = { dispose: this.changeListenerDispose };
  }
}

class FakeMonacoModel {
  value = "";
  lastEol = 0;
  readonly dispose = vi.fn();
  listenerDisposable: { dispose(): void } = { dispose() {} };
  private listener: (() => void) | undefined;

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.value = value;
    this.listener?.();
  }

  getValueLength(): number {
    return this.value.length;
  }

  getPositionAt(offset: number): { lineNumber: number; column: number } {
    const prefix = this.value.slice(0, offset);
    const lines = prefix.split(/\r\n|\r|\n/);
    return { lineNumber: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
  }

  setEOL(sequence: number): void {
    this.lastEol = sequence;
    const eol = sequence === 1 ? "\r\n" : "\n";
    this.value = this.value.replace(/\r\n|\r|\n/g, eol);
    this.listener?.();
  }

  onDidChangeContent(listener: () => void): { dispose(): void } {
    this.listener = listener;
    return this.listenerDisposable;
  }

  simulateEdit(value: string): void {
    this.value = value;
    this.listener?.();
  }
}

function sourcePanel(): HTMLElement {
  const panel = screen.getByText("Canonical DBML source").closest("section");
  if (!panel) throw new Error("Source panel was not rendered.");
  return panel;
}

function getWorkspaceStatus(label: string): HTMLElement {
  return within(sourcePanel()).getByText(label);
}

function findWorkspaceStatus(label: string): Promise<HTMLElement> {
  return within(sourcePanel()).findByText(label);
}
