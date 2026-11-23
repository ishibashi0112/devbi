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

test("the ファイル出力 menu stays on the screen, also when the button has wrapped to the left", async ({ page }) => {
  await page.goto("/#/sales");
  await expect(page.locator('[data-tile="kpi-revenue"]').getByTestId("kpi-value")).toHaveText(/^¥[\d,]+$/);
  const width = page.viewportSize()!.width;
  const inside = async () => {
    await page.getByRole("button", { name: "ファイル出力" }).click();
    const box = (await page.getByRole("menu", { name: "ファイル出力" }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
  };
  await inside();
  // As an error after the button does (it takes the rest of the line, and the button wraps to the left).
  await page.evaluate(() => {
    const span = document.createElement("span");
    span.className = "devbi-error";
    span.textContent = "CSV に書き出せませんでした: とても長いエラーの文がここに入り、見出しの右の列をいっぱいに使います";
    document.querySelector(".devbi-actions")!.append(span);
  });
  const button = (await page.getByRole("button", { name: "ファイル出力" }).boundingBox())!;
  expect(button.x).toBeLessThan(width / 2);
  await inside();
});
