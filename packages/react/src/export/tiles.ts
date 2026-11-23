// Which tiles the ファイル出力 menu writes data for, and the query each runs. Small and in the main bundle: the menu
// lists the tiles before any export's chunk is loaded.
import { checkQuery, componentProblem, resolveComponent, TILE_TYPES, type BuiltinTileType, type Query, type TileSpec, type TileTypeInfo } from "devbi";
import type { DevbiContextValue } from "../context.js";
import { builtinTiles } from "../tiles/index.js";

/** A tile that reads the model's rows as they are (`explore`), not the query's measures. */
export function readsRows(tile: TileSpec): boolean {
  return !!tile.type && Object.hasOwn(TILE_TYPES, tile.type) && !!(TILE_TYPES[tile.type as BuiltinTileType] as TileTypeInfo).rows;
}

/** The tile's query as TileFrame runs it. `skip`: a tile that reads no data (markdown, date-range). */
export async function queryOf(ctx: DevbiContextValue, tile: TileSpec): Promise<Query | null | "skip"> {
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

/** The dashboard's tiles in its order (top to bottom, then left to right). */
export const tilesInOrder = (tiles: readonly TileSpec[]) => [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);

/**
 * The tiles a CSV can be written for, in the dashboard's order: those that read data with a query (not the period
 * picker or text, not a tile of your own that reads its data itself, not one whose file is missing).
 */
export async function dataTiles(ctx: DevbiContextValue): Promise<TileSpec[]> {
  const tiles = tilesInOrder(ctx.dashboard.tiles);
  const has = await Promise.all(
    tiles.map(async (t) => {
      if (readsRows(t)) return true;
      try {
        const q = await queryOf(ctx, t);
        return q !== null && q !== "skip";
      } catch {
        return false;
      }
    }),
  );
  return tiles.filter((_, i) => has[i]);
}

/** The name a tile's data goes by (its sheet, its CSV file, the menu): its title, else its id. */
export const tileName = (tile: TileSpec) => tile.title ?? tile.id;
