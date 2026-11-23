/**
 * The `options` of a table tile that reads a dataset (`query.dataset`, a report's table): which columns and in what
 * order, how each shows, groups, a totals row, the search box, and what a click on a row puts in the dashboard's
 * parameters. Shared by the browser (the table and its Excel sheet) and devbi-check.
 */
import type { FieldInfo, Row } from "./types.js";

/** The colors of a status chip (`style: { chips: … }`), as spreadsheet-grid names them. */
export const CHIP_TONES = ["neutral", "info", "good", "warning", "critical"] as const;
export type ChipTone = (typeof CHIP_TONES)[number];

/** What a group's row and the totals row show in a column. `count` is the number of rows. */
export const TABLE_AGGREGATES = ["sum", "avg", "min", "max", "count"] as const;
export type TableAggregate = (typeof TABLE_AGGREGATES)[number];

/** One column of `options.columns`: a column name alone, or with how it shows. */
export interface TableColumn {
  /** The column of the SQL's result. */
  field: string;
  label?: string;
  /** A number format (`¥#,##0`, `0.0%`). */
  format?: string;
  /** In pixels. Without it, as wide as its values. */
  width?: number;
  align?: "left" | "center" | "right";
  /** Kept in view at the left or the right while the table scrolls sideways. */
  pin?: "left" | "right";
  /** Not shown at first (the viewer can show it from the column list). */
  hidden?: boolean;
  /** `false`: no filter in its menu. Default on. */
  filter?: boolean;
  agg?: TableAggregate;
  /** A data bar, a color scale, or status chips (value → tone). */
  style?: "bar" | "scale" | { chips: Record<string, ChipTone> };
}

export interface TableOptions {
  /** The columns shown and their order. Undefined: every column, in the SQL's order. */
  columns?: TableColumn[];
  /** The columns the rows are grouped by, outermost first. */
  groupBy: string[];
  /** A totals row at the bottom. */
  totals: boolean;
  /** The search box above the table. Default on. */
  search: boolean;
  /** A click on a row puts its columns' values in these dashboard parameters (parameter → column). */
  click?: { params: Record<string, string> };
}

/** The keys of a dataset table's `options`. */
export const TABLE_OPTION_KEYS = ["columns", "groupBy", "totals", "search", "click"] as const;
const COLUMN_KEYS = ["field", "label", "format", "width", "align", "pin", "hidden", "filter", "agg", "style"] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (items: readonly string[]) => items.join("・");

/**
 * A dataset table's `options` as the table uses them, and what is wrong with them (Japanese sentences, each naming
 * the key: `options.columns[2].agg は …`). What is wrong is left out of `options`.
 */
export function tableOptions(raw: unknown): { options: TableOptions; problems: string[] } {
  const problems: string[] = [];
  const options: TableOptions = { groupBy: [], totals: false, search: true };
  if (raw === undefined) return { options, problems };
  if (!isObject(raw)) return { options, problems: ["options はオブジェクトで書きます"] };
  for (const key of Object.keys(raw)) {
    if (!(TABLE_OPTION_KEYS as readonly string[]).includes(key)) {
      problems.push(`options.${key} はありません（データセットの表の options は ${list(TABLE_OPTION_KEYS)}）`);
    }
  }

  if (raw.columns !== undefined) {
    if (!Array.isArray(raw.columns)) {
      problems.push('options.columns は配列で書きます（列の名前か { "field": "列の名前", … }）');
    } else {
      const columns: TableColumn[] = [];
      const seen = new Set<string>();
      raw.columns.forEach((c: unknown, i: number) => {
        const col = tableColumn(c, `options.columns[${i}]`, problems);
        if (!col) return;
        if (seen.has(col.field)) {
          problems.push(`options.columns の ${col.field} が 2 回あります`);
          return;
        }
        seen.add(col.field);
        columns.push(col);
      });
      options.columns = columns;
    }
  }

  if (raw.groupBy !== undefined) {
    const g = typeof raw.groupBy === "string" ? [raw.groupBy] : raw.groupBy;
    if (Array.isArray(g) && g.every((x) => typeof x === "string" && x !== "")) options.groupBy = [...new Set(g as string[])];
    else problems.push('options.groupBy は列の名前の配列で書きます（["地域", "顧客"]）');
  }
  for (const key of ["totals", "search"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === "boolean") options[key] = raw[key];
    else problems.push(`options.${key} は true か false です`);
  }

  if (raw.click !== undefined) {
    const params = isObject(raw.click) ? raw.click.params : undefined;
    const extra = isObject(raw.click) ? Object.keys(raw.click).filter((k) => k !== "params") : [];
    if (!isObject(params) || Object.keys(params).length === 0 || !Object.values(params).every((v) => typeof v === "string" && v !== "")) {
      problems.push('options.click は { "params": { "パラメーターの名前": "列の名前" } } で書きます');
    } else {
      options.click = { params: params as Record<string, string> };
    }
    for (const k of extra) problems.push(`options.click.${k} はありません（params だけ）`);
  }
  return { options, problems };
}

