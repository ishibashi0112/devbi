import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Dialect } from "./result.js";
import { MAX_PLACEHOLDERS, ParamLineError, RESERVED, checkValue, headerDirectives, type DatasetParameter, type ParamType } from "./params.js";
import { isNameChar, parameters, readOnlyProblem, splitStatements } from "./sqltext.js";

/** One `api/<name>.sql` file: a SELECT the API runs for `read_api('<name>')`. */
export interface Dataset {
  name: string;
  /** The comment lines above the SELECT, without the `connection:`, `snapshot:`, `param:` and `key:` lines. */
  description: string;
  /** The `-- connection: <name>` line: which DEVBI_DB_<NAME> to use. Undefined: DEVBI_DB. */
  connection?: string;
  /** The `-- snapshot: 06:00, 12:00` line: the times of day (server time, `HH:MM`) its snapshot is made. */
  snapshot?: string[];
  /** The statement, without the comments above it and without a final `;`. */
  sql: string;
  /** Parameter names (`:from` → `from`), each once, in the order they first appear. */
  params: string[];
  /**
   * One per parameter: those with a `-- param:` line first, in the order of the lines (with their type, label,
   * default…), then the others in the order they first appear (only `name`).
   */
  parameters: DatasetParameter[];
  /** The `-- key: 受注番号, 行番号` line: the result columns that tell one row from another. */
  key?: string[];
}

export class DatasetError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The names of the SQL files in `<dir>/api`, sorted. */
export async function listDatasets(dir: string): Promise<string[]> {
  const apiDir = path.join(dir, "api");
  if (!existsSync(apiDir)) return [];
  return (await readdir(apiDir))
    .filter((f) => f.endsWith(".sql") && !f.startsWith("."))
    .map((f) => f.slice(0, -".sql".length))
    .sort();
}

/** The environment variable that holds a connection's URL: DEVBI_DB, or DEVBI_DB_<NAME> for a named one. */
export function connectionVariable(connection?: string): string {
  return connection ? `DEVBI_DB_${connection.toUpperCase().replace(/[^A-Z0-9]/g, "_")}` : "DEVBI_DB";
}

/** The text of `<dir>/api/<name>.sql`. Throws DatasetError (404 when there is no such file). */
export async function readDatasetText(dir: string, name: string): Promise<string> {
  // Only names of files that are there: no paths from the request reach the file system.
  if (!(await listDatasets(dir)).includes(name)) throw new DatasetError(`API の SQL ${name} はありません（api/${name}.sql）`, 404);
  return readFile(path.join(dir, "api", `${name}.sql`), "utf8");
}

/** Read and check `<dir>/api/<name>.sql` with the database's quoting rules. Throws DatasetError (404 when there is no such file). */
export async function readDataset(dir: string, name: string, dialect?: Dialect): Promise<Dataset> {
  return parseDataset(name, await readDatasetText(dir, name), dialect);
}

const CONNECTION_LINE = /^\s*--\s*connection\s*:\s*(\S+)\s*$/i;

/**
 * The `-- connection: <name>` line among the comment lines at the top of the file (blank lines between them are
 * fine), without checking the SQL: which database, and so which quoting rules, the rest is read with.
 */
export function connectionOf(text: string): string | undefined {
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = CONNECTION_LINE.exec(line);
    if (m) return m[1];
    if (line.trim() && !/^\s*--/.test(line)) return undefined;
  }
  return undefined;
}

const SNAPSHOT_LINE = /^\s*--\s*snapshot\s*:(.*)$/i;

/**
 * The `-- snapshot: 06:00, 12:00` line among the comment lines at the top of the file: the times of day its
 * snapshot is made (sorted, `HH:MM`). Undefined: no snapshot, `read_api` asks the database each time.
 * Throws DatasetError for a time it cannot read.
 */
