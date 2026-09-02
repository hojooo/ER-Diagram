#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  generateFidelityFixture,
  P0_ACCEPTANCE_PROFILE_HASH,
  p0AcceptanceProfile,
  sha256FixtureSource,
} from "@er-diagram/test-fixtures";
import { chromium } from "@playwright/test";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const suffix = `${process.pid}${Date.now().toString(36)}`.toLowerCase();
const image = "er-diagram:local";
const applicationAlias = "er-diagram-p0-application";
const applicationA = `erdiagram-p0-a-${suffix}`;
const applicationB = `erdiagram-p0-b-${suffix}`;
const applicationBRestart = `erdiagram-p0-b-restart-${suffix}`;
const proxyName = `erdiagram-p0-proxy-${suffix}`;
const internalNetwork = `erdiagram-p0-internal-${suffix}`;
const ingressNetwork = `erdiagram-p0-ingress-${suffix}`;
const volumeA = `erdiagram-p0-data-a-${suffix}`;
const volumeB = `erdiagram-p0-data-b-${suffix}`;
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "er-diagram-p0-"));
const bundleFilename = path.join(temporaryDirectory, "p0.erdiagram.zip");
const source = generateFidelityFixture();
const invalidSource = `${source}${p0AcceptanceProfile.journey.invalidSuffix}`;
const sourceEdited = `${source}${p0AcceptanceProfile.journey.sourceEditSuffix}`;
const sourceAfterRedoInvalidation = `${sourceEdited}// p0-redo-invalidation-sentinel\n`;
const modifier = process.platform === "darwin" ? "Meta" : "Control";
let baseUrl;
let browser;

const evidence = new Map(
  p0AcceptanceProfile.journey.assertions.map((assertionId) => [assertionId, false]),
);

