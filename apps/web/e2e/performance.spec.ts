import { performance } from "node:perf_hooks";

import { DEFAULT_RUNTIME_RESOURCE_LIMITS, RESOURCE_LIMITS_VERSION } from "@er-diagram/contracts";
import {
  fixtureInventory,
  generateFidelityFixture,
  generateScaleFixture,
  M4_PERFORMANCE_PROFILE_HASH,
  M4_PERFORMANCE_PROFILE_VERSION,
  m4PerformanceProfile,
  sha256FixtureSource,
} from "@er-diagram/test-fixtures";
import type { Browser, BrowserContext, Page, Route } from "@playwright/test";

import { createControlledLayoutApi } from "./controlled-layout-api.js";
import { expect, test } from "./test-fixture.js";

const PROJECT_ID = "019d5f4e-7b6c-7abc-8def-8123456789ab";
const CREATED_AT = "2026-09-01T01:02:03.004Z";
const FIDELITY_SOURCE = generateFidelityFixture();
const SCALE_SOURCE = generateScaleFixture();
const SMALL_INPUT_SOURCE = `// source input performance sentinel
Table input_target {
  id bigint [pk]
}
`;
const SOURCE_VIEW_LABELS = [
  "full_schema",
  "focus_01",
  "focus_02",
  "focus_03",
  "focus_04",
  "focus_05",
  "focus_06",
] as const;

interface PerformanceTelemetry {
  parserWorkerCreations: number;
  layoutWorkerCreations: number;
  parserRequests: number;
  layoutRequests: number;
  parserDurationsMs: number[];
  layoutDurationsMs: number[];
  longTasksMs: number[];
}

