import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DatasetColumns } from "@devbi/server";
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

  it("writes each dataset's parameters and, asked of its database, its row type (kept when it cannot be asked)", async () => {
    const dir = await project({
      "api/orders.sql": "-- param: from date\nSELECT id, day, amount, name, amount * 2 AS twice FROM orders WHERE day >= :from\n",
      "api/broken.sql": "-- param: x nope\nSELECT :x\n",
    });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dir, "shop.sqlite"));
    db.exec("CREATE TABLE orders (id INTEGER NOT NULL, day DATE, amount REAL, name TEXT)");
    db.close();
    const env = { DEVBI_DB: "sqlite:shop.sqlite" };
    const dts = () => readFile(path.join(dir, ".devbi/env.d.ts"), "utf8");

    // Without asking: the names only (any columns), and no columns.json.
    expect((await generate(dir, { env })).unasked).toEqual([]);
    expect(await dts()).toContain('    "orders": {\n      params: "from";\n    };');
    expect(await dts()).toContain('    "broken": {\n      params: string;\n    };');
    expect(existsSync(path.join(dir, ".devbi/columns.json"))).toBe(false);

    // Asked: the columns as SQLite declares them (an expression's type is only known from its values, and so is a
    // DATE column's: its text is read as dates only when all of it is).
    const all = await generate(dir, { env, describe: "all" });
    expect(all.unasked.map((u) => [u.name, u.offline])).toEqual([["broken", false]]);
    expect(await dts()).toContain(
      [
        '    "orders": {',
        '      params: "from";',
        "      row: {",
        '        "id": number | null;',
        '        "day": import("devbi").Scalar;',
        '        "amount": number | null;',
        '        "name": string | null;',
        '        "twice": import("devbi").Scalar;',
        "      };",
        "    };",
      ].join("\n"),
    );
    const known = JSON.parse(await readFile(path.join(dir, ".devbi/columns.json"), "utf8"));
    expect(Object.keys(known)).toEqual(["orders"]);

    // "changed" asks only what changed since (and what was never answered); a column the database says is never
    // null has no `| null`.
    const asked: string[] = [];
    let answer: (name: string) => Promise<DatasetColumns> = async (name) => ({ name, columns: [{ name: "id", type: "int", nullable: false }] });
    const api = { describe: (name: string) => (asked.push(name), answer(name)) };
    await generate(dir, { env, describe: "changed", api });
    expect(asked).toEqual(["broken"]);
    await writeFile(path.join(dir, "api/orders.sql"), "-- param: from date\nSELECT id FROM orders WHERE day >= :from\n");
    asked.length = 0;
    await generate(dir, { env, describe: "changed", api });
    expect(asked).toEqual(["orders"]);
    expect(await dts()).toContain('      row: {\n        "id": number;\n      };');
    // in name order whatever order they were answered in, a column a line (the file is kept in git)
    expect(await readFile(path.join(dir, ".devbi/columns.json"), "utf8")).toMatch(
      /^\{\n {2}"broken": \{\n {4}"sql": "\w+",\n {4}"columns": \[\n {6}\{ "name": "id", "type": "int", "nullable": false \}\n {4}\]\n {2}\},\n {2}"orders": \{/,
    );

    // A database that does not answer: the columns last asked stay, and it is reported.
    answer = async () => {
      throw new Error("データベースにつなげません（sqlite:shop.sqlite）: nope");
    };
    asked.length = 0;
    const offline = await generate(dir, { env, describe: "all", api });
    expect(offline.unasked.map((u) => [u.name, u.offline, u.why])).toEqual([
      ["broken", true, "データベースにつなげません（sqlite:shop.sqlite）: nope"],
      ["orders", true, "データベースにつなげません（sqlite:shop.sqlite）: nope"],
    ]);
    // the same connection is not asked again
    expect(asked).toEqual(["broken"]);
    expect(await dts()).toContain('      row: {\n        "id": number;\n      };');

    // A dataset removed: gone from the types.
    await rm(path.join(dir, "api/orders.sql"));
    await generate(dir, { env });
    expect(await dts()).not.toContain('"orders"');
  });
});
