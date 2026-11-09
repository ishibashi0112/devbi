import * as duckdb from "@duckdb/duckdb-wasm";
import * as arrow from "apache-arrow";
import { tableToRows } from "./arrow-rows.js";
import { apiCalls, apiParams, hasUrlScheme, ident, readXlsx, scanSources, snapshotFile, unquoteString, type MetricsView, type Row, type SourceRef, type XlsxTable } from "devbi";

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
  /**
   * The API's SQL files read from a snapshot, with their times of day: `read_api('<name>', …)` reads
   * `snapshots/<file>.arrows` under `baseUrl` (a static file, made by devbi-serve or devbi-snapshot).
   */
  snapshots?: Record<string, string[]>;
  debug?: boolean;
}

/** A snapshot a view read: which, when it was made, and its times of day. */
export interface SnapshotInfo {
  name: string;
  file: string;
  /** When the file was made (its Last-Modified). */
  at: Date;
  times: string[];
}

export interface QueryResult {
  rows: Row[];
  table: arrow.Table;
}

export interface Engine {
  /** Run SQL and return rows as plain objects (dates as Date, numbers as number). */
  query(sql: string): Promise<QueryResult>;
  /** Run SQL and return the Arrow table only (many rows: the `explore` tile). Not cached. */
  table(sql: string): Promise<arrow.Table>;
  /**
   * Load a metrics view's data: register or read the files its model SQL reads,
   * materialize the model as a table, and return SQL selecting from it.
   */
  loadView(view: MetricsView, api?: ApiOptions): Promise<string>;
  /** The snapshots a view reads (none when it reads the API directly or files), once it has loaded. */
  snapshotsOf(view: MetricsView, api?: ApiOptions): Promise<SnapshotInfo[]>;
  close(): Promise<void>;
}

/** Where `read_api` reads from, per view (dashboards on one page may use different APIs and share the engine). */
export interface ApiOptions {
  /** Default: the engine's `apiUrl`. */
  apiUrl?: string;
  /** Default: the engine's `fetch`. */
  fetch?: typeof fetch;
}

function workerUrl(url: string): string {
  const abs = new URL(url, document.baseURI);
  if (abs.origin === location.origin) return abs.href;
  // A worker script on another origin (a CDN) must be loaded through a same-origin blob.
  return URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(abs.href)});`], { type: "text/javascript" }));
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
  const apiFolder = (url: string | undefined) => new URL((url ?? "api/").replace(/([^/])$/, "$1/"), base).href;
  const defaultApi = apiFolder(options.apiUrl);
  const defaultFetch = options.fetch ?? fetch.bind(globalThis);

  const snapshotTimes = options.snapshots ?? {};
  const madeAt = new Map<string, Date>();

  // Rows from the read-only API (api/<name>.sql on the server), as a table named `name`. A snapshot is a static
  // file next to the data instead (the same Arrow as the API's answer).
  const loadApi = async (s: SourceRef, name: string, apiUrl: string, doFetch: typeof fetch) => {
    const params = apiParams(s);
    let snapshot = Object.hasOwn(snapshotTimes, s.path) ? snapshotFile(s.path, params) : undefined;
    const query = () =>
      doFetch(new URL("query", apiUrl).href, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/vnd.apache.arrow.stream" },
        body: JSON.stringify({ name: s.path, params }),
      });
    // A page (index.html) where a file was asked for: a site that answers every path with its page.
    const isPage = (r: Response) => /^text\/html\b/i.test(r.headers.get("Content-Type") ?? "");
    let res: Response;
    if (snapshot) {
      // no-cache: asked again each time (a 304 when unchanged), or a browser keeps yesterday's file for hours
      // when the server (IIS) sends no Cache-Control.
      res = await doFetch(new URL(`snapshots/${encodeURIComponent(snapshot)}`, base).href, {
        cache: "no-cache",
        headers: { Accept: "application/vnd.apache.arrow.stream" },
      });
      if (res.status === 404 || (res.ok && isPage(res))) {
        // Not made yet on a static site, or no longer a snapshot on the server (its SQL or models/ changed after
        // this page was built): read the API as it is now, when there is one.
        const live = await query().catch(() => undefined);
        if (!live || live.status === 404 || live.status === 405 || (live.ok && isPage(live))) {
          throw new Error(
            `${s.path} のスナップショット（snapshots/${snapshot}）がありません。サーバーで devbi-snapshot を実行するか、devbi-serve が作るのを待ってください`,
          );
        }
        res = live;
        snapshot = undefined;
      }
    } else {
      res = await query();
    }
    if (!res.ok) {
      const error = await res
        .json()
        .then((b: { error?: string }) => b.error)
        .catch(() => undefined);
      if (snapshot) throw new Error(`${s.path} のスナップショットを読めません（${res.status}）${error ? `: ${error}` : ""}`);
      throw new Error(`API の ${s.path} を読めません（${res.status}）${error ? `: ${error}` : ""}`);
    }
    if (snapshot) {
      const modified = Date.parse(res.headers.get("Last-Modified") ?? "");
      madeAt.set(snapshot, Number.isFinite(modified) ? new Date(modified) : new Date());
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
  let modelSeq = 0;
  const fetchIds = new Map<typeof fetch, number>();
  const fetchId = (f: typeof fetch) => fetchIds.get(f) ?? (fetchIds.set(f, fetchIds.size + 1), fetchIds.size);

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

  const loadView = async (view: MetricsView, apiUrl: string, doFetch: typeof fetch, table: string): Promise<string> => {
    let sql = view.model;
    const sources = scanSources(sql);
    // Replace from the end so earlier offsets stay valid.
    for (const s of [...sources].reverse()) {
      if (s.format === "api") {
        const name = `__devbi_src_${++sourceSeq}`;
        await loadApi(s, name, apiUrl, doFetch);
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
    await conn.query(`CREATE OR REPLACE TABLE ${table} AS\n${sql}`);
    return `SELECT * FROM ${table}`;
  };

  const engine: Engine = {
    query,
    table: (sql) => conn.query(sql),
    async snapshotsOf(view, api) {
      if (Object.keys(snapshotTimes).length === 0) return [];
      const used = apiCalls(view.model).filter((c) => Object.hasOwn(snapshotTimes, c.name));
      if (used.length === 0) return [];
      await engine.loadView(view, api);
      return used.flatMap((c) => {
        const file = snapshotFile(c.name, c.params);
        const at = madeAt.get(file);
        return at ? [{ name: c.name, file, at, times: snapshotTimes[c.name]! }] : [];
      });
    },
    loadView(view, api = {}) {
      // Once per view and API (and fetch): a view that reads no API is the same whichever API the dashboard uses.
      const apiUrl = api.apiUrl ? apiFolder(api.apiUrl) : defaultApi;
      const doFetch = api.fetch ?? defaultFetch;
      const readsApi = scanSources(view.model).some((s) => s.format === "api");
      const own = readsApi && (apiUrl !== defaultApi || doFetch !== defaultFetch);
      const key = own ? `${view.name}\n${apiUrl}\n${fetchId(doFetch)}` : view.name;
      let p = views.get(key);
      if (!p) {
        // Another prefix for the API-specific copies, so no view's own name can give the same table name.
        const table = ident(key === view.name ? `__devbi_model_${view.name}` : `__devbi_apimodel_${++modelSeq}_${view.name}`);
        p = loadView(view, apiUrl, doFetch, table);
        views.set(key, p);
        p.catch(() => views.delete(key));
      }
      return p;
    },
    async close() {
      await conn.close();
      await db.terminate();
      worker.terminate();
    },
  };
  return engine;
}