export function snapshotOf(text: string, name = "?"): string[] | undefined {
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = SNAPSHOT_LINE.exec(line);
    if (m) {
      const times = m[1]!.split(/[,、\s]+/).filter(Boolean).map((t) => {
        const hm = /^(\d{1,2}):(\d{2})$/.exec(t);
        if (!hm || Number(hm[1]) > 23 || Number(hm[2]) > 59) {
          throw new DatasetError(`api/${name}.sql: snapshot の時刻は 06:00 のように書きます（${t}）`, 400);
        }
        return `${hm[1]!.padStart(2, "0")}:${hm[2]}`;
      });
      if (times.length === 0) throw new DatasetError(`api/${name}.sql: snapshot に時刻を書いてください（例: -- snapshot: 06:00）`, 400);
      return [...new Set(times)].sort();
    }
    if (line.trim() && !/^\s*--/.test(line)) return undefined;
  }
  return undefined;
}

export function parseDataset(name: string, text: string, dialect?: Dialect): Dataset {
  const rel = `api/${name}.sql`;
  const statements = splitStatements(text, dialect);
  if (statements.length === 0) throw new DatasetError(`${rel}: SELECT 文がありません`, 400);
  if (statements.length > 1) throw new DatasetError(`${rel}: 1 つのファイルに書ける SELECT 文は 1 つだけです（${statements.length} 個あります）`, 400);
  const st = statements[0]!;
  const problem = readOnlyProblem(st.sql, dialect);
  if (problem) {
    const why =
      problem.code === "not-select"
        ? `SELECT か WITH で始まる文だけ使えます（${problem.word ?? "この文"} で始まっています）`
        : problem.code === "several"
          ? "文が 2 つ以上あるかもしれません。引用符の閉じ忘れがないか見てください"
          : `${problem.word} は使えません。読み取るだけの SELECT にしてください（列名なら引用符で囲みます）`;
    throw new DatasetError(`${rel}: ${why}`, 400);
  }
  const connection = connectionOf(text);
  const snapshot = snapshotOf(text, name);
  const description = st.title.split("\n").filter((line) => !/^(connection|snapshot|param|key)\s*:/i.test(line.trim()));
  const places = parameters(st.sql, dialect);
  const params: string[] = [];
  for (const p of places) {
    if (!params.some((q) => q.toLowerCase() === p.name.toLowerCase())) params.push(p.name);
  }
  let header: ReturnType<typeof headerDirectives>;
  try {
    header = headerDirectives(text, name, params);
  } catch (e) {
    if (e instanceof ParamLineError) throw new DatasetError(e.message, 400);
    throw e;
  }
  // A multiple-value parameter only in `IN (:name)`: the server writes one placeholder per value there.
  for (const p of places) {
    const def = header.parameters.find((d) => d.name.toLowerCase() === p.name.toLowerCase());
    if (!def?.multiple) continue;
    if (!inList(st.sql, p.start, p.end)) {
      const line = st.line + (st.sql.slice(0, p.start).match(/\n/g)?.length ?? 0);
      throw new DatasetError(`${rel}（${line} 行目）: :${p.name} は複数の値（${def.type}[]）なので、IN (:${p.name}) の形でだけ使えます`, 400);
    }
  }
  const declared = new Set(header.parameters.map((d) => d.name.toLowerCase()));
  return {
    name,
    description: description.join("\n").trim(),
    ...(connection ? { connection } : {}),
    ...(snapshot ? { snapshot } : {}),
    sql: st.sql,
    params,
    parameters: [...header.parameters, ...params.filter((p) => !declared.has(p.toLowerCase())).map((p) => ({ name: p }))],
    ...(header.key ? { key: header.key } : {}),
  };
}

/** Whether the parameter at sql[start, end) is all there is in `IN (…)` (NOT IN too), spaces aside. */
function inList(sql: string, start: number, end: number): boolean {
  const space = (c: string | undefined) => c !== undefined && /\s/.test(c);
  let j = end;
  while (space(sql[j])) j++;
  if (sql[j] !== ")") return false;
  let i = start - 1;
  while (space(sql[i])) i--;
  if (sql[i] !== "(") return false;
  i--;
  while (space(sql[i])) i--;
  return i >= 1 && (sql[i - 1] === "I" || sql[i - 1] === "i") && (sql[i] === "N" || sql[i] === "n") && !isNameChar(sql[i - 2]);
}

