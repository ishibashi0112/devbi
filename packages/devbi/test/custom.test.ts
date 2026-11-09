import { describe, expect, it } from "vitest";
import {
  compileMalloy,
  compileRows,
  compileSource,
  customFields,
  customSelectable,
  customTable,
  customViews,
  parseMetricsYaml,
  QueryError,
  sqlColumns,
  withSources,
  type Filter,
} from "../src/index.js";
import { round, rows } from "./helpers.js";

const view = parseMetricsYaml(
  `
label: 売上
model: SELECT * FROM sales
time: order_date
dimensions:
  customer: { column: customer_name, label: 顧客 }
  region:   { column: region, label: 地域 }
  big:      { sql: "amount >= 200", label: 大口 }
measures:
  total_revenue: { sql: SUM(amount), label: 売上, format: "¥#,##0" }
`,
  "sales",
);

async function describeSql(sql: string): Promise<Record<string, string>> {
  const rs = await rows(`DESCRIBE SELECT * FROM (${sql})`);
  return Object.fromEntries(rs.map((r) => [String(r.column_name), String(r.column_type)]));
}

/** The rows a Malloy or SQL query reads from `sales`, filtered. */
async function source(filters: Filter[] = []) {
  const columns = Object.keys(await describeSql(view.model));
  return { sql: compileSource(view, { columns, filters }), schema: await describeSql(compileSource(view, { columns })) };
}

describe("customViews", () => {
  const names = ["sales", "sales_daily", "目標"];
  it("finds the metrics files a query names, outside strings and comments", () => {
    expect(customViews({ malloy: "run: sales -> { group_by: region } // sales_daily" }, names)).toEqual(["sales"]);
    expect(customViews({ malloy: "run: `目標` -> { where: x = 'sales_daily' }" }, names)).toEqual(["目標"]);
    expect(customViews({ sql: 'SELECT * FROM SALES JOIN "目標" USING (月) -- sales_daily' }, names)).toEqual(["sales", "目標"]);
    expect(customViews({ sql: "SELECT 'sales' AS x /* sales_daily */" }, names)).toEqual([]);
    expect(customViews({ metrics: "sales_daily", sql: "SELECT 1" }, names)).toEqual(["sales_daily"]);
    expect(customViews({ measures: ["x"] }, names)).toEqual([]);
  });

  it("counts only the names read as tables: not a column, an alias, a function or a qualified name", () => {
    const names = ["sales", "customers", "order", "month", "目標"];
    const sql = (text: string) => customViews({ sql: text }, names);
    expect(sql("SELECT 地域, COUNT(DISTINCT 顧客) AS customers FROM sales GROUP BY ALL ORDER BY month(d)")).toEqual(["sales"]);
    expect(sql("SELECT * FROM sales s, 目標 AS t, read_csv('x.csv') WHERE s.customers = t.x")).toEqual(["sales", "目標"]);
    expect(sql("SELECT EXTRACT(month FROM order) FROM main.customers LEFT JOIN 目標 USING (月)")).toEqual(["目標"]);
    expect(sql("WITH t AS (SELECT * FROM sales) SELECT * FROM t WHERE x IN (SELECT y FROM customers)")).toEqual(["sales", "customers"]);
    expect(sql("FROM sales SELECT 1")).toEqual(["sales"]);
    // Every item of a FROM clause, after subqueries, table functions, joins and parentheses.
    expect(sql("SELECT * FROM (SELECT 1 AS z) a, generate_series(1, 3) t(z), sales AS s(a, b), LATERAL (SELECT 1) q, customers")).toEqual([
      "sales",
      "customers",
    ]);
    expect(sql("FROM sales s LEFT JOIN customers c ON s.x = c.x, 目標 t")).toEqual(["sales", "customers", "目標"]);
    expect(sql("FROM month m JOIN (sales s JOIN 目標 t USING (y)) ON m.x = s.x TABLESAMPLE 50%, customers")).toEqual([
      "month",
      "sales",
      "目標",
      "customers",
    ]);
    expect(sql("SELECT (SELECT max(x) FROM 目標), y FROM (sales) UNION ALL TABLE customers")).toEqual(["目標", "sales", "customers"]);
    const malloy = (text: string) => customViews({ malloy: text }, names);
    expect(malloy("run: sales -> { group_by: month; aggregate: customers is count(); order_by: month }")).toEqual(["sales"]);
    expect(
      malloy(
        "source: s is sales extend { join_one: 目標 on 月 = 目標.月; join_many: c is customers on x = c.x }\nrun: s -> { group_by: x }",
      ),
    ).toEqual(["sales", "目標", "customers"]);
    expect(malloy("source: s is `sales`\nrun: s -> { group_by: x }")).toEqual(["sales"]);
    expect(malloy("run: sales extend { join_one: customers on x = customers.x, 目標 on y = 目標.y } -> { group_by: x }")).toEqual([
      "sales",
      "customers",
      "目標",
    ]);
    expect(malloy("source:\n  # tag\n  s IS sales extend { dimension: a is b },\n  c is customers\nrun: s -> { group_by: a }")).toEqual([
      "sales",
      "customers",
    ]);
  });
});

