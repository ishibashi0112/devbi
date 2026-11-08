// devbi-inspect: what is in a data file, or what a metrics file's model returns. The columns with their type, how
// many are empty, the range, and the most common values of text columns: what you need to write the metrics file
// (and what an AI needs, since it cannot open the Excel file).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ident, listSheets, parseMetricsYaml } from "devbi";
import { modelSources } from "./index.js";
import { createNodeEngine, type NodeEngineOptions } from "./node-engine.js";

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
  /** What was read: the file (relative to the project when inside it) or `models/<name>.metrics.yaml`. */
  source: string;
  /** An Excel file's sheets (the first is read unless `sheet` is given). */
  sheets?: string[];
  sheet?: string;
  rows: number;
  columns: InspectColumn[];
}

export interface InspectOptions extends NodeEngineOptions {
  /** The sheet of an Excel file. Default: the first. */
  sheet?: string;
  /** How many common values to list for text columns. Default 8; 0 for none. */
  values?: number;
}

const DATA = /\.(xlsx|csv|tsv|txt|parquet|arrow|arrows|feather|json|ndjson|jsonl)$/i;

const text = (v: unknown) =>
  v instanceof Date
    ? v
        .toISOString()
        .replace(/T00:00:00\.000Z$/, "")
        .replace(/\.000Z$/, "Z")
    : String(v);

/**
 * Inspect `target`: a data file (a path from the current folder or the project) or the name of a metrics file in
 * `models/` (its model's result).
 */
export async function inspectData(dir: string, target: string, options: InspectOptions = {}): Promise<InspectReport> {
  const metricsFile = path.join(dir, "models", `${target}.metrics.yaml`);
  const isMetrics = !DATA.test(target) && existsSync(metricsFile);
  const file = isMetrics ? undefined : [path.resolve(target), path.resolve(dir, target)].find((p) => existsSync(p));
  if (!isMetrics && !file) {
    throw new Error(
      DATA.test(target)
        ? `ファイル ${target} がありません`
        : `${target} はデータファイルでも指標ファイル（models/${target}.metrics.yaml）でもありません`,
    );
  }
  const engine = await createNodeEngine(dir, options.env ? { env: options.env } : {});
  try {
    const report: InspectReport = { source: "", rows: 0, columns: [] };
    let from: string;
    if (isMetrics) {
      report.source = `models/${target}.metrics.yaml`;
      const view = parseMetricsYaml(await readFile(metricsFile, "utf8"), target, report.source);
      const { problems } = modelSources(dir, report.source, view);
      if (problems.length) throw new Error(problems.join("\n"));
      from = `(${await engine.loadView(view)})`;
    } else {
      const rel = path.relative(dir, file!);
      report.source = rel.startsWith("..") || path.isAbsolute(rel) ? file! : rel.split(path.sep).join("/");
      if (/\.xlsx$/i.test(file!)) {
        report.sheets = await listSheets(await readFile(file!));
        if (options.sheet && !report.sheets.includes(options.sheet)) {
          throw new Error(`シート「${options.sheet}」がありません（${report.sheets.join("・")}）`);
        }
        report.sheet = options.sheet ?? report.sheets[0];
      }
      from = await engine.loadFile(file!, report.sheet ? { sheet: report.sheet } : {});
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
    return report;
  } finally {
    engine.close();
  }
}

/** The report as text. */
export function formatInspect(r: InspectReport): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const lines = [`${r.source}${r.sheet ? `（シート「${r.sheet}」）` : ""}: ${n(r.rows)} 行、${r.columns.length} 列`];
  if (r.sheets && r.sheets.length > 1) lines.push(`  シート: ${r.sheets.join("・")}（ほかのシートは --sheet <名前>）`);
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
  return lines.join("\n");
}