function tableColumn(c: unknown, at: string, problems: string[]): TableColumn | undefined {
  if (typeof c === "string") {
    if (c === "") problems.push(`${at}: 列の名前が空です`);
    return c === "" ? undefined : { field: c };
  }
  if (!isObject(c)) {
    problems.push(`${at} は列の名前か { "field": "列の名前", … } で書きます`);
    return undefined;
  }
  if (typeof c.field !== "string" || c.field === "") {
    problems.push(`${at}: field（列の名前）が要ります`);
    return undefined;
  }
  const col: TableColumn = { field: c.field };
  for (const key of Object.keys(c)) {
    if (!(COLUMN_KEYS as readonly string[]).includes(key)) problems.push(`${at}.${key} はありません（使えるのは ${list(COLUMN_KEYS)}）`);
  }
  for (const key of ["label", "format"] as const) {
    if (c[key] === undefined) continue;
    if (typeof c[key] === "string") col[key] = c[key];
    else problems.push(`${at}.${key} は文字で書きます`);
  }
  for (const key of ["hidden", "filter"] as const) {
    if (c[key] === undefined) continue;
    if (typeof c[key] === "boolean") col[key] = c[key];
    else problems.push(`${at}.${key} は true か false です`);
  }
  if (c.width !== undefined) {
    if (typeof c.width === "number" && Number.isFinite(c.width) && c.width >= 20) col.width = c.width;
    else problems.push(`${at}.width は 20 以上の数（px）で書きます`);
  }
  const oneOf = <T extends string>(key: string, values: readonly T[]): T | undefined => {
    const v = c[key];
    if (v === undefined) return undefined;
    if (typeof v === "string" && (values as readonly string[]).includes(v)) return v as T;
    problems.push(`${at}.${key} は ${list(values)} のどれかです`);
    return undefined;
  };
  const align = oneOf("align", ["left", "center", "right"] as const);
  if (align) col.align = align;
  const pin = oneOf("pin", ["left", "right"] as const);
  if (pin) col.pin = pin;
  const agg = oneOf("agg", TABLE_AGGREGATES);
  if (agg) col.agg = agg;
  if (c.style !== undefined) {
    const style = c.style;
    if (style === "bar" || style === "scale") col.style = style;
    else if (isObject(style) && isObject(style.chips) && Object.keys(style).length === 1) {
      const chips: Record<string, ChipTone> = {};
      for (const [value, tone] of Object.entries(style.chips)) {
        if (typeof tone === "string" && (CHIP_TONES as readonly string[]).includes(tone)) chips[value] = tone as ChipTone;
        else problems.push(`${at}.style.chips の ${JSON.stringify(value)} は ${list(CHIP_TONES)} のどれかです`);
      }
      col.style = { chips };
    } else {
      problems.push(`${at}.style は "bar"（データバー）・"scale"（色の濃さ）か { "chips": { "値": "good", … } } です`);
    }
  }
  return col;
}

/**
 * The columns `options` names that the result does not have (`options.columns の「顧客名」は結果の列にありません…`):
 * known only once the dataset has been read.
 */
