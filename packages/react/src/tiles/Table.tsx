import type { Row, Scalar, TileProps } from "devbi";
import { useMemo, useState } from "react";
import { dimensions, filterFor, isSelected } from "./util.js";

function compare(a: Scalar | undefined, b: Scalar | undefined): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "ja");
}

function sameRow(selection: TileProps["selection"], row: Row): boolean | undefined {
  if (!selection.length) return undefined;
  return selection.every((f) => isSelected(selection, f.field, row[f.field] ?? null));
}

/** A sortable table of all result fields. Clicking a row selects its dimension values. */
export function Table({ rows, fields, format, selection, select }: TileProps) {
  const [sort, setSort] = useState<{ field: string; desc: boolean } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const s = [...rows].sort((a, b) => compare(a[sort.field], b[sort.field]));
    return sort.desc ? s.reverse() : s;
  }, [rows, sort]);
  const dims = dimensions(fields);
  const time = fields.find((f) => f.kind === "time");
  return (
    <div className="devbi-table-wrap">
      <table className="devbi-table">
        <thead>
          <tr>
            {fields.map((f) => (
              <th
                key={f.name}
                className={f.kind === "measure" ? "devbi-num" : ""}
                aria-sort={sort?.field === f.name ? (sort.desc ? "descending" : "ascending") : "none"}
              >
                <button
                  type="button"
                  onClick={() => setSort((s) => (s?.field === f.name ? (s.desc ? null : { field: f.name, desc: true }) : { field: f.name, desc: false }))}
                >
                  {f.label}
                  {sort?.field === f.name ? (sort.desc ? " ▼" : " ▲") : ""}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const sel = sameRow(selection, r);
            return (
              <tr
                key={i}
                className={sel === undefined ? "" : sel ? "devbi-selected" : "devbi-dimmed"}
                onClick={() => {
                  if (!dims.length && !time) return;
                  if (sel) return select(null);
                  select([
                    ...dims.map((d) => filterFor(d, r[d.name] ?? null)),
                    ...(time && r[time.name] instanceof Date ? [filterFor(time, r[time.name] ?? null)] : []),
                  ]);
                }}
              >
                {fields.map((f) => (
                  <td key={f.name} className={f.kind === "measure" ? "devbi-num" : ""}>
                    {format(r[f.name], f.name)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
