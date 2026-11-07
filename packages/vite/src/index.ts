import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { DashboardError, MetricsError, componentProblem, defineDashboard, defineMetricsView, hasUrlScheme, resolveComponent, scanSources } from "devbi";
import { loadEnv, version as viteVersion, type Connect, type Plugin, type PreviewServer, type ResolvedConfig, type UserConfig, type ViteDevServer } from "vite";
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
  /**
   * Also build `devbi-embed.js` into the output folder: one script that shows the dashboards in another app's
   * page (`<div data-devbi="sales">`), with the data, the engine and the API next to it. Default off.
   */
  embed?: boolean;
}

const VIRTUAL = "virtual:devbi";
const RESOLVED = "\0virtual:devbi";
const EMBED = "virtual:devbi/embed";
const RESOLVED_EMBED = "\0virtual:devbi/embed";
/** The embed script's entry name, and its file in the output folder (always this name, so pages can point at it). */
const EMBED_NAME = "devbi-embed";

type FileNames = string | ((chunk: { name: string }) => string) | undefined;
type Output = { entryFileNames?: FileNames; chunkFileNames?: FileNames };
type BuildInputs = { input?: string | string[] | Record<string, string>; preserveEntrySignatures?: unknown; output?: Output | Output[] };

/**
 * Add the embed script to a build's entries, keeping the page (index.html) and any entries already given.
 * Returns warnings for the log (the config hook has no logger yet).
 */
function addEmbedEntry(user: UserConfig, root: string): string[] {
  const warnings: string[] = [];
  const build = (user.build ??= {});
  // Vite 8 bundles with Rolldown (build.rollupOptions is its old name); Vite 7 with Rollup.
  const rolldown = Number(viteVersion.split(".")[0]) >= 8;
  const key = rolldown && (build.rolldownOptions || !build.rollupOptions) ? "rolldownOptions" : "rollupOptions";
  const options = ((build as Record<string, unknown>)[key] ??= {}) as BuildInputs;
  const given = options.input;
  const html = path.join(root, "index.html");
  // Entries from a list are named by their path (admin/index.html → admin/index), so two index.html stay two.
  const nameOf = (file: string) => posix(path.relative(root, path.resolve(root, file))).replace(/\.[^./]+$/, "").replace(/^(\.\.\/)+/, "");
  const inputs: Record<string, string> =
    given === undefined
      ? existsSync(html)
        ? { index: html }
        : {}
      : typeof given === "string"
        ? { index: given }
        : Array.isArray(given)
          ? Object.fromEntries(given.map((g) => [nameOf(g), g]))
          : { ...given };
  if (Object.hasOwn(inputs, EMBED_NAME)) {
    throw new Error(`devbi: embed: true のときは、build の入口に ${EMBED_NAME} という名前を使えません（埋め込み用のスクリプトの名前です）`);
  }
  inputs[EMBED_NAME] = EMBED;
  options.input = inputs;
  // Vite drops an app's entry exports; the embed script keeps its own (import { mount } from ".../devbi-embed.js").
  if (options.preserveEntrySignatures === false) {
    warnings.push(`build.${key}.preserveEntrySignatures: false は、埋め込み用のスクリプトの export が消えるので "exports-only" にしました`);
    options.preserveEntrySignatures = "exports-only";
  }
  options.preserveEntrySignatures ??= "exports-only";
  const assets = build.assetsDir ?? "assets";
  const entryNamed = (orig: FileNames) => (chunk: { name: string }) =>
    chunk.name === EMBED_NAME ? `${EMBED_NAME}.js` : typeof orig === "function" ? orig(chunk) : (orig ?? `${assets}/[name]-[hash].js`);
  // The code the page and the embed script share is a chunk named after virtual:devbi ("_virtual_devbi"); a file
  // starting with "_" is left out by GitHub Pages (Jekyll).
  const chunkNamed = (chunk: { name: string }) => `${assets}/${chunk.name.replace(/^_+/, "") || "chunk"}-[hash].js`;
  const outputs = options.output === undefined ? [(options.output = {})] : Array.isArray(options.output) ? options.output : [options.output];
  for (const o of outputs) {
    o.entryFileNames = entryNamed(o.entryFileNames);
    o.chunkFileNames ??= chunkNamed;
  }
  // The table's CSS comes with its code; with one CSS file for the whole site, only index.html links it.
  if (build.cssCodeSplit === false) {
    warnings.push("build.cssCodeSplit: false だと、埋め込んだダッシュボードに表（spreadsheet-grid）の CSS が付きません");
  }
  // The embed script loads the rest by paths from base: "/reports/" works only from pages on the server where the
  // site is at /reports/. "./" (the default here) or a full URL work from any page.
  if (user.base === undefined) user.base = "./";
  else if (user.base.startsWith("/")) {
    warnings.push(
      `base: ${JSON.stringify(user.base)} だと、devbi-embed.js はサイトを同じサーバーの ${user.base} に置いたページからしか動きません（ほかのサーバーのページに埋め込むなら base: "./" にしてください）`,
    );
  }
  return warnings;
}

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
        if (s.format === "api") {
          // Rows from the read-only API: the SQL file stays on the server (never copied into the build).
          if (!existsSync(path.join(dir, "api", `${s.path}.sql`))) problems.push(`${rel}: API の SQL ファイル api/${s.path}.sql がありません`);
          continue;
        }
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

