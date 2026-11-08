import { expect, test, type Page } from "@playwright/test";
import { listSheets, readXlsx } from "devbi";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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
  // DevBI's own page: the project's CSS applies as written (no reset of plain elements, which is for embedding).
  await expect(page.locator(".devbi-root")).not.toHaveAttribute("data-devbi-isolate");
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
  // The list itself is not filtered: the other regions are dimmed.
  await expect(tile(page, "region").getByRole("button", { name: /近畿/ })).toHaveCSS("opacity", "0.45");
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
  const productRows = tile(page, "products").getByRole("row").filter({ has: page.getByRole("gridcell") });
  await expect(productRows).toHaveCount(2);
  await expect(tile(page, "products").getByRole("grid")).not.toContainText("部品");

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

test("the page's own script stays small; charts, the table grid and the DuckDB engine load as their own files", async ({ page, request }) => {
  const html = await (await request.get("/")).text();
  const entry = /<script type="module"[^>]*src="\.\/assets\/([^"]+\.js)"/.exec(html)?.[1];
  expect(entry).toBeTruthy();
  // What the page loads before anything else: its script and the files it imports (with embed: true, most of the
  // code sits in a file shared with devbi-embed.js).
  const first = [entry!, ...[...html.matchAll(/<link rel="modulepreload"[^>]*href="\.\/assets\/([^"]+\.js)"/g)].map((m) => m[1]!)];
  const scripts = new Map<string, number>();
  page.on("response", (r) => {
    const name = new URL(r.url()).pathname.split("/").pop() ?? "";
    if (name.endsWith(".js")) r.body().then((b) => scripts.set(name, b.length), () => undefined);
  });
  await ready(page);
  await expect.poll(() => [entry!, ...[...scripts.keys()].filter((n) => /^(engine|PlotChart|GridTable)-/.test(n))].filter((n) => scripts.has(n)).length).toBe(4);
  await expect.poll(() => first.filter((n) => scripts.has(n)).length).toBe(first.length);
  const size = first.reduce((sum, n) => sum + scripts.get(n)!, 0);
  expect(size).toBeGreaterThan(100_000); // the shared file is in it
  expect(size).toBeLessThan(500_000);
  // The Excel and print code comes with the first export.
  expect([...scripts.keys()].filter((n) => /^(xlsx|print)-/.test(n))).toEqual([]);
});

