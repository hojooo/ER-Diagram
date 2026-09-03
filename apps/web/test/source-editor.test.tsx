// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { createHash } from "node:crypto";
import {
  DEFAULT_RUNTIME_CONFIG_RESPONSE,
  type Diagnostic,
  type ProjectMutationResponse,
  type ProjectState,
} from "@er-diagram/contracts";
import { parseDbmlV2 } from "@er-diagram/core";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, forwardRef, useImperativeHandle, useRef, useState } from "react";
import { createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStore } from "zustand";

import { App, createAppRoutes } from "../src/App.js";
import type { BaseSchemaDiagramProps } from "../src/diagram/base-schema-diagram-contract.js";
import type { ProjectApi, SaveDraftInput, SaveLayoutInput } from "../src/projects/project-api.js";
import { ProjectApiError } from "../src/projects/project-api.js";
import type {
  SourceEditorHandle,
  SourceEditorProps,
} from "../src/source-editor/editor-contract.js";
import {
  DBML_EDITOR_THEME,
  DBML_MARKER_OWNER,
  MonacoDbmlEditor,
} from "../src/source-editor/monaco-dbml-editor.js";
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
const INFO_SOURCE = `Table parents {
  id int [pk]
}

Table children {
  parent_id int
}

Ref: children.parent_id > parents.id
`;
const SERVER_SOURCE = "Table server_state { id int [pk] }";
const VIEW_SOURCE = `TableGroup Identity {
  accounts
  profiles
}

Table accounts {
  id int [pk]
}

Table profiles {
  id int [pk]
  account_id int
}

Table orders {
  id int [pk]
  account_id int
}

Ref profile_account: profiles.account_id > accounts.id
Ref order_account: orders.account_id > accounts.id

DiagramView identity_only {
  Tables {
    accounts
    profiles
  }
  TableGroups {
    Identity
  }
  Schemas {
  }
}
`;

const navigateToDiagnostic = vi.fn();
const replaceSource = vi.fn();
const revealSourceRange = vi.fn();
const focusSource = vi.fn();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  navigateToDiagnostic.mockReset();
  replaceSource.mockReset();
  revealSourceRange.mockReset();
  focusSource.mockReset();
});

