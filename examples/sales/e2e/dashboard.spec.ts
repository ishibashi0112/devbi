import { expect, test, type Page } from "@playwright/test";

const tile = (page: Page, id: string) => page.locator(`[data-tile="${id}"]`);
const kpi = (page: Page, id: string) => tile(page, id).getByTestId("kpi-value");

async function ready(page: Page) {
  await page.goto("/#/sales"); // by name: local_* dashboards from `pnpm try-xlsx` add an index page at "/"
  await expect(kpi(page, "kpi-revenue")).toHaveText(/^¥[\d,]+$/);
  // The period picker applies its default (the latest fiscal year) on load.
  await expect(page.locator(".devbi-filters")).toContainText("受注日");
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
}

test("renders every tile from the xlsx without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await expect(page.locator(".devbi-error")).toHaveCount(0);
  await expect(tile(page, "region").locator("li")).toHaveCount(6);
  await expect(tile(page, "monthly").locator("svg").first()).toBeVisible();
  await expect(tile(page, "top-customers").locator("li")).toHaveCount(10);
  await expect(tile(page, "region-quarter").locator("tfoot")).toContainText("合計");
  await expect(tile(page, "kpi-revenue")).toContainText("前年比");
  expect(errors).toEqual([]);
});

test("the period presets change every tile; comparisons need a bounded period", async ({ page }) => {
  await ready(page);
  await tile(page, "period").getByRole("button", { name: "全期間" }).click();
  await expect(kpi(page, "kpi-revenue")).toHaveText("¥193,161,410");
  await expect(tile(page, "kpi-revenue").locator("dd").last()).toHaveText("—");
  await expect(tile(page, "region-quarter").locator("tfoot td").last()).toHaveText("¥193,161,410");

  await tile(page, "period").getByRole("button", { name: "2025年度" }).click();
  await expect(tile(page, "kpi-revenue").locator("dd").last()).toHaveText(/^\d+\.\d%$/);
});

test("clicking a region cross-filters the other tiles but not itself", async ({ page }) => {
  await ready(page);
  const kanto = tile(page, "region").getByRole("button", { name: /関東/ });
  const kantoValue = (await kanto.locator(".devbi-barlist-value").innerText()).trim();
  const before = await kpi(page, "kpi-revenue").innerText();

  await kanto.click();
  await expect(kanto).toHaveAttribute("aria-pressed", "true");
  await expect(kpi(page, "kpi-revenue")).toHaveText(kantoValue);
  expect(kantoValue).not.toBe(before);
  await expect(tile(page, "region").locator("li")).toHaveCount(6);
  await expect(page.locator(".devbi-filters")).toContainText("地域: 関東");
  // The pivot is filtered too: one row plus totals.
  await expect(tile(page, "region-quarter").locator("tbody tr")).toHaveCount(1);
  await expect(tile(page, "region-quarter").locator("tfoot td").last()).toHaveText(kantoValue);

  await page.getByRole("button", { name: "地域の絞り込みを外す" }).click();
  await expect(kpi(page, "kpi-revenue")).toHaveText(before);
});

test("clicking a month bar selects that month", async ({ page }) => {
  await ready(page);
  const before = await kpi(page, "kpi-revenue").innerText();
  const svg = tile(page, "monthly").locator("svg").last();
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.6);
  await expect(page.locator(".devbi-chip")).toHaveCount(2);
  await expect(page.locator(".devbi-chip").nth(1)).toContainText(/受注日: 20\d\d年\d+月/);
  await expect(kpi(page, "kpi-revenue")).not.toHaveText(before);
});

test("the category list and the promoted JSX tile filter like built-in tiles", async ({ page }) => {
  await ready(page);
  await tile(page, "category").getByLabel("保守").check();
  await expect(tile(page, "products").locator("tbody tr")).toHaveCount(2);
  await expect(tile(page, "products").locator("tbody")).not.toContainText("部品");

  const first = tile(page, "top-customers").locator("ol button").first();
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".devbi-filters")).toContainText("顧客:");
  await page.getByRole("button", { name: "すべて解除" }).click();
  await expect(page.locator(".devbi-chip")).toHaveCount(0);
});

test("chart tooltips use the tile background in dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await ready(page);
  const svg = tile(page, "monthly").locator("svg").last();
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6);
  const tip = tile(page, "monthly").locator('g[aria-label="tip"] path').first();
  await expect(tip).toBeVisible();
  const fill = await tip.evaluate((el) => getComputedStyle(el).fill);
  const card = await tile(page, "monthly").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(fill).toBe(card);
});

test("the page's own script stays small; charts and the DuckDB engine load as their own files", async ({ page, request }) => {
  const html = await (await request.get("/")).text();
  const entry = /<script type="module"[^>]*src="\.\/assets\/([^"]+\.js)"/.exec(html)?.[1];
  expect(entry).toBeTruthy();
  const scripts = new Map<string, number>();
  page.on("response", (r) => {
    const name = new URL(r.url()).pathname.split("/").pop() ?? "";
    if (name.endsWith(".js")) r.body().then((b) => scripts.set(name, b.length), () => undefined);
  });
  await ready(page);
  await expect.poll(() => [entry!, ...[...scripts.keys()].filter((n) => /^(engine|PlotChart)-/.test(n))].filter((n) => scripts.has(n)).length).toBe(3);
  expect(scripts.get(entry!)).toBeLessThan(500_000);
});

test("a chart file that cannot be fetched (the site was rebuilt) asks for a reload, in Japanese", async ({ page }) => {
  await page.route(/\/assets\/PlotChart-[^/]+\.js$/, (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("/#/sales");
  await expect(tile(page, "monthly").locator(".devbi-error")).toContainText("ページを読み込み直してください");
  // Tiles that do not need the chart file still work.
  await expect(kpi(page, "kpi-revenue")).toHaveText(/^¥[\d,]+$/);
});
