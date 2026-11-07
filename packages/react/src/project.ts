import {
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
  duckdb: DuckDBBundle;
  extensionRepository?: string;
}

export interface Project {
  dashboards: Record<string, Dashboard & { path: string }>;
  metrics: Record<string, MetricsView>;
  components: Record<string, () => Promise<TileModule>>;
  baseUrl: string;
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
    duckdb: input.duckdb,
    ...(input.extensionRepository ? { extensionRepository: input.extensionRepository } : {}),
  };
}

export { resolveComponent } from "devbi";
