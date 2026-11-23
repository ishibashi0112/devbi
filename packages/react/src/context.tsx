import type * as arrow from "apache-arrow";
import {
  compileMalloy,
  compileQuery,
  compileRows,
  compileSource,
  compileTimeExtent,
  customFields,
  customMainView,
  customQuery,
  customTable,
  customViews,
  QueryError,
  sqlColumns,
  withSources,
  formatValue,
  getDimension,
  getMeasure,
  type Dashboard,
  type FieldInfo,
  type Filter,
  type MetricsView,
  type ParamValue,
  type Query,
  type ResultColumn,
  type Row,
} from "devbi";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ApiOptions, Engine } from "./engine.js";
import { loadChunk } from "./chunk.js";
import type { DatasetResult } from "./dataset.js";
import { createEngine } from "./load-engine.js";
import { DashboardParams, ParamsNeeded, ParamsWaiting } from "./param-store.js";
import type { Project } from "./project.js";
import { DashboardSelection } from "./selection.js";

export interface DevbiContextValue {
  project: Project;
  dashboard: Dashboard & { path: string };
  /**
   * The page's DuckDB engine (for the metrics files). Started the first time it is asked for: a dashboard whose tiles
   * read only datasets never loads DuckDB-wasm.
   */
  readonly engine: Promise<Engine>;
  selection: DashboardSelection;
  /** The dashboard's parameters (the bar above the tiles) and their values. */
  params: DashboardParams;
  /** The rows of a dataset (`api/<name>.sql`) with these parameter values: the last few are kept until 更新. */
  readDataset(name: string, params: Record<string, ParamValue>): Promise<DatasetResult>;
  /** 更新: read the datasets again (the tiles and the choices). */
  refresh(): void;
  /** The metrics view a query uses (its own `metrics`, else the dashboard's, else the only one). */
  view(name?: string): MetricsView;
}

/** How many dataset results a dashboard keeps (a result may be a million rows). */
const KEPT_RESULTS = 5;

const Ctx = createContext<DevbiContextValue | null>(null);

const engines = new Map<string, Promise<Engine>>();

/**
 * One engine per page and project (DuckDB bundle and data folder), shared by every dashboard. Each dashboard's
 * API location and fetch go with its views (`loadView(view, { apiUrl, fetch })`), not with the engine.
 */
export function getEngine(project: Project): Promise<Engine> {
  const key = `${project.duckdb.mainModule}|${project.baseUrl}|${project.extensionRepository ?? ""}`;
  let e = engines.get(key);
  if (!e) {
    e = createEngine({
      bundle: project.duckdb,
      baseUrl: project.baseUrl,
      snapshots: project.snapshots,
      ...(project.extensionRepository ? { extensionRepository: project.extensionRepository } : {}),
    });
    engines.set(key, e);
    e.catch(() => engines.delete(key));
  }
  return e;
}

/**
 * The page's engine as the dashboard sees it: `loadView(view)` reads `read_api` from the dashboard's API with its
 * fetch (the project's `apiUrl` and `fetch`), also for promoted tiles that call `useDevbi().engine` themselves.
 */
function forDashboard(engine: Engine, project: Project): Engine {
  const api: ApiOptions = { ...(project.apiUrl ? { apiUrl: project.apiUrl } : {}), ...(project.fetch ? { fetch: project.fetch } : {}) };
  if (!api.apiUrl && !api.fetch) return engine;
  return {
    ...engine,
    loadView: (view, options) => engine.loadView(view, options ?? api),
    snapshotsOf: (view, options) => engine.snapshotsOf(view, options ?? api),
  };
}

/** The API's folder for a project (`<apiUrl>query`), absolute. */
function apiFolder(project: Project): { apiUrl: string; baseUrl: string } {
  const base = new URL(project.baseUrl ?? "./", document.baseURI);
  // A folder: "/reports/api" means "/reports/api/".
  return { apiUrl: new URL((project.apiUrl ?? "api/").replace(/([^/])$/, "$1/"), base).href, baseUrl: base.href };
}

