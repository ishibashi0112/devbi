import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { DashboardError, MetricsError, componentProblem, defineDashboard, defineMetricsView, hasUrlScheme, resolveComponent, scanSources } from "devbi";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { parse as parseYaml } from "yaml";
import { generate } from "./gen.js";

export { generate, envDts, schemaNames, type GenerateResult } from "./gen.js";

export interface DevbiOptions {
  /** Directory holding `dashboards/`, `models/` and `data/`. Relative to the Vite root. Default: the root. */
  dir?: string;
  /**
   * Where DuckDB-wasm loads extensions (parquet) from, for browsers that cannot reach extensions.duckdb.org.
   * CSV, Arrow IPC and xlsx need no extensions.
   */
  extensionRepository?: string;
}

const VIRTUAL = "virtual:devbi";
const RESOLVED = "\0virtual:devbi";

interface ProjectFiles {
  dashboards: Record<string, { path: string; spec: unknown }>;
  metrics: Record<string, { path: string; spec: unknown }>;
  /** Data files read by model SQL, relative to the project dir. */
  data: string[];
  watched: string[];
}

function posix(p: string): string {
  return p.split(path.sep).join("/");
}

async function list(dir: string, suffix: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => f.endsWith(suffix)).sort();
}

/** Read and validate every dashboard and metrics file. Throws one error listing all problems. */
export async function readProject(dir: string): Promise<ProjectFiles> {
  const problems: string[] = [];
  const out: ProjectFiles = { dashboards: {}, metrics: {}, data: [], watched: [] };
  const modelsDir = path.join(dir, "models");
  for (const f of await list(modelsDir, ".metrics.yaml")) {
    const file = path.join(modelsDir, f);
    const name = f.slice(0, -".metrics.yaml".length);
    const rel = `models/${f}`;
    out.watched.push(file);
    try {
      const spec = parseYaml(await readFile(file, "utf8"));
      const view = defineMetricsView(spec, name, rel);
      out.metrics[name] = { path: `/${rel}`, spec };
      for (const s of scanSources(view.model)) {
        if (hasUrlScheme(s.path)) continue;
        const p = posix(path.normalize(s.path));
        if (p.startsWith("..") || path.isAbsolute(s.path)) {
          problems.push(`${rel}: データのパスはプロジェクトの中を相対パスで書いてください: ${s.path}`);
        } else if (!existsSync(path.join(dir, p))) {
          problems.push(`${rel}: データファイル ${s.path} がありません`);
        } else if (!out.data.includes(p)) {
          out.data.push(p);
        }
      }
    } catch (e) {
      problems.push(e instanceof MetricsError ? e.message : `${rel}: ${(e as Error).message}`);
    }
  }
  const dashDir = path.join(dir, "dashboards");
  for (const f of await list(dashDir, ".dash.json")) {
    const file = path.join(dashDir, f);
    const name = f.slice(0, -".dash.json".length);
    const rel = `dashboards/${f}`;
    out.watched.push(file);
    try {
      const spec = JSON.parse(await readFile(file, "utf8"));
      const d = defineDashboard(spec, name, rel);
      const metricsNames = new Set([d.metrics, ...d.tiles.map((t) => t.query?.metrics)].filter((x): x is string => !!x));
      for (const m of metricsNames) {
        if (!existsSync(path.join(modelsDir, `${m}.metrics.yaml`))) problems.push(`${rel}: 指標ファイル models/${m}.metrics.yaml がありません`);
      }
      for (const t of d.tiles) {
        if (!t.component) continue;
        // Same resolution as the runtime, so what passes here is what import.meta.glob below bundles.
        const resolved = resolveComponent(`/${rel}`, t.component);
        const problem = componentProblem(resolved);
        if (problem) problems.push(`${rel}: タイル ${t.id} の ${t.component}: ${problem}`);
        else if (!existsSync(path.join(dir, resolved))) problems.push(`${rel}: タイル ${t.id} のファイル ${t.component} がありません`);
      }
      out.dashboards[name] = { path: `/${rel}`, spec };
    } catch (e) {
      problems.push(e instanceof DashboardError ? e.message : `${rel}: ${(e as Error).message}`);
    }
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return out;
}

function resolveDuckdb(root: string): { wasm: string; worker: string } {
  const fromRoot = createRequire(path.join(root, "package.json"));
  let reactPkg: string;
  try {
    reactPkg = fromRoot.resolve("@devbi/react/package.json");
  } catch {
    throw new Error("@devbi/react が見つかりません。pnpm add @devbi/react で入れてください");
  }
  const fromReact = createRequire(reactPkg);
  return {
    wasm: fromReact.resolve("@duckdb/duckdb-wasm/dist/duckdb-base.wasm"),
    worker: fromReact.resolve("@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js"),
  };
}

/**
 * The DevBI Vite plugin. Provides `virtual:devbi` (the project: dashboards, metrics, promoted tiles, DuckDB bundle),
 * reloads the page when dash.json / metrics.yaml / data files change, and copies data files into the build.
 */
export default function devbi(options: DevbiOptions = {}): Plugin {
  let config: ResolvedConfig;
  let dir = "";
  let relDir = "";
  let lastData: string[] = [];

  return {
    name: "devbi",
    enforce: "pre",
    config() {
      return { optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] } };
    },
    configResolved(c) {
      config = c;
      dir = path.resolve(c.root, options.dir ?? ".");
      relDir = posix(path.relative(c.root, dir));
      if (relDir.startsWith("..")) throw new Error(`devbi: dir はVite の root の中にしてください: ${dir}`);
    },
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : undefined;
    },
    async buildStart() {
      // Keep .devbi/ (names for TypeScript and the editors' JSON Schema) in step with models/.
      await generate(dir).catch((e: unknown) => config.logger.warn(`devbi: .devbi/ を書けませんでした: ${(e as Error).message}`));
    },
    async load(id) {
      // DuckDB-wasm's worker points at a .map file the package does not ship; drop the comment so the dev server
      // does not print "Failed to load source map". Not the `?url` import, which must keep Vite's handling.
      // The browser fetches it as `…worker.js?v=<hash>`.
      if (config.command === "serve" && /[\\/]@duckdb[\\/]duckdb-wasm[\\/]dist[\\/][^/\\?]+\.worker\.js(\?v=\w+)?$/.test(id)) {
        const code = await readFile(id.split("?")[0]!, "utf8");
        return { code: code.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n"), map: null };
      }
      if (id !== RESOLVED) return;
      const project = await readProject(dir);
      lastData = project.data;
      for (const f of project.watched) this.addWatchFile(f);
      const duck = resolveDuckdb(config.root);
      const prefix = relDir ? `/${relDir}` : "";
      const base = relDir ? `${relDir}/` : "";
      return [
        `import mainModule from ${JSON.stringify(`${posix(duck.wasm)}?url`)};`,
        `import mainWorker from ${JSON.stringify(`${posix(duck.worker)}?url`)};`,
        `const components = import.meta.glob(${JSON.stringify([`${prefix}/dashboards/**/*.tsx`, `${prefix}/dashboards/**/*.jsx`])});`,
        `export default {`,
        `  dashboards: ${JSON.stringify(project.dashboards)},`,
        `  metrics: ${JSON.stringify(project.metrics)},`,
        `  components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k.slice(${prefix.length}), v])),`,
        `  baseUrl: import.meta.env.BASE_URL + ${JSON.stringify(base)},`,
        `  duckdb: { mainModule, mainWorker },`,
        options.extensionRepository ? `  extensionRepository: ${JSON.stringify(options.extensionRepository)},` : "",
        `};`,
      ].join("\n");
    },
    configureServer(server: ViteDevServer) {
      const watchDirs = ["dashboards", "models", "data"].map((d) => path.join(dir, d));
      server.watcher.add(watchDirs);
      const reload = (file: string) => {
        const isProjectFile = /\.(dash\.json|metrics\.yaml)$/.test(file);
        const isData = file.startsWith(path.join(dir, "data") + path.sep);
        if (!isProjectFile && !isData) return;
        if (file.endsWith(".metrics.yaml")) void generate(dir).catch(() => undefined);
        const graph = server.environments?.client?.moduleGraph ?? server.moduleGraph;
        const mod = graph.getModuleById(RESOLVED);
        if (mod) graph.invalidateModule(mod as never);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("change", reload);
      server.watcher.on("add", reload);
      server.watcher.on("unlink", reload);
    },
    async writeBundle(output) {
      const outDir = output.dir ?? config.build.outDir;
      for (const rel of lastData) {
        const target = path.join(outDir, relDir, rel);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(dir, rel), target);
      }
    },
  };
}
