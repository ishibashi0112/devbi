import { expect, test, type Page } from "@playwright/test";

// public/embed-demo.html: "another app's page" with its own CSS, one <div data-devbi="sales-db"> and devbi-embed.js.
const tile = (page: Page, id: string) => page.locator(`[data-tile="${id}"]`);
const kpi = (page: Page, id: string) => tile(page, id).getByTestId("kpi-value");
const report = (page: Page) => page.locator("#report-area");

test.use({ colorScheme: "dark" });

type Devbi = {
  dashboards: { name: string }[];
  mount(target: string | Element, options?: Record<string, unknown>): { unmount(): void };
  mountAll(): number;
  unmount(target: string | Element): void;
};

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("worker", () => errors.push("worker")); // DuckDB's: one for the whole page
  const api: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) api.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await page.goto("/embed-demo.html");
  await expect(kpi(page, "kpi-revenue")).toHaveText(/^¥[\d,]+$/);
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  expect(errors).toEqual(["worker"]);
  errors.length = 0;
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
  await expect(root).toHaveAttribute("data-devbi-isolate", "");
  await expect(page.locator("main > h1")).toHaveCSS("color", "rgb(138, 28, 28)");
  await expect(root.locator(".devbi-head h1")).toHaveCSS("color", "rgb(29, 35, 48)");
  await expect(root.locator(".devbi-head h1")).toHaveCSS("text-transform", "none");
  await expect(tile(page, "kpi-revenue").locator(".devbi-tile-title")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(tile(page, "region").locator("li").first()).toHaveCSS("list-style-type", "none");
  await expect(root).toHaveCSS("font-family", /system-ui/);
  expect(errors).toEqual([]);
});

/** Instead of the print dialog: the printed frame's text in window.printed. */
async function catchPrint(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { printed?: string }).printed = undefined;
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!(n instanceof HTMLIFrameElement) || n.dataset.devbiPrintFrame === undefined) continue;
          n.addEventListener("load", () => {
            n.contentWindow!.print = () => ((window as unknown as { printed: string }).printed = n.contentDocument!.body.innerText);
          });
        }
      }
    }).observe(document.body, { childList: true });
  });
}

const printed = (page: Page) => page.evaluate(() => (window as unknown as { printed?: string }).printed);