export function DevbiProvider({
  project,
  dashboard,
  params,
  children,
}: {
  project: Project;
  dashboard: Dashboard & { path: string };
  /**
   * The values the parameters start with (the URL's, the embed's, React's `params`), checked against their types.
   * Read when the store is made: later values go to the store (Dashboard's effect); a store made again (another
   * project or dashboard) starts with the values given then.
   */
  params?: Record<string, ParamValue>;
  children: ReactNode;
}) {
  const first = useRef(params);
  first.current = params;
  const value = useMemo<DevbiContextValue>(() => {
    const selection = new DashboardSelection();
    const view = (name?: string) => {
      const n = name ?? dashboard.metrics ?? (Object.keys(project.metrics).length === 1 ? Object.keys(project.metrics)[0] : undefined);
      if (!n) throw new Error(`${dashboard.path}: 使う指標ファイルを "metrics" に書いてください`);
      const v = Object.hasOwn(project.metrics, n) ? project.metrics[n] : undefined;
      if (!v) throw new Error(`指標ファイル models/${n}.metrics.yaml がありません`);
      return v;
    };
    let engine: Promise<Engine> | undefined;
    const results = new Map<string, Promise<DatasetResult>>();
    const readDataset = (name: string, values: Record<string, ParamValue>): Promise<DatasetResult> => {
      const k = JSON.stringify([name, values]);
      let p = results.get(k);
      if (p) {
        // the most recent last
        results.delete(k);
        results.set(k, p);
        return p;
      }
      const info = Object.hasOwn(project.datasets, name) ? project.datasets[name] : undefined;
      p = loadChunk(() => import("./dataset.js")).then((m) =>
        m.readDataset({
          name,
          params: values,
          ...apiFolder(project),
          fetch: project.fetch ?? fetch.bind(globalThis),
          ...(info?.key ? { key: info.key } : {}),
        }),
      );
      results.set(k, p);
      p.catch(() => results.delete(k));
      while (results.size > KEPT_RESULTS) results.delete(results.keys().next().value!);
      return p;
    };
    const store = new DashboardParams(dashboard, project.datasets, readDataset, first.current ?? {});
    return {
      project,
      dashboard,
      get engine() {
        return (engine ??= getEngine(project).then((e) => forDashboard(e, project)));
      },
      selection,
      params: store,
      readDataset,
      refresh() {
        results.clear();
        store.refresh();
      },
      view,
    };
  }, [project, dashboard]);
  // The choices (and `default=all`) are read once the dashboard is on the page, with or without the bar (the GUI
  // editor's preview has none).
  useEffect(() => value.params.start(), [value]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDevbi(): DevbiContextValue {
  const c = useContext(Ctx);
  if (!c) throw new Error("DevBI のタイルは <Dashboard> の中で使ってください");
  return c;
}

/** Re-render when any selection changes. */
export function useSelectionVersion(): number {
  const { selection } = useDevbi();
  return useSyncExternalStore(selection.subscribe, selection.getVersion, selection.getVersion);
}

/** Re-render when a parameter's value or choices change. */
export function useParamsVersion(): number {
  const { params } = useDevbi();
  return useSyncExternalStore(params.subscribe, params.getVersion, params.getVersion);
}

/** The dataset a query reads: its info, or an error that names the missing file. */
function datasetOf(ctx: DevbiContextValue, name: string) {
  const info = Object.hasOwn(ctx.project.datasets, name) ? ctx.project.datasets[name] : undefined;
  if (!info) throw new QueryError(`データセット ${name} がありません（api/${name}.sql）`);
  return info;
}

/** The rows of a dataset tile, with the dashboard's parameters. */
async function runDataset(ctx: DevbiContextValue, query: Query): Promise<{ rows: Row[]; fields: FieldInfo[] }> {
  const info = datasetOf(ctx, query.dataset!);
  const req = ctx.params.request(query, info);
  if ("missing" in req) throw new ParamsNeeded(req.missing);
  if ("waiting" in req) throw new ParamsWaiting();
  if ("error" in req) throw new QueryError(req.error);
  const { rows, fields } = await ctx.readDataset(query.dataset!, req.params);
  return { rows, fields };
}

export interface QueryState {
  rows: Row[];
  fields: FieldInfo[];
  /** Filters from other tiles that applied to these rows. */
  filters: Filter[];
  loading: boolean;
  error: Error | null;
}

/** The fields of a view that selections are on: its dimensions and its time. */
function viewFields(view: MetricsView): Set<string> {
  return new Set([...Object.keys(view.dimensions), ...(view.time ? [view.time.name] : [])]);
}

/** The metrics views a query reads: its own (or the dashboard's); for Malloy or SQL, the ones it names. */
function viewsOfQuery(ctx: DevbiContextValue, query: Query): MetricsView[] {
  if (query.dataset !== undefined) return [];
  if (!customQuery(query)) return [ctx.view(query.metrics)];
  return customViews(query, Object.keys(ctx.project.metrics)).map((n) => ctx.project.metrics[n]!);
}

/**
 * The view a query's fields are of (labels, formats, what a click selects): its own (or the dashboard's); for Malloy
 * or SQL, its `metrics` or the only view it reads (none when it reads two or more without `metrics`).
 */
export function queryView(ctx: DevbiContextValue, query: Query | null | undefined): MetricsView | undefined {
  // A dataset's columns are its own (no metrics file's labels or formats).
  if (query?.dataset !== undefined) return undefined;
  try {
    if (!customQuery(query)) return ctx.view(query?.metrics);
    const main = customMainView(query!, customViews(query!, Object.keys(ctx.project.metrics)));
    return main ? ctx.view(main) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The selections that apply to a tile's query: every other tile's, on fields of the query's metrics view (a view
 * without that field is not filtered by it), but not on its time column with `period: false`. None when the query's
 * view is missing (the query reports that).
 */
export function crossFilters(ctx: DevbiContextValue, query: Query, tileId: string | undefined): Filter[] {
  let views: MetricsView[];
  try {
    views = viewsOfQuery(ctx, query);
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const view of views) {
    const own = viewFields(view);
    // `period: false`: not the period (the date-range tile, a clicked time bucket).
    if (query.period === false && view.time) own.delete(view.time.name);
    for (const n of own) names.add(n);
  }
  return ctx.selection.filtersFor(tileId).filter((f) => names.has(f.field));
}

/** Run a query on the dashboard's data with these filters (from {@link crossFilters}) besides its own. */
export async function runQuery(ctx: DevbiContextValue, query: Query, filters: Filter[]): Promise<{ rows: Row[]; fields: FieldInfo[] }> {
  if (query.dataset !== undefined) return runDataset(ctx, query);
  if (customQuery(query)) return runCustom(ctx, query, filters);
  const view = ctx.view(query.metrics);
  const engine = await ctx.engine;
  const model = await engine.loadView(view);
  const { sql, fields } = compileQuery(view, query, { filters, model });
  const { rows } = await engine.query(sql);
  return { rows, fields };
}

/** Malloy compiled to SQL, by its text and its sources' columns (the same for any filters). */
const malloyCache = new Map<string, Promise<{ sql: string; columns: ResultColumn[] }>>();

/** The columns of a SELECT and their DuckDB types. */
async function describe(engine: Engine, sql: string): Promise<Record<string, string>> {
  const { rows } = await engine.query(`DESCRIBE SELECT * FROM (\n${sql}\n)`);
  return Object.fromEntries(rows.map((r) => [String(r.column_name), String(r.column_type)]));
}

/**
 * A query written in Malloy or SQL: the rows of each view it names (the period and the selections that apply to that
 * view, and its own `filters` on its main view) in front of it as CTEs, Malloy compiled to SQL first.
 */
async function runCustom(ctx: DevbiContextValue, query: Query, filters: Filter[]): Promise<{ rows: Row[]; fields: FieldInfo[] }> {
  const custom = customQuery(query)!;
  const lang = custom.lang === "sql" ? "SQL" : "Malloy";
  if (query.metrics) ctx.view(query.metrics); // a name that is not a metrics file says so
  const names = customViews(query, Object.keys(ctx.project.metrics));
  if (!names.length) {
    const how = custom.lang === "sql" ? "FROM sales" : "run: sales -> { … }";
    throw new QueryError(`${lang} のクエリが指標ファイルを読んでいません（${how} のように、models/<名前>.metrics.yaml の名前で読みます）`);
  }
  const main = customMainView(query, names);
  if (query.filters?.length && !main)
    throw new QueryError("2 つ以上の指標ファイルを読むクエリの filters は、metrics でどの指標ファイルかを書いてください");
  const engine = await ctx.engine;
  const sources = await Promise.all(
    names.map(async (name) => {
      const view = ctx.project.metrics[name]!;
      const model = await engine.loadView(view);
      const columns = Object.keys(await describe(engine, model));
      const fields = viewFields(view);
      const own = name === main ? (query.filters ?? []) : [];
      for (const f of own) if (!fields.has(f.field)) throw new QueryError(`フィルタの ${f.field} は ${view.name} の軸にありません`);
      const schema = custom.lang === "malloy" ? await describe(engine, compileSource(view, { model, columns })) : {};
      const sql = compileSource(view, { model, columns, filters: [...own, ...filters.filter((f) => fields.has(f.field))] });
      return { name, sql, schema };
    }),
  );
  let sql = custom.text;
  let columns: ResultColumn[] | undefined;
  if (custom.lang === "malloy") {
    const input = sources.map((s) => ({ name: s.name, table: customTable("malloy", s.name), schema: s.schema }));
    const key = JSON.stringify([custom.text, input]);
    let compiled = malloyCache.get(key);
    if (!compiled) {
      compiled = compileMalloy(custom.text, input);
      malloyCache.set(key, compiled);
      compiled.catch(() => malloyCache.delete(key));
      if (malloyCache.size > 100) malloyCache.delete(malloyCache.keys().next().value!);
    }
    ({ sql, columns } = await compiled);
  }
  let result: Awaited<ReturnType<Engine["query"]>>;
  try {
    result = await engine.query(
      withSources(
        sql,
        sources.map((s) => ({ table: customTable(custom.lang, s.name), sql: s.sql })),
      ),
    );
  } catch (e) {
    throw new QueryError(`${lang}: ${(e instanceof Error ? e.message : String(e)).replace(/\n+LINE \d+:[\s\S]*$/, "").trim()}`);
  }
  columns ??= sqlColumns(result.table.schema.fields.map((f) => ({ name: f.name, type: String(f.type) })));
  const { names: out, fields } = customFields(custom.lang, columns, main ? ctx.project.metrics[main] : undefined);
  const rows = result.rows.map((r) => Object.fromEntries(columns.map((c, i) => [out[i]!, r[c.name] ?? null])));
  return { rows, fields };
}

/**
 * Run a query against the dashboard's data, cross-filtered by every tile except `tileId`.
 * Pass `crossfilter: false` to ignore selections. Promoted tiles can use this for extra queries.
 */
export function useDevbiQuery(query: Query | null | undefined, options: { tileId?: string; crossfilter?: boolean } = {}): QueryState {
  const ctx = useDevbi();
  const version = useSelectionVersion();
  const { tileId, crossfilter = true } = options;
  const hasQuery = !!query;
  const filters = useMemo(
    () => (hasQuery && crossfilter ? crossFilters(ctx, query, tileId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, tileId, crossfilter, hasQuery, query?.metrics, query?.period, query?.malloy, query?.sql, ctx],
  );
  // A dataset tile: what it sends with the parameters' values now (and 更新).
  const paramsVersion = useParamsVersion();
  const request = useMemo(() => {
    if (query?.dataset === undefined) return null;
    try {
      return [ctx.params.request(query, datasetOf(ctx, query.dataset)), ctx.params.refreshes];
    } catch (e) {
      return (e as Error).message;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsVersion, query?.dataset, query?.params, ctx]);
  const key = JSON.stringify([query ?? null, filters, request]);
  const [state, setState] = useState<QueryState>({ rows: [], fields: [], filters: [], loading: !!query, error: null });
  const seq = useRef(0);
  useEffect(() => {
    // Bump on every change, including to "no query", so an earlier fetch still in flight cannot write its result.
    const mine = ++seq.current;
    if (!query) {
      setState({ rows: [], fields: [], filters: [], loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    runQuery(ctx, query, filters).then(
      ({ rows, fields }) => {
        if (seq.current === mine) setState({ rows, fields, filters, loading: false, error: null });
      },
      (e: unknown) => {
        if (seq.current !== mine) return;
        // Waiting for the choices (default=all): still loading. Parameters to fill in: no rows (the tile says which).
        if (e instanceof ParamsWaiting) return;
        if (e instanceof ParamsNeeded) setState({ rows: [], fields: [], filters, loading: false, error: e });
        else setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e : new Error(String(e)) }));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ctx]);
  return state;
}

export interface RowsState {
  /** The model's rows (at most `limit`), as DuckDB returned them. */
  table: arrow.Table | null;
  limit: number;
  /** There were more rows than `limit`. */
  truncated: boolean;
  /** The rows are the newest ones (the view has a time column); else the first by every column. */
  newest: boolean;
  /** Filters from other tiles that applied to these rows. */
  filters: Filter[];
  loading: boolean;
  error: Error | null;
}

/**
 * The rows of the query's metrics view as they are (every column of its model), filtered by the query's `filters` and
 * the selections of every tile except `tileId`: the data of the `explore` tile.
 */
export function useDevbiRows(query: Query, options: { tileId?: string } = {}): RowsState {
  const ctx = useDevbi();
  const version = useSelectionVersion();
  const { tileId } = options;
  const filters = useMemo(
    () => crossFilters(ctx, query, tileId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, tileId, query.metrics, query.period, ctx],
  );
  const key = JSON.stringify([query, filters]);
  const [state, setState] = useState<RowsState>({
    table: null,
    limit: 0,
    truncated: false,
    newest: true,
    filters: [],
    loading: true,
    error: null,
  });
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    (async () => {
      const view = ctx.view(query.metrics);
      const engine = await ctx.engine;
      const model = await engine.loadView(view);
      const { sql, limit, newest } = compileRows(view, query, { filters, model });
      const table = await engine.table(sql);
      const truncated = table.numRows > limit;
      return { table: truncated ? table.slice(0, limit) : table, limit, truncated, newest };
    })().then(
      (r) => {
        if (seq.current === mine) setState({ ...r, filters, loading: false, error: null });
      },
      (e: unknown) => {
        if (seq.current === mine) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e : new Error(String(e)) }));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ctx]);
  return state;
}

/** Earliest and latest value of the time column (ignores selections). */
export function useTimeExtent(metrics?: string): { min: Date | null; max: Date | null; error: Error | null } {
  const ctx = useDevbi();
  const [state, setState] = useState<{ min: Date | null; max: Date | null; error: Error | null }>({ min: null, max: null, error: null });
  useEffect(() => {
    let live = true;
    (async () => {
      const view = ctx.view(metrics);
      const engine = await ctx.engine;
      const model = await engine.loadView(view);
      const { rows } = await engine.query(compileTimeExtent(view, { model }));
      const r = rows[0] ?? {};
      if (live) setState({ min: (r.min as Date) ?? null, max: (r.max as Date) ?? null, error: null });
    })().catch((e: unknown) => live && setState({ min: null, max: null, error: e instanceof Error ? e : new Error(String(e)) }));
    return () => {
      live = false;
    };
  }, [ctx, metrics]);
  return state;
}

/** Look up a field's display info in a result or its metrics view. */
export function fieldInfo(view: MetricsView, fields: FieldInfo[], name: string): Partial<FieldInfo> & { label: string } {
  const f = fields.find((x) => x.name === name);
  if (f) return f;
  const d = getDimension(view, name);
  if (d) return { name, label: d.label, kind: "dimension", ...(d.format ? { format: d.format } : {}) };
  const m = getMeasure(view, name);
  if (m) return { name, label: m.label, kind: "measure", ...(m.format ? { format: m.format } : {}) };
  if (view.time?.name === name) return { name, label: view.time.label, kind: "time" };
  return { name, label: name };
}

export function makeFormatters(view: MetricsView | undefined, fields: FieldInfo[]) {
  const fy = view?.time?.fiscalYearStart ?? 1;
  const info = (name: string) => (view ? fieldInfo(view, fields, name) : (fields.find((f) => f.name === name) ?? { label: name }));
  return {
    format: (value: unknown, field: string) => formatValue(value, info(field) as FieldInfo, fy),
    label: (field: string) => info(field).label,
  };
}