export function tableColumnProblems(options: TableOptions, fields: readonly string[]): string[] {
  const have = new Set(fields);
  const names = fields.join("、");
  const problems: string[] = [];
  const check = (where: string, name: string) => {
    if (!have.has(name)) problems.push(`${where} の「${name}」は結果の列にありません（列: ${names}）`);
  };
  for (const c of options.columns ?? []) check("options.columns", c.field);
  for (const g of options.groupBy) check("options.groupBy", g);
  for (const col of Object.values(options.click?.params ?? {})) check("options.click", col);
  return problems;
}

/** The result's fields with the labels and formats `options.columns` gives them (the same order, all of them). */
export function withColumnOptions(fields: readonly FieldInfo[], options: TableOptions): FieldInfo[] {
  if (!options.columns?.length) return [...fields];
  const byField = new Map(options.columns.map((c) => [c.field, c]));
  return fields.map((f) => {
    const c = byField.get(f.name);
    if (!c || (c.label === undefined && c.format === undefined)) return f;
    return { ...f, ...(c.label !== undefined ? { label: c.label } : {}), ...(c.format !== undefined ? { format: c.format } : {}) };
  });
}

/** A column of the table as it is drawn: its field (with the options' label and format) and how it shows. */
export interface TableColumnView {
  field: FieldInfo;
  column: TableColumn;
  /** Its aggregate: `agg`, or a sum for a number column when no column has one and there are totals or groups. */
  agg?: TableAggregate;
  /** A grouping column (`groupBy`), outermost first. */
  group: boolean;
}

/**
 * The table's columns in order: those of `options.columns` (or every field), then any `groupBy` column not among
 * them, hidden (the grid shows the groups in a column of its own). Columns the result does not have are left out.
 * With totals or groups and no `agg` anywhere, the number columns (not `-- key:` ones) are summed.
 */
export function tableColumns(fields: readonly FieldInfo[], options: TableOptions): TableColumnView[] {
  const byName = new Map(withColumnOptions(fields, options).map((f) => [f.name, f]));
  const chosen = options.columns ?? fields.map((f) => ({ field: f.name }));
  const views: TableColumnView[] = [];
  const add = (column: TableColumn) => {
    const field = byName.get(column.field);
    if (field && !views.some((v) => v.field.name === field.name)) views.push({ field, column, group: options.groupBy.includes(field.name) });
  };
  for (const c of chosen) add(c);
  for (const g of options.groupBy) add({ field: g, hidden: true });
  const anyAgg = views.some((v) => v.column.agg);
  const sums = !anyAgg && (options.totals || options.groupBy.length > 0);
  for (const v of views) {
    const agg = v.column.agg ?? (sums && v.field.kind === "measure" && !v.group ? "sum" : undefined);
    if (agg) v.agg = agg;
  }
  // The grid groups by the columns in their order: put the groupBy columns first, in groupBy's order.
  const groups = options.groupBy.flatMap((g) => views.filter((v) => v.field.name === g));
  return [...groups, ...views.filter((v) => !v.group)];
}

/** A column's aggregate over the rows (nulls skipped; `count` counts every row, as the grid does). */
function aggregate(rows: readonly Row[], field: string, agg: TableAggregate): number | null {
  if (agg === "count") return rows.length;
  const values: number[] = [];
  for (const r of rows) {
    const v = r[field];
    if (typeof v === "number" && Number.isFinite(v)) values.push(v);
  }
  if (!values.length) return null;
  if (agg === "sum") return values.reduce((a, b) => a + b, 0);
  if (agg === "avg") return values.reduce((a, b) => a + b, 0) / values.length;
  return agg === "min" ? Math.min(...values) : Math.max(...values);
}

/**
 * The table as its `options` first show it, for a sheet written without the table on the page: the grouping columns
 * first, then the columns not hidden, every row (in the SQL's order), and the totals row when `options.totals`.
 */
export function tableView(
  fields: readonly FieldInfo[],
  rows: readonly Row[],
  options: TableOptions,
): { fields: FieldInfo[]; rows: readonly Row[]; total?: Row } {
  const views = tableColumns(fields, options).filter((v) => v.group || !v.column.hidden);
  if (!options.totals) return { fields: views.map((v) => v.field), rows };
  const total: Row = {};
  for (const v of views) total[v.field.name] = v.agg ? aggregate(rows, v.field.name, v.agg) : null;
  return { fields: views.map((v) => v.field), rows, total };
}