interface MetricSummary {
  readonly samples: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

test.describe.configure({ mode: "serial" });

test("measures persistent parser-worker latency on the fidelity fixture", async ({ page }) => {
  test.setTimeout(300_000);
  await installWorkerTelemetry(page);
  await installPerformanceApi(page, FIDELITY_SOURCE);
  const browserErrors = collectBrowserErrors(page);

  await openStableWorkspace(page, fixtureInventory.fidelity);
  const environment = await readBrowserEnvironment(page);
  expect(environment.logicalCpu).toBeGreaterThanOrEqual(
    m4PerformanceProfile.environment.minimumLogicalCpu,
  );
  expect(environment.memoryBytes).toBeGreaterThanOrEqual(
    m4PerformanceProfile.environment.minimumMemoryBytes,
  );

  const initialTelemetry = await readTelemetry(page);
  expect(initialTelemetry.parserWorkerCreations).toBe(1);
  expect(initialTelemetry.layoutWorkerCreations).toBe(0);
  await clearOperationTelemetry(page);

  const editor = page.getByRole("textbox", { name: "DBML source editor" });
  await editor.focus();
  await editor.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await editor.press("End");

  const totalSamples =
    m4PerformanceProfile.parse.warmupSamples + m4PerformanceProfile.parse.measuredSamples;
  for (let sample = 0; sample < totalSamples; sample += 1) {
    const before = (await readTelemetry(page)).parserDurationsMs.length;
    await editor.press(sample % 2 === 0 ? "x" : "Backspace");
    await expect
      .poll(async () => (await readTelemetry(page)).parserDurationsMs.length)
      .toBe(before + 1);
    await expect(page.getByTestId("validation-status")).toHaveText(/Draft valid/u);
  }

  const telemetry = await readTelemetry(page);
  const measured = telemetry.parserDurationsMs.slice(m4PerformanceProfile.parse.warmupSamples);
  const summary = summarize(measured);
  expect(measured).toHaveLength(m4PerformanceProfile.parse.measuredSamples);
  expect(summary.p95Ms).toBeLessThanOrEqual(m4PerformanceProfile.parse.p95ThresholdMs);
  expect(telemetry.parserWorkerCreations).toBe(0);
  expect(telemetry.layoutRequests).toBe(0);
  expect(browserErrors).toEqual([]);
  emitResult("parse", { ...summary, environment });
});

test("measures cold interactive readiness in isolated Chrome contexts", async ({ browser }) => {
  test.setTimeout(600_000);
  const observations: number[] = [];

  for (
    let sample = 0;
    sample < m4PerformanceProfile.coldInteractive.isolatedContextSamples;
    sample += 1
  ) {
    const context = await createMeasuredContext(browser);
    const page = await context.newPage();
    const browserErrors = collectBrowserErrors(page);
    await installPerformanceApi(page, FIDELITY_SOURCE);
    const startedAt = performance.now();
    await openStableWorkspace(page, fixtureInventory.fidelity);
    observations.push(performance.now() - startedAt);
    const telemetry = await readTelemetry(page);
    expect(telemetry.parserRequests).toBeGreaterThanOrEqual(1);
    expect(telemetry.layoutRequests).toBe(0);
    expect(browserErrors).toEqual([]);
    await context.close();
  }

  const summary = summarize(observations);
  expect(summary.p95Ms).toBeLessThanOrEqual(m4PerformanceProfile.coldInteractive.p95ThresholdMs);
  emitResult("coldInteractive", summary);
});

test("keeps every first view switch below threshold without parser, ELK, or writes", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const observations: number[] = [];
  let parserRequests = 0;
  let layoutRequests = 0;
  let sourceWrites = 0;
  let layoutWrites = 0;

  for (let run = 0; run < m4PerformanceProfile.viewSwitch.samplesPerSourceView; run += 1) {
    const context = await createMeasuredContext(browser);
    const page = await context.newPage();
    const api = await installPerformanceApi(page, FIDELITY_SOURCE);
    const browserErrors = collectBrowserErrors(page);
    await openStableWorkspace(page, fixtureInventory.fidelity);
    await clearOperationTelemetry(page);
    const initialSourceWrites = api.sourceWrites.length;
    const initialLayoutWrites = api.layouts.writes.length;

    for (const viewLabel of SOURCE_VIEW_LABELS) {
      await switchView(page, "Global");
      const elapsedMs = await switchViewMeasured(page, viewLabel);
      observations.push(elapsedMs);
    }

    const telemetry = await readTelemetry(page);
    parserRequests += telemetry.parserRequests;
    layoutRequests += telemetry.layoutRequests;
    sourceWrites += api.sourceWrites.length - initialSourceWrites;
    layoutWrites += api.layouts.writes.length - initialLayoutWrites;
    expect(browserErrors).toEqual([]);
    await context.close();
  }

  const orderedContext = await createMeasuredContext(browser);
  const orderedPage = await orderedContext.newPage();
  const orderedApi = await installPerformanceApi(orderedPage, FIDELITY_SOURCE);
  const orderedErrors = collectBrowserErrors(orderedPage);
  await openStableWorkspace(orderedPage, fixtureInventory.fidelity);
  await clearOperationTelemetry(orderedPage);
  for (const viewLabel of [...SOURCE_VIEW_LABELS, "Global"] as const) {
    const elapsedMs = await switchViewMeasured(orderedPage, viewLabel);
    observations.push(elapsedMs);
  }
  const orderedTelemetry = await readTelemetry(orderedPage);
  parserRequests += orderedTelemetry.parserRequests;
  layoutRequests += orderedTelemetry.layoutRequests;
  sourceWrites += orderedApi.sourceWrites.length;
  layoutWrites += orderedApi.layouts.writes.length;
  expect(orderedErrors).toEqual([]);
  await orderedContext.close();

  const summary = summarize(observations);
  emitResult("viewSwitch", {
    ...summary,
    maxObservationMs: summary.maxMs,
    parserRequests,
    layoutRequests,
    sourceWrites,
    layoutWrites,
  });
  expect(summary.maxMs).toBeLessThanOrEqual(m4PerformanceProfile.viewSwitch.observationThresholdMs);
  expect(summary.p95Ms).toBeLessThanOrEqual(m4PerformanceProfile.viewSwitch.p95ThresholdMs);
  expect(parserRequests).toBe(0);
  expect(layoutRequests).toBe(0);
  expect(sourceWrites).toBe(0);
  expect(layoutWrites).toBe(0);
});

