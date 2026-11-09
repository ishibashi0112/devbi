import { defineMetricsView, formatDashboardJson } from "devbi";
import { describe, expect, it } from "vitest";
import {
  changeType,
  readsRows,
  fieldsOf,
  filterRow,
  idProblem,
  metricsNameOf,
  moveUp,
  promoteTile,
  rowFilter,
  setDashboardKey,
  setOption,
  setQueryKey,
  setTileKey,
  sortKeys,
  sortSpecs,
  toggle,
  updateTile,
  withKey,
  type FilterRow,
  TILE_KEYS,
} from "../src/edit.js";
import type { RawDashboard, RawTile } from "../src/layout.js";

const sales = defineMetricsView(
  {
    model: "SELECT 1",
    time: { column: "d", label: "日付" },
    dimensions: { region: { column: "r", label: "地域" } },
    measures: { revenue: { sql: "SUM(a)", label: "売上" } },
  },
  "sales",
);
const metrics = { sales };

const tile = (extra: Partial<RawTile> = {}): RawTile => ({ id: "t", x: 0, y: 0, w: 6, h: 4, type: "bar", ...extra });

describe("withKey", () => {
  it("puts a new key where a hand-written file has it, and keeps an existing key in its place", () => {
    const t = { id: "a", x: 0, y: 0, w: 1, h: 1, type: "kpi", query: { measures: ["n"] } };
    expect(Object.keys(setTileKey(t, "title", "売上"))).toEqual(["id", "x", "y", "w", "h", "type", "title", "query"]);
    // A file with its own order: the key stays where it is.
    const odd = { query: {}, title: "a", id: "b" };
    expect(Object.keys(withKey(odd, "title", "c", TILE_KEYS))).toEqual(["query", "title", "id"]);
    // A key the order does not know goes at the end.
    expect(Object.keys(withKey({ a: 1 }, "zzz", 2, TILE_KEYS))).toEqual(["a", "zzz"]);
  });

  it("removes a key set to nothing, and returns the same object when nothing changes", () => {
    const t = tile({ title: "x" });
    for (const empty of [undefined, "", [], {}]) expect(setTileKey(t, "title", empty)).not.toHaveProperty("title");
    expect(setTileKey(t, "title", "x")).toBe(t);
    expect(setTileKey(t, "options", undefined)).toBe(t);
    expect(setTileKey(t, "options", { a: [1] })).toEqual({ ...t, options: { a: [1] } });
  });

  it("keeps the dashboard's keys in their usual order", () => {
    const spec: RawDashboard = { $schema: "s", metrics: "sales", tiles: [] };
    expect(Object.keys(setDashboardKey(spec, "title", "売上"))).toEqual(["$schema", "title", "metrics", "tiles"]);
    expect(formatDashboardJson(setDashboardKey(spec, "description", "説明"))).toBe(
      `{\n  "$schema": "s",\n  "description": "説明",\n  "metrics": "sales",\n  "tiles": []\n}\n`,
    );
  });
});

describe("query and options", () => {
  it("sets query keys in order, and keeps a query left empty (the tile then says what is missing)", () => {
    const t = setQueryKey(tile({ query: { measures: ["revenue"], limit: 3 } }), "time", "month");
    expect(Object.keys(t.query as object)).toEqual(["measures", "time", "limit"]);
    const empty = setQueryKey(setQueryKey(setQueryKey(t, "measures", []), "time", ""), "limit", undefined);
    expect(empty.query).toEqual({});
    expect(setQueryKey(tile(), "limit", undefined)).toEqual(tile());
    expect(Object.keys(setQueryKey(tile({ title: "a" }), "measures", ["revenue"]))).toEqual(["id", "x", "y", "w", "h", "type", "title", "query"]);
  });

  it("sets options in the order the tile type lists them", () => {
    const t = setOption(tile({ type: "pivot", options: { totals: false } }), "columns", "受注日");
    expect(Object.keys(t.options as object)).toEqual(["columns", "totals"]);
    expect(setOption(setOption(t, "columns", ""), "totals", undefined)).not.toHaveProperty("options");
  });

  it("finds the tile's metrics file: its own, the date picker's option, the dashboard's, the only one", () => {
    const spec: RawDashboard = { tiles: [] };
    expect(metricsNameOf(metrics, spec, tile({ query: { metrics: "other" } }))).toBe("other");
    expect(metricsNameOf(metrics, spec, tile({ type: "date-range", options: { metrics: "x" } }))).toBe("x");
    expect(metricsNameOf(metrics, { ...spec, metrics: "y" }, tile())).toBe("y");
    expect(metricsNameOf(metrics, spec, tile())).toBe("sales");
    expect(metricsNameOf({ a: sales, b: sales }, spec, tile())).toBeUndefined();
  });
});

