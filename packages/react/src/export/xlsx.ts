// The dashboard's data as an Excel workbook (the Excel button). Its own chunk: loaded on the first export.
import {
  addResultTable,
  checkQuery,
  componentProblem,
  formatValue,
  MAX_COLS,
  MAX_ROWS,
  resolveComponent,
  resultCell,
  sheetRef,
  TABLE_STYLES,
  Workbook,
  type BuiltinTileType,
  type Cell,
  type CellStyle,
  type FieldInfo,
  type Filter,
  type MetricsView,
  type Query,
  type Row,
  type Sheet,
  type TileSpec,
} from "devbi";
import { crossFilters, fieldInfo, runQuery, type DevbiContextValue } from "../context.js";
import { describeFilter, snapshotText } from "../describe.js";
import { viewsOf } from "../project.js";
import { builtinTiles } from "../tiles/index.js";
import { pivotFields, pivotModel, totalQuery } from "../tiles/pivot-model.js";

const S = {
  ...TABLE_STYLES,
  title: { bold: true, size: 14 },
  heading: { bold: true, size: 12 },
  note: { color: "667085" },
  key: { bold: true },
  link: { color: "0563C1", underline: true, border: true },
} satisfies Record<string, CellStyle>;

/** Rows kept under Excel's limit, with room for the title rows above the table. */
const ROOM = 8;

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** What became of a tile: its sheet and row count, or why it has none. */
interface TileResult {
  tile: TileSpec;
  sheet?: Sheet;
  rows?: number;
  note?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `2026/11/8 10:23` (local time). */
const localTime = (d: Date) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${pad(d.getMinutes())}`;

/** A file name for an export: the dashboard's title and the time, without characters file systems refuse. */
export function exportFileName(title: string, now: Date, ext: string): string {
  const name = title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").trim().slice(0, 100) || "dashboard";
  return `${name}_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.${ext}`;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The tile's query as TileFrame runs it. `skip`: a tile that reads no data (markdown, date-range). */
async function queryOf(ctx: DevbiContextValue, tile: TileSpec): Promise<Query | null | "skip"> {
  const builtin = tile.type && Object.hasOwn(builtinTiles, tile.type) ? builtinTiles[tile.type as BuiltinTileType] : undefined;
  if (tile.type && !builtin) throw new Error(`タイルの種類 ${tile.type} はありません`);
  if (builtin?.noQuery) return "skip";
  if (tile.query) return tile.query;
  if (!tile.component) return null;
  const path = resolveComponent(ctx.dashboard.path, tile.component);
  const load = Object.hasOwn(ctx.project.components, path) ? ctx.project.components[path] : undefined;
  if (!load) {
    const problem = componentProblem(path);
    throw new Error(problem ? `${tile.component}: ${problem}` : `タイルのファイル ${path} がありません`);
  }
  const mod = await load();
  return mod.query ? (checkQuery(mod.query, tile.component) as Query) : null;
}

/** `受注日: 2025年4月〜2026年3月、地域: 関東`, or `なし`. */
function filtersText(view: MetricsView | undefined, fields: FieldInfo[], filters: readonly Filter[]): string {
  if (filters.length === 0) return "なし";
  return filters
    .map((f) => `${view ? fieldInfo(view, fields, f.field).label : f.field}: ${describeFilter(f, view?.time?.name === f.field)}`)
    .join("、");
}

/**
 * A pivot tile as on the dashboard: what writes its cross table with totals (the totals row and column only with row
 * fields: without, the one row is its own total), and the rows that has. None when it has no measure or column field.
 */
async function pivotTable(
  ctx: DevbiContextValue,
  tile: TileSpec,
  query: Query,
  result: { rows: Row[]; fields: FieldInfo[] },
  filters: Filter[],
  fy: number,
): Promise<{ rows: number; write: (sheet: Sheet) => void } | undefined> {
  const { m, colField, rowFields } = pivotFields(result.fields, typeof tile.options?.columns === "string" ? tile.options.columns : undefined);
  if (!m || !colField) return undefined;
  const totals = tile.options?.totals !== false;
  const run = async (keep: FieldInfo[]) => (await runQuery(ctx, totalQuery(query, m, keep), filters)).rows;
  const [rowTot, colTot, grand] = await Promise.all([
    totals && rowFields.length ? run(rowFields) : [],
    totals && rowFields.length ? run([colField]) : [],
    totals && rowFields.length ? run([]) : [],
  ]);
  const model = pivotModel(result.rows, colField, rowFields, m, rowTot, colTot);
  const withTotals = totals && rowFields.length > 0;
  const width = rowFields.length + model.colList.length + (withTotals ? 1 : 0);
  if (width > MAX_COLS) {
    throw new Error(`${colField.label} が ${model.colList.length.toLocaleString()} 通りあり、Excel の列数の上限（${MAX_COLS.toLocaleString()}）を超えます`);
  }
  return { rows: model.rowList.length, write: (sheet) => writePivot(sheet, model, m, colField, rowFields, withTotals, grand, fy) };
}

function writePivot(
  sheet: Sheet,
  model: ReturnType<typeof pivotModel>,
  m: FieldInfo,
  colField: FieldInfo,
  rowFields: FieldInfo[],
  withTotals: boolean,
  grand: Row[],
  fy: number,
) {
  const header = sheet.add(
    ...rowFields.map((f) => ({ v: f.label, s: S.header })),
    ...model.colList.map(([, v]) => ({ v: formatValue(v, colField, fy), s: S.header })),
    ...(withTotals ? [{ v: "合計", s: S.header }] : []),
  );
  for (const [rk, r] of model.rowList) {
    sheet.add(
      ...rowFields.map((f) => resultCell(r[f.name], f, fy)),
      ...model.colList.map(([ck]) => resultCell(model.cells.get(`${rk}|${ck}`), m, fy)),
      ...(withTotals ? [resultCell(model.rowTotal.get(rk), m, fy, S.total)] : []),
    );
  }
  if (withTotals) {
    sheet.add(
      ...rowFields.map((_, i): Cell => ({ v: i === 0 ? "合計" : null, s: S.total })),
      ...model.colList.map(([ck]) => resultCell(model.colTotal.get(ck), m, fy, S.total)),
      resultCell(grand[0]?.[m.name], m, fy, S.total),
    );
  }
  sheet.freeze = { rows: header + 1, cols: rowFields.length };
}

/** One tile's sheet: its title, the filters its data went through, and the data as the tile shows it. */
async function addTile(ctx: DevbiContextValue, book: Workbook, tile: TileSpec): Promise<TileResult | undefined> {
  const query = await queryOf(ctx, tile);
  if (query === "skip") return undefined;
  if (!query) return { tile, note: "自分でデータを読むタイルなので書き出せません" };
  const filters = crossFilters(ctx, query, tile.id);
  const view = ctx.view(query.metrics);
  const fy = view.time?.fiscalYearStart ?? 1;
  const result = await runQuery(ctx, query, filters);
  const cut = result.rows.length > MAX_ROWS - ROOM;
  if (cut) result.rows = result.rows.slice(0, MAX_ROWS - ROOM);
  // before the sheet: a pivot too wide for Excel has none
  const pivot = tile.type === "pivot" ? await pivotTable(ctx, tile, query, result, filters, fy) : undefined;

  const name = tile.title ?? tile.id;
  const sheet = book.sheet(name);
  sheet.add({ v: name, s: S.heading, noWidth: true });
  sheet.add({ v: `絞り込み: ${filtersText(view, result.fields, [...(query.filters ?? []), ...filters])}`, s: S.note, noWidth: true });
  sheet.skip();
  if (pivot) pivot.write(sheet);
  else addResultTable(sheet, result.rows, result.fields, { fiscalYearStart: fy });
  return { tile, sheet, rows: pivot?.rows ?? result.rows.length, ...(cut ? { note: "Excel の行数の上限までです" } : {}) };
}

/**
 * The dashboard's data as an .xlsx file: a summary sheet (title, when, the selections), then a sheet for each tile
 * that reads data, with what the tile shows under the current selections. Numbers and dates stay numbers and dates,
 * shown with the metrics' formats; a pivot is its cross table with totals.
 */
export async function dashboardWorkbook(ctx: DevbiContextValue, now = new Date()): Promise<Uint8Array> {
  const { dashboard } = ctx;
  const book = new Workbook();
  const summary = book.sheet("概要");
  const tiles = [...dashboard.tiles].sort((a, b) => a.y - b.y || a.x - b.x);
  const results: TileResult[] = [];
  // One after another: the sheets come in the dashboard's order, and DuckDB runs one query at a time anyway.
  for (const tile of tiles) {
    try {
      const r = await addTile(ctx, book, tile);
      if (r) results.push(r);
    } catch (e) {
      results.push({ tile, note: `エラー: ${message(e)}` });
    }
    // let the page draw between tiles (a table of 100,000 rows takes a few seconds)
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  let view: MetricsView | undefined;
  try {
    view = ctx.view();
  } catch {
    view = undefined;
  }
  const snapshots = await ctx.engine
    .then((engine) => Promise.all(viewsOf(ctx.project, dashboard).map((v) => engine.snapshotsOf(v))))
    .then((all) => snapshotText(all.flat()))
    .catch(() => undefined);

  summary.add({ v: dashboard.title, s: S.title, noWidth: true });
  if (dashboard.description) summary.add({ v: dashboard.description, s: S.note, noWidth: true });
  summary.skip();
  const info = (key: string, value: string) => summary.add({ v: key, s: S.key }, { v: value, noWidth: true });
  info("書き出した日時", localTime(now));
  if (snapshots) info("データ", snapshots);
  info("絞り込み", filtersText(view, [], ctx.selection.entries().flatMap((e) => e.filters)));
  summary.skip();
  const header = summary.add({ v: "タイル", s: S.header }, { v: "行数", s: S.header }, { v: "メモ", s: S.header });
  for (const r of results) {
    const title = r.tile.title ?? r.tile.id;
    summary.add(
      r.sheet ? { v: title, s: S.link, link: `${sheetRef(r.sheet.name)}!A1` } : { v: title, s: S.cell },
      r.rows === undefined ? { v: null, s: S.cell } : resultCell(r.rows, { kind: "measure", format: "#,##0" }),
      { v: r.note ?? null, s: S.cell },
    );
  }
  summary.freeze = { rows: header + 1 };
  return book.toBytes();
}

/** Save a file the page made (the browser's download). */
export function saveFile(bytes: Uint8Array, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
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

/** The Excel button: the workbook, downloaded as `<title>_<date>-<time>.xlsx`. */
export async function exportXlsx(ctx: DevbiContextValue): Promise<void> {
  const now = new Date();
  saveFile(await dashboardWorkbook(ctx, now), exportFileName(ctx.dashboard.title, now, "xlsx"), XLSX_TYPE);
}
