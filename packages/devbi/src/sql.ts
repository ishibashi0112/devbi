import type { Scalar } from "./types.js";

/** Quote an identifier for DuckDB. */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** Format a Date as `YYYY-MM-DD` using its UTC parts. */
export function isoDate(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Format a Date as `YYYY-MM-DD HH:MM:SS[.mmm]` using its UTC parts. */
export function isoTimestamp(d: Date): string {
  const ms = d.getUTCMilliseconds();
  return `${isoDate(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${ms ? `.${pad(ms, 3)}` : ""}`;
}

/** A SQL literal for a value. Strings stay strings; use {@link timeLiteral} for the time column. */
export function literal(v: Scalar | undefined): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`数値として扱えない値です: ${v}`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return dateLiteral(v);
  return `'${v.replaceAll("'", "''")}'`;
}

function dateLiteral(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new Error("日付として扱えない値です");
  const midnight =
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  return midnight ? `DATE '${isoDate(d)}'` : `TIMESTAMP '${isoTimestamp(d)}'`;
}

/** A literal for comparing with the time column: ISO strings become DATE / TIMESTAMP. */
export function timeLiteral(v: Scalar | undefined): string {
  if (typeof v === "string") {
    if (DATE_RE.test(v)) return `DATE '${v}'`;
    if (TIMESTAMP_RE.test(v)) return `TIMESTAMP '${v.replace("T", " ").replace(/Z$/, "")}'`;
  }
  if (typeof v === "number") return dateLiteral(new Date(v));
  return literal(v);
}

/** Remove trailing semicolons and whitespace so the SQL can be nested. */
export function trimSql(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "").trim();
}

export interface IdentToken {
  name: string;
  start: number;
  end: number;
  /** Preceded by `.` (a qualified name such as `t.amount`). */
  qualified: boolean;
  /** Followed by `(` (a function call). */
  call: boolean;
  /**
   * Inside the parentheses of an aggregate call such as `SUM(...)`, or of `FILTER (...)` / `OVER (...)` / `WITHIN GROUP (...)`.
   * A name there refers to a row value (a column), never to a measure, because aggregates cannot nest.
   */
  inAggregate: boolean;
}

/** DuckDB aggregate functions (lower case). Unknown ones are treated like ordinary functions. */
const AGGREGATES = new Set(
  (
    "sum count count_star avg mean min max median mode quantile quantile_cont quantile_disc percentile_cont percentile_disc " +
    "stddev stddev_pop stddev_samp variance var_pop var_samp any_value arbitrary first last arg_max arg_min argmax argmin " +
    "arg_max_null arg_min_null max_by min_by list array_agg string_agg group_concat listagg bool_and bool_or every count_if countif " +
    "fsum sumkahan kahan_sum sum_no_overflow favg product approx_count_distinct approx_quantile reservoir_quantile histogram " +
    "entropy kurtosis kurtosis_pop skewness corr covar_pop covar_samp regr_avgx regr_avgy regr_count regr_intercept regr_r2 " +
    "regr_slope regr_sxx regr_sxy regr_syy bit_and bit_or bit_xor bitstring_agg geomean geometric_mean weighted_avg wavg mad " +
    "filter over within group"
  ).split(" "),
);

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_$]/u;

/**
 * Find bare identifiers in a SQL fragment, skipping string literals, quoted identifiers and comments.
 * Used to find references from one measure to another.
 */
export function scanIdentifiers(sql: string): IdentToken[] {
  const out: IdentToken[] = [];
  let i = 0;
  let prevSignificant = "";
  // One entry per open parenthesis: whether it opens an aggregate context. `pendingAggregate` is set by the name before `(`.
  const parens: boolean[] = [];
  let aggDepth = 0;
  let pendingAggregate = false;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      prevSignificant = quote;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close < 0 ? sql.length : close + 2;
      continue;
    }
    if (IDENT_START.test(ch)) {
      const start = i;
      i++;
      while (i < sql.length && IDENT_PART.test(sql[i]!)) i++;
      let j = i;
      while (j < sql.length && /\s/.test(sql[j]!)) j++;
      const name = sql.slice(start, i);
      const qualified = prevSignificant === ".";
      const call = sql[j] === "(";
      out.push({ name, start, end: i, qualified, call, inAggregate: aggDepth > 0 });
      // `WITHIN GROUP (` : `within` marks the context, `group` carries it to the parenthesis.
      pendingAggregate = call ? !qualified && AGGREGATES.has(name.toLowerCase()) : name.toLowerCase() === "within";
      prevSignificant = "a";
      continue;
    }
    if (ch === "(") {
      parens.push(pendingAggregate);
      if (pendingAggregate) aggDepth++;
    } else if (ch === ")") {
      if (parens.pop()) aggDepth--;
    }
    if (!/\s/.test(ch)) {
      pendingAggregate = false;
      prevSignificant = ch;
    }
    i++;
  }
  return out;
}

