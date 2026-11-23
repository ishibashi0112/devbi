import { expect, test, type Page } from "@playwright/test";
import { listSheets, readXlsx } from "devbi";
import { readFileSync } from "node:fs";

// dashboards/sales-report.dash.json: a table of api/order_lines.sql with the parameter bar its `-- param:` lines make
// (SSRS-like). The rows come from the API with the values; the browser does not aggregate them (no DuckDB-wasm).
const ALL = ["中国・四国", "中部", "九州・沖縄", "北海道・東北", "近畿", "関東"];
const bar = (page: Page) => page.locator(".devbi-params");
const field = (page: Page, name: string) => bar(page).locator(`[data-param="${name}"]`);
const lines = (page: Page) => page.locator('[data-tile="lines"]');
const customers = (page: Page) => page.locator('[data-tile="customers"]');
/** The texts of a column of a table tile (the rows drawn). */
const cells = (tile: ReturnType<Page["locator"]>, column: string) => tile.locator(`.ssg-body-row [role=gridcell][data-ssg-col-key="${column}"]`).allInnerTexts();

function watch(page: Page) {
  const api: { name: string; params: Record<string, unknown> }[] = [];
  const wasm: string[] = [];
  const errors: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/query")) api.push(r.postDataJSON());
    if (/\.wasm(\?|$)|duckdb/.test(r.url())) wasm.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return { api, wasm, errors, reads: () => api.filter((a) => a.name === "order_lines").map((a) => a.params) };
}

test("a report's parameters come from its SQL file, and changing one reads the dataset again", async ({ page }) => {
  const seen = watch(page);
  // The first day as a value in the link (the default, the start of this fiscal year, moves with the date).
  await page.goto("/#/sales-report?from=2024-04-01");
  await expect(field(page, "from").getByLabel("受注日（から）")).toHaveValue("2024-04-01");
  await expect(field(page, "to").getByLabel("受注日（まで）")).toHaveValue("");
  await expect(field(page, "regions").getByRole("button")).toHaveText("すべて（6）");
  await expect(lines(page)).toContainText("J10001");
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  // The table with every region (`default=all` waits for the choices) and no customer (optional, none by default).
  expect(seen.reads()).toEqual([{ from: "2024-04-01", to: null, regions: ALL, customer: null }]);

  // Two regions: read again with them, and the link keeps them.
  await field(page, "regions").getByRole("button").click();
  await page.getByRole("button", { name: "すべて外す" }).click();
  await page.getByRole("checkbox", { name: "関東" }).check();
  await page.getByRole("checkbox", { name: "近畿" }).check();
  await page.keyboard.press("Escape");
  await expect(field(page, "regions").getByRole("button")).toHaveText("近畿、関東");
  await expect.poll(() => seen.reads().at(-1)).toEqual({ from: "2024-04-01", to: null, regions: ["近畿", "関東"], customer: null });
  await expect(lines(page)).not.toContainText("九州・沖縄");
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe("#/sales-report?from=2024-04-01&regions=近畿&regions=関東");

  // The last day: typed (Enter), and sent.
  await field(page, "to").getByLabel("受注日（まで）").fill("2024-04-30");
  await field(page, "to").getByLabel("受注日（まで）").press("Enter");
  await expect.poll(() => seen.reads().at(-1)).toEqual({ from: "2024-04-01", to: "2024-04-30", regions: ["近畿", "関東"], customer: null });
  await expect(lines(page)).not.toContainText("2024/5/1");

  // 更新: the same values, read from the database again.
  const before = seen.reads().length;
  await page.getByRole("button", { name: "更新" }).click();
  await expect.poll(() => seen.reads().length).toBe(before + 1);
  expect(seen.reads().at(-1)).toEqual(seen.reads().at(-2));

  // A link opens with its values.
  await page.reload();
  await expect(field(page, "to").getByLabel("受注日（まで）")).toHaveValue("2024-04-30");
  await expect(field(page, "regions").getByRole("button")).toHaveText("近畿、関東");
  await expect(lines(page)).toContainText("J10003");
  expect(seen.reads().at(-1)).toEqual({ from: "2024-04-01", to: "2024-04-30", regions: ["近畿", "関東"], customer: null });
  expect(seen.wasm).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("a required parameter left empty: the tile says what to fill in, and reads nothing", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/#/sales-report?from=2024-04-01");
  await expect(lines(page)).toContainText("J10001");
  const reads = seen.reads().length;
  await field(page, "from").getByLabel("受注日（から）").fill("");
  await field(page, "from").getByLabel("受注日（から）").blur();
  await expect(lines(page).locator(".devbi-tile-needs")).toHaveText("受注日（から）を入れてください");
  await expect(lines(page).locator(".devbi-error")).toHaveCount(0);
  expect(seen.reads().length).toBe(reads);
  // A value in the address that does not fit: the default instead (the start of this fiscal year, April), and a warning.
  const warnings: string[] = [];
  page.on("console", (m) => m.type() === "warning" && warnings.push(m.text()));
  await page.goto("/#/sales-report?from=2024%2F04%2F01");
  await page.reload();
  await expect(field(page, "from").getByLabel("受注日（から）")).toHaveValue(/^\d{4}-04-01$/);
  expect(warnings).toContain('DevBI: アドレスのパラメーター from の値 "2024/04/01" は日付（2024-04-01 の形）ではないので使いません');
  expect(seen.errors).toEqual([]);
});

test("embedded: the page gives the values (data-devbi-params, mount) and hears of changes; the address stays the page's", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/embed-demo.html");
  await expect(page.locator("#report-area .devbi-head h1")).toHaveText("売上ダッシュボード（DB から）");
  // The app's own element, with the values as JSON.
  await page.evaluate(() => {
    const div = document.createElement("div");
    div.id = "lines-area";
    div.dataset.devbi = "sales-report";
    div.dataset.devbiParams = JSON.stringify({ from: "2024-04-01", to: "2024-04-30", regions: ["九州・沖縄"] });
    document.querySelector("main")!.append(div);
    (window as unknown as { DevBI: { mountAll(): number } }).DevBI.mountAll();
  });
  await expect.poll(() => seen.reads().at(-1)).toEqual({ from: "2024-04-01", to: "2024-04-30", regions: ["九州・沖縄"], customer: null });
  await expect(page.locator("#lines-area [data-param=regions] button")).toHaveText("九州・沖縄");
  // mount() again with other values: the dashboard stays, the values change; onParamsChange hears them.
  await page.evaluate(() => {
    const w = window as unknown as { DevBI: { mount(el: string, o: Record<string, unknown>): void }; heard: unknown[] };
    w.heard = [];
    w.DevBI.mount("#lines-area", {
      dashboard: "sales-report",
      params: { from: "2024-04-01", to: "2024-04-30", regions: ["関東"] },
      onParamsChange: (v: unknown) => w.heard.push(v),
    });
  });
  await expect.poll(() => seen.reads().at(-1)).toEqual({ from: "2024-04-01", to: "2024-04-30", regions: ["関東"], customer: null });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { heard: unknown[] }).heard.at(-1)))
    .toEqual({ from: "2024-04-01", to: "2024-04-30", regions: ["関東"], customer: null });
  expect(new URL(page.url()).hash).toBe("");
  expect(seen.errors).toEqual([]);
});

