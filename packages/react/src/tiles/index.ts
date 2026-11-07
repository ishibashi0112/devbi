import type { TileProps } from "devbi";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { loadChunk } from "../chunk.js";
import { BarList } from "./BarList.js";
import { DateRange } from "./DateRange.js";
import { Kpi } from "./Kpi.js";
import { Markdown } from "./Markdown.js";
import { Pivot } from "./Pivot.js";
import { SelectFilter } from "./SelectFilter.js";

export interface BuiltinTile {
  /** Render it as an element (`<C {...props} />`); the chart tiles are lazy and need a `<Suspense>` above them. */
  component: ComponentType<TileProps> | LazyExoticComponent<ComponentType<TileProps>>;
  /** The tile reads no rows itself (it may run its own queries). */
  noQuery?: boolean;
}

// Observable Plot and d3 come with the first chart on the page, and spreadsheet-grid with the first table,
// each as its own chunk.
const chart = (kind: "bar" | "line" | "area") =>
  lazy(() => loadChunk(() => import("./PlotChart.js")).then((m) => ({ default: m.makeChart(kind) })));
const table = lazy(() => loadChunk(() => import("./GridTable.js")).then((m) => ({ default: m.GridTable })));

/**
 * Built-in tile types for `"type"` in dash.json. The chart tiles (`bar`, `line`, `area`) and `table` are `React.lazy`
 * components: render them inside `<Suspense>` (TileFrame does).
 */
export const builtinTiles: Record<string, BuiltinTile> = {
  kpi: { component: Kpi },
  bar: { component: chart("bar") },
  line: { component: chart("line") },
  area: { component: chart("area") },
  barlist: { component: BarList },
  table: { component: table },
  pivot: { component: Pivot },
  "date-range": { component: DateRange, noQuery: true },
  select: { component: SelectFilter },
  markdown: { component: Markdown, noQuery: true },
};

export { BarList, DateRange, Kpi, Markdown, Pivot, SelectFilter };
export { useTileSize } from "./util.js";