test("keeps scale interactions responsive and confines explicit auto-layout to ELK", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await installWorkerTelemetry(page);
  const api = await installPerformanceApi(page, SCALE_SOURCE);
  const browserErrors = collectBrowserErrors(page);
  await openStableWorkspace(page, fixtureInventory.scale);
  await clearOperationTelemetry(page);

  const detailSelector = page.getByRole("combobox", { name: "Detail level" });
  for (const detail of ["KEYS_ONLY", "NAME_ONLY", "FULL"] as const) {
    await detailSelector.selectOption(detail);
    await expect(page.getByTestId("base-diagram-layout-status")).toHaveText("Diagram layout ready");
  }
  const search = page.getByRole("combobox", { name: "Search current view" });
  await search.fill("node_199");
  await page.getByRole("option", { name: "table scale.node_199" }).click();
  await expect(
    page.getByRole("button", { name: "Focus scale.node_199 in diagram" }),
  ).toHaveAttribute("aria-current", "true");
  const implicitTelemetry = await readTelemetry(page);
  expect(implicitTelemetry.parserRequests).toBe(0);
  expect(implicitTelemetry.layoutRequests).toBe(0);
  expect(api.sourceWrites).toHaveLength(0);
  expect(
    api.layouts.writes.every((write) => {
      const layout = write.command.layout as
        | { readonly positions?: Readonly<Record<string, unknown>> }
        | undefined;
      return layout?.positions !== undefined && Object.keys(layout.positions).length === 0;
    }),
  ).toBe(true);

  const interactionResults: Record<string, MetricSummary> = {};
  for (const interaction of m4PerformanceProfile.frameRate.interactions) {
    const intervals: number[] = [];
    for (let run = 0; run < m4PerformanceProfile.frameRate.runsPerInteraction; run += 1) {
      intervals.push(...(await measureInteractionFrames(page, interaction)));
    }
    const summary = summarize(intervals);
    interactionResults[interaction] = summary;
    expect(summary.p95Ms).toBeLessThanOrEqual(
      m4PerformanceProfile.frameRate.p95FrameIntervalThresholdMs,
    );
  }

  await expect(page.getByRole("button", { name: "Preview auto layout" })).toBeEnabled();
  await page.getByRole("button", { name: "Preview auto layout" }).click();
  await expect(page.getByText("Auto-layout preview ready")).toBeVisible({ timeout: 30_000 });
  const explicitTelemetry = await readTelemetry(page);
  expect(explicitTelemetry.layoutRequests).toBe(1);
  expect(explicitTelemetry.parserRequests).toBe(0);
  await page.getByRole("button", { name: "Cancel preview" }).click();
  expect(browserErrors).toEqual([]);
  emitResult("frameRate", {
    interactions: interactionResults,
    medianTargetMs: m4PerformanceProfile.frameRate.medianFrameIntervalTargetMs,
    explicitLayoutRequests: explicitTelemetry.layoutRequests,
  });
});

