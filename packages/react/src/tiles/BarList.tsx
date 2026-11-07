import type { TileProps } from "devbi";
import { dimensions, isSelected, measures, toggleValue } from "./util.js";

/** A ranked list with bars: the first dimension by the first measure. Click to select. */
export function BarList({ rows, fields, format, selection, select }: TileProps) {
  const dim = dimensions(fields)[0];
  const [m, ...rest] = measures(fields);
  if (!dim || !m) return <div className="devbi-empty">dimensions と measures を一つずつ指定してください</div>;
  const max = Math.max(0, ...rows.map((r) => (typeof r[m.name] === "number" ? (r[m.name] as number) : 0)));
  return (
    <ul className="devbi-barlist">
      {rows.map((r, i) => {
        const v = r[m.name];
        const sel = isSelected(selection, dim.name, r[dim.name] ?? null);
        const pct = typeof v === "number" && max > 0 ? Math.max(0, (v / max) * 100) : 0;
        return (
          <li key={i}>
            <button
              type="button"
              className={sel === undefined ? "" : sel ? "devbi-selected" : "devbi-dimmed"}
              aria-pressed={!!sel}
              onClick={(e) => select(toggleValue(selection, dim.name, r[dim.name] ?? null, e.shiftKey || e.metaKey || e.ctrlKey))}
            >
              <span className="devbi-bar" style={{ width: `${pct}%` }} />
              <span className="devbi-barlist-label">{format(r[dim.name], dim.name)}</span>
              <span className="devbi-barlist-value">
                {format(v, m.name)}
                {rest.map((x) => (
                  <small key={x.name}> {format(r[x.name], x.name)}</small>
                ))}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
