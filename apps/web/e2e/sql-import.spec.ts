import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

import { createControlledLayoutApi } from "./controlled-layout-api.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const REVISION_1_ID = "019d3f4e-7b6c-7def-9abc-0123456789ab";
const REVISION_2_ID = "019d3f4e-7b6c-7eee-8abc-0123456789ab";
const ARTIFACT_ID = "019d3f4e-7b6c-7fff-8abc-0123456789ab";
const CREATED_AT = "2026-08-28T01:02:03.000Z";
const CANDIDATE_DBML = "Table users {\n  id bigint [pk]\n}\n";
const REPLACEMENT_DBML = "Table accounts {\n  id bigint [pk]\n}\n";
const POSTGRESQL_SQL = "CREATE TABLE users (id bigint PRIMARY KEY);\nINSERT INTO users VALUES (1);";
const MYSQL_SQL =
  "CREATE TABLE accounts (id bigint PRIMARY KEY);\nINSERT INTO accounts VALUES (1);";

test("previews a PostgreSQL file and atomically creates revision 1 only on apply", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);
  const api = await installSqlImportApi(page, null);

  await page.goto("/");
  await page.getByRole("link", { name: "Start SQL import" }).click();
  await expect(page).toHaveURL("/sql-import/new");
  await page.getByLabel("Project name").fill("Imported schema");
  await page.getByLabel("Choose SQL file").setInputFiles({
    name: "schema.sql",
    mimeType: "text/plain",
    buffer: Buffer.from(POSTGRESQL_SQL, "utf8"),
  });
  await expect(page.getByLabel("SQL source")).toHaveValue(POSTGRESQL_SQL);
  await page.getByRole("button", { name: "Preview import" }).click();

  await expect(page.getByRole("heading", { name: "Review SQL import" })).toBeVisible();
  expect(api.createCalls()).toBe(0);
  await page.getByLabel("Status filter").selectOption("PARTIAL");
  await expect(page.getByRole("button", { name: /SQL_PARTIAL_CREATE_TABLE/ })).toBeVisible();
  await page.getByRole("button", { name: /SQL_PARTIAL_CREATE_TABLE/ }).click();
  await expect(page.getByLabel("SQL source")).toBeFocused();
  await expect
    .poll(() =>
      page.getByLabel("SQL source").evaluate((element) => ({
        start: (element as HTMLTextAreaElement).selectionStart,
        end: (element as HTMLTextAreaElement).selectionEnd,
      })),
    )
    .toEqual({ start: 0, end: 44 });
  await page.getByLabel("Status filter").selectOption("ALL");
  await page.getByLabel("I understand the reported schema conversion losses").check();
  await page.getByLabel("I confirm row data statements will be excluded").check();
  await page.getByRole("button", { name: "Apply import" }).click();

  await expect(page).toHaveURL(`/projects/${PROJECT_ID}`);
  await expect(page.getByRole("heading", { name: "Imported schema", level: 1 })).toBeVisible();
  await expect(page.getByText("Revision 1 · Parser 9.1.1")).toBeVisible();
  expect(api.createCalls()).toBe(1);
  expect(api.currentState()?.currentRevision.origin).toBe("SQL_IMPORT");
  expect(browserErrors).toEqual([]);
});