try {
  assertProfileAndWorkflowWiring();
  await ensureImage();
  await createRuntimeResources();
  await startProxy();
  baseUrl = await resolveProxyUrl();

  await startApplication(applicationA, volumeA);
  await waitForReady();
  await assertApplicationHasNoOutboundConnectivity(applicationA);
  await assertRuntimeIdentityAndHeaders();

  browser = await chromium.launch({ headless: true });
  const volumeAEvidence = await exerciseVolumeA(browser);
  const logsA = await capture("docker", ["logs", applicationA]);
  assertRedactedLogs(logsA);
  await stopApplication(applicationA);

  await startApplication(applicationB, volumeB);
  await waitForReady();
  await assertApplicationHasNoOutboundConnectivity(applicationB);
  const importedProjectId = await restoreIntoVolumeB(browser, volumeAEvidence);
  const logsB = await capture("docker", ["logs", applicationB]);
  assertRedactedLogs(logsB);
  await stopApplication(applicationB);

  await startApplication(applicationBRestart, volumeB);
  await waitForReady();
  await assertRestoredState(importedProjectId, volumeAEvidence);
  pass("BUNDLE_VOLUME_B_RESTART");
  const logsBRestart = await capture("docker", ["logs", applicationBRestart]);
  assertRedactedLogs(logsBRestart);

  assert.deepEqual(
    [...evidence.entries()].filter(([, passed]) => !passed).map(([assertionId]) => assertionId),
    [],
    "Every versioned P0 assertion must pass",
  );
  process.stdout.write(
    `${JSON.stringify({
      profileVersion: p0AcceptanceProfile.profileVersion,
      profileHash: P0_ACCEPTANCE_PROFILE_HASH,
      releaseState: p0AcceptanceProfile.releaseState,
      assertions: [...evidence.keys()],
    })}\n`,
  );
} finally {
  await browser?.close().catch(() => undefined);
  for (const container of [applicationA, applicationB, applicationBRestart, proxyName]) {
    await run("docker", ["rm", "--force", container], { allowFailure: true, quiet: true });
  }
  for (const network of [internalNetwork, ingressNetwork]) {
    await run("docker", ["network", "rm", network], { allowFailure: true, quiet: true });
  }
  for (const volume of [volumeA, volumeB]) {
    await run("docker", ["volume", "rm", volume], { allowFailure: true, quiet: true });
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function assertProfileAndWorkflowWiring() {
  assert.equal(sha256FixtureSource(source), p0AcceptanceProfile.fixture.sourceHash);
  assert.equal(Buffer.byteLength(source, "utf8"), p0AcceptanceProfile.fixture.utf8Bytes);

  const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(typeof packageJson.scripts?.["test:p0-gate"], "string");
  const ci = readFileSync(path.join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  const release = readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const ciRunCommands = new Set(
    [...ci.matchAll(/^\s*run:\s+([^|\n].*)$/gmu)].map((match) => match[1].trim()),
  );
  for (const command of [
    "pnpm test:e2e",
    "pnpm test:e2e:security",
    "pnpm test:accessibility",
    "pnpm test:container",
    "pnpm test:runtime-lifecycle",
    "pnpm test:m1-gate",
    "pnpm test:m2-gate",
    "pnpm test:m3-gate",
    "pnpm test:p0-gate",
    "pnpm test:perf",
  ]) {
    assert.ok(
      !ciRunCommands.has(command),
      `CI must not execute explicit acceptance command ${command}`,
    );
  }
  assert.ok(
    release.includes("run: pnpm test:p0-gate"),
    "Release validation must execute the complete P0 gate",
  );

  for (const { commands } of p0AcceptanceProfile.releaseGates) {
    for (const command of commands) {
      const scriptName = command.replace(/^pnpm /u, "").split(" ")[0];
      if (scriptName === "ci:verify" || scriptName.includes(":")) {
        assert.equal(
          typeof packageJson.scripts?.[scriptName],
          "string",
          `Missing release-gate script ${scriptName}`,
        );
      }
    }
  }
}

async function createRuntimeResources() {
  await run("docker", ["network", "create", "--internal", internalNetwork], { quiet: true });
  await run("docker", ["network", "create", ingressNetwork], { quiet: true });
  await run("docker", ["volume", "create", volumeA], { quiet: true });
  await run("docker", ["volume", "create", volumeB], { quiet: true });
}

async function ensureImage() {
  await run("docker", ["compose", "build", "er-diagram"]);
}

async function startApplication(name, volume) {
  await run(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      internalNetwork,
      "--network-alias",
      applicationAlias,
      "--memory",
      "2g",
      "--pids-limit",
      "128",
      "--init",
      "--stop-signal",
      "SIGTERM",
      "--stop-timeout",
      "35",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--volume",
      `${volume}:/data`,
      image,
    ],
    { quiet: true },
  );
}

async function stopApplication(name) {
  await run("docker", ["stop", "--timeout", "35", name], { quiet: true });
  await run("docker", ["rm", name], { quiet: true });
}

async function startProxy() {
  const proxySource = `
    import { createServer, request } from "node:http";
    const server = createServer((incoming, outgoing) => {
      const upstream = request({
        hostname: "${applicationAlias}",
        port: 8080,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      }, (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      });
      upstream.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(503, { "content-type": "text/plain" });
        outgoing.end("unavailable");
      });
      incoming.pipe(upstream);
    });
    server.listen(8080, "0.0.0.0");
  `;
  await run(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      proxyName,
      "--network",
      ingressNetwork,
      "--publish",
      "127.0.0.1::8080",
      "--entrypoint",
      "node",
      image,
      "--input-type=module",
      "-e",
      proxySource,
    ],
    { quiet: true },
  );
  await run("docker", ["network", "connect", internalNetwork, proxyName], { quiet: true });
}

async function resolveProxyUrl() {
  const published = (await capture("docker", ["port", proxyName, "8080/tcp"])).trim();
  assert.match(published, /^127\.0\.0\.1:[0-9]+$/u);
  return `http://${published}`;
}

async function waitForReady() {
  await waitFor(async () => {
    try {
      return (await fetch(`${baseUrl}/health/ready`)).status === 200;
    } catch {
      return false;
    }
  }, 60_000);
}

async function assertRuntimeIdentityAndHeaders() {
  const runtime = await fetchJson(`${baseUrl}/api/v1/runtime-config`);
  assert.equal(runtime.response.status, 200);
  assert.equal(runtime.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(runtime.body.release, {
    channel: "DEVELOPMENT",
    version: "development",
    sourceRevision: null,
    imageReference: null,
    parserVersion: "9.1.1",
    bundleSchemaVersion: 1,
  });
  const html = await fetch(`${baseUrl}/`, { headers: { accept: "text/html" } });
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-security-policy") ?? "", /script-src 'self'/u);
  assert.equal(html.headers.get("cache-control"), "no-store");
  pass("RUNTIME_RELEASE_AND_SECURITY");
}

async function assertApplicationHasNoOutboundConnectivity(container) {
  const probe = `
    import net from "node:net";
    const namedBlocked = await fetch("http://example.com", {
      signal: AbortSignal.timeout(1500),
    }).then(() => false, () => true);
    const literalBlocked = await new Promise((resolve) => {
      const socket = net.connect({ host: "1.1.1.1", port: 80 });
      const finish = (blocked) => { socket.destroy(); resolve(blocked); };
      socket.once("connect", () => finish(false));
      socket.once("error", () => finish(true));
      socket.setTimeout(1500, () => finish(true));
    });
    if (!namedBlocked || !literalBlocked) process.exit(1);
  `;
  await run("docker", ["exec", container, "node", "--input-type=module", "-e", probe]);
}

async function exerciseVolumeA(activeBrowser) {
  const context = await activeBrowser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);
  const remoteOrigins = collectRemoteOrigins(page);

  const projectId = await createProjectThroughUi(page);
  await waitForWorkspace(page);
  const persistedViewKey = await assertLargeFixtureExploration(page);
  await assertLayoutDoesNotChangeSource(page, projectId);
  const historyEvidence = await assertEditingAndHistory(page, projectId);
  const sqlEvidence = await assertSqlExport(page, projectId);
  const bundleEvidence = await exportBundle(page, projectId, persistedViewKey);

  assert.deepEqual(remoteOrigins, []);
  assertNoBrowserErrors(browserErrors);
  pass("OFFLINE_NO_REMOTE_REQUESTS");
  await context.close();
  return {
    projectId,
    sqlEvidence,
    ...historyEvidence,
    ...bundleEvidence,
  };
}

async function createProjectThroughUi(page) {
  await page.goto(baseUrl);
  await page.getByRole("heading", { name: "No projects yet" }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "Create project" });
  await dialog.getByLabel("Project name").fill(p0AcceptanceProfile.journey.projectName);
  await dialog.getByLabel("Primary dialect").selectOption("POSTGRESQL");
  await dialog.getByLabel("DBML file").check();
  await dialog.getByLabel("Choose DBML file").setInputFiles({
    name: "p0-fidelity.dbml",
    mimeType: "text/plain",
    buffer: Buffer.from(source, "utf8"),
  });
  const submit = dialog.getByRole("button", { name: "Create project" });
  await waitFor(() => submit.isEnabled(), 10_000);
  await submit.click();
  await page.waitForURL(/\/projects\/[0-9a-f-]+$/u, { timeout: 60_000 });
  const projectId = new URL(page.url()).pathname.split("/").at(-1);
  assert.match(projectId ?? "", /^[0-9a-f-]{36}$/u);
  const state = await getProject(projectId);
  assert.ok(state.project.draftSource === source, "Created source bytes must match the fixture");
  assert.equal(state.project.draftHash, p0AcceptanceProfile.fixture.sourceHash);
  assert.equal(state.currentRevision.validity, "VALID");
  return projectId;
}

