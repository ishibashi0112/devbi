// A tile's data as the ファイル出力 menu writes it (an Excel sheet, a CSV file): the rows the tile shows under the
// current selections. Shared by the Excel and CSV chunks.
import {
  compileRows,
  tableOptions,
  tableView,
  tileBindings,
  type FieldInfo,
  type Filter,
  type MetricsView,
  type ParamValue,
  type Query,
  type Row,
  type TileSpec,
} from "devbi";
import { tableToRows } from "../arrow-rows.js";
import { crossFilters, fieldInfo, queryView, runQuery, type DevbiContextValue, type TableExport } from "../context.js";
import { describeFilter } from "../describe.js";
import { queryOf, readsRows } from "./tiles.js";

/** A tile's rows, and what they went through. */
export interface TileData {
  tile: TileSpec;
  query: Query;
  /** The other tiles' selections on it. */
  filters: Filter[];
  fiscalYearStart: number;
  fields: FieldInfo[];
  rows: Row[];
  /** A report table's totals row, as the table shows it. */
  total?: Row;
  /** What filtered the rows, a line each (`絞り込み: …`, `パラメーター: …`): under the sheet's title. */
  notes: string[];
  /** Rows were left out: at `maxRows`, or at the explore tile's `limit` (its newest rows when `newest`). */
  cut?: { by: "max" } | { by: "limit"; limit: number; newest: boolean };
}

/** No data to write: a tile that reads none (`skip`), or why it could not be written. */
export type NoData = "skip" | { note: string };

const pad = (n: number) => String(n).padStart(2, "0");

/** `20261108-1023` (local time). */
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

