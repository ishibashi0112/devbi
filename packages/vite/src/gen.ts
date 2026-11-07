import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dashboardJsonSchema, metricsJsonSchema, MetricsError, parseMetricsYaml, type MetricsView, type SchemaNames } from "devbi";

export interface GenerateResult {
  /** Files written (or, with `check`, files that are out of date). */
  changed: string[];
  /** Metrics files that could not be read; their names are left out. */
  problems: string[];
}

const HEADER = "// pnpm gen（@devbi/vite）が models/*.metrics.yaml から作るファイルです。手で直さないでください。";

function union(names: string[]): string {
  return names.length ? names.map((n) => JSON.stringify(n)).join(" | ") : "never";
}

/** The `.devbi/env.d.ts` text: measure, dimension and time names per metrics file, for `defineQuery` and `RowOf`. */
export function envDts(views: MetricsView[]): string {
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
  return `${HEADER}\nimport "devbi";\n\ndeclare module "devbi" {\n  interface MetricsRegistry {\n${body}\n  }\n}\n`;
}

/** Names for the project's dash.json schema. */
export function schemaNames(views: MetricsView[]): SchemaNames {
  const uniq = (list: string[]) => [...new Set(list)].sort();
  return {
    metrics: uniq(views.map((v) => v.name)),
    measures: uniq(views.flatMap((v) => Object.keys(v.measures))),
    dimensions: uniq(views.flatMap((v) => Object.keys(v.dimensions))),
    fields: uniq(views.flatMap((v) => [...Object.keys(v.dimensions), ...(v.time ? [v.time.name] : [])])),
  };
}

/**
 * Write `.devbi/` in a DevBI project: `env.d.ts` (names for TypeScript), `dash.schema.json` (dash.json with
 * the project's names) and `metrics.schema.json`. Files are written only when their content changes.
 * With `check`, nothing is written and `changed` lists the files that are out of date.
 */
export async function generate(dir: string, options: { check?: boolean } = {}): Promise<GenerateResult> {
  const modelsDir = path.join(dir, "models");
  const views: MetricsView[] = [];
  const problems: string[] = [];
  const files = existsSync(modelsDir) ? (await readdir(modelsDir)).filter((f) => f.endsWith(".metrics.yaml")).sort() : [];
  for (const f of files) {
    try {
      views.push(parseMetricsYaml(await readFile(path.join(modelsDir, f), "utf8"), f.slice(0, -".metrics.yaml".length), `models/${f}`));
    } catch (e) {
      problems.push(e instanceof MetricsError ? e.message : `models/${f}: ${(e as Error).message}`);
    }
  }
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const outputs: [string, string][] = [
    ["env.d.ts", envDts(views)],
    ["dash.schema.json", json(dashboardJsonSchema(schemaNames(views)))],
    ["metrics.schema.json", json(metricsJsonSchema())],
  ];
  const outDir = path.join(dir, ".devbi");
  const changed: string[] = [];
  for (const [name, text] of outputs) {
    const file = path.join(outDir, name);
    const current = existsSync(file) ? await readFile(file, "utf8") : undefined;
    if (current === text) continue;
    changed.push(file);
    if (options.check) continue;
    await mkdir(outDir, { recursive: true });
    await writeFile(file, text);
  }
  return { changed, problems };
}
