// devbi-check: read a project's metrics and dashboard files and run what the browser would run on the data (each
// model, measure and dimension, and every tile's query), so mistakes show without opening the page. Made for the
// person and for an AI that writes the files: each problem names the file, the tile or name, and what to fix.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ApiHandler, DevBIUser, RowLevelMode } from "@devbi/server";
import * as arrow from "apache-arrow";
import {
  apiCalls,
  checkQuery,
  compileQuery,
  defaultRequests,
  scanSources,
  compileMalloy,
  compileRows,
  compileSource,
  compileTimeExtent,
  customFields,
  customMainView,
  customQuery,
  ROWS_CUSTOM,
  customTable,
  customViews,
  dashboardParams,
  tableColumnProblems,
  tableOptions,
  tileBindings,
  sqlColumns,
  withSources,
  componentProblem,
  dateRangePresets,
  DashboardError,
  DATE_RANGE_PRESETS,
  formatValue,
  MetricsError,
  parseDashboardJson,
  parseMetricsYaml,
  QueryError,
  resolveComponent,
  TILE_TYPES,
  type Dashboard,
  type FieldInfo,
  type Filter,
  type MetricsView,
  type Query,
  type ResultColumn,
  type TileSpec,
  type TileTypeInfo,
} from "devbi";
import type { ViteDevServer } from "vite";
import { askColumns, type Described } from "./describe.js";
import { dashboardProblems, datasetProblems, modelSources, readDatasets } from "./index.js";
import { createNodeEngine, duckdbMessage, fileHint, missingExtension, NotChecked, type NodeEngine } from "./node-engine.js";

export type Level = "error" | "warning";

export interface Finding {
  level: Level;
  /** Checked as these users of devUsers only (the others did not get it). */
  as?: string[];
  /** The file to change, relative to the project (`models/sales.metrics.yaml`). */
  file: string;
  message: string;
}

export interface ViewReport {
  /** The user of devUsers it was read as (row-level security). */
  as?: string;
  name: string;
  file: string;
  /** Rows of the model, when it ran. */
  rows?: number;
  measures: number;
  dimensions: number;
  /** Why it was not run (the API without a database, a URL). */
  notChecked?: string;
}

export interface TileReport {
  /** The user of devUsers it was read as (row-level security). */
  as?: string;
  dashboard: string;
  id: string;
  /** Rows of the tile's query, when it ran. */
  rows?: number;
  /** Why it has no row count: no data to read (markdown), its own data, or a problem. */
  note?: string;
  /** With `values`: its first rows as the screen shows them (`問い合わせ件数 150、前の期間 160`). */
  values?: string[];
}

export interface CheckReport {
  /** Why the project is in row-level mode (`api/orders.sql に :user. があるため`), when it is. */
  rowLevel?: string;
  /** The users of devUsers the data was read as (`--as`, or each of them). */
  as?: string[];
  /** `--url`: what the API there says (`api/schema`). */
  url?: { url: string; access: boolean; status: number; note: string };
  findings: Finding[];
  views: ViewReport[];
  tiles: TileReport[];
  /** The dashboards that could be read (names). */
  dashboards: string[];
  /**
   * The periods each dashboard's tiles ran in, when its date-range tiles start in one (`受注日 2026年10月（2026-10-01〜2026-10-30）`).
   * A period filters the tiles whose metrics file has its time column.
   */
  periods: Record<string, string[]>;
  /** Read as several users: the periods of each (they count from the latest date of that user's rows). `periods` is then empty. */
  periodsAs?: Record<string, Record<string, string[]>>;
}

export interface CheckOptions {
  /** Environment for the API's database (DEVBI_DB…). Default: the project's .env files and `process.env`. */
  env?: Record<string, string | undefined>;
  /** How many rows of each tile's result to keep in `values`, formatted as on the screen. Default 0. */
  values?: number;
  /**
   * Read the data as these users of devUsers (row-level security: `:user.` in api/*.sql): one (`--as`), or several,
   * each in turn, warning when SQL that filters by user gives them all the same rows.
   */
  users?: { name: string; user: DevBIUser }[];
  /** Where the site is (`--url https://intra/devbi/`): whether its API knows row-level security (`"access": 1`). */
  url?: string;
  /** For `url`: default the global fetch. */
  fetch?: typeof fetch;
}

/** Names of ordinary parameters that look meant for the signed-in user's value (the browser can change them). */
const USER_LIKE = /^(user_?id|userid|user_?name|username|login(_?id|_?name)?|account(_?id)?|e?mail|employee_?(id|no|number)|emp_?(id|no)|staff_?(id|no)|社員(番号|id|ID|コード)|ログイン(id|ID|名)?|ユーザー(id|ID|名)|利用者(id|ID)?)$/i;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));


/** SQL that needs a DuckDB extension that could not be downloaded is not checked, rather than called a mistake. */
const noExtension = (name: string) => `DuckDB の拡張 ${name} をインターネットから取ってこられないため確かめていません`;

