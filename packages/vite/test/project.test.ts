import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isSnapshotPath, readProject } from "../src/index.js";

describe("readProject and read_api", () => {
  const project = (withSql: boolean) => {
    const dir = mkdtempSync(path.join(tmpdir(), "devbi-project-"));
    mkdirSync(path.join(dir, "models"));
    writeFileSync(path.join(dir, "models", "s.metrics.yaml"), "model: SELECT * FROM read_api('orders', from = '2024-04-01')\nmeasures:\n  n: COUNT(*)\n");
    if (withSql) {
      mkdirSync(path.join(dir, "api"));
      writeFileSync(path.join(dir, "api", "orders.sql"), "SELECT 1 AS one");
    }
    return dir;
  };

  it("checks that api/<name>.sql is there, and copies nothing into the build", async () => {
    const p = await readProject(project(true));
    expect(p.data).toEqual([]);
    await expect(readProject(project(false))).rejects.toThrow("models/s.metrics.yaml: API の SQL ファイル api/orders.sql がありません");
  });
});

describe("datasets", () => {
  it("gives the page each dataset's parameters and key, not the SQL; a broken file only matters to the dashboards that read it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "devbi-datasets-"));
    for (const d of ["api", "dashboards"]) mkdirSync(path.join(dir, d));
    writeFileSync(path.join(dir, "api", "lines.sql"), "-- param: from date label=いつから default=month_start\n-- key: no\nSELECT no FROM t WHERE d >= :from");
    writeFileSync(path.join(dir, "api", "broken.sql"), "UPDATE t SET a = 1");
    const report = (dataset: string) =>
      JSON.stringify({ title: "r", tiles: [{ id: "t", x: 0, y: 0, w: 12, h: 4, type: "table", query: { dataset } }] });
    writeFileSync(path.join(dir, "dashboards", "r.dash.json"), report("lines"));
    const p = await readProject(dir, {});
    expect(p.datasets).toEqual({ lines: { parameters: [{ name: "from", type: "date", label: "いつから", default: "month_start" }], key: ["no"] } });
    expect(JSON.stringify(p)).not.toContain("SELECT");
    writeFileSync(path.join(dir, "dashboards", "r.dash.json"), report("broken"));
    await expect(readProject(dir, {})).rejects.toThrow(/^dashboards\/r\.dash\.json: タイル t: api\/broken\.sql: SELECT か WITH で始まる文だけ使えます/);
  });
});

describe("the dev server", () => {
  it("does not hand out the API's SQL, access/ or the SQLite database", async () => {
    const { createServer } = await import("vite");
    const devbi = (await import("../src/index.js")).default;
    // Through a link, as on macOS (where the temporary folder /var/… is really /private/var/…).
    const real = mkdtempSync(path.join(tmpdir(), "devbi-dev-"));
    const dir = `${real}-link`;
    symlinkSync(real, dir, "junction");
    for (const d of ["api", "db", "data", "access", "dist/snapshots", "snapshots"]) mkdirSync(path.join(dir, d), { recursive: true });
    // devbi-serve's snapshots (everyone's rows of an older build): only its API answers these
    writeFileSync(path.join(dir, "dist", "snapshots", "orders.arrows"), "everyone's rows");
    writeFileSync(path.join(dir, "snapshots", "orders.arrows"), "everyone's rows");
    writeFileSync(path.join(dir, "api", "orders.sql"), "SELECT 1 AS one");
    writeFileSync(path.join(dir, "access", "user.sql"), "SELECT region FROM devbi_users WHERE login = :user.id");
    writeFileSync(path.join(dir, "db", "shop.data"), "not for the browser");
    writeFileSync(path.join(dir, "db", "other.sqlite"), "not for the browser");
    writeFileSync(path.join(dir, "data", "sales.csv"), "a\n1\n");
    writeFileSync(path.join(dir, ".env"), "DEVBI_DB=sqlite:db/shop.data\n");
    const server = await createServer({ root: dir, configFile: false, logLevel: "silent", plugins: [devbi()], server: { port: 0 } });
    await server.listen();
    try {
      const base = server.resolvedUrls!.local[0]!;
      const status = async (p: string) => (await fetch(new URL(p, base))).status;
      expect(await status("data/sales.csv")).toBe(200);
      expect(await status("api/orders.sql")).toBe(403);
      expect(await status("api/orders.sql?raw")).toBe(403);
      expect(await status("access/user.sql")).toBe(403);
      expect(await status("access/user.sql?raw")).toBe(403);
      expect(await status("db/shop.data")).toBe(403);
      expect(await status("db/other.sqlite")).toBe(403);
      expect(await status(".env")).toBe(403);
      for (const p of ["dist/snapshots/orders.arrows", "dist/snapshots/orders.arrows?raw", "dist/snapshots//orders.arrows", "dist/snapshots/orders%2Earrows", "snapshots//orders.arrows", "snapshots/orders.arrows/"]) {
        // the API (401: access/ puts it in row-level mode), or refused; never the file
        expect([401, 403, 404], p).toContain(await status(p));
      }
      expect(await (await fetch(new URL(`@fs${real}/dist/snapshots/orders.arrows`, base))).text()).not.toContain("everyone's rows");
    } finally {
      await server.close();
    }
  });
});

