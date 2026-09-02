import { DEFAULT_RUNTIME_CONFIG_RESPONSE } from "@er-diagram/contracts";
import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";
export type { Locator, Page, Route } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("er-diagram.ui-locale.v1", "en");
      } catch {
        // Tests that exercise storage failures provide their own browser context.
      }
    });
    await page.route("**/api/v1/runtime-config", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify(DEFAULT_RUNTIME_CONFIG_RESPONSE),
      });
    });
    await use(page);
  },
});
