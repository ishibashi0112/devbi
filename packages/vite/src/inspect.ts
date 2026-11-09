// devbi-inspect: what is in a data file, what a metrics file's model returns, or what a SELECT returns. The columns
// with their type, how many are empty, the range, the most common values of text columns, and the first rows: what
// you need to write the metrics file (and what an AI needs, since it cannot open the Excel file), and a way to try a
// model's SQL or count a number before writing any file.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { defineMetricsView, ident, listSheets, parseMetricsYaml, type MetricsView } from "devbi";
import { modelSources } from "./index.js";
import { createNodeEngine, duckdbMessage, fileHint, missingExtension, NotChecked, type NodeEngineOptions } from "./node-engine.js";

export interface InspectColumn {
  name: string;
  /** DuckDB's type (VARCHAR, DOUBLE, BIGINT, DATE, TIMESTAMP, BOOLEAN…). */
  type: string;
  /** Empty cells. */
  nulls: number;
  /** How many different values (empty cells not counted). */
  distinct: number;
  min?: string;
  max?: string;
  /** Text and true/false columns: the most common values and how many rows have each. */
  values?: { value: string; count: number }[];
}

export interface InspectReport {
  /** What was read: the file or metrics file (relative to the project when inside it), or `SQL`. */
  source: string;
  /** An Excel file's sheets (the first is read unless `sheet` is given). */
  sheets?: string[];
  sheet?: string;
  /** An Excel file: the cells read, the header row included (`A1:K3068`). */
  range?: string;
  rows: number;
  columns: InspectColumn[];
  /** The first rows (as text; empty cells null), in the order read. */
  head: Record<string, string | null>[];
  /** What to look at: a header row that looks like a title, and how to read the sheet instead. */
  notes: string[];
}

export interface InspectOptions extends NodeEngineOptions {
  /** The sheet of an Excel file. Default: the first. */
  sheet?: string;
  /** The cells of an Excel file to read, as read_xlsx's `range` (`A3:K`). Default: all. */
  range?: string;
  /** How many common values to list for text columns. Default 8; 0 for none. */
  values?: number;
  /** How many of the first rows to show. Default 10; 0 for none. */
  rows?: number;
}

/** A SELECT to run instead of reading a file: written as a metrics file's `model` (read_xlsx('data/…') and so on). */
export interface InspectSql {
  sql: string;
}

const DATA = /\.(xlsx|csv|tsv|txt|parquet|arrow|arrows|feather|json|ndjson|jsonl)$/i;

/** A value as text; dates as 2026-10-30, times as 2026-10-30 09:15:00 (UTC, as DevBI reads them). */
const text = (v: unknown) =>
  v instanceof Date
    ? v
        .toISOString()
        .replace(/T00:00:00\.000Z$/, "")
        .replace(/(\.000)?Z$/, "")
        .replace("T", " ")
    : String(v);

/**
 * Inspect `target`: a data file (a path from the current folder or the project), a metrics file (its name in
 * `models/`, or its path) as its model's result, or `{ sql }`, a SELECT over the project's data.
 */
