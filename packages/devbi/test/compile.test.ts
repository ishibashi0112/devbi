import { describe, expect, it } from "vitest";
import { compileQuery, compileRows, compileTimeExtent, EXPLORE_ROWS, parseMetricsYaml, QueryError, type Query } from "../src/index.js";
import { round, rows } from "./helpers.js";

const view = parseMetricsYaml(
  `
label: 売上
model: SELECT * FROM sales;
time: order_date
dimensions:
  customer: { column: customer_name, label: 顧客 }
  region:   { column: region, label: 地域 }
  big:      { sql: "amount >= 200", label: 大口 }
measures:
  total_revenue: { sql: SUM(amount), label: 売上, format: "¥#,##0" }
  orders:        { sql: COUNT(DISTINCT order_id), label: 受注件数 }
  avg_order:     { sql: total_revenue / orders, label: 平均単価 }
  revenue_yoy:   { of: total_revenue, compare: previous_year, as: ratio }
  revenue_ly:    { of: total_revenue, compare: previous_year, as: value }
  revenue_pp:    { of: total_revenue, compare: previous_period, as: delta }
  revenue_cum:   { of: total_revenue, running: year }
`,
  "sales",
);

async function run(query: Query, filters: Parameters<typeof compileQuery>[2] = {}) {
  const c = compileQuery(view, query, filters);
  return { sql: c.sql, fields: c.fields, rows: round(await rows(c.sql)) };
}