test("cancels a MySQL replace without mutation, then repreviews and applies", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  const initial = state("Existing MySQL", "MYSQL", CANDIDATE_DBML, 1, "SOURCE_EDIT");
  const api = await installSqlImportApi(page, initial);

  await page.goto(`/projects/${PROJECT_ID}`);
  await expect(page.getByTestId("persistence-status")).toHaveText(/Saved/);
  await page.getByRole("link", { name: "Import SQL" }).click();
  await expect(page).toHaveURL(`/projects/${PROJECT_ID}/sql-import`);
  await expect(page.getByLabel("SQL dialect")).toHaveValue("MYSQL");
  await expect(page.getByLabel("SQL dialect")).toBeDisabled();
  await page.getByLabel("SQL source").fill(MYSQL_SQL);
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByRole("heading", { name: "Review SQL import" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel import" }).click();

  await expect(page).toHaveURL(`/projects/${PROJECT_ID}`);
  expect(api.currentState()?.project.schemaRevisionNo).toBe(1);
  expect(api.applyCalls()).toBe(0);

  await page.getByRole("link", { name: "Import SQL" }).click();
  await page.getByLabel("SQL source").fill(MYSQL_SQL);
  await page.getByRole("button", { name: "Preview import" }).click();
  await page.getByLabel("I understand the reported schema conversion losses").check();
  await page.getByLabel("I confirm row data statements will be excluded").check();
  await page.getByRole("button", { name: "Apply import" }).click();

  await expect(page).toHaveURL(`/projects/${PROJECT_ID}`);
  await expect(page.getByText("Revision 2 · Parser 9.1.1")).toBeVisible();
  expect(api.applyCalls()).toBe(1);
  expect(api.currentState()?.project.draftSource).toBe(REPLACEMENT_DBML);
  expect(browserErrors).toEqual([]);
});

interface ControlledState {
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

async function installSqlImportApi(page: Page, initial: ControlledState | null) {
  let current = initial;
  let createCallCount = 0;
  let applyCallCount = 0;
  const layoutApi = createControlledLayoutApi(PROJECT_ID);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postDataJSON() as Record<string, unknown> | null;
    const commandId = typeof body?.commandId === "string" ? body.commandId : undefined;
    const headers = {
      "content-type": "application/json",
      "x-correlation-id": "123e4567-e89b-42d3-a456-426614174000",
      ...(commandId ? { "x-command-id": commandId } : {}),
    };

    if (await layoutApi.fulfillIfMatched({ route, pathname, method, command: body, headers })) {
      return;
    }
    if (method === "GET" && pathname === "/api/v1/projects") {
      await fulfill(route, 200, { projects: current ? [summary(current)] : [] }, headers);
      return;
    }
    if (method === "GET" && pathname === `/api/v1/projects/${PROJECT_ID}` && current) {
      await fulfill(route, 200, { state: current }, headers);
      return;
    }
    if (method === "POST" && pathname === "/api/v1/sql-import/preview") {
      const source = String(body?.source ?? "");
      const dialect = body?.dialect === "MYSQL" ? "MYSQL" : "POSTGRESQL";
      await fulfill(
        route,
        200,
        standalonePreview(source, dialect, CANDIDATE_DBML, "c".repeat(64)),
        headers,
      );
      return;
    }
    if (
      method === "POST" &&
      pathname === "/api/v1/projects" &&
      body?.operation === "CREATE_FROM_SQL_IMPORT"
    ) {
      createCallCount += 1;
      current = state(String(body.name), "POSTGRESQL", CANDIDATE_DBML, 1, "SQL_IMPORT");
      await fulfill(route, 201, applyResponse(current, "c".repeat(64)), headers);
      return;
    }
    if (method === "POST" && pathname === `/api/v1/projects/${PROJECT_ID}/sql-import/preview`) {
      const source = String(body?.source ?? "");
      await fulfill(
        route,
        200,
        {
          artifactId: ARTIFACT_ID,
          artifactStatus: "PREVIEWED",
          createdAt: CREATED_AT,
          baseSchemaRevisionNo: current?.project.schemaRevisionNo ?? 1,
          ...standalonePreview(source, "MYSQL", REPLACEMENT_DBML, "d".repeat(64), true),
        },
        headers,
      );
      return;
    }
    if (
      method === "POST" &&
      pathname === `/api/v1/projects/${PROJECT_ID}/sql-import/apply` &&
      current
    ) {
      applyCallCount += 1;
      current = state(
        current.project.name,
        current.project.primaryDialect,
        REPLACEMENT_DBML,
        2,
        "SQL_IMPORT",
      );
      await fulfill(route, 200, applyResponse(current, "d".repeat(64)), headers);
      return;
    }
    await fulfill(
      route,
      404,
      {
        code: "PROJECT_NOT_FOUND",
        message: "Project not found.",
        correlationId: headers["x-correlation-id"],
      },
      headers,
    );
  });
  return {
    createCalls: () => createCallCount,
    applyCalls: () => applyCallCount,
    currentState: () => current,
  };
}

