import { expect, test } from "@playwright/test";

// The same orders as data/sales.xlsx, kept in db/sales.sqlite and read through api/orders.sql (devbi-serve).
const tile = (page: import("@playwright/test").Page, id: string) => page.locator(`[data-tile="${id}"]`);
const kpi = (page: import("@playwright/test").Page, id: string) => tile(page, id).getByTestId("kpi-value");

test("a dashboard reads a database through the API and shows the same numbers as the Excel one", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const api: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) api.push(`${r.method()} ${new URL(r.url()).pathname} ${r.postData() ?? ""}`);
  });
  await page.goto("/#/sales-db");
  await expect(kpi(page, "kpi-revenue")).toHaveText(/^¥[\d,]+$/);
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  await expect(page.locator(".devbi-error")).toHaveCount(0);
  await tile(page, "period").getByRole("button", { name: "全期間" }).click();
  await expect(kpi(page, "kpi-revenue")).toHaveText("¥193,161,410");
  await expect(tile(page, "region").locator("li")).toHaveCount(6);
  // One request for the whole dashboard: the browser aggregates the rows itself. The SQL stays on the server.
  expect(api).toEqual(['POST /api/query {"name":"orders","params":{"from":"2024-04-01"}}']);
  expect(errors).toEqual([]);
});

test("the API lists its SQL files and answers in Japanese when something is wrong", async ({ request }) => {
  const schema = await (await request.get("/api/schema")).json();
  expect(schema.datasets).toEqual([
    { name: "orders", description: expect.stringContaining("受注の明細"), params: ["from"], connection: "DEVBI_DB" },
    { name: "sales_daily", description: expect.stringContaining("日・地域・商品分類"), params: ["from"], connection: "DEVBI_DB", snapshot: ["06:00"] },
  ]);
  // The snapshots, and when each was made (devbi-serve makes a missing one when it starts, or when it is asked for).
  expect(schema.snapshots).toEqual([expect.objectContaining({ name: "sales_daily", params: { from: "2024-04-01" }, times: ["06:00"], models: ["sales_daily"] })]);
  expect((await request.get(`/snapshots/${encodeURIComponent(schema.snapshots[0].file)}`)).status()).toBe(200);
  expect((await (await request.get("/api/schema")).json()).snapshots[0].updatedAt).toEqual(expect.any(String));
  const res = await request.post("/api/query", { data: { name: "orders", params: {} } });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toBe("api/orders.sql: パラメーター :from の値がありません。read_api('orders', from = ...) と書きます");
});

test("no rows, or a computed column with only NULLs: the tiles still work", async ({ page }) => {
  const { toArrowStream } = await import("@devbi/server");
  const columns = [
    { name: "受注日", type: "date" },
    { name: "受注番号", type: "string" },
    { name: "顧客", type: "string" },
    { name: "地域", type: "string" },
    { name: "商品分類", type: "string" },
    { name: "商品", type: "string" },
    { name: "数量", type: "int" },
    { name: "単価", type: "int" },
    // SQLite's l.qty * l.unit_price: an expression, with no values to tell its type by.
    { name: "金額", type: "null" },
  ] as const;
  for (const rows of [[], [["2026-05-01", "A-1", "顧客 1", "関東", "文具", "ノート", 2, 300, null]]]) {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/query", (route) =>
      route.fulfill({ status: 200, contentType: "application/vnd.apache.arrow.stream", body: Buffer.from(toArrowStream({ columns: [...columns], rows })) }),
    );
    await page.goto("/");
    await page.goto("/#/sales-db");
    await expect(page.locator("[data-tile]").first()).toBeVisible();
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
    await expect(page.locator(".devbi-error")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.unrouteAll();
  }
});
