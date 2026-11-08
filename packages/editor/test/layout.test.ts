import { defineMetricsView } from "devbi";
import { describe, expect, it } from "vitest";
import { freeId, newTile, placeTiles, type RawDashboard } from "../src/layout.js";

const view = defineMetricsView(
  {
    model: "SELECT 1",
    time: { column: "d", label: "日付" },
    dimensions: { region: { column: "r", label: "地域" }, product: { column: "p", label: "商品" } },
    measures: { revenue: { sql: "SUM(a)", label: "売上" } },
  },
  "sales",
);

const spec = (): RawDashboard => ({
  title: "t",
  tiles: [
    { id: "kpi", x: 0, y: 0, w: 3, h: 2, type: "kpi", title: "売上", query: { measures: ["revenue"] } },
    { id: "about", x: 0, y: 2, w: 12, h: 1, type: "markdown" },
  ],
});

describe("placeTiles", () => {
  it("changes only the tiles that moved, keeping their other keys and the key order", () => {
    const s = spec();
    const moved = placeTiles(s, [
      { i: "kpi", x: 0, y: 0, w: 3, h: 2 },
      { i: "about", x: 3, y: 0, w: 9, h: 1 },
    ]);
    expect(moved.tiles[0]).toBe(s.tiles[0]);
    expect(moved.tiles[1]).toEqual({ id: "about", x: 3, y: 0, w: 9, h: 1, type: "markdown" });
    expect(Object.keys(moved.tiles[1]!)).toEqual(["id", "x", "y", "w", "h", "type"]);
    expect(moved.title).toBe("t");
  });

  it("returns the same object when nothing moved", () => {
    const s = spec();
    expect(placeTiles(s, [{ i: "kpi", x: 0, y: 0, w: 3, h: 2 }])).toBe(s);
  });
});

describe("newTile", () => {
  it("starts at the bottom with the type's size and a query that shows something", () => {
    expect(newTile("bar", spec(), view, false)).toEqual({
      id: "bar",
      x: 0,
      y: 3,
      w: 6,
      h: 4,
      type: "bar",
      title: "月別売上",
      query: { measures: ["revenue"], time: "month" },
    });
    expect(newTile("barlist", spec(), view, false).query).toEqual({ measures: ["revenue"], dimensions: ["region"] });
    expect(newTile("table", spec(), view, false).query).toEqual({ measures: ["revenue"], dimensions: ["region", "product"], limit: 100 });
    expect(newTile("date-range", spec(), view, false)).toMatchObject({ w: 12, h: 1, options: { default: "latest_fiscal_year" } });
    expect(newTile("date-range", spec(), view, false)).not.toHaveProperty("query");
  });

  it("takes a free id, and names the metrics file when the dashboard has none to share", () => {
    const t = newTile("kpi", spec(), view, true);
    expect(t.id).toBe("kpi-2");
    expect(t.query).toEqual({ metrics: "sales", measures: ["revenue"] });
    expect(freeId("a", ["a", "a-2"])).toBe("a-3");
  });

  it("keeps a new tile inside a narrower grid", () => {
    expect(newTile("table", { columns: 6, tiles: [] }, view, false)).toMatchObject({ x: 0, y: 0, w: 6 });
  });
});
