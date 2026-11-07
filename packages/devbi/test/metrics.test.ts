import { describe, expect, it } from "vitest";
import { MetricsError, componentProblem, defineDashboard, parseMetricsYaml, resolveComponent, scanSources } from "../src/index.js";

function issues(yaml: string): string[] {
  try {
    parseMetricsYaml(yaml, "t");
  } catch (e) {
    if (e instanceof MetricsError) return e.issues.map((i) => `${i.path}: ${i.message}`);
    throw e;
  }
  return [];
}

describe("parseMetricsYaml", () => {
  it("accepts shorthand dimensions and measures", () => {
    const v = parseMetricsYaml("model: SELECT 1\ndimensions:\n  r: region\nmeasures:\n  n: COUNT(*)\n", "t");
    expect(v.dimensions.r).toMatchObject({ expr: '"region"', label: "r" });
    expect(v.measures.n).toMatchObject({ kind: "sql", expr: "COUNT(*)" });
  });

  it("labels comparison and running measures from their target", () => {
    const v = parseMetricsYaml(
      `model: SELECT 1
time: d
measures:
  rev: { sql: SUM(x), label: 売上, format: "¥#,##0" }
  yoy: { of: rev, compare: previous_year }
  ly: { of: rev, compare: previous_year, as: value }
  cum: { of: rev, running: true }
`,
      "t",
    );
    expect(v.measures.yoy).toMatchObject({ label: "売上 前年比", format: "0.0%", as: "ratio" });
    expect(v.measures.ly).toMatchObject({ label: "売上 前年", format: "¥#,##0" });
    expect(v.measures.cum).toMatchObject({ label: "売上 累計", reset: "all" });
  });

  it("reports schema errors in Japanese with paths", () => {
    expect(issues("measures: {}")).toEqual([expect.stringMatching(/^model: /)]);
    expect(issues("model: SELECT 1\nmeasures:\n  a: 1\n")[0]).toMatch(/^measures\.a: /);
    expect(issues("model: x\nmeasures: {}\nextra: 1")).toEqual([expect.stringContaining("extra")]);
  });

  it("reports reference problems", () => {
    expect(issues("model: x\nmeasures:\n  a: b + 1\n  b: a + 1\n")).toEqual([
      expect.stringContaining("循環"),
    ]);
    expect(
      issues("model: x\ntime: d\nmeasures:\n  a: SUM(x)\n  y: { of: a, compare: previous_year }\n  z: y * 100\n"),
    ).toEqual([expect.stringContaining("y は前年比・累計の指標")]);
    expect(issues("model: x\nmeasures:\n  y: { of: nope, compare: previous_year }\n")).toEqual([
      "measures.y.of: 指標 nope がありません",
    ]);
    expect(issues("model: x\nmeasures:\n  a: SUM(x)\n  y: { of: a, running: true }\n")).toEqual([
      expect.stringContaining("time（日付の列）"),
    ]);
    expect(issues("model: x\ndimensions:\n  a: a\nmeasures:\n  a: SUM(x)\n")).toEqual([
      "measures.a: 軸と同じ名前は使えません: a",
    ]);
  });

  it("does not expand qualified names, calls, strings or quoted identifiers", () => {
    const v = parseMetricsYaml(
      `model: x
measures:
  a: SUM(amount)
  b: "t.a + a + 'a' + \\"a\\" + a(1)"
`,
      "t",
    );
    expect(v.measures.b).toMatchObject({ expr: `t.a + (SUM(amount)) + 'a' + "a" + a(1)` });
  });

  it("treats names inside aggregates, FILTER and OVER as columns even when a measure has that name", () => {
    const v = parseMetricsYaml(
      `model: x
measures:
  amount: SUM(amount)
  status: COUNT(DISTINCT status)
  share: "SUM(amount) FILTER (WHERE status = 'done') / amount"
  per_status: amount / status
  nested: "SUM(CASE WHEN status = 'a' THEN amount END) + amount"
  ordered: "STRING_AGG(status, ',' ORDER BY amount) || CAST(amount AS VARCHAR)"
`,
      "t",
    );
    expect(v.measures.amount).toMatchObject({ expr: "SUM(amount)" });
    expect(v.measures.share).toMatchObject({ expr: "SUM(amount) FILTER (WHERE status = 'done') / (SUM(amount))" });
    expect(v.measures.per_status).toMatchObject({ expr: "(SUM(amount)) / (COUNT(DISTINCT status))" });
    expect(v.measures.nested).toMatchObject({ expr: "SUM(CASE WHEN status = 'a' THEN amount END) + (SUM(amount))" });
    expect(v.measures.ordered).toMatchObject({ expr: "STRING_AGG(status, ',' ORDER BY amount) || CAST((SUM(amount)) AS VARCHAR)" });
  });

  it("does not mistake Object.prototype keys for defined names", () => {
    const v = parseMetricsYaml("model: x\ndimensions:\n  r: region\nmeasures:\n  constructor: COUNT(*)\n  n: constructor + 1\n", "t");
    expect(v.measures.n).toMatchObject({ expr: "(COUNT(*)) + 1" });
    expect(issues("model: x\nmeasures:\n  a: { of: toString, compare: previous_year }\n")).toEqual(["measures.a.of: 指標 toString がありません"]);
  });
});