/** Replace identifier tokens (not qualified, not function calls, not inside an aggregate) for which `replace` returns a string. */
export function replaceIdentifiers(sql: string, replace: (name: string) => string | undefined): string {
  let out = "";
  let last = 0;
  for (const t of scanIdentifiers(sql)) {
    if (t.qualified || t.call || t.inAggregate) continue;
    const r = replace(t.name);
    if (r === undefined) continue;
    out += sql.slice(last, t.start) + r;
    last = t.end;
  }
  return out + sql.slice(last);
}

/** Whether a path starts with a URL scheme such as `https:` or `s3:` (and so is not a project file). */
export function hasUrlScheme(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(path);
}

/** `api` is DevBI's `read_api('<name>')`: rows from the read-only API (`api/<name>.sql` on the server). */
export type SourceFormat = "parquet" | "csv" | "json" | "arrow" | "xlsx" | "api";

export interface SourceRef {
  /** The table function name as written, such as `read_csv_auto`. */
  fn: string;
  format: SourceFormat;
  /** The file path as written in the first argument (for `api`, the name of the SQL file on the server). */
  path: string;
  /** Named arguments after the path, such as `sheet = '明細'`, as raw SQL text. */
  args: Record<string, string>;
  /** Range of the whole call `read_x(...)` in the SQL text. */
  start: number;
  end: number;
}

const SOURCE_FN = /\bread_(parquet|csv_auto|csv|json_auto|json|ndjson|arrow|xlsx|api)\s*\(/gi;

function formatOf(fn: string): SourceFormat {
  const f = fn.toLowerCase();
  if (f.startsWith("csv")) return "csv";
  if (f.startsWith("json") || f === "ndjson") return "json";
  return f as SourceFormat;
}

/** Split `a, b = 'x,y', c = (1, 2)` on top-level commas. */
function splitArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === quote) {
          if (text[j + 1] === quote) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Index of the `)` matching the `(` at `open`, honoring quotes. */
function matchParen(sql: string, open: number): number {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Unquote a SQL string literal `'it''s'` → `it's`. Returns undefined if not a string literal. */
export function unquoteString(text: string): string | undefined {
  const t = text.trim();
  if (t.length < 2 || !t.startsWith("'") || !t.endsWith("'")) return undefined;
  return t.slice(1, -1).replaceAll("''", "'");
}

/**
 * Find file reads such as `read_parquet('data/sales.parquet')` in model SQL, and `read_api('orders')`.
 * The browser runtime registers these files with DuckDB-wasm (or loads xlsx and API rows itself),
 * and the Vite plugin copies the files into the build.
 */
export function scanSources(sql: string): SourceRef[] {
  const out: SourceRef[] = [];
  for (const m of sql.matchAll(SOURCE_FN)) {
    const start = m.index;
    const open = start + m[0].length - 1;
    const close = matchParen(sql, open);
    if (close < 0) continue;
    const [first, ...rest] = splitArgs(sql.slice(open + 1, close));
    const path = first === undefined ? undefined : unquoteString(first);
    if (path === undefined) continue;
    const args: Record<string, string> = {};
    for (const a of rest) {
      const eq = a.indexOf("=");
      if (eq < 0) args[a.trim().toLowerCase()] = "true";
      else args[a.slice(0, eq).trim().toLowerCase()] = a.slice(eq + 1).trim();
    }
    const fn = m[0].slice(0, m[0].indexOf("(")).trim();
    out.push({ fn, format: formatOf(m[1]!), path, args, start, end: close + 1 });
  }
  return out;
}

/**
 * The parameters of `read_api('orders', from = '2025-04-01', limit = 100)`: the named arguments, each a string,
 * number, `true` / `false` or `null` literal. Throws for anything else (an expression or a column).
 */
export function apiParams(source: SourceRef): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, text] of Object.entries(source.args)) {
    const t = text.trim();
    const str = unquoteString(t);
    if (str !== undefined) out[key] = str;
    else if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) out[key] = Number(t);
    else if (/^(true|false)$/i.test(t)) out[key] = t.toLowerCase() === "true";
    else if (/^null$/i.test(t)) out[key] = null;
    else throw new Error(`read_api('${source.path}') の ${key} には、文字（'…'）か数値か true / false / null を書いてください: ${t}`);
  }
  return out;
}
