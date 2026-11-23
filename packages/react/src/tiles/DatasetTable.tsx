import {
  createSpreadsheetGrid,
  columnAutosizeFeature,
  columnMenuFeature,
  conditionalFormatFeature,
  exportFeature,
  filteringFeature,
  findFeature,
  groupingFeature,
  toolPanelFeature,
  totalRowFeature,
  type GridColumn,
  type SpreadsheetGridHandle,
} from "@ishibashi0112/spreadsheet-grid/lite";
import "@ishibashi0112/spreadsheet-grid/style.css";
import {
  choiceValue,
  tableColumnProblems,
  tableColumns,
  tableOptions,
  type DashboardParam,
  type FieldInfo,
  type ParamValue,
  type Row,
  type TableColumnView,
  type TileProps,
} from "devbi";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useDevbi, useParamsVersion, type TableExport } from "../context.js";
import { popups, useTheme } from "./grid-theme.js";
import { dateKey, fromDateKey } from "./util.js";

// A report's table (a dataset: api/<name>.sql): more of spreadsheet-grid than the metrics files' table (filters,
// groups, totals, data bars, search, the column list), so its own grid in its own chunk, loaded only with a dataset
// table on the page. The metrics files' table (GridTable) stays as small as it was.
const Grid = createSpreadsheetGrid({
  features: {
    columnMenu: columnMenuFeature,
    columnAutosize: columnAutosizeFeature,
    filtering: filteringFeature,
    grouping: groupingFeature,
    totalRow: totalRowFeature,
    conditionalFormat: conditionalFormatFeature,
    find: findFeature,
    export: exportFeature,
    toolPanel: toolPanelFeature,
  },
});

type ValueKind = "number" | "date" | "boolean" | "text";

/** What a column holds: from its kind, or its first value (a `-- key:` number is a dimension). */
function valueKind(field: FieldInfo, rows: readonly Row[]): ValueKind {
  if (field.kind === "time") return "date";
  if (field.kind === "measure") return "number";
  for (const r of rows) {
    const v = r[field.name];
    if (v === null || v === undefined) continue;
    return typeof v === "number" ? "number" : v instanceof Date ? "date" : typeof v === "boolean" ? "boolean" : "text";
  }
  return "text";
}

const FILTERS = { number: "numberSet", date: "dateSet", boolean: "textSet", text: "textSet" } as const;

/** A column as the grid shows it: the value it sorts, filters and finds by; the text from the dashboard's formats. */
function gridColumn(v: TableColumnView, kind: ValueKind, format: TileProps["format"]): GridColumn<Row> {
  const { field: f, column: c } = v;
  const numeric = kind === "number";
  const style = c.style;
  return {
    key: f.name,
    title: f.label,
    width: c.width ?? (numeric ? 110 : 140),
    // A width written in the options is kept (fitting the widths to the data leaves it).
    ...(c.width !== undefined ? { suppressAutoSize: true } : {}),
    align: c.align ?? (numeric ? "right" : "left"),
    ...(c.pin ? { pinned: c.pin } : {}),
    ...(c.hidden ? { visible: false } : {}),
    // Every column can group from its menu ("この列でグループ化"); groupBy's group at first.
    rowGroup: v.group,
    groupLabel: "formatted",
    ...(c.filter !== false ? { filterType: FILTERS[kind] } : {}),
    ...(v.agg ? { aggFunc: v.agg } : {}),
    // A number that is a key (an order number) is not added up when cells are selected.
    ...(numeric && f.kind !== "measure" ? { selectionAggregate: false } : {}),
    ...(style
      ? { conditionalFormat: style === "bar" ? { dataBar: {} } : style === "scale" ? { colorScale: {} } : { chips: style.chips } }
      : {}),
    getValue: (r: Row) => {
      const x = r[f.name];
      if (x instanceof Date) return dateKey(x);
      if (typeof x === "boolean") return x ? "はい" : "いいえ";
      return x;
    },
    // A group's row and the totals row pass no row, only their value (a sum): format that.
    valueFormatter: ({ row, value }) => format(row ? row[f.name] : value, f.name),
    // Copy what is shown (¥1,200 / 2026/4/1): Excel reads these as numbers and dates.
    formatClipboardValue: (_value: unknown, row: Row) => format(row[f.name], f.name),
  };
}