test("keeps repeated source input free of tasks longer than 100 ms", async ({ page }) => {
  test.setTimeout(180_000);
  await installWorkerTelemetry(page);
  await installPerformanceApi(page, SMALL_INPUT_SOURCE);
  const browserErrors = collectBrowserErrors(page);
  await openStableWorkspace(page, {
    tables: 1,
    tableGroups: 0,
    references: 0,
  });
  await clearOperationTelemetry(page);
  await page.evaluate(() => {
    const telemetry = (
      globalThis as typeof globalThis & {
        __ER_DIAGRAM_PERFORMANCE_TELEMETRY__: PerformanceTelemetry;
      }
    ).__ER_DIAGRAM_PERFORMANCE_TELEMETRY__;
    telemetry.longTasksMs.length = 0;
  });

  const editor = page.getByRole("textbox", { name: "DBML source editor" });
  await editor.focus();
  await editor.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await editor.press("End");
  const input = "abcdefghijklmnopqrstuvwxyz1234";
  expect(input).toHaveLength(m4PerformanceProfile.sourceInput.inputEventsPerRun);

  for (let run = 0; run < m4PerformanceProfile.sourceInput.runs; run += 1) {
    const before = (await readTelemetry(page)).parserRequests;
    for (const character of input) await page.keyboard.press(character);
    await expect.poll(async () => (await readTelemetry(page)).parserRequests).toBe(before + 1);
    await expect
      .poll(async () => (await readTelemetry(page)).parserDurationsMs.length)
      .toBe(before + 1);
    await expect(page.getByTestId("validation-status")).toHaveText(/Draft valid/u);
  }

  const telemetry = await readTelemetry(page);
  const violatingTasks = telemetry.longTasksMs.filter(
    (duration) => duration > m4PerformanceProfile.sourceInput.longTaskThresholdMs,
  );
  expect(violatingTasks).toHaveLength(m4PerformanceProfile.sourceInput.allowedLongTasks);
  expect(telemetry.layoutRequests).toBe(0);
  expect(browserErrors).toEqual([]);
  emitResult("sourceInput", {
    inputEvents:
      m4PerformanceProfile.sourceInput.inputEventsPerRun * m4PerformanceProfile.sourceInput.runs,
    runs: m4PerformanceProfile.sourceInput.runs,
    debouncedParserRequests: telemetry.parserRequests,
    longTasksOver100Ms: violatingTasks.length,
    longestTaskMs: telemetry.longTasksMs.length === 0 ? 0 : Math.max(...telemetry.longTasksMs),
  });
});

async function createMeasuredContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: m4PerformanceProfile.environment.viewport,
    deviceScaleFactor: m4PerformanceProfile.environment.deviceScaleFactor,
  });
  await installWorkerTelemetry(context);
  return context;
}

async function installWorkerTelemetry(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    const telemetry: PerformanceTelemetry = {
      parserWorkerCreations: 0,
      layoutWorkerCreations: 0,
      parserRequests: 0,
      layoutRequests: 0,
      parserDurationsMs: [],
      layoutDurationsMs: [],
      longTasksMs: [],
    };
    const parserStartedAt = new Map<string, number>();
    const layoutStartedAt = new Map<string, number>();
    Object.defineProperty(globalThis, "__ER_DIAGRAM_PERFORMANCE_TELEMETRY__", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: telemetry,
    });

    class InstrumentedWorker extends NativeWorker {
      readonly performanceKind: "PARSER" | "LAYOUT" | null;

      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        const url = String(scriptURL);
        this.performanceKind =
          options?.name === "er-diagram-dbml-parser"
            ? "PARSER"
            : url.includes("layout.worker")
              ? "LAYOUT"
              : null;
        if (this.performanceKind === "PARSER") telemetry.parserWorkerCreations += 1;
        if (this.performanceKind === "LAYOUT") telemetry.layoutWorkerCreations += 1;
        this.addEventListener("message", (event: MessageEvent<unknown>) => {
          if (!isRequestMessage(event.data)) return;
          if (this.performanceKind === "PARSER") {
            const startedAt = parserStartedAt.get(event.data.requestId);
            if (startedAt !== undefined) {
              telemetry.parserDurationsMs.push(performance.now() - startedAt);
              parserStartedAt.delete(event.data.requestId);
            }
          }
          if (this.performanceKind === "LAYOUT") {
            const startedAt = layoutStartedAt.get(event.data.requestId);
            if (startedAt !== undefined) {
              telemetry.layoutDurationsMs.push(performance.now() - startedAt);
              layoutStartedAt.delete(event.data.requestId);
            }
          }
        });
      }

      override postMessage(
        message: unknown,
        transferOrOptions?: StructuredSerializeOptions | Transferable[],
      ): void {
        if (isRequestMessage(message)) {
          if (this.performanceKind === "PARSER") {
            telemetry.parserRequests += 1;
            parserStartedAt.set(message.requestId, performance.now());
          }
          if (this.performanceKind === "LAYOUT") {
            telemetry.layoutRequests += 1;
            layoutStartedAt.set(message.requestId, performance.now());
          }
        }
        if (transferOrOptions === undefined) super.postMessage(message);
        else if (Array.isArray(transferOrOptions)) {
          super.postMessage(message, { transfer: transferOrOptions });
        } else super.postMessage(message, transferOrOptions);
      }
    }

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: InstrumentedWorker,
    });

    if (typeof PerformanceObserver !== "undefined") {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) telemetry.longTasksMs.push(entry.duration);
      });
      try {
        observer.observe({ type: "longtask", buffered: true });
      } catch {
        // Chrome supports long-task observation; a missing implementation leaves an empty record.
      }
    }

    function isRequestMessage(value: unknown): value is { readonly requestId: string } {
      return (
        typeof value === "object" &&
        value !== null &&
        "requestId" in value &&
        typeof value.requestId === "string"
      );
    }
  });
}

