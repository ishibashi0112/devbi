import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readProject } from "../src/index.js";

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

describe("the dev server", () => {
  it("does not hand out the API's SQL or the SQLite database", async () => {
    const { createServer } = await import("vite");
    const devbi = (await import("../src/index.js")).default;
    // Through a link, as on macOS (where the temporary folder /var/… is really /private/var/…).
    const real = mkdtempSync(path.join(tmpdir(), "devbi-dev-"));
    const dir = `${real}-link`;
    symlinkSync(real, dir, "junction");
    for (const d of ["api", "db", "data"]) mkdirSync(path.join(dir, d));
    writeFileSync(path.join(dir, "api", "orders.sql"), "SELECT 1 AS one");
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
      expect(await status("db/shop.data")).toBe(403);
      expect(await status("db/other.sqlite")).toBe(403);
      expect(await status(".env")).toBe(403);
    } finally {
      await server.close();
    }
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
});