describe("compileQuery", () => {
  it("aggregates measures by a dimension, sorted by the first measure", async () => {
    const r = await run({ measures: ["total_revenue", "orders"], dimensions: ["customer"], limit: 2 });
    await expect(r.sql).toMatchFileSnapshot("__snapshots__/top-customers.sql");
    expect(r.rows).toEqual([
      { customer: "A社", total_revenue: 600, orders: 3 },
      { customer: "B社", total_revenue: 600, orders: 2 },
    ]);
    expect(r.fields.map((f) => [f.name, f.kind, f.label])).toEqual([
      ["customer", "dimension", "顧客"],
      ["total_revenue", "measure", "売上"],
      ["orders", "measure", "受注件数"],
    ]);
  });

  it("expands measures that reference other measures", async () => {
    expect(view.measures.avg_order).toMatchObject({ expr: "(SUM(amount)) / (COUNT(DISTINCT order_id))" });
    const r = await run({ measures: ["avg_order"] });
    expect(r.rows).toEqual([{ avg_order: 1370 / 7 }].map((x) => ({ avg_order: Number(x.avg_order.toFixed(4)) })));
  });

  it("groups by a time grain and applies filters", async () => {
    const r = await run(
      { measures: ["total_revenue"], time: "month", filters: [{ field: "region", in: ["東", null] }] },
      { filters: [{ field: "order_date", between: ["2025-01-01", "2026-01-01"] }, { field: "unknown_elsewhere", in: ["x"] }] },
    );
    await expect(r.sql).toMatchFileSnapshot("__snapshots__/monthly-filtered.sql");
    expect(r.rows).toEqual([
      { order_date: "2025-01-01", total_revenue: 100 },
      { order_date: "2025-02-01", total_revenue: 300 },
      { order_date: "2025-04-01", total_revenue: 50 },
    ]);
  });

  it("supports sql dimensions and explicit sort", async () => {
    const r = await run({ measures: ["orders"], dimensions: ["big"], sort: ["big"] });
    expect(r.rows).toEqual([
      { big: false, orders: 4 },
      { big: true, orders: 3 },
    ]);
  });

  it("compares with the previous year per month", async () => {
    const r = await run({ measures: ["total_revenue", "revenue_ly", "revenue_yoy"], time: "month" });
    await expect(r.sql).toMatchFileSnapshot("__snapshots__/yoy-monthly.sql");
    expect(r.rows).toEqual([
      { order_date: "2025-01-01", total_revenue: 300, revenue_ly: null, revenue_yoy: null },
      { order_date: "2025-02-01", total_revenue: 300, revenue_ly: null, revenue_yoy: null },
      { order_date: "2025-04-01", total_revenue: 50, revenue_ly: null, revenue_yoy: null },
      { order_date: "2026-01-01", total_revenue: 200, revenue_ly: 300, revenue_yoy: 0.6667 },
      { order_date: "2026-02-01", total_revenue: 400, revenue_ly: 300, revenue_yoy: 1.3333 },
      { order_date: "2026-03-01", total_revenue: 120, revenue_ly: null, revenue_yoy: null },
    ]);
  });

  it("compares a closed period with the same period a year earlier", async () => {
    const r = await run(
      { measures: ["total_revenue", "revenue_yoy"], dimensions: ["customer"], sort: ["customer"] },
      { filters: [{ field: "order_date", between: ["2026-01-01", "2026-03-01"] }] },
    );
    expect(r.rows).toEqual([
      { customer: "A社", total_revenue: 200, revenue_yoy: 0.5 },
      { customer: "B社", total_revenue: 400, revenue_yoy: 2 },
    ]);
  });

  it("compares with the previous period of the same length", async () => {
    const r = await run(
      { measures: ["total_revenue", "revenue_pp"] },
      { filters: [{ field: "order_date", between: ["2026-01-01", "2026-04-01"] }] },
    );
    // 2026-01-01..2026-04-01 is 90 days; the previous 90 days have no rows.
    expect(r.rows).toEqual([{ total_revenue: 720, revenue_pp: null }]);
  });

  it("compares a calendar period with the one before, not with the same number of days", async () => {
    const mtd = { field: "order_date", between: ["2026-02-01", "2026-02-21"] as [string, string] };
    // February up to the 20th, as a month: January up to the 20th (150), not the 20 days before (Jan 12..31: 200).
    const month = await run({ measures: ["total_revenue", "revenue_pp"] }, { filters: [{ ...mtd, unit: "month" }] });
    expect(month.rows).toEqual([{ total_revenue: 400, revenue_pp: 250 }]);
    const days = await run({ measures: ["total_revenue", "revenue_pp"] }, { filters: [mtd] });
    expect(days.rows).toEqual([{ total_revenue: 400, revenue_pp: 200 }]);
    // A clicked month within a fiscal year picked on the date-range tile: the month is the period.
    const both = await run(
      { measures: ["total_revenue", "revenue_pp"] },
      {
        filters: [
          { field: "order_date", between: ["2025-04-01", "2026-03-04"], unit: "fiscal_year" },
          { field: "order_date", between: ["2026-02-01", "2026-03-01"], unit: "month" },
        ],
      },
    );
    expect(both.rows).toEqual([{ total_revenue: 400, revenue_pp: 200 }]);
  });

  it("takes the unit of the shortest period, whichever was picked last", async () => {
    // This year so far, and its January clicked on a month chart: January against December (no rows), not last January.
    const ytd = { field: "order_date", between: ["2026-01-01", "2026-03-04"] as [string, string], unit: "year" as const };
    const jan = { field: "order_date", between: ["2026-01-01", "2026-02-01"] as [string, string], unit: "month" as const };
    for (const filters of [[ytd, jan], [jan, ytd]]) {
      const r = await run({ measures: ["total_revenue", "revenue_pp"] }, { filters });
      expect(r.rows).toEqual([{ total_revenue: 200, revenue_pp: null }]);
    }
  });

  it("passes on which way is good, to comparisons too", () => {
    const v = parseMetricsYaml(
      `model: SELECT * FROM sales
time: order_date
measures:
  complaints: { sql: COUNT(*), label: クレーム, better: lower }
  complaints_pp: { of: complaints, compare: previous_period, as: change }
  complaints_ly: { of: complaints, compare: previous_year, as: delta, better: higher }
  revenue: SUM(amount)
`,
      "complaints",
    );
    expect(v.measures.complaints_pp).toMatchObject({ better: "lower" });
    const c = compileQuery(v, { measures: ["complaints", "complaints_pp", "complaints_ly", "revenue"] });
    expect(c.fields.map((f) => f.better)).toEqual(["lower", "lower", undefined, undefined]);
  });

  it("compares whole months at month ends, and a week with the same weekdays a year before", async () => {
    const v = parseMetricsYaml(
      `model: "SELECT * FROM (VALUES (DATE '2026-01-31', 1), (DATE '2026-02-01', 10), (DATE '2026-02-28', 100), (DATE '2026-03-31', 1000),
  (DATE '2025-10-26', 50000), (DATE '2025-10-27', 5000), (DATE '2026-10-26', 7)) t(d, amount)"
time: d
measures:
  rev: SUM(amount)
  pp: { of: rev, compare: previous_period, as: value }
  ly: { of: rev, compare: previous_year, as: value }
`,
      "ends",
    );
    const at = async (between: [string, string], unit: "month" | "week") =>
      round(await rows(compileQuery(v, { measures: ["rev", "pp", "ly"] }, { filters: [{ field: "d", between, unit }] }).sql));
    // March: all of February (Feb 28 + 1 month is Mar 28), not the 31 days before (which would take Jan 31 too).
    expect(await at(["2026-03-01", "2026-04-01"], "month")).toEqual([{ rev: 1000, pp: 110, ly: null }]);
    // February: all of January (Jan 31 + 1 month is Feb 28).
    expect((await at(["2026-02-01", "2026-03-01"], "month"))[0]).toMatchObject({ rev: 110, pp: 1 });
    // The week from Monday 2026-10-26: last year's week from Monday 2025-10-27 (52 weeks before), not Sunday the 26th.
    expect((await at(["2026-10-26", "2026-10-31"], "week"))[0]).toMatchObject({ rev: 7, ly: 5000 });
  });

  it("does not count Feb 29 into last year's Feb 28 by the day", async () => {
    const leap = parseMetricsYaml(
      `model: "SELECT * FROM (VALUES (DATE '2024-02-28', 10), (DATE '2024-02-29', 5), (DATE '2025-02-28', 20), (DATE '2025-03-01', 30)) t(d, amount)"
time: d
measures:
  rev: SUM(amount)
  ly: { of: rev, compare: previous_year, as: value }
`,
      "leap",
    );
    const c = compileQuery(leap, { measures: ["rev", "ly"], time: "day" });
    expect(round(await rows(c.sql))).toEqual([
      { d: "2024-02-28", rev: 10, ly: null },
      { d: "2024-02-29", rev: 5, ly: null },
      { d: "2025-02-28", rev: 20, ly: 10 },
      { d: "2025-03-01", rev: 30, ly: null },
    ]);
    // By the month, Feb 29 still belongs to last February.
    const m = compileQuery(leap, { measures: ["rev", "ly"], time: "month" });
    expect(round(await rows(m.sql))).toContainEqual({ d: "2025-02-01", rev: 20, ly: 15 });
  });

  it("rejects Object.prototype keys as names", () => {
    expect(() => compileQuery(view, { measures: ["toString"] })).toThrow("指標 toString は sales にありません");
    expect(() => compileQuery(view, { dimensions: ["constructor"] })).toThrow("軸 constructor は sales にありません");
  });

  it("returns NULL for comparisons when the period is unbounded", async () => {
    const r = await run({ measures: ["total_revenue", "revenue_yoy"] });
    expect(r.rows).toEqual([{ total_revenue: 1370, revenue_yoy: null }]);
  });

  it("computes running totals that reset every year", async () => {
    const r = await run({ measures: ["total_revenue", "revenue_cum"], time: "month" });
    await expect(r.sql).toMatchFileSnapshot("__snapshots__/running-year.sql");
    expect(r.rows.map((x) => x.revenue_cum)).toEqual([300, 600, 650, 200, 600, 720]);
  });

  it("lists dimension values without measures", async () => {
    const r = await run({ dimensions: ["region"] });
    expect(r.rows).toEqual([{ region: "東" }, { region: "西" }, { region: null }]);
  });

  it("uses a replacement model and computes the time extent", async () => {
    const sql = compileTimeExtent(view, { model: "SELECT * FROM sales WHERE amount > 100" });
    expect(await rows(sql)).toEqual([{ min: "2025-01-20", max: "2026-03-03" }]);
  });

  it("rejects unknown names", () => {
    expect(() => compileQuery(view, { measures: ["nope"] })).toThrow("指標 nope は sales にありません");
    expect(() => compileQuery(view, { dimensions: ["nope"] })).toThrow("軸 nope は sales にありません");
    expect(() => compileQuery(view, { measures: ["orders"], sort: ["customer"] })).toThrow("並べ替え");
    expect(() => compileQuery(view, {})).toThrow("measures か dimensions");
  });
});

