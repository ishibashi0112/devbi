import type { FieldInfo, Query, Row, Scalar, TileProps } from "devbi";
import { useMemo } from "react";
import { useDevbiQuery } from "../context.js";
import { compareValues, filterFor, isSelected, measures } from "./util.js";

function keyOf(row: Row, fields: FieldInfo[]): string {
  return JSON.stringify(fields.map((f) => (row[f.name] instanceof Date ? (row[f.name] as Date).getTime() : (row[f.name] ?? null))));
}

/**
 * A cross table: one field across the columns (`options.columns`, default the last dimension or the time grain),
 * the other dimensions down the rows, the first measure in the cells, with totals (`options.totals: false` to hide).
 */
export function Pivot({ rows, fields, format, tile, query, selection, select }: TileProps) {
  const columns = typeof tile.options?.columns === "string" ? tile.options.columns : undefined;
  // Derived from `fields` once, so the model below is rebuilt only when the data changes.
  const { m, colField, rowFields } = useMemo(() => {
    const keys = fields.filter((f) => f.kind !== "measure");
    const colName = columns ?? keys[keys.length - 1]?.name;
    const colField = keys.find((f) => f.name === colName);
    return { m: measures(fields)[0], colField, rowFields: keys.filter((f) => f !== colField) };
  }, [fields, columns]);
  const totals = tile.options?.totals !== false && !!colField && !!m;

  const sub = (keep: FieldInfo[]): Query => ({
    ...(query.metrics ? { metrics: query.metrics } : {}),
    measures: m ? [m.name] : [],
    dimensions: keep.filter((f) => f.kind === "dimension").map((f) => f.name),
    ...(keep.some((f) => f.kind === "time") && query.time ? { time: query.time } : {}),
    ...(query.filters ? { filters: query.filters } : {}),
  });
  const rowTot = useDevbiQuery(totals && rowFields.length ? sub(rowFields) : null, { tileId: tile.id });
  const colTot = useDevbiQuery(totals ? sub([colField!]) : null, { tileId: tile.id });
  const grand = useDevbiQuery(totals && rowFields.length ? sub([]) : null, { tileId: tile.id });

  const model = useMemo(() => {
    if (!colField || !m) return null;
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
    const order = new Map(rowTot.rows.map((r, i) => [keyOf(r, rowFields), i]));
    const rowList = [...rowKeys.entries()].sort((a, b) => (order.get(a[0]) ?? 1e9) - (order.get(b[0]) ?? 1e9));
    const rowTotal = new Map(rowTot.rows.map((r) => [keyOf(r, rowFields), r[m.name] ?? null]));
    const colTotal = new Map(colTot.rows.map((r) => [keyOf(r, [colField]), r[m.name] ?? null]));
    return { colList, rowList, cells, rowTotal, colTotal };
  }, [rows, colField, rowFields, m, rowTot.rows, colTot.rows]);

  if (!model || !colField || !m) return <div className="devbi-empty">measures と、列にする軸を指定してください</div>;
  const rowSel = (r: Row) => rowFields.map((f) => filterFor(f, r[f.name] ?? null));
  const isRowSel = (r: Row) =>
    selection.length > 0 && rowFields.every((f) => isSelected(selection, f.name, r[f.name] ?? null)) && !selection.some((f) => f.field === colField.name);
  return (
    <div className="devbi-table-wrap">
      <table className="devbi-table devbi-pivot">
        <thead>
          <tr>
            {rowFields.map((f) => (
              <th key={f.name}>{f.label}</th>
            ))}
            {model.colList.map(([ck, v]) => (
              <th key={ck} className="devbi-num">
                <button type="button" onClick={() => select(isSelected(selection, colField.name, v) ? null : filterFor(colField, v))}>
                  {format(v, colField.name)}
                </button>
              </th>
            ))}
            {totals && rowFields.length > 0 && <th className="devbi-num">合計</th>}
          </tr>
        </thead>
        <tbody>
          {model.rowList.map(([rk, r]) => (
            <tr key={rk} className={isRowSel(r) ? "devbi-selected" : ""}>
              {rowFields.map((f) => (
                <th key={f.name} scope="row">
                  <button type="button" onClick={() => select(isRowSel(r) ? null : rowSel(r))}>
                    {format(r[f.name], f.name)}
                  </button>
                </th>
              ))}
              {model.colList.map(([ck, v]) => (
                <td
                  key={ck}
                  className="devbi-num"
                  onClick={() => select([...rowSel(r), filterFor(colField, v)])}
                >
                  {model.cells.has(`${rk}|${ck}`) ? format(model.cells.get(`${rk}|${ck}`), m.name) : ""}
                </td>
              ))}
              {totals && rowFields.length > 0 && <td className="devbi-num devbi-total">{format(model.rowTotal.get(rk), m.name)}</td>}
            </tr>
          ))}
        </tbody>
        {totals && (
          <tfoot>
            <tr>
              {rowFields.length > 0 && <th colSpan={rowFields.length}>合計</th>}
              {model.colList.map(([ck]) => (
                <td key={ck} className="devbi-num devbi-total">
                  {format(model.colTotal.get(ck), m.name)}
                </td>
              ))}
              {rowFields.length > 0 && <td className="devbi-num devbi-total">{format(grand.rows[0]?.[m.name], m.name)}</td>}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
