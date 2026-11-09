import { expect, test, type Page } from "@playwright/test";

// dashboards/sales-malloy.dash.json: tiles whose query is written in Malloy or SQL over the rows of sales.metrics.yaml.
const tile = (page: Page, id: string) => page.locator(`[data-tile="${id}"]`);
/** ¥18,599,290 → 18599290 */
const yen = (text: string) => Number(text.replace(/[^\d]/g, ""));

async function ready(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#/sales-malloy");
  await expect(page.locator(".devbi-tile")).toHaveCount(5);
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  await expect(page.locator(".devbi-error")).toHaveCount(0);
  return errors;
}

/** The region tile's revenue per region. */
async function regions(page: Page): Promise<Map<string, number>> {
  const items = await tile(page, "region").getByRole("button").allInnerTexts();
  return new Map(items.map((t) => [t.split("\n")[0]!.trim(), yen(t.split("\n").at(-1)!)]));
}

/** The SQL table's revenue per category (the first and second columns). */
async function categories(page: Page): Promise<Map<string, number>> {
  const rows = tile(page, "share")
    .getByRole("row")
    .filter({ has: page.getByRole("gridcell") });
  const out = new Map<string, number>();
  for (const r of await rows.all()) {
    const cells = await r.getByRole("gridcell").allInnerTexts();
    out.set(cells[0]!.trim(), yen(cells[1]!));
  }
  return out;
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

test("Malloy and SQL tiles show the period's numbers, labelled and formatted as the metrics file says", async ({ page }) => {
  const errors = await ready(page);
  // The same numbers as the built-in tiles (2026年度): 関東 18,599,290; all regions 48,052,590.
  const byRegion = await regions(page);
  expect(byRegion.get("関東")).toBe(18_599_290);
  expect(sum(byRegion)).toBe(48_052_590);
  // SQL: the same total by category, with its share.
  expect(sum(await categories(page))).toBe(48_052_590);
  await expect(tile(page, "share").getByRole("columnheader")).toHaveText(["#", /^商品分類/, /^売上/, /^構成比（%）/]);
  // A Malloy pipeline (orders per customer, then customers per count): a chart.
  await expect(tile(page, "repeat").locator("svg").last()).toBeVisible();
  await expect(tile(page, "monthly").locator("svg").last()).toBeVisible();
  expect(errors).toEqual([]);
});

test("a click on a Malloy tile filters the others by the metrics file's dimension or month", async ({ page }) => {
  await ready(page);
  // group_by: 地域 is the dimension region: other tiles (Malloy and SQL) read only 関東's rows.
  await tile(page, "region").getByRole("button", { name: /関東/ }).click();
  await expect(page.locator(".devbi-filters")).toContainText("地域: 関東");
  await expect.poll(async () => sum(await categories(page))).toBe(18_599_290);
  await expect(tile(page, "region").getByRole("button", { name: /関東/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "すべて解除" }).click();

  // group_by: 月 is 受注日.month is the time column by month: a click selects that month (all months, without the period).
  await expect(page.locator(".devbi-chip")).toHaveCount(0);
  const svg = tile(page, "monthly").locator("svg").last();
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6);
  await expect(page.locator(".devbi-chip")).toHaveText([/受注日: 20\d\d年\d+月/]);
  await expect.poll(async () => sum(await categories(page))).toBeLessThan(48_052_590);

  // A column the metrics file does not have (受注回数) filters nothing.
  await page.getByRole("button", { name: "すべて解除" }).click();
  const repeat = tile(page, "repeat").locator("svg").last();
  const r = (await repeat.boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.3, r.y + r.height * 0.8);
  await page.mouse.click(r.x + r.width * 0.3, r.y + r.height * 0.8);
  await expect(tile(page, "repeat").getByRole("button", { name: /選択を解除/ })).toHaveCount(0);
  await expect(page.locator(".devbi-chip")).toHaveCount(0);
});