test("印刷・PDF prints the dashboard alone, not the page around it; data-devbi-exports=\"false\" leaves the buttons out", async ({ page }) => {
  const { errors } = await open(page);
  // The page's rule kept out of the dashboard as the reference says (:not([data-devbi] *)), and styles added in script
  // as CSS-in-JS libraries add them: to an empty <style>, and as a sheet made in script.
  await page.addStyleTag({ content: ".devbi-tile:not([data-devbi] *) { outline: 5px solid rgb(255, 0, 0); }" });
  await page.evaluate(() => {
    const style = document.createElement("style");
    document.head.append(style);
    style.sheet!.insertRule(".devbi-printed { letter-spacing: 3px; }");
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(".devbi-printed { word-spacing: 4px; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
  await catchPrint(page);
  await report(page).getByRole("button", { name: "印刷・PDF" }).click();
  await expect.poll(() => printed(page)).toContain("売上ダッシュボード（DB から）");
  const body = page.frameLocator("iframe[data-devbi-print-frame]").locator("body");
  await expect(body.locator(":scope > *")).toHaveCount(1);
  await expect(body.locator(":scope > [data-devbi] > .devbi-root")).toHaveAttribute("data-devbi-isolate", "");
  await expect(body).not.toContainText(await page.locator("main > h1").innerText());
  await expect(body.locator(".devbi-tile").first()).toHaveCSS("outline-style", "none");
  await page.emulateMedia({ media: "print" });
  await expect(body.locator(".devbi-printed")).toHaveCSS("letter-spacing", "3px");
  await expect(body.locator(".devbi-printed")).toHaveCSS("word-spacing", "4px");
  await page.emulateMedia({ media: "screen" });

  // Options left out come from the attributes: mounting again with data-devbi-exports="false".
  await page.evaluate(() => {
    document.getElementById("report-area")!.setAttribute("data-devbi-exports", "false");
    (window as unknown as { DevBI: Devbi }).DevBI.mount("#report-area");
  });
  await expect(report(page).getByRole("button", { name: "Excel" })).toHaveCount(0);
  await expect(report(page).getByRole("button", { name: "印刷・PDF" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("in a narrow part of the page the tiles go in one column, as on a phone", async ({ page }) => {
  const { errors } = await open(page);
  const root = report(page).locator(".devbi-root");
  await expect(root).not.toHaveAttribute("data-devbi-narrow");
  await page.evaluate(() => (document.getElementById("report-area")!.style.width = "560px"));
  await expect(root).toHaveAttribute("data-devbi-narrow", "");
  const a = (await tile(page, "kpi-revenue").boundingBox())!;
  const b = (await tile(page, "kpi-orders").boundingBox())!;
  expect(b.y).toBeGreaterThan(a.y + a.height - 1);
  expect(Math.round(a.width)).toBe(Math.round(b.width));
  // Printed so too, each tile a band of its own (pages break between any two).
  await catchPrint(page);
  await report(page).getByRole("button", { name: "印刷・PDF" }).click();
  await expect.poll(() => printed(page)).toContain("売上ダッシュボード（DB から）");
  const copy = page.frameLocator("iframe[data-devbi-print-frame]").locator(".devbi-root");
  await expect(copy).toHaveAttribute("data-devbi-narrow", "");
  await expect(copy.locator(".devbi-print-band")).toHaveCount(await report(page).locator("[data-tile]").count());
  await expect(copy.locator(".devbi-print-band > [data-tile]")).toHaveCount(await report(page).locator("[data-tile]").count());
  expect(errors).toEqual([]);
});

test("from JavaScript: the list of dashboards, mount to switch, mountAll for elements added later, unmount", async ({ page }) => {
  const { errors } = await open(page);
  expect(await page.evaluate(() => (window as unknown as { DevBI: Devbi }).DevBI.dashboards.map((d) => d.name))).toEqual([
    "sales",
    "sales-daily",
    "sales-db",
  ]);

  // The page's own menu calls mount() with another dashboard: the Excel one, with the JSX tile.
  await page.locator("#report").selectOption("sales");
  await expect(report(page).locator(".devbi-head h1")).toHaveText("売上ダッシュボード");
  await expect(tile(page, "top-customers").locator("li").first()).toBeVisible();
  await expect(page.locator(".devbi-error")).toHaveCount(0);

  // A part of the page replaced (an UpdatePanel): mountAll() shows the new element and lets go of the old one.
  const added = await page.evaluate(() => {
    const devbi = (window as unknown as { DevBI: Devbi }).DevBI;
    document.getElementById("report-area")!.remove();
    const div = document.createElement("div");
    div.id = "later";
    div.dataset.devbi = "nope";
    document.querySelector("main")!.append(div);
    return devbi.mountAll();
  });
  expect(added).toBe(1);
  await expect(page.locator("#later .devbi-error")).toHaveText("ダッシュボード nope がありません（あるのは sales, sales-daily, sales-db）");
  await page.evaluate(() => (window as unknown as { DevBI: Devbi }).DevBI.unmount("#later"));
  await expect(page.locator("#later")).toBeEmpty();
  expect(errors).toEqual([]);
});

test("mount again: another theme keeps the selections, an old handle and mountAll leave a newer one alone", async ({ page }) => {
  const { errors } = await open(page);
  const chips = report(page).locator(".devbi-chip");
  const before = await chips.count();
  await tile(page, "region").locator("li button").first().click();
  await expect(chips).toHaveCount(before + 1);

  // Only the theme: the same dashboard, dark now, with its selections.
  await page.evaluate(() => (window as unknown as { DevBI: Devbi }).DevBI.mount("#report-area", { theme: "dark" }));
  await expect(report(page).locator(".devbi-root")).toHaveAttribute("data-theme", "dark");
  await expect(chips).toHaveCount(before + 1);

  const shown = await page.evaluate(() => {
    const devbi = (window as unknown as { DevBI: Devbi }).DevBI;
    const old = devbi.mount("#report-area", { dashboard: "sales" });
    devbi.mount("#report-area"); // back to data-devbi="sales-db", light from data-devbi-theme
    old.unmount(); // too late: does nothing
    return document.querySelector("#report-area .devbi-head h1")?.textContent;
  });
  expect(shown).toBe("売上ダッシュボード（DB から）");
  await expect(report(page).locator(".devbi-root")).toHaveAttribute("data-theme", "light");

  // unmount() empties it until mount() is called for it again; mountAll() leaves it empty.
  expect(
    await page.evaluate(() => {
      const devbi = (window as unknown as { DevBI: Devbi }).DevBI;
      devbi.unmount("#report-area");
      return devbi.mountAll();
    }),
  ).toBe(0);
  await expect(report(page)).toBeEmpty();
  await page.evaluate(() => (window as unknown as { DevBI: Devbi }).DevBI.mount("#report-area"));
  await expect(kpi(page, "kpi-revenue")).toHaveText(/^¥[\d,]+$/);
  expect(errors).toEqual([]);
});

test("two DevBI scripts on one page: neither takes the other's elements", async ({ page }) => {
  const { errors } = await open(page);
  // The same script once more under another URL: it leaves the dashboard already shown alone.
  await page.evaluate(() => {
    const again = "./devbi-embed.js?again";
    return import(again);
  });
  await expect(page.locator(".devbi-root")).toHaveCount(1);

  // Another project's script (a stand-in with the same page-wide list): it has "other", not "sales".
  const added = await page.evaluate(() => {
    type Instance = { knows(name: string): boolean; release(el: Element): void; scan(root: ParentNode): number };
    type Registry = { instances: Set<Instance>; claims: WeakMap<Element, { instance: Instance; known: boolean }> };
    const reg = (globalThis as unknown as Record<symbol, Registry>)[Symbol.for("devbi.embed.v1")]!;
    const other: Instance = {
      knows: (name) => name === "other",
      release(el) {
        el.textContent = "";
        if (reg.claims.get(el)?.instance === other) reg.claims.delete(el);
      },
      scan(root) {
        let n = 0;
        for (const el of root.querySelectorAll('[data-devbi="other"]')) {
          if (reg.claims.has(el)) continue;
          el.textContent = "the other project's dashboard";
          reg.claims.set(el, { instance: other, known: true });
          n++;
        }
        return n;
      },
    };
    reg.instances.add(other);
    // Added by a partial update of the page: window.DevBI (this project's) asks the other script to show it.
    const theirs = Object.assign(document.createElement("div"), { id: "theirs" });
    theirs.dataset.devbi = "other";
    // An element the other script got to first, showing that it has no "sales": the one that has it takes over.
    const taken = Object.assign(document.createElement("div"), { id: "taken", textContent: "ダッシュボード sales がありません" });
    taken.dataset.devbi = "sales";
    reg.claims.set(taken, { instance: other, known: false });
    document.querySelector("main")!.append(theirs, taken);
    return (window as unknown as { DevBI: Devbi }).DevBI.mountAll();
  });
  expect(added).toBe(2);
  await expect(page.locator("#theirs")).toHaveText("the other project's dashboard");
  await expect(page.locator("#taken .devbi-head h1")).toHaveText("売上ダッシュボード");
  await expect(page.locator(".devbi-root")).toHaveCount(2);
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
    (window as unknown as { DevBI: Devbi }).DevBI.mountAll();
  });
  await expect(page.locator("#elsewhere [data-tile='kpi-revenue'] [data-testid='kpi-value']")).toHaveText(/^¥[\d,]+$/);
  // devbi-serve answers …/api/query under any path, standing in for the host app here. Both dashboards in the
  // one DuckDB (no second worker in errors).
  expect(api).toEqual(["POST /api/query", "POST /host-app/devbi/api/query"]);
  expect(errors).toEqual([]);
});

test("data-devbi-api of another server is not used (JavaScript can pass one)", async ({ page }) => {
  const { errors, api } = await open(page);
  await page.evaluate(() => {
    const div = document.createElement("div");
    div.id = "away";
    div.dataset.devbi = "sales-db";
    div.dataset.devbiApi = "https://elsewhere.example/api/";
    document.querySelector("main")!.append(div);
    (window as unknown as { DevBI: Devbi }).DevBI.mountAll();
  });
  await expect(page.locator("#away")).toContainText("別のサーバー（https://elsewhere.example）なので使いません");
  expect(api).toEqual(["POST /api/query"]);
  expect(errors).toEqual([]);
});
