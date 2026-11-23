import { describe, expect, it } from "vitest";
import {
  checkParamValues,
  choiceValue,
  dashboardParams,
  dayWord,
  defineDashboard,
  hasValue,
  paramsFromSearch,
  paramsToSearch,
  resolveDefault,
  type DashboardParam,
  type DatasetInfo,
  type TileSpec,
} from "../src/index.js";

const tile = (id: string, query: TileSpec["query"], y = 0): TileSpec => ({ id, type: "table", x: 0, y, w: 12, h: 4, query });

const datasets: Record<string, DatasetInfo> = {
  order_lines: {
    parameters: [
      { name: "from", type: "date", label: "受注日（から）", default: "fiscal_year_start" },
      { name: "to", type: "date", label: "受注日（まで）", optional: true },
      { name: "regions", type: "text", multiple: true, label: "地域", values: "regions", default: "all" },
    ],
    key: ["受注番号", "行番号"],
  },
  regions: { parameters: [] },
  by_region: { parameters: [{ name: "from", type: "date", label: "期間" }, { name: "status" }] },
  customers: { parameters: [{ name: "regions", type: "text", multiple: true }] },
  with_customer: { parameters: [{ name: "customer", type: "integer", values: "customers" }] },
  a: { parameters: [{ name: "x", type: "text", values: "b" }] },
  b: { parameters: [{ name: "y", type: "text", values: "a" }] },
  y_only: { parameters: [{ name: "y", type: "text", values: "a" }] },
  num: { parameters: [{ name: "from", type: "integer" }] },
};