describe("withSources", () => {
  const src = [{ table: '"sales"', sql: "SELECT 1 AS a" }];
  it("puts the rows in front, joined to the query's own WITH", () => {
    expect(withSources("SELECT * FROM sales;", src)).toBe('WITH "sales" AS (\n  SELECT 1 AS a\n)\nSELECT * FROM sales');
    expect(withSources("-- note\nwith recursive t AS (SELECT 1) SELECT * FROM t, sales", src)).toBe(
      '-- note\nWITH RECURSIVE "sales" AS (\n  SELECT 1 AS a\n),\nt AS (SELECT 1) SELECT * FROM t, sales',
    );
    // What follows the last statement goes: the SQL is put in DESCRIBE SELECT * FROM (…).
    expect(withSources("SELECT '--;' AS x FROM sales; -- by region\n/* end */ ;", src)).toBe(
      `WITH "sales" AS (\n  SELECT 1 AS a\n)\nSELECT '--;' AS x FROM sales`,
    );
    expect(withSources("SELECT $$a--b$$ AS x FROM sales;", src)).toBe(
      `WITH "sales" AS (\n  SELECT 1 AS a\n)\nSELECT $$a--b$$ AS x FROM sales`,
    );
  });
});

describe("compileSource", () => {
  it("has the model's columns, the dimensions that are expressions, and the filters", async () => {
    const { sql, schema } = await source([
      { field: "order_date", between: ["2026-01-01", "2027-01-01"] },
      { field: "region", in: ["西"] },
      { field: "elsewhere", in: ["x"] },
    ]);
    expect(Object.keys(schema)).toEqual(["order_date", "order_id", "customer_name", "region", "amount", "big"]);
    expect(await rows(`SELECT order_id, big FROM (${sql}) ORDER BY 1`)).toEqual([
      { order_id: "o6", big: true },
      { order_id: "o7", big: false },
    ]);
  });
});

describe("compileSource with a dimension named like a column", () => {
  it("has the dimension's value under that name, and filters by it", async () => {
    const named = parseMetricsYaml(
      `
model: SELECT * FROM sales
time: order_date
dimensions:
  Region: { sql: "region || '地方'" }
  customer_name: { column: region }
  Order_Date: { sql: "'x'" }
measures:
  n: { sql: COUNT(*) }
`,
      "named",
    );
    const columns = Object.keys(await describeSql(named.model));
    const sql = compileSource(named, { columns, filters: [{ field: "Region", in: ["東地方"] }] });
    // Under the dimension's own name; the time column stays.
    expect(Object.keys(await describeSql(sql))).toEqual(["order_date", "order_id", "amount", "Region", "customer_name"]);
    expect(await rows(`SELECT DISTINCT region, customer_name FROM (${sql})`)).toEqual([{ Region: "東地方", customer_name: "東" }]);
  });
});

