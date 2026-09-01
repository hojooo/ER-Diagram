import { createHash } from "node:crypto";

import { DEFAULT_RUNTIME_RESOURCE_LIMITS, RESOURCE_LIMITS_VERSION } from "@er-diagram/contracts";
import { CONTENT_SECURITY_POLICY } from "../../server/src/security-headers.js";
import { createControlledLayoutApi } from "./controlled-layout-api.js";
import { expect, type Page, test } from "./test-fixture.js";

const PROJECT_ID = "019d3f4e-7b6c-7abc-8def-0123456789ab";
const REVISION_ID = "019d3f4e-7b6c-7def-9abc-0123456789ab";
const CREATED_AT = "2026-08-31T01:02:03.004Z";
const PROJECT_NAME = 'Project </h2><img src="https://attacker.invalid/pixel" onerror="alert(1)">';
const SOURCE = `TableGroup "group<script>window.pwned=true</script>😀" [color: #778899] {
  alpha
  beta
}

Table alpha {
  "column<img onerror=alert(1)>😀" int [pk, note: 'note</textarea><script>window.pwned=true</script>']
  beta_id int
}

Table beta {
  id int [pk]
}

Ref alpha_beta: alpha.beta_id > beta.id
`;

test("production build enforces CSP while local editor, parser, layout, and diagram assets run", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const remoteRequests: string[] = [];
  const workerRequests: string[] = [];
  const expectedOrigin = "http://127.0.0.1:4174";

  await page.addInitScript(() => {
    Object.defineProperty(window, "__securityPolicyViolations", {
      configurable: false,
      value: [],
      writable: false,
    });
    document.addEventListener("securitypolicyviolation", (event) => {
      const violations = Reflect.get(window, "__securityPolicyViolations") as string[];
      violations.push(
        [
          event.effectiveDirective,
          event.blockedURI,
          event.sourceFile,
          event.lineNumber,
          event.columnNumber,
          event.sample,
        ].join(":"),
      );
    });
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== expectedOrigin) remoteRequests.push(request.url());
    if (
      request.resourceType() === "worker" ||
      /\/assets\/[^/]*(?:worker|parser|layout|elk)[^/]*\.js$/iu.test(url.pathname)
    ) {
      workerRequests.push(request.url());
    }
  });
  await installControlledApi(page);

  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
  assertCspBoundary(CONTENT_SECURITY_POLICY);

  await expect(page.getByText(PROJECT_NAME, { exact: true })).toBeVisible();
  await expect(page.locator('img[src="https://attacker.invalid/pixel"]')).toHaveCount(0);
  await expect(page.locator("script:not([src])")).toHaveCount(0);
  await page.getByRole("link", { name: `Open ${PROJECT_NAME}` }).click();

  await expect(page.locator('section[aria-label="DBML source editor"] .monaco-editor')).toBeVisible(
    {
      timeout: 25_000,
    },
  );
  await page.evaluate(async () => {
    const environment = Reflect.get(globalThis, "MonacoEnvironment") as
      | { getWorker(moduleId: string, label: string): Worker }
      | undefined;
    if (!environment) throw new Error("The local Monaco worker environment was not configured.");
    const worker = environment.getWorker("", "editorWorkerService");
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(resolve, 250);
        worker.addEventListener(
          "error",
          () => {
            window.clearTimeout(timeout);
            reject(new Error("The local Monaco editor worker could not be loaded."));
          },
          { once: true },
        );
      });
    } finally {
      worker.terminate();
    }
  });
  await expect(page.getByText("Saved. Draft valid.", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("base-diagram-layout-status")).toHaveText("Diagram layout ready", {
    timeout: 25_000,
  });
  await expect(page.locator(".react-flow__renderer")).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Preview auto layout" })).toBeEnabled();
  await page.getByRole("button", { name: "Preview auto layout" }).click();
  await expect(page.getByText("Auto-layout preview ready")).toBeVisible({ timeout: 25_000 });
  await expect(
    page.getByText("public.group<script>window.pwned=true</script>😀", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /column<img onerror=alert\(1\)>😀, int, PK/ }),
  ).toBeVisible();
  await expect(page.locator("script:not([src])")).toHaveCount(0);
  await expect(page.locator("img")).toHaveCount(0);

  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (Reflect.get(window, "__securityPolicyViolations") as string[]).slice(),
        ),
      { timeout: 5_000 },
    )
    .toEqual([]);
  const workerPaths = workerRequests.map((url) => new URL(url).pathname);
  expect(workerRequests.every((url) => new URL(url).origin === expectedOrigin)).toBe(true);
  expect(workerPaths.some((path) => /editor\.worker/iu.test(path))).toBe(true);
  expect(workerPaths.some((path) => /parser\.worker/iu.test(path))).toBe(true);
  expect(workerPaths.some((path) => /(?:layout[.-]worker|elk[.-]worker)/iu.test(path))).toBe(true);
  expect(remoteRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

async function installControlledApi(page: Page): Promise<void> {
  const state = projectState();
  const layouts = createControlledLayoutApi(PROJECT_ID);
  await page.route("**/api/v1/runtime-config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        configVersion: RESOURCE_LIMITS_VERSION,
        resourceLimits: DEFAULT_RUNTIME_RESOURCE_LIMITS,
      }),
    });
  });
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

    if (await layouts.fulfillIfMatched({ route, pathname, method, command, headers })) return;
    if (method === "GET" && pathname === "/api/v1/projects") {
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ projects: [projectSummary(state)] }),
      });
      return;
    }
    if (method === "GET" && pathname === `/api/v1/projects/${PROJECT_ID}`) {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ state }) });
      return;
    }
    if (method === "GET" && pathname === `/api/v1/projects/${PROJECT_ID}/revisions`) {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ revisions: [] }) });
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

function projectState() {
  const revision = {
    id: REVISION_ID,
    projectId: PROJECT_ID,
    revisionNo: 1,
    source: SOURCE,
    sourceHash: sha256(SOURCE),
    validity: "VALID" as const,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
    createdAt: CREATED_AT,
  };
  return {
    project: {
      id: PROJECT_ID,
      name: PROJECT_NAME,
      primaryDialect: "POSTGRESQL" as const,
      draftSource: SOURCE,
      draftHash: revision.sourceHash,
      lastValidRevisionId: REVISION_ID,
      parserVersion: "9.1.1",
      schemaRevisionNo: 1,
      layoutRevisionNo: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision: revision,
    lastValidRevision: revision,
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

function assertCspBoundary(policy: string): void {
  const directives = new Map(
    policy.split(";").map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/u);
      return [name, values] as const;
    }),
  );
  expect(directives.get("script-src")).toEqual(["'self'"]);
  expect(directives.get("script-src-attr")).toEqual(["'none'"]);
  expect(directives.get("worker-src")).toEqual(["'self'"]);
  expect(directives.get("connect-src")).toEqual(["'self'"]);
  expect(directives.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  expect(policy).not.toContain("'unsafe-eval'");
  expect(directives.get("script-src")).not.toContain("'unsafe-inline'");
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
