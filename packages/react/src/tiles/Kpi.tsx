import type { TileProps } from "devbi";
import { measures } from "./util.js";

function trendClass(compare: string | undefined, value: unknown): string {
  if (typeof value !== "number") return "";
  if (compare === "ratio") return value >= 1 ? "devbi-up" : "devbi-down";
  if (compare === "change" || compare === "delta") return value >= 0 ? "devbi-up" : "devbi-down";
  return "";
}

/** A big number for the first measure, with the other measures underneath. */
export function Kpi({ rows, fields, format, loading }: TileProps) {
  const row = rows[0];
  const [main, ...rest] = measures(fields);
  if (!main) return <div className="devbi-empty">{loading ? "" : "指標を指定してください"}</div>;
  return (
    <div className="devbi-kpi">
      <div className="devbi-kpi-label">{main.label}</div>
      <div className="devbi-kpi-value" data-testid="kpi-value">
        {row ? format(row[main.name], main.name) : "—"}
      </div>
      {rest.length > 0 && (
        <dl className="devbi-kpi-sub">
          {rest.map((m) => (
            <div key={m.name}>
              <dt>{m.label}</dt>
              <dd className={trendClass(m.compare, row?.[m.name])}>{row ? format(row[m.name], m.name) : "—"}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