describe("Malloy", () => {
  async function run(text: string, filters: Filter[] = []) {
    const s = await source(filters);
    const table = customTable("malloy", "sales");
    const compiled = await compileMalloy(text, [{ name: "sales", table, schema: s.schema }]);
    const result = round(await rows(withSources(compiled.sql, [{ table, sql: s.sql }])));
    const { names, fields } = customFields("malloy", compiled.columns, view);
    return {
      result: result.map((r) => Object.fromEntries(compiled.columns.map((c, i) => [names[i], r[c.name]]))),
      fields,
      sql: compiled.sql,
    };
  }

  it("reads the view's filtered rows; a dimension's column and the truncated time column are those fields", async () => {
    const r = await run(
      "run: sales -> { group_by: region, 月 is order_date.month; aggregate: total_revenue is amount.sum(), 件数 is count(); order_by: 月, region }",
      [{ field: "order_date", between: ["2026-01-01", "2027-01-01"] }],
    );
    expect(r.fields.map((f) => [f.name, f.label, f.kind, f.grain, f.format])).toEqual([
      ["region", "地域", "dimension", undefined, undefined],
      ["order_date", "月", "time", "month", undefined],
      ["total_revenue", "売上", "measure", undefined, "¥#,##0"],
      ["件数", "件数", "measure", undefined, undefined],
    ]);
    expect(r.result).toEqual([
      { region: "東", order_date: "2026-01-01", total_revenue: 200, 件数: 2 },
      { region: "西", order_date: "2026-02-01", total_revenue: 400, 件数: 1 },
      { region: "西", order_date: "2026-03-01", total_revenue: 120, 件数: 1 },
    ]);
  });

  it("`run:` can be left out; a dimension that is an expression is a column", async () => {
    const r = await run("sales -> { group_by: big; aggregate: n is count() }");
    expect(r.fields.map((f) => [f.name, f.label, f.kind])).toEqual([
      ["big", "大口", "dimension"],
      ["n", "n", "measure"],
    ]);
    expect(r.result).toEqual([
      { big: false, n: 5 },
      { big: true, n: 3 },
    ]);
  });

  it("adds run: only when the text, after its comments, does not start with a statement", async () => {
    for (const text of [
      "// TODO: by month\nsales -> { group_by: region; aggregate: n is count() }",
      "/* 地域別 */ sales -> {\n  /* 軸 */ group_by: region\n  aggregate: n is count()\n}",
      "-- run: sales -> { group_by: x }\nrun: sales -> { group_by: region; aggregate: n is count() }",
    ])
      expect((await run(text)).result).toHaveLength(3);
  });

  it("a week is not the time (Malloy's weeks start on Sunday); a click filters by the view's dimensions and time only", async () => {
    const r = await run(
      "// 週ごと\nrun: sales -> { group_by: 週 is order_date.week, m is order_date.month, region, order_id; aggregate: n is count() }",
    );
    expect(r.fields.map((f) => [f.name, f.kind, f.grain])).toEqual([
      ["週", "time", "week"],
      ["order_date", "time", "month"],
      ["region", "dimension", undefined],
      ["order_id", "dimension", undefined],
      ["n", "measure", undefined],
    ]);
    expect([...customSelectable(r.fields, view)]).toEqual(["order_date", "region"]);
  });

  it("reads a time with a time zone as a time", async () => {
    const compiled = await compileMalloy("run: t -> { group_by: m is ts.month, ts }", [
      { name: "t", table: customTable("malloy", "t"), schema: { ts: "TIMESTAMP WITH TIME ZONE" } },
    ]);
    expect(compiled.columns.map((c) => c.type)).toEqual(["timestamp", "timestamp"]);
  });

  it("says what is wrong, and on which line", async () => {
    await expect(run("run: sales -> {\n  group_by: 地\n}")).rejects.toThrow(new QueryError("Malloy: '地' is not defined（2 行目）"));
    await expect(run("run: sales -> { group_by: region; nest: x is { aggregate: n is count() } }")).rejects.toThrow(/x は表にできません/);
  });
});

describe("SQL", () => {
  it("reads the view's filtered rows by its name; columns named as the view's dimensions and measures are those", async () => {
    const s = await source([{ field: "region", in: ["東"] }]);
    const sql = withSources("SELECT customer_name, region AS 地方, SUM(amount) AS total_revenue FROM sales GROUP BY ALL ORDER BY 1", [
      { table: customTable("sql", "sales"), sql: s.sql },
    ]);
    const types = await describeSql(sql);
    const columns = sqlColumns(Object.entries(types).map(([name, type]) => ({ name, type })));
    expect(customFields("sql", sqlColumns([{ name: "REGION", type: "VARCHAR" }]), view).fields.map((f) => f.name)).toEqual(["region"]);
    expect(customFields("sql", columns, view).fields.map((f) => [f.name, f.label, f.kind, f.format])).toEqual([
      ["customer", "顧客", "dimension", undefined],
      ["地方", "地方", "dimension", undefined], // a column renamed in SQL is not known to be the dimension
      ["total_revenue", "売上", "measure", "¥#,##0"],
    ]);
    expect(round(await rows(sql))).toEqual([{ customer_name: "A社", 地方: "東", total_revenue: 600 }]);
  });

  it("a date is not the time: a click on it filters nothing", () => {
    const fields = customFields(
      "sql",
      sqlColumns([
        { name: "order_date", type: "DATE" },
        { name: "n", type: "BIGINT" },
      ]),
      view,
    ).fields;
    expect(fields.map((f) => [f.name, f.kind, f.grain])).toEqual([
      ["order_date", "time", undefined],
      ["n", "measure", undefined],
    ]);
    expect([...customSelectable(fields, view)]).toEqual([]);
  });

  it("knows numbers from DuckDB's and Arrow's type names", () => {
    const types = [
      "INTEGER",
      "UINTEGER",
      "HUGEINT",
      "DECIMAL(18,3)",
      "Int32",
      "Uint8",
      "Float64",
      "Decimal[18e2]",
      "INTERVAL",
      "INTEGER[]",
      "INTEGER[3]",
      "Interval<DAY_TIME>",
    ];
    expect(sqlColumns(types.map((type, i) => ({ name: `c${i}`, type }))).map((c) => c.type)).toEqual([
      ...Array(8).fill("number"),
      ...Array(4).fill("other"),
    ]);
  });
});

describe("explore", () => {
  it("does not take a query in Malloy or SQL", () => {
    expect(() => compileRows(view, { sql: "SELECT 1" })).toThrow(/malloy と sql は使えません/);
  });
});
