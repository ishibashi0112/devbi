import { Workbook, type CellStyle } from "./workbook.js";

export type XlsxCell = string | number | boolean | Date | null | undefined;

export interface XlsxSheet {
  name: string;
  /** First row is usually the header. */
  rows: XlsxCell[][];
}

const DATE: CellStyle = { format: "yyyy/m/d" };
const DATE_TIME: CellStyle = { format: "yyyy/m/d h:mm:ss" };

/**
 * Write a plain xlsx workbook: one table per sheet, dates as Excel dates. Used for sample data and tests; the reader
 * is {@link readXlsx}. For styles, number formats and frozen headers use {@link Workbook}.
 */
export async function writeXlsx(sheets: XlsxSheet[]): Promise<Uint8Array> {
  const book = new Workbook();
  for (const s of sheets) {
    const sheet = book.sheet(s.name);
    for (const row of s.rows) sheet.add(...row.map((v) => (v instanceof Date ? { v, s: v.getTime() % 86_400_000 === 0 ? DATE : DATE_TIME } : v)));
  }
  return book.toBytes();
}
