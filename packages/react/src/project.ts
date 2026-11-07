import {
  apiCalls,
  defineDashboard,
  defineMetricsView,
  type Dashboard,
  type MetricsView,
  type Query,
  type TileProps,
} from "devbi";
import type { ComponentType } from "react";
import type { DuckDBBundle } from "./engine.js";

/** A promoted tile module: `export const query = {...}; export default function Tile(props: TileProps) {...}` */
export interface TileModule {
  default: ComponentType<TileProps>;
  query?: Query;
}

/** What `virtual:devbi` (the Vite plugin) provides. Can also be built by hand. */
export interface ProjectInput {
  /** Dashboards by name, as parsed from `dashboards/<name>.dash.json`. */
  dashboards: Record<string, { path: string; spec: unknown }>;
  /** Metrics views by name, as parsed from `models/<name>.metrics.yaml`. */
  metrics: Record<string, { path: string; spec: unknown }>;
  /** Promoted tile modules by path from the project root, such as `/dashboards/sales/TopCustomers.tsx`. */
  components?: Record<string, () => Promise<TileModule>>;
  /** Base URL for data files. */
  baseUrl?: string;
  /** Where the read-only API is, for `read_api(...)`. Default: `api/` under `baseUrl`. */
  apiUrl?: string;
  /** Used for the API requests instead of the global `fetch` (to add a header, for example). */
  fetch?: typeof fetch;
  /**
   * The API's SQL files that are read from a snapshot (`-- snapshot: 06:00` in `api/<name>.sql`), with their times
   * of day: `read_api('<name>', …)` then reads `snapshots/<file>.arrows` under `baseUrl` instead of asking the API.
   */
  snapshots?: Record<string, string[]>;
  duckdb: DuckDBBundle;
  extensionRepository?: string;
}

export interface Project {
  dashboards: Record<string, Dashboard & { path: string }>;
  metrics: Record<string, MetricsView>;
  components: Record<string, () => Promise<TileModule>>;
  baseUrl: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  snapshots: Record<string, string[]>;
  duckdb: DuckDBBundle;
  extensionRepository?: string;
}

/** Validate a project's files. Throws with a Japanese message naming the file. */
export function loadProject(input: ProjectInput): Project {
  const dashboards: Project["dashboards"] = {};
  for (const [name, d] of Object.entries(input.dashboards)) {
    dashboards[name] = { ...defineDashboard(d.spec, name, d.path), path: d.path };
  }
  const metrics: Project["metrics"] = {};
  for (const [name, m] of Object.entries(input.metrics)) metrics[name] = defineMetricsView(m.spec, name, m.path);
  return {
    dashboards,
    metrics,
    components: input.components ?? {},
    baseUrl: input.baseUrl ?? "./",
    ...(input.apiUrl ? { apiUrl: input.apiUrl } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    snapshots: input.snapshots ?? {},
    duckdb: input.duckdb,
    ...(input.extensionRepository ? { extensionRepository: input.extensionRepository } : {}),
  };
}

/** The metrics views a dashboard reads: its own (or the project's only one), and those its tiles name. */
export function viewsOf(project: Project, dashboard: Dashboard): MetricsView[] {
  const all = Object.keys(project.metrics);
  const names = new Set<string>();
  const own = dashboard.metrics ?? (all.length === 1 ? all[0] : undefined);
  if (own) names.add(own);
  for (const t of dashboard.tiles) if (t.query?.metrics) names.add(t.query.metrics);
  return [...names].filter((n) => Object.hasOwn(project.metrics, n)).map((n) => project.metrics[n]!);
}

/** The times of day of the snapshots a dashboard reads (sorted). Empty: it reads the API as it is, or files. */
export function snapshotTimesOf(project: Project, dashboard: Dashboard): string[] {
  const times = new Set<string>();
  for (const view of viewsOf(project, dashboard)) {
    for (const call of apiCalls(view.model)) {
      if (Object.hasOwn(project.snapshots, call.name)) for (const t of project.snapshots[call.name]!) times.add(t);
    }
  }
  return [...times].sort();
}

/** `06:00, 12:30` → `6:00、12:30`. */
export function formatTimesOfDay(times: string[]): string {
  return times.map((t) => t.replace(/^0(\d)/, "$1")).join("、");
}

export { resolveComponent } from "devbi";
