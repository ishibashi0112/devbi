import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Workbook } from "devbi";
import { describe, expect, it } from "vitest";
import { checkProject, formatReport } from "../src/check.js";
import { formatInspect, inspectData } from "../src/inspect.js";

const SALES = path.resolve(import.meta.dirname, "../../../examples/sales");

/** A project with examples/sales' data and models, and these files on top. */
function project(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "devbi-check-"));
  cpSync(path.join(SALES, "data"), path.join(dir, "data"), { recursive: true });
  mkdirSync(path.join(dir, "models"));
  mkdirSync(path.join(dir, "dashboards"));
  cpSync(path.join(SALES, "models/sales.metrics.yaml"), path.join(dir, "models/sales.metrics.yaml"));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

const dash = (tiles: unknown[]) => JSON.stringify({ metrics: "sales", tiles });
const tile = (id: string, y: number, rest: Record<string, unknown>) => ({ id, x: 0, y, w: 6, h: 2, ...rest });

describe("devbi-check", () => {
  it("runs every model, measure, dimension and tile of examples/sales without a problem", async () => {
    const r = await checkProject(SALES);
    expect(r.findings).toEqual([]);
    expect(r.views.find((v) => v.name === "sales")).toMatchObject({ rows: 6044, measures: 7, dimensions: 4 });
    // read_api through the API's SQL on the sample SQLite database (.env).
    expect(r.views.find((v) => v.name === "sales_db")?.rows).toBe(6044);
    const sales = r.tiles.filter((t) => t.dashboard === "sales");
    expect(sales.find((t) => t.id === "monthly")?.rows).toBeGreaterThan(0);
    // A promoted tile's `query` export, read through Vite.
    expect(sales.find((t) => t.id === "top-customers")?.rows).toBe(10);
    expect(sales.find((t) => t.id === "period")?.note).toBe("データを読まないタイル");
    expect(formatReport(r)).toMatch(/問題はありません$/);
  }, 60_000);

  it("names the file, the tile and what to fix", async () => {
    const dir = project({
      "models/sales.metrics.yaml": [
        "model: SELECT * FROM read_xlsx('data/sales.xlsx', sheet = '明細')",
        "time: { column: 受注日 }",
        "dimensions:",
        "  region: 地域",
        "  product: 商品名",
        "measures:",
        "  revenue: SUM(金額)",
        "  quantity: SUM(数)",
        "  revenue_ly: { of: revenue, compare: previous_year, as: value }",
      ].join("\n"),
      "models/bad.metrics.yaml": "model: SELECT 金額 / 単価x AS 比 FROM read_xlsx('data/sales.xlsx')\nmeasures:\n  n: COUNT(*)\n",
      "models/gone.metrics.yaml": "model: SELECT * FROM read_csv('data/nothing.csv')\nmeasures:\n  n: COUNT(*)\n",
      "dashboards/d.dash.json": dash([
        tile("k", 0, { type: "kpi", query: { measures: ["revenue", "revenue_ly"] } }),
        tile("typo", 2, { type: "kpi", query: { measures: ["revenu"] } }),
        tile("qty", 4, { type: "kpi", query: { measures: ["quantity"] } }),
        tile("none", 6, {
          type: "barlist",
          query: { dimensions: ["region"], measures: ["revenue"], filters: [{ field: "region", in: ["沖縄"] }] },
        }),
        tile("shape", 8, { type: "barlist", query: { measures: ["revenue"] } }),
        tile("pivot", 10, {
          type: "pivot",
          query: { dimensions: ["region"], measures: ["revenue"], time: "year" },
          options: { columns: "year" },
        }),
        tile("donut", 12, { type: "donut", query: { measures: ["revenue"] } }),
        tile("noquery", 14, { type: "bar" }),
        tile("note", 16, { type: "markdown", options: { text: "メモ" } }),
        tile("period", 18, { type: "date-range", options: { metrics: "nothing" } }),
      ]),
      "dashboards/broken.dash.json": dash([
        tile("f", 0, { type: "kpi", query: { measures: ["revenue"], filters: [{ field: "region", value: "関東" }] } }),
      ]),
    });
    const r = await checkProject(dir);
    const msgs = r.findings.map((f) => `${f.level} ${f.file}: ${f.message.split("\n")[0]}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        "error models/gone.metrics.yaml: データファイル data/nothing.csv がありません",
        expect.stringMatching(/^error models\/bad\.metrics\.yaml: model: Binder Error: .*単価x/),
        expect.stringMatching(/^error models\/sales\.metrics\.yaml: 軸 product: Binder Error: .*商品名/),
        expect.stringMatching(/^error models\/sales\.metrics\.yaml: 指標 quantity: Binder Error: .*"数"/),
        "error dashboards/d.dash.json: タイル typo: 指標 revenu は sales にありません（sales の指標: revenue・quantity・revenue_ly）",
        "warning dashboards/d.dash.json: タイル none: 結果が 0 行です（query.filters や指標の式を確かめてください）",
        "error dashboards/d.dash.json: タイル shape: barlist には dimensions と measures が一つずつ要ります",
        "error dashboards/d.dash.json: タイル pivot: pivot の options.columns「year」が結果の列にありません（使える名前: region・受注日）",
        expect.stringMatching(/^error dashboards\/d\.dash\.json: タイル donut: type「donut」はありません（kpi・/),
        "error dashboards/d.dash.json: タイル noquery: bar には query（measures・dimensions など）が要ります",
        "error dashboards/d.dash.json: タイル period: options.metrics の指標ファイル models/nothing.metrics.yaml がありません",
        expect.stringMatching(/^error dashboards\/broken\.dash\.json: tiles\.0（f）\.query\.filters\.0: 絞り込みは/),
      ]),
    );
    // DuckDB's suggestion comes with it.
    expect(r.findings.find((f) => f.message.startsWith("指標 quantity"))?.message).toContain('Candidate bindings: "数量"');
    expect(msgs).toHaveLength(12);
    const tiles = Object.fromEntries(r.tiles.map((t) => [t.id, t]));
    expect(tiles.k?.rows).toBe(1);
    // Not run again for the measure already reported.
    expect(tiles.qty?.note).toBe("quantity のエラーのため確かめていません");
    expect(tiles.note?.rows).toBeUndefined();
    const text = formatReport(r);
    expect(text).toMatch(/エラー 11 件、注意 1 件$/);
    // Errors first, the metrics files before the dashboards.
    expect(text.indexOf("✗ models/gone")).toBeLessThan(text.indexOf("✗ dashboards/"));
    expect(text.indexOf("✗ dashboards/d.dash.json")).toBeLessThan(text.indexOf("⚠"));
  }, 60_000);

  it("leaves the API unchecked, with a warning, when there is no database to read", async () => {
    const dir = project({
      "models/db.metrics.yaml": "model: SELECT * FROM read_api('orders')\nmeasures:\n  n: COUNT(*)\n",
      "dashboards/d.dash.json": JSON.stringify({ metrics: "db", tiles: [tile("k", 0, { type: "kpi", query: { measures: ["n"] } })] }),
    });
    mkdirSync(path.join(dir, "api"));
    writeFileSync(path.join(dir, "api/orders.sql"), "SELECT 1 AS one");
    const r = await checkProject(dir, { env: {} });
    expect(r.findings.filter((f) => f.level === "error")).toEqual([]);
    expect(r.findings).toEqual([
      {
        level: "warning",
        file: "models/db.metrics.yaml",
        message: expect.stringContaining("確かめていません: API の orders を読んでいません"),
      },
    ]);
    expect(r.tiles[0]?.note).toMatch(/^確かめていません（API の orders/);
  });

  it("does not call SQL a mistake when only a DuckDB extension it could not download is missing (current_date needs icu)", async () => {
    const dir = project({
      "models/x.metrics.yaml":
        "model: SELECT * FROM read_xlsx('data/sales.xlsx')\nmeasures:\n  days: SUM(CASE WHEN 受注日 <= current_date THEN 1 ELSE 0 END)\n",
      "dashboards/d.dash.json": JSON.stringify({ metrics: "x", tiles: [tile("k", 0, { type: "kpi", query: { measures: ["days"] } })] }),
    });
    const r = await checkProject(dir);
    expect(r.findings.filter((f) => f.level === "error")).toEqual([]);
    // Where DuckDB downloads it (CI), all is checked; where it cannot (no internet), a warning, and the tile is left unchecked.
    for (const f of r.findings) expect(f.message).toContain("DuckDB の拡張 icu をインターネットから取ってこられないため確かめていません");
    if (r.findings.length) expect(r.tiles[0]?.note).toBe("days を確かめていないため確かめていません");
  });

  it("reports one mistake once: measures of a broken measure, and of a broken time column, are only skipped", async () => {
    const dir = project({
      "models/sales.metrics.yaml": [
        "model: SELECT * FROM read_xlsx('data/sales.xlsx', sheet = '明細')",
        "time: { column: 受注日x }",
        "dimensions:",
        "  region: 地域",
        "measures:",
        "  revenue: SUM(金額x)",
        "  orders: COUNT(*)",
        "  avg_order: revenue / orders",
        "  orders_ly: { of: orders, compare: previous_year, as: value }",
      ].join("\n"),
      "dashboards/d.dash.json": dash([
        tile("avg", 0, { type: "kpi", query: { measures: ["avg_order"] } }),
        tile("ly", 2, { type: "kpi", query: { measures: ["orders_ly"] } }),
        tile("monthly", 4, { type: "bar", query: { measures: ["orders"], time: "month" } }),
        tile("region", 6, { type: "barlist", query: { dimensions: ["region"], measures: ["orders"] } }),
      ]),
    });
    const r = await checkProject(dir);
    expect(r.findings.map((f) => f.message.split(":")[0])).toEqual(["time（受注日x）", "指標 revenue"]);
    const notes = Object.fromEntries(r.tiles.map((t) => [t.id, t.note ?? t.rows]));
    expect(notes).toEqual({
      avg: "revenue のエラーのため確かめていません",
      ly: "受注日x のエラーのため確かめていません",
      monthly: "受注日x のエラーのため確かめていません",
      region: 6,
    });
  });

  it("wants dates in the time column, and reads only the files named in read_ functions, as the browser", async () => {
    const dir = project({
      "models/sales.metrics.yaml": [
        "model: SELECT strftime(受注日, '%Y/%m/%d') AS 日付, * FROM read_xlsx('data/sales.xlsx')",
        "time: { column: 日付 }",
        "measures:",
        "  n: COUNT(*)",
      ].join("\n"),
      "models/plain.metrics.yaml": "model: SELECT * FROM 'data/x.csv'\nmeasures:\n  n: COUNT(*)\n",
      "data/x.csv": "a\n1\n",
      "dashboards/d.dash.json": dash([tile("k", 0, { type: "kpi", query: { measures: ["n"] } })]),
    });
    const r = await checkProject(dir);
    const time = r.findings.find((f) => f.message.startsWith("time"))!;
    expect(time.message).toMatch(
      /^time（日付）: 日付の列になっていません（文字の列です。例: 20\d\d\/\d\d\/\d\d）。model の SQL で DATE か TIMESTAMP に/,
    );
    const plain = r.findings.find((f) => f.file === "models/plain.metrics.yaml")!;
    expect(plain.level).toBe("error");
    expect(plain.message).toMatch(/^model: IO Error: No files found/);
    expect(plain.message).toContain("read_csv('data/…') のように read_ の関数で読んでください");
    // A query without the time grain still runs.
    expect(r.tiles[0]?.rows).toBe(1);
  });

  it("uses a promoted tile's query as the browser does", async () => {
    const dir = project({
      "dashboards/d.dash.json": dash([
        // dash.json's query wins over the module's.
        tile("own", 0, { component: "./d/Good.tsx", query: { measures: ["revenu"] } }),
        tile("good", 2, { component: "./d/Good.tsx" }),
        tile("self", 4, { component: "./d/Self.tsx" }),
        tile("other", 6, { component: "./d/Other.tsx" }),
        tile("browser", 8, { component: "./d/Browser.tsx" }),
      ]),
    });
    mkdirSync(path.join(dir, "dashboards/d"));
    const tsx = (query: string) => `${query}\nexport default function T() {\n  return null;\n}\n`;
    writeFileSync(path.join(dir, "dashboards/d/Good.tsx"), tsx('export const query = { measures: ["revenue"] };'));
    writeFileSync(path.join(dir, "dashboards/d/Self.tsx"), tsx(""));
    writeFileSync(path.join(dir, "dashboards/d/Other.tsx"), tsx('export const query = { metrics: "nope", measures: ["n"] };'));
    writeFileSync(
      path.join(dir, "dashboards/d/Browser.tsx"),
      tsx("const w = window.innerWidth;\nexport const query = { measures: [String(w)] };"),
    );
    const r = await checkProject(dir);
    expect(r.findings.map((f) => `${f.level} ${f.message}`)).toEqual([
      "error タイル own: 指標 revenu は sales にありません（sales の指標: revenue・orders・quantity・avg_order・revenue_yoy・revenue_ly・revenue_fytd）",
      "error タイル other: query.metrics の指標ファイル models/nope.metrics.yaml がありません",
      expect.stringMatching(/^warning タイル browser: \.\/d\/Browser\.tsx を Node で読めないため確かめていません（.*window/),
    ]);
    const tiles = Object.fromEntries(r.tiles.map((t) => [t.id, t]));
    expect(tiles.good?.rows).toBe(1);
    expect(tiles.self?.note).toBe("自分でデータを読むタイル（query を export していない）");
  }, 60_000);

  it("warns once when the model has no rows, and lists a dashboard without tiles", async () => {
    const dir = project({
      "models/sales.metrics.yaml":
        "model: SELECT * FROM read_xlsx('data/sales.xlsx') WHERE false\ndimensions:\n  region: 地域\nmeasures:\n  n: COUNT(*)\n",
      "dashboards/d.dash.json": dash([tile("r", 0, { type: "barlist", query: { dimensions: ["region"], measures: ["n"] } })]),
      "dashboards/empty.dash.json": dash([]),
    });
    const r = await checkProject(dir);
    expect(r.findings.map((f) => `${f.file}: ${f.message}`)).toEqual([
      "models/sales.metrics.yaml: model の結果が 0 行です（データファイルと model の SQL を確かめてください）",
    ]);
    expect(formatReport(r)).toContain("dashboards/empty.dash.json: タイル 0（クエリを実行 0）");
  });

  it("runs the tiles in the date-range's first period, as the page opens, and shows their values", async () => {
    const dir = project({
      "dashboards/d.dash.json": dash([
        tile("period", 0, { type: "date-range", options: { default: "latest_month" } }),
        tile("k", 2, { type: "kpi", query: { measures: ["revenue", "revenue_ly", "revenue_yoy"] } }),
        tile("days", 4, { type: "bar", query: { measures: ["revenue"], time: "day" } }),
      ]),
      "dashboards/all.dash.json": dash([tile("k", 0, { type: "kpi", query: { measures: ["revenue", "revenue_ly"] } })]),
    });
    const r = await checkProject(dir, { values: 2 });
    expect(r.findings).toEqual([]);
    expect(r.periods).toEqual({ d: ["受注日 2026年10月（2026-10-01〜2026-10-30）"] });
    const d = r.tiles.filter((t) => t.dashboard === "d");
    // The month of the latest date; the comparisons have a value in it (SUM of integers comes back as a decimal).
    const days = d.find((t) => t.id === "days")!;
    expect(days.rows).toBeGreaterThan(2);
    expect(days.values).toEqual([
      expect.stringMatching(/^受注日 2026\/10\/1、売上 ¥[\d,]+$/),
      expect.stringMatching(/^受注日 2026\/10\/\d+、/),
    ]);
    expect(d.find((t) => t.id === "k")?.values).toEqual([expect.stringMatching(/^売上 ¥[\d,]+、売上 前年 ¥[\d,]+、売上 前年比 \d+\.\d%$/)]);
    // No period: all of the data, where a comparison is empty (as on the screen).
    expect(r.tiles.find((t) => t.dashboard === "all")?.values).toEqual([expect.stringMatching(/^売上 ¥[\d,]+、売上 前年 —$/)]);
    const text = formatReport(r);
    expect(text).toContain(
      "dashboards/d.dash.json: タイル 3（クエリを実行 2、date-range の最初の期間: 受注日 2026年10月（2026-10-01〜2026-10-30））",
    );
    expect(text).toMatch(/\n {2}k: 売上 ¥[\d,]+、/);
    expect(text).toMatch(/\n {2}days \d+ 行:\n {4}受注日 2026\/10\/1、売上 ¥[\d,]+\n {4}受注日 2026\/10\/\d+、売上 ¥[\d,]+ …\n/);
    // Without values: the row counts on one line.
    expect(formatReport(await checkProject(dir))).toMatch(/\n {2}k 1 行、days \d+ 行\n/);
  }, 60_000);

  it("applies each date-range's first period to the tiles of its time column, and warns about one the page ignores", async () => {
    const dir = project({
      // Another metrics file, its time column a day later than 受注日.
      "models/days.metrics.yaml":
        "model: SELECT CAST(受注日 AS DATE) + 1 AS 日付, 金額 FROM read_xlsx('data/sales.xlsx', sheet = '明細')\n" +
        "time: { column: 日付 }\nmeasures:\n  total: SUM(金額)\n",
      "dashboards/d.dash.json": dash([
        tile("p1", 0, { type: "date-range", options: { default: "latest_month" } }),
        tile("p2", 2, { type: "date-range", options: { default: "previous_year", metrics: "days" } }),
        tile("k1", 4, { type: "kpi", query: { measures: ["orders"] } }),
        tile("k2", 6, { type: "kpi", query: { measures: ["total"], metrics: "days" } }),
        tile("none", 8, {
          type: "bar",
          query: { measures: ["total"], time: "month", metrics: "days", filters: [{ field: "日付", between: ["2030-01-01", null] }] },
        }),
      ]),
      "dashboards/bad.dash.json": dash([
        tile("q", 0, { type: "date-range", options: { default: "this_quarter" } }),
        tile("fy", 2, { type: "date-range", options: { default: "latest_fiscal_year", metrics: "days" } }),
      ]),
    });
    const r = await checkProject(dir, { values: 1 });
    expect(r.periods).toEqual({ d: ["受注日 2026年10月（2026-10-01〜2026-10-30）", "日付 2025年（2025-01-01〜2025-12-31）"] });
    // k2 is on days: filtered by its own date-range (2025), not by 受注日.
    const sum = async (where: string) =>
      Number(
        (
          await inspectData(dir, {
            sql: `SELECT SUM(金額) AS s, COUNT(DISTINCT 受注番号) AS n FROM read_xlsx('data/sales.xlsx', sheet = '明細') WHERE ${where}`,
          })
        ).head[0]!.s,
      );
    const total2025 = await sum("CAST(受注日 AS DATE) + 1 BETWEEN '2025-01-01' AND '2025-12-31'");
    const k = (id: string) => r.tiles.find((t) => t.dashboard === "d" && t.id === id)!;
    expect(k("k2").values).toEqual([`total ${total2025.toLocaleString("en-US")}`]);
    expect(k("k1").values).toEqual([expect.stringMatching(/^受注件数 \d+$/)]);
    expect(Number(k("k1").values![0]!.split(" ")[1])).toBeLessThan(1000);
    // A 0-row tile names the period that filtered it.
    expect(r.findings.map((f) => `${f.level} ${f.file}: ${f.message}`)).toEqual([
      "warning dashboards/bad.dash.json: タイル q: options.default「this_quarter」はありません（all・latest_day・last_7_days・last_30_days・latest_week・latest_month・previous_month・latest_quarter・previous_quarter・last_12_months・latest_year・previous_year・year_to_date・latest_fiscal_year・previous_fiscal_year）。画面は全期間で開きます",
      "warning dashboards/bad.dash.json: タイル fy: options.default「latest_fiscal_year」には、models/days.metrics.yaml の time に fiscal_year_start（年度の始まりの月）が要ります。画面は全期間で開きます",
      "warning dashboards/d.dash.json: タイル none: 結果が 0 行です（date-range の最初の期間 日付 2025年（2025-01-01〜2025-12-31） で。query.filters や指標の式を確かめてください）",
    ]);
    expect(r.periods).not.toHaveProperty("bad");
  }, 60_000);

  it("compares a calendar period with the one before, and leaves a period: false tile on all of the data", async () => {
    const dir = project({
      "models/pp.metrics.yaml":
        "model: SELECT * FROM read_xlsx('data/sales.xlsx', sheet = '明細')\n" +
        "time: { column: 受注日, label: 受注日 }\nmeasures:\n" +
        "  orders: COUNT(DISTINCT 受注番号)\n  orders_pp: { of: orders, compare: previous_period, as: value }\n",
      "dashboards/d.dash.json": JSON.stringify({
        metrics: "pp",
        tiles: [
          tile("period", 0, { type: "date-range", options: { default: "latest_quarter" } }),
          tile("k", 2, { type: "kpi", query: { measures: ["orders", "orders_pp"] } }),
          tile("all", 4, { type: "kpi", query: { measures: ["orders"], period: false } }),
        ],
      }),
    });
    const r = await checkProject(dir, { values: 1 });
    expect(r.findings).toEqual([]);
    expect(r.periods).toEqual({ d: ["受注日 2026年Q4（2026-10-01〜2026-10-30）"] });
    const count = async (where: string) =>
      Number(
        (
          await inspectData(dir, {
            sql: `SELECT COUNT(DISTINCT 受注番号) AS n FROM read_xlsx('data/sales.xlsx', sheet = '明細') WHERE ${where}`,
          })
        ).head[0]!.n,
      );
    const n = (v: number) => v.toLocaleString("en-US");
    // The quarter so far (Oct 1..30) against the same days of the quarter before (Jul 1..30), not the 30 days before.
    const now = await count("CAST(受注日 AS DATE) BETWEEN '2026-10-01' AND '2026-10-30'");
    const before = await count("CAST(受注日 AS DATE) BETWEEN '2026-07-01' AND '2026-07-30'");
    const k = (id: string) => r.tiles.find((t) => t.id === id)!;
    expect(k("k").values).toEqual([`orders ${n(now)}、orders 前期間 ${n(before)}`]);
    expect(k("all").values).toEqual([`orders ${n(await count("TRUE"))}`]);
  }, 60_000);

  it("reports a project without metrics files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "devbi-check-"));
    mkdirSync(path.join(dir, "models"));
    const r = await checkProject(dir);
    expect(r.findings.map((f) => f.file)).toEqual(["models/", "dashboards/"]);
  });
});

describe("devbi-inspect", () => {
  it("shows an Excel file's sheets, columns, ranges and common values", async () => {
    const r = await inspectData(SALES, "data/sales.xlsx", { values: 3 });
    expect(r).toMatchObject({ source: "data/sales.xlsx", sheets: ["明細", "メモ"], sheet: "明細", rows: 6044 });
    expect(r.columns.map((c) => c.name)).toEqual(["受注日", "受注番号", "顧客", "地域", "商品分類", "商品", "数量", "単価", "金額"]);
    expect(r.columns.find((c) => c.name === "受注日")).toMatchObject({ type: "DATE", min: "2024-04-01", nulls: 0 });
    expect(r.columns.find((c) => c.name === "数量")).toMatchObject({ type: "BIGINT", min: "1", max: "40", distinct: 40 });
    const region = r.columns.find((c) => c.name === "地域")!;
    expect(region).toMatchObject({ type: "VARCHAR", distinct: 6 });
    expect(region.min).toBeUndefined();
    expect(region.values).toEqual([
      { value: "関東", count: 2322 },
      { value: "近畿", count: 1325 },
      { value: "中部", count: 1037 },
    ]);
    expect(r.range).toBe("A1:I6045");
    expect(r.notes).toEqual([]);
    // A wide range: the empty columns past the table are not taken for a title row.
    expect((await inspectData(SALES, "data/sales.xlsx", { range: "A:Z", rows: 0, values: 0 })).notes).toEqual([]);
    expect(r.head).toHaveLength(10);
    expect(r.head[0]).toMatchObject({ 受注日: "2024-04-01", 顧客: "青葉商事", 数量: "3" });
    const text = formatInspect(r);
    expect(text).toContain("data/sales.xlsx（シート「明細」の A1:I6045）: 6,044 行、9 列");
    expect(text).toContain("地域: VARCHAR、6 種類\n  多い値: 関東 (2,322)、近畿 (1,325)、中部 (1,037) …");
  });

  it("reads another sheet, a CSV file outside the project, and a metrics file's model", async () => {
    await expect(inspectData(SALES, "data/sales.xlsx", { sheet: "ない" })).rejects.toThrow("シート「ない」がありません（明細・メモ）");
    const dir = mkdtempSync(path.join(tmpdir(), "devbi-inspect-"));
    const csv = path.join(dir, "x.csv");
    writeFileSync(csv, "a,b\n1,x\n2,\n3,x\n");
    const r = await inspectData(SALES, csv);
    expect(r.source).toBe(csv);
    expect(r.columns).toEqual([
      { name: "a", type: "BIGINT", nulls: 0, distinct: 3, min: "1", max: "3" },
      { name: "b", type: "VARCHAR", nulls: 1, distinct: 1, values: [{ value: "x", count: 2 }] },
    ]);
    const m = await inspectData(SALES, "sales_daily");
    expect(m.source).toBe("models/sales_daily.metrics.yaml");
    expect(m.columns.map((c) => c.name)).toContain("明細数");
    await expect(inspectData(SALES, "nothing")).rejects.toThrow(
      "nothing はデータファイルでも指標ファイル（models/nothing.metrics.yaml）でもありません",
    );
    expect((await inspectData(SALES, "models/sales.metrics.yaml")).source).toBe("models/sales.metrics.yaml");
    await expect(inspectData(SALES, "vite.config.ts")).rejects.toThrow("vite.config.ts は読めるデータのファイルではありません");
    await expect(inspectData(SALES, csv, { sheet: "x" })).rejects.toThrow("--sheet は Excel のファイル（.xlsx）を読むときだけです");
    // A metrics file outside models/, to try a model before writing it there (its data paths are the project's).
    const probe = path.join(dir, "probe.metrics.yaml");
    writeFileSync(
      probe,
      "model: SELECT 地域, CAST(受注日 AS VARCHAR) AS 日 FROM read_xlsx('data/sales.xlsx', sheet = '明細')\nmeasures: {}\n",
    );
    const p = await inspectData(SALES, probe, { rows: 0 });
    expect([p.source, p.rows, p.columns.map((c) => `${c.name} ${c.type}`), p.head]).toEqual([
      probe,
      6044,
      ["地域 VARCHAR", "日 VARCHAR"],
      [],
    ]);
    await expect(inspectData(SALES, "models/nothing.metrics.yaml")).rejects.toThrow(
      "指標ファイル models/nothing.metrics.yaml がありません",
    );
  });

  it("notices a title above an Excel table, and reads the sheet from a row with --range", async () => {
    const book = new Workbook();
    const sheet = book.sheet("記録");
    sheet.add("問い合わせ記録（2026年10月）");
    sheet.add("番号", "受付日", "件数");
    sheet.add("Q1", new Date("2026-10-01T00:00:00Z"), 3);
    sheet.add("Q2", new Date("2026-10-02T00:00:00Z"), 5);
    const dir = mkdtempSync(path.join(tmpdir(), "devbi-inspect-"));
    writeFileSync(path.join(dir, "log.xlsx"), await book.toBytes());
    const r = await inspectData(dir, "log.xlsx");
    expect(r.columns.map((c) => `${c.name} ${c.type}`)).toEqual([
      "問い合わせ記録（2026年10月） VARCHAR",
      "column2 VARCHAR",
      "column3 VARCHAR",
    ]);
    expect(r.notes).toEqual([
      "見出しとして読んだ 1 行目は、3 列のうち 1 列にしか値がありません（ほかの列は column2… という名前になります）。" +
        "表の上の表題などの行なら、その下の見出しの行から読んでください: --range A2:C（指標ファイルでは read_xlsx('log.xlsx', sheet = '記録', range = 'A2:C')）",
    ]);
    expect(formatInspect(r)).toContain("\n⚠ 見出しとして読んだ 1 行目は");
    // The first rows show where the header is.
    expect(r.head[0]).toEqual({ "問い合わせ記録（2026年10月）": "番号", column2: "受付日", column3: "件数" });
    const fixed = await inspectData(dir, "log.xlsx", { range: "A2:C" });
    expect(fixed).toMatchObject({ range: "A2:C4", rows: 2, notes: [] });
    expect(fixed.columns.map((c) => `${c.name} ${c.type}`)).toEqual(["番号 VARCHAR", "受付日 DATE", "件数 BIGINT"]);
  });

  it("runs a SELECT over the project's data (--sql), and shows its rows", async () => {
    const sql = "SELECT 地域, SUM(金額) AS 売上 FROM read_xlsx('data/sales.xlsx', sheet = '明細') GROUP BY 1 ORDER BY 2 DESC";
    const r = await inspectData(SALES, { sql }, { rows: 2 });
    expect(r).toMatchObject({ source: "SQL", rows: 6, head: [{ 地域: "関東" }, { 地域: "近畿" }] });
    expect(Number(r.head[0]!.売上)).toBeGreaterThan(Number(r.head[1]!.売上));
    const text = formatInspect(r);
    expect(text).toMatch(/^SQL: 6 行、2 列\n/);
    expect(text).toContain("最初の 2 行（6 行のうち。--rows <数> で変えられます）:\n地域 | 売上\n関東 | ");
    // As in a model: the browser reads only files named in read_ functions.
    await expect(inspectData(SALES, { sql: "SELECT * FROM 'data/sales.csv'" })).rejects.toThrow("read_ の関数で読んでください");
  });
});
