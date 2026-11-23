import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiHandler, ColumnType, DescribedColumn } from "@devbi/server";
import { dashboardJsonSchema, metricsJsonSchema, MetricsError, parseMetricsYaml, type MetricsView, type SchemaNames } from "devbi";
import { askColumns, type Described } from "./describe.js";

export interface GenerateOptions {
  /** Write nothing: `changed` lists the files that are out of date. */
  check?: boolean;
  /**
   * Ask the datasets' databases for their columns (the row types of `RowOf` for `query.dataset`): `"all"` every
   * dataset, `"changed"` those whose SQL changed since their columns were last asked, `false` (default) none. The
   * columns last asked are kept in `.devbi/columns.json` and used for a dataset not asked (or one whose database did
   * not answer).
   */
  describe?: false | "all" | "changed";
  /** What to ask (the dev server's API). Default: an API made for this call from `env`, closed after it. */
  api?: Pick<ApiHandler, "describe">;
  /** Environment for the datasets' databases (DEVBI_DB…). Default: the project's .env files and `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface GenerateResult {
  /** Files written (or, with `check`, files that are out of date). */
  changed: string[];
  /** Metrics files that could not be read; their names are left out. */
  problems: string[];
  /** Datasets whose columns were to be asked and were not, and why (their row types stay as last asked). */
  unasked: { name: string; why: string; offline: boolean }[];
}

/** A dataset as `.devbi/env.d.ts` writes it: its parameter names, and its columns when they are known. */
export interface DatasetTypes {
  name: string;
  /** Undefined: the file does not parse (any parameter name). */
  params?: string[];
  columns?: KnownColumn[];
}

/** A column as `.devbi/columns.json` keeps it. */
export type KnownColumn = Pick<DescribedColumn, "name" | "type" | "nullable">;

/** `.devbi/columns.json`: each dataset's columns as its database last described them, and a hash of the SQL asked. */
type ColumnsFile = Record<string, { sql: string; columns: KnownColumn[] }>;

// The last view each metrics file parsed to. While a file is half-edited in the dev server, its old names stay
// in .devbi/ so promoted tiles do not turn red until the file is fixed.
const lastGood = new Map<string, MetricsView>();

const HEADER = "// pnpm gen（@devbi/vite）が models/*.metrics.yaml と api/*.sql から作るファイルです。手で直さないでください。";

function union(names: string[]): string {
  return names.length ? names.map((n) => JSON.stringify(n)).join(" | ") : "never";
}

const TS_TYPES: Record<ColumnType, string> = {
  string: "string",
  int: "number",
  float: "number",
  bool: "boolean",
  date: "Date",
  timestamp: "Date",
  null: "null",
};

/** A column's type in a row (as the browser gets it: numbers, Dates), `| null` unless the database says it is never null. */
function columnTs(c: KnownColumn): string {
  // A column whose type depends on its values (an expression in SQLite, Oracle's NUMBER without a scale): any value.
  if (!c.type) return 'import("devbi").Scalar';
  const t = TS_TYPES[c.type];
  return c.nullable === false || t === "null" ? t : `${t} | null`;
}

function datasetDts(d: DatasetTypes): string {
  return [
    `    ${JSON.stringify(d.name)}: {`,
    `      params: ${d.params ? union(d.params) : "string"};`,
    ...(d.columns ? ["      row: {", ...d.columns.map((c) => `        ${JSON.stringify(c.name)}: ${columnTs(c)};`), "      };"] : []),
    "    };",
  ].join("\n");
}

/**
 * The `.devbi/env.d.ts` text: measure, dimension and time names per metrics file, and each dataset's parameter names
 * and row type, for `defineQuery` and `RowOf`.
 */
