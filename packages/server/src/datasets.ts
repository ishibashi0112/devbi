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

/** Read and check `<dir>/api/<name>.sql`. Throws DatasetError (404 when there is no such file). */
export async function readDataset(dir: string, name: string, dialect?: Dialect): Promise<Dataset> {
  // Only names of files that are there: no paths from the request reach the file system.
  if (!(await listDatasets(dir)).includes(name)) throw new DatasetError(`API の SQL ${name} はありません（api/${name}.sql）`, 404);
  const text = await readFile(path.join(dir, "api", `${name}.sql`), "utf8");
  return parseDataset(name, text, dialect);
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
  let connection: string | undefined;
  const description: string[] = [];
  for (const line of st.title.split("\n")) {
    const m = /^connection\s*:\s*(\S+)\s*$/i.exec(line.trim());
    if (m) connection = m[1];
    else description.push(line);
  }
  const params: string[] = [];
  for (const p of parameters(st.sql, dialect)) {
    if (!params.some((q) => q.toLowerCase() === p.name.toLowerCase())) params.push(p.name);
  }
  return { name, description: description.join("\n").trim(), ...(connection ? { connection } : {}), sql: st.sql, params };
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
    // SQLite has no booleans: 1 and 0, as its own TRUE and FALSE.
    return dialect === "sqlite" && typeof v === "boolean" ? (v ? 1 : 0) : v;
  });
  return { sql: out, params };
}
