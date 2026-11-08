import { TILE_TYPES, type BuiltinTileType, type MetricsView, type Query } from "devbi";

/** A tile as it is in dash.json (keys in the file's order). */
export interface RawTile {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  [key: string]: unknown;
}

/** A dash.json as it is in the file: no defaults filled in, so saving changes only what the editor changed. */
export interface RawDashboard {
  tiles: RawTile[];
  title?: string;
  metrics?: string;
  columns?: number;
  rowHeight?: number;
  [key: string]: unknown;
}

export interface Box {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The grid's boxes, one per tile. */
export function boxesOf(spec: RawDashboard): Box[] {
  return spec.tiles.map((t) => ({ i: t.id, x: t.x, y: t.y, w: t.w, h: t.h }));
}

/**
 * The dashboard with the tiles at these places, or the same object when nothing moved. Each tile keeps its other
 * keys and their order, so the saved file changes only in the `"x": …, "y": …` lines.
 */
export function placeTiles(spec: RawDashboard, boxes: readonly Box[]): RawDashboard {
  const at = new Map(boxes.map((b) => [b.i, b]));
  let moved = false;
  const tiles = spec.tiles.map((t) => {
    const b = at.get(t.id);
    if (!b || (b.x === t.x && b.y === t.y && b.w === t.w && b.h === t.h)) return t;
    moved = true;
    return { ...t, x: b.x, y: b.y, w: b.w, h: b.h };
  });
  return moved ? { ...spec, tiles } : spec;
}

/** The first row below every tile. */
export function bottomOf(spec: RawDashboard): number {
  return spec.tiles.reduce((m, t) => Math.max(m, t.y + t.h), 0);
}

/** `base`, or `base-2`, `base-3`… whichever no tile has. */
export function freeId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

const label = (defs: Record<string, { label: string }>, name: string | undefined) => (name ? (defs[name]?.label ?? name) : "");

/**
 * A new tile of a built-in type, at the bottom, showing something from the start: the first measure, by month
 * when there is a time column, or by the first dimension. The property panel changes it from there.
 */
export function newTile(type: BuiltinTileType, spec: RawDashboard, view: MetricsView | undefined, needsMetrics: boolean): RawTile {
  const info = TILE_TYPES[type];
  const columns = spec.columns ?? 12;
  const id = freeId(type, spec.tiles.map((t) => t.id));
  const tile: RawTile = { id, x: 0, y: bottomOf(spec), w: Math.min(info.size.w, columns), h: info.size.h, type };
  const measure = view ? Object.keys(view.measures)[0] : undefined;
  const dimension = view ? Object.keys(view.dimensions)[0] : undefined;
  const m = view ? label(view.measures, measure) : "";
  const d = view ? label(view.dimensions, dimension) : "";
  const time = view?.time;
  let query: Query | undefined;
  let title: string | undefined;
  switch (type) {
    case "kpi":
      query = { measures: measure ? [measure] : [] };
      title = m || undefined;
      break;
    case "bar":
    case "line":
    case "area":
      if (time) {
        query = { measures: measure ? [measure] : [], time: "month" };
        title = m ? `月別${m}` : undefined;
      } else {
        query = { measures: measure ? [measure] : [], dimensions: dimension ? [dimension] : [] };
        title = m && d ? `${d}別${m}` : undefined;
      }
      break;
    case "barlist":
      query = { measures: measure ? [measure] : [], dimensions: dimension ? [dimension] : [] };
      title = m && d ? `${d}別${m}` : undefined;
      break;
    case "table":
      query = { measures: measure ? [measure] : [], dimensions: view ? Object.keys(view.dimensions).slice(0, 2) : [], limit: 100 };
      title = d ? `${d}別` : undefined;
      break;
    case "pivot":
      query = { measures: measure ? [measure] : [], dimensions: dimension ? [dimension] : [], ...(time ? { time: "quarter" as const } : {}) };
      title = d ? (time ? `${d} × 四半期` : d) : undefined;
      break;
    case "select":
      query = { dimensions: dimension ? [dimension] : [], measures: measure ? [measure] : [] };
      title = d || undefined;
      break;
    case "date-range":
      tile.options = { default: "latest_fiscal_year" };
      break;
    case "markdown":
      tile.options = { text: "ここに説明を書きます。**太字**、`コード`、[リンク](https://example.com) が使えます。" };
      break;
  }
  if (title) tile.title = title;
  if (query) tile.query = needsMetrics && view ? { metrics: view.name, ...query } : query;
  return tile;
}
