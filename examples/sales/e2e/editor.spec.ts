// The GUI editor (@devbi/editor) on Vite's dev server. It writes to e2e-work/ (see editor.vite.config.ts), which each
// test puts back first.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { appendFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const work = path.join(root, "e2e-work");
const original = readFileSync(path.join(root, "dashboards/sales.dash.json"), "utf8");
const metrics = readFileSync(path.join(root, "models/sales.metrics.yaml"), "utf8");
const salesFile = path.join(work, "dashboards/sales.dash.json");
const newFile = path.join(work, "dashboards/monthly.dash.json");
/** The sales dashboard's tile files: the example's own TopCustomers.tsx, and those the tests write ("コードにする"). */
const tilesDir = path.join(work, "dashboards/sales");

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  writeFileSync(salesFile, original);
  writeFileSync(path.join(work, "models/sales.metrics.yaml"), metrics);
  rmSync(newFile, { force: true });
  for (const f of readdirSync(tilesDir)) if (f !== "TopCustomers.tsx") rmSync(path.join(tilesDir, f));
});

const item = (page: Page, id: string) => page.locator(`[data-editor-tile="${id}"]`);

async function openEditor(page: Page) {
  await page.goto("/#/sales");
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await expect(item(page, "kpi-revenue").getByTestId("kpi-value")).toHaveText(/^¥[\d,]+$/);
  await expect(page.getByText("dashboards/sales.dash.json")).toBeVisible();
}

/** One grid column, in pixels (12 columns with 12px gaps). */
async function column(page: Page): Promise<number> {
  const grid = (await page.locator(".devbi-ed-grid").boundingBox())!;
  return (grid.width - 11 * 12) / 12 + 12;
}

async function drag(page: Page, target: Locator, dx: number, dy: number) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 8 });
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

/** A mark that a reload would wipe. */
const mark = (page: Page) => page.evaluate(() => ((window as unknown as { devbiMark: number }).devbiMark = 1));
const marked = (page: Page) => page.evaluate(() => (window as unknown as { devbiMark?: number }).devbiMark === 1);

test("resizing and moving tiles, then saving, changes only their lines in dash.json", async ({ page }) => {
  await openEditor(page);
  await mark(page);
  const step = await column(page);
  await drag(page, item(page, "monthly").locator(".react-resizable-handle-e"), -2 * step, 0);
  await expect(page.getByText("未保存の変更があります")).toBeVisible();
  await drag(page, item(page, "region").locator(".devbi-ed-cover"), -2 * step, 0);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  await expect(page.getByText("未保存の変更があります")).toHaveCount(0);

  const expected = original
    .replace(`"id": "monthly",\n      "x": 0, "y": 3, "w": 8, "h": 4`, `"id": "monthly",\n      "x": 0, "y": 3, "w": 6, "h": 4`)
    .replace(`"id": "region",\n      "x": 8, "y": 3, "w": 4, "h": 4`, `"id": "region",\n      "x": 6, "y": 3, "w": 4, "h": 4`);
  expect(expected).not.toBe(original);
  expect(readFileSync(salesFile, "utf8")).toBe(expected);
  // The page that saved does not reload for its own file.
  await page.waitForTimeout(1000);
  expect(await marked(page)).toBe(true);

  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(page.locator('[data-tile="region"]')).toHaveCSS("grid-column-start", "7");
  await expect(page.locator('[data-tile="monthly"]')).toHaveCSS("grid-column-end", "span 6");
});

test("adding a tile shows data at once; removing it can be undone", async ({ page }) => {
  await openEditor(page);
  // A tile in the middle: the ones below move up, and one undo puts everything back.
  await item(page, "monthly").hover();
  await item(page, "monthly").getByRole("button", { name: "月別売上を消す" }).click();
  await expect(item(page, "monthly")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(item(page, "monthly").locator("svg").first()).toBeVisible();
  await expect(page.getByText("未保存の変更があります")).toHaveCount(0);

  await page.getByLabel("タイルを追加").selectOption({ label: "数字（KPI）" });
  await expect(item(page, "kpi").getByTestId("kpi-value")).toHaveText(/^¥[\d,]+$/);
  await expect(item(page, "kpi")).toContainText("売上");

  await item(page, "kpi").hover();
  await item(page, "kpi").getByRole("button", { name: "売上を消す" }).click();
  await expect(item(page, "kpi")).toHaveCount(0);
  await page.getByRole("button", { name: "元に戻す" }).click();
  await expect(item(page, "kpi").getByTestId("kpi-value")).toHaveText(/^¥/);

  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("status")).toContainText("保存しました");
  const tile = [
    "    {",
    `      "id": "kpi",`,
    `      "x": 0, "y": 22, "w": 3, "h": 2,`,
    `      "type": "kpi",`,
    `      "title": "売上",`,
    `      "query": { "measures": ["revenue"] }`,
    "    }",
  ].join("\n");
  expect(readFileSync(salesFile, "utf8")).toBe(original.replace(/\n {4}}\n {2}]\n}\n$/, `\n    },\n${tile}\n  ]\n}\n`));
});

