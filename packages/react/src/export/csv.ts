// A tile's data as CSV (ファイル出力 → CSV), or every tile's in one ZIP. Its own chunk: loaded on the first export.
import { CSV_BOM, csvParts, writeZip, type TileSpec } from "devbi";
import type { DevbiContextValue } from "../context.js";
import { exportFileName, message, safeFileName, saveFile, tileData, type NoData, type TileData } from "./tile-data.js";
import { tileName, tilesInOrder } from "./tiles.js";

const CSV_TYPE = "text/csv;charset=utf-8";
const ZIP_TYPE = "application/zip";
/** The file in the ZIP that names the tiles that could not be written. */
const PROBLEMS = "書き出せなかったタイル.txt";

/** A tile's CSV: its rows as the tile shows them (without a report table's totals row), values as they are. */
const csvOf = (data: TileData) => csvParts(data.rows, data.fields);

/** The CSV of a tile, or why it has none. */
async function tileCsv(ctx: DevbiContextValue, tile: TileSpec): Promise<string[] | NoData> {
  const data = await tileData(ctx, tile);
  return data === "skip" || "note" in data ? data : csvOf(data);
}

/** ファイル出力 → CSV → a tile: `<title>_<tile>_<date>-<time>.csv`. */
export async function exportTileCsv(ctx: DevbiContextValue, tile: TileSpec): Promise<void> {
  const now = new Date();
  const csv = await tileCsv(ctx, tile);
  if (csv === "skip") throw new Error(`${tileName(tile)} はデータを読まないタイルです`);
  if ("note" in csv) throw new Error(`${tileName(tile)}: ${csv.note}`);
  saveFile(csv, exportFileName(ctx.dashboard.title, now, "csv", tileName(tile)), CSV_TYPE);
}

/**
 * Every tile's CSV in a ZIP (`<title>_<date>-<time>.zip`), a `<tile>.csv` each, in the dashboard's order (the tiles
 * that read no data, such as the period picker, have none). A tile that cannot be written (an error, a tile of your own
 * that reads its data itself) is named in `書き出せなかったタイル.txt` in the ZIP, as the Excel summary names it; when no
 * tile could be written, nothing is saved (the error is thrown).
 */
export async function dashboardCsvZip(ctx: DevbiContextValue, now = new Date()): Promise<Uint8Array> {
  const files: { name: string; data: string[]; modified: Date }[] = [];
  const problems: string[] = [];
  const used = new Set<string>();
  const unique = (name: string) => {
    let n = name;
    for (let i = 2; used.has(n.toLowerCase()); i++) n = `${name} (${i})`;
    used.add(n.toLowerCase());
    return n;
  };
  // One after another, as the Excel export: DuckDB runs one query at a time anyway.
  for (const tile of tilesInOrder(ctx.dashboard.tiles)) {
    try {
      const csv = await tileCsv(ctx, tile);
      if (csv === "skip") continue;
      if ("note" in csv) problems.push(`${tileName(tile)}: ${csv.note}`);
      else files.push({ name: `${unique(safeFileName(tileName(tile), tile.id))}.csv`, data: csv, modified: now });
    } catch (e) {
      problems.push(`${tileName(tile)}: エラー: ${message(e)}`);
    }
    // let the page draw between tiles
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!files.length) throw new Error(problems.length ? problems.join("\n") : "データを読むタイルがありません");
  if (problems.length) {
    files.push({ name: PROBLEMS, data: [`${CSV_BOM}書き出せなかったタイル:\r\n${problems.join("\r\n")}\r\n`], modified: now });
  }
  return writeZip(files);
}

/** ファイル出力 → CSV → すべてのタイル: the ZIP, downloaded. */
export async function exportCsvZip(ctx: DevbiContextValue): Promise<void> {
  const now = new Date();
  saveFile([(await dashboardCsvZip(ctx, now)) as BlobPart], exportFileName(ctx.dashboard.title, now, "zip"), ZIP_TYPE);
}