test("a report's table: its columns, groups by region with each group's sums, and a totals row", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/#/sales-report?from=2024-04-01");
  // options.columns: 顧客ID is hidden (a click reads it), 金額 has its format; 地域 groups the rows (groupBy).
  await expect(customers(page).locator("[role=columnheader] .ssg-header-label")).toHaveText(["地域", "顧客", "受注数", "数量", "金額"]);
  await expect(customers(page)).toContainText("九州・沖縄(3件)");
  await expect(customers(page).locator(".ssg-total-row").last()).toHaveText("合計3,02959,421¥193,161,410");
  // The lines' totals: only the columns with agg (数量 and 金額; not 単価). 合計 is in the pinned column's part.
  await expect(lines(page).locator(".ssg-total-row")).toHaveText(["合計", "59,421¥193,161,410"]);
  expect(seen.errors).toEqual([]);
});

test("a click on a customer's row shows their lines (options.click); a second click shows everyone's again", async ({ page }) => {
  const seen = watch(page);
  await page.goto("/#/sales-report?from=2024-04-01");
  await expect(lines(page)).toContainText("J10001");
  await customers(page).getByText("青葉工業", { exact: true }).click();
  // 青葉工業 is customer 5: the bar shows them, the link keeps them, and the lines are read again with them.
  await expect.poll(() => seen.reads().at(-1)).toEqual({ from: "2024-04-01", to: null, regions: ALL, customer: 5 });
  await expect(field(page, "customer").locator("option:checked")).toHaveText("青葉工業");
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe("#/sales-report?from=2024-04-01&customer=5");
  await expect.poll(async () => [...new Set(await cells(lines(page), "顧客"))]).toEqual(["青葉工業"]);
  await expect(lines(page).locator(".ssg-total-row").last()).toHaveText("2,673¥10,012,620");
  // The row stays marked, and only the lines read it (the customers' table does not read the customer).
  await expect(customers(page).locator('.ssg-body-cell.devbi-selected[data-ssg-col-key="顧客"]')).toHaveText("青葉工業");
  expect(seen.api.filter((a) => a.name === "customer_totals")).toHaveLength(1);

  await customers(page).getByText("青葉工業", { exact: true }).click();
  await expect(field(page, "customer").locator("option:checked")).toHaveText("（指定なし）");
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe("#/sales-report?from=2024-04-01");
  await expect(lines(page)).toContainText("J10001");
  await expect(customers(page).locator(".ssg-body-cell.devbi-selected")).toHaveCount(0);
  expect(seen.errors).toEqual([]);
});

