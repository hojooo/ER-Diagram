import { expect, type Page } from "./test-fixture.js";

export async function openWorkspaceTab(page: Page, name: "Source" | "Outline") {
  const toggle = page.getByRole("button", { name: /^(Open|Collapse) source and outline$/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await page.getByRole("tab", { name, exact: true }).click();
}

export async function openWorkspaceInspector(page: Page) {
  const toggle = page.getByRole("button", { name: /^(Open|Collapse) workspace tools$/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}
