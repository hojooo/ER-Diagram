import { DEFAULT_RUNTIME_RESOURCE_LIMITS, RESOURCE_LIMITS_VERSION } from "@er-diagram/contracts";
import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";
export type { Locator, Page, Route } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use) => {
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
    await use(page);
  },
});
