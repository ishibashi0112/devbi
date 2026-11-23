// A tile's data as CSV (ファイル出力 → CSV), or every tile's in one ZIP. Its own chunk: loaded on the first export.
import { csvParts, writeZip, type TileSpec } from "devbi";
import type { DevbiContextValue } from "../context.js";
import { exportFileName, message, safeFileName, saveFile, tileData, type NoData, type TileData } from "./tile-data.js";
import { dataTiles, tileName } from "./tiles.js";

const CSV_TYPE = "text/csv;charset=utf-8";
const ZIP_TYPE = "application/zip";

/** A tile's CSV: its rows as the tile shows them (without a report table's totals row), values as they are. */
async function tileCsv(ctx: DevbiContextValue, tile: TileSpec): Promise<string[]> {
  const data: TileData | NoData = await tileData(ctx, tile);
  if (data === "skip") throw new Error(`${tileName(tile)} はデータを読まないタイルです`);
  if ("note" in data) throw new Error(`${tileName(tile)}: ${data.note}`);
  return csvParts(data.rows, data.fields);
}

/** ファイル出力 → CSV → a tile: `<title>_<tile>_<date>-<time>.csv`. */
export async function exportTileCsv(ctx: DevbiContextValue, tile: TileSpec): Promise<void> {
  const now = new Date();
  const parts = await tileCsv(ctx, tile);
  saveFile(parts, exportFileName(ctx.dashboard.title, now, "csv", tileName(tile)), CSV_TYPE);
}

/**
 * Every tile's CSV in a ZIP (`<title>_<date>-<time>.zip`), a `<tile>.csv` each, in the dashboard's order. A tile that
 * fails is left out, and named in `エラー.txt` in the ZIP; when every one fails, nothing is saved (the error is thrown).
 */
export async function dashboardCsvZip(ctx: DevbiContextValue, now = new Date()): Promise<Uint8Array> {
  const files: { name: string; data: string[]; modified: Date }[] = [];
  const errors: string[] = [];
  const used = new Set<string>();
  const unique = (name: string) => {
    let n = name;
    for (let i = 2; used.has(n.toLowerCase()); i++) n = `${name} (${i})`;
    used.add(n.toLowerCase());
    return n;
  };
  // One after another, as the Excel export: DuckDB runs one query at a time anyway.
  for (const tile of await dataTiles(ctx)) {
    try {
      files.push({ name: `${unique(safeFileName(tileName(tile), tile.id))}.csv`, data: await tileCsv(ctx, tile), modified: now });
    } catch (e) {
      errors.push(`${tileName(tile)}: ${message(e)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!files.length) throw new Error(errors.length ? errors.join("\n") : "データを読むタイルがありません");
  if (errors.length) files.push({ name: "エラー.txt", data: [`書き出せなかったタイル:\r\n${errors.join("\r\n")}\r\n`], modified: now });
  return writeZip(files);
}

/** ファイル出力 → CSV → すべてのタイル: the ZIP, downloaded. */
export async function exportCsvZip(ctx: DevbiContextValue): Promise<void> {
  const now = new Date();
  saveFile([(await dashboardCsvZip(ctx, now)) as BlobPart], exportFileName(ctx.dashboard.title, now, "zip"), ZIP_TYPE);
}
