import type { TileProps } from "devbi";
import { lazy, type ComponentType } from "react";
import { BarList } from "./BarList.js";
import { DateRange } from "./DateRange.js";
import { Kpi } from "./Kpi.js";
import { Markdown } from "./Markdown.js";
import { Pivot } from "./Pivot.js";
import { SelectFilter } from "./SelectFilter.js";
import { Table } from "./Table.js";

export interface BuiltinTile {
  component: ComponentType<TileProps>;
  /** The tile reads no rows itself (it may run its own queries). */
  noQuery?: boolean;
}

// Observable Plot and d3 come with the first chart on the page, as their own chunk.
const chart = (kind: "bar" | "line" | "area") => lazy(() => import("./PlotChart.js").then((m) => ({ default: m.makeChart(kind) })));

/**
 * Built-in tile types for `"type"` in dash.json. The chart tiles (`bar`, `line`, `area`) are `React.lazy`
 * components: render them inside `<Suspense>` (TileFrame does).
 */
export const builtinTiles: Record<string, BuiltinTile> = {
  kpi: { component: Kpi },
  bar: { component: chart("bar") },
  line: { component: chart("line") },
  area: { component: chart("area") },
  barlist: { component: BarList },
  table: { component: Table },
  pivot: { component: Pivot },
  "date-range": { component: DateRange, noQuery: true },
  select: { component: SelectFilter },
  markdown: { component: Markdown, noQuery: true },
};

export { BarList, DateRange, Kpi, Markdown, Pivot, SelectFilter, Table };
export { useTileSize } from "./util.js";
