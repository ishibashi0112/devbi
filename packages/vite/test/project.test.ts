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