/** A path with its links resolved, as far as it exists (the rest as written). */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realPath(parent), path.basename(p));
  }
}

/** Vite's server.fs.deny when a project sets none (it is replaced, not added to, when one is given). */
const VITE_DENY = [".env", ".env.*", "*.{crt,pem}", "**/.git/**"];
/** Files the read-only API reads, which the browser must not get from the dev server. */
const SERVER_ONLY = ["**/api/**/*.sql", "*.{sqlite,sqlite3,db}", "*.{sqlite,sqlite3,db}-{wal,shm,journal}"];

/**
 * The DevBI Vite plugin. Provides `virtual:devbi` (the project: dashboards, metrics, promoted tiles, DuckDB bundle),
 * reloads the page when dash.json / metrics.yaml / data files change, and copies data files into the build.
 */
export default function devbi(options: DevbiOptions = {}): Plugin {
  let config: ResolvedConfig;
  let dir = "";
  let relDir = "";
  let lastData: string[] = [];
  let embedWarnings: string[] = [];

  /**
   * The read-only API (api/*.sql) for the dev and preview servers, the same one devbi-serve runs. Connection URLs
   * come from DEVBI_DB… in the environment or Vite's .env files. Database errors are shown as they are (local use).
   */
  const mountApi = (middlewares: Connect.Server, httpServer: { once(event: "close", fn: () => void): unknown } | null) => {
    if (!existsSync(path.join(dir, "api"))) return;
    const env = { ...process.env, ...loadEnv(config.mode, config.envDir || config.root, "DEVBI_") };
    const handler = import("@devbi/server").then((m) =>
      m.createApiHandler({ dir, env, exposeErrors: true, log: (line) => config.logger.info(`devbi: ${line}`, { timestamp: true }) }),
    );
    httpServer?.once("close", () => void handler.then((h) => h.close()));
    middlewares.use((req, res, next) => {
      handler
        .then(async (h) => {
          if (!(await h.handle(req, res))) next();
        })
        .catch(next);
    });
  };

  return {
    name: "devbi",
    enforce: "pre",
    config(user, { mode, command }) {
      // The dev server serves the project folder: keep the API's SQL and SQLite databases out of it (they are
      // for the server only). Vite's own list stays when the project has none of its own.
      const root = path.resolve(user.root ?? process.cwd());
      const env = { ...process.env, ...loadEnv(mode, user.envDir ? path.resolve(root, user.envDir) : root, "DEVBI_") };
      // Vite compares the file's real path (macOS's /var is /private/var): deny both that and the path as written.
      const sqliteFiles = Object.entries(env)
        .filter(([k, v]) => /^DEVBI_DB(_|$)/.test(k) && v?.trim().startsWith("sqlite:"))
        .flatMap(([, v]) => {
          const file = path.resolve(root, options.dir ?? ".", v!.trim().slice("sqlite:".length).replace(/^\/\//, ""));
          return [...new Set([file, realPath(file)])].map((f) => posix(f).replace(/[*?{}()[\]!+@]/g, "\\$&"));
        });
      const deny = [...(user.server?.fs?.deny ? [] : VITE_DENY), ...SERVER_ONLY, ...sqliteFiles];
      if (options.embed && command === "build" && !user.build?.ssr && !user.build?.lib) embedWarnings = addEmbedEntry(user, root);
      return { optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] }, server: { fs: { deny } } };
    },
    configResolved(c) {
      config = c;
      for (const w of embedWarnings) c.logger.warn(`devbi: ${w}`);
      dir = path.resolve(c.root, options.dir ?? ".");
      relDir = posix(path.relative(c.root, dir));
      if (relDir.startsWith("..")) throw new Error(`devbi: dir はVite の root の中にしてください: ${dir}`);
    },
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : id === EMBED ? RESOLVED_EMBED : undefined;
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
      if (id === RESOLVED_EMBED) {
        const base = relDir ? `${relDir}/` : "./";
        return [
          `import project from ${JSON.stringify(VIRTUAL)};`,
          `import { startEmbed } from "@devbi/react";`,
          // This script sits in the output folder: the data and the API are next to it, whichever page loads it.
          // (import.meta.url through a name: Vite would take new URL("…", import.meta.url) for a file to bundle.)
          `const here = import.meta.url;`,
          `const baseUrl = import.meta.env.DEV ? project.baseUrl : new URL(${JSON.stringify(base)}, here).href;`,
          `const devbi = startEmbed({ ...project, baseUrl });`,
          `export const dashboards = devbi.dashboards, mount = devbi.mount, mountAll = devbi.mountAll, unmount = devbi.unmount;`,
          `export default devbi;`,
        ].join("\n");
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
      mountApi(server.middlewares, server.httpServer);
      const watchDirs = ["dashboards", "models", "data", "api"].map((d) => path.join(dir, d));
      server.watcher.add(watchDirs);
      const reload = (file: string) => {
        const isProjectFile = /\.(dash\.json|metrics\.yaml)$/.test(file);
        const isData = file.startsWith(path.join(dir, "data") + path.sep) || file.startsWith(path.join(dir, "api") + path.sep);
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
    configurePreviewServer(server: PreviewServer) {
      mountApi(server.middlewares, server.httpServer);
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
