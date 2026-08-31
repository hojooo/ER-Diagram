import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "./test-fixture.js";
import {
  computeSqlImportCreatePreviewHash,
  computeSqlImportPreviewHash,
  convertDbmlToSqlExport,
  convertSqlImport,
  evaluateSqlImportDataPolicy,
  type SqlImportConversionResult,
} from "@er-diagram/core";
import {
  type SqlInterchangeGateFixture,
  sqlInterchangeGateFixtures,
} from "@er-diagram/test-fixtures";

import { createControlledLayoutApi } from "./controlled-layout-api.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const REVISION_1_ID = "019d3f4e-7b6c-7def-9abc-0123456789ab";
const REVISION_2_ID = "019d3f4e-7b6c-7eee-8abc-0123456789ab";
const ARTIFACT_ID = "019d3f4e-7b6c-7fff-8abc-0123456789ab";
const CREATED_AT = "2026-08-29T01:02:03.000Z";
const INITIAL_MYSQL_SOURCE = "Table legacy { id bigint [pk] }\n";

test("M2-GATE creates PostgreSQL from reported DDL-only import and downloads verified SQL", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const fixture = gateFixture("POSTGRESQL");
  const browserErrors = collectBrowserErrors(page);
  const api = await installMilestoneTwoApi(page, null);

  await page.goto("/sql-import/new");
  await page.getByLabel("Project name").fill("PostgreSQL M2 gate");
  await page.getByLabel("SQL source").fill(fixture.source);
  await page.getByRole("button", { name: "Preview import" }).click();

  await verifyImportAcknowledgements(page, "SQL_PARTIAL_IDENTITY");
  expect(api.createCalls()).toBe(0);
  await page.getByRole("button", { name: "Apply import" }).click();

  await expect(page).toHaveURL(`/projects/${PROJECT_ID}`);
  await expect(page.getByText("Revision 1 · Parser 9.1.1")).toBeVisible();
  expect(api.createCalls()).toBe(1);
  expect(api.currentState()?.currentRevision.origin).toBe("SQL_IMPORT");
  await verifyExportDownload(page, fixture);
  expect(browserErrors).toEqual([]);
});

test("M2-GATE replaces MySQL only after independent loss and data acknowledgements", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const fixture = gateFixture("MYSQL");
  const browserErrors = collectBrowserErrors(page);
  const initial = state("MySQL M2 gate", "MYSQL", INITIAL_MYSQL_SOURCE, 1, "SOURCE_EDIT");
  const api = await installMilestoneTwoApi(page, initial);

  await page.goto(`/projects/${PROJECT_ID}`);
  await expect(page.getByTestId("persistence-status")).toHaveText(/Saved/u);
  await page.getByRole("link", { name: "Import SQL" }).click();
  await page.getByLabel("SQL source").fill(fixture.source);
  await page.getByRole("button", { name: "Preview import" }).click();

  await verifyImportAcknowledgements(page, "SQL_PARTIAL_MYSQL_TABLE_OPTIONS");
  expect(api.applyCalls()).toBe(0);
  expect(api.currentState()?.project.schemaRevisionNo).toBe(1);
  await page.getByRole("button", { name: "Apply import" }).click();

  await expect(page).toHaveURL(`/projects/${PROJECT_ID}`);
  await expect(page.getByText("Revision 2 · Parser 9.1.1")).toBeVisible();
  expect(api.applyCalls()).toBe(1);
  expect(api.currentState()?.currentRevision.origin).toBe("SQL_IMPORT");
  await verifyExportDownload(page, fixture);
  expect(browserErrors).toEqual([]);
});

async function verifyImportAcknowledgements(page: Page, partialCode: string): Promise<void> {
  await expect(page.getByRole("heading", { name: "Review SQL import" })).toBeVisible();
  const apply = page.getByRole("button", { name: "Apply import" });
  await expect(apply).toBeDisabled();

  await page.getByLabel("Status filter").selectOption("PARTIAL");
  await expect(
    page.getByRole("button", { name: new RegExp(partialCode, "u") }).first(),
  ).toBeVisible();
  await page.getByLabel("Status filter").selectOption("UNSUPPORTED");
  await expect(
    page.getByRole("button", { name: /SQL_UNSUPPORTED_DATA_STATEMENT/u }).first(),
  ).toBeVisible();
  await page.getByLabel("Status filter").selectOption("ALL");

  await page.getByLabel("I understand the reported schema conversion losses").check();
  await expect(apply).toBeDisabled();
  await page.getByLabel("I confirm row data statements will be excluded").check();
  await expect(apply).toBeEnabled();
}

