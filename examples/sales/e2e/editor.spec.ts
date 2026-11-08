// The GUI editor (@devbi/editor) on Vite's dev server. It writes to e2e-work/ (see editor.vite.config.ts), which each
// test puts back first.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const work = path.join(root, "e2e-work");
const original = readFileSync(path.join(root, "dashboards/sales.dash.json"), "utf8");
const metrics = readFileSync(path.join(root, "models/sales.metrics.yaml"), "utf8");
const salesFile = path.join(work, "dashboards/sales.dash.json");
const newFile = path.join(work, "dashboards/monthly.dash.json");

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  writeFileSync(salesFile, original);
  writeFileSync(path.join(work, "models/sales.metrics.yaml"), metrics);
  rmSync(newFile, { force: true });
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
