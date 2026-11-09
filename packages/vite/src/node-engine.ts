// DuckDB (the same DuckDB-wasm the browser runs, in its Node build) over a project's files on disk: what devbi-check
// and devbi-inspect run the model SQL and the tiles' queries on. It reads the data as the browser engine
// (@devbi/react's engine.ts) does: xlsx through devbi's reader, read_api through the API's SQL files, other files
// as DuckDB reads them. Only for checking: no cache, one query at a time.
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import * as duckdb from "@duckdb/duckdb-wasm/blocking";
import * as arrow from "apache-arrow";
import { apiParams, hasUrlScheme, ident, readXlsx, scanSources, unquoteString, type MetricsView, type XlsxTable } from "devbi";

/** A view or file that this engine does not read (a URL, the API without a database), so it was not checked. */
export class NotChecked extends Error {}

export interface NodeEngine {
  /** Run SQL; the rows as plain objects (dates as Date). */
  query(sql: string): Record<string, unknown>[];
  /** Load a metrics view's data (its model SQL as a table) and return SQL selecting from it. */
  loadView(view: MetricsView): Promise<string>;
  /**
   * Load one data file (relative to the project, or absolute) as a table: its name, and for an Excel file the cells
   * read (`A1:K3068`, the header row included).
   */
  loadFile(file: string, options?: { sheet?: string; range?: string }): Promise<{ table: string; range?: string }>;
  close(): void;
}

export interface NodeEngineOptions {
  /** Environment for the API's database (DEVBI_DB…). Default: the project's .env files and `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * When DuckDB could not download an extension it needs (parquet, json, icu for `current_date`…; it fetches them from
 * the internet, as in the browser): its name.
 */
export function missingExtension(e: unknown): string | undefined {
  const text = e instanceof Error ? e.message : String(e);
  if (!/Extension Autoloading Error/.test(text)) return undefined;
  return /required extension '([\w-]+)/.exec(text)?.[1] ?? "?";
}

/** DuckDB's message without the "LINE 1: …" pointer into SQL the user did not write. */
export function duckdbMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/\n+LINE \d+:[\s\S]*$/, "").trim();
}

/**
 * When DuckDB found no file: the browser reads only the files named in read_xlsx(…), read_csv(…) and the like, so
 * a path in FROM 'data/x.csv' does not work there (nor here, where statements run from an empty folder).
 */
export function fileHint(message: string): string {
  return /No files found|Cannot open file|No such file/i.test(message)
    ? "\nデータのファイルは read_csv('data/…') のように read_ の関数で読んでください（ブラウザはそう書いたファイルだけを読み込みます）"
    : "";
}

/** As the browser engine converts xlsx to Arrow (engine.ts xlsxToArrow). */
function xlsxToArrow(t: XlsxTable): arrow.Table {
  if (!t.columns.length) throw new Error(`シート「${t.sheet}」にデータがありません`);
  const vectors: Record<string, arrow.Vector> = {};
  for (const c of t.columns) {
    switch (c.type) {
      case "BIGINT":
        vectors[c.name] = arrow.vectorFromArray(
          c.values.map((v) => (v === null ? null : BigInt(v as number))),
          new arrow.Int64(),
        );
        break;
      case "DOUBLE":
        vectors[c.name] = arrow.vectorFromArray(c.values as (number | null)[], new arrow.Float64());
        break;
      case "BOOLEAN":
        vectors[c.name] = arrow.vectorFromArray(c.values as (boolean | null)[], new arrow.Bool());
        break;
      case "DATE":
        vectors[c.name] = arrow.vectorFromArray(c.values as (Date | null)[], new arrow.DateDay());
        break;
      case "TIMESTAMP":
        vectors[c.name] = arrow.vectorFromArray(
          c.values.map((v) => (v === null ? null : (v as Date).getTime())),
          new arrow.TimestampMillisecond(),
        );
        break;
      default:
        vectors[c.name] = arrow.vectorFromArray(c.values as (string | null)[], new arrow.Utf8());
    }
  }
  return new arrow.Table(vectors);
}