async function installPerformanceApi(page: Page, initialSource: string) {
  let state = projectState(initialSource, 1, 0);
  const sourceWrites: Array<Record<string, unknown>> = [];
  const layouts = createControlledLayoutApi(PROJECT_ID);

  await page.route("**/api/v1/**", async (route) => {
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

    if (pathname === "/api/v1/runtime-config" && method === "GET") {
      await route.fulfill({
        status: 200,
        headers: { ...headers, "cache-control": "no-store" },
        body: JSON.stringify({
          configVersion: RESOURCE_LIMITS_VERSION,
          resourceLimits: DEFAULT_RUNTIME_RESOURCE_LIMITS,
        }),
      });
      return;
    }

    if (await layouts.fulfillIfMatched({ route, pathname, method, command, headers })) {
      state = {
        ...state,
        project: { ...state.project, layoutRevisionNo: layouts.currentRevisionNo },
      };
      return;
    }

    if (pathname === `/api/v1/projects/${PROJECT_ID}` && method === "GET") {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ state }) });
      return;
    }

    if (pathname === `/api/v1/projects/${PROJECT_ID}/draft` && method === "PUT") {
      if (!command || typeof command.source !== "string") throw new Error("Missing source input.");
      sourceWrites.push(structuredClone(command));
      state = projectState(
        command.source,
        state.project.schemaRevisionNo + 1,
        layouts.currentRevisionNo,
      );
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ state, diagnostics: [], revisionCreated: true }),
      });
      return;
    }

    if (pathname === "/api/v1/projects" && method === "GET") {
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ projects: [projectSummary(state)] }),
      });
      return;
    }

    await fulfillNotFound(route, headers);
  });

  return { sourceWrites, layouts };
}

async function openStableWorkspace(
  page: Page,
  inventory: {
    readonly tables: number;
    readonly tableGroups: number;
    readonly references: number;
  },
): Promise<void> {
  await page.goto(`/projects/${PROJECT_ID}`);
  await expect(
    page.locator('section[aria-label="DBML source editor"] .monaco-editor'),
  ).toBeVisible();
  await expect(page.getByTestId("validation-status")).toHaveText(/Draft valid/u);
  await expect(page.getByTestId("base-diagram-layout-status")).toHaveText("Diagram layout ready");
  await expect(
    page
      .getByRole("region", { name: "Schema outline" })
      .getByText(
        `${inventory.tables} ${plural(inventory.tables, "table")} · ${inventory.tableGroups} ${plural(inventory.tableGroups, "group")} · ${inventory.references} ${plural(inventory.references, "relationship")}`,
        { exact: true },
      ),
  ).toBeVisible();
}