describe("changeType", () => {
  const spec: RawDashboard = { metrics: "sales", tiles: [] };

  it("keeps the query, title and size; keeps only the options the new type has", () => {
    const pivot = tile({ type: "pivot", title: "地域", query: { measures: ["revenue"] }, options: { columns: "d", totals: false } });
    expect(changeType(spec, pivot, "table", metrics)).toEqual({ id: "t", x: 0, y: 0, w: 6, h: 4, type: "table", title: "地域", query: { measures: ["revenue"] } });
    expect(changeType(spec, pivot, "pivot", metrics)).toBe(pivot);
    const select = changeType(spec, pivot, "select", metrics);
    expect(select).not.toHaveProperty("options");
  });

  it("takes the tile's own metrics file along: query.metrics to the period picker's options.metrics, and back", () => {
    const orders = defineMetricsView({ model: "SELECT 1", time: "o", measures: { n: "COUNT(*)" } }, "orders");
    const both = { sales, orders };
    const bar = tile({ query: { metrics: "orders", measures: ["n"], time: "month" } });
    const period = changeType(spec, bar, "date-range", both);
    expect(period).not.toHaveProperty("query");
    expect(period.options).toEqual({ default: "latest_fiscal_year", metrics: "orders" });
    expect(changeType(spec, period, "kpi", both).query).toEqual({ metrics: "orders", measures: ["n"] });
    // A dashboard without its own metrics file and more than one: the period picker names one.
    expect(changeType({ tiles: [] }, tile(), "date-range", both).options).toEqual({ default: "latest_fiscal_year", metrics: "orders" });
  });

  it("drops the query for a type without one, and starts one for a type that needs it", () => {
    const text = changeType(spec, tile({ query: { measures: ["revenue"], time: "month" } }), "markdown", metrics);
    expect(text).not.toHaveProperty("query");
    expect(text.options).toHaveProperty("text");
    const back = changeType(spec, text, "kpi", metrics);
    expect(back.query).toEqual({ measures: ["revenue"] });
    expect(back).not.toHaveProperty("options");
    expect(changeType(spec, tile(), "date-range", metrics).options).toEqual({ default: "latest_fiscal_year" });
  });

  it("starts the query over between the model's rows (explore) and measures, keeping the metrics file, the filters and the period", () => {
    const filters = [{ field: "region", in: ["東"] }];
    const bar = tile({ query: { metrics: "sales", measures: ["revenue"], time: "month", filters, sort: ["-revenue"], limit: 5, period: false } });
    const explore = changeType(spec, bar, "explore", metrics);
    expect(explore.query).toEqual({ metrics: "sales", filters, period: false });
    expect(explore.w).toBe(6);
    expect(changeType(spec, explore, "kpi", metrics).query).toEqual({ metrics: "sales", measures: ["revenue"], filters, period: false });
    // Nothing to keep: no query (all of the model's rows).
    expect(changeType(spec, tile({ query: { measures: ["revenue"] } }), "explore", metrics)).not.toHaveProperty("query");
    expect(readsRows("explore")).toBe(true);
    expect(readsRows("table")).toBe(false);
    expect(readsRows(undefined)).toBe(false);
  });
});

