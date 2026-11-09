import { TILE_TYPES, type BuiltinTileType, type Filter, type MetricsView, type Scalar, type SortSpec } from "devbi";
import { newTile, type RawDashboard, type RawTile } from "./layout.js";

/** Where each key goes in a hand-written file, so a key the panel adds lands where a person would put it. */
export const DASHBOARD_KEYS = ["$schema", "title", "description", "metrics", "columns", "rowHeight", "tiles"] as const;
export const TILE_KEYS = ["id", "x", "y", "w", "h", "type", "component", "title", "query", "options"] as const;
export const QUERY_KEYS = ["metrics", "measures", "dimensions", "time", "filters", "sort", "limit", "period"] as const;

type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** undefined, "", [] and {}: the key is left out of the file. */
const isEmpty = (v: unknown) => v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);

const equal = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * `obj` with `key` set to `value`, where a hand-written file has it: a key already there keeps its place, a new one
 * goes before the first key that comes after it in `order` (else at the end). An empty value removes the key.
 * Returns the same object when nothing changes, so an edit that changes nothing is not an undo step.
 */
export function withKey<T extends Obj>(obj: T, key: string, value: unknown, order: readonly string[]): T {
  if (isEmpty(value)) {
    if (!Object.hasOwn(obj, key)) return obj;
    const rest: Obj = { ...obj };
    delete rest[key];
    return rest as T;
  }
  if (Object.hasOwn(obj, key)) return equal(obj[key], value) ? obj : ({ ...obj, [key]: value } as T);
  const rank = order.indexOf(key);
  const entries = Object.entries(obj);
  const at = rank < 0 ? -1 : entries.findIndex(([k]) => order.indexOf(k) > rank);
  if (at < 0) entries.push([key, value]);
  else entries.splice(at, 0, [key, value]);
  return Object.fromEntries(entries) as T;
}

/** The dashboard with one tile changed (the same object when `update` changes nothing). */
export function updateTile(spec: RawDashboard, id: string, update: (tile: RawTile) => RawTile): RawDashboard {
  let changed = false;
  const tiles = spec.tiles.map((t) => {
    if (t.id !== id) return t;
    const next = update(t);
    if (next !== t) changed = true;
    return next;
  });
  return changed ? { ...spec, tiles } : spec;
}

export const setDashboardKey = (spec: RawDashboard, key: string, value: unknown) => withKey(spec, key, value, DASHBOARD_KEYS);
export const setTileKey = (tile: RawTile, key: string, value: unknown) => withKey(tile, key, value, TILE_KEYS);

/**
 * Set one key of the tile's `query`. A query left empty stays as `{}`, so the tile says what it is missing (with no
 * query at all, a built-in tile would show nothing and say nothing).
 */
export function setQueryKey(tile: RawTile, key: string, value: unknown): RawTile {
  const query = isObj(tile.query) ? tile.query : {};
  const next = withKey(query, key, value, QUERY_KEYS);
  if (next === query) return tile;
  return Object.hasOwn(tile, "query") ? { ...tile, query: next } : setTileKey(tile, "query", next);
}

/** Set one key of the tile's `options` (in the order the tile type lists them); options left empty are removed. */
export function setOption(tile: RawTile, key: string, value: unknown): RawTile {
  const options = isObj(tile.options) ? tile.options : {};
  const order = typeof tile.type === "string" && Object.hasOwn(TILE_TYPES, tile.type) ? Object.keys(TILE_TYPES[tile.type as BuiltinTileType].options) : [];
  const next = withKey(options, key, value, order);
  return next === options ? tile : setTileKey(tile, "options", next);
}

/** The metrics file the dashboard's tiles use by default, and whether a new tile has to name one. */
export function viewFor(metrics: Record<string, MetricsView>, spec: RawDashboard): { view?: MetricsView; needsMetrics: boolean } {
  const names = Object.keys(metrics).sort();
  const own = typeof spec.metrics === "string" ? spec.metrics : names.length === 1 ? names[0] : undefined;
  if (own) return { view: Object.hasOwn(metrics, own) ? metrics[own] : undefined, needsMetrics: false };
  return { view: names[0] ? metrics[names[0]] : undefined, needsMetrics: true };
}

/** The name of the metrics file a tile reads: its own, else the dashboard's, else the only one. */
export function metricsNameOf(metrics: Record<string, MetricsView>, spec: RawDashboard, tile: RawTile): string | undefined {
  const own = isObj(tile.query) && typeof tile.query.metrics === "string" ? tile.query.metrics : undefined;
  const option = isObj(tile.options) && typeof tile.options.metrics === "string" ? tile.options.metrics : undefined;
  if (own ?? option) return own ?? option;
  if (typeof spec.metrics === "string") return spec.metrics;
  const names = Object.keys(metrics);
  return names.length === 1 ? names[0] : undefined;
}

/**
 * The tile as another built-in type: the query stays (a type without one drops it, a type that needs one gets the
 * one a new tile would start with), and so do the options the new type has, with its defaults for the rest. The
 * metrics file the tile reads goes with it (`query.metrics`, or the period picker's `options.metrics`). Title, place
 * and size stay.
 */