async function waitForWorkspace(page) {
  await page.locator('section[aria-label="DBML source editor"] .monaco-editor').waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await page.getByRole("region", { name: "Schema outline" }).waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await waitForLayoutReady(page);
}

async function assertLargeFixtureExploration(page) {
  const outline = page.getByRole("region", { name: "Schema outline" });
  await outline
    .getByText("143 tables · 15 groups · 573 relationships", { exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });

  const viewSelector = page.getByRole("combobox", { name: "Diagram view" });
  assert.equal(await viewSelector.locator("option").count(), 8);
  for (const viewName of p0AcceptanceProfile.journey.viewNames) {
    await viewSelector.selectOption({ label: viewName });
    await waitForLayoutReady(page);
    await outline
      .getByRole("heading", { name: `Schema outline · ${viewName}` })
      .waitFor({ state: "visible", timeout: 20_000 });
  }

  await viewSelector.selectOption({ label: "focus_01" });
  await waitForLayoutReady(page);
  const persistedViewKey = await viewSelector.inputValue();
  assert.match(persistedViewKey, /^view:/u);
  const detail = page.getByRole("combobox", { name: "Detail level" });
  await detail.selectOption("NAME_ONLY");
  await waitForLayoutReady(page);
  await detail.selectOption("FULL");
  await waitForLayoutReady(page);
  await viewSelector.selectOption("GLOBAL");
  await waitForLayoutReady(page);

  for (const groupName of p0AcceptanceProfile.journey.groupNames) {
    await outline.locator(`button[aria-label="Collapse ${groupName} in diagram"]`).click({
      timeout: 15_000,
    });
  }
  for (const groupName of p0AcceptanceProfile.journey.groupNames) {
    await outline.locator(`button[aria-label="Expand ${groupName} in diagram"]`).waitFor({
      state: "visible",
      timeout: 15_000,
    });
  }
  await waitForLayoutReady(page);
  for (const groupName of p0AcceptanceProfile.journey.groupNames) {
    await outline.locator(`button[aria-label="Expand ${groupName} in diagram"]`).click({
      timeout: 15_000,
    });
  }
  await waitForLayoutReady(page);

  await selectTable(page, "entity_142", "core.entity_142");
  pass("DIAGRAM_GROUPS_AND_VIEWS");
  return persistedViewKey;
}

