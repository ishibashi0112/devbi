import { expect, test } from "@playwright/test";

test("stacks tiles in one column on a phone without horizontal scrolling", async ({ page }) => {
  await page.goto("/#/sales"); // by name: local_* dashboards from `pnpm try-xlsx` add an index page at "/"
  await expect(page.locator('[data-tile="kpi-revenue"]').getByTestId("kpi-value")).toHaveText(/^¥[\d,]+$/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const a = await page.locator('[data-tile="kpi-revenue"]').boundingBox();
  const b = await page.locator('[data-tile="kpi-orders"]').boundingBox();
  expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
  expect(Math.round(a!.width)).toBe(Math.round(b!.width));
});
