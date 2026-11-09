// Arrow results as plain rows: for the engine's queries, and for the Excel export of an explore tile's rows (its own
// module, so the export's chunk does not import the engine's).
import * as arrow from "apache-arrow";
import type { Row } from "devbi";

/** Convert an Arrow value to a plain JS value. */
function converter(type: arrow.DataType): (v: unknown) => Row[string] {
  if (arrow.DataType.isDate(type) || arrow.DataType.isTimestamp(type)) {
    return (v) => (v === null || v === undefined ? null : new Date(Number(v)));
  }
  if (arrow.DataType.isDecimal(type)) {
    const scale = (type as arrow.Decimal).scale;
    return (v) => (v === null || v === undefined ? null : arrow.util.bigNumToNumber(v as never, scale));
  }
  if (arrow.DataType.isInt(type)) {
    return (v) => (v === null || v === undefined ? null : typeof v === "bigint" ? Number(v) : (v as number));
  }
  if (arrow.DataType.isBool(type) || arrow.DataType.isFloat(type) || arrow.DataType.isUtf8(type)) {
    return (v) => (v === undefined ? null : (v as Row[string]));
  }
  return (v) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v));
}

/** An Arrow table's rows as plain objects (dates as Date, decimals and 64-bit integers as numbers). */
export function tableToRows(table: arrow.Table): Row[] {
  const cols = table.schema.fields.map((f, i) => ({ name: f.name, vec: table.getChildAt(i)!, conv: converter(f.type) }));
  const out: Row[] = new Array(table.numRows);
  for (let r = 0; r < table.numRows; r++) {
    const row: Row = {};
    for (const c of cols) row[c.name] = c.conv(c.vec.get(r));
    out[r] = row;
  }
  return out;
}
