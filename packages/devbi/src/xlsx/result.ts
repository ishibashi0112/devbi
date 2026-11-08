import { excelNumberFormat, excelTimeFormat, formatNumber, formatTime, formatValue } from "../format.js";
import type { FieldInfo, Row } from "../types.js";
import type { Cell, CellStyle, Sheet } from "./workbook.js";

/** The styles of a result table in xlsx. */
export const TABLE_STYLES = {
  header: { bold: true, fill: "F2F2F2", border: true },
  cell: { border: true },
  total: { bold: true, border: true },
} satisfies Record<string, CellStyle>;

const withFormat = new WeakMap<CellStyle, Map<string, CellStyle>>();

/** `style` with a number format (the same object for the same pair, so styles are looked up once). */
function formatted(style: CellStyle, format: string): CellStyle {
  let byFormat = withFormat.get(style);
  if (!byFormat) withFormat.set(style, (byFormat = new Map()));
  let s = byFormat.get(format);
  if (!s) byFormat.set(format, (s = { ...style, format }));
  return s;
}

type FieldFormat = Pick<FieldInfo, "format" | "grain" | "kind">;

/**
 * A result value as an xlsx cell, shown in Excel as the dashboard shows it: numbers stay numbers with the field's
 * format (`¥1,200`, `12.3%`), dates stay dates labeled by the time grain (`2026年4月`). A quarter, which Excel has no
 * format for, and true / false (はい / いいえ) are written as their text.
 */
export function resultCell(value: unknown, field: FieldFormat | undefined, fiscalYearStart = 1, style: CellStyle = TABLE_STYLES.cell): Cell {
  if (value === null || value === undefined) return { v: null, s: style };
  if (value instanceof Date) {
    const format = excelTimeFormat(field?.grain, fiscalYearStart, value.getTime() % 86_400_000 !== 0);
    const text = formatTime(value, field?.grain, fiscalYearStart);
    return format ? { v: value, s: formatted(style, format), text } : { v: text, s: style };
  }
  const n = typeof value === "bigint" && Number.isSafeInteger(Number(value)) ? Number(value) : value;
  if (typeof n === "number") {
    const format = field?.format ? excelNumberFormat(field.format) : Number.isInteger(n) ? "#,##0" : "#,##0.0#";
    // compact (1.2億) is shown in full in Excel: as wide as that
    const [compact, pre = "", post = ""] = field?.format?.split(":") ?? [];
    const text = compact === "compact" ? `${pre}${formatNumber(n, "#,##0")}${post}` : formatValue(n, field, fiscalYearStart);
    return { v: n, s: formatted(style, format), text };
  }
  if (typeof n === "string") return { v: n, s: style };
  return { v: formatValue(n, field, fiscalYearStart), s: style };
}

/**
 * Write a query result as a table from the sheet's next row: a header of the fields' labels, then a row per result
 * row, with an auto filter and the header kept in view. Returns the header's zero-based row.
 */
export function addResultTable(sheet: Sheet, rows: readonly Row[], fields: readonly FieldInfo[], options: { fiscalYearStart?: number } = {}): number {
  const header = sheet.add(...fields.map((f) => ({ v: f.label, s: TABLE_STYLES.header })));
  for (const row of rows) sheet.add(...fields.map((f) => resultCell(row[f.name], f, options.fiscalYearStart)));
  sheet.freeze = { rows: header + 1 };
  if (rows.length > 0 && fields.length > 0) sheet.filter = [header, header + rows.length, fields.length];
  return header;
}