export function envDts(views: MetricsView[], datasets: DatasetTypes[] = []): string {
  const body = views
    .map((v) =>
      [
        `    ${JSON.stringify(v.name)}: {`,
        `      measures: ${union(Object.keys(v.measures))};`,
        `      dimensions: ${union(Object.keys(v.dimensions))};`,
        `      time: ${union(v.time ? [v.time.name] : [])};`,
        `    };`,
      ].join("\n"),
    )
    .join("\n");
  const sets = datasets.map(datasetDts).join("\n");
  return [
    HEADER,
    'import "devbi";',
    "",
    'declare module "devbi" {',
    "  interface MetricsRegistry {",
    body,
    "  }",
    "  interface DatasetRegistry {",
    sets,
    "  }",
    "}",
    "",
  ].join("\n");
}

/** Names for the project's dash.json schema. `datasets`: the names of the SQL files in `api/` (for `query.dataset`). */
export function schemaNames(views: MetricsView[], datasets?: string[]): SchemaNames {
  const uniq = (list: string[]) => [...new Set(list)].sort();
  return {
    metrics: uniq(views.map((v) => v.name)),
    measures: uniq(views.flatMap((v) => Object.keys(v.measures))),
    dimensions: uniq(views.flatMap((v) => Object.keys(v.dimensions))),
    fields: uniq(views.flatMap((v) => [...Object.keys(v.dimensions), ...(v.time ? [v.time.name] : [])])),
    ...(datasets ? { datasets: uniq(datasets) } : {}),
  };
}

/**
 * Write `.devbi/` in a DevBI project: `env.d.ts` (names for TypeScript, and the datasets' row types), `dash.schema.json`
 * (dash.json with the project's names), `metrics.schema.json` and `columns.json` (the datasets' columns as their
 * databases last described them, see `options.describe`). Files are written only when their content changes.
 * With `check`, nothing is written and `changed` lists the files that are out of date.
 */
export async function generate(dir: string, options: GenerateOptions = {}): Promise<GenerateResult> {
  // The datasets first (asking a database can take a while): the metrics files are then read as they are now.
  const outDir = path.join(dir, ".devbi");
  const { datasets, known, unasked } = await datasetTypes(dir, outDir, options);
  const modelsDir = path.join(dir, "models");
  const views: MetricsView[] = [];
  const problems: string[] = [];
  const files = existsSync(modelsDir) ? (await readdir(modelsDir)).filter((f) => f.endsWith(".metrics.yaml")).sort() : [];
  for (const f of files) {
    const file = path.join(modelsDir, f);
    try {
      const view = parseMetricsYaml(await readFile(file, "utf8"), f.slice(0, -".metrics.yaml".length), `models/${f}`);
      lastGood.set(file, view);
      views.push(view);
    } catch (e) {
      problems.push(e instanceof MetricsError ? e.message : `models/${f}: ${(e as Error).message}`);
      const previous = lastGood.get(file);
      if (previous) views.push(previous);
    }
  }
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const outputs: [string, string][] = [
    ["env.d.ts", envDts(views, datasets)],
    ["dash.schema.json", json(dashboardJsonSchema(schemaNames(views, datasets.map((d) => d.name))))],
    ["metrics.schema.json", json(metricsJsonSchema())],
    // Written when a database was asked (a run that asks none keeps the file as it is).
    ...(options.describe && datasets.length ? [["columns.json", columnsJson(known)] as [string, string]] : []),
  ];
  const changed: string[] = [];
  for (const [name, text] of outputs) {
    const file = path.join(outDir, name);
    const current = existsSync(file) ? await readFile(file, "utf8") : undefined;
    if (current === text) continue;
    changed.push(file);
    if (options.check) continue;
    await mkdir(outDir, { recursive: true });
    // Whole or not at all: the dev server's runs can overlap, and one must not read a half-written file.
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temp, text);
    await rename(temp, file);
  }
  return { changed, problems, unasked };
}

