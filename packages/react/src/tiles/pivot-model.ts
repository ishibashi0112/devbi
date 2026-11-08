import type { FieldInfo, Query, Row, Scalar } from "devbi";
import { compareValues, measures } from "./util.js";

/** A row's identity by some fields (a time bucket by its start). */
export function keyOf(row: Row, fields: FieldInfo[]): string {
  return JSON.stringify(fields.map((f) => (row[f.name] instanceof Date ? (row[f.name] as Date).getTime() : (row[f.name] ?? null))));
}

/** The pivot's fields: `columns` (default the last dimension or the time grain) across, the others down, the first measure in the cells. */
export function pivotFields(fields: FieldInfo[], columns: string | undefined) {
  const keys = fields.filter((f) => f.kind !== "measure");
  const colName = columns ?? keys[keys.length - 1]?.name;
  const colField = keys.find((f) => f.name === colName);
  return { m: measures(fields)[0], colField, rowFields: keys.filter((f) => f !== colField) };
}

/** The query of a total: the measure by only the `keep` fields, with the tile's own filters. */
export function totalQuery(query: Query, m: FieldInfo | undefined, keep: FieldInfo[]): Query {
  return {
    ...(query.metrics ? { metrics: query.metrics } : {}),
    measures: m ? [m.name] : [],
    dimensions: keep.filter((f) => f.kind === "dimension").map((f) => f.name),
    ...(keep.some((f) => f.kind === "time") && query.time ? { time: query.time } : {}),
    ...(query.filters ? { filters: query.filters } : {}),
  };
}

export interface PivotModel {
  /** The column values, in order, by key. */
  colList: [string, Scalar][];
  /** A row of the result for each pivot row (its row fields' values), in order, by key. */
  rowList: [string, Row][];
  /** Cell values by `<row key>|<column key>`. */
  cells: Map<string, Scalar>;
  rowTotal: Map<string, Scalar>;
  colTotal: Map<string, Scalar>;
}

/**
 * The cross table of a result: columns sorted by value, rows in the order of their totals' query (`rowTotRows`), and
 * the totals by row and by column (from their own queries, as a ratio or a distinct count do not add up).
 */
export function pivotModel(rows: Row[], colField: FieldInfo, rowFields: FieldInfo[], m: FieldInfo, rowTotRows: Row[], colTotRows: Row[]): PivotModel {
  const cols = new Map<string, Scalar>();
  const rowKeys = new Map<string, Row>();
  const cells = new Map<string, Scalar>();
  for (const r of rows) {
    const ck = keyOf(r, [colField]);
    cols.set(ck, r[colField.name] ?? null);
    const rk = keyOf(r, rowFields);
    if (!rowKeys.has(rk)) rowKeys.set(rk, r);
    cells.set(`${rk}|${ck}`, r[m.name] ?? null);
  }
  const colList = [...cols.entries()].sort((a, b) => compareValues(a[1], b[1]));
  const order = new Map(rowTotRows.map((r, i) => [keyOf(r, rowFields), i]));
  const rowList = [...rowKeys.entries()].sort((a, b) => (order.get(a[0]) ?? 1e9) - (order.get(b[0]) ?? 1e9));
  const rowTotal = new Map(rowTotRows.map((r) => [keyOf(r, rowFields), r[m.name] ?? null]));
  const colTotal = new Map(colTotRows.map((r) => [keyOf(r, [colField]), r[m.name] ?? null]));
  return { colList, rowList, cells, rowTotal, colTotal };
}
