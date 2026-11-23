import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import path from "node:path";
import {
  DashboardError,
  MetricsError,
  componentProblem,
  dashboardParams,
  defineDashboard,
  defineMetricsView,
  hasUrlScheme,
  resolveComponent,
  scanSources,
  type Dashboard,
  type DatasetInfo,
  type MetricsView,
} from "devbi";
import { loadEnv, version as viteVersion, type Connect, type Plugin, type PreviewServer, type ResolvedConfig, type UserConfig, type ViteDevServer } from "vite";
import { parse as parseYaml } from "yaml";
import type { IncomingMessage } from "node:http";
import type { ApiHandler, RequestOptions } from "@devbi/server";
import { devUserOf, type DevbiPluginApi } from "./dev-users.js";
import { createEditorHandler, sameMachine, versionOf } from "./editor.js";
import { generate } from "./gen.js";

export { generate, envDts, schemaNames, type GenerateResult } from "./gen.js";
export { createEditorHandler, versionOf, NEW_NAME, type EditorOptions } from "./editor.js";
export { loadDevUsers, devUserOf, type DevbiPluginApi } from "./dev-users.js";

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
  /**
   * Users to view the dashboards as, on the dev server (row-level security: `:user.<attr>` in `api/*.sql`): the page
   * gets 「表示する利用者」 at the top, and the API answers as the one picked there. By name:
   * `{ yamada: { roles: ["営業"], attrs: { region: "関東" } } }`. Only for requests from this computer; never in a
   * build, `vite preview` or `devbi-serve`.
   */
  devUsers?: Record<string, DevUser>;
}

/** A user of `devUsers`: as the host app would pass them to the API (`{ id, roles, attrs }`). */
export interface DevUser {
  /** The id `:user.id` reads (`CORP\\yamada`). Default: the name in `devUsers`. */
  id?: string;
  roles?: string[];
  attrs?: Record<string, string | number | boolean | null>;
}

/** The cookie that says which of `devUsers` the page views as (the dev server only; from this computer only). */
export const DEV_USER_COOKIE = "devbi-dev-user";

/** A cookie's value from a Cookie header; undefined when it has none (or one that does not decode). */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
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
  // The embed script loads the rest (the DuckDB files, the table's CSS) by paths from base: with Vite's "/", or
  // "/reports/", only from pages on the server where the site is at that path. "./" or a full URL work from any page.
  // Not changed here: base is also how the project's own pages find their files.
  const base = user.base ?? "/";
  if (base.startsWith("/")) {
    warnings.push(
      `base: ${JSON.stringify(base)}${user.base === undefined ? "（Vite の既定）" : ""} だと、devbi-embed.js はサイトを同じサーバーの ${base} に置いたページからしか動きません。` +
        `ほかのページに埋め込むなら、vite.config に base: "./" と書いてください`,
    );
  }
  return warnings;
}

/**
 * The API's SQL files read from a snapshot: name → times of day, from the `-- snapshot: 06:00` lines in api/*.sql.
 * Only that goes to the browser, not the SQL.
 */
export async function readSnapshots(dir: string): Promise<Record<string, string[]>> {
  if (!existsSync(path.join(dir, "api"))) return {};
  const { listDatasets, readDatasetText, snapshotOf } = await import("@devbi/server");
  const out: Record<string, string[]> = {};
  for (const name of await listDatasets(dir)) {
    const times = snapshotOf(await readDatasetText(dir, name), name);
    if (times) out[name] = times;
  }
  return out;
}

/** The datasets (api/*.sql) as the page knows them, and the files that do not parse (name → message). */
export interface DatasetFiles {
  datasets: Record<string, DatasetInfo>;
  errors: Record<string, string>;
}

/**
 * What the page knows of each dataset (api/<name>.sql): its parameters (`-- param:`) and key (`-- key:`), not the SQL.
 * The same as the API's `api/schema` lists. Each file is read with the quoting rules of its database when `env` names
 * its URL (DEVBI_DB…), and of all of them otherwise. A file that does not parse is in `errors`: a problem only for the
 * dashboards that read it (the API reports it too).
 */
