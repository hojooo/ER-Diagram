import { DEFAULT_RUNTIME_CONFIG_RESPONSE } from "@er-diagram/contracts";
import { expect, test } from "@playwright/test";

test("starts in Korean and persists an explicit English selection", async ({ page }) => {
  await page.route("**/api/v1/runtime-config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(DEFAULT_RUNTIME_CONFIG_RESPONSE),
    });
  });
  await page.route("**/api/v1/projects", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ projects: [] }),
    });
  });

  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.getByRole("heading", { level: 1, name: "프로젝트" })).toBeVisible();
  await expect(page).toHaveTitle("프로젝트 · DBML·SQL ERD Studio");

  await page.getByRole("combobox", { name: "언어" }).selectOption("en");

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
  await expect(page).toHaveTitle("Projects · DBML·SQL ERD Studio");

  await page.reload();

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
});
