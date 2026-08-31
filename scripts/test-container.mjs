#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const composeProject = `erdiagramm4005${process.pid}${Date.now().toString(36)}`.toLowerCase();
const service = "er-diagram";
const image = "er-diagram:local";
const baseUrl = "http://127.0.0.1:8080";
const sentinel = `container-source-sentinel-${randomUUID()}`;
const source = `// ${sentinel}\nTable public.container_accounts {\n  id bigint [pk]\n}\n`;
let browser;

try {
  const composeConfig = JSON.parse(
    await capture("docker", composeArgs("config", "--format", "json")),
  );
  assertComposeConfig(composeConfig);

  await run("docker", composeArgs("build", service));
  await assertImageRuntime();

  await run("docker", composeArgs("up", "--detach", "--no-build"));
  await waitForLiveServer();
  const firstContainerId = (await capture("docker", composeArgs("ps", "--quiet", service))).trim();
  assert.notEqual(firstContainerId, "", "Compose must create the application container");
  await assertContainerRuntime(firstContainerId);

  const project = await assertHttpRuntime();
  browser = await chromium.launch({ headless: true });
  await assertBrowserRuntime(browser, project.id);
  await browser.close();
  browser = undefined;

  const logs = await capture("docker", composeArgs("logs", "--no-color"));
  assert.ok(!logs.includes(sentinel), "Operational logs must not contain canonical source text");
  assert.ok(!logs.includes("native SQLite"), "Operational logs must not contain native errors");

  await run("docker", composeArgs("down", "--remove-orphans"));
  await run("docker", composeArgs("up", "--detach", "--no-build"));
  await waitForLiveServer();
  const replacementContainerId = (
    await capture("docker", composeArgs("ps", "--quiet", service))
  ).trim();
  assert.notEqual(replacementContainerId, firstContainerId, "Compose must replace the container");

  const restored = await fetchJson(`${baseUrl}/api/v1/projects/${project.id}`);
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.state.project.id, project.id);
  assert.equal(restored.body.state.project.draftSource, source);

  process.stdout.write("Container acceptance passed.\n");
} finally {
  await browser?.close().catch(() => undefined);
  await run("docker", composeArgs("down", "--volumes", "--remove-orphans"), {
    allowFailure: true,
    quiet: true,
  });
}

function composeArgs(...args) {
  return ["compose", "-p", composeProject, ...args];
}

function assertComposeConfig(config) {
  const application = config.services?.[service];
  assert.ok(application, "Compose must define the er-diagram service");
  assert.equal(application.image, image);
  assert.equal(application.mem_limit, "2147483648");
  assert.equal(application.pids_limit, 128);
  assert.equal(application.init, true);
  assert.equal(application.restart, "unless-stopped");
  assert.deepEqual(application.cap_drop, ["ALL"]);
  assert.deepEqual(application.security_opt, ["no-new-privileges:true"]);
  assert.deepEqual(application.ports, [
    {
      mode: "ingress",
      host_ip: "127.0.0.1",
      target: 8080,
      published: "8080",
      protocol: "tcp",
    },
  ]);
  assert.deepEqual(
    application.volumes.map(({ type, target }) => ({ type, target })),
    [{ type: "volume", target: "/data" }],
  );
}

async function assertImageRuntime() {
  const config = JSON.parse(
    await capture("docker", ["image", "inspect", image, "--format", "{{json .Config}}"]),
  );
  assert.equal(config.User, "node");
  assert.equal(config.WorkingDir, "/app/server");
  assert.deepEqual(config.Cmd, ["node", "dist/production-entrypoint.js"]);
  assert.ok(config.Env.includes("NODE_VERSION=24.14.0"));
  assert.ok(config.Env.includes("NODE_ENV=production"));
  assert.deepEqual(config.ExposedPorts, { "8080/tcp": {} });

  const probe = `
    import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
    const required = [
      "/app/server/dist/resource-worker.js",
      "/app/web/index.html",
      "/app/LICENSE",
      "/app/NOTICE",
      "/app/THIRD_PARTY_NOTICES.md",
    ];
    for (const filename of required) {
      if (!existsSync(filename)) throw new Error("required runtime file is missing");
    }
    const forbidden = [
      "/app/server/src",
      "/app/server/test",
      "/app/server/node_modules/typescript",
      "/app/server/node_modules/vitest",
      "/app/server/node_modules/@playwright",
      "/app/server/node_modules/playwright-core",
      "/app/server/node_modules/@types",
      "/app/server/node_modules/@er-diagram/contracts/src",
      "/app/server/node_modules/@er-diagram/core/src",
      "/app/server/node_modules/@er-diagram/source-transform/src",
      "/app/server/node_modules/@er-diagram/storage-sqlite/src",
    ];
    for (const filename of forbidden) {
      if (existsSync(filename)) throw new Error("development file leaked into runtime");
    }
    let applicationWritable = true;
    try { accessSync("/app/server", constants.W_OK); } catch { applicationWritable = false; }
    accessSync("/data", constants.W_OK);
    const applicationOwner = statSync("/app/server").uid;
    const dataOwner = statSync("/data").uid;
    const migrationDirectory =
      "/app/server/node_modules/@er-diagram/storage-sqlite/drizzle";
    const migrations = readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql"));
    const storagePackage = await import("@er-diagram/storage-sqlite");
    const storage = storagePackage.openSqliteStorage({ filename: "/data/runtime-smoke.sqlite" });
    storage.close();
    const serverPackage = await import("/app/server/dist/index.js");
    const executor = serverPackage.createResourceExecutor({
      operationalLogSink: serverPackage.NOOP_OPERATIONAL_LOG_SINK,
    });
    try {
      const parsed = await executor.parseDbml(
        "Table public.container_smoke { id int [pk] }",
        "/main.dbml",
      );
      if (!parsed.ok || parsed.graph.tables.length !== 1) {
        throw new Error("packaged resource worker failed");
      }
    } finally {
      await executor.close();
    }
    console.log(JSON.stringify({
      nodeVersion: process.version,
      uid: process.getuid?.(),
      applicationWritable,
      applicationOwner,
      dataOwner,
      migrationCount: migrations.length,
    }));
  `;
  const result = JSON.parse(
    await capture("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      image,
      "--input-type=module",
      "-e",
      probe,
    ]),
  );
  assert.deepEqual(result, {
    nodeVersion: "v24.14.0",
    uid: 1000,
    applicationWritable: false,
    applicationOwner: 0,
    dataOwner: 1000,
    migrationCount: 2,
  });
}

