import { defineDashboard, type DatasetInfo, type FieldInfo, type ParamValue } from "devbi";
import { describe, expect, it, vi } from "vitest";
import type { DatasetResult } from "../src/dataset.js";
import { DashboardParams } from "../src/param-store.js";

// The parameter bar's values without React: defaults, the choices (and choices that follow another parameter),
// 表示 with apply: "button", 更新, and what a dataset tile sends.
const datasets: Record<string, DatasetInfo> = {
  order_lines: {
    parameters: [
      { name: "from", type: "date", label: "受注日（から）", default: "fiscal_year_start" },
      { name: "to", type: "date", label: "受注日（まで）", optional: true },
      { name: "regions", type: "text", multiple: true, label: "地域", values: "regions", default: "all" },
    ],
  },
  regions: { parameters: [] },
  // Customers of one region: its choices follow the region picked.
  sales: {
    parameters: [
      { name: "region", type: "text", label: "地域", values: "regions" },
      { name: "customer", type: "integer", label: "顧客", values: "customers" },
    ],
  },
  customers: { parameters: [{ name: "region", type: "text", label: "地域", values: "regions" }] },
};

const text = (name: string): FieldInfo => ({ name, label: name, kind: "dimension" });
const CUSTOMERS: Record<string, [number, string][]> = {
  関東: [
    [1, "富士物産"],
    [2, "三河物産"],
  ],
  近畿: [[3, "浪速工業"]],
};

