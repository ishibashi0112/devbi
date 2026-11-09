import type { FieldInfo, TileProps } from "devbi";
import { measures } from "./util.js";

/** Good (devbi-up) or bad (devbi-down): up is good, unless less is better (`better: lower`). No change, no colour. */
export function trendClass(m: Pick<FieldInfo, "compare" | "better">, value: unknown): string {
  if (typeof value !== "number") return "";
  const change = m.compare === "ratio" ? value - 1 : m.compare === "change" || m.compare === "delta" ? value : 0;
  if (change === 0) return "";
  return change > 0 === (m.better !== "lower") ? "devbi-up" : "devbi-down";
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
              <dd className={trendClass(m, row?.[m.name])}>{row ? format(row[m.name], m.name) : "—"}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