/** What a built-in tile needs in its result, as the tile itself checks (packages/react/src/tiles). */
function shapeProblem(type: string, fields: FieldInfo[], options: Record<string, unknown> | undefined): string | undefined {
  const measures = fields.filter((f) => f.kind === "measure");
  const dims = fields.filter((f) => f.kind === "dimension");
  const time = fields.find((f) => f.kind === "time");
  switch (type) {
    case "kpi":
      return measures.length ? undefined : "kpi には measures が要ります";
    case "bar":
    case "line":
    case "area":
      return measures.length && (time || dims.length) ? undefined : `${type} には measures と、time か dimensions が要ります`;
    case "barlist":
      return measures.length && dims.length ? undefined : "barlist には dimensions と measures が一つずつ要ります";
    case "select":
      return dims.length ? undefined : "select には dimensions が一つ要ります";
    case "pivot": {
      const keys = fields.filter((f) => f.kind !== "measure");
      const columns = typeof options?.columns === "string" ? options.columns : keys[keys.length - 1]?.name;
      if (!measures.length) return "pivot には measures が要ります";
      if (!keys.some((k) => k.name === columns)) {
        return typeof options?.columns === "string"
          ? `pivot の options.columns「${options.columns}」が結果の列にありません（使える名前: ${keys.map((k) => k.name).join("・") || "なし"}）`
          : "pivot には列にする dimensions か time が要ります";
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** A row of the model as it is (`--values` for an explore tile): `受注日 2026-10-30、地域 関東、金額 12,340`. */
function rowText(row: Record<string, unknown>): string {
  const text = (v: unknown): string => {
    if (v === null || v === undefined) return "（空）";
    if (v instanceof Date)
      return v
        .toISOString()
        .replace(/T00:00:00\.000Z$/, "")
        .replace(/\.000Z$/, "")
        .replace("T", " ");
    if (typeof v === "number") return v.toLocaleString("en-US", { maximumFractionDigits: 6 });
    if (typeof v === "bigint") return v.toLocaleString("en-US");
    return String(v);
  };
  return Object.entries(row)
    .map(([k, v]) => `${k} ${text(v)}`)
    .join("、");
}

/** The names a view has, for a query that used one it does not have. */
function namesHint(view: MetricsView, text: string): string {
  const list = (names: string[]) => (names.length ? names.join("・") : "なし");
  if (/^指標 /.test(text)) return `（${view.name} の指標: ${list(Object.keys(view.measures))}）`;
  if (/^(軸|フィルタの) /.test(text)) {
    return `（${view.name} の軸: ${list(Object.keys(view.dimensions))}${view.time ? `、time: ${view.time.name}` : ""}）`;
  }
  return "";
}

/** Names a query uses (to skip a tile whose measure is already reported broken). */
function namesOf(view: MetricsView, query: Query): string[] {
  return [
    ...(query.measures ?? []),
    ...(query.dimensions ?? []),
    ...(query.time && view.time ? [view.time.name] : []),
    ...(query.filters ?? []).map((f) => f.field),
  ];
}

async function list(dir: string, suffix: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => f.endsWith(suffix)).sort();
}

/**
 * Check a DevBI project (the folder with `models/` and `dashboards/`): the files as the dev server reads them, then
 * the model SQL, each measure and dimension, and every tile's query run on the data with DuckDB (the browser's
 * DuckDB-wasm, in Node). Promoted tiles' `query` is read with Vite.
 */
export async function checkProject(dir: string, options: CheckOptions = {}): Promise<CheckReport> {
  const users = options.users ?? [];
  let report: CheckReport;
  if (users.length <= 1) {
    report = await checkOnce(dir, options, users[0]);
    if (users[0]) {
      report.as = [users[0].name];
      for (const v of report.views) v.as = users[0].name;
      for (const t of report.tiles) t.as = users[0].name;
    }
  } else {
    // Each user in turn; what all of them got is one finding, the rest say whose.
    const runs: { name: string; report: CheckReport }[] = [];
    for (const u of users) runs.push({ name: u.name, report: await checkOnce(dir, options, u) });
    const seen = new Map<string, { finding: Finding; names: Set<string> }>();
    for (const run of runs) {
      for (const f of run.report.findings) {
        const key = JSON.stringify([f.level, f.file, f.message]);
        const s = seen.get(key);
        if (s) s.names.add(run.name);
        else seen.set(key, { finding: f, names: new Set([run.name]) });
      }
    }
    const first = runs[0]!.report;
    report = {
      ...first,
      as: runs.map((r) => r.name),
      findings: [...seen.values()].map(({ finding, names }) => (names.size === runs.length ? finding : { ...finding, as: [...names] })),
      views: runs.flatMap((r) => r.report.views.map((v) => ({ ...v, as: r.name }))),
      tiles: runs.flatMap((r) => r.report.tiles.map((t) => ({ ...t, as: r.name }))),
      periods: {},
      periodsAs: Object.fromEntries(runs.map((r) => [r.name, r.report.periods])),
    };
    for (const f of await sameRows(dir, options, users)) report.findings.push(f);
  }
  if (options.url) report.findings.push(...(await checkUrl(options.url, report, options.fetch ?? fetch)));
  return report;
}

/**
 * SQL that filters by user (`:user.`) and gives every one of devUsers the same rows: maybe not filtered after all
 * (`SELECT :user.id AS 見ている人, …`). Run with the parameters the models and dashboards use as they open.
 */
async function sameRows(dir: string, options: CheckOptions, users: { name: string; user: DevBIUser }[]): Promise<Finding[]> {
  if (!existsSync(path.join(dir, "api"))) return [];
  const server = await import("@devbi/server");
  const env = options.env ?? server.loadEnv(dir);
  const requests = new Map<string, { name: string; params: Record<string, unknown> }>();
  const ask = (name: string, params: Record<string, unknown>) => {
    const key = JSON.stringify([name, Object.keys(params).sort().map((k) => [k, params[k]])]);
    if (!requests.has(key)) requests.set(key, { name, params });
  };
  const datasets: Record<string, import("devbi").DatasetInfo> = {};
  const filtering = new Set<string>();
  for (const name of await server.listDatasets(dir)) {
    try {
      const text = await server.readDatasetText(dir, name);
      const d = server.parseDataset(name, text, server.dialectOf(env[server.connectionVariable(server.connectionOf(text))] ?? ""));
      datasets[name] = { parameters: d.parameters, ...(d.key ? { key: d.key } : {}) };
      if (d.user?.length) {
        filtering.add(name);
        if (!d.params.length) ask(name, {});
      }
    } catch {
      // its own finding
    }
  }
  if (!filtering.size) return [];
  for (const f of await list(path.join(dir, "models"), ".metrics.yaml")) {
    try {
      const view = parseMetricsYaml(await readFile(path.join(dir, "models", f), "utf8"), f.slice(0, -".metrics.yaml".length), `models/${f}`);
      for (const call of apiCalls(view.model)) ask(call.name, call.params);
    } catch {
      // its own finding
    }
  }
  for (const f of await list(path.join(dir, "dashboards"), ".dash.json")) {
    try {
      const d = parseDashboardJson(await readFile(path.join(dir, "dashboards", f), "utf8"), f.slice(0, -".dash.json".length), `dashboards/${f}`);
      for (const r of defaultRequests(d, datasets)) ask(r.dataset, r.params);
    } catch {
      // its own finding
    }
  }
  const api = server.createApiHandler({ dir, env, exposeErrors: true });
  const out: Finding[] = [];
  try {
    const done = new Set<string>();
    for (const { name, params } of requests.values()) {
      if (!filtering.has(name) || done.has(name)) continue;
      const got: { name: string; rows: Cells }[] = [];
      for (const u of users) {
        try {
          const { bytes, rows } = await api.run(name, params, { user: u.user });
          // Everyone getting no rows says nothing about the filter (a period without data).
          if (rows) got.push({ name: u.name, rows: cellsOf(bytes) });
        } catch {
          // this user may not read it (403), or the database is away: not compared
        }
      }
      const read = got.map((g) => g.name);
      if (got.length >= 2 && sameButTheUser(got.map((g) => g.rows))) {
        done.add(name);
        out.push({
          level: "warning",
          file: `api/${name}.sql`,
          message: `devUsers の ${read.join("・")} に、同じ行を返しました（その人の値をくり返す列のほかは）。:user.… で行を絞っているか確かめてください（属性の値が同じ人どうしや、絞っても同じ行になるときは問題ありません）`,
        });
      }
    }
  } finally {
    await api.close();
  }
  return out;
}

type Cells = string[][];

/** A result's rows as text, column by column (JSON of each value; bigints and dates as their text). */
function cellsOf(bytes: Uint8Array): Cells {
  const table = arrow.tableFromIPC(bytes);
  const columns = table.schema.fields.map((f) => f.name);
  const text = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x)) ?? "null";
  return table.toArray().map((r: Record<string, unknown>) => columns.map((c) => text(r[c])));
}

/**
 * Whether users got the same rows but for columns that only repeat a value of the user (`SELECT :user.id AS 見ている人, …`
 * without a WHERE): the columns with one value in each user's rows and different values between users are left out,
 * and the rows compared in any order. Nothing left to compare (`SELECT COUNT(*) … WHERE region = :user.region`, a
 * number per user): not the same.
 */
function sameButTheUser(results: Cells[]): boolean {
  const width = results[0]!.length ? results[0]![0]!.length : 0;
  if (results.some((rows) => rows.some((r) => r.length !== width))) return false;
  const kept: number[] = [];
  for (let c = 0; c < width; c++) {
    const single = results.map((rows) => (rows.every((r) => r[c] === rows[0]![c]) ? rows[0]![c] : undefined));
    const echoed = single.every((v) => v !== undefined) && new Set(single).size > 1;
    if (!echoed) kept.push(c);
  }
  if (!kept.length) return false;
  const key = (rows: Cells) => JSON.stringify(rows.map((r) => JSON.stringify(kept.map((c) => r[c]))).sort());
  const first = key(results[0]!);
  return results.every((rows) => key(rows) === first);
}

/** `--url`: whether the API where the site is knows row-level security (`"access": 1` in api/schema). */
async function checkUrl(url: string, report: CheckReport, fetchFn: typeof fetch): Promise<Finding[]> {
  const base = url.endsWith("/") ? url : `${url}/`;
  const at = new URL("api/schema", base).href;
  const file = "--url";
  const level: Level = report.rowLevel ? "error" : "warning";
  let res: Response;
  try {
    res = await fetchFn(at, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    report.url = { url, access: false, status: 0, note: `つながりません: ${message(e)}` };
    return [{ level: "warning", file, message: `${at} につながりません（${message(e)}）。置いた先の API を確かめていません` }];
  }
  const body = (await res.json().catch(() => undefined)) as { access?: unknown; error?: unknown; user?: unknown } | undefined;
  if (res.ok && body?.access === 1) {
    // Asked without signing in: an API in row-level mode answers 401, or says whom it answers as (a server in front).
    if (report.rowLevel && !body.user) {
      report.url = { url, access: true, status: res.status, note: "行レベル制御を知っている API ですが、行レベルのモードで動いていません" };
      return [
        {
          level: "error",
          file,
          message: `${at} が、ログインしていない人に SQL の一覧を返しました。置いた先は行レベルのモードで動いていません（新しい api/*.sql を置いていない、ホストがログインした人を渡していない、など）。このままでは、だれにでも同じ行が返ります`,
        },
      ];
    }
    report.url = { url, access: true, status: res.status, note: "行レベル制御を知っている API です" };
    return [];
  }
  // DevBI's own 401 says `"access": 1` too (another login in front answers 401 of its own).
  if (res.status === 401 && body?.access === 1) {
    report.url = { url, access: true, status: 401, note: "ログインが要る API です（行レベルのモードで動いています）" };
    return [];
  }
  if (res.ok && body && typeof body === "object") {
    report.url = { url, access: false, status: res.status, note: "行レベル制御を知らない API です" };
    return [
      {
        level,
        file,
        message: `${at} に "access": 1 がありません。行レベル制御を知らない古い DevBI の API です（アプリにコピーしたままの C# など）。-- roles: を読まず、:user. の SQL は動きません。新しいものに入れ替えます`,
      },
    ];
  }
  report.url = { url, access: false, status: res.status, note: `確かめられません（HTTP ${res.status}）` };
  return [{ level: "warning", file, message: `${at} が HTTP ${res.status} で答えました（DevBI の API の答えではありません。サイトのログインの前で止まったなど）。置いた先の API を確かめていません` }];
}

/** One run of the checks, as one user of devUsers (or nobody). */
async function checkOnce(dir: string, options: CheckOptions, as?: { name: string; user: DevBIUser }): Promise<CheckReport> {
  const findings: Finding[] = [];
  const views: ViewReport[] = [];
  const tiles: TileReport[] = [];
  const periods: Record<string, string[]> = {};
  const add = (level: Level, file: string, text: string) => findings.push({ level, file, message: text });
  // Each issue of a file is its own finding; the problems of index.ts start with "<file>: ".
  // `ids`: a dashboard's tile ids, to name the tile of a "tiles.3…" path.
  const addIssues = (file: string, e: unknown, ids: unknown[] = []) => {
    if (e instanceof MetricsError || e instanceof DashboardError) {
      for (const i of e.issues) {
        const where = i.path.replace(/^tiles\.(\d+)/, (m, n: string) =>
          typeof ids[Number(n)] === "string" ? `${m}（${ids[Number(n)]}）` : m,
        );
        add("error", file, where ? `${where}: ${i.message}` : i.message);
      }
    } else {
      const text = message(e);
      add("error", file, text.startsWith(`${file}: `) ? text.slice(file.length + 2) : text);
    }
  };

  // ---- the files ----
  const metrics = new Map<string, { view: MetricsView; file: string }>();
  const modelFiles = await list(path.join(dir, "models"), ".metrics.yaml");
  for (const f of modelFiles) {
    const file = `models/${f}`;
    const name = f.slice(0, -".metrics.yaml".length);
    try {
      const view = parseMetricsYaml(await readFile(path.join(dir, file), "utf8"), name, file);
      const { problems } = modelSources(dir, file, view);
      for (const p of problems) addIssues(file, p);
      if (!problems.length) metrics.set(name, { view, file });
    } catch (e) {
      addIssues(file, e);
    }
  }
  // The datasets (api/*.sql) as the page knows them: their parameters, read with each database's quoting rules.
  const env = options.env ?? (await import("@devbi/server")).loadEnv(dir);
  const datasetFiles = await readDatasets(dir, env);
  const rowLevel = await rowLevelChecks(dir, env, metrics, add);
  // Their columns, asked of their databases once each (api/describe): only where one answers.
  let api: ApiHandler | undefined;
  const described = new Map<string, Promise<Described>>();
  // A connection that did not answer (DEVBI_DB…): its other datasets are not asked (each would wait again).
  const offline = new Map<string, Described>();
  const describe = (name: string): Promise<Described> => {
    let found = described.get(name);
    if (!found) {
      found = (async () => {
        let connection: string;
        try {
          const server = await import("@devbi/server");
          connection = server.connectionVariable(server.connectionOf(await server.readDatasetText(dir, name)));
          api ??= server.createApiHandler({ dir, env, exposeErrors: true });
        } catch (e) {
          return { why: message(e) };
        }
        const before = offline.get(connection);
        if (before) return before;
        const d = await askColumns(api, name);
        if (d.offline) offline.set(connection, d);
        return d;
      })();
      described.set(name, found);
    }
    return found;
  };
  /** `-- key:` columns the result does not have: once per SQL file. */
  const keysChecked = new Set<string>();
  const dashboards: { dashboard: Dashboard; file: string }[] = [];
  for (const f of await list(path.join(dir, "dashboards"), ".dash.json")) {
    const file = `dashboards/${f}`;
    let text = "";
    try {
      text = await readFile(path.join(dir, file), "utf8");
      const dashboard = parseDashboardJson(text, f.slice(0, -".dash.json".length), file);
      for (const p of [...dashboardProblems(dir, file, dashboard), ...datasetProblems(file, dashboard, datasetFiles)]) addIssues(file, p);
      dashboards.push({ dashboard, file });
    } catch (e) {
      let ids: unknown[] = [];
      try {
        const tiles = (JSON.parse(text) as { tiles?: unknown }).tiles;
        if (Array.isArray(tiles)) ids = tiles.map((t) => (t as { id?: unknown } | null)?.id);
      } catch {
        // Not JSON: the error says so.
      }
      addIssues(file, e, ids);
    }
  }
  // A project of datasets only (api/*.sql, SSRS-like reports) needs no metrics file.
  const hasDatasets = Object.keys(datasetFiles.datasets).length + Object.keys(datasetFiles.errors).length > 0;
  if (!modelFiles.length && !hasDatasets) add("error", "models/", "指標ファイル（models/<名前>.metrics.yaml）がありません");
  if (!dashboards.length && !findings.some((f) => f.file.startsWith("dashboards/"))) {
    add("warning", "dashboards/", "ダッシュボード（dashboards/<名前>.dash.json）がありません");
  }

  // ---- the data ----
  let engine: NodeEngine | undefined;
  let vite: ViteDevServer | undefined;
  try {
    if (metrics.size) engine = await createNodeEngine(dir, { ...(options.env ? { env: options.env } : {}), ...(as ? { user: as.user, userName: as.name } : {}) });
    // Per view: the model SQL (or why it did not run), and the names that failed or were not checked. A name that
    // failed only because another did (a measure of a broken measure) has its causes in `causes`, not an error.
    const state = new Map<
      string,
      {
        model: string | NotChecked | Error;
        rows: number;
        failed: Set<string>;
        unchecked: Set<string>;
        causes: Map<string, string[]>;
        /** The latest date of the time column (date-range's periods count from it). */
        timeMax?: Date;
      }
    >();

    for (const [name, { view, file }] of metrics) {
      const report: ViewReport = {
        name,
        file,
        measures: Object.keys(view.measures).length,
        dimensions: Object.keys(view.dimensions).length,
      };
      views.push(report);
      const failed = new Set<string>();
      const unchecked = new Set<string>();
      const causes = new Map<string, string[]>();
      let model: string;
      try {
        model = await engine!.loadView(view);
      } catch (e) {
        let why: NotChecked | Error = e instanceof Error ? e : new Error(String(e));
        const ext = missingExtension(e);
        if (e instanceof NotChecked) {
          report.notChecked = e.message;
          add("warning", file, `確かめていません: ${e.message}`);
        } else if (ext) {
          report.notChecked = `DuckDB の拡張 ${ext} を取ってこられないため`;
          add("warning", file, `model: ${noExtension(ext)}`);
          why = new NotChecked(report.notChecked);
        } else {
          const text = duckdbMessage(e);
          add("error", file, `model: ${text}${fileHint(text)}`);
        }
        state.set(name, { model: why, rows: 0, failed, unchecked, causes });
        continue;
      }
      report.rows = Number(engine!.query(`SELECT count(*) AS n FROM (${model})`)[0]?.n ?? 0);
      state.set(name, { model, rows: report.rows, failed, unchecked, causes });
      if (report.rows === 0) add("warning", file, "model の結果が 0 行です（データファイルと model の SQL を確かめてください）");

      // Run SQL for one name: a mistake is an error (the name goes in `failed`), a missing extension a warning.
      const run = <T>(label: string, field: string, go: () => T): T | undefined => {
        try {
          return go();
        } catch (e) {
          const ext = missingExtension(e);
          if (ext) {
            add("warning", file, `${label}: ${noExtension(ext)}`);
            unchecked.add(field);
          } else {
            add("error", file, `${label}: ${e instanceof QueryError ? e.message : duckdbMessage(e)}`);
            failed.add(field);
          }
          return undefined;
        }
      };
      const runQuery = (label: string, field: string, query: Query) =>
        run(label, field, () => engine!.query(compileQuery(view, query, { model }).sql));

      const time = view.time;
      if (time) {
        const extent = run(`time（${time.name}）`, time.name, () => engine!.query(compileTimeExtent(view, { model })))?.[0];
        // MIN and MAX work on text too, but the period filters and the date-range tile need dates.
        const value = extent?.min ?? extent?.max;
        if (value !== undefined && value !== null && !(value instanceof Date)) {
          add(
            "error",
            file,
            `time（${time.name}）: 日付の列になっていません（${typeof value === "number" ? "数値" : "文字"}の列です。例: ${String(value)}）。` +
              "model の SQL で DATE か TIMESTAMP にしてください（例: CAST(列 AS DATE)、strptime(列, '%Y/%m/%d')）",
          );
          failed.add(time.name);
        } else if (extent?.max instanceof Date) {
          state.get(name)!.timeMax = extent.max;
        }
      }
      for (const d of Object.keys(view.dimensions)) runQuery(`軸 ${d}`, d, { dimensions: [d], limit: 1 });

      // Measures after the ones they use, so that one mistake is one error.
      const done = new Set<string>();
      const measure = (m: string) => {
        if (done.has(m)) return;
        done.add(m);
        const def = view.measures[m];
        if (!def) return;
        const uses = def.kind === "sql" ? def.refs : [def.of];
        uses.forEach(measure);
        const from = [...uses, ...(def.kind !== "sql" && time ? [time.name] : [])];
        const bad = from.filter((u) => failed.has(u));
        if (bad.length) {
          failed.add(m);
          causes.set(m, [...new Set(bad.flatMap((u) => causes.get(u) ?? [u]))]);
          return;
        }
        if (from.some((u) => unchecked.has(u))) {
          unchecked.add(m);
          return;
        }
        runQuery(`指標 ${m}`, m, { measures: [m] });
        // Comparisons and running totals compile differently with a time grain: that way too.
        if (time && def.kind !== "sql" && !failed.has(m) && !unchecked.has(m)) {
          runQuery(`指標 ${m}（time: month）`, m, { measures: [m], time: "month" });
        }
      };
      Object.keys(view.measures).forEach(measure);
    }

    // ---- the tiles ----
    for (const { dashboard, file } of dashboards) {
      const where = (t: TileSpec) => `タイル ${t.id}${t.title ? `（${t.title}）` : ""}`;
      // As the runtime picks a query's view: its own, the dashboard's, or the only metrics file.
      const viewName = (n?: string) =>
        n ?? dashboard.metrics ?? (modelFiles.length === 1 ? modelFiles[0]!.slice(0, -".metrics.yaml".length) : undefined);
      // dash.json's "metrics" and query.metrics are reported with the files (dashboardProblems); other names are not.
      const listed = (n: string, t: TileSpec) => n === dashboard.metrics || n === t.query?.metrics;

      // As the page opens: each date-range tile with a first period (options.default) selects it, and it filters every
      // tile whose metrics file has that time column (crossFilters); comparisons (previous_period…) then have a value.
      const filters: Filter[] = [];
      const shown: { field: string; text: string }[] = [];
      for (const t of dashboard.tiles) {
        const def = t.type === "date-range" ? t.options?.default : undefined;
        if (def === undefined || def === "all") continue;
        if (!(DATE_RANGE_PRESETS as readonly unknown[]).includes(def)) {
          add(
            "warning",
            file,
            `${where(t)}: options.default「${String(def)}」はありません（${DATE_RANGE_PRESETS.join("・")}）。画面は全期間で開きます`,
          );
          continue;
        }
        const n = viewName(t.query?.metrics ?? (typeof t.options?.metrics === "string" ? t.options.metrics : undefined));
        const time = n ? metrics.get(n)?.view.time : undefined;
        const max = n ? state.get(n)?.timeMax : undefined;
        if (!time || !max) continue; // no time column, or its error: reported with the tile and the metrics file
        const preset = dateRangePresets(max, time.fiscalYearStart).find((p) => p.key === def);
        if (!preset?.range) {
          add(
            "warning",
            file,
            `${where(t)}: options.default「${String(def)}」には、models/${n}.metrics.yaml の time に fiscal_year_start（年度の始まりの月）が要ります。画面は全期間で開きます`,
          );
          continue;
        }
        const [start, end] = preset.range;
        filters.push({ field: time.name, between: [start, end], ...(preset.unit ? { unit: preset.unit } : {}) });
        const day = (d: Date) => d.toISOString().slice(0, 10);
        shown.push({
          field: time.name,
          text: `${time.name} ${preset.label}（${day(start)}〜${day(new Date(end.getTime() - 86_400_000))}）`,
        });
      }
      if (shown.length) periods[dashboard.name] = shown.map((p) => p.text);
      // The periods that filter a view's tiles: those on its time column or a dimension of that name.
      const periodsOf = (view: MetricsView) =>
        shown.filter((p) => view.time?.name === p.field || Object.hasOwn(view.dimensions, p.field)).map((p) => p.text);
      // The parameter bar, as the page makes it (its problems are reported with the files).
      const bar = dashboardParams(dashboard, datasetFiles.datasets).params;

      for (const t of dashboard.tiles) {
        const tile: TileReport = { dashboard: dashboard.name, id: t.id };
        tiles.push(tile);
        const fail = (text: string) => {
          add("error", file, `${where(t)}: ${text}`);
          tile.note = "エラー";
        };
        // As TileFrame: the query in dash.json, else a promoted tile's `export const query`.
        let query: Query | undefined = t.query;
        if (t.type) {
          if (!Object.hasOwn(TILE_TYPES, t.type)) {
            fail(`type「${t.type}」はありません（${Object.keys(TILE_TYPES).join("・")}）`);
            continue;
          }
          const info = TILE_TYPES[t.type as keyof typeof TILE_TYPES];
          // The options of a report's table (columns, groupBy…) on a table of the metrics files: the table shows every
          // column of its query and ignores them.
          const datasetOnly = Object.entries((info as TileTypeInfo).options ?? {})
            .filter(([k, o]) => o.dataset && t.options !== undefined && Object.hasOwn(t.options, k))
            .map(([k]) => `options.${k}`);
          if (datasetOnly.length && t.query?.dataset === undefined)
            fail(`${datasetOnly.join("・")} はデータセットの表（query.dataset）だけで使えます。指標ファイルの表は query の列をすべて出します`);
          if (!info.query) {
            tile.note = "データを読まないタイル";
            if (t.type === "date-range") {
              // As the tile picks its view (DateRange.tsx); it reads the time column's first and last day.
              const own = t.query?.metrics ?? (typeof t.options?.metrics === "string" ? t.options.metrics : undefined);
              const n = viewName(own);
              const view = n ? metrics.get(n)?.view : undefined;
              if (!n) fail(`使う指標ファイルがわかりません。dash.json の "metrics" か options.metrics に書いてください`);
              else if (!modelFiles.includes(`${n}.metrics.yaml`)) {
                if (!listed(n, t)) fail(`options.metrics の指標ファイル models/${n}.metrics.yaml がありません`);
              } else if (view && !view.time)
                fail(`date-range には time（日付の列）が要ります（models/${n}.metrics.yaml に time がありません）`);
              else if (view?.time && state.get(n)?.failed.has(view.time.name))
                tile.note = `${view.time.name} のエラーのため確かめていません`;
            }
            continue;
          }
          // explore reads all of the model's rows without one.
          if (!query && (info as TileTypeInfo).rows) query = {};
          if (!query) {
            fail(`${t.type} には query（measures・dimensions など）が要ります`);
            continue;
          }
        } else if (t.component && !query) {
          const resolved = resolveComponent(`/${file}`, t.component);
          if (componentProblem(resolved) || !existsSync(path.join(dir, resolved))) continue; // reported with the files
          let exported: unknown;
          try {
            if (!vite) {
              const { createServer } = await import("vite");
              vite = await createServer({
                root: dir,
                configFile: false,
                logLevel: "silent",
                appType: "custom",
                server: { middlewareMode: true, hmr: false, watch: null },
                optimizeDeps: { noDiscovery: true, include: [] },
              });
            }
            exported = (await vite.ssrLoadModule(resolved)).query;
          } catch (e) {
            // In Node, without the project's vite.config: a tile may need the browser (window…) to load.
            const text = `${t.component} を Node で読めないため確かめていません（${message(e).split("\n")[0]}）`;
            add("warning", file, `${where(t)}: ${text}`);
            tile.note = text;
            continue;
          }
          if (!exported) {
            tile.note = "自分でデータを読むタイル（query を export していない）";
            continue;
          }
          try {
            query = checkQuery(exported, t.component) as Query;
          } catch (e) {
            fail(
              `${t.component} の query: ${e instanceof DashboardError ? e.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("、") : message(e)}`,
            );
            continue;
          }
        }
        if (!query) continue;

        if (query.dataset !== undefined) {
          // Rows from the database with the parameters' values: not run here (the API runs them, devbi-serve checks).
          const name = query.dataset;
          const info = Object.hasOwn(datasetFiles.datasets, name) ? datasetFiles.datasets[name]! : undefined;
          if (t.query?.dataset === undefined) {
            // A promoted tile's own query: dash.json's checks (datasetProblems) did not see it.
            if (Object.hasOwn(datasetFiles.errors, name)) fail(datasetFiles.errors[name]!);
            else if (!info) fail(`${t.component} の query: データセット ${name} がありません（api/${name}.sql）`);
            else {
              const lost = tileBindings({ ...t, query }, info).filter(
                (b) => b.param !== undefined && !bar.some((p) => p.name.toLowerCase() === b.param!.toLowerCase()),
              );
              if (lost.length)
                fail(
                  `${t.component} の query: パラメーター ${lost.map((b) => b.param).join("・")} の欄がありません（dash.json のタイルの query に dataset を書くか、params に type を書いてください）`,
                );
            }
          }
          if (t.type === "table") {
            // The table's options as the tile reads them.
            const { options: opts, problems } = tableOptions(t.options);
            for (const p of problems) fail(p);
            const lost = Object.keys(opts.click?.params ?? {}).filter((n) => !bar.some((p) => p.name.toLowerCase() === n.toLowerCase()));
            if (lost.length)
              fail(
                `options.click の ${lost.join("・")} はこのダッシュボードのパラメーターにありません（dash.json の params に type を書くか、そのパラメーターを使うデータセットの表を置いてください）`,
              );
          }
          let columnsNote = "";
          if (info) {
            // The columns as the database describes them (not the rows): the names the options and -- key: use.
            const d = await describe(name);
            if (d.columns) {
              const columns = d.columns.map((c) => c.name);
              columnsNote = `列 ${columns.length} 個の名前はデータベースに聞いて確かめました。`;
              if (t.type === "table") for (const p of tableColumnProblems(tableOptions(t.options).options, columns)) fail(p);
              const missing = (info.key ?? []).filter((k) => !columns.includes(k));
              if (missing.length && !keysChecked.has(name)) {
                keysChecked.add(name);
                add("error", `api/${name}.sql`, `-- key: の ${missing.join("・")} は結果の列にありません（列: ${columns.join("、")}）`);
              }
            } else if (d.offline) {
              columnsNote = "データベースにつながらないため、列の名前は確かめていません。";
            } else {
              columnsNote = "列の名前は確かめていません。";
              if (!keysChecked.has(name)) {
                keysChecked.add(name);
                add("warning", `api/${name}.sql`, `データベースが列を答えませんでした（${d.why}）。列の名前は確かめていません`);
              }
            }
          }
          tile.note ??= info
            ? `データセット ${name}（api/${name}.sql）を読むタイル。${columnsNote}行はデータベースから読むため数えていません`
            : "エラー";
          continue;
        }

        const custom = customQuery(query);
        if (custom) {
          if (t.type && Object.hasOwn(TILE_TYPES, t.type) && (TILE_TYPES[t.type as keyof typeof TILE_TYPES] as TileTypeInfo).rows) {
            fail(ROWS_CUSTOM);
            continue;
          }
          // As the runtime (runCustom): the views it names, each filtered by the first periods that apply to it.
          const lang = custom.lang === "sql" ? "SQL" : "Malloy";
          if (query.metrics && !modelFiles.includes(`${query.metrics}.metrics.yaml`)) {
            if (listed(query.metrics, t)) tile.note = `指標ファイル models/${query.metrics}.metrics.yaml がないため確かめていません`;
            else fail(`query.metrics の指標ファイル models/${query.metrics}.metrics.yaml がありません`);
            continue;
          }
          const names = customViews(
            query,
            modelFiles.map((f) => f.slice(0, -".metrics.yaml".length)),
          );
          if (!names.length) {
            const how = custom.lang === "sql" ? "FROM sales" : "run: sales -> { … }";
            fail(`${lang} のクエリが指標ファイルを読んでいません（${how} のように、models/<名前>.metrics.yaml の名前で読みます）`);
            continue;
          }
          const blocked = names.find((n) => !metrics.get(n) || typeof state.get(n)?.model !== "string");
          if (blocked) {
            const model = state.get(blocked)?.model;
            tile.note =
              model instanceof NotChecked
                ? `確かめていません（${model.message}）`
                : `models/${blocked}.metrics.yaml のエラーのため確かめていません`;
            continue;
          }
          const main = customMainView(query, names);
          if (query.filters?.length && !main) {
            fail("2 つ以上の指標ファイルを読むクエリの filters は、metrics でどの指標ファイルかを書いてください");
            continue;
          }
          const describe = (sql: string): Record<string, string> =>
            Object.fromEntries(
              engine!.query(`DESCRIBE SELECT * FROM (\n${sql}\n)`).map((r) => [String(r.column_name), String(r.column_type)]),
            );
          try {
            const sources = names.map((n) => {
              const view = metrics.get(n)!.view;
              const model = state.get(n)!.model as string;
              const columns = Object.keys(describe(model));
              const fields = new Set([...Object.keys(view.dimensions), ...(view.time ? [view.time.name] : [])]);
              const own = n === main ? (query.filters ?? []) : [];
              for (const f of own) if (!fields.has(f.field)) throw new QueryError(`フィルタの ${f.field} は ${n} の軸にありません`);
              const period = filters.filter((f) => fields.has(f.field) && !(query.period === false && f.field === view.time?.name));
              return {
                name: n,
                sql: compileSource(view, { model, columns, filters: [...own, ...period] }),
                schema: custom.lang === "malloy" ? describe(compileSource(view, { model, columns })) : {},
              };
            });
            let sql = custom.text;
            let columns: ResultColumn[] | undefined;
            if (custom.lang === "malloy") {
              ({ sql, columns } = await compileMalloy(
                custom.text,
                sources.map((s) => ({ name: s.name, table: customTable("malloy", s.name), schema: s.schema })),
              ));
            }
            const full = withSources(
              sql,
              sources.map((s) => ({ table: customTable(custom.lang, s.name), sql: s.sql })),
            );
            const rows = engine!.query(full);
            columns ??= sqlColumns(Object.entries(describe(full)).map(([name, type]) => ({ name, type })));
            const view = main ? metrics.get(main)!.view : undefined;
            const shaped = customFields(custom.lang, columns, view);
            tile.rows = rows.length;
            if (options.values) {
              const fy = view?.time?.fiscalYearStart ?? 1;
              tile.values = rows
                .slice(0, options.values)
                .map((r) =>
                  columns!.map((c, i) => `${shaped.fields[i]!.label} ${formatValue(r[c.name], shaped.fields[i]!, fy)}`).join("、"),
                );
            }
            const shape = t.type ? shapeProblem(t.type, shaped.fields, t.options) : undefined;
            if (shape) fail(shape);
            else if (rows.length === 0 && names.every((n) => (state.get(n)?.rows ?? 0) > 0)) {
              const applied = query.period === false ? [] : [...new Set(names.flatMap((n) => periodsOf(metrics.get(n)!.view)))];
              const period = applied.length ? `date-range の最初の期間 ${applied.join("・")} で。` : "";
              add("warning", file, `${where(t)}: 結果が 0 行です（${period}${lang} のクエリを確かめてください）`);
            }
          } catch (e) {
            const ext = missingExtension(e);
            if (ext) {
              add("warning", file, `${where(t)}: ${noExtension(ext)}`);
              tile.note = `DuckDB の拡張 ${ext} を取ってこられないため確かめていません`;
            } else fail(e instanceof QueryError ? message(e) : `${lang}: ${duckdbMessage(e)}`);
          }
          continue;
        }

        const n = viewName(query.metrics);
        if (!n) {
          fail(`使う指標ファイルがわかりません。dash.json の "metrics" か query.metrics に書いてください`);
          continue;
        }
        if (!modelFiles.includes(`${n}.metrics.yaml`)) {
          if (listed(n, t)) tile.note = `指標ファイル models/${n}.metrics.yaml がないため確かめていません`;
          else fail(`query.metrics の指標ファイル models/${n}.metrics.yaml がありません`);
          continue;
        }
        const entry = metrics.get(n);
        const st = state.get(n);
        if (!entry || !st) {
          tile.note = `models/${n}.metrics.yaml のエラーのため確かめていません`;
          continue;
        }
        if (typeof st.model !== "string") {
          tile.note =
            st.model instanceof NotChecked
              ? `確かめていません（${st.model.message}）`
              : `models/${n}.metrics.yaml の model のエラーのため確かめていません`;
          continue;
        }
        const names = namesOf(entry.view, query);
        const failed = [...new Set(names.filter((x) => st.failed.has(x)).flatMap((x) => st.causes.get(x) ?? [x]))];
        if (failed.length) {
          tile.note = `${failed.join("・")} のエラーのため確かめていません`;
          continue;
        }
        const unchecked = names.filter((x) => st.unchecked.has(x));
        if (unchecked.length) {
          tile.note = `${unchecked.join("・")} を確かめていないため確かめていません`;
          continue;
        }
        // `period: false`: not filtered on the time column (crossFilters).
        const own = query.period === false ? filters.filter((f) => f.field !== entry.view.time?.name) : filters;
        if (t.type && (TILE_TYPES[t.type as keyof typeof TILE_TYPES] as TileTypeInfo).rows) {
          // The model's rows as they are (explore): how many, and whether they fit in the tile's limit.
          const unused = (["measures", "dimensions", "time", "sort"] as const).filter((k) => query[k] !== undefined);
          if (unused.length)
            add("warning", file, `${where(t)}: ${t.type} は明細の行を読むため、query の ${unused.join("・")} は使いません`);
          let compiled;
          try {
            compiled = compileRows(entry.view, query, { model: st.model, filters: own });
          } catch (e) {
            fail(`${message(e)}${e instanceof QueryError ? namesHint(entry.view, message(e)) : ""}`);
            continue;
          }
          try {
            const rows = engine!.query(compiled.sql);
            tile.rows = Math.min(rows.length, compiled.limit);
            if (options.values) tile.values = rows.slice(0, Math.min(options.values, compiled.limit)).map(rowText);
            if (rows.length > compiled.limit) {
              const n = compiled.limit.toLocaleString("en-US");
              add(
                "warning",
                file,
                compiled.newest
                  ? `${where(t)}: 明細が ${n} 行を超えるため、新しいほうから ${n} 行だけを集計します（期間で絞るか、query.limit を大きくしてください）`
                  : `${where(t)}: 明細が ${n} 行を超えるため、${n} 行だけを集計します（query.filters で絞るか、query.limit を大きくしてください）`,
              );
            } else if (rows.length === 0 && st.rows > 0) {
              const applied = query.period === false ? [] : periodsOf(entry.view);
              const period = applied.length ? `date-range の最初の期間 ${applied.join("・")} で。` : "";
              add("warning", file, `${where(t)}: 明細が 0 行です（${period}query.filters を確かめてください）`);
            }
          } catch (e) {
            const ext = missingExtension(e);
            if (ext) {
              add("warning", file, `${where(t)}: ${noExtension(ext)}`);
              tile.note = `DuckDB の拡張 ${ext} を取ってこられないため確かめていません`;
            } else {
              fail(duckdbMessage(e));
            }
          }
          continue;
        }
        let compiled;
        try {
          compiled = compileQuery(entry.view, query, { model: st.model, filters: own });
        } catch (e) {
          fail(`${message(e)}${e instanceof QueryError ? namesHint(entry.view, message(e)) : ""}`);
          continue;
        }
        try {
          const rows = engine!.query(compiled.sql);
          tile.rows = rows.length;
          if (options.values) {
            const fy = entry.view.time?.fiscalYearStart ?? 1;
            tile.values = rows
              .slice(0, options.values)
              .map((r) => compiled.fields.map((f) => `${f.label} ${formatValue(r[f.name], f, fy)}`).join("、"));
          }
        } catch (e) {
          const ext = missingExtension(e);
          if (ext) {
            add("warning", file, `${where(t)}: ${noExtension(ext)}`);
            tile.note = `DuckDB の拡張 ${ext} を取ってこられないため確かめていません`;
          } else {
            fail(duckdbMessage(e));
          }
          continue;
        }
        const shape = t.type ? shapeProblem(t.type, compiled.fields, t.options) : undefined;
        if (shape) fail(shape);
        // When the model has no rows, that is the one warning (on the metrics file).
        else if (tile.rows === 0 && st.rows > 0) {
          const applied = query.period === false ? [] : periodsOf(entry.view);
          const period = applied.length ? `date-range の最初の期間 ${applied.join("・")} で。` : "";
          add("warning", file, `${where(t)}: 結果が 0 行です（${period}query.filters や指標の式を確かめてください）`);
        }
      }
    }
  } finally {
    engine?.close();
    await vite?.close();
    await api?.close();
  }
  return { ...(rowLevel?.on ? { rowLevel: rowLevel.why! } : {}), findings, views, tiles, dashboards: dashboards.map((d) => d.dashboard.name), periods };
}

/**
 * The api/*.sql files as the API reads them (each error once, on its file), and what row-level mode needs: every file
 * says who sees which rows, no ordinary parameter meant for the user's value, models that read files everyone gets
 * (a warning), and no snapshot files left that no job makes any more.
 */
async function rowLevelChecks(
  dir: string,
  env: Record<string, string | undefined>,
  metrics: Map<string, { view: MetricsView; file: string }>,
  add: (level: Level, file: string, text: string) => void,
): Promise<RowLevelMode | undefined> {
  if (!existsSync(path.join(dir, "api"))) return undefined;
  const server = await import("@devbi/server");
  const mode = await server.rowLevelMode(dir);
  // `api/x.sql（3 行目）: …` on the file api/x.sql: `3 行目: …`
  const own = (rel: string, text: string) =>
    text.startsWith(`${rel}: `)
      ? text.slice(rel.length + 2)
      : text.startsWith(`${rel} は、`)
        ? text.slice(rel.length + 3)
        : text.startsWith(`${rel}（`)
          ? text.slice(rel.length).replace(/^（(\d+) 行目）/, "$1 行目")
          : text;
  for (const name of await server.listDatasets(dir)) {
    const rel = `api/${name}.sql`;
    let d: import("@devbi/server").Dataset;
    try {
      const text = await server.readDatasetText(dir, name);
      d = server.parseDataset(name, text, server.dialectOf(env[server.connectionVariable(server.connectionOf(text))] ?? ""));
    } catch (e) {
      add("error", rel, own(rel, message(e)));
      continue;
    }
    const problem = server.rowLevelProblem(d, mode);
    if (problem) add("error", rel, own(rel, problem));
    if (!mode.on) continue;
    for (const p of d.params) {
      if (USER_LIKE.test(p)) {
        add("warning", rel, `:${p} は、ブラウザが値を変えられるふつうのパラメーターです。ログインした人の値なら :user.id か :user.<属性> を使います（行レベルのモード）`);
      }
    }
  }
  if (mode.on) {
    for (const { view, file } of metrics.values()) {
      const told = new Set<string>();
      for (const s of scanSources(view.model)) {
        if (s.format === "api" || told.has(s.path)) continue;
        told.add(s.path);
        add("warning", file, `model の ${s.path} は、だれが開いても同じ行が届きます（行レベルのモード）。マスタなら問題ありません。人ごとに変えたいデータは、データベースに入れて api/*.sql から読みます`);
      }
    }
  }
  // Snapshot files no job makes any more: everyone's rows of SQL that filters by user now, or of an older build.
  const found = await server.snapshotJobs(dir, env, { rowLevel: mode.on });
  if (found.snapshotting && found.problems.length <= (found.leftOut ?? 0)) {
    const made = new Set(found.jobs.map((j) => j.file));
    for (const folder of ["snapshots", "dist/snapshots"]) {
      for (const f of await list(path.join(dir, folder), ".arrows")) {
        if (made.has(f)) continue;
        add(
          mode.on ? "error" : "warning",
          `${folder}/${f}`,
          "今は作らないスナップショットのファイルです（-- snapshot: を消した SQL、人で絞るようになった SQL、パラメーターを変える前のもの）。devbi-serve か devbi-snapshot を動かすと消えます。IIS などに写したものは robocopy /MIR で写し先からも消します",
        );
      }
    }
  }
  return mode;
}

/** The report as text: a line per metrics file and dashboard, then the problems. */
export function formatReport(report: CheckReport): string {
  const lines: string[] = [];
  if (report.rowLevel) {
    lines.push(
      `行レベルのモードです（${report.rowLevel}）。${report.as?.length ? `データを ${report.as.join("・")} として流しました` : "データは読んでいません（devUsers を書くか --as を付けます）"}`,
    );
  }
  if (report.url) lines.push(`置いた先 ${report.url.url}: ${report.url.note}`);
  // `（yamada として）` after a file when the data was read as several users.
  const whose = (as: string | undefined) => (as && (report.as?.length ?? 0) > 1 ? `（${as} として）` : "");
  for (const v of report.views) {
    lines.push(
      v.notChecked
        ? `${v.file}${whose(v.as)}: 確かめていません（${v.notChecked}）`
        : `${v.file}${whose(v.as)}: ${v.rows === undefined ? "エラー" : `${v.rows.toLocaleString("en-US")} 行`}、指標 ${v.measures}・軸 ${v.dimensions}`,
    );
  }
  const runs = (report.as?.length ?? 0) > 1 ? report.as! : [undefined];
  for (const run of runs) {
    for (const name of report.dashboards) {
      const list = report.tiles.filter((t) => t.dashboard === name && (run === undefined || t.as === run));
      const ran = list.filter((t) => t.rows !== undefined);
      const periods = run !== undefined && report.periodsAs ? (report.periodsAs[run] ?? {}) : report.periods;
      const period = Object.hasOwn(periods, name) ? `、date-range の最初の期間: ${periods[name]!.join("・")}` : "";
      lines.push(`dashboards/${name}.dash.json${whose(run)}: タイル ${list.length}（クエリを実行 ${ran.length}${period}）`);
      if (ran.some((t) => t.values)) {
        // --values: each tile's first rows, as the screen shows them.
        for (const t of ran) {
          const more = t.values && t.rows! > t.values.length ? " …" : "";
          if (t.rows === 1 && t.values?.length) lines.push(`  ${t.id}: ${t.values[0]}`);
          else
            lines.push(
              `  ${t.id} ${t.rows!.toLocaleString("en-US")} 行${t.values?.length ? ":" : ""}`,
              ...(t.values ?? []).map((v, i, a) => `    ${v}${i === a.length - 1 ? more : ""}`),
            );
        }
      } else if (ran.length) lines.push(`  ${ran.map((t) => `${t.id} ${t.rows!.toLocaleString("en-US")} 行`).join("、")}`);
      // Tiles not run, by reason (the problems are listed below; tiles without data need no line).
      const notes = new Map<string, string[]>();
      for (const t of list) {
        if (t.rows === undefined && t.note && t.note !== "エラー" && t.note !== "データを読まないタイル") {
          notes.set(t.note, [...(notes.get(t.note) ?? []), t.id]);
        }
      }
      for (const [note, ids] of notes) lines.push(`  ${ids.join("・")}: ${note}`);
    }
  }
  // By file: the metrics files, then the dashboards.
  const rank = (f: Finding) => (f.file.startsWith("models/") ? 0 : 1);
  const byFile = (a: Finding, b: Finding) => rank(a) - rank(b) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const errors = report.findings.filter((f) => f.level === "error").sort(byFile);
  const warnings = report.findings.filter((f) => f.level === "warning").sort(byFile);
  if (report.findings.length) lines.push("");
  for (const f of [...errors, ...warnings]) {
    const [first, ...rest] = f.message.split("\n");
    lines.push(`${f.level === "error" ? "✗" : "⚠"} ${f.file}: ${f.as ? `${f.as.join("・")} として: ` : ""}${first}`);
    for (const r of rest) if (r.trim()) lines.push(`    ${r}`);
  }
  lines.push("");
  lines.push(errors.length || warnings.length ? `エラー ${errors.length} 件、注意 ${warnings.length} 件` : "問題はありません");
  return lines.join("\n");
}
