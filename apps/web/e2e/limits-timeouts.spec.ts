import { DEFAULT_RUNTIME_RESOURCE_LIMITS, RESOURCE_LIMITS_VERSION } from "@er-diagram/contracts";

import { expect, test } from "./test-fixture.js";

test("runtime config failure blocks startup until explicit retry", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/v1/runtime-config", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runtimeConfig(8)),
    });
  });
  await page.route("**/api/v1/projects", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"projects":[]}' });
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Runtime configuration unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Projects" })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  expect(attempts).toBe(2);
});

test("oversized SQL file and textarea remain local without preview mutation", async ({ page }) => {
  let previewRequests = 0;
  await page.route("**/api/v1/runtime-config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runtimeConfig(8)),
    });
  });
  await page.route("**/api/v1/sql-import/preview", async (route) => {
    previewRequests += 1;
    await route.abort();
  });

  await page.goto("/sql-import/new");
  await page.getByLabel("Choose SQL file").setInputFiles({
    name: "too-large.sql",
    mimeType: "text/plain",
    buffer: Buffer.from("123456789", "utf8"),
  });
  await expect(page.getByText(/SQL file exceeds the configured 8 byte limit/)).toBeVisible();
  await expect(page.getByLabel("SQL source")).toHaveValue("");

  await page.getByLabel("Project name").fill("Bounded import");
  await page.getByLabel("SQL source").fill("123456789");
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByText(/SQL source exceeds the configured 8 byte limit/)).toBeVisible();
  expect(previewRequests).toBe(0);
});

function runtimeConfig(maxSourceBytes: number) {
  return {
    configVersion: RESOURCE_LIMITS_VERSION,
    resourceLimits: {
      ...DEFAULT_RUNTIME_RESOURCE_LIMITS,
      bundle: { ...DEFAULT_RUNTIME_RESOURCE_LIMITS.bundle },
      maxSourceBytes,
    },
  };
}
