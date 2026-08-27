import { expect, test } from "@playwright/test";

test("renders and updates the compound graph prototype", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/__spikes/layout");

  await expect(page.getByRole("heading", { name: "DBML·SQL ERD Studio" })).toBeVisible();
  await expect(page.getByTestId("erd-canvas")).toBeVisible();
  await expect(page.getByTestId("layout-status")).toHaveText("Layout ready", {
    timeout: 10_000,
  });
  await expect(page.locator(".react-flow__node-table")).toHaveCount(5);

  await page.getByRole("button", { name: "Collapse Identity" }).click();

  await expect(page.locator(".react-flow__node-table")).toHaveCount(3);
  await expect(page.getByText("2 tables collapsed")).toBeVisible();
  await expect(page.getByTestId("layout-status")).toHaveText("Layout ready", {
    timeout: 10_000,
  });
  expect(browserErrors).toEqual([]);
});
