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
  DashboardError,
  MetricsError,
  parseDashboardJson,
  parseMetricsYaml,
  QueryError,
  resolveComponent,
  TILE_TYPES,
  type Dashboard,
  type FieldInfo,
  type MetricsView,
  type Query,
  type TileSpec,
} from "devbi";
import type { ViteDevServer } from "vite";
import { dashboardProblems, modelSources } from "./index.js";
import { createNodeEngine, duckdbMessage, missingExtension, NotChecked, type NodeEngine } from "./node-engine.js";

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
}

export interface CheckReport {
  findings: Finding[];
  views: ViewReport[];
  tiles: TileReport[];
}

export interface CheckOptions {
  /** Environment for the API's database (DEVBI_DB…). Default: the project's .env files and `process.env`. */
  env?: Record<string, string | undefined>;
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
    const text = await readFile(path.join(dir, file), "utf8");
    try {
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
    const broken = new Map<string, Set<string>>(); // view → names that failed on their own
    const skipped = new Map<string, Set<string>>(); // view → names that need an extension Node cannot load
    const loaded = new Map<string, string | NotChecked | Error>(); // view → model SQL, or why not

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
      broken.set(name, failed);
      skipped.set(name, unchecked);
      let model: string;
      try {
        model = await engine!.loadView(view);
        loaded.set(name, model);
      } catch (e) {
        if (e instanceof NotChecked) {
          report.notChecked = e.message;
          add("warning", file, `確かめていません: ${e.message}`);
        } else if (missingExtension(e)) {
          report.notChecked = `DuckDB の拡張 ${missingExtension(e)} を取ってこられないため`;
          add("warning", file, `model: ${noExtension(missingExtension(e)!)}`);
          loaded.set(name, new NotChecked(report.notChecked));
          continue;
        } else {
          add("error", file, `model: ${duckdbMessage(e)}`);
        }
        loaded.set(name, e as Error);
        continue;
      }
      // Run SQL for one name: a mistake is an error (the name goes in `failed`), a missing extension a warning.
      const run = (label: string, field: string, sql: () => string) => {
        try {
          engine!.query(sql());
        } catch (e) {
          const ext = missingExtension(e);
          if (ext) {
            add("warning", file, `${label}: ${noExtension(ext)}`);
            unchecked.add(field);
          } else {
            add("error", file, `${label}: ${e instanceof QueryError ? e.message : duckdbMessage(e)}`);
            failed.add(field);
          }
        }
      };
      const runQuery = (label: string, field: string, query: Query) => run(label, field, () => compileQuery(view, query, { model }).sql);
      report.rows = Number(engine!.query(`SELECT count(*) AS n FROM (${model})`)[0]?.n ?? 0);
      if (report.rows === 0) add("warning", file, "model の結果が 0 行です（データファイルと model の SQL を確かめてください）");
      if (view.time) run(`time（${view.time.name}）`, view.time.name, () => compileTimeExtent(view, { model }));
      for (const d of Object.keys(view.dimensions)) runQuery(`軸 ${d}`, d, { dimensions: [d], limit: 1 });
      for (const [m, def] of Object.entries(view.measures)) {
        runQuery(`指標 ${m}`, m, { measures: [m] });
        // Comparisons and running totals compile differently with a time grain: that way too.
        if (view.time && def.kind !== "sql" && !failed.has(m) && !unchecked.has(m))
          runQuery(`指標 ${m}（time: month）`, m, { measures: [m], time: "month" });
      }
    }

    // ---- the tiles ----
    for (const { dashboard, file } of dashboards) {
      const where = (t: TileSpec) => `タイル ${t.id}${t.title ? `（${t.title}）` : ""}`;
      // As the runtime picks a query's view: its own, the dashboard's, or the only metrics file.
      const viewName = (n?: string) =>
        n ?? dashboard.metrics ?? (modelFiles.length === 1 ? modelFiles[0]!.slice(0, -".metrics.yaml".length) : undefined);

      for (const t of dashboard.tiles) {
        const tile: TileReport = { dashboard: dashboard.name, id: t.id };
        tiles.push(tile);
        const fail = (text: string) => {
          add("error", file, `${where(t)}: ${text}`);
          tile.note = "エラー";
        };
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
                // dash.json's "metrics" and query.metrics are reported with the files; options.metrics is not.
                if (n === own && !t.query?.metrics) fail(`options.metrics の指標ファイル models/${n}.metrics.yaml がありません`);
              } else if (view && !view.time)
                fail(`date-range には time（日付の列）が要ります（models/${n}.metrics.yaml に time がありません）`);
              else if (view?.time && broken.get(n)?.has(view.time.name)) tile.note = `${view.time.name} のエラーのため確かめていません`;
            }
            continue;
          }
          if (!query) {
            fail(`${t.type} には query（measures・dimensions など）が要ります`);
            continue;
          }
        } else if (t.component) {
          const resolved = resolveComponent(`/${file}`, t.component);
          if (componentProblem(resolved) || !existsSync(path.join(dir, resolved))) continue; // reported with the files
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
            const mod = await vite.ssrLoadModule(resolved);
            query = mod.query ? (checkQuery(mod.query, t.component) as Query) : undefined;
          } catch (e) {
            fail(`${t.component} を読めません: ${message(e).split("\n")[0]}`);
            continue;
          }
          if (!query) {
            tile.note = "自分でデータを読むタイル（query を export していない）";
            continue;
          }
        }
        if (!query) continue;

        const n = viewName(query.metrics);
        if (!n) {
          fail(`使う指標ファイルがわかりません。dash.json の "metrics" か query.metrics に書いてください`);
          continue;
        }
        const entry = metrics.get(n);
        const model = loaded.get(n);
        if (!entry || model === undefined) {
          tile.note = `指標ファイル models/${n}.metrics.yaml にエラーがあるため確かめていません`;
          continue;
        }
        if (typeof model !== "string") {
          tile.note =
            model instanceof NotChecked
              ? `確かめていません（${model.message}）`
              : `models/${n}.metrics.yaml の model のエラーのため確かめていません`;
          continue;
        }
        const names = namesOf(entry.view, query);
        const failed = names.filter((x) => broken.get(n)?.has(x));
        if (failed.length) {
          tile.note = `${failed.join("・")} のエラーのため確かめていません`;
          continue;
        }
        const unchecked = names.filter((x) => skipped.get(n)?.has(x));
        if (unchecked.length) {
          tile.note = `${unchecked.join("・")} を確かめていないため確かめていません`;
          continue;
        }
        let compiled;
        try {
          compiled = compileQuery(entry.view, query, { model });
        } catch (e) {
          fail(`${message(e)}${e instanceof QueryError ? namesHint(entry.view, message(e)) : ""}`);
          continue;
        }
        try {
          tile.rows = engine!.query(compiled.sql).length;
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
        else if (tile.rows === 0) add("warning", file, `${where(t)}: 結果が 0 行です（query.filters や指標の式を確かめてください）`);
      }
    }
  } finally {
    engine?.close();
    await vite?.close();
  }
  return { findings, views, tiles };
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
  const byDashboard = new Map<string, TileReport[]>();
  for (const t of report.tiles) byDashboard.set(t.dashboard, [...(byDashboard.get(t.dashboard) ?? []), t]);
  for (const [name, list] of byDashboard) {
    const ran = list.filter((t) => t.rows !== undefined);
    lines.push(`dashboards/${name}.dash.json: タイル ${list.length}（クエリを実行 ${ran.length}）`);
    if (ran.length) lines.push(`  ${ran.map((t) => `${t.id} ${t.rows!.toLocaleString("en-US")} 行`).join("、")}`);
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
