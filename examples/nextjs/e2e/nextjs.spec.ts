import { expect, test, type Page } from "@playwright/test";

// The sales example's dashboards in a Next.js app: devbi-embed.js from public/devbi/, the API and the snapshots
// from app/devbi/[...path]/route.ts (createApiHandler's fetch).
const tile = (page: Page, id: string) => page.locator(`[data-tile="${id}"]`);
const kpi = (page: Page, id: string) => tile(page, id).getByTestId("kpi-value");

function watch(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const requests: string[] = [];
  page.on("request", (r) => {
    if (/\/devbi\/(api|snapshots)\//.test(r.url())) requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  return { errors, requests };
}

test("a dashboard in a Next.js page reads the database through the app's route.ts", async ({ page }) => {
  const { errors, requests } = watch(page);
  await page.goto("/");
  await expect(kpi(page, "kpi-revenue")).toHaveText(/^¥[\d,]+$/);
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  await expect(page.locator(".devbi-error")).toHaveCount(0);
  await tile(page, "period").getByRole("button", { name: "全期間" }).click();
  // The same total as the sales example's devbi-serve and the Excel file.
  await expect(kpi(page, "kpi-revenue")).toHaveText("¥193,161,410");
  await expect(tile(page, "region").locator("li")).toHaveCount(6);
  expect(requests).toEqual(["POST /devbi/api/query"]);
  // The app's CSS stays outside: its h1 is red, the dashboard's is not.
  await expect(page.locator("main > h1")).toHaveCSS("color", "rgb(138, 28, 28)");
  await expect(page.locator(".devbi-head h1")).toHaveCSS("color", "rgb(29, 35, 48)");
  expect(errors).toEqual([]);
});

test("a dashboard on a morning snapshot reads the file the server made, through the same route", async ({ page }) => {
  const { errors, requests } = watch(page);
  await page.goto("/daily");
  await tile(page, "period").getByRole("button", { name: "全期間" }).click();
  await expect(kpi(page, "kpi-revenue")).toHaveText("¥193,161,410");
  await expect(page.getByTestId("snapshot-note")).toHaveText(/^データは \d{1,2}月\d{1,2}日 \d{1,2}:\d{2} の時点（毎日 6:00 に更新）$/);
  expect(requests).toEqual([expect.stringMatching(/^GET \/devbi\/snapshots\/sales_daily~[0-9a-f]{16}\.arrows$/)]);
  expect(errors).toEqual([]);
});

test("moving between pages in the app (no reload) puts the other dashboard in, and back", async ({ page }) => {
  const { errors } = watch(page);
  await page.goto("/");
  await expect(kpi(page, "kpi-revenue")).toHaveText(/^¥[\d,]+$/);
  await page.getByRole("link", { name: "日次集計（毎朝）" }).click();
  await expect(page).toHaveURL(/\/daily$/);
  await expect(page.getByTestId("snapshot-note")).toBeVisible();
  await expect(page.locator(".devbi-root")).toHaveCount(1);
  await page.goBack();
  await expect(page.locator(".devbi-head h1")).toHaveText("売上ダッシュボード（DB から）");
  await expect(page.getByTestId("snapshot-note")).toHaveCount(0);
  await expect(page.locator(".devbi-root")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("the route answers like devbi-serve: the SQL files, Japanese errors, and only known host names", async ({ request }) => {
  const schema = await (await request.get("/devbi/api/schema")).json();
  expect(schema.datasets.map((d: { name: string }) => d.name)).toEqual(["orders", "sales_daily"]);
  const wrongType = await request.post("/devbi/api/query", { headers: { "Content-Type": "text/plain" }, data: "{}" });
  expect([wrongType.status(), (await wrongType.json()).error]).toEqual([415, "Content-Type: application/json で送ってください"]);
  const noName = await request.post("/devbi/api/query", { data: { name: "nope" } });
  expect([noName.status(), (await noName.json()).error]).toEqual([404, "API の SQL nope はありません（api/nope.sql）"]);
  expect((await request.get("/devbi/api/query")).status()).toBe(405);
  const other = await request.get("/devbi/api/schema", { headers: { Host: "elsewhere.example" } });
  expect(other.status()).toBe(403);
});