describe("what the dev server bundles ahead (optimizeDeps.include)", () => {
  const include = async (root: string, command = "serve") => {
    const devbi = (await import("../src/index.js")).default;
    const config = (devbi().config as (u: unknown, e: { mode: string; command: string }) => { optimizeDeps: { include: string[]; exclude?: string[] } })(
      { root },
      { mode: "development", command },
    );
    // DuckDB-wasm is never left out (it would load its own apache-arrow, or not load at all with pnpm).
    expect(config.optimizeDeps.exclude).toBeUndefined();
    return config.optimizeDeps.include;
  };
  const project = (packages: string[], linked = false) => {
    const root = mkdtempSync(path.join(tmpdir(), "devbi-deps-"));
    for (const name of packages) {
      const at = path.join(root, "node_modules", ...name.split("/"));
      mkdirSync(path.dirname(at), { recursive: true });
      const real = linked ? mkdtempSync(path.join(tmpdir(), "devbi-src-")) : at;
      mkdirSync(real, { recursive: true });
      writeFileSync(path.join(real, "package.json"), JSON.stringify({ name }));
      if (linked) symlinkSync(real, at, "junction");
    }
    return root;
  };

  it("installed from npm: the editor, and what a tile it writes imports", async () => {
    expect(await include(project(["@devbi/editor", "@devbi/react", "devbi"]))).toEqual(["@devbi/editor", "devbi", "@devbi/react"]);
    expect(await include(project(["@devbi/react", "devbi"]))).toEqual([]);
    expect(await include(project(["@devbi/editor", "@devbi/react", "devbi"]), "build")).toEqual([]);
  });

  it("linked to their source (this repository, pnpm link): only their own CommonJS dependencies", async () => {
    const malloy = ["devbi > @malloydata/malloy", "devbi > @malloydata/malloy/connection"];
    expect(await include(project(["@devbi/editor", "@devbi/react", "devbi"], true))).toEqual(["@devbi/editor > react-grid-layout", ...malloy]);
    expect(await include(project(["@devbi/react", "devbi"], true))).toEqual(malloy);
    expect(await include(project(["@devbi/react", "devbi"], true), "build")).toEqual([]);
  });
});

describe("snapshots", () => {
  it("passes the times of the api/*.sql with a snapshot line to the browser, not the SQL", async () => {
    const { readSnapshots } = await import("../src/index.js");
    const dir = mkdtempSync(path.join(tmpdir(), "devbi-snap-"));
    expect(await readSnapshots(dir)).toEqual({});
    mkdirSync(path.join(dir, "api"));
    writeFileSync(path.join(dir, "api", "daily.sql"), "-- 日次\n-- snapshot: 12:00, 06:00\nSELECT 1");
    writeFileSync(path.join(dir, "api", "live.sql"), "SELECT 1");
    expect(await readSnapshots(dir)).toEqual({ daily: ["06:00", "12:00"] });
    writeFileSync(path.join(dir, "api", "bad.sql"), "-- snapshot: 朝\nSELECT 1");
    await expect(readSnapshots(dir)).rejects.toThrow("api/bad.sql: snapshot の時刻は 06:00 のように書きます（朝）");
  });
});

