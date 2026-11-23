// CSV of a query result (the dashboard's CSV export): the values as they are, for another program or a spreadsheet.
import { isoDate } from "./sql.js";
import type { FieldInfo, Row } from "./types.js";

/** Characters that make a cell a formula in Excel and other spreadsheets (`=1+1`, `@SUM(…)`, `+81-…`). */
const FORMULA_START = /^[=+\-@\t\r]/;
/** A number written as text (`-12.5`, `+3`, `-`): no formula however a spreadsheet reads it. */
const NUMBER_TEXT = /^[+-]?[\d.,\s]*$/;

/**
 * How a column's dates are written: `date` (`2026-04-01`), `time` (`2026-04-01 09:30:00`), `ms` (`… 09:30:00.250`).
 * One for the whole column, from its values (a timestamp at midnight is written with its time too).
 */
export type CsvTimeFormat = "date" | "time" | "ms";

const DAY = 86_400_000;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function dateText(d: Date, format: CsvTimeFormat): string {
  if (format === "date") return isoDate(d);
  const ms = d.getUTCMilliseconds();
  const time = `${isoDate(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return format === "ms" ? `${time}.${pad(ms, 3)}` : time;
}

/** The format for a column of these values: `time` when one of them has a time of day, `ms` when one has milliseconds. */
export function csvTimeFormat(values: Iterable<unknown>): CsvTimeFormat {
  let format: CsvTimeFormat = "date";
  for (const v of values) {
    if (!(v instanceof Date) || Number.isNaN(v.getTime())) continue;
    if (v.getUTCMilliseconds()) return "ms";
    if (((v.getTime() % DAY) + DAY) % DAY) format = "time";
  }
  return format;
}

/**
 * A value as one CSV cell, before quoting: numbers without a format (`2622450`, `0.1297`; at most 15 significant
 * digits, which drops a float's trailing noise), dates as `2026-04-01` and times as `2026-04-01 09:30:00` (their UTC
 * parts, as DevBI holds them; `time` decides, else the value itself), true / false, empty for none. Text that a
 * spreadsheet would run as a formula gets a leading `'` (CSV injection), except a number written as text.
 */
export function csvValue(value: unknown, time?: CsvTimeFormat): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : dateText(value, time ?? csvTimeFormat([value]));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return String(Number.isInteger(value) ? value : Number(value.toPrecision(15)));
  }
  if (typeof value === "bigint" || typeof value === "boolean") return String(value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return FORMULA_START.test(text) && !NUMBER_TEXT.test(text) ? `'${text}` : text;
}

/** A cell as CSV writes it: quoted when it has a comma, a quote, a line break or spaces at its ends (RFC 4180). */
function quote(text: string): string {
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The byte order mark that makes Excel read the file as UTF-8 (without it, Japanese is garbled). */
export const CSV_BOM = "﻿";

/**
 * A query result as CSV, in parts (a result of a million rows is too long for one string): a header of the fields'
 * labels, then a line per row, each ending in CRLF. Starts with the UTF-8 byte order mark, so Excel reads it as UTF-8.
 * Join the parts, or give them to `new Blob(parts)` as they are.
 */
export function csvParts(rows: readonly Row[], fields: readonly Pick<FieldInfo, "name" | "label">[]): string[] {
  const line = (cells: string[]) => `${cells.map(quote).join(",")}\r\n`;
  // A label can come from the data (a column of a database or of the model): guarded as values are.
  const parts = [CSV_BOM + line(fields.map((f) => csvValue(f.label)))];
  // Each column's dates in one format (not 2026-04-01 in one row and 2026-04-01 09:30:00 in the next).
  const times = fields.map((f) => csvTimeFormat({ *[Symbol.iterator]() { for (const r of rows) yield r[f.name]; } }));
  let batch = "";
  for (const row of rows) {
    batch += line(fields.map((f, i) => csvValue(row[f.name], times[i])));
    if (batch.length >= 1 << 20) {
      parts.push(batch);
      batch = "";
    }
  }
  if (batch) parts.push(batch);
  return parts;
}