export async function readDatasets(dir: string, env: Record<string, string | undefined> = process.env): Promise<DatasetFiles> {
  const out: DatasetFiles = { datasets: {}, errors: {} };
  if (!existsSync(path.join(dir, "api"))) return out;
  const { listDatasets, readDatasetText, parseDataset, connectionOf, connectionVariable, dialectOf } = await import("@devbi/server");
  for (const name of await listDatasets(dir)) {
    try {
      const text = await readDatasetText(dir, name);
      const d = parseDataset(name, text, dialectOf(env[connectionVariable(connectionOf(text))] ?? ""));
      out.datasets[name] = { parameters: d.parameters, ...(d.key ? { key: d.key } : {}) };
    } catch (e) {
      out.errors[name] = (e as Error).message;
    }
  }
  return out;
}

/**
 * Problems with a dashboard's datasets and parameters: a tile's `query.dataset` with no file (or one that does not
 * parse), `query.params` the dataset does not have, and parameters that do not merge (`dashboardParams`).
 */
export function datasetProblems(rel: string, d: Dashboard, files: DatasetFiles): string[] {
  const out = new Set<string>();
  for (const p of dashboardParams(d, files.datasets).problems) {
    // A file that is there but does not parse: its own message, not "がありません".
    out.add(`${rel}: ${p.replace(/データセット (\S+) がありません（api\/\S+\.sql）/, (all, n: string) => (Object.hasOwn(files.errors, n) ? files.errors[n]! : all))}`);
  }
  return [...out];
}

interface ProjectFiles {
  dashboards: Record<string, { path: string; spec: unknown }>;
  metrics: Record<string, { path: string; spec: unknown }>;
  /** Every dataset's parameters and key (for the parameter bar and the dataset tiles). */
  datasets: Record<string, DatasetInfo>;
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

/** Problems with the files a dashboard points at: its metrics files and promoted tiles. */
export function dashboardProblems(dir: string, rel: string, d: Dashboard): string[] {
  const problems: string[] = [];
  const metricsNames = new Set([d.metrics, ...d.tiles.map((t) => t.query?.metrics)].filter((x): x is string => !!x));
  for (const m of metricsNames) {
    if (!existsSync(path.join(dir, "models", `${m}.metrics.yaml`))) problems.push(`${rel}: 指標ファイル models/${m}.metrics.yaml がありません`);
  }
  for (const t of d.tiles) {
    if (!t.component) continue;
    // Same resolution as the runtime, so what passes here is what import.meta.glob below bundles.
    const resolved = resolveComponent(`/${rel}`, t.component);
    const problem = componentProblem(resolved);
    if (problem) problems.push(`${rel}: タイル ${t.id} の ${t.component}: ${problem}`);
    else if (!existsSync(path.join(dir, resolved))) problems.push(`${rel}: タイル ${t.id} のファイル ${t.component} がありません`);
  }
  return problems;
}

/** The data files a metrics view's model reads (relative to the project), and problems with them. */
export function modelSources(dir: string, rel: string, view: MetricsView): { data: string[]; problems: string[] } {
  const data: string[] = [];
  const problems: string[] = [];
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
    } else if (!data.includes(p)) {
      data.push(p);
    }
  }
  return { data, problems };
}

/**
 * Read and validate every dashboard and metrics file, and the datasets' parameters. Throws one error listing all
 * problems. `env`: where the datasets' connection URLs are (to read each SQL file with its database's rules).
 */
export async function readProject(dir: string, env?: Record<string, string | undefined>): Promise<ProjectFiles> {
  const problems: string[] = [];
  const files = await readDatasets(dir, env);
  const out: ProjectFiles = { dashboards: {}, metrics: {}, datasets: files.datasets, data: [], watched: [] };
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
      const sources = modelSources(dir, rel, view);
      problems.push(...sources.problems);
      for (const p of sources.data) if (!out.data.includes(p)) out.data.push(p);
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
      problems.push(...dashboardProblems(dir, rel, d), ...datasetProblems(rel, d, files));
      out.dashboards[name] = { path: `/${rel}`, spec };
    } catch (e) {
      problems.push(e instanceof DashboardError ? e.message : `${rel}: ${(e as Error).message}`);
    }
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return out;
}

function fromReact(root: string): NodeRequire {
  const fromRoot = createRequire(path.join(root, "package.json"));
  let reactPkg: string;
  try {
    reactPkg = fromRoot.resolve("@devbi/react/package.json");
  } catch {
    throw new Error("@devbi/react が見つかりません。pnpm add @devbi/react で入れてください");
  }
  return createRequire(reactPkg);
}

