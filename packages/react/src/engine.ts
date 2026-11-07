import * as duckdb from "@duckdb/duckdb-wasm";
import * as arrow from "apache-arrow";
import { apiParams, hasUrlScheme, ident, readXlsx, scanSources, unquoteString, type MetricsView, type Row, type SourceRef, type XlsxTable } from "devbi";

export interface DuckDBBundle {
  /** URL of `duckdb-base.wasm`. */
  mainModule: string;
  /** URL of `duckdb-browser-base.worker.js`. */
  mainWorker: string;
}

export interface EngineOptions {
  bundle: DuckDBBundle;
  /** Base URL that data paths in model SQL (`data/sales.csv`) are resolved against. */
  baseUrl?: string;
  /**
   * Where DuckDB loads extensions (e.g. parquet) from. Defaults to extensions.duckdb.org.
   * Point it at a copy on your own server when the browser cannot reach the internet.
   */
  extensionRepository?: string;
  /**
   * Where the read-only API is (`read_api('orders')` posts to `<apiUrl>query`). Default: `api/` next to the data
   * (`baseUrl`).
   */
  apiUrl?: string;
  /** Used for the API requests instead of the global `fetch`: to add a header, for example. */
  fetch?: typeof fetch;
  debug?: boolean;
}

export interface QueryResult {
  rows: Row[];
  table: arrow.Table;
}

export interface Engine {
  /** Run SQL and return rows as plain objects (dates as Date, numbers as number). */
  query(sql: string): Promise<QueryResult>;
  /**
   * Load a metrics view's data: register or read the files its model SQL reads,
   * materialize the model as a table, and return SQL selecting from it.
   */
  loadView(view: MetricsView): Promise<string>;
  close(): Promise<void>;
}

function workerUrl(url: string): string {
  const abs = new URL(url, document.baseURI);
  if (abs.origin === location.origin) return abs.href;
  // A worker script on another origin (a CDN) must be loaded through a same-origin blob.
  return URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(abs.href)});`], { type: "text/javascript" }));
}

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

/** DuckDB's type for an Arrow column, to create the table when the API returns no rows. */
function duckType(type: arrow.DataType): string {
  // No type to go by (an expression with no rows): DuckDB's NULL type, which SUM(), comparisons and the rest take.
  if (arrow.DataType.isNull(type)) return '"NULL"';
  if (arrow.DataType.isInt(type)) return "BIGINT";
  if (arrow.DataType.isFloat(type) || arrow.DataType.isDecimal(type)) return "DOUBLE";
  if (arrow.DataType.isBool(type)) return "BOOLEAN";
  if (arrow.DataType.isDate(type)) return "DATE";
  if (arrow.DataType.isTimestamp(type)) return "TIMESTAMP";
  return "VARCHAR";
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`データを取得できません（${res.status}）: ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Start DuckDB-wasm in a worker (single-threaded bundle) and return an engine.
 * The wasm file is fetched once; the browser caches it like any other asset.
 */
export async function createEngine(options: EngineOptions): Promise<Engine> {
  const logger = options.debug ? new duckdb.ConsoleLogger() : new duckdb.VoidLogger();
  const worker = new Worker(workerUrl(options.bundle.mainWorker));
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(new URL(options.bundle.mainModule, document.baseURI).href);
  await db.open({
    query: { castBigIntToDouble: true, castDecimalToDouble: true },
    ...(options.extensionRepository ? { extensionRepository: options.extensionRepository } : {}),
  });
  const conn = await db.connect();
  const base = new URL(options.baseUrl ?? "./", document.baseURI);
  // A folder: "/reports/api" means "/reports/api/" (query is posted to <apiUrl>query).
  const apiUrl = new URL((options.apiUrl ?? "api/").replace(/([^/])$/, "$1/"), base);
  const doFetch = options.fetch ?? fetch.bind(globalThis);

  // Rows from the read-only API (api/<name>.sql on the server), as a table named `name`.
  const loadApi = async (s: SourceRef, name: string) => {
    const url = new URL("query", apiUrl).href;
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/vnd.apache.arrow.stream" },
      body: JSON.stringify({ name: s.path, params: apiParams(s) }),
    });
    if (!res.ok) {
      const error = await res
        .json()
        .then((b: { error?: string }) => b.error)
        .catch(() => undefined);
      throw new Error(`API の ${s.path} を読めません（${res.status}）${error ? `: ${error}` : ""}`);
    }
    const table = arrow.tableFromIPC(new Uint8Array(await res.arrayBuffer()));
    if (table.numRows === 0) {
      const cols = table.schema.fields.map((f) => `${ident(f.name)} ${duckType(f.type)}`);
      await conn.query(`CREATE TABLE ${ident(name)} (${cols.join(", ")})`);
    } else {
      await conn.insertArrowTable(table, { name, create: true });
    }
  };
  const registered = new Set<string>();
  const views = new Map<string, Promise<string>>();
  let sourceSeq = 0;

  // Data does not change while the page is open, so results are cached by SQL text.
  const cache = new Map<string, Promise<QueryResult>>();
  const query = (sql: string): Promise<QueryResult> => {
    let p = cache.get(sql);
    if (!p) {
      p = conn.query(sql).then((table) => ({ table, rows: tableToRows(table) }));
      cache.set(sql, p);
      p.catch(() => cache.delete(sql));
      if (cache.size > 300) cache.delete(cache.keys().next().value!);
    }
    return p;
  };

  const loadView = async (view: MetricsView): Promise<string> => {
    let sql = view.model;
    const sources = scanSources(sql);
    // Replace from the end so earlier offsets stay valid.
    for (const s of [...sources].reverse()) {
      if (s.format === "api") {
        const name = `__devbi_src_${++sourceSeq}`;
        await loadApi(s, name);
        sql = `${sql.slice(0, s.start)}${ident(name)}${sql.slice(s.end)}`;
        continue;
      }
      if (hasUrlScheme(s.path) && !/^https?:/i.test(s.path)) continue;
      const url = new URL(s.path, base).href;
      if (s.format === "xlsx") {
        const table = await readXlsx(await fetchBytes(url), {
          ...(s.args.sheet ? { sheet: unquoteString(s.args.sheet) ?? s.args.sheet } : {}),
          ...(s.args.range ? { range: unquoteString(s.args.range) ?? s.args.range } : {}),
          header: s.args.header === undefined ? true : !/^(false|0)$/i.test(s.args.header),
          allVarchar: s.args.all_varchar !== undefined && !/^(false|0)$/i.test(s.args.all_varchar),
        });
        const name = `__devbi_src_${++sourceSeq}`;
        await conn.insertArrowTable(xlsxToArrow(table), { name, create: true });
        sql = `${sql.slice(0, s.start)}${ident(name)}${sql.slice(s.end)}`;
      } else if (!registered.has(s.path)) {
        if (s.path.includes("*")) throw new Error(`ブラウザではファイル名のワイルドカードは使えません: ${s.path}`);
        await db.registerFileURL(s.path, url, duckdb.DuckDBDataProtocol.HTTP, false);
        registered.add(s.path);
      }
    }
    const table = ident(`__devbi_model_${view.name}`);
    await conn.query(`CREATE OR REPLACE TABLE ${table} AS\n${sql}`);
    return `SELECT * FROM ${table}`;
  };

  return {
    query,
    loadView(view) {
      let p = views.get(view.name);
      if (!p) {
        p = loadView(view);
        views.set(view.name, p);
        p.catch(() => views.delete(view.name));
      }
      return p;
    },
    async close() {
      await conn.close();
      await db.terminate();
      worker.terminate();
    },
  };
}