async function assertContainerRuntime(containerId) {
  const inspect = JSON.parse(
    await capture("docker", ["inspect", containerId, "--format", "{{json .}}"]),
  );
  assert.equal(inspect.Config.User, "node");
  assert.equal(inspect.HostConfig.Memory, 2 * 1024 * 1024 * 1024);
  assert.equal(inspect.HostConfig.PidsLimit, 128);
  assert.deepEqual(inspect.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(inspect.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
  assert.equal(inspect.HostConfig.Init, true);
  assert.deepEqual(inspect.HostConfig.PortBindings["8080/tcp"], [
    { HostIp: "127.0.0.1", HostPort: "8080" },
  ]);
}

async function assertHttpRuntime() {
  const root = await fetch(`${baseUrl}/`, { headers: { accept: "text/html" } });
  assert.equal(root.status, 200);
  assert.equal(root.headers.get("cache-control"), "no-store");
  const csp = root.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self'/u);
  assert.ok(!csp.includes("'unsafe-eval'"));
  const html = await root.text();
  const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+\.js)"/u)?.[1];
  assert.ok(assetPath, "Packaged index must reference a hashed JavaScript asset");

  const asset = await fetch(`${baseUrl}${assetPath}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const deepRoute = await fetch(`${baseUrl}/projects/nonexistent-navigation`, {
    headers: { accept: "text/html" },
  });
  assert.equal(deepRoute.status, 200);
  assert.equal(deepRoute.headers.get("cache-control"), "no-store");

  const missingApi = await fetchJson(`${baseUrl}/api/v1/missing`, {
    headers: { accept: "text/html" },
  });
  assert.equal(missingApi.response.status, 404);
  assert.equal(missingApi.body.code, "ROUTE_NOT_FOUND");

  const runtimeConfig = await fetchJson(`${baseUrl}/api/v1/runtime-config`);
  assert.equal(runtimeConfig.response.status, 200);
  assert.equal(runtimeConfig.body.configVersion, 1);

  const commandId = randomUUID();
  const created = await fetchJson(`${baseUrl}/api/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: "CREATE",
      commandId,
      name: "Container acceptance",
      primaryDialect: "POSTGRESQL",
      source,
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.response.headers.get("x-command-id"), commandId);
  assert.equal(created.body.state.project.draftSource, source);
  assert.equal(created.body.state.currentRevision.validity, "VALID");
  return { id: created.body.state.project.id };
}

async function assertBrowserRuntime(activeBrowser, projectId) {
  const page = await activeBrowser.newPage();
  const browserErrors = [];
  const unexpectedOrigins = [];
  const workerAssets = new Set();
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("request", (request) => {
    const requestUrl = request.url();
    if (requestUrl.startsWith("blob:") || requestUrl.startsWith("data:")) return;
    const parsed = new URL(requestUrl);
    if (parsed.origin !== baseUrl) unexpectedOrigins.push(parsed.origin);
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
  const layoutStatus = page.getByTestId("base-diagram-layout-status");
  await layoutStatus.waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(async () => (await layoutStatus.textContent()) === "Diagram layout ready", 30_000);
  assert.ok(
    [...workerAssets].some((pathname) => pathname.includes("parser.worker-")),
    "The packaged parser worker must load",
  );
  assert.ok(
    [...workerAssets].some(
      (pathname) => pathname.includes("layout.worker-") || pathname.includes("elk-worker"),
    ),
    "The packaged layout worker must load",
  );
  assert.deepEqual(unexpectedOrigins, []);
  assert.deepEqual(browserErrors, []);
  await page.close();
}

async function waitForLiveServer() {
  await waitFor(async () => {
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      return response.status === 200;
    } catch {
      return false;
    }
  }, 30_000);
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  return { response, body: await response.json() };
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
