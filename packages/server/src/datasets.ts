import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Dialect } from "./connect.js";
import { parameters, readOnlyProblem, splitStatements } from "./sqltext.js";

/** One `api/<name>.sql` file: a SELECT the API runs for `read_api('<name>')`. */
export interface Dataset {
  name: string;
  /** The comment lines above the SELECT, without the `connection:` line. */
  description: string;
  /** The `-- connection: <name>` line: which DEVBI_DB_<NAME> to use. Undefined: DEVBI_DB. */
  connection?: string;
  /** The `-- snapshot: 06:00, 12:00` line: the times of day (server time, `HH:MM`) its snapshot is made. */
  snapshot?: string[];
  /** The statement, without the comments above it and without a final `;`. */
  sql: string;
  /** Parameter names (`:from` → `from`), each once, in the order they first appear. */
  params: string[];
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
  const description = st.title.split("\n").filter((line) => !/^(connection|snapshot)\s*:/i.test(line.trim()));
  const params: string[] = [];
  for (const p of parameters(st.sql, dialect)) {
    if (!params.some((q) => q.toLowerCase() === p.name.toLowerCase())) params.push(p.name);
  }
  return {
    name,
    description: description.join("\n").trim(),
    ...(connection ? { connection } : {}),
    ...(snapshot ? { snapshot } : {}),
    sql: st.sql,
    params,
  };
}

export type ParamValue = string | number | boolean | null;

/**
 * The dataset's SQL with its `:name` parameters in the database's placeholder style (`?` for SQLite, `$1` for
 * PostgreSQL), and the values in order. Every parameter needs a value, and no others may be given.
 */
export function bindParameters(dataset: Dataset, dialect: Dialect, values: Record<string, unknown>): { sql: string; params: unknown[] } {
  const rel = `api/${dataset.name}.sql`;
  // Names match without regard to case, like SQL names (and DuckDB passes read_api's argument names in lower case).
  const given = new Map<string, unknown>();
  for (const [key, v] of Object.entries(values)) {
    const lower = key.toLowerCase();
    if (given.has(lower)) throw new DatasetError(`${rel}: パラメーター ${key} が 2 回あります`, 400);
    if (!dataset.params.some((p) => p.toLowerCase() === lower)) {
      const known = dataset.params.length ? `（使えるのは ${dataset.params.join(", ")}）` : "（この SQL にはパラメーターがありません）";
      throw new DatasetError(`${rel}: パラメーター ${key} はありません${known}`, 400);
    }
    given.set(lower, v);
  }
  for (const p of dataset.params) {
    if (!given.has(p.toLowerCase())) throw new DatasetError(`${rel}: パラメーター :${p} の値がありません。read_api('${dataset.name}', ${p} = ...) と書きます`, 400);
    const v = given.get(p.toLowerCase());
    if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new DatasetError(`${rel}: パラメーター ${p} の値は文字・数値・真偽・null のどれかにしてください`, 400);
    }
  }
  const order: string[] = [];
  let out = "";
  let last = 0;
  for (const p of parameters(dataset.sql, dialect)) {
    out += dataset.sql.slice(last, p.start);
    if (dialect === "postgres") {
      let k = order.findIndex((q) => q.toLowerCase() === p.name.toLowerCase());
      if (k < 0) k = order.push(p.name) - 1;
      out += `$${k + 1}`;
    } else {
      order.push(p.name);
      out += "?";
    }
    last = p.end;
  }
  out += dataset.sql.slice(last);
  const params = order.map((name) => {
    const v = given.get(name.toLowerCase()) as ParamValue;
    if (dialect !== "sqlite") return v;
    // SQLite has no booleans: 1 and 0, as its own TRUE and FALSE. And a whole number goes in as an integer
    // (a JS number would be a REAL, which does not equal the text '10' in a TEXT column the way 10 does).
    if (typeof v === "boolean") return v ? 1n : 0n;
    return typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : v;
  });
  return { sql: out, params };
}