function standalonePreview(
  source: string,
  dialect: "POSTGRESQL" | "MYSQL",
  candidate: string,
  previewHash: string,
  replace = false,
) {
  const candidateHash = sha256(candidate);
  const createEnd = dialect === "POSTGRESQL" ? 44 : 47;
  const report = {
    reportVersion: 1,
    dialect,
    sourceFilepath: "/import.sql",
    sourceHash: sha256(source),
    parserInputHash: sha256(source),
    parserVersions: { dbmlCore: "9.1.1", dbmlParse: "9.1.1" },
    capabilityMatrixVersion: 1,
    schemaSemanticsVersion: 1,
    overallStatus: "PARTIAL",
    applyEligible: false,
    candidateDbmlHash: candidateHash,
    statements: [
      {
        statementNo: 1,
        kind: "CREATE_TABLE",
        capabilityId: "CREATE_TABLE",
        status: "PARTIAL",
        code: "SQL_PARTIAL_CREATE_TABLE",
        message: "Some table clauses are not preserved.",
        range: sourceRange(0, createEnd, 1, 1, 1, createEnd + 1),
        clauses: [],
      },
      {
        statementNo: 2,
        kind: "DML",
        capabilityId: "DML",
        status: "UNSUPPORTED",
        code: "SQL_UNSUPPORTED_DATA_STATEMENT",
        message: "Row data is excluded from schema import.",
        range: sourceRange(createEnd + 1, source.length, 2, 1, 2, 31),
        clauses: [],
      },
    ],
    diagnostics: [],
    semanticVerification: {
      status: "VERIFIED",
      sourceModelHash: candidateHash,
      candidateSchemaHash: candidateHash,
      changes: [],
    },
  };
  return {
    ...(replace ? {} : { previewStatus: "PREVIEWED" }),
    previewHash,
    originalSqlRetention: "DISCARD",
    report,
    policy: {
      policyVersion: 1,
      dataStatementNos: [2],
      dataHandling: "CONFIRMATION_REQUIRED",
      applyReadiness: "DATA_EXCLUSION_CONFIRMATION_REQUIRED",
    },
    candidate: { dbml: candidate, dbmlHash: candidateHash },
  };
}

function applyResponse(current: ControlledState, previewHash: string) {
  return {
    artifactId: ARTIFACT_ID,
    artifactStatus: "APPLIED",
    previewHash,
    appliedAt: CREATED_AT,
    policy: {
      policyVersion: 1,
      dataStatementNos: [2],
      dataHandling: "CONFIRMED_DDL_ONLY",
      applyReadiness: "READY",
    },
    state: current,
    diagnostics: [],
    revisionCreated: true,
  };
}

function state(
  name: string,
  dialect: "POSTGRESQL" | "MYSQL",
  source: string,
  revisionNo: number,
  origin: "SOURCE_EDIT" | "SQL_IMPORT",
): ControlledState {
  const currentRevision = revision(source, revisionNo, origin);
  return {
    project: {
      id: PROJECT_ID,
      name,
      primaryDialect: dialect,
      draftSource: source,
      draftHash: currentRevision.sourceHash,
      lastValidRevisionId: currentRevision.id,
      parserVersion: "9.1.1",
      schemaRevisionNo: revisionNo,
      layoutRevisionNo: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision,
    lastValidRevision: currentRevision,
  };
}

function revision(source: string, revisionNo: number, origin: "SOURCE_EDIT" | "SQL_IMPORT") {
  return {
    id: revisionNo === 1 ? REVISION_1_ID : REVISION_2_ID,
    projectId: PROJECT_ID,
    revisionNo,
    source,
    sourceHash: sha256(source),
    validity: "VALID" as const,
    origin,
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
    createdAt: CREATED_AT,
  };
}

function summary(current: ControlledState) {
  return {
    id: current.project.id,
    name: current.project.name,
    primaryDialect: current.project.primaryDialect,
    parserVersion: current.project.parserVersion,
    schemaRevisionNo: current.project.schemaRevisionNo,
    layoutRevisionNo: current.project.layoutRevisionNo,
    draftValidity: current.currentRevision.validity,
    diagnosticSummary: current.currentRevision.diagnosticSummary,
    createdAt: current.project.createdAt,
    updatedAt: current.project.updatedAt,
  };
}

function sourceRange(
  startOffset: number,
  endOffset: number,
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
) {
  return {
    filepath: "/import.sql",
    startOffset,
    endOffset,
    startLine,
    startColumn,
    endLine,
    endColumn,
  };
}

async function fulfill(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  status: number,
  body: unknown,
  headers: Record<string, string>,
) {
  await route.fulfill({ status, headers, body: JSON.stringify(body) });
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