/** A clicked row's value for a parameter (as its type; a list of one for a list). Undefined: none to put. */
function paramValueOf(p: DashboardParam, raw: unknown): ParamValue | undefined {
  const v = choiceValue(raw, p);
  if (v === undefined) return p.optional && !p.multiple ? null : undefined;
  return p.multiple ? [v] : v;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The `table` tile of a dataset (a report): the SQL's rows in a read-only spreadsheet-grid, with the columns, groups,
 * totals and styles of its `options`. The viewer sorts, filters (each column's menu, and the search box), groups and
 * shows hidden columns, all in the browser. `options.click` puts a clicked row's values in the dashboard's
 * parameters (a second click puts them back to their default).
 */
export function DatasetTable({ rows, fields, format, tile, query }: TileProps) {
  const ctx = useDevbi();
  useParamsVersion();
  const ref = useRef<HTMLDivElement>(null);
  const grid = useRef<SpreadsheetGridHandle<Row>>(null);
  const theme = useTheme(ref);
  const { options, problems } = useMemo(() => tableOptions(tile.options), [tile.options]);
  const missing = useMemo(() => (fields.length ? tableColumnProblems(options, fields.map((f) => f.name)) : []), [options, fields]);
  const views = useMemo(() => tableColumns(fields, options), [fields, options]);
  // The columns change with the result's columns and the options, not with each new set of rows: the viewer's
  // changes (pins, groups, shown columns) stay while the parameters change.
  const kinds = views.map((v) => valueKind(v.field, rows));
  const signature = JSON.stringify([views, kinds]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const base = useMemo(() => views.map((v, i) => gridColumn(v, kinds[i]!, format)), [signature]);
  const [columns, setColumns] = useState(base);
  const [shown, setShown] = useState(base);
  if (shown !== base) {
    setShown(base);
    setColumns(base);
  }

  const info = query.dataset !== undefined && Object.hasOwn(ctx.project.datasets, query.dataset) ? ctx.project.datasets[query.dataset] : undefined;
  const key = info?.key?.length && info.key.every((k) => fields.some((f) => f.name === k)) ? info.key : undefined;

  // A click on a row: its columns' values into the dashboard's parameters.
  const click = useMemo(
    () => Object.entries(options.click?.params ?? {}).map(([param, column]) => ({ param, column, p: ctx.params.find(param) })),
    [options.click, ctx.params],
  );
  const unknown = click.filter((c) => !c.p).map((c) => c.param);
  const selected = (r: Row): boolean =>
    click.length > 0 && click.every(({ p, column }) => p !== undefined && same(ctx.params.value(p.name), paramValueOf(p, r[column])));
  const toggle = (r: Row) => {
    if (!click.length || unknown.length) return;
    if (selected(r)) {
      ctx.params.reset(click.map((c) => c.p!.name));
      return;
    }
    const values: Record<string, ParamValue> = {};
    for (const { p, column } of click) {
      const v = paramValueOf(p!, r[column]);
      if (v !== undefined) values[p!.name] = v;
    }
    ctx.params.setValues(values);
  };
  const activeRow = useRef<Row | null>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Enter / Space on the active cell clicks its row; not in the search box or the find bar.
    if (!click.length || (e.key !== "Enter" && e.key !== " ") || e.nativeEvent.isComposing || !activeRow.current) return;
    if ((e.target as HTMLElement).closest("input, textarea, select, button, [contenteditable]")) return;
    e.preventDefault();
    toggle(activeRow.current);
  };

  // What the Excel button writes: the table as the viewer has it (filtered, sorted, the columns shown; every row of a
  // collapsed group too, the grouping columns first).
  const byName = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);
  useEffect(() => {
    const dates = new Set(views.flatMap((v, i) => (kinds[i] === "date" ? [v.field.name] : [])));
    const read = (): TableExport | undefined => {
      // Not drawn (an error in its place): the sheet writes the rows as they came.
      if (!grid.current) return undefined;
      const data = grid.current.getExportData({ scope: "view", includeTotalRow: options.totals });
      const state = grid.current.getState();
      const shownFields = data.columns.flatMap((c) => {
        const f = byName.get(c.key);
        return f ? [{ ...f, label: c.title || f.label }] : [];
      });
      const typed = (cells: { value: unknown }[]): Row => {
        const row: Row = {};
        data.columns.forEach((c, i) => {
          const v = cells[i]?.value;
          // Dates come back as the grid's text (dateKey): the sheet writes them as dates. はい / いいえ stay as shown.
          row[c.key] = typeof v === "string" && dates.has(c.key) ? (fromDateKey(v) ?? v) : ((v ?? null) as Row[string]);
        });
        return row;
      };
      const out: Row[] = [];
      let total: Row | undefined;
      data.rows.forEach((cells, i) => {
        if (data.rowKinds?.[i] === "total") total = typed(cells);
        else out.push(typed(cells));
      });
      return {
        fields: shownFields,
        rows: out,
        ...(total ? { total } : {}),
        filtered: (state.filters.globalText.trim() !== "" || Object.keys(state.filters.columnFilters).length > 0),
      };
    };
    ctx.tables.set(tile.id, read);
    return () => {
      if (ctx.tables.get(tile.id) === read) ctx.tables.delete(tile.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, tile.id, byName, options.totals, signature]);

  const problem =
    problems[0] ??
    missing[0] ??
    (unknown.length
      ? `options.click の ${unknown.join("、")} はこのダッシュボードのパラメーターにありません（dash.json の params に type を書くか、そのパラメーターを使うデータセットの表を置いてください）`
      : undefined);
  if (problem) return <div className="devbi-error">{problem}</div>;

  return (
    <div ref={ref} className={`devbi-grid-wrap${click.length ? " devbi-grid-clickable" : ""}`} onKeyDown={onKeyDown}>
      <Grid<Row>
        ref={grid}
        className="devbi-table-grid devbi-dataset-grid"
        classNames={popups}
        rows={rows}
        rowKeyGetter={key ? (r) => JSON.stringify(key.map((k) => (r[k] instanceof Date ? (r[k] as Date).getTime() : r[k]))) : undefined}
        columns={columns}
        onColumnsChange={setColumns}
        readOnly
        showTopBar={options.search}
        // The search box alone; the filters in use show as chips under it (each with a ×).
        showTopBarSummary={false}
        globalFilterPlaceholder="表の中を検索"
        globalFilterMatch="both"
        showFilterChipBar
        find
        showBottomBar={false}
        totalRow={options.totals}
        theme={theme}
        density="compact"
        height="100%"
        autoSizeColumns="onMount"
        noRowsText="行がありません"
        ariaLabel={tile.title ?? tile.id}
        getRowClassName={(r) => (selected(r) ? "devbi-selected" : undefined)}
        onActiveCellChange={(cell) => {
          activeRow.current = cell?.row ?? null;
        }}
        onCellClick={({ row: r, event }) => {
          // Shift / Ctrl / ⌘ + click extend or add to the selected cells for copying; they put no values.
          if (event.shiftKey || event.ctrlKey || event.metaKey) return;
          toggle(r);
        }}
      />
    </div>
  );
}