async function assertLayoutDoesNotChangeSource(page, projectId) {
  const before = await getProject(projectId);
  const tableNode = page.locator('.react-flow__node-table[data-id*="entity_142"]').first();
  await tableNode.waitFor({ state: "visible", timeout: 30_000 });
  const positionBeforeDrag = await tableNode.getAttribute("style");
  const dragHandle = tableNode.locator(".diagram-table__drag-handle");
  await dragHandle.scrollIntoViewIfNeeded();
  const box = await dragHandle.boundingBox();
  assert.ok(box, "Selected table must have a draggable header");
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 48, startY + 32, { steps: 8 });
  await page.mouse.up();
  await waitFor(async () => (await tableNode.getAttribute("style")) !== positionBeforeDrag, 20_000);
  await waitFor(
    async () =>
      (await getProject(projectId)).project.layoutRevisionNo > before.project.layoutRevisionNo,
    20_000,
  );
  const after = await getProject(projectId);
  assert.equal(after.project.draftHash, before.project.draftHash);
  assert.equal(after.project.schemaRevisionNo, before.project.schemaRevisionNo);
  pass("DIAGRAM_LAYOUT_SOURCE_HASH_UNCHANGED");
}

async function assertEditingAndHistory(page, projectId) {
  const editor = page.getByRole("textbox", { name: "DBML source editor" });
  const initial = await getProject(projectId);

  await replaceEditorSource(editor, invalidSource);
  const invalid = await waitForSource(
    projectId,
    invalidSource,
    initial.project.schemaRevisionNo + 1,
  );
  assert.equal(invalid.currentRevision.validity, "INVALID");
  await page
    .getByText(/Showing last-valid revision/u)
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.reload();
  await waitForWorkspace(page);
  await page
    .getByText(/Showing last-valid revision/u)
    .waitFor({ state: "visible", timeout: 30_000 });

  await replaceEditorSource(editor, source);
  const recovered = await waitForSource(projectId, source, invalid.project.schemaRevisionNo + 1);
  assert.equal(recovered.currentRevision.validity, "VALID");
  await page.getByText(/Showing the current valid draft/u).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  pass("SOURCE_INVALID_LAST_VALID_RECOVERY");

  await replaceEditorSource(editor, sourceEdited);
  const sourceStep = await waitForSource(
    projectId,
    sourceEdited,
    recovered.project.schemaRevisionNo + 1,
  );
  assert.equal(sourceStep.currentRevision.origin, "SOURCE_EDIT");

  await selectTable(page, "entity_142", p0AcceptanceProfile.journey.visualTarget.tableName);
  await page.getByRole("button", { name: "Create column" }).click();
  await page.getByLabel("Column name").fill(p0AcceptanceProfile.journey.visualTarget.columnName);
  await page
    .getByLabel("DBML column type")
    .fill(p0AcceptanceProfile.journey.visualTarget.columnType);
  await page.getByRole("button", { name: "Apply command" }).click();
  const visual = await waitForProjectRevision(projectId, sourceStep.project.schemaRevisionNo + 1);
  assert.equal(visual.currentRevision.origin, "VISUAL_COMMAND");
  assert.ok(
    visual.project.draftSource.includes(p0AcceptanceProfile.journey.visualTarget.columnName),
    "Visual command must add the marker column",
  );
  assertOnlyTargetTableChanged(sourceEdited, visual.project.draftSource);
  for (const sentinel of p0AcceptanceProfile.journey.preservationSentinels) {
    assert.ok(
      visual.project.draftSource.includes(sentinel),
      "Source-preservation sentinel missing",
    );
  }
  pass("VISUAL_TARGET_ONLY_SOURCE_PATCH");

  const sourceAfterVisual = visual.project.draftSource;
  const undo = page.getByRole("button", { name: /Undo schema change/u });
  const redo = page.getByRole("button", { name: /Redo schema change/u });
  await undo.click();
  await waitForSource(projectId, sourceEdited);
  await undo.click();
  await waitForSource(projectId, source);
  await redo.click();
  await waitForSource(projectId, sourceEdited);
  await redo.click();
  await waitForSource(projectId, sourceAfterVisual);

  await undo.click();
  await waitForSource(projectId, sourceEdited);
  const layoutBefore = (await getProject(projectId)).project.layoutRevisionNo;
  const detail = page.getByRole("combobox", { name: "Detail level" });
  await detail.selectOption("NAME_ONLY");
  await waitFor(
    async () => (await getProject(projectId)).project.layoutRevisionNo > layoutBefore,
    20_000,
  );
  assert.equal(await redo.isEnabled(), true);
  await redo.click();
  await waitForSource(projectId, sourceAfterVisual);

  await undo.click();
  await waitForSource(projectId, sourceEdited);
  await waitFor(async () => redo.isEnabled(), 20_000);
  await replaceEditorSource(editor, sourceAfterRedoInvalidation);
  const forward = await waitForSource(projectId, sourceAfterRedoInvalidation);
  assert.equal(await redo.isDisabled(), true);
  pass("HISTORY_UNDO_REDO");

  await page.getByRole("button", { name: "Revision history" }).click();
  const history = page.getByRole("dialog", { name: "Revision history" });
  const invalidRow = history.getByRole("article", { name: "Revision 2", exact: true });
  await invalidRow.getByRole("button", { name: "Restore revision 2", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Restore revision 2?" });
  await confirmation.getByRole("button", { name: "Restore revision 2", exact: true }).click();
  const restoredInvalid = await waitForProjectRevision(
    projectId,
    forward.project.schemaRevisionNo + 1,
  );
  assert.equal(restoredInvalid.currentRevision.validity, "INVALID");
  assert.equal(restoredInvalid.currentRevision.origin, "RESTORE");
  await history.getByRole("button", { name: "Close history" }).click();
  await page
    .getByText(/Showing last-valid revision/u)
    .waitFor({ state: "visible", timeout: 30_000 });
  await undo.click();
  const restoredValid = await waitForSource(projectId, sourceAfterRedoInvalidation);
  assert.equal(restoredValid.currentRevision.validity, "VALID");
  pass("HISTORY_INVALID_RESTORE");

  await page.reload();
  await waitForWorkspace(page);
  assert.equal(await page.getByRole("button", { name: /Undo schema change/u }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: /Redo schema change/u }).isDisabled(), true);
  await page.getByRole("button", { name: "Revision history" }).click();
  const durableHistory = page.getByRole("dialog", { name: "Revision history" });
  const durableRevisions = await getRevisions(projectId);
  const restoreRevision = durableRevisions.find((revision) => revision.origin === "RESTORE");
  assert.ok(restoreRevision, "Durable revision history must retain the RESTORE checkpoint");
  const restoreArticle = durableHistory.getByRole("article", {
    name: `Revision ${restoreRevision.revisionNo}`,
    exact: true,
  });
  await restoreArticle.waitFor({
    state: "visible",
    timeout: 20_000,
  });
  assert.ok(
    ((await restoreArticle.textContent()) ?? "").includes("INVALID · RESTORE"),
    "Durable History must display the restored invalid revision origin",
  );
  assert.equal((await durableHistory.textContent())?.includes(sourceAfterRedoInvalidation), false);
  await durableHistory.getByRole("button", { name: "Close history" }).click();
  pass("HISTORY_RELOAD_IS_DURABLE");

  return {
    currentState: await getProject(projectId),
    revisions: await getRevisions(projectId),
  };
}

async function assertSqlExport(page, projectId) {
  await page.goto(`${baseUrl}/projects/${projectId}/sql-export`);
  await page.getByRole("button", { name: "Generate SQL export" }).click();
  await page.getByText(/Export report ready:/u).waitFor({ state: "visible", timeout: 60_000 });

  const reportDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download report JSON" }).click();
  const reportDownload = await reportDownloadPromise;
  const reportPath = await reportDownload.path();
  assert.ok(reportPath, "SQL report download must have a local path");
  const reportDownloadJson = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(reportDownloadJson.report.semanticVerification.status, "VERIFIED");
  assert.equal(reportDownloadJson.report.containsDataStatements, false);

  const acknowledgement = page.getByLabel(/I reviewed the partial or unsupported conversions/u);
  if (await acknowledgement.count()) await acknowledgement.check();
  const sqlDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download SQL" }).click();
  const sqlDownload = await sqlDownloadPromise;
  const sqlPath = await sqlDownload.path();
  assert.ok(sqlPath, "SQL download must have a local path");
  const sql = readFileSync(sqlPath, "utf8");
  assert.ok(
    sql.startsWith("-- Generated by DBML·SQL ERD Studio as empty-schema create DDL."),
    "Generated SQL must include the empty-schema header",
  );

  const preview = await fetchJson(`${baseUrl}/api/v1/sql-import/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commandId: randomUUID(),
      dialect: "POSTGRESQL",
      source: sql,
      originalSqlRetention: "DISCARD",
    }),
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.previewStatus, "PREVIEWED");
  assert.equal(preview.body.report.semanticVerification.status, "VERIFIED");
  assert.equal(preview.body.report.sourceHash, sha256(sql));
  assert.deepEqual(
    preview.body.report.statements.filter(({ kind }) => kind === "DML" || kind === "COPY"),
    [],
    "Generated SQL must not contain data statements",
  );
  pass("SQL_EXPORT_REPARSE_AND_REPORT");
  return { sqlHash: sha256(sql), reportHash: sha256(JSON.stringify(reportDownloadJson)) };
}

async function exportBundle(page, projectId, persistedViewKey) {
  const currentState = await getProject(projectId);
  const revisions = await getRevisions(projectId);
  const globalLayout = await getLayout(projectId, "GLOBAL");
  const persistedViewLayout = await getLayout(projectId, persistedViewKey);

  await page.goto(`${baseUrl}/projects/${projectId}/bundle-export`);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/v1/projects/${projectId}/bundle-export`,
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download portable bundle" }).click();
  const [response, download] = await Promise.all([responsePromise, downloadPromise]);
  const downloadPath = await download.path();
  assert.ok(downloadPath, "Bundle download must have a local path");
  const archive = readFileSync(downloadPath);
  const archiveHash = sha256(archive);
  assert.equal(response.status(), 200);
  assert.equal(response.headers()["x-bundle-sha256"], archiveHash);
  writeFileSync(bundleFilename, archive, { mode: 0o600 });
  await page.getByText(/Portable bundle downloaded:/u).waitFor({
    state: "visible",
    timeout: 30_000,
  });

  return {
    bundleHash: archiveHash,
    bundleBytes: archive.length,
    currentState,
    revisions,
    layouts: [globalLayout, persistedViewLayout],
  };
}

async function restoreIntoVolumeB(activeBrowser, expected) {
  const context = await activeBrowser.newContext();
  const page = await context.newPage();
  const browserErrors = collectBrowserErrors(page);
  const remoteOrigins = collectRemoteOrigins(page);
  await page.goto(`${baseUrl}/project-bundles/import`);
  await page.getByLabel("Portable bundle ZIP").setInputFiles(bundleFilename);
  await page.getByRole("button", { name: "Import as new project" }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]+$/u, { timeout: 90_000 });
  const importedProjectId = new URL(page.url()).pathname.split("/").at(-1);
  assert.match(importedProjectId ?? "", /^[0-9a-f-]{36}$/u);
  assert.notEqual(importedProjectId, expected.projectId);
  await waitForWorkspace(page);
  await assertRestoredState(importedProjectId, expected);
  assert.deepEqual(remoteOrigins, []);
  assertNoBrowserErrors(browserErrors);
  pass("BUNDLE_NEW_PROJECT_ID");
  pass("BUNDLE_SOURCE_HISTORY_LAYOUT");
  await context.close();
  return importedProjectId;
}

async function assertRestoredState(projectId, expected) {
  const current = await getProject(projectId);
  assert.ok(
    current.project.draftSource === expected.currentState.project.draftSource,
    "Imported current source bytes must match",
  );
  assert.equal(current.project.draftHash, expected.currentState.project.draftHash);
  assert.equal(current.project.primaryDialect, "POSTGRESQL");
  assert.equal(current.currentRevision.validity, expected.currentState.currentRevision.validity);
  assert.equal(
    current.lastValidRevision?.revisionNo ?? null,
    expected.currentState.lastValidRevision?.revisionNo ?? null,
  );
  const revisions = await getRevisions(projectId);
  assert.deepEqual(revisions.map(revisionEvidence), expected.revisions.map(revisionEvidence));

  for (const expectedLayout of expected.layouts) {
    const restoredLayout = await getLayout(projectId, expectedLayout.layout.viewKey);
    assert.deepEqual(layoutEvidence(restoredLayout), layoutEvidence(expectedLayout));
  }
}

async function selectTable(page, query, qualifiedName) {
  const search = page.getByRole("combobox", { name: "Search current view" });
  await search.fill(query);
  const option = page.getByRole("option", { name: `table ${qualifiedName}`, exact: true });
  await option.waitFor({ state: "visible", timeout: 20_000 });
  await option.click();
  await page.getByText(`Selected table ${qualifiedName}`, { exact: true }).waitFor({
    state: "visible",
    timeout: 20_000,
  });
}

async function replaceEditorSource(editor, nextSource) {
  await editor.focus();
  await editor.press(`${modifier}+a`);
  await editor.evaluate((element, pastedSource) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pastedSource);
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    );
  }, nextSource);
  await editor.page().waitForTimeout(800);
}

