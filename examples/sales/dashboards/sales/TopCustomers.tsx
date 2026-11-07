// A tile promoted to JSX. It declares what it needs (no SQL); the runtime runs the query
// with the other tiles' selections applied, and passes the rows in.
import type { Query, TileProps } from "devbi";

export const query: Query = { measures: ["revenue", "orders", "revenue_yoy"], dimensions: ["customer"], limit: 10 };

export default function TopCustomers({ rows, format, select, selection }: TileProps) {
  const own = selection.find((f) => f.field === "customer");
  const chosen = own && "in" in own ? own.in : [];
  const max = Math.max(1, ...rows.map((r) => Number(r.revenue) || 0));
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
      {rows.map((r, i) => {
        const on = chosen.includes(r.customer ?? null);
        const yoy = typeof r.revenue_yoy === "number" ? r.revenue_yoy : null;
        return (
          <li key={String(r.customer)}>
            <button
              type="button"
              aria-pressed={on}
              onClick={() => select(on ? null : { field: "customer", in: [r.customer ?? null] })}
              style={{
                width: "100%",
                display: "grid",
                gridTemplateColumns: "1.6em 1fr auto",
                gap: 8,
                alignItems: "baseline",
                padding: "6px 8px",
                borderRadius: 6,
                border: on ? "2px solid var(--devbi-accent)" : "1px solid var(--devbi-border)",
                background: `linear-gradient(90deg, var(--devbi-accent-soft) ${((Number(r.revenue) || 0) / max) * 100}%, transparent 0)`,
                cursor: "pointer",
                textAlign: "left",
                opacity: chosen.length && !on ? 0.5 : 1,
              }}
            >
              <span style={{ color: "var(--devbi-muted)" }}>{i + 1}</span>
              <span>
                {format(r.customer, "customer")}
                <small style={{ display: "block", color: "var(--devbi-muted)" }}>{format(r.orders, "orders")} 件</small>
              </span>
              <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {format(r.revenue, "revenue")}
                {yoy !== null && (
                  <small style={{ display: "block", color: yoy >= 1 ? "var(--devbi-up)" : "var(--devbi-down)" }}>
                    前年比 {format(yoy, "revenue_yoy")}
                  </small>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