function duckType(type: arrow.DataType): string {
  if (arrow.DataType.isNull(type)) return '"NULL"';
  if (arrow.DataType.isInt(type)) return "BIGINT";
  if (arrow.DataType.isFloat(type) || arrow.DataType.isDecimal(type)) return "DOUBLE";
  if (arrow.DataType.isBool(type)) return "BOOLEAN";
  if (arrow.DataType.isDate(type)) return "DATE";
  if (arrow.DataType.isTimestamp(type)) return "TIMESTAMP";
  return "VARCHAR";
}

/** A value of a result row as a plain one (Arrow's dates are numbers; DuckDB's integers may be bigint). */
function plain(v: unknown, type: arrow.DataType): unknown {
  if (v === null || v === undefined) return null;
  if (arrow.DataType.isDate(type) || arrow.DataType.isTimestamp(type)) return new Date(Number(v));
  // As the browser engine (tableToRows): SUM of integers is a HUGEINT, a decimal in Arrow.
  if (arrow.DataType.isDecimal(type)) return arrow.util.bigNumToNumber(v as never, (type as arrow.Decimal).scale);
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "object") return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x));
  return v;
}

const require = createRequire(import.meta.url);

/** Start DuckDB-wasm in this process (a second or so). */
export async function createNodeEngine(dir: string, options: NodeEngineOptions = {}): Promise<NodeEngine> {
  const bundles = {
    base: {
      mainModule: require.resolve("@duckdb/duckdb-wasm/dist/duckdb-base.wasm"),
      mainWorker: require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-base.worker.cjs"),
    },
  };
  // DuckDB-wasm's Node runtime warns "test for unknown feature" while it opens: not the user's problem.
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (!/^test for unknown feature/.test(String(args[0]))) warn(...args);
  };
  let db: Awaited<ReturnType<typeof duckdb.createDuckDB>>;
  let conn: ReturnType<typeof db.connect>;
  try {
    db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await db.instantiate(() => undefined);
    // As the browser opens it (engine.ts): numbers come back as numbers.
    db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true } });
    conn = db.connect();
  } finally {
    console.warn = warn;
  }

  // DuckDB's Node runtime reads a path it was not given (FROM 'data/x.csv', a list of files…) from the disk, relative
  // to the current folder; the browser cannot read it. Each statement runs from an empty folder, so that such a path
  // fails here as it does in the browser.
  const empty = mkdtempSync(path.join(tmpdir(), "devbi-duckdb-"));
  const sql = (text: string) => {
    const cwd = process.cwd();
    let moved = false;
    try {
      process.chdir(empty);
      moved = true;
    } catch {
      // In a worker thread (no chdir): from the current folder.
    }
    try {
      return conn.query(text);
    } finally {
      if (moved) process.chdir(cwd);
    }
  };

  let api: import("@devbi/server").ApiHandler | undefined;
  const apiHandler = async () => {
    if (!api) {
      const { createApiHandler, loadEnv } = await import("@devbi/server");
      api = createApiHandler({ dir, env: options.env ?? loadEnv(dir), exposeErrors: true });
    }
    return api;
  };

  const insert = (table: arrow.Table, name: string) => {
    if (table.numRows === 0) {
      const cols = table.schema.fields.map((f) => `${ident(f.name)} ${duckType(f.type)}`);
      sql(`CREATE TABLE ${ident(name)} (${cols.join(", ")})`);
    } else {
      // As IPC bytes: this module's Arrow may be another copy than DuckDB-wasm's own.
      conn.insertArrowFromIPCStream(arrow.tableToIPC(table, "stream"), { name, create: true });
    }
  };

  const readXlsxFile = async (file: string, args: { sheet?: string; range?: string; header?: boolean; allVarchar?: boolean }) =>
    readXlsx(await readFile(path.join(dir, file)), args);

  const registered = new Set<string>();
  const register = async (file: string) => {
    if (registered.has(file)) return;
    if (file.includes("*")) throw new Error(`ブラウザではファイル名のワイルドカードは使えません: ${file}`);
    db.registerFileBuffer(file, await readFile(path.join(dir, file)));
    registered.add(file);
  };

  let seq = 0;
  const views = new Map<string, Promise<string>>();

  const loadView = async (view: MetricsView): Promise<string> => {
    let model = view.model;
    for (const s of [...scanSources(model)].reverse()) {
      if (s.format === "api") {
        const handler = await apiHandler();
        let bytes: Uint8Array;
        try {
          ({ bytes } = await handler.run(s.path, apiParams(s)));
        } catch (e) {
          const message = (e as Error).message;
          // No database to read: the dashboards that use it are checked on devbi-serve, not here.
          if (/接続先がありません/.test(message)) throw new NotChecked(`API の ${s.path} を読んでいません: ${message}`);
          throw new Error(`API の ${s.path}（api/${s.path}.sql）: ${message}`);
        }
        const name = `__devbi_src_${++seq}`;
        insert(arrow.tableFromIPC(bytes), name);
        model = `${model.slice(0, s.start)}${ident(name)}${model.slice(s.end)}`;
        continue;
      }
      if (hasUrlScheme(s.path)) throw new NotChecked(`ネットの上のファイル ${s.path} は読んでいません`);
      if (s.format === "xlsx") {
        const table = await readXlsxFile(s.path, {
          ...(s.args.sheet ? { sheet: unquoteString(s.args.sheet) ?? s.args.sheet } : {}),
          ...(s.args.range ? { range: unquoteString(s.args.range) ?? s.args.range } : {}),
          header: s.args.header === undefined ? true : !/^(false|0)$/i.test(s.args.header),
          allVarchar: s.args.all_varchar !== undefined && !/^(false|0)$/i.test(s.args.all_varchar),
        });
        const name = `__devbi_src_${++seq}`;
        insert(xlsxToArrow(table), name);
        model = `${model.slice(0, s.start)}${ident(name)}${model.slice(s.end)}`;
      } else {
        await register(s.path);
      }
    }
    const table = ident(`__devbi_model_${view.name}`);
    sql(`CREATE OR REPLACE TABLE ${table} AS\n${model}`);
    return `SELECT * FROM ${table}`;
  };

  const query = (text: string) => {
    const table = sql(text);
    const fields = table.schema.fields;
    const out: Record<string, unknown>[] = [];
    for (let r = 0; r < table.numRows; r++) {
      const row: Record<string, unknown> = {};
      fields.forEach((f, i) => (row[f.name] = plain(table.getChildAt(i)?.get(r), f.type)));
      out.push(row);
    }
    return out;
  };

  return {
    query,
    loadView(view) {
      let p = views.get(view.name);
      if (!p) {
        p = loadView(view);
        views.set(view.name, p);
      }
      return p;
    },
    async loadFile(file, opts = {}) {
      const name = `__devbi_file_${++seq}`;
      const bytes = await readFile(path.resolve(dir, file));
      if (/\.xlsx$/i.test(file)) {
        const table = await readXlsx(bytes, { ...(opts.sheet ? { sheet: opts.sheet } : {}), ...(opts.range ? { range: opts.range } : {}) });
        insert(xlsxToArrow(table), name);
        return { table: ident(name), ...(table.range ? { range: table.range } : {}) };
      } else {
        // Under a name of its own: the file may be outside the project.
        const virtual = `${name}${path.extname(file)}`;
        db.registerFileBuffer(virtual, bytes);
        const fn = /\.parquet$/i.test(file)
          ? "read_parquet"
          : /\.(arrow|arrows|feather)$/i.test(file)
            ? "read_arrow"
            : /\.(json|ndjson|jsonl)$/i.test(file)
              ? "read_json_auto"
              : "read_csv_auto";
        sql(`CREATE TABLE ${ident(name)} AS SELECT * FROM ${fn}('${virtual}')`);
      }
      return { table: ident(name) };
    },
    close() {
      conn.close();
      api?.close().catch(() => undefined);
      rmSync(empty, { recursive: true, force: true });
    },
  };
}