export type ParamValue = string | number | boolean | null;

// PostgreSQL works out constant expressions with the values while it plans (even under LIMIT 0): values that most
// expressions take (a text that is also a number, no zero to divide by).
const SAMPLES: Record<ParamType, ParamValue> = { text: "1", integer: 1, number: 1, date: "2000-01-01", datetime: "2000-01-01 00:00:00", boolean: false };

/**
 * A value for each parameter that passes its checks (`-- param:` typed ones as their type, a list of one for a
 * list; the others null), to ask the database about the result's columns without anyone's values (`api/describe`).
 */
export function describeValues(dataset: Dataset): Record<string, ParamValue | ParamValue[]> {
  return Object.fromEntries(
    dataset.params.map((p) => {
      const def = dataset.parameters.find((d) => d.name.toLowerCase() === p.toLowerCase());
      if (!def?.type) return [p, null];
      const v = SAMPLES[def.type];
      return [p, def.multiple ? [v] : v];
    }),
  );
}

/** The placeholder for the k-th value (from 1): `?` (SQLite, MySQL), `$1` (PostgreSQL), `@p1` (SQL Server), `:p1` (Oracle). */
function placeholder(dialect: Dialect, k: number): string {
  switch (dialect) {
    case "postgres":
      return `$${k}`;
    case "mssql":
      return `@p${k}`;
    case "oracle":
      return `:p${k}`;
    default:
      return "?";
  }
}

const PG_TYPES: Record<ParamType, string> = { text: "text", integer: "bigint", number: "numeric", date: "date", datetime: "timestamp", boolean: "boolean" };

/**
 * A typed parameter's place in the SQL. Dates and times go as `YYYY-MM-DD[ HH:MM:SS[.ffffff]]` text, read the same
 * whatever the session's date format: PostgreSQL casts every typed value (otherwise `:x IS NULL OR …` cannot tell
 * the type), SQL Server, Oracle and MySQL cast dates and times, SQLite nothing (it keeps dates as text).
 */
function typedPlace(dialect: Dialect, type: ParamType | undefined, ph: string, value: ParamValue): string {
  if (!type) return ph;
  switch (dialect) {
    case "postgres":
      return `CAST(${ph} AS ${PG_TYPES[type]})`;
    case "mssql":
      return type === "date" ? `CAST(${ph} AS date)` : type === "datetime" ? `CAST(${ph} AS datetime2)` : ph;
    case "oracle":
      if (type === "date") return `TO_DATE(${ph}, 'YYYY-MM-DD')`;
      // a DATE keeps seconds, and a DATE column compared with a TIMESTAMP loses its index: TIMESTAMP only for fractions
      if (type === "datetime") return typeof value === "string" && value.includes(".") ? `TO_TIMESTAMP(${ph}, 'YYYY-MM-DD HH24:MI:SS.FF')` : `TO_DATE(${ph}, 'YYYY-MM-DD HH24:MI:SS')`;
      return ph;
    case "mysql":
      return type === "date" ? `CAST(${ph} AS DATE)` : type === "datetime" ? `CAST(${ph} AS DATETIME(6))` : ph;
    default:
      return ph;
  }
}

/** A value as the driver takes it. */
function driverValue(dialect: Dialect, v: ParamValue): unknown {
  if (dialect !== "sqlite") return v;
  // SQLite has no booleans: 1 and 0, as its own TRUE and FALSE. And a whole number goes in as an integer
  // (a JS number would be a REAL, which does not equal the text '10' in a TEXT column the way 10 does).
  if (typeof v === "boolean") return v ? 1n : 0n;
  return typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : v;
}

