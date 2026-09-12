import { installPolishApi, POLISH_PROJECT_ID } from "./polish-api.js";
import { expect, test } from "./test-fixture.js";

for (const locale of ["ko", "en"]) {
  test(`document flows reflow with readable actions in ${locale}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(
      (value) => localStorage.setItem("er-diagram.ui-locale.v1", value),
      locale,
    );
    await installPolishApi(page);
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of [
        "/",
        "/sql-import/new",
        "/project-bundles/import",
        `/projects/${POLISH_PROJECT_ID}/sql-export`,
        `/projects/${POLISH_PROJECT_ID}/bundle-export`,
      ]) {
        await page.goto(route);
        await expect(page.locator("h1:not([data-route-loading])")).toBeVisible();
        if (route === "/") {
          await expect(
            page.getByRole("heading", { name: "Order management · synthetic review project" }),
          ).toBeVisible();
        }
        await page.waitForLoadState("networkidle");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${route} at ${width}px`,
        ).toBe(true);
        const outside = await page
          .locator(
            "main button:visible, main input:visible, main select:visible, main textarea:visible",
          )
          .evaluateAll((elements) =>
            elements
              .filter((element) => {
                const bounds = element.getBoundingClientRect();
                return bounds.left < -1 || bounds.right > innerWidth + 1;
              })
              .map((element) => element.tagName),
          );
        expect(outside).toEqual([]);
      }
    }
  });
}

test("long column names do not overlap types or alter the projected node geometry", async ({
  page,
}) => {
  await installPolishApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/projects/${POLISH_PROJECT_ID}`);
  await expect(page.getByTestId("base-diagram-layout-status")).toHaveText("Diagram layout ready", {
    timeout: 30_000,
  });
  const column = page.getByRole("button", {
    name: "account_display_name_for_review, varchar(255)",
    exact: true,
  });
  const measurement = await column.evaluate((element) => {
    const name = element.children[1] as HTMLElement;
    const type = element.querySelector("code") as HTMLElement;
    return {
      separated: name.getBoundingClientRect().right <= type.getBoundingClientRect().left,
      nameClipped:
        name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === "ellipsis",
      nameSize: Number.parseFloat(getComputedStyle(name).fontSize),
      typeSize: Number.parseFloat(getComputedStyle(type).fontSize),
      rowHeight: element.clientHeight,
      tableWidth: (element.closest(".diagram-table") as HTMLElement).offsetWidth,
    };
  });
  expect(measurement).toMatchObject({
    separated: true,
    nameClipped: true,
    rowHeight: 28,
    tableWidth: 260,
  });
  expect(measurement.nameSize).toBeGreaterThanOrEqual(12);
  expect(measurement.typeSize).toBeGreaterThanOrEqual(12);
  await column.click();
  await expect(column).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("workspace-inspector-scroll")).toContainText(
    "account_display_name_for_review",
  );
});
