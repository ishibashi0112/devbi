import { expect, test, type Page } from "@playwright/test";
import { listSheets, readXlsx } from "devbi";
import { readFileSync } from "node:fs";

// The explore tile (Perspective) on dashboards/sales-explore.dash.json: the period's order lines, grouped by 商品分類.
const tile = (page: Page, id: string) => page.locator(`[data-tile="${id}"]`);

type Viewer = HTMLElement & {
  getView(): Promise<{ to_json(w: { start_row: number; end_row: number }): Promise<Record<string, unknown>[]> }>;
  getTable(): Promise<{ size(): Promise<number> }>;
  save(): Promise<{ group_by: string[] }>;
  restore(c: object): Promise<void>;
};
const viewer = (page: Page) => page.locator("perspective-viewer");
/** The viewer's total row (the first of a grouped view); none while it is loading new rows ("No table set"). */
const totals = (page: Page) =>
  viewer(page).evaluate(async (el) => {
    try {
      return (await (await (el as Viewer).getView()).to_json({ start_row: 0, end_row: 1 }))[0];
    } catch {
      return undefined;
    }
  });
const loaded = (page: Page) => viewer(page).evaluate(async (el) => (await (el as Viewer).getTable()).size());
/** The tables Perspective's engine holds (one per explore tile, however often the rows were loaded). */
const hosted = (page: Page) =>
  viewer(page).evaluate(async (el) => {
    const table = (await (el as Viewer).getTable()) as unknown as {
      get_client(): Promise<{ get_hosted_table_names(): Promise<string[]> }>;
    };
    return (await (await table.get_client()).get_hosted_table_names()).length;
  });
/** ¥18,599,290 → 18599290 */
const yen = (text: string) => Number(text.replace(/[^\d]/g, ""));

async function ready(page: Page) {
  await page.goto("/#/sales-explore");
  await expect(page.locator('.devbi-explore[aria-busy="false"]')).toHaveCount(1);
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
}

/** The region tile's revenue per region. */
async function regions(page: Page): Promise<Map<string, number>> {
  const items = await tile(page, "region").getByRole("button").allInnerTexts();
  return new Map(items.map((t) => [t.split("\n")[0]!.trim(), yen(t.split("\n").at(-1)!)]));
}

test("the explore tile shows the period's rows in Perspective, laid out as dash.json says, with Japanese labels", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await expect(page.locator(".devbi-error")).toHaveCount(0);
  // The sum of the rows is the region tile's sum: the same period, the same data.
  const sum = [...(await regions(page)).values()].reduce((a, b) => a + b, 0);
  expect(sum).toBeGreaterThan(0);
  await expect.poll(async () => (await totals(page))?.["金額"]).toBe(sum);
  expect(await viewer(page).evaluate(async (el) => (await (el as Viewer).save()).group_by)).toEqual(["商品分類"]);
  // Whole numbers without ".00"; the settings in Japanese.
  await expect(viewer(page).locator("perspective-viewer-datagrid")).toContainText(sum.toLocaleString("en-US"));
  expect(await viewer(page).evaluate((el) => getComputedStyle(el).getPropertyValue("--group-by-label--content").trim())).toBe('"行"');
  expect(errors).toEqual([]);
});

test("clicking a region filters the explore tile, which keeps how the viewer was arranged", async ({ page }) => {
  await ready(page);
  await viewer(page).evaluate((el) => (el as Viewer).restore({ group_by: ["商品"] }));
  const all = await loaded(page);
  await tile(page, "region").getByRole("button", { name: /関東/ }).click();
  await expect(page.locator(".devbi-filters")).toContainText("地域: 関東");
  const kanto = (await regions(page)).get("関東")!;
  await expect.poll(async () => (await totals(page))?.["金額"]).toBe(kanto);
  await expect(page.locator('.devbi-explore[aria-busy="false"]')).toHaveCount(1);
  expect(await loaded(page)).toBeLessThan(all);
  expect(await viewer(page).evaluate(async (el) => (await (el as Viewer).save()).group_by)).toEqual(["商品"]);

  // Each load replaces the table, and leaving the dashboard deletes it.
  await expect.poll(() => hosted(page)).toBe(1);
  await page.evaluate(() => (location.hash = "#/sales"));
  await expect(page.locator("perspective-viewer")).toHaveCount(0);
  await page.evaluate(() => (location.hash = "#/sales-explore"));
  await expect(page.locator('.devbi-explore[aria-busy="false"]')).toHaveCount(1);
  await expect.poll(() => hosted(page)).toBe(1);
});

test("Excel writes the explore tile's rows; 印刷・PDF prints its view as a table", async ({ page }) => {
  await ready(page);
  const rows = await loaded(page);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Excel" }).click()]);
  const file = readFileSync((await download.path())!);
  expect(await listSheets(file)).toEqual(["概要", "地域別売上", "明細"]);
  const sheet = await readXlsx(file, { sheet: "明細", range: "A5:I200000" });
  expect(sheet.rowCount).toBe(rows);
  expect(sheet.columns.map((c) => c.name)).toEqual(["受注日", "受注番号", "顧客", "地域", "商品分類", "商品", "数量", "単価", "金額"]);
  expect(sheet.columns[0]!.type).toBe("DATE");
  const total = sheet.columns.at(-1)!.values.reduce((a: number, v) => a + (v as number), 0);
  expect(total).toBe((await totals(page))?.["金額"]);

  // In print, the view as a table (Perspective draws in a shadow DOM a copy cannot show).
  await page.evaluate(() => {
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!(n instanceof HTMLIFrameElement) || n.dataset.devbiPrintFrame === undefined) continue;
          n.addEventListener("load", () => {
            n.contentWindow!.print = () => ((window as unknown as { printed: boolean }).printed = true);
          });
        }
      }
    }).observe(document.body, { childList: true });
  });
  await page.getByRole("button", { name: "印刷・PDF" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { printed?: boolean }).printed)).toBe(true);
  const printed = page.frameLocator("iframe[data-devbi-print-frame]").locator('[data-tile="explore"] .devbi-explore-print table');
  await expect(printed.locator("thead")).toContainText("商品分類");
  await expect(printed.locator("tbody tr").first()).toContainText(`合計${total.toLocaleString("ja-JP")}`);
});
