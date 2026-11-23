import { expect, test, type Page } from "@playwright/test";

// dashboards/sales-report.dash.json: a table of api/order_lines.sql with the parameter bar its `-- param:` lines make
// (SSRS-like). The rows come from the API with the values; the browser does not aggregate them (no DuckDB-wasm).
const ALL = ["中国・四国", "中部", "九州・沖縄", "北海道・東北", "近畿", "関東"];
const bar = (page: Page) => page.locator(".devbi-params");
const field = (page: Page, name: string) => bar(page).locator(`[data-param="${name}"]`);
const lines = (page: Page) => page.locator('[data-tile="lines"]');

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
  // The choices first, then the table with every region (`default=all` waits for them).
  expect(seen.api[0]).toEqual({ name: "regions", params: {} });
  expect(seen.reads()).toEqual([{ from: "2024-04-01", to: null, regions: ALL }]);

  // Two regions: read again with them, and the link keeps them.
  await field(page, "regions").getByRole("button").click();
  await page.getByRole("button", { name: "すべて外す" }).click();
  await page.getByRole("checkbox", { name: "関東" }).check();
  await page.getByRole("checkbox", { name: "近畿" }).check();
  await page.keyboard.press("Escape");
  await expect(field(page, "regions").getByRole("button")).toHaveText("近畿、関東");
  await expect.poll(() => seen.reads().at(-1)).toEqual({ from: "2024-04-01", to: null, regions: ["近畿", "関東"] });
  await expect(lines(page)).not.toContainText("九州・沖縄");
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe("#/sales-report?from=2024-04-01&regions=近畿&regions=関東");

  // The last day: typed (Enter), and sent.
  await field(page, "to").getByLabel("受注日（まで）").fill("2024-04-30");
  await field(page, "to").getByLabel("受注日（まで）").press("Enter");
  await expect.poll(() => seen.reads().at(-1)).toEqual({ from: "2024-04-01", to: "2024-04-30", regions: ["近畿", "関東"] });
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
  expect(seen.reads().at(-1)).toEqual({ from: "2024-04-01", to: "2024-04-30", regions: ["近畿", "関東"] });
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
  await expect.poll(() => seen.reads().at(-1)).toEqual({ from: "2024-04-01", to: "2024-04-30", regions: ["九州・沖縄"] });
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
  await expect.poll(() => seen.reads().at(-1)).toEqual({ from: "2024-04-01", to: "2024-04-30", regions: ["関東"] });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { heard: unknown[] }).heard.at(-1)))
    .toEqual({ from: "2024-04-01", to: "2024-04-30", regions: ["関東"] });
  expect(new URL(page.url()).hash).toBe("");
  expect(seen.errors).toEqual([]);
});