async function verifyExportDownload(page: Page, fixture: SqlInterchangeGateFixture): Promise<void> {
  await page.goto(`/projects/${PROJECT_ID}/sql-export`);
  await page.getByRole("button", { name: "Generate SQL export" }).click();
  await expect(
    page.getByText(`Export report ready: ${fixture.expectedExportOverallStatus}.`),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Download SQL" })).toBeDisabled();

  const reportDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download report JSON" }).click();
  const reportDownload = await reportDownloadPromise;
  const reportPath = await reportDownload.path();
  const reportText = await readFile(reportPath as string, "utf8");
  const reportDownloadValue = JSON.parse(reportText) as {
    report: { entries: Array<{ code: string }>; generatedSqlHash: string };
  };
  expect(reportDownloadValue.report.entries.map(({ code }) => code)).toEqual(
    fixture.expectedExportEntryCodes,
  );
  expect(reportDownloadValue.report.generatedSqlHash).toBe(fixture.expectedGeneratedSqlHash);
  expect(reportText).not.toContain(fixture.rowSentinel);

  await page.getByLabel(/I reviewed the partial or unsupported conversions/u).check();
  const sqlDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download SQL" }).click();
  const sqlDownload = await sqlDownloadPromise;
  const sql = await readFile((await sqlDownload.path()) as string, "utf8");
  expect(sql).toMatch(/^-- Generated by DBML·SQL ERD Studio as empty-schema create DDL\./u);
  expect(sha256(sql)).toBe(fixture.expectedGeneratedSqlHash);
  expect(sql).not.toContain(fixture.rowSentinel);

  const reimported = await convertSqlImport({ dialect: fixture.dialect, source: sql });
  expect(reimported.ok).toBe(true);
  expect(
    reimported.report.statements.filter(({ kind }) => kind === "DML" || kind === "COPY"),
  ).toEqual([]);
}

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

interface PreparedPreview {
  readonly conversion: SqlImportConversionResult;
  readonly previewHash: string;
  readonly response: Record<string, unknown>;
}

async function installMilestoneTwoApi(page: Page, initial: ControlledState | null) {
  let current = initial;
  let createCallCount = 0;
  let applyCallCount = 0;
  let standalonePreview: PreparedPreview | null = null;
  let replacePreview: PreparedPreview | null = null;
  const layoutApi = createControlledLayoutApi(PROJECT_ID);

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "GET" && pathname === "/api/v1/runtime-config") {
      await route.fallback();
      return;
    }
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
      standalonePreview = await prepareStandalonePreview(
        body?.dialect === "MYSQL" ? "MYSQL" : "POSTGRESQL",
        String(body?.source ?? ""),
      );
      await fulfill(route, 200, standalonePreview.response, headers);
      return;
    }
    if (
      method === "POST" &&
      pathname === "/api/v1/projects" &&
      body?.operation === "CREATE_FROM_SQL_IMPORT" &&
      standalonePreview?.conversion.ok
    ) {
      createCallCount += 1;
      current = state(
        String(body.name),
        body.primaryDialect === "MYSQL" ? "MYSQL" : "POSTGRESQL",
        standalonePreview.conversion.candidate.dbml,
        1,
        "SQL_IMPORT",
      );
      await fulfill(
        route,
        201,
        applyResponse(current, standalonePreview, String(body.previewHash)),
        headers,
      );
      return;
    }
    if (
      method === "POST" &&
      pathname === `/api/v1/projects/${PROJECT_ID}/sql-import/preview` &&
      current
    ) {
      replacePreview = await prepareReplacePreview(
        current,
        String(body?.source ?? ""),
        current.project.primaryDialect,
      );
      await fulfill(route, 200, replacePreview.response, headers);
      return;
    }
    if (
      method === "POST" &&
      pathname === `/api/v1/projects/${PROJECT_ID}/sql-import/apply` &&
      current &&
      replacePreview?.conversion.ok
    ) {
      applyCallCount += 1;
      current = state(
        current.project.name,
        current.project.primaryDialect,
        replacePreview.conversion.candidate.dbml,
        current.project.schemaRevisionNo + 1,
        "SQL_IMPORT",
      );
      await fulfill(
        route,
        200,
        applyResponse(current, replacePreview, String(body?.previewHash)),
        headers,
      );
      return;
    }
    if (method === "POST" && pathname === `/api/v1/projects/${PROJECT_ID}/sql-export` && current) {
      const exported = await convertDbmlToSqlExport({
        primaryDialect: current.project.primaryDialect,
        targetDialect: current.project.primaryDialect,
        source: current.project.draftSource,
      });
      await fulfill(
        route,
        200,
        {
          sourceSelection: "CURRENT_DRAFT",
          revisionNo: current.currentRevision.revisionNo,
          sourceHash: current.project.draftHash,
          report: exported.report,
          candidate: exported.candidate,
        },
        headers,
      );
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

async function prepareStandalonePreview(
  dialect: "POSTGRESQL" | "MYSQL",
  source: string,
): Promise<PreparedPreview> {
  const conversion = await convertSqlImport({ dialect, source });
  const policy = evaluateSqlImportDataPolicy(conversion);
  const previewHash = await computeSqlImportCreatePreviewHash({
    evidence: {
      dialect,
      sourceHash: conversion.report.sourceHash,
      candidateDbmlHash: conversion.ok ? conversion.candidate.dbmlHash : null,
      report: conversion.report,
    },
    previewPolicy: policy,
    originalSqlRetention: "DISCARD",
  });
  return {
    conversion,
    previewHash,
    response: {
      previewStatus: conversion.ok ? "PREVIEWED" : "FAILED",
      previewHash,
      originalSqlRetention: "DISCARD",
      report: conversion.report,
      policy,
      candidate: conversion.ok
        ? { dbml: conversion.candidate.dbml, dbmlHash: conversion.candidate.dbmlHash }
        : null,
    },
  };
}

async function prepareReplacePreview(
  current: ControlledState,
  source: string,
  dialect: "POSTGRESQL" | "MYSQL",
): Promise<PreparedPreview> {
  const conversion = await convertSqlImport({ dialect, source });
  const policy = evaluateSqlImportDataPolicy(conversion);
  const previewHash = await computeSqlImportPreviewHash({
    evidence: {
      projectId: current.project.id,
      baseSchemaRevisionNo: current.project.schemaRevisionNo,
      dialect,
      sourceHash: conversion.report.sourceHash,
      candidateDbmlHash: conversion.ok ? conversion.candidate.dbmlHash : null,
      report: conversion.report,
    },
    previewPolicy: policy,
    originalSqlRetention: "DISCARD",
  });
  return {
    conversion,
    previewHash,
    response: {
      artifactId: ARTIFACT_ID,
      artifactStatus: conversion.ok ? "PREVIEWED" : "FAILED",
      createdAt: CREATED_AT,
      baseSchemaRevisionNo: current.project.schemaRevisionNo,
      previewHash,
      originalSqlRetention: "DISCARD",
      report: conversion.report,
      policy,
      candidate: conversion.ok
        ? { dbml: conversion.candidate.dbml, dbmlHash: conversion.candidate.dbmlHash }
        : null,
    },
  };
}

function applyResponse(current: ControlledState, preview: PreparedPreview, previewHash: string) {
  return {
    artifactId: ARTIFACT_ID,
    artifactStatus: "APPLIED",
    previewHash,
    appliedAt: CREATED_AT,
    policy: evaluateSqlImportDataPolicy(preview.conversion, "CONFIRM_DDL_ONLY"),
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

function gateFixture(dialect: "POSTGRESQL" | "MYSQL"): SqlInterchangeGateFixture {
  const fixture = sqlInterchangeGateFixtures.find((candidate) => candidate.dialect === dialect);
  if (!fixture) throw new Error(`Missing ${dialect} M2 gate fixture.`);
  return fixture;
}

async function fulfill(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  status: number,
  body: unknown,
  headers: Record<string, string>,
): Promise<void> {
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