async function switchView(page: Page, viewLabel: string): Promise<void> {
  await switchViewMeasured(page, viewLabel);
}

async function switchViewMeasured(page: Page, viewLabel: string): Promise<number> {
  return page.evaluate(async (targetLabel) => {
    const selector = [...document.querySelectorAll("select")].find((candidate) =>
      candidate.closest("label")?.textContent?.includes("Diagram view"),
    );
    if (!(selector instanceof HTMLSelectElement)) {
      throw new Error("The diagram view selector is unavailable.");
    }
    const option = [...selector.options].find((candidate) => candidate.text === targetLabel);
    if (!option) throw new Error("The requested diagram view is unavailable.");
    const startedAt = performance.now();
    selector.value = option.value;
    selector.dispatchEvent(new Event("change", { bubbles: true }));

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("The diagram view did not become interactive.")),
        5_000,
      );
      const inspect = () => {
        const headingReady = [...document.querySelectorAll("h2")].some(
          (heading) => heading.textContent === `Schema outline · ${targetLabel}`,
        );
        const status = document.querySelector<HTMLElement>(
          '[data-testid="base-diagram-layout-status"]',
        );
        const layoutReady =
          status?.textContent === "Diagram layout ready" && status.dataset.viewKey === option.value;
        if (headingReady && layoutReady) {
          window.clearTimeout(timeout);
          resolve();
        } else requestAnimationFrame(inspect);
      };
      requestAnimationFrame(inspect);
    });
    return performance.now() - startedAt;
  }, viewLabel);
}

async function measureInteractionFrames(
  page: Page,
  interaction: (typeof m4PerformanceProfile.frameRate.interactions)[number],
): Promise<number[]> {
  const durationMs = m4PerformanceProfile.frameRate.durationMs;
  const box = await waitForInteractionTarget(page, interaction);
  const frameSample = page.evaluate(
    (duration) =>
      new Promise<number[]>((resolve) => {
        const intervals: number[] = [];
        const startedAt = performance.now();
        let previous: number | null = null;
        const measure = (timestamp: number) => {
          if (previous !== null) intervals.push(timestamp - previous);
          previous = timestamp;
          if (performance.now() - startedAt >= duration) resolve(intervals);
          else requestAnimationFrame(measure);
        };
        requestAnimationFrame(measure);
      }),
    durationMs,
  );
  await performInteraction(page, interaction, durationMs, box);
  return frameSample;
}

async function waitForInteractionTarget(
  page: Page,
  interaction: (typeof m4PerformanceProfile.frameRate.interactions)[number],
): Promise<{ x: number; y: number; width: number; height: number }> {
  const target =
    interaction === "DRAG"
      ? page.locator(".react-flow__node-table:visible").first()
      : page.locator(".react-flow__pane");
  await target.waitFor({ state: "visible" });
  const box = await target.boundingBox();
  if (!box) throw new Error("The performance interaction target is not visible.");
  return box;
}

async function performInteraction(
  page: Page,
  interaction: (typeof m4PerformanceProfile.frameRate.interactions)[number],
  durationMs: number,
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): Promise<void> {
  const startX = box.x + Math.min(box.width / 2, 120);
  const startY = box.y + Math.min(box.height / 2, 80);
  await page.mouse.move(startX, startY);

  const steps = 50;
  if (interaction === "ZOOM") {
    for (let step = 0; step < steps; step += 1) {
      await page.mouse.wheel(0, step % 2 === 0 ? -60 : 60);
      await page.waitForTimeout(durationMs / steps);
    }
    return;
  }

  await page.mouse.down();
  for (let step = 0; step < steps; step += 1) {
    const direction = step % 2 === 0 ? 1 : -1;
    await page.mouse.move(startX + direction * 36, startY + direction * 24);
    await page.waitForTimeout(durationMs / steps);
  }
  await page.mouse.up();
}

