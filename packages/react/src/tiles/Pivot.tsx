import type { Row, TileProps } from "devbi";
import { useMemo } from "react";
import { useDevbiQuery } from "../context.js";
import { pivotFields, pivotModel, totalQuery } from "./pivot-model.js";
import { filterFor, isSelected } from "./util.js";

/**
 * A cross table: one field across the columns (`options.columns`, default the last dimension or the time grain),
 * the other dimensions down the rows, the first measure in the cells, with totals (`options.totals: false` to hide).
 */
export function Pivot({ rows, fields, format, tile, query, selection, select }: TileProps) {
  const columns = typeof tile.options?.columns === "string" ? tile.options.columns : undefined;
  // Derived from `fields` once, so the model below is rebuilt only when the data changes.
  const { m, colField, rowFields } = useMemo(() => pivotFields(fields, columns), [fields, columns]);
  const totals = tile.options?.totals !== false && !!colField && !!m;

  const sub = (keep: typeof fields) => totalQuery(query, m, keep);
  const rowTot = useDevbiQuery(totals && rowFields.length ? sub(rowFields) : null, { tileId: tile.id });
  const colTot = useDevbiQuery(totals ? sub([colField!]) : null, { tileId: tile.id });
  const grand = useDevbiQuery(totals && rowFields.length ? sub([]) : null, { tileId: tile.id });

  const model = useMemo(
    () => (colField && m ? pivotModel(rows, colField, rowFields, m, rowTot.rows, colTot.rows) : null),
    [rows, colField, rowFields, m, rowTot.rows, colTot.rows],
  );

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