async function waitForSource(projectId, expectedSource, minimumRevisionNo = 0) {
  let state;
  await waitFor(async () => {
    state = await getProject(projectId);
    return (
      state.project.schemaRevisionNo >= minimumRevisionNo &&
      state.project.draftHash === sha256(expectedSource) &&
      state.project.draftSource === expectedSource
    );
  }, 60_000);
  return state;
}

async function waitForProjectRevision(projectId, minimumRevisionNo) {
  let state;
  await waitFor(async () => {
    state = await getProject(projectId);
    return state.project.schemaRevisionNo >= minimumRevisionNo;
  }, 60_000);
  return state;
}

async function waitForLayoutReady(page) {
  const status = page.getByTestId("base-diagram-layout-status");
  await status.waitFor({ state: "visible", timeout: 60_000 });
  await waitFor(async () => (await status.textContent()) === "Diagram layout ready", 60_000);
}

async function getProject(projectId) {
  const result = await fetchJson(`${baseUrl}/api/v1/projects/${projectId}`);
  assert.equal(result.response.status, 200);
  return result.body.state;
}

async function getRevisions(projectId) {
  const result = await fetchJson(`${baseUrl}/api/v1/projects/${projectId}/revisions`);
  assert.equal(result.response.status, 200);
  return result.body.revisions;
}