describe("scanSources", () => {
  it("finds file reads and their named arguments", () => {
    const s = scanSources(
      "SELECT * FROM read_xlsx('data/a.xlsx', sheet = '明細, 2026', header = true) JOIN read_csv_auto('data/b''s.csv') USING (id)",
    );
    expect(s.map(({ fn, format, path, args }) => ({ fn, format, path, args }))).toEqual([
      { fn: "read_xlsx", format: "xlsx", path: "data/a.xlsx", args: { sheet: "'明細, 2026'", header: "true" } },
      { fn: "read_csv_auto", format: "csv", path: "data/b's.csv", args: {} },
    ]);
  });
});

describe("defineDashboard", () => {
  it("fills defaults and checks tiles", () => {
    const d = defineDashboard({ tiles: [{ id: "a", x: 0, y: 0, w: 4, h: 2, type: "kpi" }] }, "s");
    expect(d).toMatchObject({ title: "s", columns: 12, rowHeight: 80 });
    expect(() =>
      defineDashboard(
        {
          tiles: [
            { id: "a", x: 10, y: 0, w: 4, h: 2, type: "kpi" },
            { id: "a", x: 0, y: 0, w: 4, h: 2 },
          ],
        },
        "s",
      ),
    ).toThrow(/type か component[\s\S]*/);
    expect(() => defineDashboard({ tiles: [{ id: "a", x: 10, y: 0, w: 4, h: 2, type: "kpi" }] }, "s")).toThrow(
      "列数 12 を超えています",
    );
  });

  it("reports overlapping tiles", () => {
    const tiles = [
      { id: "a", x: 0, y: 0, w: 6, h: 2, type: "kpi" },
      { id: "b", x: 6, y: 0, w: 6, h: 2, type: "kpi" },
      { id: "c", x: 0, y: 2, w: 12, h: 1, type: "kpi" },
    ];
    expect(() => defineDashboard({ tiles }, "s")).not.toThrow();
    expect(() => defineDashboard({ tiles: [...tiles, { id: "d", x: 5, y: 1, w: 2, h: 2, type: "kpi" }] }, "s")).toThrow(
      "タイル d が a と重なっています",
    );
  });
});

describe("resolveComponent", () => {
  it("resolves against the dashboard file or the project root", () => {
    expect(resolveComponent("/dashboards/sales.dash.json", "./sales/Top.tsx")).toBe("/dashboards/sales/Top.tsx");
    expect(resolveComponent("/dashboards/a/b.dash.json", "../c/D.jsx")).toBe("/dashboards/c/D.jsx");
    expect(resolveComponent("/dashboards/sales.dash.json", "/dashboards/./sales/Top.tsx")).toBe("/dashboards/sales/Top.tsx");
    expect(componentProblem("/dashboards/sales/Top.tsx")).toBeUndefined();
    expect(componentProblem(resolveComponent("/dashboards/sales.dash.json", "../tiles/Top.tsx"))).toContain("dashboards/ の中");
    expect(componentProblem("/dashboards/sales/top.ts")).toContain(".tsx か .jsx");
  });
});