describe("embed: true", () => {
  type Built = { build: { rolldownOptions: { input: Record<string, string>; preserveEntrySignatures?: string; output: { entryFileNames: (c: { name: string }) => string } } } };
  const configure = async (user: Record<string, unknown>, command: "build" | "serve" = "build") => {
    const devbi = (await import("../src/index.js")).default;
    const plugin = devbi({ embed: true });
    (plugin.config as (u: unknown, e: { mode: string; command: string }) => unknown)(user, { mode: "production", command });
    return user as unknown as Built;
  };

  it("adds devbi-embed.js next to the page, keeping its exports and name", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "devbi-embed-"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html>");
    const { build } = await configure({ root: dir });
    expect(build.rolldownOptions.input).toEqual({ index: path.join(dir, "index.html"), "devbi-embed": "virtual:devbi/embed" });
    expect(build.rolldownOptions.preserveEntrySignatures).toBe("exports-only");
    expect(build.rolldownOptions.output.entryFileNames({ name: "devbi-embed" })).toBe("devbi-embed.js");
    expect(build.rolldownOptions.output.entryFileNames({ name: "index" })).toBe("assets/[name]-[hash].js");
  });

  it("keeps the entries and file names a project gives", async () => {
    const { build } = await configure({ root: "/p", build: { rollupOptions: { input: ["/p/a.html", "/p/b.html"], output: { entryFileNames: "js/[name].js" } } } });
    const o = (build as unknown as { rollupOptions: Built["build"]["rolldownOptions"] }).rollupOptions;
    expect(o.input).toEqual({ a: "/p/a.html", b: "/p/b.html", "devbi-embed": "virtual:devbi/embed" });
    expect(o.output.entryFileNames({ name: "a" })).toBe("js/[name].js");
  });

  it("does nothing for the dev server", async () => {
    expect((await configure({ root: "/p" }, "serve")).build).toBeUndefined();
  });

  it("names listed entries by their path, so two index.html stay two", async () => {
    const { build } = await configure({ root: "/p", build: { rolldownOptions: { input: ["/p/index.html", "admin/index.html"] } } });
    expect(build.rolldownOptions.input).toEqual({ index: "/p/index.html", "admin/index": "admin/index.html", "devbi-embed": "virtual:devbi/embed" });
  });

  it("refuses an entry of the project's own named devbi-embed", async () => {
    await expect(configure({ root: "/p", build: { rolldownOptions: { input: { "devbi-embed": "/p/x.html" } } } })).rejects.toThrow(/devbi-embed/);
  });

  it("names shared chunks without a leading _ (GitHub Pages leaves those files out)", async () => {
    const { build } = await configure({ root: "/p" });
    const o = build.rolldownOptions.output as unknown as { chunkFileNames: (c: { name: string }) => string };
    expect(o.chunkFileNames({ name: "_virtual_devbi" })).toBe("assets/virtual_devbi-[hash].js");
    expect(o.chunkFileNames({ name: "engine" })).toBe("assets/engine-[hash].js");
  });

  it("warns about what stops the embed script from working, and leaves base as it is", async () => {
    const warnings = async (user: Record<string, unknown>) => {
      const devbi = (await import("../src/index.js")).default;
      const plugin = devbi({ embed: true });
      (plugin.config as (u: unknown, e: { mode: string; command: string }) => unknown)(user, { mode: "production", command: "build" });
      const warn = vi.fn();
      (plugin.configResolved as (c: unknown) => void)({ root: "/p", command: "build", logger: { warn } });
      return warn.mock.calls.map((c) => String(c[0])).join("\n");
    };
    const user = { root: "/p", base: "/reports/", build: { cssCodeSplit: false, rolldownOptions: { preserveEntrySignatures: false } } };
    const said = await warnings(user);
    expect(user.base).toBe("/reports/");
    expect(user.build.rolldownOptions.preserveEntrySignatures).toBe("exports-only");
    expect(said).toMatch(/preserveEntrySignatures/);
    expect(said).toMatch(/cssCodeSplit/);
    expect(said).toMatch(/base: "\/reports\/"/);
    const unset: Record<string, unknown> = { root: "/p" };
    expect(await warnings(unset)).toMatch(/base: "\/"（Vite の既定）/);
    expect(unset.base).toBeUndefined();
    expect(await warnings({ root: "/p", base: "./" })).toBe("");
  });
});

describe("snapshot files", () => {
  it("are known however their path is written", () => {
    for (const p of ["/snapshots/x.arrows", "/snapshots//x.arrows", "/dist/snapshots/x.arrows/", "/a/Snapshots/x%2Earrows?raw", "/snapshots/x.arrows.", "/snapshots%2Fx.arrows", "/snapshots/sub/x.arrows.1-2.tmp", "\\snapshots\\x.arrows"]) {
      expect(isSnapshotPath(p), p).toBe(true);
    }
    for (const p of ["/src/snapshots/view.ts", "/data/x.arrows", "/snapshots.arrows", "/my-snapshots/x.arrows", "/assets/index.js"]) expect(isSnapshotPath(p), p).toBe(false);
  });
});

