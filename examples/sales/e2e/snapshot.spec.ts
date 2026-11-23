import { expect, test, type Page } from "@playwright/test";

// dashboards/sales-daily.dash.json reads api/sales_daily.sql, which has "-- snapshot: 06:00": devbi-serve makes the
// file when it starts (and every morning), and the browser reads that file, not the API.
const tile = (page: Page, id: string) => page.locator(`[data-tile="${id}"]`);
const kpi = (page: Page, id: string) => tile(page, id).getByTestId("kpi-value");

test("a dashboard on a morning snapshot reads the saved file, not the database, and says when it was taken", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests: string[] = [];
  page.on("request", (r) => {
    if (/\/(api|snapshots)\//.test(r.url())) requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await page.goto("/#/sales-daily");
  await expect(kpi(page, "kpi-revenue")).toHaveText(/^¥[\d,]+$/);
  await tile(page, "period").getByRole("button", { name: "全期間" }).click();
  // Summed by day, region and category in the database: the same total as the order lines.
  await expect(kpi(page, "kpi-revenue")).toHaveText("¥193,161,410");
  await expect(tile(page, "category").locator("tfoot")).toContainText("¥193,161,410");
  await expect(page.getByTestId("snapshot-note")).toHaveText(/^データは \d{1,2}月\d{1,2}日 \d{1,2}:\d{2} の時点（毎日 6:00 に更新）$/);
  expect(requests).toEqual([expect.stringMatching(/^GET \/snapshots\/sales_daily~[0-9a-f]{16}\.arrows$/)]);
  expect(errors).toEqual([]);
});

test("a report's choices on a morning snapshot: the page reads the saved file, not the database", async ({ page }) => {
  // api/regions.sql (the regions' choices of sales-report) has "-- snapshot: 06:00" and no parameters: one file.
  const requests: string[] = [];
  page.on("request", (r) => {
    if (/\/(api|snapshots)\//.test(r.url())) requests.push(`${r.method()} ${new URL(r.url()).pathname} ${r.postDataJSON()?.name ?? ""}`.trim());
  });
  await page.goto("/#/sales-report?from=2024-04-01");
  await expect(page.locator('[data-param="regions"]').getByRole("button")).toHaveText("すべて（6）");
  await expect(tile(page, "lines")).toContainText("J10001");
  expect(requests).toContain("GET /snapshots/regions.arrows");
  expect(requests).not.toContain("POST /api/query regions");
  // Choices are not a tile: no "as of" note on the tiles.
  await expect(page.locator(".devbi-tile-note")).toHaveCount(0);
});

test("the list of dashboards says which ones are taken every morning", async ({ page }) => {
  await page.goto("/");
  const items = page.locator(".devbi-index li");
  await expect(items).toHaveCount(6);
  await expect(items.filter({ hasText: "日次集計" })).toContainText("毎日 6:00 の時点のデータ");
  await expect(items.filter({ hasText: "DB から" })).not.toContainText("時点のデータ");
});

test("the dashboards that ask the API each time say nothing about a time", async ({ page }) => {
  await page.goto("/#/sales-db");
  await expect(kpi(page, "kpi-revenue")).toHaveText(/^¥[\d,]+$/);
  await expect(page.getByTestId("snapshot-note")).toHaveCount(0);
});

test("without the file (a static site before devbi-snapshot ran, or the SQL changed since the build) it reads the API", async ({ page }) => {
  await page.route(/\/snapshots\/[^/]+\.arrows$/, (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "見つかりません" }));
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(new URL(r.url()).pathname);
  });
  await page.goto("/#/sales-daily");
  await tile(page, "period").getByRole("button", { name: "全期間" }).click();
  await expect(kpi(page, "kpi-revenue")).toHaveText("¥193,161,410");
  expect(posts).toEqual(["/api/query"]);
  // Read as it is now: not "as of" a morning.
  await expect(page.getByTestId("snapshot-note")).toHaveCount(0);
});

test("without the file and without an API, the tiles say what to run", async ({ page }) => {
  await page.route(/\/snapshots\/[^/]+\.arrows$/, (route) => route.fulfill({ status: 404, body: "" }));
  await page.route(/\/api\/query$/, (route) => route.fulfill({ status: 405, body: "" }));
  await page.goto("/#/sales-daily");
  await expect(tile(page, "kpi-revenue")).toContainText(/sales_daily のスナップショット（snapshots\/sales_daily~[0-9a-f]{16}\.arrows）がありません。サーバーで devbi-snapshot を実行するか/);
});
