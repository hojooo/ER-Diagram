import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, type Page, test } from "./test-fixture.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const IMPORTED_ID = "019d3f4e-7b6c-7abc-8def-0123456789ac";
const REVISION_ID = "019d3f4e-7b6c-7def-9abc-0123456789ab";
const CREATED_AT = "2026-08-31T01:02:03.000Z";
const SOURCE = "Table users { id int [pk] }\n";
const BUNDLE = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x42, 0x55, 0x4e, 0x44, 0x4c, 0x45]);
const BUNDLE_HASH = createHash("sha256").update(BUNDLE).digest("hex");

test("imports a selected portable ZIP as a separately keyed project", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  let uploaded: Buffer | undefined;
  let commandId: string | undefined;
  await installBundleApi(page, {
    onImport(body, receivedCommandId) {
      uploaded = body;
      commandId = receivedCommandId;
    },
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Import bundle" }).click();
  await expect(page.getByRole("heading", { name: "Import project bundle" })).toBeVisible();
  await page.getByLabel("Portable bundle ZIP").setInputFiles({
    name: "portable.erdiagram.zip",
    mimeType: "application/zip",
    buffer: BUNDLE,
  });
  await expect(page.getByText(/Selected portable\.erdiagram\.zip/u)).toBeVisible();
  await page.getByRole("button", { name: "Import as new project" }).click();

  await expect(page).toHaveURL(`/projects/${IMPORTED_ID}`);
  await expect(page.getByRole("heading", { name: "Imported schema", level: 1 })).toBeVisible();
  expect(uploaded).toEqual(BUNDLE);
  expect(commandId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(errors).toEqual([]);
});

test("requires retained-SQL confirmation and verifies the ZIP before download", async ({
  page,
}) => {
  const errors = collectBrowserErrors(page);
  await installBundleApi(page);
  await page.goto(`/projects/${PROJECT_ID}/bundle-export`);

  await expect(page.getByText(/Current revision 2 is invalid/u)).toBeVisible();
  await page.getByLabel("SQL import reports").selectOption("INCLUDE_RETAINED_SQL");
  const downloadButton = page.getByRole("button", { name: "Download portable bundle" });
  await expect(downloadButton).toBeDisabled();
  await page.getByLabel(/retained original SQL may contain sensitive literals/u).check();

  const downloadPromise = page.waitForEvent("download");
  await downloadButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Portable-schema.erdiagram.zip");
  expect(await readFile((await download.path()) as string)).toEqual(BUNDLE);
  await expect(
    page.getByText(`Portable bundle downloaded: ${BUNDLE.byteLength} bytes.`),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

async function installBundleApi(
  page: Page,
  callbacks: {
    readonly onImport?: (body: Buffer, commandId: string) => void;
  } = {},
) {
  const original = projectState(PROJECT_ID, "Portable schema", true);
  const imported = projectState(IMPORTED_ID, "Imported schema", false);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/v1/runtime-config") {
      await route.fallback();
      return;
    }
    const jsonHeaders = {
      "content-type": "application/json",
      "x-correlation-id": "123e4567-e89b-42d3-a456-426614174000",
    };

    if (request.method() === "GET" && pathname === "/api/v1/projects") {
      await route.fulfill({
        status: 200,
        headers: jsonHeaders,
        body: JSON.stringify({ projects: [projectSummary(imported)] }),
      });
      return;
    }
    if (request.method() === "GET" && pathname === `/api/v1/projects/${PROJECT_ID}`) {
      await route.fulfill({
        status: 200,
        headers: jsonHeaders,
        body: JSON.stringify({ state: original }),
      });
      return;
    }
    if (request.method() === "GET" && pathname === `/api/v1/projects/${IMPORTED_ID}`) {
      await route.fulfill({
        status: 200,
        headers: jsonHeaders,
        body: JSON.stringify({ state: imported }),
      });
      return;
    }
    if (request.method() === "GET" && pathname.includes("/layouts/")) {
      await route.fulfill({
        status: 200,
        headers: jsonHeaders,
        body: JSON.stringify({ layout: null, currentLayoutRevisionNo: 0 }),
      });
      return;
    }
    if (request.method() === "POST" && pathname === "/api/v1/project-bundles/import") {
      const receivedCommandId = request.headers()["x-command-id"] ?? "";
      callbacks.onImport?.(request.postDataBuffer() ?? Buffer.alloc(0), receivedCommandId);
      await route.fulfill({
        status: 201,
        headers: { ...jsonHeaders, "x-command-id": receivedCommandId },
        body: JSON.stringify({
          bundleSchemaVersion: 1,
          bundleHash: BUNDLE_HASH,
          state: imported,
          diagnostics: [],
          imported: { revisionCount: 1, layoutCount: 0, reportCount: 0 },
        }),
      });
      return;
    }
    if (
      request.method() === "POST" &&
      pathname === `/api/v1/projects/${PROJECT_ID}/bundle-export`
    ) {
      expect(request.postDataJSON()).toEqual({
        expectedSchemaRevisionNo: 2,
        expectedLayoutRevisionNo: 0,
        reportMode: "INCLUDE_RETAINED_SQL",
      });
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-length": String(BUNDLE.byteLength),
          "x-bundle-sha256": BUNDLE_HASH,
          "x-correlation-id": jsonHeaders["x-correlation-id"],
        },
        body: BUNDLE,
      });
      return;
    }

    await route.fulfill({
      status: 404,
      headers: jsonHeaders,
      body: JSON.stringify({
        code: "PROJECT_NOT_FOUND",
        message: "Project not found.",
        correlationId: jsonHeaders["x-correlation-id"],
      }),
    });
  });
}

function projectState(projectId: string, name: string, invalid: boolean) {
  const valid = revision(projectId, 1, SOURCE, "VALID");
  const current = invalid ? revision(projectId, 2, `${SOURCE}Table broken {`, "INVALID") : valid;
  return {
    project: {
      id: projectId,
      name,
      primaryDialect: "POSTGRESQL",
      draftSource: current.source,
      draftHash: current.sourceHash,
      lastValidRevisionId: valid.id,
      parserVersion: "9.1.1",
      schemaRevisionNo: current.revisionNo,
      layoutRevisionNo: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision: current,
    lastValidRevision: valid,
  };
}

function revision(
  projectId: string,
  revisionNo: number,
  source: string,
  validity: "VALID" | "INVALID",
) {
  return {
    id: revisionNo === 1 ? REVISION_ID : "019d3f4e-7b6c-7eee-8abc-0123456789ab",
    projectId,
    revisionNo,
    source,
    sourceHash: createHash("sha256").update(source).digest("hex"),
    validity,
    origin: "SOURCE_EDIT",
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

function projectSummary(state: ReturnType<typeof projectState>) {
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

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