describe("devUsers (「表示する利用者」)", () => {
  it("answers as the user the cookie names, for this computer only", async () => {
    const { devUserRequest } = await import("../src/index.js");
    const users = { yamada: { id: "CORP\\yamada", roles: ["営業"], attrs: { region: "関東" } }, sato: {} };
    expect(devUserRequest(users, "a=1; devbi-dev-user=yamada", true)).toEqual({ user: { id: "CORP\\yamada", roles: ["営業"], attrs: { region: "関東" } } });
    expect(devUserRequest(users, "devbi-dev-user=sato", true)).toEqual({ user: { id: "sato" } });
    // Another computer (vite --host) sending the cookie itself: nobody.
    expect(devUserRequest(users, "devbi-dev-user=yamada", false)).toEqual({ signInHint: expect.stringContaining("動かしているパソコン") });
    expect(devUserRequest(users, undefined, true)).toEqual({ signInHint: "上の『表示する利用者』で選びます" });
    expect(devUserRequest(users, "devbi-dev-user=", true)).toEqual({ signInHint: "上の『表示する利用者』で選びます" });
    expect(devUserRequest(users, "devbi-dev-user=toString", true)).toEqual({ signInHint: expect.stringContaining("devUsers に toString がありません") });
    expect(devUserRequest(undefined, "devbi-dev-user=yamada", true)).toEqual({ signInHint: expect.stringContaining("devUsers") });
    expect(devUserRequest("preview", "devbi-dev-user=yamada", true)).toEqual({ signInHint: expect.stringContaining("vite preview") });
  });

  it("filters the API's rows by the user picked, and tells the page whom it can pick", async () => {
    const { createServer } = await import("vite");
    const { DatabaseSync } = await import("node:sqlite");
    const devbi = (await import("../src/index.js")).default;
    const dir = mkdtempSync(path.join(tmpdir(), "devbi-devusers-"));
    for (const d of ["api", "db"]) mkdirSync(path.join(dir, d));
    const db = new DatabaseSync(path.join(dir, "db", "shop.sqlite"));
    db.exec("CREATE TABLE sales (region TEXT, amount INTEGER); INSERT INTO sales VALUES ('関東', 10), ('関東', 5), ('近畿', 7);");
    db.close();
    writeFileSync(path.join(dir, "api", "mine.sql"), "SELECT region, amount FROM sales WHERE region = :user.region");
    writeFileSync(path.join(dir, ".env"), "DEVBI_DB=sqlite:db/shop.sqlite\n");
    const devUsers = { yamada: { roles: ["営業"], attrs: { region: "関東" } }, suzuki: { attrs: { region: "近畿" } }, sato: {} };
    const server = await createServer({ root: dir, configFile: false, logLevel: "silent", plugins: [devbi({ devUsers })], server: { port: 0 } });
    await server.listen();
    try {
      const base = server.resolvedUrls!.local[0]!;
      const { tableFromIPC } = await import("apache-arrow");
      const ask = async (cookie?: string) => {
        const res = await fetch(new URL("api/query", base), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
          body: JSON.stringify({ name: "mine" }),
        });
        if (!res.ok) return `${res.status} ${((await res.json()) as { error: string }).error}`;
        return tableFromIPC(new Uint8Array(await res.arrayBuffer()))
          .toArray()
          .map((r) => `${r.region} ${r.amount}`)
          .join(", ");
      };
      expect(await ask("devbi-dev-user=yamada")).toBe("関東 10, 関東 5");
      expect(await ask("devbi-dev-user=suzuki")).toBe("近畿 7");
      expect(await ask()).toBe("401 ログインしていません（上の『表示する利用者』で選びます）");
      expect(await ask("devbi-dev-user=sato")).toBe("403 利用者 sato に属性 region がありません（api/mine.sql の :user.region）");
      // The page's list (virtual:devbi on the dev server): names and what each is, not the cookie's value.
      const mod = await server.transformRequest("virtual:devbi");
      expect(mod?.code).toContain(JSON.stringify([{ name: "yamada", note: "営業・region 関東" }, { name: "suzuki", note: "region 近畿" }, { name: "sato" }]));
    } finally {
      await server.close();
    }
  });

  it("stops the dev server on a user the API would not take", async () => {
    const { createServer } = await import("vite");
    const devbi = (await import("../src/index.js")).default;
    const dir = mkdtempSync(path.join(tmpdir(), "devbi-devusers-"));
    mkdirSync(path.join(dir, "api"));
    writeFileSync(path.join(dir, "api", "mine.sql"), "SELECT 1 AS one -- access: all");
    const start = (devUsers: Record<string, unknown>) =>
      createServer({ root: dir, configFile: false, logLevel: "silent", plugins: [devbi({ devUsers } as never)], server: { port: 0 } });
    await expect(start({ yamada: { attrs: { id: "x" } } })).rejects.toThrow("devbi: devUsers の yamada: ");
    await expect(start({ yamada: { id: "" } })).rejects.toThrow("devbi: devUsers の yamada: id は空でない文字で書いてください");
    await expect(start({ yamada: "営業" })).rejects.toThrow("devbi: devUsers の yamada: { roles, attrs } の形で書いてください");
  });
});