it("points a tile written out as code at its file, keeping its name, place, size and title", () => {
  const pivot = tile({ type: "pivot", title: "地域", query: { measures: ["revenue"] }, options: { totals: false } });
  const promoted = promoteTile(pivot, "./sales/T.tsx");
  expect(promoted).toEqual({ id: "t", x: 0, y: 0, w: 6, h: 4, component: "./sales/T.tsx", title: "地域" });
  expect(Object.keys(promoted)).toEqual(["id", "x", "y", "w", "h", "component", "title"]);
  expect(formatDashboardJson({ tiles: [promoted] })).toContain(`"component": "./sales/T.tsx",\n      "title": "地域"`);
});

it("lists the time column, then the dimensions", () => {
  expect(fieldsOf(sales)).toEqual([
    ["d", "日付"],
    ["region", "地域"],
  ]);
});

describe("names, lists and sort", () => {
  it("refuses an empty name or one another tile has", () => {
    const spec: RawDashboard = { tiles: [tile({ id: "a" }), tile({ id: "b" })] };
    expect(idProblem(spec, "a", "b")).toMatch(/ほかのタイル/);
    expect(idProblem(spec, "a", " ")).toMatch(/入れて/);
    expect(idProblem(spec, "a", "a")).toBeUndefined();
    expect(idProblem(spec, "a", "c")).toBeUndefined();
    expect(updateTile(spec, "a", (t) => setTileKey(t, "id", "c")).tiles.map((t) => t.id)).toEqual(["c", "b"]);
    expect(updateTile(spec, "a", (t) => t)).toBe(spec);
  });

  it("adds a checked name at the end and moves one earlier", () => {
    expect(toggle(["a"], "b")).toEqual(["a", "b"]);
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
    expect(moveUp(["a", "b", "c"], "c")).toEqual(["a", "c", "b"]);
    expect(moveUp(["a", "b"], "a")).toEqual(["a", "b"]);
  });

  it("reads both ways of writing sort, and writes the short one", () => {
    const keys = sortKeys(["-revenue", "region", { field: "d", desc: true }]);
    expect(keys).toEqual([
      { field: "revenue", desc: true },
      { field: "region", desc: false },
      { field: "d", desc: true },
    ]);
    expect(sortSpecs(keys)).toEqual(["-revenue", "region", "-d"]);
  });
});

describe("filters", () => {
  it("shows a period's end as the last day included; the file has the day after", () => {
    const row = filterRow({ field: "d", between: ["2025-04-01", "2026-04-01"] }, "d");
    expect(row).toEqual({ kind: "period", field: "d", from: "2025-04-01", to: "2026-03-31" });
    expect(rowFilter({ kind: "period", field: "d", from: "2025-04-01", to: "2026-03-31" })).toEqual({ field: "d", between: ["2025-04-01", "2026-04-01"] });
    expect(rowFilter({ kind: "period", field: "d", from: null, to: "2024-12-31" })).toEqual({ field: "d", between: [null, "2025-01-01"] });
    expect(rowFilter({ kind: "period", field: "d", from: null, to: null })).toBeNull();
    // A calendar unit stays when the days are changed; an unknown one leaves the filter as written.
    const month = filterRow({ field: "d", between: ["2026-10-01", "2026-11-01"], unit: "month" }, "d");
    expect(month).toEqual({ kind: "period", field: "d", from: "2026-10-01", to: "2026-10-31", unit: "month" });
    expect(rowFilter({ ...(month as Extract<FilterRow, { kind: "period" }>), to: "2026-10-15" })).toEqual({
      field: "d",
      between: ["2026-10-01", "2026-10-16"],
      unit: "month",
    });
    expect(filterRow({ field: "d", between: ["2026-10-01", null], unit: "moon" }, "d").kind).toBe("other");
  });

  it("picks values of a dimension; nothing picked is no filter", () => {
    expect(filterRow({ field: "region", in: ["関東", null] }, "d")).toEqual({ kind: "in", field: "region", values: ["関東", null] });
    expect(rowFilter({ kind: "in", field: "region", values: [] })).toBeNull();
  });

  it("leaves any other form as written (to remove, or to fix in the file)", () => {
    for (const f of [{ field: "region", between: [1, 2] }, { field: "d", in: ["2025-01-01"] }, { field: "d", between: ["2025-01", null] }, "x"]) {
      expect(filterRow(f, "d")).toEqual({ kind: "other", filter: f });
    }
  });
});