test("closing with unsaved changes asks first; going back in the browser keeps them", async ({ page }) => {
  await openEditor(page);
  await page.getByLabel("タイルを追加").selectOption({ label: "文章" });
  await page.evaluate(() => (location.hash = "#/"));
  await expect(item(page, "markdown")).toBeVisible();
  await expect(page.getByText("未保存の変更があります")).toBeVisible();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("保存していない変更があります");
  await page.getByRole("button", { name: "保存せずに閉じる" }).click();
  await expect(page.locator('[data-tile="kpi-revenue"]')).toBeVisible();
  await expect(page.locator('[data-tile="markdown"]')).toHaveCount(0);
  expect(readFileSync(salesFile, "utf8")).toBe(original);
});

test("a new dashboard: name, heading, then tiles", async ({ page }) => {
  await page.goto("/#/sales");
  await page.getByRole("button", { name: "＋ 新しいダッシュボード" }).click();
  const name = page.getByLabel("ファイル名");
  await name.fill("月次");
  await expect(page.getByText("半角の英数字と - _ で書いてください")).toBeVisible();
  await name.fill("sales");
  await expect(page.getByText("その名前のダッシュボードはもうあります")).toBeVisible();
  await expect(page.getByRole("button", { name: "作って編集する" })).toBeDisabled();
  await name.fill("monthly");
  await page.getByLabel("見出し").fill("月次の売上");
  await page.getByRole("button", { name: "作って編集する" }).click();

  await expect(page.getByRole("heading", { name: "月次の売上" })).toBeVisible();
  await expect(page.getByText("「＋ タイルを追加」から")).toBeVisible();
  await expect(page).toHaveURL(/#\/monthly$/);
  await page.getByLabel("タイルを追加").selectOption({ label: "棒グラフ" });
  await expect(item(page, "bar").locator("svg").first()).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  expect(readFileSync(newFile, "utf8")).toBe(
    [
      "{",
      `  "$schema": "../.devbi/dash.schema.json",`,
      `  "title": "月次の売上",`,
      `  "metrics": "sales",`,
      `  "tiles": [`,
      "    {",
      `      "id": "bar",`,
      `      "x": 0, "y": 0, "w": 6, "h": 4,`,
      `      "type": "bar",`,
      `      "title": "月別売上",`,
      `      "query": { "measures": ["revenue"], "time": "month" }`,
      "    }",
      "  ]",
      "}",
      "",
    ].join("\n"),
  );

  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(page.getByRole("heading", { name: "月次の売上", level: 1 })).toBeVisible();
  await expect(page.locator('[data-tile="bar"] svg').first()).toBeVisible();
  await page.getByRole("link", { name: "← 一覧へ" }).click();
  await expect(page.getByRole("link", { name: /月次の売上/ })).toBeVisible();
});

test("a change made elsewhere: taken in when nothing is unsaved, asked about when something is", async ({ page }) => {
  await openEditor(page);
  await mark(page);
  // Half-written: the editor keeps what it shows, and says why it could not read the file.
  writeFileSync(salesFile, "{ broken");
  await expect(page.getByRole("alert")).toContainText("JSON として読めません");
  await expect(item(page, "kpi-revenue")).toBeVisible();
  writeFileSync(salesFile, original.replace(`"title": "売上ダッシュボード"`, `"title": "売上（VS Code で変更）"`));
  await expect(page.getByRole("heading", { name: "売上（VS Code で変更）" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("読み込み直しました");

  await page.getByLabel("タイルを追加").selectOption({ label: "文章" });
  writeFileSync(salesFile, "{ broken again");
  await expect(page.getByRole("alert")).toContainText("ほかで書き換えられました");
  // Still the editor's version on screen, and saving is refused until the user picks one.
  await expect(item(page, "markdown")).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("エディタで開いたあとに書き換えられています");
  await page.getByRole("button", { name: "ここでの内容で上書きする" }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  const saved = readFileSync(salesFile, "utf8");
  expect(saved).toContain(`"title": "売上（VS Code で変更）"`);
  expect(saved).toContain(`"id": "markdown"`);
  // The page took the file from disk while the editor was open: it reloads when the editor closes.
  expect(await marked(page)).toBe(true);
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect.poll(() => marked(page).catch(() => false)).toBe(false);
  await expect(page.getByRole("heading", { name: "売上（VS Code で変更）", level: 1 })).toBeVisible();
  await expect(page.locator('[data-tile="markdown"]')).toBeVisible();
});

test("saving with nothing changed leaves a file written in another style alone", async ({ page }) => {
  const other = `${JSON.stringify(JSON.parse(original), null, 2)}\n`;
  writeFileSync(salesFile, other);
  await openEditor(page);
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForTimeout(500);
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(readFileSync(salesFile, "utf8")).toBe(other);
});

test("after models/ or data/ changes, the page reloads and the editor opens again", async ({ page }) => {
  await openEditor(page);
  await mark(page);
  appendFileSync(path.join(work, "models/sales.metrics.yaml"), "# changed\n");
  await expect.poll(() => marked(page).catch(() => false)).toBe(false);
  await expect(page.getByText("dashboards/sales.dash.json")).toBeVisible();
  await expect(item(page, "kpi-revenue").getByTestId("kpi-value")).toHaveText(/^¥/);

  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(page.locator('[data-tile="kpi-revenue"]')).toBeVisible();
  await mark(page);
  const xlsx = path.join(work, "data/sales.xlsx");
  writeFileSync(xlsx, readFileSync(xlsx));
  await expect.poll(() => marked(page).catch(() => false)).toBe(false);
  await expect(page.locator('[data-tile="kpi-revenue"]').getByTestId("kpi-value")).toHaveText(/^¥/);
});

test("the editor's endpoint is only for the editor's own requests", async ({ page }) => {
  await page.goto("/#/sales");
  const status = await page.evaluate(async () => {
    const plain = await fetch("/__devbi/editor/dashboards/sales");
    const bad = await fetch("/__devbi/editor/dashboards/sales", {
      method: "PUT",
      headers: { "X-DevBI-Editor": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ spec: { tiles: [{ id: "a", x: 0, y: 0, w: 13, h: 1, type: "kpi" }] }, version: "x" }),
    });
    return { plain: plain.status, bad: bad.status };
  });
  expect(status).toEqual({ plain: 403, bad: 409 });
  expect(readFileSync(salesFile, "utf8")).toBe(original);
});

const panel = (page: Page) => page.getByRole("complementary", { name: "設定" });

/** Press a tile (not drag it): the property panel shows it. */
async function pick(page: Page, id: string) {
  await item(page, id).locator(".devbi-ed-cover").click();
  await expect(panel(page).getByLabel("名前（id）")).toHaveValue(id);
}

test("the property panel: type, title, measures and time grain show on the tile at once, and save as those lines", async ({ page }) => {
  await openEditor(page);
  await expect(panel(page).getByRole("heading", { name: "ダッシュボード" })).toBeVisible();
  await pick(page, "monthly");
  const p = panel(page);
  await p.getByLabel("種類").selectOption({ label: "折れ線グラフ" });
  await expect(item(page, "monthly").locator(".devbi-tile-line")).toBeVisible();
  await p.getByRole("checkbox", { name: /受注件数/ }).check();
  await expect(item(page, "monthly")).toContainText("受注件数");
  await p.getByLabel(/期間の単位/).selectOption({ label: "四半期" });

  // Typing in a box is one undo step, however many letters.
  const title = p.getByLabel("見出し", { exact: true });
  await title.click();
  await title.press("End");
  await title.pressSequentially("（税込）");
  await expect(item(page, "monthly").getByRole("heading", { name: "月別売上（税込）" })).toBeVisible();
  await page.getByRole("button", { name: "元に戻す" }).click();
  await expect(title).toHaveValue("月別売上");
  await page.getByRole("button", { name: "やり直す" }).click();
  await expect(title).toHaveValue("月別売上（税込）");

  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  expect(readFileSync(salesFile, "utf8")).toBe(
    original.replace(
      `"type": "bar",\n      "title": "月別売上",\n      "query": { "measures": ["revenue"], "time": "month" }`,
      `"type": "line",\n      "title": "月別売上（税込）",\n      "query": { "measures": ["revenue", "orders"], "time": "quarter" }`,
    ),
  );
});

test("the property panel: filters from the data's values, sort and limit; with no tile, the dashboard's own settings", async ({ page }) => {
  await openEditor(page);
  await pick(page, "region");
  const p = panel(page);
  const before = await item(page, "region").locator(".devbi-tile-body").innerText();
  await p.getByLabel("絞り込みを追加").selectOption({ label: "商品分類" });
  await p.getByRole("checkbox", { name: "保守" }).check();
  await expect(item(page, "region").locator(".devbi-tile-body")).not.toHaveText(before);
  await p.getByLabel("並び順を追加").selectOption({ label: "地域" });
  await p.getByLabel("地域の向き").selectOption({ label: "大きい順" });
  await p.getByLabel("件数", { exact: true }).fill("3");
  await expect(item(page, "region").locator(".devbi-tile-body")).not.toContainText("九州");
  // Not filtered by the period (the date-range tile's latest fiscal year): larger numbers, of all of the data.
  const inPeriod = await item(page, "region").locator(".devbi-tile-body").innerText();
  await p.getByLabel("期間で絞るか").selectOption({ label: "絞らない（いつも全期間）" });
  await expect(item(page, "region").locator(".devbi-tile-body")).not.toHaveText(inPeriod);

  // Back to the dashboard's own settings.
  await p.getByRole("button", { name: "ダッシュボード全体" }).click();
  await expect(p.getByRole("heading", { name: "ダッシュボード" })).toBeVisible();
  await p.getByLabel("見出し", { exact: true }).fill("売上（四半期の会議用）");
  await expect(page.getByRole("heading", { name: "売上（四半期の会議用）", level: 1 })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("status")).toContainText("保存しました");
  const saved = readFileSync(salesFile, "utf8");
  const spec = JSON.parse(saved);
  expect(spec.title).toBe("売上（四半期の会議用）");
  expect(spec.tiles.find((t: { id: string }) => t.id === "region").query).toEqual({
    measures: ["revenue"],
    dimensions: ["region"],
    filters: [{ field: "category", in: ["保守"] }],
    sort: ["-region"],
    limit: 3,
    period: false,
  });
  // Only the title and that tile's query changed (its `"query": {` line is in the file already, for another tile).
  const changed = saved.split("\n").filter((line) => !original.split("\n").includes(line));
  expect(changed).toEqual([
    `  "title": "売上（四半期の会議用）",`,
    `        "measures": ["revenue"],`,
    `        "dimensions": ["region"],`,
    `        "filters": [{ "field": "category", "in": ["保守"] }],`,
    `        "sort": ["-region"],`,
    `        "limit": 3,`,
    `        "period": false`,
  ]);
});

test("the property panel: a tile's name is checked, options show at once, a type without data drops the query", async ({ page }) => {
  await openEditor(page);
  await pick(page, "region");
  const p = panel(page);
  const id = p.getByLabel("名前（id）");
  await id.fill("kpi-orders");
  await expect(p.getByText("kpi-orders は、ほかのタイルの名前です")).toBeVisible();
  await id.fill("region-sales");
  await id.press("Enter");
  await expect(item(page, "region-sales")).toBeVisible();
  await expect(id).toHaveValue("region-sales");

  // The pivot's totals.
  await pick(page, "region-quarter");
  await expect(item(page, "region-quarter")).toContainText("合計");
  await p.getByLabel("合計の行と列").selectOption({ label: "いいえ" });
  await expect(item(page, "region-quarter")).not.toContainText("合計");

  // The period picker starts over with its new default.
  await pick(page, "period");
  await p.getByLabel("最初の期間").selectOption({ label: "前の年度" });
  await expect(item(page, "period").getByRole("button", { name: "2025年度" })).toHaveAttribute("aria-pressed", "true");

  // A query that cannot show anything says so in the panel too.
  await pick(page, "kpi-orders");
  await p.getByRole("checkbox", { name: /受注件数/ }).uncheck();
  await expect(p.getByText("measures か dimensions を一つ以上指定してください")).toBeVisible();
  await expect(item(page, "kpi-orders")).toContainText("measures か dimensions を一つ以上指定してください");
  await page.getByRole("button", { name: "元に戻す" }).click();
  await expect(item(page, "kpi-orders").getByTestId("kpi-value")).toHaveText(/^[\d,]+$/);

  // A type without a query: the query goes, the text a new one starts with comes.
  await pick(page, "monthly");
  await p.getByLabel("種類").selectOption({ label: "文章" });
  await expect(item(page, "monthly").locator(".devbi-tile-markdown")).toBeVisible();
  await expect(p.getByLabel("本文")).toHaveValue(/ここに説明を書きます/);
  await p.getByRole("button", { name: "このタイルを消す" }).click();
  await expect(item(page, "monthly")).toHaveCount(0);
  await expect(p.getByRole("heading", { name: "ダッシュボード" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("status")).toContainText("保存しました");
  const spec = JSON.parse(readFileSync(salesFile, "utf8"));
  const ids = spec.tiles.map((t: { id: string }) => t.id);
  expect(ids).toContain("region-sales");
  expect(ids).not.toContain("monthly");
  expect(spec.tiles.find((t: { id: string }) => t.id === "region-quarter").options).toEqual({ columns: "受注日", totals: false });
  expect(spec.tiles.find((t: { id: string }) => t.id === "period").options).toEqual({ default: "previous_fiscal_year" });
});

test("the property panel: an explore tile reads the rows, its first layout written as JSON", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openEditor(page);
  await pick(page, "products");
  const p = panel(page);
  await p.getByLabel("種類").selectOption({ label: "探索（自由に集計）" });
  const tile = item(page, "products");
  await expect(tile.locator('.devbi-explore[aria-busy="false"]')).toHaveCount(1);
  // The model's rows: no measures, dimensions or sort to pick; the filters, the limit and the period stay.
  await expect(p.getByRole("group", { name: "指標" })).toHaveCount(0);
  await expect(p.getByRole("group", { name: "軸" })).toHaveCount(0);
  await expect(p.getByLabel("件数")).toBeVisible();
  await expect(p.getByLabel("期間で絞るか")).toBeVisible();

  const layout = p.getByLabel("最初の並べ方");
  await layout.fill("{ group_by: 地域 }");
  await layout.blur();
  await expect(p.getByText(/JSON として読めません/)).toBeVisible();
  await layout.fill('{ "group_by": ["地域"], "columns": ["金額"] }');
  await layout.blur();
  await expect(p.getByText(/JSON として読めません/)).toHaveCount(0);
  const viewer = tile.locator("perspective-viewer");
  const arranged = () => viewer.evaluate(async (el) => (await (el as unknown as { save(): Promise<{ group_by: string[] }> }).save()).group_by);
  await expect.poll(arranged).toEqual(["地域"]);

  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  const saved = JSON.parse(readFileSync(salesFile, "utf8")).tiles.find((t: { id: string }) => t.id === "products");
  expect(saved).toEqual({
    id: "products",
    x: 3,
    y: 16,
    w: 9,
    h: 5,
    type: "explore",
    title: "商品別",
    options: { layout: { group_by: ["地域"], columns: ["金額"] } },
  });
  expect(errors).toEqual([]);
});

test("the property panel keeps what is being typed: a new name when another tile is pressed, a date typed digit by digit", async ({ page }) => {
  await openEditor(page);
  const p = panel(page);
  // A new name, then another tile pressed: the name is taken, and the panel goes to that tile.
  await pick(page, "region");
  await p.getByLabel("名前（id）").fill("region-2");
  await item(page, "monthly").locator(".devbi-ed-cover").click();
  await expect(p.getByLabel("名前（id）")).toHaveValue("monthly");
  await expect(item(page, "region-2")).toBeVisible();
  // The same tile pressed: the panel stays on it, under its new name.
  await p.getByLabel("名前（id）").fill("monthly-2");
  await item(page, "monthly").locator(".devbi-ed-cover").click();
  await expect(p.getByLabel("名前（id）")).toHaveValue("monthly-2");

  // Backspace after a button in the panel does not remove the tile.
  await pick(page, "products");
  await p.getByRole("button", { name: "数量を前へ" }).click();
  await page.keyboard.press("Backspace");
  await expect(item(page, "products")).toBeVisible();

  // A start date typed digit by digit: the box stays (with focus) while the filter is written.
  await pick(page, "region-2");
  await p.getByLabel("絞り込みを追加").selectOption({ label: "受注日" });
  const start = p.getByLabel("受注日の始まり");
  await start.focus();
  await page.keyboard.type("04012025");
  await expect(start).toHaveValue("2025-04-01");
  await expect(start).toBeFocused();

  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("status")).toContainText("保存しました");
  const spec = JSON.parse(readFileSync(salesFile, "utf8"));
  const byId = (id: string) => spec.tiles.find((t: { id: string }) => t.id === id);
  expect(byId("monthly-2")).toBeTruthy();
  expect(byId("region-2").query.filters).toEqual([{ field: "受注日", between: ["2025-04-01", null] }]);
  expect(byId("products").query.measures).toEqual(["revenue", "quantity", "revenue_yoy", "orders"]);
});

test("コードにする: the tile is written out as a .tsx file that draws it as before, and the dashboard is saved, without a reload", async ({ page }) => {
  await openEditor(page);
  await mark(page);
  const p = panel(page);
  const pivot = item(page, "region-quarter");
  await expect(pivot.locator("table")).toContainText("北海道・東北");
  await pick(page, "region-quarter");
  await p.getByRole("button", { name: "コードにする…" }).click();
  await expect(p).toContainText("dashboards/sales/ に .tsx ファイルを書き出し");
  await p.getByRole("button", { name: "書き出す" }).click();
  await expect(page.getByRole("status")).toContainText("dashboards/sales/RegionQuarter.tsx に書き出して、保存しました");
  // The panel now has only what dash.json still says: the title and the name.
  await expect(p).toContainText("コードのタイルです（dashboards/sales/RegionQuarter.tsx）");
  await expect(p.getByLabel("種類")).toHaveCount(0);
  await expect(p.getByText("指標", { exact: true })).toHaveCount(0);
  await expect(p.getByRole("button", { name: "コードにする…" })).toHaveCount(0);
  await expect(pivot).toContainText("./sales/RegionQuarter.tsx");
  await expect(pivot.locator("table")).toContainText("北海道・東北");
  await expect(page.getByText("未保存の変更があります")).toHaveCount(0);
  expect(await marked(page)).toBe(true);

  const source = readFileSync(path.join(tilesDir, "RegionQuarter.tsx"), "utf8");
  expect(source).toContain(`export const query = defineQuery({ measures: ["revenue"], dimensions: ["region"], time: "quarter" });`);
  expect(source).toContain(`const options = { columns: "受注日" };`);
  expect(source).toContain("const Builtin = builtinTiles.pivot.component;");
  expect(source).toContain("export default function RegionQuarter(props: TileProps<RowOf<typeof query>>) {");
  const before = original.split("\n");
  const after = readFileSync(salesFile, "utf8").split("\n");
  expect(after.filter((l) => !before.includes(l))).toEqual([`      "component": "./sales/RegionQuarter.tsx",`, `      "title": "地域 × 四半期"`]);
  expect(before.filter((l) => !after.includes(l))).toEqual([
    `      "type": "pivot",`,
    `      "title": "地域 × 四半期",`,
    `      "query": { "measures": ["revenue"], "dimensions": ["region"], "time": "quarter" },`,
    `      "options": { "columns": "受注日" }`,
  ]);

  // Undo: the built-in tile again (unsaved). Written out again, it uses the same file.
  await page.getByRole("button", { name: "元に戻す" }).click();
  await expect(p.getByLabel("種類")).toHaveValue("pivot");
  await expect(page.getByText("未保存の変更があります")).toBeVisible();
  await p.getByRole("button", { name: "コードにする…" }).click();
  await p.getByRole("button", { name: "書き出す" }).click();
  await expect(page.getByRole("status")).toContainText("前に書き出した dashboards/sales/RegionQuarter.tsx を使うようにして、保存しました");
  expect(readdirSync(tilesDir).sort()).toEqual(["RegionQuarter.tsx", "TopCustomers.tsx"]);

  // The page after the editor closes has the new file too, still without a reload.
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(page.locator('[data-tile="region-quarter"] table')).toContainText("北海道・東北");
  expect(await marked(page)).toBe(true);
});

test("a tile file added elsewhere while there are unsaved changes does not reload the page", async ({ page }) => {
  await openEditor(page);
  await mark(page);
  await page.getByLabel("タイルを追加").selectOption({ label: "文章" });
  writeFileSync(path.join(tilesDir, "Elsewhere.tsx"), "export default function Elsewhere() {\n  return null;\n}\n");
  await expect(page.getByRole("alert")).toContainText("dashboards/sales/Elsewhere.tsx が変わりました");
  await expect(item(page, "markdown")).toBeVisible();
  expect(await marked(page)).toBe(true);
});
