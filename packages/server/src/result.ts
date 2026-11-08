/**
 * The kind of values in a result column, as DevBI hands them on in Arrow. `null`: nothing tells the type (a SQLite
 * expression with no rows, or only NULLs); it becomes DuckDB's NULL type, which every function and comparison takes.
 */
export type ColumnType = "string" | "int" | "float" | "bool" | "date" | "timestamp" | "null";

export interface ResultColumn {
  name: string;
  type: ColumnType;
}

export interface ResultSet {
  columns: ResultColumn[];
  /**
   * Values per row, in column order: string, number, bigint, boolean or null. Dates are `YYYY-MM-DD` text and
   * timestamps `YYYY-MM-DD HH:MM:SS[.fff]` text (the database's own wall-clock time).
   */
  rows: unknown[][];
}

export type Dialect = "sqlite" | "postgres" | "mssql" | "oracle" | "mysql";

export interface QueryOptions {
  /** Give up after this long (the database stops the query where it can). */
  timeoutMs?: number;
  /** Read at most this many rows; the rest are not fetched. */
  maxRows?: number;
}

/** A read-only connection to one database. */
export interface Connection {
  dialect: Dialect;
  /**
   * Run one SELECT with its parameters already in the database's placeholder style (`bindParameters`), in a
   * transaction that cannot write where the database has one.
   */
  query(sql: string, params: unknown[], options?: QueryOptions): Promise<ResultSet>;
  close(): Promise<void>;
}

/** Drivers are optional peer dependencies: install only the one for your database. (From ashiato.) */
export async function loadDriver<T>(pkg: string, label: string): Promise<T> {
  try {
    const mod = (await import(pkg)) as { default?: T } & T;
    return (mod.default ?? mod) as T;
  } catch (e) {
    const base = pkg.split("/")[0];
    throw new Error(`${label} につなぐには ${base} が要ります。npm install ${base} で入れてください（${(e as Error).message}）`);
  }
}

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A date and time, with an optional time zone (`Z`, `+09:00`) that DevBI drops: the wall-clock time stays as written. */
export const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:\s*(?:Z|[+-]\d{2}(?::?\d{2})?))?$/i;

/** A column's type from its values, when they say: numbers, booleans, otherwise text. Undefined when all are NULL. */
export function typeOfValues(values: unknown[]): ColumnType | undefined {
  let type: ColumnType | undefined;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    let t: ColumnType;
    if (typeof v === "bigint") t = "int";
    else if (typeof v === "number") t = Number.isInteger(v) ? "int" : "float";
    else if (typeof v === "boolean") t = "bool";
    else return "string";
    if (type === undefined || type === t) type = t;
    else if ((type === "int" && t === "float") || (type === "float" && t === "int")) type = "float";
    else return "string";
  }
  return type;
}

/** Arrow and DuckDB need one name per column. */
export function checkColumnNames(names: string[]): void {
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) throw new Error(`列名が重なっています: ${dup}（AS で別の名前を付けてください）`);
}

/** A whole number as text (BIGINT, NUMBER(19)): a number when exact, a bigint otherwise. */
export function wholeNumber(text: string): number | bigint {
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : BigInt(text);
}

/** A decimal as text (DECIMAL, NUMBER): a whole number stays exact (a bigint when it must), others are a double. */
export function decimalNumber(text: string): number | bigint {
  const t = text.trim();
  if (/^[+-]?\d+$/.test(t)) return wholeNumber(t);
  return Number(t);
}

/** `YYYY-MM-DD HH:MM:SS.fff` from a Date's UTC fields (drivers that hand over the stored wall-clock time as UTC). */
export function utcText(d: Date, time = true): string {
  const iso = d.toISOString();
  if (!time) return iso.slice(0, 10);
  return iso.slice(0, 23).replace("T", " ").replace(/\.000$/, "");
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** `YYYY-MM-DD HH:MM:SS.fff` from a Date's local fields (drivers that build the Date from the stored wall-clock time). */
export function localText(d: Date): string {
  const ms = d.getMilliseconds();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    (ms ? `.${pad(ms, 3)}` : "")
  );
}

/** Binary values travel as Base64 text. */
export function base64(v: Uint8Array): string {
  return Buffer.from(v).toString("base64");
}

/** Wraps a SELECT so that the database reads at most `maxRows` rows (SQLite, PostgreSQL, MySQL's derived tables). */
export function limited(sql: string, maxRows: number | undefined): string {
  return maxRows === undefined ? sql : `SELECT * FROM (\n${sql}\n) AS devbi_rows LIMIT ${Math.max(0, Math.floor(maxRows))}`;
}

export function timeoutMessage(ms: number): string {
  return `${Math.round(ms / 100) / 10} 秒を過ぎたので止めました（--timeout で延ばせます）`;
}