describe("dashboardParams", () => {
  it("takes the parameters of the datasets the tiles read, once per name, in the tiles' order", () => {
    const { params, problems } = dashboardParams({ tiles: [tile("lines", { dataset: "order_lines" })] }, datasets);
    expect(problems).toEqual([]);
    expect(params).toEqual([
      { name: "from", type: "date", multiple: false, label: "受注日（から）", default: "fiscal_year_start", optional: false, hidden: false },
      { name: "to", type: "date", multiple: false, label: "受注日（まで）", optional: true, hidden: false },
      { name: "regions", type: "text", multiple: true, label: "地域", default: "all", values: "regions", optional: false, hidden: false },
    ]);
  });

  it("says when two datasets give a name two labels, until dash.json's params settles it", () => {
    const tiles = [tile("lines", { dataset: "order_lines" }), tile("sum", { dataset: "by_region" }, 4)];
    expect(dashboardParams({ tiles }, datasets).problems).toEqual([
      "パラメーター from の label が api/order_lines.sql と api/by_region.sql で違います。dash.json の params に from の label を書いて決めてください",
    ]);
    const settled = dashboardParams({ tiles, params: { from: { label: "期間（から）" } } }, datasets);
    expect(settled.problems).toEqual([]);
    expect(settled.params.map((p) => [p.name, p.label])).toEqual([
      ["from", "期間（から）"],
      ["to", "受注日（まで）"],
      ["regions", "地域"],
      ["status", "status"],
    ]);
  });

  it("refuses one name with two types, and a type in dash.json that differs", () => {
    const tiles = [tile("lines", { dataset: "order_lines" }), tile("n", { dataset: "num" }, 4)];
    expect(dashboardParams({ tiles }, datasets).problems).toEqual([
      "パラメーター from の型が api/order_lines.sql（date）と api/num.sql（integer）で違います",
    ]);
    expect(dashboardParams({ tiles: [tiles[0]!], params: { regions: { type: "text" } } }, datasets).problems).toEqual([
      "params の regions: type「text」が api/order_lines.sql の text[] と違います",
    ]);
  });

  it("binds a parameter to another dashboard parameter, or to a value of the tile's own (not in the bar)", () => {
    const tiles = [
      tile("lines", { dataset: "order_lines", params: { FROM: { param: "start" }, regions: ["関東"] } }),
      tile("sum", { dataset: "by_region", params: { from: { param: "start" }, status: "出荷済み" } }, 4),
    ];
    const { params, problems } = dashboardParams({ tiles, params: { start: { label: "開始" } } }, datasets);
    expect(problems).toEqual([]);
    expect(params.map((p) => [p.name, p.type, p.label])).toEqual([
      ["start", "date", "開始"],
      ["to", "date", "受注日（まで）"],
    ]);
  });

  it("names what does not exist: a dataset, a key of query.params, a dashboard parameter without a type", () => {
    const tiles = [tile("x", { dataset: "nope" }), tile("lines", { dataset: "order_lines", params: { region: "関東" } }, 4)];
    expect(dashboardParams({ tiles, params: { extra: {} } }, datasets).problems).toEqual([
      "タイル x: データセット nope がありません（api/nope.sql）",
      "タイル lines: query.params の region は api/order_lines.sql のパラメーターにありません（あるのは from、to、regions）",
      "params の extra は、どのデータセットのパラメーターでもないので type を書いてください",
    ]);
  });

  it("adds the parameters of the choices' datasets (cascading), and refuses a ring", () => {
    const { params, problems } = dashboardParams({ tiles: [tile("c", { dataset: "with_customer" })] }, datasets);
    expect(problems).toEqual([]);
    expect(params.map((p) => [p.name, p.type, p.multiple])).toEqual([
      ["customer", "integer", false],
      ["regions", "text", true],
    ]);
    expect(dashboardParams({ tiles: [tile("a", { dataset: "a" })] }, datasets).problems).toEqual([
      "パラメーター x の候補が、まわりまわって x 自身の値を使っています（values の輪）",
      "パラメーター y の候補が、まわりまわって y 自身の値を使っています（values の輪）",
    ]);
    expect(dashboardParams({ tiles: [tile("y", { dataset: "y_only" })] }, datasets).problems).toEqual([
      "パラメーター y の候補が、まわりまわって y 自身の値を使っています（values の輪）",
      "パラメーター x の候補が、まわりまわって x 自身の値を使っています（values の輪）",
    ]);
  });

  it("checks dash.json defaults against the type", () => {
    const tiles = [tile("lines", { dataset: "order_lines" })];
    const issues = (params: Record<string, object>) => dashboardParams({ tiles, params }, datasets).problems;
    expect(issues({ from: { default: "2024-02-30" } })).toEqual(["パラメーター from の default: 「2024-02-30」は日付（2024-04-01 の形）ではありません"]);
    expect(issues({ from: { default: "today-30" }, regions: { default: ["関東", "近畿"] } })).toEqual([]);
    expect(issues({ regions: { default: "関東" } })).toEqual([]);
    expect(issues({ from: { default: ["2024-04-01"] } })).toEqual(["パラメーター from の default: 1 つの値のパラメーターに配列は書けません"]);
    expect(issues({ from: { default: null } })).toEqual(["パラメーター from の default: null は optional のパラメーターだけで使えます"]);
  });
});

describe("dash.json", () => {
  it("takes params, fiscalYearStart, apply and dataset queries", () => {
    const d = defineDashboard(
      {
        fiscalYearStart: 4,
        apply: "button",
        params: { from: { label: "から", default: "month_start" }, regions: { type: "text[]", default: ["関東"] } },
        tiles: [{ id: "t", type: "table", x: 0, y: 0, w: 12, h: 4, query: { dataset: "order_lines", params: { to: { param: "until" } } } }],
      },
      "r",
    );
    expect([d.fiscalYearStart, d.apply, Object.keys(d.params!)]).toEqual([4, "button", ["from", "regions"]]);
  });

  it("refuses a dataset with the metrics' keys, a chart reading a dataset, params without a dataset, user names", () => {
    const bad = (spec: object) => {
      try {
        defineDashboard(spec, "r");
        return [];
      } catch (e) {
        return (e as { issues: { path: string; message: string }[] }).issues.map((i) => `${i.path}: ${i.message}`);
      }
    };
    expect(bad({ tiles: [{ id: "t", type: "table", x: 0, y: 0, w: 1, h: 1, query: { dataset: "x", measures: ["m"] } }] })).toEqual([
      "tiles.0.query.measures: dataset のクエリでは measures は使えません（並べ替えと件数は SQL か表の操作で）",
    ]);
    expect(bad({ tiles: [{ id: "t", type: "bar", x: 0, y: 0, w: 1, h: 1, query: { dataset: "x" } }] })).toEqual([
      "tiles.0.type: データセット（query.dataset）を読めるのは、今は表（table）と自作タイルです",
    ]);
    expect(bad({ tiles: [{ id: "t", type: "table", x: 0, y: 0, w: 1, h: 1, query: { measures: ["m"], params: { a: 1 } } }] })).toEqual([
      "tiles.0.query.params: params は dataset と一緒に書きます",
    ]);
    expect(bad({ params: { "User.region": { type: "text" } }, tiles: [] })[0]).toMatch(/^params\.User\.region: user で始まる名前/);
    expect(bad({ fiscalYearStart: 13, tiles: [] }).length).toBe(1);
  });
});

