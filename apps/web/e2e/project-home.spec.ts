import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

import { createControlledLayoutApi } from "./controlled-layout-api.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const COPY_ID = "019d3f4e-7b6c-7def-9abc-0123456789ab";
const CREATED_AT = "2026-08-27T01:02:03.004Z";

interface TestProjectState {
  project: {
    id: string;
    name: string;
    primaryDialect: "POSTGRESQL" | "MYSQL";
    draftSource: string;
    draftHash: string;
    lastValidRevisionId: string;
    parserVersion: string;
    schemaRevisionNo: number;
    layoutRevisionNo: number;
    createdAt: string;
    updatedAt: string;
  };
  currentRevision: ReturnType<typeof revision>;
  lastValidRevision: ReturnType<typeof revision>;
}

function revision(projectId: string) {
  const source = "";
  return {
    id: projectId,
    projectId,
    revisionNo: 1,
    source,
    sourceHash: sha256(source),
    validity: "VALID" as const,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
    createdAt: CREATED_AT,
  };
}

function projectState(
  id: string,
  name: string,
  primaryDialect: "POSTGRESQL" | "MYSQL",
): TestProjectState {
  const currentRevision = revision(id);
  return {
    project: {
      id,
      name,
      primaryDialect,
      draftSource: "",
      draftHash: currentRevision.sourceHash,
      lastValidRevisionId: currentRevision.id,
      parserVersion: "9.1.1",
      schemaRevisionNo: 1,
      layoutRevisionNo: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision,
    lastValidRevision: currentRevision,
  };
}

function projectSummary(state: TestProjectState) {
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

async function installProjectApi(page: Page) {
  let projects: TestProjectState[] = [];
  const layoutApis = [createControlledLayoutApi(PROJECT_ID), createControlledLayoutApi(COPY_ID)];
  await page.route("**/api/v1/projects**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    const command = request.postDataJSON() as Record<string, unknown> | null;
    const commandId = typeof command?.commandId === "string" ? command.commandId : undefined;
    const headers = {
      "content-type": "application/json",
      "x-correlation-id": "123e4567-e89b-42d3-a456-426614174000",
      ...(commandId ? { "x-command-id": commandId } : {}),
    };

    for (const layouts of layoutApis) {
      if (await layouts.fulfillIfMatched({ route, pathname, method, command, headers })) return;
    }

    if (method === "GET" && pathname === "/api/v1/projects") {
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ projects: projects.map(projectSummary) }),
      });
      return;
    }

    if (method === "POST" && pathname === "/api/v1/projects" && command?.operation === "CREATE") {
      const state = projectState(
        PROJECT_ID,
        String(command.name),
        command.primaryDialect === "MYSQL" ? "MYSQL" : "POSTGRESQL",
      );
      projects = [state];
      await route.fulfill({
        status: 201,
        headers,
        body: JSON.stringify({ state, diagnostics: [], revisionCreated: true }),
      });
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/v1/projects" &&
      command?.operation === "DUPLICATE"
    ) {
      const original = projects.find((item) => item.project.id === command.sourceProjectId);
      const state = projectState(
        COPY_ID,
        String(command.name),
        original?.project.primaryDialect ?? "POSTGRESQL",
      );
      projects = [state, ...projects];
      await route.fulfill({
        status: 201,
        headers,
        body: JSON.stringify({ state, diagnostics: [], revisionCreated: true }),
      });
      return;
    }

    const projectId = pathname.split("/").at(-1);
    const current = projects.find((item) => item.project.id === projectId);
    if (method === "GET" && current) {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ state: current }) });
      return;
    }
    if (method === "PATCH" && current) {
      const renamed = { ...current, project: { ...current.project, name: String(command?.name) } };
      projects = projects.map((item) => (item.project.id === projectId ? renamed : item));
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ state: renamed }) });
      return;
    }
    if (method === "DELETE" && current) {
      projects = projects.filter((item) => item.project.id !== projectId);
      await route.fulfill({ status: 204, headers, body: "" });
      return;
    }

    await route.fulfill({
      status: 404,
      headers,
      body: JSON.stringify({
        code: "PROJECT_NOT_FOUND",
        message: "Project not found.",
        correlationId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    });
  });
}

test("creates, opens, renames, duplicates, and confirms deletion", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await installProjectApi(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
  await page.getByRole("button", { name: "New project" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create project" });
  await expect(createDialog.getByLabel("Project name")).toBeFocused();
  await createDialog.getByLabel("Project name").fill("Orders");
  await createDialog.getByLabel("Primary dialect").selectOption("MYSQL");
  await createDialog.getByRole("button", { name: "Create project" }).click();

  await expect(page).toHaveURL(`/projects/${PROJECT_ID}`);
  await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible();
  await expect(page.getByText("MySQL project")).toBeVisible();
  await expect(page.getByText("Canonical DBML source")).toBeVisible();
  await expect(page.getByTestId("persistence-status")).toHaveText(/Saved/);
  await expect(
    page.locator('section[aria-label="DBML source editor"] .monaco-editor'),
  ).toBeVisible();
  await expect(page.getByTestId("erd-canvas")).toHaveCount(0);

  await page.getByRole("link", { name: "Back to projects" }).click();
  const ordersCard = page.getByRole("article", { name: "Orders" });
  await ordersCard.getByRole("button", { name: "Rename Orders" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename project" });
  await renameDialog.getByLabel("Project name").fill("Orders schema");
  await renameDialog.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("article", { name: "Orders schema" })).toBeVisible();

  const renamedCard = page.getByRole("article", { name: "Orders schema" });
  await renamedCard.getByRole("button", { name: "Duplicate Orders schema" }).click();
  await page
    .getByRole("dialog", { name: "Duplicate project" })
    .getByRole("button", { name: "Duplicate project" })
    .click();
  await expect(page).toHaveURL(`/projects/${COPY_ID}`);
  await expect(page.getByRole("heading", { name: "Orders schema copy", level: 1 })).toBeVisible();

  await page.getByRole("link", { name: "Back to projects" }).click();
  const copyCard = page.getByRole("article", { name: "Orders schema copy" });
  const deleteTrigger = copyCard.getByRole("button", { name: "Delete Orders schema copy" });
  await deleteTrigger.click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete Orders schema copy?" });
  await expect(deleteDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(deleteDialog.getByText(/portable project export is not available/i)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(deleteDialog).toBeHidden();
  await expect(deleteTrigger).toBeFocused();

  await deleteTrigger.click();
  await page
    .getByRole("dialog", { name: "Delete Orders schema copy?" })
    .getByRole("button", { name: "Delete project" })
    .click();
  await expect(page.getByRole("article", { name: "Orders schema copy" })).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
