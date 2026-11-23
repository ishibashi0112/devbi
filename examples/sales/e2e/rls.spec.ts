// Row-level security on Vite's dev server: api/orders.sql in e2e/rls/ keeps the rows of the user's region
// (:user.region), and 「表示する利用者」 picks who the API answers as (devUsers in e2e/rls.vite.config.ts).
import { expect, test, type Page } from "@playwright/test";

const tile = (page: Page, id: string) => page.locator(`[data-tile="${id}"]`);
const kpi = (page: Page) => tile(page, "kpi-revenue").getByTestId("kpi-value");
const picker = (page: Page) => page.getByLabel("表示する利用者");

test("each user sees the rows of their own region; nobody signed in sees none", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  // Nobody picked yet: the API answers 401, and the tile says where to pick someone.
  await expect(picker(page)).toHaveValue("");
  await expect(tile(page, "kpi-revenue").locator(".devbi-error")).toHaveText("API の orders を読めません（401）: ログインしていません（上の『表示する利用者』で選びます）");

  await picker(page).selectOption("yamada");
  await expect(kpi(page)).toHaveText("¥72,393,280");
  await expect(picker(page)).toHaveValue("yamada");
  await expect(tile(page, "region").locator(".devbi-barlist-label")).toHaveText(["関東"]);
  // -- access: all: everyone gets every row (the company's totals by region)
  await expect(tile(page, "all-regions").getByText("中国・四国")).toBeVisible();

  await picker(page).selectOption("suzuki");
  await expect(kpi(page)).toHaveText("¥42,290,840");
  await expect(tile(page, "region").locator(".devbi-barlist-label")).toHaveText(["近畿"]);

  // A user without the attribute: 403, nothing runs
  await picker(page).selectOption("sato");
  await expect(tile(page, "kpi-revenue").locator(".devbi-error")).toHaveText("API の orders を読めません（403）: 利用者 sato に属性 region がありません（api/orders.sql の :user.region）");

  await picker(page).selectOption("");
  await expect(tile(page, "kpi-revenue").locator(".devbi-error")).toContainText("（401）");
  expect(errors).toEqual([]);
});

test("the browser cannot choose the user's values itself", async ({ request }) => {
  const ask = (params: Record<string, unknown>) =>
    request.post("/api/query", { headers: { Cookie: "devbi-dev-user=yamada" }, data: { name: "orders", params: { from: "2024-04-01", ...params } } });
  const sent = await ask({ "user.region": "近畿" });
  expect(sent.status()).toBe(400);
  expect((await sent.json()).error).toContain("パラメーター user.region は渡せません");
  // The schema says whom it answers as, and leaves the user's values out of the parameters.
  const schema = await (await request.get("/api/schema", { headers: { Cookie: "devbi-dev-user=yamada" } })).json();
  expect(schema.access).toBe(1);
  expect(schema.user).toEqual({ id: "CORP\\yamada" });
  expect(schema.datasets.find((d: { name: string }) => d.name === "orders").params).toEqual(["from"]);
});
