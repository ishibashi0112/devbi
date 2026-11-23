import { describe, expect, it } from "vitest";
import { tableColumnProblems, tableColumns, tableOptions, tableView, withColumnOptions, type FieldInfo } from "../src/index.js";

// The options of a report's table (a dataset: api/<name>.sql): the columns, groups, totals, search and row click.
const field = (name: string, kind: FieldInfo["kind"] = "dimension"): FieldInfo => ({ name, label: name, kind });
const FIELDS = [field("顧客ID"), field("地域"), field("顧客"), field("受注数", "measure"), field("金額", "measure"), field("最終受注日", "time")];

describe("tableOptions", () => {
  it("reads every key, with defaults (search on, no groups, no totals)", () => {
    expect(tableOptions(undefined)).toEqual({ options: { groupBy: [], totals: false, search: true }, problems: [] });
    const { options, problems } = tableOptions({
      columns: ["顧客", { field: "金額", label: "売上", format: "¥#,##0", width: 120, align: "right", pin: "left", agg: "avg", style: "bar" }, { field: "地域", hidden: true, filter: false, style: { chips: { 関東: "good" } } }],
      groupBy: "地域",
      totals: true,
      search: false,
      click: { params: { customer: "顧客ID" } },
    });
    expect(problems).toEqual([]);
    expect(options).toEqual({
      columns: [
        { field: "顧客" },
        { field: "金額", label: "売上", format: "¥#,##0", width: 120, align: "right", pin: "left", agg: "avg", style: "bar" },
        { field: "地域", hidden: true, filter: false, style: { chips: { 関東: "good" } } },
      ],
      groupBy: ["地域"],
      totals: true,
      search: false,
      click: { params: { customer: "顧客ID" } },
    });
  });

  it("names each key that is wrong, in Japanese, and leaves it out", () => {
    const { options, problems } = tableOptions({
      columns: ["顧客", "顧客", { label: "x" }, { field: "金額", agg: "median", width: 5, colour: "red", style: "pie" }, 3],
      groupBy: [1],
      totals: "yes",
      limit: 10,
      click: { customer: "顧客ID" },
    });
    expect(problems).toEqual([
      "options.limit はありません（データセットの表の options は columns・groupBy・totals・search・click）",
      "options.columns の 顧客 が 2 回あります",
      "options.columns[2]: field（列の名前）が要ります",
      "options.columns[3].colour はありません（使えるのは field・label・format・width・align・pin・hidden・filter・agg・style）",
      "options.columns[3].width は 20 以上の数（px）で書きます",
      "options.columns[3].agg は sum・avg・min・max・count のどれかです",
      'options.columns[3].style は "bar"（データバー）・"scale"（色の濃さ）か { "chips": { "値": "good", … } } です',
      'options.columns[4] は列の名前か { "field": "列の名前", … } で書きます',
      'options.groupBy は列の名前の配列で書きます（["地域", "顧客"]）',
      "options.totals は true か false です",
      'options.click は { "params": { "パラメーターの名前": "列の名前" } } で書きます',
      "options.click.customer はありません（params だけ）",
    ]);
    expect(options).toEqual({ columns: [{ field: "顧客" }, { field: "金額" }], groupBy: [], totals: false, search: true });
    expect(tableOptions([]).problems).toEqual(["options はオブジェクトで書きます"]);
  });

  it("names the columns the result does not have, once it is read", () => {
    const { options } = tableOptions({ columns: ["顧客", "顧客名"], groupBy: ["支店"], click: { params: { customer: "ID" } } });
    expect(tableColumnProblems(options, FIELDS.map((f) => f.name))).toEqual([
      "options.columns の「顧客名」は結果の列にありません（列: 顧客ID、地域、顧客、受注数、金額、最終受注日）",
      "options.groupBy の「支店」は結果の列にありません（列: 顧客ID、地域、顧客、受注数、金額、最終受注日）",
      "options.click の「ID」は結果の列にありません（列: 顧客ID、地域、顧客、受注数、金額、最終受注日）",
    ]);
  });
});

describe("tableColumns", () => {
  it("every column in the SQL's order without options; labels and formats from options.columns", () => {
    expect(tableColumns(FIELDS, tableOptions(undefined).options).map((v) => [v.field.name, v.agg, v.group])).toEqual(
      FIELDS.map((f) => [f.name, undefined, false]),
    );
    const { options } = tableOptions({ columns: [{ field: "金額", label: "売上", format: "¥#,##0" }] });
    expect(withColumnOptions(FIELDS, options).find((f) => f.name === "金額")).toEqual({ name: "金額", label: "売上", kind: "measure", format: "¥#,##0" });
    expect(tableColumns(FIELDS, options).map((v) => v.field.label)).toEqual(["売上"]);
  });

  it("groups first (hidden when not among the columns); with totals and no agg, the numbers are summed", () => {
    const { options } = tableOptions({ columns: ["顧客", "受注数", "金額"], groupBy: ["地域"], totals: true });
    const views = tableColumns(FIELDS, options);
    expect(views.map((v) => [v.field.name, v.agg ?? null, v.group, v.column.hidden ?? false])).toEqual([
      ["地域", null, true, true],
      ["顧客", null, false, false],
      ["受注数", "sum", false, false],
      ["金額", "sum", false, false],
    ]);
    // An agg on one column: only the columns with one.
    const one = tableColumns(FIELDS, tableOptions({ columns: ["顧客", "受注数", { field: "金額", agg: "max" }], totals: true }).options);
    expect(one.map((v) => v.agg ?? null)).toEqual([null, null, "max"]);
  });

  it("a sheet without the table on the page: the grouping columns, the shown ones, and the totals of the rows", () => {
    const rows = [
      { 顧客ID: 1, 地域: "関東", 顧客: "富士物産", 受注数: 3, 金額: 1200, 最終受注日: null },
      { 顧客ID: 2, 地域: "近畿", 顧客: "浪速工業", 受注数: 1, 金額: null, 最終受注日: null },
      { 顧客ID: 3, 地域: "関東", 顧客: "新規商事", 受注数: null, 金額: 600, 最終受注日: null },
    ];
    const { options } = tableOptions({
      columns: [{ field: "顧客ID", hidden: true }, "顧客", { field: "受注数", agg: "count" }, { field: "金額", agg: "avg" }],
      groupBy: ["地域"],
      totals: true,
    });
    const view = tableView(FIELDS, rows, options);
    expect(view.fields.map((f) => f.name)).toEqual(["地域", "顧客", "受注数", "金額"]);
    expect(view.rows).toBe(rows);
    // count is every row (as the grid counts), avg skips the empty values
    expect(view.total).toEqual({ 地域: null, 顧客: null, 受注数: 3, 金額: 900 });
    expect(tableView(FIELDS, rows, tableOptions(undefined).options).total).toBeUndefined();
  });
});
