import { expect, test, type Page } from "@playwright/test";

// public/embed-demo.html: "another app's page" with its own CSS, one <div data-devbi="sales-db"> and devbi-embed.js.
const tile = (page: Page, id: string) => page.locator(`[data-tile="${id}"]`);
const kpi = (page: Page, id: string) => tile(page, id).getByTestId("kpi-value");
const report = (page: Page) => page.locator("#report-area");

test.use({ colorScheme: "dark" });

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const api: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) api.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await page.goto("/embed-demo.html");
  await expect(kpi(page, "kpi-revenue")).toHaveText(/^¥[\d,]+$/);
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  return { errors, api };
}

test("one script and a data-devbi element put a dashboard into another app's page, light like the page", async ({ page }) => {
  const { errors, api } = await open(page);
  const root = report(page).locator(".devbi-root");
  await expect(root.locator(".devbi-head h1")).toHaveText("売上ダッシュボード（DB から）");
  await expect(page.locator(".devbi-error")).toHaveCount(0);
  await tile(page, "period").getByRole("button", { name: "全期間" }).click();
  await expect(kpi(page, "kpi-revenue")).toHaveText("¥193,161,410");
  expect(api).toEqual(["POST /api/query"]);

  // data-devbi-theme="light": light although the OS is dark, the table too.
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(root).toHaveCSS("background-color", "rgb(246, 247, 249)");
  await expect(tile(page, "products").locator(".ssg-root")).not.toHaveClass(/ssg-theme-dark/);

  // The page's CSS for h1, header and td stays out of the dashboard; its own h1 keeps it.
  await expect(page.locator("main > h1")).toHaveCSS("color", "rgb(138, 28, 28)");
  await expect(root.locator(".devbi-head h1")).toHaveCSS("color", "rgb(29, 35, 48)");
  await expect(root.locator(".devbi-head h1")).toHaveCSS("text-transform", "none");
  await expect(tile(page, "kpi-revenue").locator(".devbi-tile-title")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(tile(page, "region").locator("li").first()).toHaveCSS("list-style-type", "none");
  expect(errors).toEqual([]);
});

test("from JavaScript: the list of dashboards, mount to switch, mountAll for elements added later, unmount", async ({ page }) => {
  const { errors } = await open(page);
  expect(await page.evaluate(() => (window as unknown as { DevBI: { dashboards: { name: string }[] } }).DevBI.dashboards.map((d) => d.name))).toEqual([
    "sales",
    "sales-db",
  ]);

  // The page's own menu calls mount() with another dashboard: the Excel one, with the JSX tile.
  await page.locator("#report").selectOption("sales");
  await expect(report(page).locator(".devbi-head h1")).toHaveText("売上ダッシュボード");
  await expect(tile(page, "top-customers").locator("li").first()).toBeVisible();
  await expect(page.locator(".devbi-error")).toHaveCount(0);

  // A part of the page replaced (an UpdatePanel): mountAll() shows the new element and lets go of the old one.
  const added = await page.evaluate(() => {
    const devbi = (window as unknown as { DevBI: { mountAll(): number } }).DevBI;
    document.getElementById("report-area")!.remove();
    const div = document.createElement("div");
    div.id = "later";
    div.dataset.devbi = "nope";
    document.querySelector("main")!.append(div);
    return devbi.mountAll();
  });
  expect(added).toBe(1);
  await expect(page.locator("#later .devbi-error")).toHaveText("ダッシュボード nope がありません（あるのは sales, sales-db）");
  await page.evaluate(() => (window as unknown as { DevBI: { unmount(s: string): void } }).DevBI.unmount("#later"));
  await expect(page.locator("#later")).toBeEmpty();
  expect(errors).toEqual([]);
});

test("data-devbi-api: the API can be somewhere else (in the host app)", async ({ page }) => {
  const { errors, api } = await open(page);
  await page.evaluate(() => {
    const div = document.createElement("div");
    div.id = "elsewhere";
    div.dataset.devbi = "sales-db";
    div.dataset.devbiApi = "/host-app/devbi/api/";
    document.querySelector("main")!.append(div);
    (window as unknown as { DevBI: { mountAll(): number } }).DevBI.mountAll();
  });
  await expect(page.locator("#elsewhere [data-tile='kpi-revenue'] [data-testid='kpi-value']")).toHaveText(/^¥[\d,]+$/);
  // devbi-serve answers …/api/query under any path, standing in for the host app here.
  expect(api).toEqual(["POST /api/query", "POST /host-app/devbi/api/query"]);
  expect(errors).toEqual([]);
});