test("a chart file that cannot be fetched (the site was rebuilt) asks for a reload, in Japanese", async ({ page }) => {
  await page.route(/\/assets\/PlotChart-[^/]+\.js$/, (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("/#/sales");
  await expect(tile(page, "monthly").locator(".devbi-error")).toContainText("ページを読み込み直してください");
  // Tiles that do not need the chart file still work.
  await expect(kpi(page, "kpi-revenue")).toHaveText(/^¥[\d,]+$/);
});

test("the table tile (spreadsheet-grid): a row click or Enter filters the other tiles, the column menu sorts", async ({ page }) => {
  await ready(page);
  const products = tile(page, "products");
  const before = await kpi(page, "kpi-revenue").innerText();
  await products.getByRole("gridcell", { name: "ノギス" }).click();
  await expect(page.locator(".devbi-filters")).toContainText("商品: ノギス");
  await expect(kpi(page, "kpi-revenue")).not.toHaveText(before);
  // The table itself is not filtered: the other rows stay, dimmed.
  await expect(products.getByRole("gridcell", { name: "グリス" })).toHaveClass(/devbi-dimmed/);
  await products.getByRole("gridcell", { name: "ノギス" }).click();
  await expect(page.locator(".devbi-chip")).toHaveCount(1); // only the period is left
  // From the keyboard: Enter on the active cell selects its row; Shift+click only extends the copy range.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator(".devbi-filters")).toContainText("商品:");
  await page.keyboard.press("Enter");
  await expect(page.locator(".devbi-chip")).toHaveCount(1);
  await products.getByRole("gridcell", { name: "グリス" }).click({ modifiers: ["Shift"] });
  await expect(page.locator(".devbi-chip")).toHaveCount(1);

  // Fitted widths show every value whole (no "¥10,489,5…").
  const clipped = await products.getByRole("gridcell").evaluateAll((cells) =>
    cells
      .filter((c) => {
        const range = document.createRange();
        range.selectNodeContents(c);
        const box = c.firstElementChild ?? c;
        return range.getBoundingClientRect().width > box.getBoundingClientRect().width + 0.01;
      })
      .map((c) => (c as HTMLElement).innerText),
  );
  expect(clipped).toEqual([]);

  const header = products.getByRole("columnheader", { name: /数量/ });
  await header.hover();
  await header.getByRole("button", { name: "列メニュー" }).click();
  await page.getByText("昇順で並び替え").click();
  const quantities = async () =>
    (await products.locator('[role=gridcell][data-ssg-col-key="quantity"]').allInnerTexts()).map((q) => Number(q.replaceAll(",", "")));
  await expect.poll(async () => (await quantities()).length).toBeGreaterThan(1);
  await expect.poll(async () => {
    const n = await quantities();
    return n.every((v, i) => i === 0 || n[i - 1]! <= v);
  }).toBe(true);
});

test("a build has no GUI editor in it", async ({ page }) => {
  await ready(page);
  await expect(page.getByRole("button", { name: "編集", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "＋ 新しいダッシュボード" })).toHaveCount(0);
  const assets = path.resolve(import.meta.dirname, "../dist/assets");
  for (const f of readdirSync(assets).filter((f) => f.endsWith(".js"))) {
    const code = readFileSync(path.join(assets, f), "utf8");
    expect(code, f).not.toContain("__devbi/editor");
    expect(code, f).not.toContain("react-grid-layout");
  }
});

test("Excel saves each tile's data as filtered now: a sheet per tile, numbers and dates as Excel's own", async ({ page }) => {
  await ready(page);
  const kanto = tile(page, "region").getByRole("button", { name: /関東/ });
  await kanto.click();
  await expect(page.locator(".devbi-filters")).toContainText("地域: 関東");
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  const revenue = await kpi(page, "kpi-revenue").innerText();

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Excel" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^売上ダッシュボード_\d{8}-\d{4}\.xlsx$/);
  const file = readFileSync((await download.path())!);
  // The summary, then the tiles that read data, in the dashboard's order (not the period picker or the text).
  expect(await listSheets(file)).toEqual([
    "概要",
    "売上",
    "受注件数",
    "平均受注額",
    "数量",
    "月別売上",
    "地域別売上",
    "売上と前年同月",
    "商品分類別の推移",
    "上位顧客（自作タイル）",
    "地域 × 四半期",
    "商品分類",
    "商品別",
  ]);
  const summary = await readXlsx(file, { sheet: "概要", header: false });
  const [keys, values] = summary.columns.map((c) => c.values);
  expect(values![keys!.indexOf("絞り込み")]).toMatch(/^受注日: .+、地域: 関東$/);
  expect(keys).toContain("上位顧客（自作タイル）");

  // A number stays a number (shown as ¥18,599,290 by its format), filtered by the other tiles' selections.
  const kpiSheet = await readXlsx(file, { sheet: "売上", range: "A4:C5" });
  expect(kpiSheet.columns.map((c) => c.name)).toEqual(["売上", "売上 前年", "売上 前年比"]);
  expect(`¥${(kpiSheet.columns[0]!.values[0] as number).toLocaleString("ja-JP")}`).toBe(revenue);
  expect(kpiSheet.columns[2]!.type).toBe("DOUBLE");
  // Months are dates; the tile that was clicked is not filtered by its own selection (as on the screen).
  const monthly = await readXlsx(file, { sheet: "月別売上", range: "A4:B100" });
  expect(monthly.columns.map((c) => [c.name, c.type])).toEqual([
    ["受注日", "DATE"],
    ["売上", "BIGINT"],
  ]);
  expect((await readXlsx(file, { sheet: "地域別売上", range: "A4:B100" })).rowCount).toBe(6);
  // The pivot as its cross table, with totals.
  const pivot = (await readXlsx(file, { sheet: "地域 × 四半期", range: "A4:Z100" })).columns.filter((c) => c.values.some((v) => v !== null));
  expect(pivot[0]!.values).toEqual(["関東", "合計"]);
  expect(pivot.at(-1)!.name).toBe("合計");
  expect(pivot.length).toBeGreaterThan(2);
  expect(pivot.slice(1, -1).every((c) => /^\d{4}年Q\d$/.test(c.name) && c.type === "BIGINT")).toBe(true);
});

/** Instead of the print dialog: keeps what the 印刷・PDF button's hidden frame holds when it prints. */
async function catchPrint(page: Page) {
  await page.evaluate(() => {
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!(n instanceof HTMLIFrameElement) || n.dataset.devbiPrintFrame === undefined) continue;
          n.addEventListener("load", () => {
            n.contentWindow!.print = () => ((window as unknown as { printed: string }).printed = n.contentDocument!.title);
          });
        }
      }
    }).observe(document.body, { childList: true });
  });
}

test("印刷・PDF prints a copy of the dashboard: light, without the buttons, tiles kept whole on a page", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await ready(page);
  await tile(page, "region").getByRole("button", { name: /関東/ }).click();
  await tile(page, "category").getByLabel("保守").check();
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  await catchPrint(page);
  await page.getByRole("button", { name: "印刷・PDF" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { printed?: string }).printed)).toMatch(/^売上ダッシュボード_\d{8}$/);
  await expect(page.getByRole("button", { name: "印刷・PDF" })).toBeEnabled();

  const frame = page.frameLocator("iframe[data-devbi-print-frame]");
  const copy = frame.locator(".devbi-root");
  await expect(copy).toHaveAttribute("data-theme", "light");
  await expect(copy.locator("[data-tile]")).toHaveCount(await page.locator("[data-tile]").count());
  // The charts as drawn, the selection, the selected period's buttons.
  await expect(copy.locator('[data-tile="monthly"] svg').first()).toBeVisible();
  await expect(copy.locator(".devbi-chip").filter({ hasText: "地域: 関東" })).toHaveCount(1);
  await expect(copy.locator('[data-tile="category"]').getByLabel("保守")).toBeChecked();
  await expect(copy.locator('[data-tile="period"] input[type="date"]').first()).toHaveValue(
    await tile(page, "period").locator('input[type="date"]').first().inputValue(),
  );
  // Bands of rows that no tile crosses, each kept on one page.
  expect(await copy.locator(".devbi-print-band").count()).toBeGreaterThan(3);
  // On paper: white, the time it was printed, no buttons.
  await page.emulateMedia({ media: "print", colorScheme: "dark" });
  await expect(copy).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(copy.locator(".devbi-printed")).toHaveText(/^\d{4}\/\d+\/\d+ \d+:\d\d の表示$/);
  await expect(copy.locator(".devbi-actions")).toBeHidden();
  await expect(copy.locator(".devbi-chip button")).toHaveCount(3);
  for (const button of await copy.locator(".devbi-chip button").all()) await expect(button).toBeHidden();
  // The page itself is as it was.
  await page.emulateMedia({ media: "screen" });
  await expect(page.locator(".devbi-root[data-devbi-print], .devbi-printed")).toHaveCount(0);
});
