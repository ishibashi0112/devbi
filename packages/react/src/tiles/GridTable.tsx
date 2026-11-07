import { createSpreadsheetGrid, columnAutosizeFeature, columnMenuFeature, type GridColumn } from "@ishibashi0112/spreadsheet-grid/lite";
import "@ishibashi0112/spreadsheet-grid/style.css";
import type { Row, TileProps } from "devbi";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { dimensions, filterFor, isSelected } from "./util.js";

// Built once, at module level: only the features the table tile uses (sorting from the column menu,
// fitting column widths). This file loads with the first table on the page, as its own chunk.
const Grid = createSpreadsheetGrid({ features: { columnMenu: columnMenuFeature, columnAutosize: columnAutosizeFeature } });

function sameRow(selection: TileProps["selection"], row: Row): boolean | undefined {
  if (!selection.length) return undefined;
  return selection.every((f) => isSelected(selection, f.field, row[f.field] ?? null));
}

/**
 * The grid follows the dashboard's light / dark, like DevBI's CSS: light when `.devbi-root` has
 * `data-theme="light"`, otherwise the OS setting. Watches the attribute, so switching it later works too.
 */
function useTheme(ref: React.RefObject<HTMLElement | null>): "light" | "auto" {
  const [theme, setTheme] = useState<"light" | "auto">("auto");
  useLayoutEffect(() => {
    const root = ref.current?.closest(".devbi-root");
    if (!root) return;
    const read = () => setTheme(root.getAttribute("data-theme") === "light" ? "light" : "auto");
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [ref]);
  return theme;
}

/** A row's identity: its dimension and time values (each row of a grouped result has its own). */
function keyOf(row: Row, keys: string[]): string {
  return JSON.stringify(keys.map((k) => (row[k] instanceof Date ? (row[k] as Date).getTime() : row[k])));
}

/**
 * The `table` tile: every result field in a read-only spreadsheet-grid. Sort and fit widths from the column
 * menu (⋮), select cells and copy them (Ctrl/⌘+C) to paste into Excel. Clicking a row, or Enter / Space on
 * a cell, selects its dimension and time values, which filters the other tiles.
 */
export function GridTable({ rows, fields, format, selection, select, tile }: TileProps) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme(ref);
  const dims = dimensions(fields);
  const time = fields.find((f) => f.kind === "time");
  const keys = useMemo(() => fields.filter((f) => f.kind !== "measure").map((f) => f.name), [fields]);
  const activeRow = useRef<Row | null>(null);
  // Select a row's dimension and time values (filters the other tiles); the same row again clears it.
  const toggle = useCallback(
    (r: Row) => {
      if (!dims.length && !time) return;
      if (sameRow(selection, r)) return select(null);
      select([
        ...dims.map((d) => filterFor(d, r[d.name] ?? null)),
        ...(time && r[time.name] instanceof Date ? [filterFor(time, r[time.name] ?? null)] : []),
      ]);
    },
    [dims, time, selection, select],
  );
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Enter / Space on the active cell select its row, as a click does (the grid is read-only, so they are free).
    if ((e.key === "Enter" || e.key === " ") && activeRow.current && !e.nativeEvent.isComposing) {
      e.preventDefault();
      toggle(activeRow.current);
    }
  };
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
    <div ref={ref} className="devbi-grid-wrap" onKeyDown={onKeyDown}>
      <Grid<Row>
        className="devbi-table-grid"
        rows={rows}
        rowKeyGetter={keys.length ? (r) => keyOf(r, keys) : undefined}
        columns={columns}
        readOnly
        showTopBar={false}
        showBottomBar={false}
        theme={theme}
        density="compact"
        height="100%"
        // Fit the widths to the first data; later filters keep them (and keep widths the user changed).
        autoSizeColumns="onMount"
        ariaLabel={tile.title ?? tile.id}
        getRowClassName={(r) => {
          const sel = sameRow(selection, r);
          return sel === undefined ? undefined : sel ? "devbi-selected" : "devbi-dimmed";
        }}
        onActiveCellChange={(cell) => {
          activeRow.current = cell?.row ?? null;
        }}
        onCellClick={({ row: r, event }) => {
          // Shift / Ctrl / ⌘ + click extend or add to the selected range for copying; they do not filter.
          if (event.shiftKey || event.ctrlKey || event.metaKey) return;
          toggle(r);
        }}
      />
    </div>
  );
}
