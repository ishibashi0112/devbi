import * as arrow from "apache-arrow";
import type { ColumnType, ResultSet } from "./connect.js";

/** Milliseconds since 1970 for `YYYY-MM-DD[ HH:MM:SS[.fff]]`, read as UTC (DuckDB's TIMESTAMP has no time zone). */
function utcMillis(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?$/.exec(text);
  if (!m) return null;
  const ms = m[7] ? Math.round(Number(m[7]) * 1000) : 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0), ms);
}

function vector(type: ColumnType, values: unknown[]): arrow.Vector {
  switch (type) {
    case "int":
      return arrow.vectorFromArray(
        values.map((v) => (v === null || v === undefined ? null : BigInt(v as number | bigint))),
        new arrow.Int64(),
      );
    case "float":
      return arrow.vectorFromArray(
        values.map((v) => (v === null || v === undefined ? null : Number(v))),
        new arrow.Float64(),
      );
    case "bool":
      return arrow.vectorFromArray(
        values.map((v) => (v === null || v === undefined ? null : Boolean(v))),
        new arrow.Bool(),
      );
    case "date":
      return arrow.vectorFromArray(
        values.map((v) => {
          const ms = typeof v === "string" ? utcMillis(v) : null;
          return ms === null ? null : new Date(ms);
        }),
        new arrow.DateDay(),
      );
    case "timestamp":
      return arrow.vectorFromArray(
        values.map((v) => (typeof v === "string" ? utcMillis(v) : null)),
        new arrow.TimestampMillisecond(),
      );
    default:
      return arrow.vectorFromArray(
        values.map((v) => (v === null || v === undefined ? null : String(v))),
        new arrow.Utf8(),
      );
  }
}

/** A result set as an Arrow table. */
export function toArrowTable(result: ResultSet): arrow.Table {
  const vectors: Record<string, arrow.Vector> = {};
  result.columns.forEach((c, i) => {
    vectors[c.name] = vector(
      c.type,
      result.rows.map((r) => r[i]),
    );
  });
  return new arrow.Table(vectors);
}

/** A result set as Arrow IPC stream bytes (`application/vnd.apache.arrow.stream`). */
export function toArrowStream(result: ResultSet): Uint8Array {
  return arrow.tableToIPC(toArrowTable(result), "stream");
}
