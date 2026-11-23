// The dashboard's data as an Excel workbook (ファイル出力 → Excel). Its own chunk: loaded on the first export.
import {
  addResultTable,
  customQuery,
  formatValue,
  MAX_COLS,
  MAX_ROWS,
  resultCell,
  sheetRef,
  TABLE_STYLES,
  Workbook,
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
import { runQuery, type DevbiContextValue } from "../context.js";
import { snapshotText } from "../describe.js";
import { viewsOf } from "../project.js";
import { pivotFields, pivotModel, totalQuery } from "../tiles/pivot-model.js";
import { exportFileName, filtersText, message, paramsText, saveFile, tileData } from "./tile-data.js";
import { tileName, tilesInOrder } from "./tiles.js";

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
  const totals = tile.options?.totals !== false && !customQuery(query);
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

/** One tile's sheet: its title, what filtered its data, and the data as the tile shows it. */
async function addTile(ctx: DevbiContextValue, book: Workbook, tile: TileSpec): Promise<TileResult | undefined> {
  const data = await tileData(ctx, tile, MAX_ROWS - ROOM);
  if (data === "skip") return undefined;
  if ("note" in data) return { tile, note: data.note };
  const fy = data.fiscalYearStart;
  // before the sheet: a pivot too wide for Excel has none
  const pivot = tile.type === "pivot" ? await pivotTable(ctx, tile, data.query, data, data.filters, fy) : undefined;

  const name = tileName(tile);
  const sheet = book.sheet(name);
  sheet.add({ v: name, s: S.heading, noWidth: true });
  for (const note of data.notes) sheet.add({ v: note, s: S.note, noWidth: true });
  sheet.skip();
  if (pivot) pivot.write(sheet);
  else addResultTable(sheet, data.rows, data.fields, { fiscalYearStart: fy, ...(data.total ? { total: data.total } : {}) });
  const cut = data.cut;
  const note = !cut
    ? undefined
    : cut.by === "max"
      ? "Excel の行数の上限までです"
      : `${cut.newest ? "新しいほうから " : ""}${cut.limit.toLocaleString("ja-JP")} 行までです`;
  return { tile, sheet, rows: pivot?.rows ?? data.rows.length, ...(note ? { note } : {}) };
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
  const tiles = tilesInOrder(dashboard.tiles);
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
  // Only a dashboard with metrics files asks the engine (it would start DuckDB-wasm).
  const views = viewsOf(ctx.project, dashboard);
  const snapshots = !views.length
    ? undefined
    : await ctx.engine
        .then((engine) => Promise.all(views.map((v) => engine.snapshotsOf(v))))
        .then((all) => snapshotText(all.flat()))
        .catch(() => undefined);

  summary.add({ v: dashboard.title, s: S.title, noWidth: true });
  if (dashboard.description) summary.add({ v: dashboard.description, s: S.note, noWidth: true });
  summary.skip();
  const info = (key: string, value: string) => summary.add({ v: key, s: S.key }, { v: value, noWidth: true });
  info("書き出した日時", localTime(now));
  if (snapshots) info("データ", snapshots);
  if (ctx.params.list.length) info("パラメーター", paramsText(ctx));
  if (dashboard.tiles.some((t) => t.query?.dataset === undefined && t.type !== "markdown"))
    info("絞り込み", filtersText(view, [], ctx.selection.entries().flatMap((e) => e.filters)));
  summary.skip();
  const header = summary.add({ v: "タイル", s: S.header }, { v: "行数", s: S.header }, { v: "メモ", s: S.header });
  for (const r of results) {
    const title = tileName(r.tile);
    summary.add(
      r.sheet ? { v: title, s: S.link, link: `${sheetRef(r.sheet.name)}!A1` } : { v: title, s: S.cell },
      r.rows === undefined ? { v: null, s: S.cell } : resultCell(r.rows, { kind: "measure", format: "#,##0" }),
      { v: r.note ?? null, s: S.cell },
    );
  }
  summary.freeze = { rows: header + 1 };
  return book.toBytes();
}

/** ファイル出力 → Excel: the workbook, downloaded as `<title>_<date>-<time>.xlsx`. */
export async function exportXlsx(ctx: DevbiContextValue): Promise<void> {
  const now = new Date();
  saveFile([(await dashboardWorkbook(ctx, now)) as BlobPart], exportFileName(ctx.dashboard.title, now, "xlsx"), XLSX_TYPE);
}