describe("DBML source workspace", () => {
  it("shows DBML compiler information at the bottom of the outline instead of Problems", async () => {
    const api = new SourceProjectApi(projectState(INFO_SOURCE, 1, "VALID"));
    renderWorkspace(api);

    await screen.findByText("Canonical DBML source");
    await findWorkspaceStatus("Draft valid");
    expect(screen.queryByRole("heading", { name: "Problems" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    const compilerInformation = await screen.findByRole("region", {
      name: "DBML compiler information",
    });
    expect(within(compilerInformation).getByText("2")).toBeVisible();
    expect(
      within(compilerInformation).getByText(
        "Column 'children.parent_id' is nullable but operator '>' requires it to be NOT NULL",
      ),
    ).toBeVisible();
    expect(within(compilerInformation).getByText("2 source locations")).toBeVisible();

    fireEvent.click(within(compilerInformation).getByText("2 source locations"));
    const [firstSourceLocation] = within(compilerInformation).getAllByRole("button", {
      name: /Open DBML_SEMANTIC_INVALID_REF_RELATIONSHIP at line/,
    });
    if (firstSourceLocation === undefined) {
      throw new Error("Expected a DBML compiler source location action");
    }
    fireEvent.click(firstSourceLocation);
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));
    expect(navigateToDiagnostic).toHaveBeenCalledOnce();
  });

  it("autosaves valid → invalid → valid source without losing the last-valid graph", async () => {
    const api = new SourceProjectApi(projectState(VALID_SOURCE, 1, "VALID"));
    renderWorkspace(api);

    const editor = (await screen.findByLabelText("DBML source editor")) as HTMLTextAreaElement;
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
    await act(() => vi.advanceTimersByTimeAsync(16));
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

  it("records committed source revisions and adopts undo and redo without a duplicate autosave", async () => {
    const api = new SourceProjectApi(projectState(VALID_SOURCE, 1, "VALID"));
    renderWorkspace(api);
    const editor = (await screen.findByLabelText("DBML source editor")) as HTMLTextAreaElement;
    await findWorkspaceStatus("Draft valid");

    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: SECOND_VALID_SOURCE } });
    await act(() => vi.advanceTimersByTimeAsync(750));
    await settleReact();

    const undo = screen.getByRole("button", { name: /Undo schema change, 1 step/ });
    expect(undo).toBeEnabled();
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "Create table" }));
    const tableName = await screen.findByLabelText("Table name");
    fireEvent.keyDown(tableName, { key: "z", ctrlKey: true });
    expect(api.saveDraftInputs).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Undo schema change, 1 step/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.keyDown(screen.getByTestId("fake-relationship-edge"), {
      key: "z",
      ctrlKey: true,
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Redo schema change, 1 step/ })).toBeEnabled(),
    );

    expect(api.saveDraftInputs).toHaveLength(2);
    expect(api.saveDraftInputs[1]).toMatchObject({
      projectId: PROJECT_ID,
      source: VALID_SOURCE,
      expectedSchemaRevisionNo: 2,
      commandId: expect.any(String),
    });
    expect(editor).toHaveValue(domValue(VALID_SOURCE));
    expect(screen.getByText("Schema revision").nextElementSibling).toHaveTextContent("3");

    const redo = screen.getByRole("button", { name: /Redo schema change, 1 step/ });
    expect(redo).toBeEnabled();
    fireEvent.keyDown(screen.getByRole("application", { name: "ER diagram canvas" }), {
      key: "z",
      ctrlKey: true,
      shiftKey: true,
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Undo schema change, 1 step/ })).toBeEnabled(),
    );

    expect(api.saveDraftInputs).toHaveLength(3);
    expect(api.saveDraftInputs[2]).toMatchObject({
      projectId: PROJECT_ID,
      source: SECOND_VALID_SOURCE,
      expectedSchemaRevisionNo: 3,
      commandId: expect.any(String),
    });
    expect(editor).toHaveValue(domValue(SECOND_VALID_SOURCE));
    expect(screen.getByText("Schema revision").nextElementSibling).toHaveTextContent("4");
  });

  it("adopts an external revision and resets workspace history after an undo conflict", async () => {
    const api = new SourceProjectApi(projectState(VALID_SOURCE, 1, "VALID"));
    renderWorkspace(api);
    const editor = (await screen.findByLabelText("DBML source editor")) as HTMLTextAreaElement;
    await findWorkspaceStatus("Draft valid");
    await waitFor(() => expect(api.getLayoutInputs).toHaveLength(1));

    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: SECOND_VALID_SOURCE } });
    await act(() => vi.advanceTimersByTimeAsync(750));
    await settleReact();
    vi.useRealTimers();

    const externalState = projectState(SERVER_SOURCE, 3, "VALID");
    const external = {
      ...externalState,
      project: { ...externalState.project, layoutRevisionNo: 7 },
    };
    api.conflictOnce = external;
    fireEvent.click(screen.getByRole("button", { name: /Undo schema change, 1 step/ }));

    await waitFor(() => expect(editor).toHaveValue(domValue(SERVER_SOURCE)));
    await waitFor(() => expect(api.getLayoutInputs).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByTestId("fake-diagram-layout-keys")).toHaveTextContent(
        'table:["public","server_state"]',
      ),
    );
    expect(screen.getByText("Schema revision").nextElementSibling).toHaveTextContent("3");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Undo schema change, 0 steps/ })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: /Redo schema change, 0 steps/ })).toBeDisabled();
    expect(screen.getByText("The project revision is stale.")).toBeVisible();
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

    await waitFor(() =>
      expect(api.saveDraftInputs[1]).toMatchObject({
        source: SECOND_VALID_SOURCE,
        expectedSchemaRevisionNo: 2,
      }),
    );
    expect(await findWorkspaceStatus("Saved")).toBeVisible();
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
    const backToProjects = screen.getByRole("link", { name: "Back" });
    fireEvent.click(backToProjects);
    const dialog = await screen.findByRole("dialog", { name: "Leave schema workspace?" });
    expect(within(dialog).getByRole("button", { name: "Stay" })).toHaveFocus();
    expect(editor).toHaveValue(domValue(SECOND_VALID_SOURCE));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(backToProjects).toHaveFocus());
    expect(router.state.location.pathname).toBe(`/projects/${PROJECT_ID}`);

    fireEvent.click(backToProjects);
    await screen.findByRole("dialog", { name: "Leave schema workspace?" });
    pendingSave.resolve(mutation(SECOND_VALID_SOURCE, 2, "VALID"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("enters replace import only after source and layout are saved and offers no discard bypass", async () => {
    const pendingSave = deferred<ProjectMutationResponse>();
    const api = new SourceProjectApi(projectState(VALID_SOURCE, 1, "VALID"));
    api.nextSave = pendingSave.promise;
    const { router } = renderWorkspace(api);
    const editor = await screen.findByLabelText("DBML source editor");
    await findWorkspaceStatus("Draft valid");

    fireEvent.change(editor, { target: { value: SECOND_VALID_SOURCE } });
    fireEvent.click(screen.getByRole("link", { name: "Import SQL" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave schema workspace?" });
    expect(
      within(dialog).queryByRole("button", { name: "Leave workspace" }),
    ).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/projects/${PROJECT_ID}`);

    pendingSave.resolve(mutation(SECOND_VALID_SOURCE, 2, "VALID"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${PROJECT_ID}/sql-import`),
    );
  });

  it("enters SQL export only after source and layout are saved and offers no discard bypass", async () => {
    const pendingSave = deferred<ProjectMutationResponse>();
    const api = new SourceProjectApi(projectState(VALID_SOURCE, 1, "VALID"));
    api.nextSave = pendingSave.promise;
    const { router } = renderWorkspace(api);
    const editor = await screen.findByLabelText("DBML source editor");
    await findWorkspaceStatus("Draft valid");

    fireEvent.change(editor, { target: { value: SECOND_VALID_SOURCE } });
    fireEvent.click(screen.getByRole("link", { name: "Export SQL" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave schema workspace?" });
    expect(
      within(dialog).queryByRole("button", { name: "Leave workspace" }),
    ).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/projects/${PROJECT_ID}`);

    pendingSave.resolve(mutation(SECOND_VALID_SOURCE, 2, "VALID"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${PROJECT_ID}/sql-export`),
    );
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

  it("keeps the canvas mounted and performs no parse or persistence work when surfaces toggle", async () => {
    const api = new SourceProjectApi(projectState(VALID_SOURCE, 1, "VALID"));
    const { parserClient } = renderWorkspace(api);
    await screen.findByText("Canonical DBML source");
    await findWorkspaceStatus("Draft valid");
    const diagram = screen.getByRole("application", { name: "ER diagram canvas" });
    const initialParseCalls = parserClient.parseCalls;
    const initialLayoutReads = api.getLayoutInputs.length;
    const commandBar = screen.getByTestId("workspace-command-bar");
    expect(within(commandBar).queryByRole("button", { name: "Source" })).toBeNull();
    expect(within(commandBar).queryByRole("button", { name: "Outline" })).toBeNull();
    expect(within(commandBar).queryByRole("button", { name: "Tools" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse workspace tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));

    expect(screen.getByRole("application", { name: "ER diagram canvas" })).toBe(diagram);
    expect(screen.queryByTestId("diagram-controls")).not.toBeInTheDocument();
    expect(parserClient.parseCalls).toBe(initialParseCalls);
    expect(api.getLayoutInputs).toHaveLength(initialLayoutReads);
    expect(api.saveDraftInputs).toHaveLength(0);
    expect(api.saveLayoutInputs).toHaveLength(0);
    expect(api.state.project.schemaRevisionNo).toBe(1);
    expect(api.state.project.layoutRevisionNo).toBe(0);
    expect(api.state.project.updatedAt).toBe(CREATED_AT);
  });

  it("uses the full-viewport shell only for the project workspace route", async () => {
    const api = new SourceProjectApi(projectState(VALID_SOURCE, 1, "VALID"));
    const { router } = renderWorkspace(api);
    await screen.findByText("Canonical DBML source");
    await findWorkspaceStatus("Draft valid");

    const main = screen.getByRole("main");
    expect(main).toHaveClass("h-full", "w-full", "overflow-hidden");
    expect(main).not.toHaveClass("max-w-7xl");
    expect(screen.queryByText("Self-hosted schema workspace")).not.toBeInTheDocument();

    await act(async () => router.navigate("/"));
    await screen.findByRole("heading", { name: "Projects", level: 1 });
    expect(screen.getByRole("main")).toHaveClass("max-w-7xl");
    expect(screen.getByText("Self-hosted schema workspace")).toBeVisible();
  });

  it("synchronizes source selection and diagram navigation without applying last-valid ranges", async () => {
    const api = new SourceProjectApi(projectState(VALID_SOURCE, 1, "VALID"));
    renderWorkspace(api);
    const editor = (await screen.findByLabelText("DBML source editor")) as HTMLTextAreaElement;
    await findWorkspaceStatus("Draft valid");

    editor.setSelectionRange(VALID_SOURCE.indexOf("id"), VALID_SOURCE.indexOf("id"));
    fireEvent.select(editor);
    expect(await screen.findByTestId("fake-diagram-selection")).toHaveTextContent("column");

    fireEvent.click(screen.getByRole("button", { name: "Collapse workspace tools" }));
    expect(screen.getByRole("button", { name: "Open workspace tools" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Select first diagram table" }));
    expect(revealSourceRange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Open workspace tools" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByTitle(/Selected table .*users/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open workspace tools" }));
    expect(screen.getByText(/Selected table .*users/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    const openSource = await screen.findByRole("button", {
      name: /Open source for table at line/,
    });
    fireEvent.click(openSource);
    await waitFor(() => expect(revealSourceRange).toHaveBeenCalledOnce());

    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: INVALID_SOURCE } });
    await act(() => vi.advanceTimersByTimeAsync(750));
    await settleReact();
    expect(screen.getByText(/Showing last-valid revision 1/)).toBeVisible();
    const navigationCalls = revealSourceRange.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Select first diagram table" }));
    expect(revealSourceRange).toHaveBeenCalledTimes(navigationCalls);

    fireEvent.change(editor, { target: { value: SECOND_VALID_SOURCE } });
    await act(() => vi.advanceTimersByTimeAsync(750));
    await vi.waitFor(() => {
      expect(screen.getByText(/Showing the current valid draft/)).toBeVisible();
    });
    fireEvent.click(screen.getByRole("button", { name: "Select first diagram table" }));
    expect(revealSourceRange).toHaveBeenCalledTimes(navigationCalls);
  });

  it("offers a source focus action when an invalid initial draft has no last-valid graph", async () => {
    const api = new SourceProjectApi(projectState(INVALID_SOURCE, 1, "INVALID", null));
    renderWorkspace(api);

    expect(await screen.findByText("No valid diagram yet")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open workspace tools" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Source" })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Focus source editor" }));
    await waitFor(() => expect(focusSource).toHaveBeenCalledOnce());
  });

  it("hydrates an uncached view before committing one diagram projection transition", async () => {
    const api = new SourceProjectApi(projectState(VIEW_SOURCE, 1, "VALID"));
    renderWorkspace(api);
    await screen.findByText("Canonical DBML source");
    await findWorkspaceStatus("Draft valid");
    await waitFor(() => expect(api.getLayoutInputs).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId("fake-diagram-layout-pending")).toHaveTextContent("ready"),
    );

    const pendingLayout = deferred<Awaited<ReturnType<ProjectApi["getLayout"]>>>();
    api.nextLayout = pendingLayout.promise;
    const viewSelector = screen.getByRole("combobox", { name: "Diagram view" });
    const viewKey = within(viewSelector)
      .getByRole("option", { name: "identity_only" })
      .getAttribute("value");
    if (!viewKey) throw new Error("Expected the source-defined view key.");

    fireEvent.change(viewSelector, { target: { value: viewKey } });
    await waitFor(() => expect(api.getLayoutInputs).toHaveLength(2));
    expect(api.getLayoutInputs[1]).toEqual({ projectId: PROJECT_ID, viewKey });
    expect(screen.getByTestId("fake-diagram-view")).toHaveTextContent("Global");
    expect(screen.getByRole("application", { name: "ER diagram canvas" })).toBeVisible();

    pendingLayout.resolve({ layout: null, currentLayoutRevisionNo: 0 });
    await waitFor(() =>
      expect(screen.getByTestId("fake-diagram-view")).toHaveTextContent("identity_only"),
    );
    expect(screen.getByTestId("fake-diagram-layout-pending")).toHaveTextContent("ready");
  });

  it("keeps view-specific collapse and LOD state while requiring explicit Global navigation", async () => {
    const api = new SourceProjectApi(projectState(VIEW_SOURCE, 1, "VALID"));
    const { parserClient } = renderWorkspace(api);
    const editor = (await screen.findByLabelText("DBML source editor")) as HTMLTextAreaElement;
    await findWorkspaceStatus("Draft valid");
    const initialParseCalls = parserClient.parseCalls;

    const viewSelector = screen.getByRole("combobox", { name: "Diagram view" });
    const identityOption = within(viewSelector).getByRole("option", { name: "identity_only" });
    fireEvent.change(viewSelector, { target: { value: identityOption.getAttribute("value") } });
    await screen.findByRole("button", { name: "Toggle first fake group" });
    fireEvent.change(screen.getByRole("combobox", { name: "Detail level" }), {
      target: { value: "KEYS_ONLY" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Toggle first fake group" }));
    expect(screen.getByTestId("fake-diagram-view")).toHaveTextContent("identity_only");
    expect(screen.getByTestId("fake-diagram-detail")).toHaveTextContent("KEYS_ONLY");
    expect(screen.getByTestId("fake-diagram-collapse-count")).toHaveTextContent("1");

    fireEvent.change(viewSelector, { target: { value: "GLOBAL" } });
    await waitFor(() =>
      expect(screen.getByTestId("fake-diagram-view")).toHaveTextContent("Global"),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Detail level" }), {
      target: { value: "NAME_ONLY" },
    });
    fireEvent.change(viewSelector, { target: { value: identityOption.getAttribute("value") } });
    await waitFor(() =>
      expect(screen.getByTestId("fake-diagram-detail")).toHaveTextContent("KEYS_ONLY"),
    );
    expect(screen.getByTestId("fake-diagram-collapse-count")).toHaveTextContent("1");

    const hiddenTableOffset = VIEW_SOURCE.indexOf("Table orders") + "Table ".length;
    editor.setSelectionRange(hiddenTableOffset, hiddenTableOffset);
    fireEvent.select(editor);
    expect(await screen.findByText("This symbol is hidden by identity_only.")).toBeVisible();
    expect(screen.getByTestId("fake-diagram-selection")).toHaveTextContent("none");
    fireEvent.click(screen.getByRole("button", { name: "Show in Global" }));
    expect(viewSelector).toHaveValue("GLOBAL");
    expect(screen.getByTestId("fake-diagram-selection")).toHaveTextContent("table");
    expect(api.saveDraftInputs).toHaveLength(0);
    expect(parserClient.parseCalls).toBe(initialParseCalls);
  });
});

describe("Monaco DBML adapter", () => {
  it("registers DBML, preserves CRLF, maps diagnostics and disposes every editor resource", async () => {
    const runtime = new FakeMonacoRuntime();
    const editorHandle = createRef<SourceEditorHandle>();
    const onChange = vi.fn();
    const onSave = vi.fn();
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const onCursorPositionChange = vi.fn();
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
        onUndo={onUndo}
        onRedo={onRedo}
        onCursorPositionChange={onCursorPositionChange}
        loadRuntime={async () => runtime.value}
      />,
    );

    await waitFor(() => expect(runtime.createModel).toHaveBeenCalledOnce());
    expect(runtime.registerLanguage).toHaveBeenCalledWith({ id: "dbml", extensions: [".dbml"] });
    expect(runtime.setLanguageConfiguration).toHaveBeenCalledOnce();
    expect(runtime.setMonarchTokensProvider).toHaveBeenCalledOnce();
    expect(runtime.defineTheme).toHaveBeenCalledWith(
      DBML_EDITOR_THEME,
      expect.objectContaining({
        base: "vs-dark",
        colors: expect.objectContaining({
          "editorLineNumber.dimmedForeground": "#94A3B8",
        }),
      }),
    );
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

    const markerRange = markerDiagnostic.range;
    if (!markerRange) throw new Error("Expected a diagnostic source range.");
    expect(editorHandle.current?.revealSourceRange(markerRange)).toBe(true);
    expect(runtime.editor.setSelection).toHaveBeenLastCalledWith({
      startLineNumber: 1,
      startColumn: 11,
      endLineNumber: 1,
      endColumn: 11,
    });
    expect(
      editorHandle.current?.revealSourceRange({
        ...markerRange,
        filepath: "/shared.dbml",
      }),
    ).toBe(false);

    act(() => runtime.editor.simulateCursor({ lineNumber: 2, column: 3 }));
    expect(onCursorPositionChange).toHaveBeenCalledWith({
      filepath: "/main.dbml",
      offset: source.indexOf("id"),
    });

    act(() => runtime.model.simulateEdit("Table edited { id int }"));
    expect(onChange).toHaveBeenCalledWith("Table edited { id int }");
    const changeCalls = onChange.mock.calls.length;
    act(() => editorHandle.current?.replaceSource("Table server { id int }"));
    expect(runtime.model.getValue()).toBe("Table server { id int }");
    expect(runtime.model.lastEol).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(changeCalls);
    runtime.editor.commands.get(runtime.keybinding("KeyS"))?.();
    expect(onSave).toHaveBeenCalledOnce();
    runtime.editor.commands.get(runtime.keybinding("KeyZ"))?.();
    runtime.editor.commands.get(runtime.keybinding("KeyZ", true))?.();
    runtime.editor.commands.get(runtime.keybinding("KeyY"))?.();
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onRedo).toHaveBeenCalledTimes(2);

    rendered.unmount();
    expect(runtime.changeListenerDispose).toHaveBeenCalledOnce();
    expect(runtime.cursorListenerDispose).toHaveBeenCalledOnce();
    expect(runtime.editor.dispose).toHaveBeenCalledOnce();
    expect(runtime.model.dispose).toHaveBeenCalledOnce();
    expect(runtime.setModelMarkers).toHaveBeenLastCalledWith(runtime.model, DBML_MARKER_OWNER, []);
  });

  it("adopts authoritative source received before the Monaco runtime is ready", async () => {
    const runtime = new FakeMonacoRuntime();
    const editorHandle = createRef<SourceEditorHandle>();
    const onReady = vi.fn();
    let resolveRuntime: ((value: MonacoRuntime) => void) | undefined;
    const runtimePromise = new Promise<MonacoRuntime>((resolve) => {
      resolveRuntime = resolve;
    });

    render(
      <MonacoDbmlEditor
        ref={editorHandle}
        projectId={PROJECT_ID}
        initialSource="Table stale { id int }"
        diagnostics={[]}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onReady={onReady}
        loadRuntime={() => runtimePromise}
      />,
    );

    act(() => editorHandle.current?.replaceSource("Table authoritative { id int }"));
    act(() => resolveRuntime?.(runtime.value));

    await waitFor(() => expect(runtime.createModel).toHaveBeenCalledOnce());
    expect(runtime.model.getValue()).toBe("Table authoritative { id int }");
    expect(onReady).toHaveBeenCalledOnce();
  });
});

const FakeSourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(
  function FakeSourceEditor(
    { initialSource, diagnostics, onChange, onSave, onCursorPositionChange },
    ref,
  ) {
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
      revealSourceRange(range) {
        revealSourceRange(range);
        return range.filepath === "/main.dbml";
      },
      focus() {
        focusSource();
      },
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
        onSelect={(event) =>
          onCursorPositionChange?.({
            filepath: "/main.dbml",
            offset: event.currentTarget.selectionStart,
          })
        }
      />
    );
  },
);

class FakeParserClient implements DbmlParserWorkerClient {
  readonly dispose = vi.fn();
  parseCalls = 0;

  async parse(source: string): Promise<DbmlWorkerParseResult> {
    this.parseCalls += 1;
    const parsed = await parseDbmlV2(source);
    if (!parsed.ok) {
      return {
        type: "DBML_PARSE_RESULT",
        requestId: "550e8400-e29b-41d4-a716-446655440000",
        ok: false,
        sourceHash: parsed.sourceHash,
        parserInputHash: parsed.parserInputHash,
        parserVersion: "9.1.1",
        diagnostics: parsed.diagnostics,
      };
    }
    return {
      type: "DBML_PARSE_RESULT",
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      ok: true,
      sourceHash: parsed.sourceHash,
      parserInputHash: parsed.parserInputHash,
      parserVersion: "9.1.1",
      diagnostics: parsed.graph.diagnostics,
      graph: parsed.graph,
    };
  }
}

function FakeSchemaDiagram({
  graph,
  viewKey,
  detailLevel,
  collapsedGroupKeys,
  layoutPositions,
  layoutPending,
  selectionStore,
  onToggleGroup,
  onActivateElement,
}: BaseSchemaDiagramProps) {
  const selection = useStore(selectionStore, (state) => state.selection);
  const table = graph.tables[0];
  return (
    <div role="application" aria-label="ER diagram canvas" data-schema-history-scope="diagram">
      <svg aria-label="Fake relationships">
        <g data-testid="fake-relationship-edge" tabIndex={0} />
      </svg>
      <output data-testid="fake-diagram-selection">{selection?.kind ?? "none"}</output>
      <output data-testid="fake-diagram-view">
        {viewKey === "GLOBAL"
          ? "Global"
          : (graph.views.find((view) => view.key === viewKey)?.name ?? "Unknown")}
      </output>
      <output data-testid="fake-diagram-detail">{detailLevel}</output>
      <output data-testid="fake-diagram-collapse-count">{collapsedGroupKeys.size}</output>
      <output data-testid="fake-diagram-layout-keys">
        {Object.keys(layoutPositions ?? {})
          .sort()
          .join(",")}
      </output>
      <output data-testid="fake-diagram-layout-pending">
        {layoutPending ? "pending" : "ready"}
      </output>
      {graph.groups[0] ? (
        <button type="button" onClick={() => onToggleGroup(graph.groups[0]?.key ?? "")}>
          Toggle first fake group
        </button>
      ) : null}
      {table ? (
        <button
          type="button"
          onClick={() => {
            const nextSelection = {
              elementKey: table.key,
              kind: "table" as const,
              tableKeys: [table.key],
            };
            selectionStore.getState().setSelection(nextSelection);
            onActivateElement?.(nextSelection);
          }}
        >
          Select first diagram table
        </button>
      ) : null}
    </div>
  );
}

class SourceProjectApi implements ProjectApi {
  readonly saveDraftInputs: SaveDraftInput[] = [];
  readonly saveLayoutInputs: SaveLayoutInput[] = [];
  readonly getLayoutInputs: Array<{ projectId: string; viewKey: string }> = [];
  conflictOnce: ProjectState | null = null;
  nextSave: Promise<ProjectMutationResponse> | null = null;
  nextLayout: Promise<Awaited<ReturnType<ProjectApi["getLayout"]>>> | null = null;

  constructor(public state: ProjectState) {}

  async getRuntimeConfig() {
    return DEFAULT_RUNTIME_CONFIG_RESPONSE;
  }

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

  async listRevisions() {
    return { revisions: [] };
  }

  async restoreRevision(): Promise<never> {
    throw new Error("Revision restore is not expected in source editor tests.");
  }

  async getLayout(input: { projectId: string; viewKey: string }) {
    this.getLayoutInputs.push(input);
    if (this.nextLayout) {
      const response = await this.nextLayout;
      this.nextLayout = null;
      return response;
    }
    const revisionNo = this.state.project.layoutRevisionNo;
    return {
      layout:
        revisionNo === 0
          ? null
          : {
              projectId: input.projectId,
              viewKey: input.viewKey,
              positions: { 'table:["public","server_state"]': { x: 320, y: 180 } },
              collapsedGroupKeys: [],
              hiddenElementKeys: [],
              viewport: { x: 12, y: 24, zoom: 1.25 },
              detailLevel: "FULL" as const,
              baseSchemaHash: sha256(SERVER_SOURCE),
              revisionNo,
            },
      currentLayoutRevisionNo: revisionNo,
    };
  }

  applyVisualCommand: ProjectApi["applyVisualCommand"] = async () => {
    throw new Error("Visual commands are not expected in source editor tests.");
  };

  async saveLayout(input: SaveLayoutInput) {
    this.saveLayoutInputs.push(input);
    const revisionNo = input.expectedLayoutRevisionNo + 1;
    this.state = {
      ...this.state,
      project: { ...this.state.project, layoutRevisionNo: revisionNo },
    };
    return {
      state: {
        layout: {
          projectId: input.projectId,
          viewKey: input.viewKey,
          revisionNo,
          ...input.layout,
        },
        currentLayoutRevisionNo: revisionNo,
      },
      layoutUpdated: true,
    };
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
  async exportProjectBundle(): Promise<never> {
    throw new Error("Bundle export is not used by this fixture.");
  }
  async importProjectBundle(): Promise<never> {
    throw new Error("Bundle import is not used by this fixture.");
  }
}

function renderWorkspace(api: SourceProjectApi) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const parserClient = new FakeParserClient();
  const router = createMemoryRouter(
    createAppRoutes({
      workspaceAdapters: {
        SourceEditor: FakeSourceEditor,
        SchemaDiagram: FakeSchemaDiagram,
        createParserClient: () => parserClient,
      },
    }),
    { initialEntries: [`/projects/${PROJECT_ID}`] },
  );
  const rendered = render(
    <App api={api} queryClient={queryClient} router={router} initialLocale="en" />,
  );
  return { ...rendered, queryClient, router, parserClient };
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
  readonly cursorListenerDispose = vi.fn();
  readonly registerLanguage = vi.fn();
  readonly setLanguageConfiguration = vi.fn();
  readonly setMonarchTokensProvider = vi.fn();
  readonly createModel = vi.fn((source: string) => {
    this.model.value = source;
    return this.model;
  });
  readonly setModelMarkers = vi.fn();
  readonly defineTheme = vi.fn();
  readonly editor = {
    commands: new Map<number, () => void>(),
    addCommand: vi.fn((keybinding: number, command: () => void) => {
      this.editor.commands.set(keybinding, command);
      return `command-${keybinding}`;
    }),
    setSelection: vi.fn(),
    revealRangeInCenter: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    cursorListener: undefined as
      | ((event: { position: { lineNumber: number; column: number } }) => void)
      | undefined,
    onDidChangeCursorPosition: vi.fn(
      (listener: (event: { position: { lineNumber: number; column: number } }) => void) => {
        this.editor.cursorListener = listener;
        return { dispose: this.cursorListenerDispose };
      },
    ),
    simulateCursor: (position: { lineNumber: number; column: number }) => {
      this.editor.cursorListener?.({ position });
    },
  };
  readonly createEditor = vi.fn((_container: HTMLElement, _options: unknown) => this.editor);
  readonly value = {
    KeyMod: { CtrlCmd: 2_048, Shift: 1_024 },
    KeyCode: { KeyS: 49, KeyZ: 56, KeyY: 55 },
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
      defineTheme: this.defineTheme,
      setModelMarkers: this.setModelMarkers,
    },
  } as unknown as MonacoRuntime;

  constructor() {
    this.model.listenerDisposable = { dispose: this.changeListenerDispose };
  }

  keybinding(key: "KeyS" | "KeyZ" | "KeyY", shift = false): number {
    const keyCode = { KeyS: 49, KeyZ: 56, KeyY: 55 }[key];
    return 2_048 | (shift ? 1_024 : 0) | keyCode;
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

  getOffsetAt(position: { lineNumber: number; column: number }): number {
    const lines = this.value.split(/\r\n|\r|\n/);
    const preceding = lines.slice(0, position.lineNumber - 1);
    const eolLength = this.value.includes("\r\n") ? 2 : 1;
    return (
      preceding.reduce((total, line) => total + line.length + eolLength, 0) + position.column - 1
    );
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