async function readTelemetry(page: Page): Promise<PerformanceTelemetry> {
  return page.evaluate(() =>
    structuredClone(
      (
        globalThis as typeof globalThis & {
          __ER_DIAGRAM_PERFORMANCE_TELEMETRY__: PerformanceTelemetry;
        }
      ).__ER_DIAGRAM_PERFORMANCE_TELEMETRY__,
    ),
  );
}

async function clearOperationTelemetry(page: Page): Promise<void> {
  await page.evaluate(() => {
    const telemetry = (
      globalThis as typeof globalThis & {
        __ER_DIAGRAM_PERFORMANCE_TELEMETRY__: PerformanceTelemetry;
      }
    ).__ER_DIAGRAM_PERFORMANCE_TELEMETRY__;
    telemetry.parserWorkerCreations = 0;
    telemetry.layoutWorkerCreations = 0;
    telemetry.parserRequests = 0;
    telemetry.layoutRequests = 0;
    telemetry.parserDurationsMs.length = 0;
    telemetry.layoutDurationsMs.length = 0;
  });
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function readBrowserEnvironment(page: Page) {
  return page.evaluate(() => ({
    userAgent: navigator.userAgent,
    logicalCpu: navigator.hardwareConcurrency,
    memoryBytes:
      (navigator as Navigator & { readonly deviceMemory?: number }).deviceMemory === undefined
        ? 0
        : (navigator as Navigator & { readonly deviceMemory: number }).deviceMemory *
          1024 *
          1024 *
          1024,
    viewport: { width: innerWidth, height: innerHeight },
    deviceScaleFactor: devicePixelRatio,
  }));
}

function summarize(values: readonly number[]): MetricSummary {
  if (values.length === 0) throw new Error("A performance metric requires at least one sample.");
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    minMs: round(sorted[0] ?? 0),
    medianMs: round(nearestRank(sorted, 0.5)),
    p95Ms: round(nearestRank(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

function nearestRank(sortedValues: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(sortedValues.length * percentile) - 1);
  return sortedValues[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function emitResult(metric: string, result: object): void {
  console.log(
    JSON.stringify({
      performanceProfileVersion: M4_PERFORMANCE_PROFILE_VERSION,
      performanceProfileHash: M4_PERFORMANCE_PROFILE_HASH,
      metric,
      result,
    }),
  );
}

function projectState(source: string, revisionNo: number, layoutRevisionNo: number) {
  const currentRevision = revision(source, revisionNo);
  return {
    project: {
      id: PROJECT_ID,
      name: "M4 performance acceptance",
      primaryDialect: "POSTGRESQL" as const,
      draftSource: source,
      draftHash: sha256FixtureSource(source),
      lastValidRevisionId: currentRevision.id,
      parserVersion: "9.1.1",
      schemaRevisionNo: revisionNo,
      layoutRevisionNo,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    currentRevision,
    lastValidRevision: currentRevision,
  };
}

function revision(source: string, revisionNo: number) {
  return {
    id: `019d5f4e-7b6c-7a${revisionNo.toString().padStart(2, "0")}-8def-8123456789ab`,
    projectId: PROJECT_ID,
    revisionNo,
    source,
    sourceHash: sha256FixtureSource(source),
    validity: "VALID" as const,
    origin: "SOURCE_EDIT" as const,
    parserVersion: "9.1.1",
    diagnosticSummary: { errors: 0, warnings: 0, infos: 0, parserVersion: "9.1.1" },
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
    draftValidity: "VALID" as const,
    diagnosticSummary: state.currentRevision.diagnosticSummary,
    createdAt: state.project.createdAt,
    updatedAt: state.project.updatedAt,
  };
}

async function fulfillNotFound(route: Route, headers: Record<string, string>): Promise<void> {
  await route.fulfill({
    status: 404,
    headers,
    body: JSON.stringify({
      code: "PROJECT_NOT_FOUND",
      message: "Project not found.",
      correlationId: "123e4567-e89b-42d3-a456-426614174000",
    }),
  });
}