/** `.devbi/columns.json`, kept in git: datasets in name order, a column a line (a changed column is a changed line). */
function columnsJson(known: ColumnsFile): string {
  const names = Object.keys(known).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const one = (c: KnownColumn) => `{ ${Object.entries(c).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;
  const body = names.map((n) => {
    const { sql, columns } = known[n]!;
    const list = columns.length ? `[\n${columns.map((c) => `      ${one(c)}`).join(",\n")}\n    ]` : "[]";
    return `  ${JSON.stringify(n)}: {\n    "sql": ${JSON.stringify(sql)},\n    "columns": ${list}\n  }`;
  });
  return names.length ? `{\n${body.join(",\n")}\n}\n` : "{}\n";
}

const sqlHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * The datasets (api/*.sql, by file name: one that does not parse is still a name) with their parameter names and
 * columns: asked of their databases as `options.describe` says, else as last asked (`.devbi/columns.json`).
 */
async function datasetTypes(
  dir: string,
  outDir: string,
  options: GenerateOptions,
): Promise<{ datasets: DatasetTypes[]; known: ColumnsFile; unasked: GenerateResult["unasked"] }> {
  if (!existsSync(path.join(dir, "api"))) return { datasets: [], known: {}, unasked: [] };
  const server = await import("@devbi/server");
  const env = options.env ?? server.loadEnv(dir);
  let before: ColumnsFile = {};
  try {
    const file = path.join(outDir, "columns.json");
    if (existsSync(file)) before = JSON.parse(await readFile(file, "utf8")) as ColumnsFile;
  } catch {
    // A broken file: ask again.
  }
  const texts = new Map<string, string>();
  const datasets: DatasetTypes[] = [];
  for (const name of await server.listDatasets(dir)) {
    let text: string;
    try {
      text = await server.readDatasetText(dir, name);
    } catch {
      continue; // removed since it was listed
    }
    texts.set(name, text);
    let params: string[] | undefined;
    try {
      const d = server.parseDataset(name, text, server.dialectOf(env[server.connectionVariable(server.connectionOf(text))] ?? ""));
      params = d.parameters.map((p) => p.name);
    } catch {
      // Any parameter name while the file does not parse (devbi-check and the API report it).
    }
    datasets.push({ name, ...(params ? { params } : {}) });
  }
  const names = [...texts.keys()];
  const known: ColumnsFile = {};
  for (const name of names) if (Object.hasOwn(before, name) && Array.isArray(before[name]?.columns)) known[name] = before[name]!;
  const unasked: GenerateResult["unasked"] = [];
  const ask = options.describe
    ? names.filter((n) => options.describe === "all" || known[n]?.sql !== sqlHash(texts.get(n)!))
    : [];
  if (ask.length) {
    const api = options.api ?? server.createApiHandler({ dir, env, exposeErrors: true });
    try {
      // One at a time (the pool is the pages' too), and a connection that does not answer is not asked again.
      const answers: [string, Described][] = [];
      const offline = new Map<string, Described>();
      for (const name of ask) {
        const connection = server.connectionVariable(server.connectionOf(texts.get(name)!));
        const d = offline.get(connection) ?? (await askColumns(api, name));
        // (the reason without the first file's name, for the others)
        if (d.offline) offline.set(connection, { ...d, why: (d.why ?? "").replace(/^api\/.+?\.sql: /, "") });
        answers.push([name, d]);
      }
      for (const [name, d] of answers) {
        if (d.columns) {
          known[name] = {
            sql: sqlHash(texts.get(name)!),
            columns: d.columns.map((c) => ({ name: c.name, ...(c.type ? { type: c.type } : {}), ...(c.nullable !== undefined ? { nullable: c.nullable } : {}) })),
          };
        } else {
          unasked.push({ name, why: d.why ?? "", offline: !!d.offline });
        }
      }
    } finally {
      if (!options.api) await (api as ApiHandler).close();
    }
  }
  for (const d of datasets) if (known[d.name]) d.columns = known[d.name]!.columns;
  return { datasets, known, unasked };
}
