// devbi-check: read a project's metrics and dashboard files and run what the browser would run on the data (each
// model, measure and dimension, and every tile's query), so mistakes show without opening the page. Made for the
// person and for an AI that writes the files: each problem names the file, the tile or name, and what to fix.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  checkQuery,
  compileQuery,
  compileTimeExtent,
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
  type TileSpec,
} from "devbi";
import type { ViteDevServer } from "vite";
import { dashboardProblems, modelSources } from "./index.js";
import { createNodeEngine, duckdbMessage, fileHint, missingExtension, NotChecked, type NodeEngine } from "./node-engine.js";

export type Level = "error" | "warning";

export interface Finding {
  level: Level;
  /** The file to change, relative to the project (`models/sales.metrics.yaml`). */
  file: string;
  message: string;
}

export interface ViewReport {
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
}

export interface CheckOptions {
  /** Environment for the API's database (DEVBI_DB…). Default: the project's .env files and `process.env`. */
  env?: Record<string, string | undefined>;
  /** How many rows of each tile's result to keep in `values`, formatted as on the screen. Default 0. */
  values?: number;
}

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
  const dashboards: { dashboard: Dashboard; file: string }[] = [];
  for (const f of await list(path.join(dir, "dashboards"), ".dash.json")) {
    const file = `dashboards/${f}`;
    let text = "";
    try {
      text = await readFile(path.join(dir, file), "utf8");
      const dashboard = parseDashboardJson(text, f.slice(0, -".dash.json".length), file);
      for (const p of dashboardProblems(dir, file, dashboard)) addIssues(file, p);
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
  if (!modelFiles.length) add("error", "models/", "指標ファイル（models/<名前>.metrics.yaml）がありません");
  if (!dashboards.length && !findings.some((f) => f.file.startsWith("dashboards/"))) {
    add("warning", "dashboards/", "ダッシュボード（dashboards/<名前>.dash.json）がありません");
  }

  // ---- the data ----
  let engine: NodeEngine | undefined;
  let vite: ViteDevServer | undefined;
  try {
    if (metrics.size) engine = await createNodeEngine(dir, options.env ? { env: options.env } : {});
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
        filters.push({ field: time.name, between: [start, end] });
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
        let compiled;
        try {
          compiled = compileQuery(entry.view, query, { model: st.model, filters });
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
          const applied = periodsOf(entry.view);
          const period = applied.length ? `date-range の最初の期間 ${applied.join("・")} で。` : "";
          add("warning", file, `${where(t)}: 結果が 0 行です（${period}query.filters や指標の式を確かめてください）`);
        }
      }
    }
  } finally {
    engine?.close();
    await vite?.close();
  }
  return { findings, views, tiles, dashboards: dashboards.map((d) => d.dashboard.name), periods };
}

/** The report as text: a line per metrics file and dashboard, then the problems. */
export function formatReport(report: CheckReport): string {
  const lines: string[] = [];
  for (const v of report.views) {
    lines.push(
      v.notChecked
        ? `${v.file}: 確かめていません（${v.notChecked}）`
        : `${v.file}: ${v.rows === undefined ? "エラー" : `${v.rows.toLocaleString("en-US")} 行`}、指標 ${v.measures}・軸 ${v.dimensions}`,
    );
  }
  for (const name of report.dashboards) {
    const list = report.tiles.filter((t) => t.dashboard === name);
    const ran = list.filter((t) => t.rows !== undefined);
    const period = Object.hasOwn(report.periods, name) ? `、date-range の最初の期間: ${report.periods[name]!.join("・")}` : "";
    lines.push(`dashboards/${name}.dash.json: タイル ${list.length}（クエリを実行 ${ran.length}${period}）`);
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
  // By file: the metrics files, then the dashboards.
  const rank = (f: Finding) => (f.file.startsWith("models/") ? 0 : 1);
  const byFile = (a: Finding, b: Finding) => rank(a) - rank(b) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const errors = report.findings.filter((f) => f.level === "error").sort(byFile);
  const warnings = report.findings.filter((f) => f.level === "warning").sort(byFile);
  if (report.findings.length) lines.push("");
  for (const f of [...errors, ...warnings]) {
    const [first, ...rest] = f.message.split("\n");
    lines.push(`${f.level === "error" ? "✗" : "⚠"} ${f.file}: ${first}`);
    for (const r of rest) if (r.trim()) lines.push(`    ${r}`);
  }
  lines.push("");
  lines.push(errors.length || warnings.length ? `エラー ${errors.length} 件、注意 ${warnings.length} 件` : "問題はありません");
  return lines.join("\n");
}