export async function inspectData(dir: string, target: string | InspectSql, options: InspectOptions = {}): Promise<InspectReport> {
  const report: InspectReport = { source: "", rows: 0, columns: [], head: [], notes: [] };
  const relative = (p: string) => {
    const rel = path.relative(dir, p);
    return rel.startsWith("..") || path.isAbsolute(rel) ? p : rel.split(path.sep).join("/");
  };
  let view: MetricsView | undefined;
  let file: string | undefined;
  if (typeof target !== "string") {
    report.source = "SQL";
    view = defineMetricsView({ model: target.sql, measures: {} }, "sql", "--sql");
  } else if (target.endsWith(".metrics.yaml") || (!DATA.test(target) && existsSync(path.join(dir, "models", `${target}.metrics.yaml`)))) {
    // A metrics file: named (sales), or its path (models/sales.metrics.yaml, or one elsewhere to try a model).
    const metricsFile = target.endsWith(".metrics.yaml")
      ? ([path.resolve(target), path.resolve(dir, target), path.join(dir, "models", path.basename(target))].find((p) => existsSync(p)) ??
        path.resolve(dir, target))
      : path.join(dir, "models", `${target}.metrics.yaml`);
    if (!existsSync(metricsFile)) throw new Error(`指標ファイル ${target} がありません`);
    report.source = relative(metricsFile);
    view = parseMetricsYaml(
      await readFile(metricsFile, "utf8"),
      path.basename(metricsFile).slice(0, -".metrics.yaml".length),
      report.source,
    );
  } else {
    file = [path.resolve(target), path.resolve(dir, target)].find((p) => existsSync(p));
    if (!(file && DATA.test(target))) {
      throw new Error(
        file
          ? `${target} は読めるデータのファイルではありません（xlsx・csv・tsv・txt・parquet・arrow・json・ndjson・jsonl）`
          : DATA.test(target)
            ? `ファイル ${target} がありません`
            : `${target} はデータファイルでも指標ファイル（models/${target}.metrics.yaml）でもありません`,
      );
    }
    report.source = relative(file);
  }
  if ((options.sheet || options.range) && !(file && /\.xlsx$/i.test(file))) {
    throw new Error(`${options.sheet ? "--sheet" : "--range"} は Excel のファイル（.xlsx）を読むときだけです`);
  }
  const engine = await createNodeEngine(dir, options.env ? { env: options.env } : {});
  try {
    let from: string;
    if (view) {
      const { problems } = modelSources(dir, report.source, view);
      if (problems.length) throw new Error(problems.join("\n"));
      try {
        from = `(${await engine.loadView(view)})`;
      } catch (e) {
        if (e instanceof NotChecked || missingExtension(e)) throw e;
        const text = duckdbMessage(e);
        throw new Error(`${text}${fileHint(text)}`);
      }
    } else {
      if (/\.xlsx$/i.test(file!)) {
        report.sheets = await listSheets(await readFile(file!));
        if (options.sheet && !report.sheets.includes(options.sheet)) {
          throw new Error(`シート「${options.sheet}」がありません（${report.sheets.join("・")}）`);
        }
        report.sheet = options.sheet ?? report.sheets[0];
      }
      const loaded = await engine.loadFile(file!, {
        ...(report.sheet ? { sheet: report.sheet } : {}),
        ...(options.range ? { range: options.range } : {}),
      });
      from = loaded.table;
      if (loaded.range) report.range = loaded.range;
    }
    report.rows = Number(engine.query(`SELECT count(*) AS n FROM ${from}`)[0]?.n ?? 0);
    const limit = options.values ?? 8;
    const summary = engine.query(`SUMMARIZE SELECT * FROM ${from}`);
    // Exact counts (SUMMARIZE's are estimates: "41 kinds" of 1 to 40 reads as a mistake).
    const counts = summary.length
      ? engine.query(
          `SELECT ${summary.map((s, i) => `count(DISTINCT ${ident(String(s.column_name))}) AS d${i}, count(*) - count(${ident(String(s.column_name))}) AS n${i}`).join(", ")} FROM ${from}`,
        )[0]!
      : {};
    for (const [i, s] of summary.entries()) {
      const name = String(s.column_name);
      const type = String(s.column_type);
      const col: InspectColumn = { name, type, nulls: Number(counts[`n${i}`] ?? 0), distinct: Number(counts[`d${i}`] ?? 0) };
      // A text column's range is alphabetical, which says little: its common values below say more.
      if (type !== "VARCHAR" && s.min !== null && s.min !== undefined) col.min = text(s.min);
      if (type !== "VARCHAR" && s.max !== null && s.max !== undefined) col.max = text(s.max);
      if (limit > 0 && (type === "VARCHAR" || type === "BOOLEAN") && report.rows) {
        col.values = engine
          .query(
            `SELECT ${ident(name)} AS v, count(*) AS n FROM ${from} WHERE ${ident(name)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${limit}`,
          )
          .map((r) => ({ value: text(r.v), count: Number(r.n) }));
      }
      report.columns.push(col);
    }
    const head = options.rows ?? 10;
    if (head > 0 && report.rows) {
      report.head = engine
        .query(`SELECT * FROM ${from} LIMIT ${head}`)
        .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? null : text(v)])));
    }
    const title = report.range ? titleRow(report) : undefined;
    if (title) report.notes.push(title);
    return report;
  } finally {
    engine.close();
  }
}

/**
 * An Excel sheet whose header row has a value in at most half of the columns (the rest named column2…) is most
 * likely a title above the table: how to read from the row below it instead.
 */
function titleRow(r: InspectReport): string | undefined {
  const named = r.columns.filter((c, i) => c.name !== `column${i + 1}`).length;
  const m = /^([A-Z]+)(\d+):([A-Z]+)\d+$/.exec(r.range!);
  if (r.columns.length < 2 || named > r.columns.length / 2 || !m) return undefined;
  const row = Number(m[2]);
  const next = `${m[1]}${row + 1}:${m[3]}`;
  const sheet = r.sheet ? `, sheet = '${r.sheet}'` : "";
  return (
    `見出しとして読んだ ${row} 行目は、${r.columns.length} 列のうち ${named} 列にしか値がありません（ほかの列は column2… という名前になります）。` +
    `表の上の表題などの行なら、その下の見出しの行から読んでください: --range ${next}（指標ファイルでは read_xlsx('${r.source}'${sheet}, range = '${next}')）`
  );
}

/** The report as text. */
export function formatInspect(r: InspectReport): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const where = `${r.sheet ? `シート「${r.sheet}」` : ""}${r.sheet && r.range ? "の " : ""}${r.range ?? ""}`;
  const lines = [`${r.source}${where ? `（${where}）` : ""}: ${n(r.rows)} 行、${r.columns.length} 列`];
  if (r.sheets && r.sheets.length > 1) lines.push(`  シート: ${r.sheets.join("・")}（ほかのシートは --sheet <名前>）`);
  for (const note of r.notes) lines.push(`⚠ ${note}`);
  lines.push("");
  for (const c of r.columns) {
    const parts = [c.type];
    if (c.min !== undefined) parts.push(c.min === c.max ? `すべて ${c.min}` : `${c.min} 〜 ${c.max}`);
    parts.push(`${n(c.distinct)} 種類`);
    if (c.nulls) parts.push(`空 ${n(c.nulls)} 行`);
    lines.push(`${c.name}: ${parts.join("、")}`);
    if (c.values?.length) {
      const more = c.distinct > c.values.length ? " …" : "";
      lines.push(`  多い値: ${c.values.map((v) => `${v.value} (${n(v.count)})`).join("、")}${more}`);
    }
  }
  if (r.head.length) {
    const rest = r.rows > r.head.length ? `（${n(r.rows)} 行のうち。--rows <数> で変えられます）` : "";
    lines.push("", `最初の ${r.head.length} 行${rest}:`, r.columns.map((c) => c.name).join(" | "));
    for (const row of r.head) lines.push(r.columns.map((c) => row[c.name] ?? "").join(" | "));
  }
  return lines.join("\n");
}
