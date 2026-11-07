import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generate } from "../src/gen.js";

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "devbi-gen-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  return dir;
}

describe("generate (.devbi/)", () => {
  it("writes names for TypeScript and a dash.json schema with the project's names", async () => {
    const dir = await project({
      "models/sales.metrics.yaml": "model: SELECT 1\ntime: 受注日\ndimensions:\n  region: 地域\nmeasures:\n  revenue: SUM(金額)\n",
      "models/stock.metrics.yaml": "model: SELECT 1\nmeasures:\n  qty: SUM(数量)\n",
    });
    const first = await generate(dir);
    expect(first.changed.map((f) => path.basename(f))).toEqual(["env.d.ts", "dash.schema.json", "metrics.schema.json"]);
    expect(first.problems).toEqual([]);

    const dts = await readFile(path.join(dir, ".devbi/env.d.ts"), "utf8");
    expect(dts).toContain('declare module "devbi"');
    expect(dts).toContain('"sales": {\n      measures: "revenue";\n      dimensions: "region";\n      time: "受注日";');
    expect(dts).toContain('"stock": {\n      measures: "qty";\n      dimensions: never;\n      time: never;');

    const schema = JSON.parse(await readFile(path.join(dir, ".devbi/dash.schema.json"), "utf8"));
    const query = schema.properties.tiles.items.properties.query.properties;
    expect(query.measures.items.enum).toEqual(["qty", "revenue"]);
    expect(query.metrics.enum).toEqual(["sales", "stock"]);

    // Unchanged files are not rewritten; --check reports stale ones.
    expect((await generate(dir)).changed).toEqual([]);
    await writeFile(path.join(dir, "models/stock.metrics.yaml"), "model: SELECT 1\nmeasures:\n  qty: SUM(数量)\n  n: COUNT(*)\n");
    const check = await generate(dir, { check: true });
    expect(check.changed.map((f) => path.basename(f))).toEqual(["env.d.ts", "dash.schema.json"]);
    expect(await readFile(path.join(dir, ".devbi/env.d.ts"), "utf8")).toBe(dts);
  });

  it("keeps a file's last good names while it is broken (half-edited in the dev server)", async () => {
    const dir = await project({ "models/sales.metrics.yaml": "model: SELECT 1\nmeasures:\n  revenue: SUM(金額)\n" });
    await generate(dir);
    await writeFile(path.join(dir, "models/sales.metrics.yaml"), "model: SELECT 1\nmeasures:\n  revenue: { of: nope, compare: previous_year }\n");
    const r = await generate(dir);
    expect(r.problems.join("\n")).toContain("指標 nope がありません");
    expect(await readFile(path.join(dir, ".devbi/env.d.ts"), "utf8")).toContain('measures: "revenue";');
  });

  it("skips metrics files it cannot read and reports them", async () => {
    const dir = await project({ "models/bad.metrics.yaml": "model: SELECT 1\nmeasures:\n  a: { of: nope, compare: previous_year }\n" });
    const r = await generate(dir);
    expect(r.problems.join("\n")).toContain("指標 nope がありません");
    expect(await readFile(path.join(dir, ".devbi/env.d.ts"), "utf8")).toContain("interface MetricsRegistry {\n\n  }");
  });
});
