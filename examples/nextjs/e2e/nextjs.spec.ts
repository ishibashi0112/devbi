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
  expect(schema.datasets.map((d: { name: string }) => d.name)).toEqual(["customer_totals", "customers", "order_lines", "orders", "regions", "sales_daily"]);
  const wrongType = await request.post("/devbi/api/query", { headers: { "Content-Type": "text/plain" }, data: "{}" });
  expect([wrongType.status(), (await wrongType.json()).error]).toEqual([415, "Content-Type: application/json で送ってください"]);
  const noName = await request.post("/devbi/api/query", { data: { name: "nope" } });
  expect([noName.status(), (await noName.json()).error]).toEqual([404, "API の SQL nope はありません（api/nope.sql）"]);
  expect((await request.get("/devbi/api/query")).status()).toBe(405);
  const typed = await request.post("/devbi/api/query", { data: { name: "order_lines", params: { from: "2024-04-01", to: null, regions: ["関東", "近畿"], customer: null } } });
  expect([typed.status(), typed.headers()["x-devbi-rows"]]).toEqual([200, "3647"]);
  const badDate = await request.post("/devbi/api/query", { data: { name: "order_lines", params: { from: "2024/04/01", to: null, regions: ["関東"], customer: null } } });
  expect([badDate.status(), (await badDate.json()).error]).toEqual([
    400,
    "api/order_lines.sql: パラメーター from には日付（'2024-04-01' の形の文字）を渡してください（\"2024/04/01\" が来ました）",
  ]);
  const other = await request.get("/devbi/api/schema", { headers: { Host: "elsewhere.example" } });
  expect(other.status()).toBe(403);
});

// 「担当の売上」: the row-level security example (examples/sales/e2e/rls), its API in app/devbi-rls/[...path]/route.ts
// with the user of the app's session (lib/session.ts), and requireUser.
test("「担当の売上」 shows each person who signs in only their own region's orders", async ({ page }) => {
  const { errors } = watch(page);
  await page.goto("/");
  await page.getByRole("link", { name: "担当の売上（ログイン）" }).click();
  await expect(page.getByRole("button", { name: "山田（関東の担当）としてログイン" })).toBeVisible();
  await expect(page.locator(".devbi-root")).toHaveCount(0);
  await page.getByRole("button", { name: "山田（関東の担当）としてログイン" }).click();
  await expect(page.getByTestId("signed-in")).toHaveText("山田（関東の担当）（CORP\\yamada）でログインしています");
  await expect(kpi(page, "kpi-revenue")).toHaveText("¥72,393,280");
  await expect(tile(page, "region").locator("li")).toHaveCount(1);
  await expect(tile(page, "region").locator("li")).toContainText("関東");
  // region_totals (-- access: all) shows every region to everyone
  await expect(tile(page, "all-regions")).toContainText("中国・四国");
  await expect(tile(page, "all-regions")).toContainText("¥8,568,450");

  // Another person: a whole new page (the form's 303), with no rows of the one before.
  await page.getByRole("button", { name: "ログアウト" }).click();
  await page.getByRole("button", { name: "鈴木（近畿の担当）としてログイン" }).click();
  await expect(kpi(page, "kpi-revenue")).toHaveText("¥42,290,840");
  await expect(tile(page, "region").locator("li")).toHaveCount(1);
  await expect(tile(page, "region").locator("li")).toContainText("近畿");
  expect(errors).toEqual([]);
});

test("「担当の売上」 refuses who has no region (403), and anyone without the app's session (401)", async ({ page, request }) => {
  await page.goto("/my");
  await page.getByRole("button", { name: "佐藤（担当の地域なし）としてログイン" }).click();
  await expect(tile(page, "kpi-revenue")).toContainText("API の orders を読めません（403）: 利用者 CORP\\sato に属性 region がありません（api/orders.sql の :user.region）");

  const nobody = await request.get("/devbi-rls/api/schema");
  expect([nobody.status(), await nobody.json()]).toEqual([401, { error: "ログインしていません（ポータルの「担当の売上（ログイン）」からログインします）", access: 1 }]);
  // A cookie the server did not sign is nobody's.
  const forged = await request.get("/devbi-rls/api/schema", { headers: { Cookie: "portal_session=yamada.AAAA" } });
  expect(forged.status()).toBe(401);
  // A form on another site cannot sign anyone in.
  const crossSite = await request.post("/session", { form: { person: "yamada" }, headers: { "Sec-Fetch-Site": "cross-site" }, maxRedirects: 0 });
  expect(crossSite.status()).toBe(403);

  const signIn = await request.post("/session", { form: { person: "yamada" }, maxRedirects: 0 });
  expect([signIn.status(), signIn.headers()["location"]]).toEqual([303, "/my"]);
  const schema = await (await request.get("/devbi-rls/api/schema")).json();
  expect(schema.datasets.map((d: { name: string }) => d.name)).toEqual(["orders", "region_totals"]);
  expect([schema.access, schema.user]).toEqual([1, { id: "CORP\\yamada" }]);
  // The browser's parameters cannot be the user's: user.region is not a parameter.
  const asOther = await request.post("/devbi-rls/api/query", { data: { name: "orders", params: { from: "2024-04-01", "user.region": "近畿" } } });
  expect(asOther.status()).toBe(400);
});