export function changeType(spec: RawDashboard, tile: RawTile, type: BuiltinTileType, metrics: Record<string, MetricsView>): RawTile {
  if (tile.type === type) return tile;
  const info = TILE_TYPES[type];
  const query = isObj(tile.query) ? tile.query : undefined;
  const old = isObj(tile.options) ? tile.options : {};
  const own = typeof query?.metrics === "string" ? query.metrics : typeof old.metrics === "string" ? old.metrics : undefined;
  const ownView = own && Object.hasOwn(metrics, own) ? metrics[own] : undefined;
  const base = viewFor(metrics, spec);
  const fresh = ownView ? newTile(type, spec, ownView, true) : newTile(type, spec, base.view, base.needsMetrics);
  let next = setTileKey(tile, "type", type);
  if (!info.query) next = setTileKey(next, "query", undefined);
  else if (!query || isEmpty(query)) {
    const { metrics: _, ...rest } = isObj(fresh.query) ? fresh.query : {};
    next = setTileKey(next, "query", own && !ownView ? { metrics: own, ...rest } : fresh.query);
  }
  const merged: Obj = { ...(isObj(fresh.options) ? fresh.options : {}), ...Object.fromEntries(Object.entries(old).filter(([k]) => Object.hasOwn(info.options, k))) };
  const metricsName = own ?? (base.needsMetrics ? base.view?.name : undefined);
  if (!info.query && Object.hasOwn(info.options, "metrics") && metricsName) merged.metrics = metricsName;
  const options = Object.fromEntries(Object.keys(info.options).flatMap((k) => (Object.hasOwn(merged, k) ? [[k, merged[k]]] : [])));
  return setTileKey(next, "options", options);
}

/**
 * The tile once written out as code: it names the file (`component`), whose query and options it no longer has.
 * Its name, place, size and title stay in dash.json.
 */
export function promoteTile(tile: RawTile, component: string): RawTile {
  let next = tile;
  for (const key of ["type", "query", "options"]) next = setTileKey(next, key, undefined);
  return setTileKey(next, "component", component);
}

/** The fields a filter or a pivot's columns can use: the time column, then the dimensions, with their labels. */
export function fieldsOf(view: MetricsView): [name: string, label: string][] {
  return [...(view.time ? [[view.time.name, view.time.label] as [string, string]] : []), ...Object.entries(view.dimensions).map(([n, d]) => [n, d.label] as [string, string])];
}

/** Why `to` cannot be the tile's new name, if it cannot. */
export function idProblem(spec: RawDashboard, from: string, to: string): string | undefined {
  if (!to.trim()) return "名前を入れてください";
  if (to !== from && spec.tiles.some((t) => t.id === to)) return `${to} は、ほかのタイルの名前です`;
  return undefined;
}

/** Checked: added at the end. Unchecked: removed. */
export function toggle(list: readonly string[], name: string): string[] {
  return list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
}

/** One place earlier (the first measure or dimension is the one a tile shows first). */
export function moveUp(list: readonly string[], name: string): string[] {
  const out = [...list];
  const i = out.indexOf(name);
  if (i > 0) [out[i - 1], out[i]] = [out[i]!, out[i - 1]!];
  return out;
}

export interface SortKey {
  field: string;
  desc: boolean;
}

export function sortKeys(sort: readonly SortSpec[] | undefined): SortKey[] {
  return (sort ?? []).map((s) => (typeof s === "string" ? { field: s.replace(/^-/, ""), desc: s.startsWith("-") } : { field: s.field, desc: !!s.desc }));
}

/** Written the short way: `"-revenue"` for descending. */
export function sortSpecs(keys: readonly SortKey[]): string[] {
  return keys.map((k) => (k.desc ? `-${k.field}` : k.field));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` date `days` later (or earlier). */
export function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A filter as the panel shows it: values to pick (`in`), a period of days on the time column (the end shown as
 * the last day included, while the file has the day after it: `between` is start ≦ value ＜ end), or anything else,
 * which the panel shows as written and can only remove.
 */
export type FilterRow =
  | { kind: "in"; field: string; values: Scalar[] }
  | { kind: "period"; field: string; from: string | null; to: string | null }
  | { kind: "other"; filter: unknown };

export function filterRow(filter: unknown, timeName: string | undefined): FilterRow {
  if (!isObj(filter) || typeof filter.field !== "string") return { kind: "other", filter };
  const field = filter.field;
  if (Array.isArray(filter.in) && field !== timeName) return { kind: "in", field, values: filter.in as Scalar[] };
  if (Array.isArray(filter.between) && field === timeName && filter.between.length === 2) {
    const [lo, hi] = filter.between as unknown[];
    const day = (v: unknown) => v === null || (typeof v === "string" && DAY.test(v));
    if (day(lo) && day(hi)) return { kind: "period", field, from: lo as string | null, to: hi === null ? null : shiftDay(hi as string, -1) };
  }
  return { kind: "other", filter };
}

/** The filter to write, or null when it would not filter anything (no values picked, no days given). */
export function rowFilter(row: Exclude<FilterRow, { kind: "other" }>): Filter | null {
  if (row.kind === "in") return row.values.length ? { field: row.field, in: row.values } : null;
  if (!row.from && !row.to) return null;
  return { field: row.field, between: [row.from || null, row.to ? shiftDay(row.to, 1) : null] };
}