function resolveDuckdb(root: string): { wasm: string; worker: string } {
  const req = fromReact(root);
  return {
    wasm: req.resolve("@duckdb/duckdb-wasm/dist/duckdb-base.wasm"),
    worker: req.resolve("@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js"),
  };
}

/** Perspective's WebAssembly (the engine and the viewer), for the explore tile. */
function resolvePerspective(root: string): { server: string; client: string } {
  const req = fromReact(root);
  const dist = (pkg: string) => path.dirname(req.resolve(`${pkg}/package.json`));
  return {
    server: path.join(dist("@finos/perspective"), "dist/wasm/perspective-server.wasm"),
    client: path.join(dist("@finos/perspective-viewer"), "dist/wasm/perspective-viewer.wasm"),
  };
}

/**
 * Whether a dashboard may show an explore tile: one in dash.json, or a tile of its own code (a promoted explore tile
 * draws the built-in one). A build then carries Perspective's WebAssembly (about 3 MB, fetched only for the tile).
 */
function mayExplore(dashboards: ProjectFiles["dashboards"]): boolean {
  return Object.values(dashboards).some((d) => {
    const tiles = (d.spec as { tiles?: unknown }).tiles;
    return Array.isArray(tiles) && tiles.some((t) => (t as { type?: unknown })?.type === "explore" || !!(t as { component?: unknown })?.component);
  });
}

/**
 * A package the project has installed (the GUI editor, @devbi/editor, for one): whether it is a link to its source
 * (this monorepo, `pnpm link`) rather than a package in node_modules, which Vite bundles ahead (optimizeDeps).
 */
function findPackage(root: string, name: string): { linked: boolean } | undefined {
  // Where Vite looks for a package imported from the project: node_modules/ in the root and the folders above it.
  for (let dir = root; ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, "node_modules", ...name.split("/"), "package.json");
    if (existsSync(pkg)) return { linked: !realPath(pkg).split(path.sep).includes("node_modules") };
    if (path.dirname(dir) === dir) return undefined;
  }
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

/**
 * Whether a request to the dev server may say which of devUsers it views as: it comes straight from this computer.
 * Not through a proxy or tunnel (a header that says it passed one: the request may be anyone's), and, when
 * `server.allowedHosts` is `true` (which lets any page point a name of its own at this server), only to localhost or
 * an IP address. `"proxy"` and `"host"` are those cases, `false` another computer.
 */
export function devUserOrigin(
  req: { socket: { remoteAddress?: string | undefined; localAddress?: string | undefined }; headers: Record<string, string | string[] | undefined> },
  allowedHosts: unknown,
): boolean | "proxy" | "host" {
  if (!sameMachine(req as IncomingMessage)) return false;
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return "proxy";
  if (allowedHosts === true && !localHostName(req.headers.host)) return "host";
  return true;
}

const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "via", "cf-connecting-ip", "true-client-ip", "x-client-ip"];

/** localhost, a name under .localhost, or an IP address (no page can point those at this server). */
function localHostName(host: string | string[] | undefined): boolean {
  if (typeof host !== "string") return false;
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.replace(/:\d*$/, "");
  const lower = name.toLowerCase().replace(/\.$/, "");
  return lower === "localhost" || lower.endsWith(".localhost") || isIP(lower) !== 0;
}

/**
 * Who the API of Vite's server answers as. The dev server: the one of devUsers the page picked (its cookie), for
 * requests straight from this computer only (devUserOrigin). Otherwise nobody, with how to pick one for the 401's
 * message. `vite preview`: nobody.
 */
export function devUserRequest(
  users: Record<string, DevUser> | undefined | "preview",
  cookie: string | undefined,
  fromThisComputer: boolean | "proxy" | "host",
): RequestOptions {
  if (users === "preview") return { signInHint: "vite preview では利用者を選べません。開発サーバー（vite）の『表示する利用者』で確かめます" };
  if (!users || !Object.keys(users).length) {
    return { signInHint: "開発サーバーでは、vite.config.ts の devbi({ devUsers }) に書いた人として見られます" };
  }
  const picked = cookieValue(cookie, DEV_USER_COOKIE);
  if (picked === undefined || picked === "") return { signInHint: "開発サーバーのダッシュボードの右上の『表示する利用者』で選びます" };
  // Another computer (vite --host) does not become someone by sending the cookie: the API reads .env's databases.
  if (fromThisComputer === false) return { signInHint: "『表示する利用者』は、開発サーバーを動かしているパソコンで開いたページからだけ使えます" };
  if (fromThisComputer === "proxy") {
    return { signInHint: "『表示する利用者』は、開発サーバーにじかにつないだページからだけ使えます（プロキシーやトンネルを通したページからは使えません）" };
  }
  if (fromThisComputer === "host") {
    return { signInHint: "server.allowedHosts が true なので、『表示する利用者』は localhost か IP アドレスで開いたページからだけ使えます" };
  }
  if (!Object.hasOwn(users, picked)) return { signInHint: `devUsers に ${shortName(picked)} がありません。『表示する利用者』で選び直します` };
  return { user: devUserOf(picked, users[picked]!) };
}

