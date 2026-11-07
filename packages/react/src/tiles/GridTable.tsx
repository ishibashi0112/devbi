import { createSpreadsheetGrid, columnAutosizeFeature, columnMenuFeature, type GridColumn } from "@ishibashi0112/spreadsheet-grid/lite";
import "@ishibashi0112/spreadsheet-grid/style.css";
import type { Row, TileProps } from "devbi";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { dimensions, filterFor, isSelected } from "./util.js";

// Built once, at module level: only the features the table tile uses (sorting from the column menu,
// fitting column widths). This file loads with the first table on the page, as its own chunk.
const Grid = createSpreadsheetGrid({ features: { columnMenu: columnMenuFeature, columnAutosize: columnAutosizeFeature } });

function sameRow(selection: TileProps["selection"], row: Row): boolean | undefined {
  if (!selection.length) return undefined;
  return selection.every((f) => isSelected(selection, f.field, row[f.field] ?? null));
}

/** The grid follows the dashboard's light / dark: an explicit `data-theme` on `.devbi-root`, else the OS. */
function useTheme(ref: React.RefObject<HTMLElement | null>): "light" | "dark" | "auto" {
  const [theme, setTheme] = useState<"light" | "dark" | "auto">("auto");
  useLayoutEffect(() => {
    const t = ref.current?.closest(".devbi-root")?.getAttribute("data-theme");
    setTheme(t === "light" || t === "dark" ? t : "auto");
  }, [ref]);
  return theme;
}

/**
 * The `table` tile: every result field in a read-only spreadsheet-grid. Sort and fit widths from the column
 * menu (⋮), select cells and copy them (Ctrl/⌘+C) to paste into Excel. Clicking a row selects its dimension
 * and time values, which filters the other tiles.
 */
export function GridTable({ rows, fields, format, selection, select, tile }: TileProps) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme(ref);
  const dims = dimensions(fields);
  const time = fields.find((f) => f.kind === "time");
  const columns = useMemo(
    (): GridColumn<Row>[] =>
      fields.map((f) => ({
        key: f.name,
        title: f.label,
        width: f.kind === "measure" ? 110 : 140,
        align: f.kind === "measure" ? "right" : "left",
        // Sort dates by time; show every value with the field's format.
        getValue: (r: Row) => {
          const v = r[f.name];
          return v instanceof Date ? v.getTime() : v;
        },
        valueFormatter: ({ row }) => format(row[f.name], f.name),
        // Copy what is shown (¥1,200 / 94.0% / 2026年5月): Excel reads these as numbers and dates.
        formatClipboardValue: (_value: unknown, row: Row) => format(row[f.name], f.name),
      })),
    [fields, format],
  );
  return (
    <div ref={ref} className="devbi-grid-wrap">
      <Grid<Row>
        className="devbi-grid"
        rows={rows}
        columns={columns}
        readOnly
        showTopBar={false}
        showBottomBar={false}
        theme={theme}
        density="compact"
        height="100%"
        autoSizeColumns="onDataChange"
        ariaLabel={tile.title ?? tile.id}
        getRowClassName={(r) => {
          const sel = sameRow(selection, r);
          return sel === undefined ? undefined : sel ? "devbi-selected" : "devbi-dimmed";
        }}
        onCellClick={({ row: r }) => {
          if (!dims.length && !time) return;
          if (sameRow(selection, r)) return select(null);
          select([
            ...dims.map((d) => filterFor(d, r[d.name] ?? null)),
            ...(time && r[time.name] instanceof Date ? [filterFor(time, r[time.name] ?? null)] : []),
          ]);
        }}
      />
    </div>
  );
}
