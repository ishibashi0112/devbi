import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

let conn: DuckDBConnection | undefined;

/** A DuckDB (Node) connection with a small `sales` table for golden tests. */
export async function db(): Promise<DuckDBConnection> {
  if (conn) return conn;
  const inst = await DuckDBInstance.create(":memory:");
  conn = await inst.connect();
  await conn.run(`
    CREATE TABLE sales AS SELECT * FROM (VALUES
      (DATE '2025-01-10', 'o1', 'A社', '東', 100),
      (DATE '2025-01-20', 'o2', 'B社', '西', 200),
      (DATE '2025-02-05', 'o3', 'A社', '東', 300),
      (DATE '2025-04-01', 'o4', 'C社', NULL, 50),
      (DATE '2026-01-15', 'o5', 'A社', '東', 150),
      (DATE '2026-01-25', 'o5', 'A社', '東', 50),
      (DATE '2026-02-10', 'o6', 'B社', '西', 400),
      (DATE '2026-03-03', 'o7', 'C社', '西', 120)
    ) t(order_date, order_id, customer_name, region, amount)
  `);
  return conn;
}

function plain(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v && typeof v === "object" && "toDouble" in v) return (v as { toDouble(): number }).toDouble();
  return v;
}

/** Run SQL and return rows with bigint → number and dates → YYYY-MM-DD. */
export async function rows(sql: string): Promise<Record<string, unknown>[]> {
  const c = await db();
  const r = await c.runAndReadAll(sql);
  return r.getRowObjectsJS().map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)])));
}

export function round(rs: Record<string, unknown>[], digits = 4) {
  return rs.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, typeof v === "number" && !Number.isInteger(v) ? Number(v.toFixed(digits)) : v]),
    ),
  );
}