describe("defaults", () => {
  const now = new Date(2026, 10, 23, 10, 30); // 2026-11-23, local
  const p = (over: Partial<DashboardParam>): DashboardParam => ({ name: "x", multiple: false, label: "x", optional: false, hidden: false, ...over });

  it("works out day words from the viewer's clock", () => {
    expect(
      ["today", "tomorrow", "yesterday", "month_start", "next_month_start", "previous_month_start", "year_start", "today-30", "month_start+14"].map(
        (w) => dayWord(w, now),
      ),
    ).toEqual(["2026-11-23", "2026-11-24", "2026-11-22", "2026-11-01", "2026-12-01", "2026-10-01", "2026-01-01", "2026-10-24", "2026-11-15"]);
    expect([dayWord("fiscal_year_start", now, 4), dayWord("fiscal_year_start", new Date(2026, 2, 31), 4), dayWord("fiscal_year_start", now)]).toEqual([
      "2026-04-01",
      "2025-04-01",
      "2026-01-01",
    ]);
    expect(dayWord("next_month_start", new Date(2026, 11, 31))).toBe("2027-01-01");
  });

  it("gives each type its value; all needs the choices; nothing without a default", () => {
    expect(resolveDefault(p({ type: "date", default: "fiscal_year_start" }), { now, fiscalYearStart: 4 })).toBe("2026-04-01");
    expect(resolveDefault(p({ type: "datetime", default: "today" }), { now })).toBe("2026-11-23T00:00");
    expect(resolveDefault(p({ type: "integer", default: "10" }), { now })).toBe(10);
    expect(resolveDefault(p({ type: "boolean", default: "false" }), { now })).toBe(false);
    expect(resolveDefault(p({ type: "text", multiple: true, default: "関東, 近畿" }), { now })).toEqual(["関東", "近畿"]);
    expect(resolveDefault(p({ type: "integer", multiple: true, default: [1, 2] }), { now })).toEqual([1, 2]);
    expect(resolveDefault(p({ type: "text", multiple: true, values: "regions", default: "all" }), { now })).toBeUndefined();
    expect(resolveDefault(p({ type: "text", multiple: true, values: "regions", default: "all" }), { now, choices: ["関東", "近畿"] })).toEqual(["関東", "近畿"]);
    // the text "all" itself: a list in dash.json
    expect(resolveDefault(p({ type: "text", multiple: true, values: "regions", default: ["all"] }), { now, choices: ["関東"] })).toEqual(["all"]);
    expect(resolveDefault(p({ type: "date" }), { now })).toBeUndefined();
    expect(resolveDefault(p({ type: "date", optional: true }), { now })).toBeNull();
    expect([hasValue(p({}), null), hasValue(p({ optional: true }), null), hasValue(p({ multiple: true }), [])]).toEqual([false, true, false]);
  });

  it("works out day words in a list of dates, and reads `all` without choices as the text, as the server does", () => {
    const dates = p({ type: "date", multiple: true, default: "month_start, today" });
    expect(resolveDefault(dates, { now })).toEqual(["2026-11-01", "2026-11-23"]);
    expect(resolveDefault(p({ type: "date", multiple: true, default: "today" }), { now })).toEqual(["2026-11-23"]);
    expect(resolveDefault(p({ type: "date", multiple: true, default: ["today", "2026-01-05"] }), { now })).toEqual(["2026-11-23", "2026-01-05"]);
    expect(resolveDefault(p({ type: "text", multiple: true, default: "all" }), { now })).toEqual(["all"]);
    const ds = (def: string, type: "date" | "text" | "integer") => ({ parameters: [{ name: "x", type, multiple: true, default: def }] });
    const problems = (info: DatasetInfo) => dashboardParams({ tiles: [tile("t", { dataset: "d" })] }, { d: info }).problems;
    expect(problems(ds("month_start,today", "date"))).toEqual([]);
    expect(problems(ds("all", "text"))).toEqual([]);
    expect(problems(ds("all", "integer"))).toEqual(["パラメーター x の default: 「all」は整数ではありません"]);
  });

  it("takes a choice's value as the parameter's type reads it", () => {
    const at = new Date(Date.UTC(2026, 3, 1, 0, 0));
    expect([choiceValue(at, { type: "date" }), choiceValue(at, { type: "datetime" }), choiceValue(at)]).toEqual(["2026-04-01", "2026-04-01T00:00", "2026-04-01"]);
    expect(choiceValue(new Date(Date.UTC(2026, 3, 1, 9, 0, 30)), { type: "datetime" })).toBe("2026-04-01T09:00:30");
    expect(choiceValue("2026-04-01 09:00:00", { type: "datetime" })).toBe("2026-04-01T09:00");
    expect([choiceValue(12n), choiceValue(2n ** 60n)]).toEqual([12, "1152921504606846976"]);
  });
});