async function getLayout(projectId, viewKey) {
  const result = await fetchJson(
    `${baseUrl}/api/v1/projects/${projectId}/layouts/${encodeURIComponent(viewKey)}`,
  );
  assert.equal(result.response.status, 200);
  assert.ok(result.body.layout, `Expected persisted layout for ${viewKey}`);
  return result.body;
}

function revisionEvidence(revision) {
  return {
    revisionNo: revision.revisionNo,
    sourceHash: revision.sourceHash,
    validity: revision.validity,
    origin: revision.origin,
    parserVersion: revision.parserVersion,
    diagnosticSummary: revision.diagnosticSummary,
    createdAt: revision.createdAt,
  };
}

function layoutEvidence(response) {
  return {
    currentLayoutRevisionNo: response.currentLayoutRevisionNo,
    layout: response.layout
      ? {
          viewKey: response.layout.viewKey,
          revisionNo: response.layout.revisionNo,
          positions: response.layout.positions,
          collapsedGroupKeys: response.layout.collapsedGroupKeys,
          hiddenElementKeys: response.layout.hiddenElementKeys,
          viewport: response.layout.viewport,
          detailLevel: response.layout.detailLevel,
          baseSchemaHash: response.layout.baseSchemaHash,
        }
      : null,
  };
}