/** A cookie's value as a message shows it: one line, at most 40 characters. */
function shortName(name: string): string {
  const line = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/** devUsers as the page lists them: `{ name: "yamada", note: "営業・region 関東" }`. */
function devUserList(users: Record<string, DevUser> | undefined): { name: string; note?: string }[] {
  return Object.entries(users ?? {}).map(([name, u]) => {
    const parts = [
      ...(u?.id !== undefined && u.id !== name ? [u.id] : []),
      ...(Array.isArray(u?.roles) ? u.roles : []),
      ...Object.entries(u?.attrs ?? {})
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `${k} ${String(v)}`),
    ];
    return parts.length ? { name, note: parts.join("・") } : { name };
  });
}

/** Vite's server.fs.deny when a project sets none (it is replaced, not added to, when one is given). */
const VITE_DENY = [".env", ".env.*", "*.{crt,pem}", "**/.git/**"];
/** Files the read-only API reads, which the browser must not get from the dev server (access/: row-level security). */
const SERVER_ONLY = [
  "**/api/**/*.sql",
  "**/access/**",
  "*.{sqlite,sqlite3,db}",
  "*.{sqlite,sqlite3,db}-{wal,shm,journal}",
  // devbi-serve's snapshots (dist/snapshots/): the API answers snapshots/<file>, as it checks who may read them
  "**/snapshots/**/*.arrows",
  "**/snapshots/**/*.tmp",
];

/**
 * A snapshot file's path however it is written (`/snapshots//x.arrows`, `/dist/snapshots/x.arrows/`, `%2E`): only the
 * API answers these, never the dev or preview server's static files (`vite preview` serves dist/ as it is).
 */
