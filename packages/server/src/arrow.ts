import * as arrow from "apache-arrow";
import type { ColumnType, ResultSet } from "./result.js";

/** Milliseconds since 1970 for `YYYY-MM-DD[ HH:MM:SS[.fff]]`, read as UTC (DuckDB's TIMESTAMP has no time zone). Sent as microseconds, DuckDB's TIMESTAMP, to the millisecond. */
function utcMillis(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?$/.exec(text);
  if (!m) return null;
  const ms = m[7] ? Math.round(Number(m[7]) * 1000) : 0;
  // setUTCFullYear, not Date.UTC: Date.UTC reads years 0–99 as 1900–1999 (0001-01-01 is .NET's DateTime.MinValue,
  // common in SQL Server tables)
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.setUTCHours(Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0), ms);
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const fitsInt64 = (v: unknown) => typeof v !== "bigint" || (v >= INT64_MIN && v <= INT64_MAX);

function vector(type: ColumnType, values: unknown[]): arrow.Vector {
  switch (type) {
    case "int":
      // Whole numbers past BIGINT (DECIMAL(38,0), BIGINT UNSIGNED, Oracle's NUMBER) go as DOUBLE, like decimals.
      if (!values.every(fitsInt64)) return vector("float", values);
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
        new arrow.TimestampMicrosecond(),
      );
    case "null":
      return new arrow.Vector([arrow.makeData({ type: new arrow.Null(), length: values.length, nullCount: values.length })]);
    default:
      return arrow.vectorFromArray(
        values.map((v) => (v === null || v === undefined ? null : String(v))),
        new arrow.Utf8(),
      );
  }
}

/** A result set as an Arrow table, its columns in the SELECT's order. */
export function toArrowTable(result: ResultSet): arrow.Table {
  // Built from a list, not an object: an object would put columns named like numbers ("2024") first.
  const vectors = result.columns.map((c, i) => vector(c.type, result.rows.map((r) => r[i])));
  const fields = result.columns.map((c, i) => new arrow.Field(c.name, vectors[i]!.type, true));
  const children = vectors.map((v) => (v.data.length === 1 ? v.data[0]! : arrow.makeData({ type: v.type, length: 0, nullCount: 0 })));
  const schema = new arrow.Schema(fields);
  const length = result.rows.length;
  return new arrow.Table(schema, [new arrow.RecordBatch(schema, arrow.makeData({ type: new arrow.Struct(fields), length, nullCount: 0, children }))]);
}

/** A result set as Arrow IPC stream bytes (`application/vnd.apache.arrow.stream`). */
export function toArrowStream(result: ResultSet): Uint8Array {
  return arrow.tableToIPC(toArrowTable(result), "stream");
}