describe("values from outside", () => {
  const params: DashboardParam[] = [
    { name: "from", type: "date", multiple: false, label: "から", optional: false, hidden: false },
    { name: "to", type: "date", multiple: false, label: "まで", optional: true, hidden: false },
    { name: "regions", type: "text", multiple: true, label: "地域", optional: false, hidden: false },
    { name: "customer", type: "integer", multiple: false, label: "顧客", optional: false, hidden: true },
  ];

  it("reads and writes a URL's query (a list as the same key again, a value with a comma as it is)", () => {
    const search = paramsToSearch(params, { from: "2026-04-01", to: null, regions: ["関東", "九州・沖縄", "a,b"], customer: 1024 });
    expect(search).toBe("from=2026-04-01&to=&regions=%E9%96%A2%E6%9D%B1&regions=%E4%B9%9D%E5%B7%9E%E3%83%BB%E6%B2%96%E7%B8%84&regions=a%2Cb&customer=1024");
    expect(paramsFromSearch(params, `?${search}`)).toEqual({ from: "2026-04-01", to: null, regions: ["関東", "九州・沖縄", "a,b"], customer: 1024 });
    // what does not fit is left out (the default stays); names compare without case
    const problems: string[] = [];
    expect(paramsFromSearch(params, "FROM=2026/04/01&customer=x&other=1", problems)).toEqual({});
    expect(problems).toEqual([
      'アドレスのパラメーター from の値 "2026/04/01" は日付（2024-04-01 の形）ではないので使いません',
      'アドレスのパラメーター customer の値 "x" は整数ではないので使いません',
    ]);
    // none picked: written as an empty value, and read back as none (not the default)
    expect(paramsToSearch(params, { regions: [] })).toBe("regions=");
    expect(paramsFromSearch(params, "regions=")).toEqual({ regions: [] });
  });

  it("checks values given by the embed or React", () => {
    expect(checkParamValues(params, { customer: 1024, regions: "関東", to: null, From: "2026-04-01" })).toEqual({
      values: { customer: 1024, regions: ["関東"], to: null, from: "2026-04-01" },
      problems: [],
    });
    expect(checkParamValues(params, { customer: "1.5", from: null, nope: 1 }).problems).toEqual([
      "パラメーター customer の値 \"1.5\" は整数ではありません",
      "パラメーター from の値 null は日付（2024-04-01 の形）ではありません",
      "パラメーター nope はこのダッシュボードにありません",
    ]);
  });
});