function assertOnlyTargetTableChanged(before, after) {
  const beforeSpan = findTableBlock(before, p0AcceptanceProfile.journey.visualTarget.tableName);
  const afterSpan = findTableBlock(after, p0AcceptanceProfile.journey.visualTarget.tableName);
  assert.ok(beforeSpan && afterSpan, "Visual target table block must be locatable");
  assert.equal(before.slice(0, beforeSpan.start), after.slice(0, afterSpan.start));
  assert.equal(before.slice(beforeSpan.end), after.slice(afterSpan.end));
}

function findTableBlock(dbml, qualifiedName) {
  const declaration = `Table ${qualifiedName}`;
  const start = dbml.indexOf(declaration);
  if (start < 0) return null;
  const openingBrace = dbml.indexOf("{", start + declaration.length);
  if (openingBrace < 0) return null;
  let depth = 0;
  let quote = null;
  for (let index = openingBrace; index < dbml.length; index += 1) {
    const character = dbml[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1 };
    }
  }
  return null;
}

function collectBrowserErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function collectRemoteOrigins(page) {
  const origins = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    const origin = new URL(url).origin;
    if (origin !== baseUrl) origins.push(origin);
  });
  return origins;
}

function assertNoBrowserErrors(errors) {
  assert.equal(errors.length, 0, "Browser console and page errors must be empty");
}

function assertRedactedLogs(logs) {
  for (const sentinel of [
    ...p0AcceptanceProfile.journey.preservationSentinels,
    p0AcceptanceProfile.journey.visualTarget.columnName,
    "p0-source-edit-sentinel",
    "p0-redo-invalidation-sentinel",
  ]) {
    assert.equal(logs.includes(sentinel), false, "Operational logs must redact source evidence");
  }
  assert.equal(logs.includes("native SQLite"), false);
  assert.equal(logs.includes("/data/er-diagram.sqlite"), false);
}

function pass(assertionId) {
  assert.equal(evidence.has(assertionId), true, `Unknown P0 assertion ${assertionId}`);
  evidence.set(assertionId, true);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  return { response, body: await response.json() };
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function capture(command, args) {
  return run(command, args, { capture: true, quiet: true });
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : options.quiet ? "ignore" : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0 || options.allowFailure) {
        resolveRun(stdout);
        return;
      }
      rejectRun(
        new Error(`${command} ${args.join(" ")} failed with exit ${code}: ${stderr.trim()}`),
      );
    });
  });
}
