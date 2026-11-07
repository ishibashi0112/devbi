import type { TileProps } from "devbi";
import type { ComponentType } from "react";
import { BarList } from "./BarList.js";
import { DateRange } from "./DateRange.js";
import { Kpi } from "./Kpi.js";
import { Markdown } from "./Markdown.js";
import { Pivot } from "./Pivot.js";
import { makeChart } from "./PlotChart.js";
import { SelectFilter } from "./SelectFilter.js";
import { Table } from "./Table.js";

export interface BuiltinTile {
  component: ComponentType<TileProps>;
  /** The tile reads no rows itself (it may run its own queries). */
  noQuery?: boolean;
}

/** Built-in tile types for `"type"` in dash.json. */
export const builtinTiles: Record<string, BuiltinTile> = {
  kpi: { component: Kpi },
  bar: { component: makeChart("bar") },
  line: { component: makeChart("line") },
  area: { component: makeChart("area") },
  barlist: { component: BarList },
  table: { component: Table },
  pivot: { component: Pivot },
  "date-range": { component: DateRange, noQuery: true },
  select: { component: SelectFilter },
  markdown: { component: Markdown, noQuery: true },
};

export { BarList, DateRange, Kpi, Markdown, Pivot, SelectFilter, Table, makeChart };
export { useTileSize } from "./util.js";
