// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { DEFAULT_RUNTIME_CONFIG_RESPONSE } from "@er-diagram/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { App, createAppRoutes } from "../src/App.js";
import type { ProjectApi } from "../src/projects/project-api.js";

afterEach(() => {
  cleanup();
  document.title = "";
});

describe("application accessibility shell", () => {
  it("offers a skip link that moves focus to the main landmark", async () => {
    renderApplication();

    const skipLink = await screen.findByRole("link", { name: "Skip to main content" });
    const main = screen.getByRole("main");

    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
    expect(skipLink).toHaveAttribute("href", "#main-content");
    expect(main).toHaveAttribute("id", "main-content");

    skipLink.focus();
    fireEvent.click(skipLink);

    expect(main).toHaveFocus();
  });

  it("updates the document title and focuses the page heading after client navigation", async () => {
    const { router } = renderApplication();

    await screen.findByRole("heading", { name: "No projects yet" });
    await waitFor(() => expect(document.title).toBe("Projects · DBML·SQL ERD Studio"));

    await act(async () => {
      await router.navigate("/missing-page");
    });

    const heading = await screen.findByRole("heading", { name: "Page not found", level: 1 });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(document.title).toBe("Page not found · DBML·SQL ERD Studio");
  });
});

function renderApplication() {
  const api = createAccessibilityApi();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: ["/"] });
  const rendered = render(<App api={api} queryClient={queryClient} router={router} />);
  return { ...rendered, router };
}

function createAccessibilityApi(): ProjectApi {
  const unsupported = async (): Promise<never> => {
    throw new Error("This API method is not used by the accessibility shell fixture.");
  };

  return {
    getRuntimeConfig: async () => DEFAULT_RUNTIME_CONFIG_RESPONSE,
    listProjects: async () => ({ projects: [] }),
    getProject: unsupported,
    listRevisions: unsupported,
    createProject: unsupported,
    renameProject: unsupported,
    duplicateProject: unsupported,
    saveDraft: unsupported,
    restoreRevision: unsupported,
    getLayout: unsupported,
    saveLayout: unsupported,
    deleteProject: unsupported,
    previewStandaloneSqlImport: unsupported,
    createProjectFromSqlImport: unsupported,
    previewProjectSqlImport: unsupported,
    applyProjectSqlImport: unsupported,
    exportProjectSql: unsupported,
    applyVisualCommand: unsupported,
    exportProjectBundle: unsupported,
    importProjectBundle: unsupported,
  };
}
