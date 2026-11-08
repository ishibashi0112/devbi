// The project made by create-devbi, with the packages installed from their tarballs (scripts/check-packed.mjs),
// without its self-written tile: the file "コードにする" writes is the first .tsx the dev server sees.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const app = process.env.DEVBI_PACKED_APP!;

/** A mark that a reload would wipe. */
const mark = (page: import("@playwright/test").Page) => page.evaluate(() => ((window as unknown as { devbiMark: number }).devbiMark = 1));
const marked = (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as { devbiMark?: number }).devbiMark === 1);

test("the sample dashboard draws, and the GUI editor writes a tile out (コードにする) without a page reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator('[data-tile="kpi-revenue"]').getByTestId("kpi-value")).toHaveText(/^¥[\d,]+$/);
  await expect(page.locator('[data-tile="region-quarter"] table')).toContainText("北海道・東北");
  // The self-written tile (dashboards/sales/TopCustomers.tsx).
  // From here on, a dependency Vite had not bundled ahead would reload the page (and lose the editor's changes).
  await mark(page);

  await page.getByRole("button", { name: "編集", exact: true }).click();
  const tile = page.locator('[data-editor-tile="region-quarter"]');
  await expect(tile.locator("table")).toContainText("北海道・東北");
  await tile.locator(".devbi-ed-cover").click();
  const panel = page.getByRole("complementary", { name: "設定" });
  await expect(panel.getByLabel("名前（id）")).toHaveValue("region-quarter");
  await panel.getByRole("button", { name: "コードにする…" }).click();
  await panel.getByRole("button", { name: "書き出す" }).click();
  await expect(page.getByRole("status")).toContainText("dashboards/sales/RegionQuarter.tsx に書き出して、保存しました");
  await expect(tile.locator("table")).toContainText("北海道・東北");
  expect(readFileSync(path.join(app, "dashboards/sales/RegionQuarter.tsx"), "utf8")).toContain("builtinTiles.pivot.component");
  expect(readFileSync(path.join(app, "dashboards/sales.dash.json"), "utf8")).toContain(`"component": "./sales/RegionQuarter.tsx"`);

  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(page.locator('[data-tile="region-quarter"] table')).toContainText("北海道・東北");
  // A reload Vite starts after it bundles a dependency comes a moment later: wait for it, then look.
  await page.waitForTimeout(3000);
  expect(await marked(page)).toBe(true);
  expect(errors).toEqual([]);
  expect(existsSync(path.join(app, "dist/index.html"))).toBe(true);
});