/**
 * The dataset's SQL with its `:name` parameters in the database's placeholder style, and the values in order:
 * `?` for each place (SQLite, MySQL), or one numbered placeholder per name (`$1` PostgreSQL, `@p1` SQL Server,
 * `:p1` Oracle). Every parameter needs a value, and no others may be given. A parameter with a `-- param:` line is
 * checked against its type and goes typed (`typedPlace`); a multiple-value one becomes one placeholder per value in
 * its `IN (…)`. Names starting with `user.` are refused: they are the signed-in user's values (row-level security).
 */
export function bindParameters(dataset: Dataset, dialect: Dialect, values: Record<string, unknown>): { sql: string; params: unknown[] } {
  const rel = `api/${dataset.name}.sql`;
  // Names match without regard to case, like SQL names (and DuckDB passes read_api's argument names in lower case).
  const given = new Map<string, unknown>();
  for (const [key, v] of Object.entries(values)) {
    const lower = key.toLowerCase();
    if (RESERVED.test(key)) throw new DatasetError(`${rel}: パラメーター ${key} は渡せません（user. で始まる名前は、ログインした人の値のために取ってあります）`, 400);
    if (given.has(lower)) throw new DatasetError(`${rel}: パラメーター ${key} が 2 回あります`, 400);
    if (!dataset.params.some((p) => p.toLowerCase() === lower)) {
      const known = dataset.params.length ? `（使えるのは ${dataset.params.join(", ")}）` : "（この SQL にはパラメーターがありません）";
      throw new DatasetError(`${rel}: パラメーター ${key} はありません${known}`, 400);
    }
    given.set(lower, v);
  }
  const types = new Map<string, ParamType | undefined>();
  const checked = new Map<string, ParamValue | ParamValue[]>();
  for (const p of dataset.params) {
    const lower = p.toLowerCase();
    if (!given.has(lower)) throw new DatasetError(`${rel}: パラメーター :${p} の値がありません。read_api('${dataset.name}', ${p} = ...) と書きます`, 400);
    const v = given.get(lower);
    const def = dataset.parameters.find((d) => d.name.toLowerCase() === lower);
    if (def?.type) {
      types.set(lower, def.type);
      try {
        checked.set(lower, checkValue(rel, def as DatasetParameter & { type: ParamType }, v));
      } catch (e) {
        throw new DatasetError((e as Error).message, 400);
      }
      continue;
    }
    if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new DatasetError(`${rel}: パラメーター ${p} の値は文字・数値・真偽・null のどれかにしてください`, 400);
    }
    checked.set(lower, v);
  }
  const numbered = dialect === "postgres" || dialect === "mssql" || dialect === "oracle";
  // PostgreSQL, SQL Server, Oracle: a name's placeholders, written again where the name comes again.
  const written = new Map<string, string>();
  const params: unknown[] = [];
  let out = "";
  let last = 0;
  for (const p of parameters(dataset.sql, dialect)) {
    out += dataset.sql.slice(last, p.start);
    const lower = p.name.toLowerCase();
    let place = numbered ? written.get(lower) : undefined;
    if (place === undefined) {
      const v = checked.get(lower)!;
      const type = types.get(lower);
      place = (Array.isArray(v) ? v : [v]).map((x) => typedPlace(dialect, type, placeholder(dialect, params.push(driverValue(dialect, x))), x)).join(", ");
      if (numbered) written.set(lower, place);
    }
    out += place;
    last = p.end;
  }
  out += dataset.sql.slice(last);
  if (params.length > MAX_PLACEHOLDERS) {
    throw new DatasetError(
      `${rel}: パラメーターの値が全部で ${params.length.toLocaleString("en-US")} 個になります。1 つの SQL に渡せるのは ${MAX_PLACEHOLDERS.toLocaleString("en-US")} 個までです。候補を絞るか、すべてのときはこのパラメーターを使わない SQL にしてください`,
      400,
    );
  }
  return { sql: out, params };
}