describe("compileRows (the explore tile)", () => {
  it("reads the model's rows as they are, newest first, filtered on its time column and dimensions", async () => {
    const c = compileRows(
      view,
      { filters: [{ field: "region", in: ["東"] }], limit: 2 },
      { filters: [{ field: "order_date", between: ["2025-01-01", "2026-01-01"] }, { field: "unknown_elsewhere", in: ["x"] }] },
    );
    await expect(c.sql).toMatchFileSnapshot("__snapshots__/rows-filtered.sql");
    expect(c.limit).toBe(2);
    // One more row than the limit: the tile knows there were more.
    expect(await rows(c.sql)).toEqual([
      { order_date: "2025-02-05", order_id: "o3", customer_name: "A社", region: "東", amount: 300 },
      { order_date: "2025-01-10", order_id: "o1", customer_name: "A社", region: "東", amount: 100 },
    ]);
    const sql = compileRows(view, { filters: [{ field: "region", in: ["東"] }], limit: 1 }).sql;
    expect(await rows(sql)).toHaveLength(2);
  });

  it("filters on a dimension's expression, and takes 100,000 rows by default", async () => {
    const c = compileRows(view, {}, { filters: [{ field: "big", in: [true] }] });
    expect(c.limit).toBe(EXPLORE_ROWS);
    expect(c.sql).toContain(`LIMIT ${EXPLORE_ROWS + 1}`);
    expect((await rows(c.sql)).map((r) => r.amount)).toEqual([400, 300, 200]);
  });

  it("refuses a fixed filter on a name the view does not have", () => {
    expect(() => compileRows(view, { filters: [{ field: "nope", in: ["x"] }] })).toThrow(QueryError);
    expect(() => compileRows(view, { filters: [{ field: "nope", in: ["x"] }] })).toThrow("フィルタの nope は sales の軸にありません");
  });
});

describe("fiscal years and Japanese names", () => {
  const jp = parseMetricsYaml(
    `
model: |
  SELECT order_date AS 受注日, customer_name AS 顧客名, amount AS 金額 FROM sales
time: { column: 受注日, label: 受注日, fiscal_year_start: 4 }
dimensions:
  顧客: 顧客名
measures:
  売上: SUM(金額)
  年度累計: { of: 売上, running: fiscal_year }
`,
    "jp",
  );

  it("groups by fiscal year starting in April", async () => {
    const c = compileQuery(jp, { measures: ["売上"], time: "fiscal_year" });
    expect(await rows(c.sql)).toEqual([
      { 受注日: "2024-04-01", 売上: 600 },
      { 受注日: "2025-04-01", 売上: 770 },
    ]);
  });

  it("resets running totals at the fiscal year start", async () => {
    const c = compileQuery(jp, { measures: ["年度累計"], time: "month" });
    expect((await rows(c.sql)).map((r) => r.年度累計)).toEqual([300, 600, 50, 250, 650, 770]);
  });
});
