#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const suffix = `${process.pid}${Date.now().toString(36)}`.toLowerCase();
const image = "er-diagram:local";
const applicationName = `erdiagram-runtime-app-${suffix}`;
const replacementName = `erdiagram-runtime-replacement-${suffix}`;
const crashReplacementName = `erdiagram-runtime-crash-${suffix}`;
const proxyName = `erdiagram-runtime-proxy-${suffix}`;
const internalNetwork = `erdiagram-runtime-internal-${suffix}`;
const ingressNetwork = `erdiagram-runtime-ingress-${suffix}`;
const dataVolume = `erdiagram-runtime-data-${suffix}`;
const applicationAlias = "er-diagram-application";
const sourceSentinel = `offline-runtime-source-${randomUUID()}`;
const originalSource = `// ${sourceSentinel}\nTable public.runtime_accounts {\n  id bigint [pk]\n}\n`;
const browserSavedSource = originalSource.replace(
  "  id bigint [pk]\n",
  "  id bigint [pk]\n  runtime_name varchar\n",
);
const updatedSource = `${browserSavedSource}\nTable public.runtime_events {\n  id bigint [pk]\n}\n`;
let browser;
let baseUrl;

try {
  await ensureImage();
  await assertShutdownTimeoutFallback();
  await run("docker", ["network", "create", "--internal", internalNetwork]);
  await run("docker", ["network", "create", ingressNetwork]);
  await run("docker", ["volume", "create", dataVolume]);

  await startApplication(applicationName);
  await startProxy();
  baseUrl = await resolveProxyUrl();
  await waitForReady();
  await assertApplicationHasNoOutboundConnectivity(applicationName);

  const project = await createProject();
  browser = await chromium.launch({ headless: true });
  await assertOfflineBrowserRuntime(browser, project.id);
  await browser.close();
  browser = undefined;

  const slowSave = startSlowDraftSave(project.id);
  await slowSave.firstChunk;
  await run("docker", ["kill", "--signal", "SIGTERM", applicationName]);
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/health/ready`).catch(() => null);
    return response?.status !== 200;
  }, 5_000);
  const slowSaveResult = await slowSave.completed;
  const exitCode = (await capture("docker", ["wait", applicationName])).trim();
  assert.equal(exitCode, "0", "The first SIGTERM must finish with a clean exit");
  const gracefulLogs = await capture("docker", ["logs", applicationName]);
  assert.match(gracefulLogs, /"state":"SHUTTING_DOWN"/u);
  assert.match(gracefulLogs, /"state":"STOPPED"/u);
  assertRedactedLogs(gracefulLogs);
  await run("docker", ["rm", applicationName]);

  await startApplication(replacementName);
  await waitForReady();
  await assertDraftTransaction(project.id, slowSaveResult);

  await run("docker", ["kill", "--signal", "SIGKILL", replacementName]);
  assert.equal((await capture("docker", ["wait", replacementName])).trim(), "137");
  await run("docker", ["rm", replacementName]);
  await startApplication(crashReplacementName);
  await waitForReady();
  const recovered = await fetchJson(`${baseUrl}/api/v1/projects/${project.id}`);
  assert.equal(recovered.response.status, 200, "A crash must release the volume lease");

  process.stdout.write("Production lifecycle and offline runtime acceptance passed.\n");
} finally {
  await browser?.close().catch(() => undefined);
  for (const container of [applicationName, replacementName, crashReplacementName, proxyName]) {
    await run("docker", ["rm", "--force", container], { allowFailure: true, quiet: true });
  }
  for (const network of [internalNetwork, ingressNetwork]) {
    await run("docker", ["network", "rm", network], { allowFailure: true, quiet: true });
  }
  await run("docker", ["volume", "rm", dataVolume], { allowFailure: true, quiet: true });
}

async function ensureImage() {
  await run("docker", ["compose", "build", "er-diagram"]);
}

async function startApplication(name) {
  await run("docker", [
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
    `${dataVolume}:/data`,
    image,
  ]);
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
  await run("docker", [
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
  ]);
  await run("docker", ["network", "connect", internalNetwork, proxyName]);
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
  }, 45_000);
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
  const inspect = JSON.parse(
    await capture("docker", [
      "inspect",
      container,
      "--format",
      "{{json .NetworkSettings.Networks}}",
    ]),
  );
  assert.deepEqual(Object.keys(inspect), [internalNetwork]);
}

async function createProject() {
  const commandId = randomUUID();
  const created = await fetchJson(`${baseUrl}/api/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: "CREATE",
      commandId,
      name: "Offline runtime acceptance",
      primaryDialect: "POSTGRESQL",
      source: originalSource,
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.response.headers.get("x-command-id"), commandId);
  return { id: created.body.state.project.id };
}