function reader() {
  const calls: { name: string; params: Record<string, ParamValue> }[] = [];
  const pending: (() => void)[] = [];
  const read = vi.fn((name: string, params: Record<string, ParamValue>): Promise<DatasetResult> => {
    calls.push({ name, params });
    const result =
      name === "regions"
        ? { rows: [{ 地域: "関東" }, { 地域: "近畿" }], fields: [text("地域")] }
        : name === "customers"
          ? {
              rows: (CUSTOMERS[String(params.region)] ?? []).map(([id, n]) => ({ id, name: n })),
              fields: [{ name: "id", label: "id", kind: "dimension" as const }, text("name")],
            }
          : { rows: [], fields: [] };
    return new Promise((resolve) => pending.push(() => resolve(result)));
  });
  /** Answer the reads so far (and those they start), then let the store take them. */
  const settle = async () => {
    for (let i = 0; i < 10 && pending.length; i++) {
      for (const go of pending.splice(0)) go();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { read, calls, settle };
}

const NOW = new Date(2026, 10, 23, 10, 0); // 2026-11-23 in Tokyo

function store(spec: Record<string, unknown>, given: Record<string, ParamValue> = {}) {
  const r = reader();
  const dashboard = defineDashboard({ title: "t", ...spec }, "t", "dashboards/t.dash.json");
  return { ...r, s: new DashboardParams(dashboard, datasets, r.read, given, NOW), dashboard };
}

const linesTile = { id: "lines", x: 0, y: 0, w: 12, h: 4, type: "table", query: { dataset: "order_lines" } };

describe("DashboardParams", () => {
  it("starts from the defaults; `all` waits for the choices, then takes every one", async () => {
    const { s, settle, calls } = store({ fiscalYearStart: 4, tiles: [linesTile] });
    const query = { dataset: "order_lines" };
    expect(s.list.map((p) => p.name)).toEqual(["from", "to", "regions"]);
    expect(s.value("from")).toBe("2026-04-01");
    expect(s.value("to")).toBeNull();
    expect(s.request(query, datasets.order_lines!)).toEqual({ waiting: true });
    s.start();
    await settle();
    expect(calls).toEqual([{ name: "regions", params: {} }]);
    expect(s.value("regions")).toEqual(["関東", "近畿"]);
    expect(s.request(query, datasets.order_lines!)).toEqual({ params: { from: "2026-04-01", to: null, regions: ["関東", "近畿"] } });
    // The default (`all`, today's fiscal year) is not written in the address.
    expect(s.changedValues()).toEqual({});
    s.set("regions", ["近畿"]);
    expect(s.changedValues()).toEqual({ regions: ["近畿"] });
  });

  it("says which required values are missing", () => {
    const { s } = store({ tiles: [linesTile] }, { regions: ["関東"] });
    s.set("from", undefined);
    expect(s.request({ dataset: "order_lines" }, datasets.order_lines!)).toEqual({ missing: ["受注日（から）"] });
  });

  it("a tile's own value, and a dashboard parameter under another name", () => {
    const { s } = store({
      params: { since: { type: "date", label: "いつから", default: "2025-04-01" } },
      tiles: [{ ...linesTile, query: { dataset: "order_lines", params: { from: { param: "since" }, regions: ["関東"] } } }],
    });
    expect(s.list.map((p) => p.name)).toEqual(["since", "to"]);
    expect(s.request({ dataset: "order_lines", params: { from: { param: "since" }, regions: ["関東"] } }, datasets.order_lines!)).toEqual({
      params: { from: "2025-04-01", to: null, regions: ["関東"] },
    });
    // A parameter no dash.json tile gave the bar (a promoted tile's own query): an error that says what to write.
    expect(() => s.request({ dataset: "order_lines", params: { from: { param: "nope" } } }, datasets.order_lines!)).toThrow(
      "パラメーター nope の欄がありません",
    );
  });

  it("with apply: button, the tiles keep the applied values until 表示", async () => {
    const { s, settle } = store({ apply: "button", tiles: [linesTile] }, { from: "2024-04-01", regions: ["関東"] });
    s.start();
    await settle();
    s.set("from", "2025-04-01");
    expect(s.dirty()).toBe(true);
    expect(s.draftValue("from")).toBe("2025-04-01");
    expect(s.value("from")).toBe("2024-04-01");
    s.applyDraft();
    expect(s.dirty()).toBe(false);
    expect(s.value("from")).toBe("2025-04-01");
  });

  it("choices that follow another parameter: read with its value, and a value no longer there goes back", async () => {
    const tiles = [{ id: "s", x: 0, y: 0, w: 12, h: 4, type: "table", query: { dataset: "sales" } }];
    const { s, settle, calls } = store({ tiles }, { region: "関東", customer: 2 });
    s.start();
    await settle();
    expect(s.choicesOf("customer")?.items).toEqual([
      { value: 1, label: "富士物産" },
      { value: 2, label: "三河物産" },
    ]);
    expect(s.value("customer")).toBe(2);
    s.set("region", "近畿");
    await settle();
    expect(calls.filter((c) => c.name === "customers").map((c) => c.params)).toEqual([{ region: "関東" }, { region: "近畿" }]);
    expect(s.choicesOf("customer")?.items).toEqual([{ value: 3, label: "浪速工業" }]);
    // 三河物産 is not in 近畿: no default, so empty (the tile asks for it).
    expect(s.value("customer")).toBeUndefined();
    expect(s.request({ dataset: "sales" }, datasets.sales!)).toEqual({ missing: ["顧客"] });
  });

  it("a table's row click puts values in (others kept); a second click puts them back to their default", async () => {
    const tiles = [{ id: "s", x: 0, y: 0, w: 12, h: 4, type: "table", query: { dataset: "sales" } }];
    const { s, settle } = store({ params: { customer: { optional: true } }, tiles }, { region: "関東" });
    s.start();
    await settle();
    expect(s.value("customer")).toBeNull();
    let heard = 0;
    s.subscribe(() => heard++);
    s.setValues({ customer: 2 });
    expect([s.value("region"), s.value("customer"), s.draftValue("customer")]).toEqual(["関東", 2, 2]);
    expect(s.changedValues()).toEqual({ region: "関東", customer: 2 });
    s.reset(["customer"]);
    expect(s.value("customer")).toBeNull();
    expect(s.changedValues()).toEqual({ region: "関東" });
    // already at its default: nothing changes, nobody hears of it
    const before = heard;
    s.reset(["customer", "nope"]);
    expect(heard).toBe(before);
  });

  it("更新 reads the choices again", async () => {
    const { s, settle, calls } = store({ tiles: [linesTile] });
    s.start();
    await settle();
    expect(calls).toHaveLength(1);
    s.refresh();
    await settle();
    expect(calls).toHaveLength(2);
    expect(s.refreshes).toBe(1);
  });

  it("`all` stops waiting when its choices cannot be read, or asks for what they need; more than 1,000 values is said", async () => {
    // The choices fail: the tile asks for the value instead of waiting.
    const failing = store({ tiles: [linesTile] }, { from: "2024-04-01" });
    failing.read.mockImplementation(() => Promise.reject(new Error("API の regions を読めません（500）")));
    failing.s.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(failing.s.choicesOf("regions")?.error?.message).toBe("API の regions を読めません（500）");
    expect(failing.s.request({ dataset: "order_lines" }, datasets.order_lines!)).toEqual({ missing: ["地域"] });

    // Choices that need a value not filled in: the tile asks for that one.
    const cascade: Record<string, DatasetInfo> = {
      ...datasets,
      orders: { parameters: [{ name: "customers", type: "integer", multiple: true, label: "顧客", values: "customers", default: "all" }] },
      customers: { parameters: [{ name: "region", type: "text", label: "地域" }] },
    };
    const r = reader();
    const dashboard = defineDashboard({ title: "t", tiles: [{ ...linesTile, query: { dataset: "orders" } }] }, "t", "dashboards/t.dash.json");
    const s = new DashboardParams(dashboard, cascade, r.read, {}, NOW);
    s.start();
    expect(s.request({ dataset: "orders" }, cascade.orders!)).toEqual({ missing: ["地域"] });

    const many = store({ tiles: [linesTile] }, { from: "2024-04-01", regions: Array.from({ length: 1001 }, (_, i) => `r${i}`) });
    const req = many.s.request({ dataset: "order_lines" }, datasets.order_lines!);
    expect("error" in req && req.error).toMatch(/^地域（1,001 個）: 1 つのパラメーターで送れる値は 1,000 個までです/);
  });

  it("opens with none picked from the address (regions=), after the choices too", async () => {
    const { s, settle } = store({ tiles: [linesTile] }, { from: "2024-04-01", regions: [] });
    s.start();
    await settle();
    expect(s.value("regions")).toEqual([]);
    expect(s.request({ dataset: "order_lines" }, datasets.order_lines!)).toEqual({ missing: ["地域"] });
    expect(s.changedValues()).toEqual({ from: "2024-04-01", regions: [] });
  });

  it("an address sets its values and puts the ones it leaves out back to their default", async () => {
    const { s, settle } = store({ fiscalYearStart: 4, tiles: [linesTile] });
    s.start();
    await settle();
    s.setValues({ from: "2024-04-01", regions: ["近畿"] });
    s.setValues({ regions: [] }, { others: "default" });
    expect([s.value("from"), s.value("regions")]).toEqual(["2026-04-01", []]);
    // None picked stays none when the choices are read again.
    s.refresh();
    await settle();
    expect(s.value("regions")).toEqual([]);
    s.setValues({}, { others: "default" });
    expect(s.value("regions")).toEqual(["関東", "近畿"]);
  });

  it("values from outside (the address, React's params) are applied at once, in the bar too", async () => {
    const { s, settle } = store({ apply: "button", tiles: [linesTile] });
    s.start();
    await settle();
    s.setValues({ from: "2024-04-01", regions: ["近畿"] });
    expect(s.value("from")).toBe("2024-04-01");
    expect(s.draftValue("regions")).toEqual(["近畿"]);
    expect(s.dirty()).toBe(false);
  });
});
