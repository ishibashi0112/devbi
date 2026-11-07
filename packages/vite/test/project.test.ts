import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    const dir = mkdtempSync(path.join(tmpdir(), "devbi-dev-"));
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