async function assertOfflineBrowserRuntime(activeBrowser, projectId) {
  const page = await activeBrowser.newPage();
  const errors = [];
  const remoteOrigins = [];
  const workerAssets = new Set();
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("blob:") || url.startsWith("data:")) return;
    const parsed = new URL(url);
    if (parsed.origin !== baseUrl) remoteOrigins.push(parsed.origin);
    if (/parser\.worker-|layout\.worker-|elk-worker/u.test(parsed.pathname)) {
      workerAssets.add(parsed.pathname);
    }
  });
  await page.goto(`${baseUrl}/projects/${projectId}`);
  await page.locator('section[aria-label="DBML source editor"] .monaco-editor').waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.getByRole("region", { name: "Schema outline" }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await waitFor(
    async () =>
      (await page.getByTestId("base-diagram-layout-status").textContent()) ===
      "Diagram layout ready",
    30_000,
  );
  const previewAutoLayout = page.getByRole("button", { name: "Preview auto layout" });
  await previewAutoLayout.click();
  await page.getByText("Auto-layout preview ready").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Cancel preview" }).click();
  await previewAutoLayout.waitFor({ state: "visible", timeout: 30_000 });
  assert.ok([...workerAssets].some((asset) => asset.includes("parser.worker-")));
  assert.ok(
    [...workerAssets].some(
      (asset) => asset.includes("layout.worker-") || asset.includes("elk-worker"),
    ),
  );
  assert.deepEqual(remoteOrigins, []);
  assert.deepEqual(errors, []);

  const input = page.getByRole("textbox", { name: "DBML source editor" });
  await input.focus();
  await input.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await input.evaluate((element, source) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", source);
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    );
  }, browserSavedSource);
  await waitFor(async () => {
    const state = await fetchJson(`${baseUrl}/api/v1/projects/${projectId}`);
    return (
      state.response.status === 200 &&
      state.body.state.project.schemaRevisionNo === 2 &&
      state.body.state.project.draftSource === browserSavedSource
    );
  }, 15_000);
  await page.reload();
  await page.locator('section[aria-label="DBML source editor"] .monaco-editor').waitFor({
    state: "visible",
    timeout: 30_000,
  });
  const outline = page.getByRole("region", { name: "Schema outline" });
  const table = outline.locator("details").filter({ hasText: "runtime_accounts" }).first();
  if (!(await table.getAttribute("open"))) await table.locator("summary").click();
  await table.getByText("runtime_name", { exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.close();
}

function startSlowDraftSave(projectId) {
  const payload = JSON.stringify({
    commandId: randomUUID(),
    source: updatedSource,
    expectedSchemaRevisionNo: 2,
  });
  const script = `
    import { request } from "node:http";
    const body = ${JSON.stringify(payload)};
    const split = Math.floor(body.length / 2);
    const response = await new Promise((resolve, reject) => {
      const outgoing = request({
        hostname: "${applicationAlias}",
        port: 8080,
        path: ${JSON.stringify(`/api/v1/projects/${projectId}/draft`)},
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      }, (incoming) => {
        let responseBody = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => { responseBody += chunk; });
        incoming.on("end", () => resolve({ status: incoming.statusCode, body: responseBody }));
      });
      outgoing.on("error", reject);
      outgoing.write(body.slice(0, split), () => {
        process.stdout.write("FIRST_CHUNK_SENT\\n");
        setTimeout(() => outgoing.end(body.slice(split)), 750);
      });
    });
    process.stdout.write(JSON.stringify(response) + "\\n");
  `;
  const child = spawn("docker", ["exec", proxyName, "node", "--input-type=module", "-e", script], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let firstChunkResolve;
  let firstChunkReject;
  const firstChunk = new Promise((resolveFirst, rejectFirst) => {
    firstChunkResolve = resolveFirst;
    firstChunkReject = rejectFirst;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("FIRST_CHUNK_SENT\n")) firstChunkResolve();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("error", firstChunkReject);
  const completed = new Promise((resolveComplete, rejectComplete) => {
    child.once("exit", (code) => {
      if (code !== 0) {
        rejectComplete(new Error(`Slow draft request failed with exit ${code}: ${stderr.trim()}`));
        return;
      }
      const line = stdout.trim().split("\n").at(-1);
      resolveComplete(JSON.parse(line ?? "null"));
    });
  });
  return { firstChunk, completed };
}

async function assertDraftTransaction(projectId, slowSaveResult) {
  const state = await fetchJson(`${baseUrl}/api/v1/projects/${projectId}`);
  assert.equal(state.response.status, 200);
  const revisions = await fetchJson(`${baseUrl}/api/v1/projects/${projectId}/revisions`);
  assert.equal(revisions.response.status, 200);
  assert.ok([200, 503].includes(slowSaveResult.status));
  const committed = state.body.state.project.draftSource === updatedSource;
  const rolledBack = state.body.state.project.draftSource === browserSavedSource;
  assert.ok(committed || rolledBack, "Shutdown must leave a complete old or new draft source");
  assert.equal(state.body.state.project.schemaRevisionNo, committed ? 3 : 2);
  assert.equal(revisions.body.revisions[0].revisionNo, committed ? 3 : 2);
  assert.ok(
    revisions.body.revisions.every((revision) => revision.sourceHash.length === 64),
    "Shutdown must not persist a partial revision",
  );
}

async function assertShutdownTimeoutFallback() {
  const script = `
    import { installProductionSignalHandlers } from "./apps/server/dist/production-entrypoint.js";
    const runtime = { shutdown: () => new Promise(() => undefined) };
    installProductionSignalHandlers(runtime, 50);
    setInterval(() => undefined, 1000);
    process.stdout.write("READY\\n");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  await waitForChildOutput(child, "READY\n", 5_000);
  child.kill("SIGTERM");
  const exitCode = await waitForChildExit(child, 5_000);
  assert.equal(exitCode, 1, "A graceful shutdown timeout must fail closed");
}

function assertRedactedLogs(logs) {
  assert.ok(!logs.includes(sourceSentinel));
  assert.ok(!logs.includes(originalSource));
  assert.ok(!logs.includes(updatedSource));
  assert.ok(!logs.includes("/data/er-diagram.sqlite"));
  assert.ok(!logs.includes("native SQLite"));
  assert.ok(!logs.includes("ER_DIAGRAM_"));
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

function waitForChildOutput(child, expected, timeoutMs) {
  return new Promise((resolveOutput, rejectOutput) => {
    let output = "";
    const timeout = setTimeout(() => rejectOutput(new Error("Child output timed out")), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes(expected)) return;
      clearTimeout(timeout);
      resolveOutput();
    });
    child.once("error", rejectOutput);
    child.once("exit", (code) => {
      if (!output.includes(expected)) rejectOutput(new Error(`Child exited early: ${code}`));
    });
  });
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("Child exit timed out"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
    child.once("error", rejectExit);
  });
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