export function isSnapshotPath(url: string | undefined): boolean {
  let p = (url ?? "").split(/[?#]/)[0]!;
  try {
    p = decodeURIComponent(p);
  } catch {
    // not a path a static server finds either
  }
  p = p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/[/. ]+$/, "");
  return /(^|\/)snapshots\/(.+\/)?[^/]*\.(arrows|tmp)$/i.test(p);
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
  let embedWarnings: string[] = [];
  let editor: { linked: boolean } | undefined;
  /** The editor's last save of each file: a change to that content is the saving page's own (no reload there). */
  const lastWrites = new Map<string, { version: string; client: string | undefined }>();
  /** The dev server's API (api/*.sql), which also tells .devbi/ the datasets' columns. */
  let devApi: Promise<ApiHandler> | undefined;
  let devEnv: Record<string, string | undefined> | undefined;
  /** A run of .devbi/ that asks the databases for the datasets' columns, and whether another is wanted after it. */
  let describing: Promise<void> | undefined;
  let describeAgain = false;
  /**
   * Ask the datasets' databases for their columns, for .devbi/'s row types (dev server only), in the background: every
   * dataset the first time (the database may have changed since), then those whose SQL changed. One run at a time.
   */
  const describeColumns = (mode: "all" | "changed") => {
    // Not for a test run that starts Vite (Vitest): no databases asked behind the tests.
    if (!devApi || process.env.VITEST) return;
    if (describing) {
      describeAgain = true;
      return;
    }
    const api = devApi;
    describing = (async () => {
      let next: "all" | "changed" = mode;
      do {
        describeAgain = false;
        await generate(dir, { describe: next, api: await api, ...(devEnv ? { env: devEnv } : {}) }).catch(() => undefined);
        next = "changed";
      } while (describeAgain);
    })().finally(() => {
      describing = undefined;
    });
  };

  /**
   * Whether a Host header names this server, as Vite checks it after the plugins' middlewares: its allowedHosts,
   * and no check over HTTPS (a page cannot point another name at it there: the certificate would not match).
   */
  const allowedHost = async (host: string | undefined, preview = false) => {
    if (!host) return false;
    const server = preview ? config.preview : config.server;
    if (server.https || server.allowedHosts === true) return true;
    const { isHostAllowed } = await import("@devbi/server");
    return isHostAllowed(host, server.allowedHosts ?? []);
  };
  /** The key of a file in lastWrites: Vite gives the hooks paths with / on Windows too. */
  const fileKey = (file: string) => posix(path.resolve(file));

  /**
   * The read-only API (api/*.sql) for the dev and preview servers, the same one devbi-serve runs. Connection URLs
   * come from DEVBI_DB… in the environment or Vite's .env files. Database errors are shown as they are (local use).
   */
  const mountApi = (middlewares: Connect.Server, httpServer: { once(event: "close", fn: () => void): unknown } | null, preview: boolean) => {
    if (!existsSync(path.join(dir, "api"))) return;
    const env = { ...process.env, ...loadEnv(config.mode, config.envDir || config.root, "DEVBI_") };
    const handler = import("@devbi/server").then((m) =>
      // api/describe (a dataset's columns, for the GUI editor) on the dev server only
      m.createApiHandler({ dir, env, exposeErrors: true, describe: !preview, log: (line) => config.logger.info(`devbi: ${line}`, { timestamp: true }) }),
    );
    if (!preview) {
      devApi = handler;
      devEnv = env;
    }
    httpServer?.once("close", () => void handler.then((h) => h.close()));
    middlewares.use((req, res, next) => {
      // This runs before Vite's own check of the Host header (DNS rebinding): unknown hosts are left to it.
      handler
        .then(async (h) => {
          if (!(await allowedHost(req.headers.host, preview))) return next();
          if (await h.handle(req, res, asUser(req, preview))) return;
          if (isSnapshotPath(req.url)) {
            res.statusCode = 404;
            res.end();
            return;
          }
          next();
        })
        .catch(next);
    });
  };

  const asUser = (req: IncomingMessage, preview: boolean): RequestOptions =>
    devUserRequest(preview ? "preview" : options.devUsers, req.headers.cookie, devUserOrigin(req, config.server.allowedHosts));

  /** A dashboard, metrics, data or api file, by its path in the project folder; anything else: undefined. */
  const projectChange = (file: string): string | undefined => {
    const rel = posix(path.relative(dir, file));
    const isProjectFile = /^(dashboards\/[^/]+\.dash\.json|models\/[^/]+\.metrics\.yaml)$/.test(rel);
    return isProjectFile || /^(data|api)\//.test(rel) ? rel : undefined;
  };
  /** A promoted tile's file (what virtual:devbi's import.meta.glob takes), by its path in the project folder. */
  const tileChange = (file: string): string | undefined => {
    const rel = posix(path.relative(dir, file));
    return /^dashboards\/.+\.(tsx|jsx)$/.test(rel) && !/(^|\/)node_modules\//.test(rel) ? rel : undefined;
  };
  /** virtual:devbi is read again on the next load; .devbi/ follows models/. */
  const invalidate = (graph: { getModuleById(id: string): unknown; invalidateModule(mod: never): void }, rel: string) => {
    // .devbi/'s names: the metrics files', and the datasets' (api/*.sql) for query.dataset, then their columns.
    if (rel.endsWith(".metrics.yaml") || /^api\/[^/]+\.sql$/.test(rel)) {
      void generate(dir, devEnv ? { env: devEnv } : {}).catch(() => undefined);
      if (rel.startsWith("api/")) describeColumns("changed");
    }
    const mod = graph.getModuleById(RESOLVED);
    if (mod) graph.invalidateModule(mod as never);
  };

  return {
    name: "devbi",
    enforce: "pre",
    // For tools that read the project's Vite config (devbi-check --as, devbi-inspect --as): the options as given.
    api: { devbi: { dirOption: options.dir, devUsers: options.devUsers } satisfies DevbiPluginApi },
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
      // The GUI editor, on the dev server only. Bundled ahead with the rest, so opening it does not make Vite
      // optimize new dependencies and reload the page; from source (a link), only its dependencies are.
      editor = command === "serve" ? findPackage(root, "@devbi/editor") : undefined;
      const include = editor ? [editor.linked ? "@devbi/editor > react-grid-layout" : "@devbi/editor"] : [];
      // A tile the editor writes out ("コードにする") imports these: bundled ahead too, so loading it after the page
      // has opened does not make Vite find a new dependency and reload the page.
      if (editor) for (const name of ["devbi", "@devbi/react"]) if (findPackage(root, name)?.linked === false) include.push(name);
      // DuckDB-wasm is bundled ahead too (not excluded): with @devbi/react from npm, an excluded one imported its own
      // apache-arrow next to the copy in @devbi/react's bundle, and DuckDB took no table DevBI made (xlsx, the API);
      // with pnpm, the bundle's import of it did not resolve from the project at all.
      // Malloy (a Malloy tile) is bundled ahead too, from a linked devbi (from npm, it is in devbi's bundle).
      const core = findPackage(root, "devbi");
      if (command === "serve" && core?.linked) include.push("devbi > @malloydata/malloy", "devbi > @malloydata/malloy/connection");
      // Malloy's parser uses npm's util, which reads process.env.NODE_DEBUG when it loads: there is no process in a browser.
      return { define: { "process.env.NODE_DEBUG": "undefined" }, optimizeDeps: { include }, server: { fs: { deny } } };
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
      // Keep .devbi/ (names for TypeScript and the editors' JSON Schema) in step with models/ and api/: the datasets'
      // columns as last asked, then (dev server) as their databases answer now.
      await generate(dir, devEnv ? { env: devEnv } : {}).catch((e: unknown) => config.logger.warn(`devbi: .devbi/ を書けませんでした: ${(e as Error).message}`));
      describeColumns("all");
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
      const project = await readProject(dir, { ...process.env, ...loadEnv(config.mode, config.envDir || config.root, "DEVBI_") });
      lastData = project.data;
      for (const f of project.watched) this.addWatchFile(f);
      const duck = resolveDuckdb(config.root);
      // On the dev server always (the GUI editor can add an explore tile); in a build, only when a dashboard may show one.
      const psp = config.command === "serve" || mayExplore(project.dashboards) ? resolvePerspective(config.root) : undefined;
      const snapshots = await readSnapshots(dir);
      const prefix = relDir ? `/${relDir}` : "";
      const base = relDir ? `${relDir}/` : "";
      const dev = config.command === "serve";
      // devUsers for the page's 「表示する利用者」: names, and what each is (the API reads the cookie, not these).
      const devUsers = dev ? devUserList(options.devUsers) : [];
      return [
        `import mainModule from ${JSON.stringify(`${posix(duck.wasm)}?url`)};`,
        `import mainWorker from ${JSON.stringify(`${posix(duck.worker)}?url`)};`,
        psp ? `import perspectiveServer from ${JSON.stringify(`${posix(psp.server)}?url`)};` : "",
        psp ? `import perspectiveClient from ${JSON.stringify(`${posix(psp.client)}?url`)};` : "",
        // The dev server tells the page when a project file changes: reload, unless the page saved it itself (the
        // GUI editor) or a listener (the editor with unsaved changes) takes it.
        ...(dev
          ? [
              `const devbiClient = globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);`,
              `const devbiListeners = new Set();`,
              `if (import.meta.hot) import.meta.hot.on("devbi:change", (change) => {`,
              `  if (change.by === devbiClient) return;`,
              `  for (const listener of [...devbiListeners]) if (listener(change) === true) return;`,
              `  location.reload();`,
              `});`,
            ]
          : []),
        `const components = import.meta.glob(${JSON.stringify([`${prefix}/dashboards/**/*.tsx`, `${prefix}/dashboards/**/*.jsx`])});`,
        `export default {`,
        `  dashboards: ${JSON.stringify(project.dashboards)},`,
        `  metrics: ${JSON.stringify(project.metrics)},`,
        Object.keys(project.datasets).length ? `  datasets: ${JSON.stringify(project.datasets)},` : "",
        `  components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k.slice(${prefix.length}), v])),`,
        `  baseUrl: import.meta.env.BASE_URL + ${JSON.stringify(base)},`,
        Object.keys(snapshots).length ? `  snapshots: ${JSON.stringify(snapshots)},` : "",
        `  duckdb: { mainModule, mainWorker },`,
        psp ? `  perspective: { server: perspectiveServer, client: perspectiveClient },` : "",
        options.extensionRepository ? `  extensionRepository: ${JSON.stringify(options.extensionRepository)},` : "",
        dev
          ? [
              `  dev: {`,
              `    client: devbiClient,`,
              `    endpoint: import.meta.env.BASE_URL + "__devbi/editor/",`,
              editor ? `    editor: () => import("@devbi/editor"),` : "",
              // A tile file written after the page loaded (the editor's "コードにする"): not in the glob above yet.
              `    importTile: (path) => import(/* @vite-ignore */ import.meta.env.BASE_URL + ${JSON.stringify(base)} + encodeURI(path.slice(1))),`,
              `    onChange(listener) { devbiListeners.add(listener); return () => devbiListeners.delete(listener); },`,
              devUsers.length ? `    users: ${JSON.stringify(devUsers)},` : "",
              `  },`,
            ].join("\n")
          : "",
        `};`,
      ].join("\n");
    },
    async configureServer(server: ViteDevServer) {
      // devUsers as the API takes users: a mistake stops the dev server here, not each request later.
      if (options.devUsers) {
        const { viewerOf } = await import("@devbi/server");
        for (const [name, u] of Object.entries(options.devUsers)) {
          try {
            if (!name.trim()) throw new TypeError("名前は空でない文字で書いてください");
            if (typeof u !== "object" || u === null || Array.isArray(u)) throw new TypeError("{ roles, attrs } の形で書いてください");
            if (u.id !== undefined && (typeof u.id !== "string" || !u.id.trim())) throw new TypeError("id は空でない文字で書いてください");
            viewerOf(devUserOf(name, u));
          } catch (e) {
            throw new Error(`devbi: devUsers の ${name}: ${(e as Error).message}`);
          }
        }
      }
      mountApi(server.middlewares, server.httpServer, false);
      const handleEditor = createEditorHandler({
        dir,
        allowedHost,
        // As readProject checks it (a save it would refuse is refused here, with the reason).
        problems: async (rel, d) => [
          ...dashboardProblems(dir, rel, d),
          ...datasetProblems(rel, d, await readDatasets(dir, { ...process.env, ...loadEnv(config.mode, config.envDir || config.root, "DEVBI_") })),
        ],
        onWrite: (file, version, client) => lastWrites.set(fileKey(file), { version, client }),
      });
      server.middlewares.use((req, res, next) => {
        handleEditor(req, res).then((handled) => !handled && next(), next);
      });
      server.watcher.add(["dashboards", "models", "data", "api"].map((d) => path.join(dir, d)));
      // Without HMR, Vite calls no hotUpdate hook: reload the page for any project file, as before the editor.
      if (server.config.server.hmr === false) {
        for (const event of ["add", "change", "unlink"] as const) {
          server.watcher.on(event, (file: string) => {
            // A tile file added or removed changes import.meta.glob in virtual:devbi.
            const change = projectChange(file) ?? (event === "change" ? undefined : tileChange(file));
            if (!change) return;
            invalidate(server.environments.client.moduleGraph, change);
            server.ws.send({ type: "full-reload" });
          });
        }
      }
      if (!editor) {
        config.logger.info("devbi: GUI エディタを使うには pnpm add -D @devbi/editor", { timestamp: true });
      }
    },
    hotUpdate: {
      // After Vite's own: for a tile file added or removed, import.meta.glob has put virtual:devbi in the update,
      // which would reload the page at once (and lose the GUI editor's unsaved changes). The page decides instead.
      order: "post",
      async handler({ type, file, read, modules }) {
        if (this.environment.name !== "client") return;
        const project = projectChange(file);
        const tile = project || type === "update" ? undefined : tileChange(file);
        const rel = project ?? tile;
        if (!rel) return;
        invalidate(this.environment.moduleGraph, rel);
        // The GUI editor's own save: the page that saved it has it already.
        let by: string | undefined;
        const last = lastWrites.get(fileKey(file));
        if (last && type !== "delete") {
          const text = await Promise.resolve(read()).catch(() => undefined);
          if (text !== undefined && versionOf(text) === last.version) by = last.client;
        }
        this.environment.hot.send({ type: "custom", event: "devbi:change", data: { file: rel, type, ...(by ? { by } : {}) } });
        // A tile file: Vite still updates the modules that import it (a tile that imported it before it existed).
        return project ? [] : modules.filter((m) => m.id !== RESOLVED);
      },
    },
    configurePreviewServer(server: PreviewServer) {
      mountApi(server.middlewares, server.httpServer, true);
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