/** A name without characters file systems refuse (`\ / : * ? " < > |`): for files and the names inside a ZIP. */
export const safeFileName = (name: string, fallback: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").trim().slice(0, 100) || fallback;

/** A file name for an export: the dashboard's title (and a part of it, such as a tile's) and the time. */
export function exportFileName(title: string, now: Date, ext: string, part?: string): string {
  const name = safeFileName(title, "dashboard");
  return `${name}${part === undefined ? "" : `_${safeFileName(part, "tile")}`}_${stamp(now)}.${ext}`;
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A date and time as parameters hold it (`2026-04-01T09:00`): written with a space. */
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** A parameter's value as the sheets note it: `2026/4/1`, `関東・近畿`, `（指定なし）`. */
export function paramValueText(v: ParamValue | undefined, choices?: Map<string, string>): string {
  if (v === undefined) return "（未入力）";
  if (v === null) return "（指定なし）";
  const one = (x: Exclude<ParamValue, null | unknown[]>) =>
    choices?.get(String(x)) ??
    (typeof x === "boolean" ? (x ? "はい" : "いいえ") : typeof x === "string" && DATETIME.test(x) ? x.replace("T", " ") : String(x));
  return Array.isArray(v) ? v.map(one).join("・") : one(v);
}

/** `受注日（から） 2026-04-01、地域 関東・近畿`: the values of the given parameters (all when none given). */
export function paramsText(ctx: DevbiContextValue, names?: string[]): string {
  const list = ctx.params.list.filter((p) => !names || names.some((n) => n.toLowerCase() === p.name.toLowerCase()));
  return list
    .map((p) => {
      const choices = new Map((ctx.params.choicesOf(p.name)?.items ?? []).map((c) => [String(c.value), c.label]));
      return `${p.label} ${paramValueText(ctx.params.value(p.name), choices)}`;
    })
    .join("、");
}

/** `受注日: 2025年4月〜2026年3月、地域: 関東`, or `なし`. */
export function filtersText(view: MetricsView | undefined, fields: FieldInfo[], filters: readonly Filter[]): string {
  if (filters.length === 0) return "なし";
  return filters
    .map((f) => `${view ? fieldInfo(view, fields, f.field).label : f.field}: ${describeFilter(f, view?.time?.name === f.field)}`)
    .join("、");
}

/**
 * An explore tile's data: the model's rows it reads (the period and the other tiles' selections applied), as they
 * are, for a pivot table in Excel. How the viewer has arranged them is not written (Perspective's own export does).
 */
async function rowsData(ctx: DevbiContextValue, tile: TileSpec, maxRows: number): Promise<TileData> {
  const query: Query = tile.query ?? {};
  const filters = crossFilters(ctx, query, tile.id);
  const view = ctx.view(query.metrics);
  const engine = await ctx.engine;
  const { sql, limit, newest } = compileRows(view, query, { filters, model: await engine.loadView(view) });
  const table = await engine.table(sql);
  const max = Math.min(limit, maxRows);
  const rows = tableToRows(table.numRows > max ? table.slice(0, max) : table);
  // The model's columns, not measures: numbers and dates as they are, labelled with their names.
  const fields: FieldInfo[] = table.schema.fields.map((f) => ({ name: f.name, label: f.name, kind: "dimension" }));
  const notes = [
    `絞り込み: ${filtersText(view, [], [...(query.filters ?? []), ...filters])}`,
    "明細の行です。画面での並べ方と集計は、探索タイルの「書き出し」で書き出せます",
  ];
  const cut = table.numRows <= max ? undefined : max < limit ? ({ by: "max" } as const) : ({ by: "limit", limit, newest } as const);
  return { tile, query, filters, fiscalYearStart: view.time?.fiscalYearStart ?? 1, fields, rows, notes, ...(cut ? { cut } : {}) };
}

/** A dataset table's rows: what the table on the page shows, else its rows with its options (no options: undefined). */
function datasetTable(ctx: DevbiContextValue, tile: TileSpec, rows: readonly Row[], fields: FieldInfo[]): TableExport | undefined {
  const shown = ctx.tables.get(tile.id)?.();
  if (shown && shown.fields.length) return shown;
  // A table written out as code has its options in its file: its rows as they came.
  if (tile.type !== "table") return undefined;
  const { options, problems } = tableOptions(tile.options);
  if (problems.length) return undefined;
  const view = tableView(fields, rows, options);
  return { ...view, rows: [...view.rows], filtered: false };
}

/**
 * A tile's data as the tile shows it under the current selections: its query re-run with the other tiles' selections
 * (its own selection does not filter itself), a report's table as the viewer has it on the page (the columns shown,
 * filtered, sorted, its totals row), an explore tile's model rows. At most `maxRows` rows.
 */
export async function tileData(ctx: DevbiContextValue, tile: TileSpec, maxRows = Infinity): Promise<TileData | NoData> {
  if (readsRows(tile)) return rowsData(ctx, tile, maxRows);
  const query = await queryOf(ctx, tile);
  if (query === "skip") return "skip";
  if (!query) return { note: "自分でデータを読むタイルなので書き出せません" };
  const filters = crossFilters(ctx, query, tile.id);
  const view = queryView(ctx, query);
  const fiscalYearStart = view?.time?.fiscalYearStart ?? 1;
  const result = await runQuery(ctx, query, filters);
  // (A table written out as code is on the page as a table too.)
  const table =
    query.dataset !== undefined && (tile.type === "table" || ctx.tables.has(tile.id)) ? datasetTable(ctx, tile, result.rows, result.fields) : undefined;
  const out = table ?? result;
  const cut = out.rows.length > maxRows;
  const rows = cut ? out.rows.slice(0, maxRows) : out.rows;

  const notes: string[] = [];
  if (query.dataset !== undefined) {
    // A dataset's rows: the parameters it ran with (its own values and the dashboard's).
    const info = ctx.project.datasets[query.dataset];
    const bound = info ? tileBindings(tile, info) : [];
    const own = bound.filter((b) => b.param === undefined).map((b) => `${b.name} ${paramValueText(b.value)}`);
    const fromBar = paramsText(ctx, bound.flatMap((b) => (b.param === undefined ? [] : [b.param])));
    notes.push(`パラメーター: ${[fromBar, ...own].filter(Boolean).join("、") || "なし"}`);
    if (table?.filtered) notes.push("表の検索・列のフィルターで絞った行です");
  } else {
    notes.push(`絞り込み: ${filtersText(view, result.fields, [...(query.filters ?? []), ...filters])}`);
  }
  return {
    tile,
    query,
    filters,
    fiscalYearStart,
    fields: out.fields,
    rows,
    ...(table?.total ? { total: table.total } : {}),
    notes,
    ...(cut ? { cut: { by: "max" } as const } : {}),
  };
}

/** Save a file the page made (the browser's download). */
export function saveFile(data: BlobPart[], name: string, type: string): void {
  const url = URL.createObjectURL(new Blob(data, { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  // after the download has started (Safari reads the URL a moment later)
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