test("the viewer's changes to a table stay while the parameters change, through a reading with no rows", async ({ page }) => {
  await page.goto("/#/sales-report?from=2024-04-01&to=2024-04-30");
  await expect(lines(page)).toContainText("J10001");
  const headers = lines(page).locator("[role=columnheader] .ssg-header-label");
  const before = await headers.allInnerTexts();
  const header = lines(page).getByRole("columnheader", { name: /商品分類/ });
  await header.hover();
  await header.getByRole("button", { name: "列メニュー" }).click();
  await page.getByRole("menuitem", { name: "この列でグループ化" }).click();
  await expect.poll(() => headers.allInnerTexts()).not.toEqual(before);
  const grouped = await headers.allInnerTexts();
  // 受注日（まで） before 受注日（から）: no rows (行番号 has no value to tell that it is a number).
  const to = field(page, "to").getByLabel("受注日（まで）");
  await to.fill("2024-03-01");
  await to.press("Enter");
  await expect(lines(page)).toContainText("行がありません");
  await to.fill("2024-04-30");
  await to.press("Enter");
  // April 2024: 172 lines, 1,667 pieces, ¥5,567,780.
  await expect(lines(page).locator(".ssg-total-row").last()).toContainText("1,667¥5,567,780");
  await expect(headers).toHaveText(grouped);
});

test("the viewer searches and filters a column; Excel writes the table as it is then, with its totals", async ({ page }) => {
  await page.goto("/#/sales-report?from=2024-04-01&to=2024-04-30");
  await expect(lines(page)).toContainText("J10001");
  await lines(page).getByPlaceholder("表の中を検索").fill("グリス");
  await expect.poll(async () => [...new Set(await cells(lines(page), "商品"))]).toEqual(["グリス"]);
  // The column's menu (⋮): only 関東.
  const header = lines(page).getByRole("columnheader", { name: /地域/ });
  await header.hover();
  await header.getByRole("button", { name: "列メニュー" }).click();
  await page.getByRole("menuitem", { name: "フィルター…" }).click();
  await page.getByRole("dialog").getByRole("checkbox", { name: "（すべて選択）" }).uncheck();
  await page.getByRole("dialog").getByRole("checkbox", { name: "関東" }).check();
  await page.getByRole("dialog").getByRole("button", { name: "閉じる" }).click();
  await expect.poll(async () => [...new Set(await cells(lines(page), "地域"))]).toEqual(["関東"]);
  const shown = await cells(lines(page), "受注番号");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Excel" }).click()]);
  const file = readFileSync((await download.path())!);
  expect(await listSheets(file)).toEqual(["概要", "顧客別（行をクリックで、その顧客の明細）", "受注明細"]);
  // Each cell as text (header: false reads every column as text; empty rows are left out).
  const sheet = await readXlsx(file, { sheet: "受注明細", header: false });
  const rows = sheet.columns[0]!.values.map((_, i) => sheet.columns.map((c) => c.values[i] as string | null));
  expect(rows[1]![0]).toMatch(/^パラメーター: 受注日（から） 2024-04-01、受注日（まで） 2024-04-30、/);
  expect(rows[2]![0]).toBe("表の検索・列のフィルターで絞った行です");
  // The rows shown (as they are filtered), under the table's headings, then the totals of those rows.
  const at = rows.findIndex((r) => r[0] === "受注日");
  expect(rows[at]).toEqual(["受注日", "受注番号", "行番号", "顧客", "地域", "商品分類", "商品", "数量", "単価", "金額"]);
  const body = rows.slice(at + 1, -1);
  expect(body.map((r) => r[1])).toEqual(shown);
  expect(new Set(body.map((r) => `${r[4]} ${r[6]}`))).toEqual(new Set(["関東 グリス"]));
  const total = rows.at(-1)!;
  expect(total[0]).toBe("合計");
  expect(total[9]).toBe(String(body.reduce((sum, r) => sum + Number(r[9]), 0)));
  // The customers' sheet: the group's column first, the hidden column left out.
  const by = await readXlsx(file, { sheet: "顧客別（行をクリックで、その顧客の明細）", range: "A4:E100" });
  expect(by.columns.map((c) => c.name)).toEqual(["地域", "顧客", "受注数", "数量", "金額"]);
});
