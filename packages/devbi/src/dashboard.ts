import { z } from "zod";
import { GRAINS, type Grain, type TileSpec } from "./types.js";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const filterInput = z.union([
  z.strictObject({ field: z.string().min(1), in: z.array(scalar) }),
  z.strictObject({ field: z.string().min(1), between: z.tuple([scalar, scalar]) }),
]);

const sortInput = z.union([
  z.string().min(1),
  z.strictObject({ field: z.string().min(1), desc: z.boolean().optional() }),
]);

export const queryInput = z.strictObject({
  metrics: z.string().min(1).optional(),
  measures: z.array(z.string().min(1)).optional(),
  dimensions: z.array(z.string().min(1)).optional(),
  time: z.enum(GRAINS as [Grain, ...Grain[]]).optional(),
  filters: z.array(filterInput).optional(),
  sort: z.array(sortInput).optional(),
  limit: z.number().int().positive().optional(),
});

const gridInt = z.number().int().nonnegative();

const tileInput = z
  .strictObject({
    id: z.string().min(1),
    x: gridInt,
    y: gridInt,
    w: z.number().int().positive(),
    h: z.number().int().positive(),
    title: z.string().optional(),
    type: z.string().min(1).optional(),
    component: z.string().min(1).optional(),
    query: queryInput.optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((t) => !!t.type !== !!t.component, { message: "type か component のどちらか一つを書いてください" });

const dashboardInput = z.strictObject({
  $schema: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  /** Default metrics view for the tiles (name of `models/<name>.metrics.yaml`). */
  metrics: z.string().min(1).optional(),
  columns: z.number().int().positive().optional(),
  rowHeight: z.number().int().positive().optional(),
  tiles: z.array(tileInput),
});

export interface Dashboard {
  name: string;
  title: string;
  description?: string;
  metrics?: string;
  columns: number;
  rowHeight: number;
  tiles: TileSpec[];
}

export class DashboardError extends Error {
  constructor(
    readonly source: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(`${source}: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("\n")}`);
    this.name = "DashboardError";
  }
}

/** Check a parsed `*.dash.json`. Throws {@link DashboardError} listing every problem found. */
export function defineDashboard(data: unknown, name: string, source = `${name}.dash.json`): Dashboard {
  const parsed = dashboardInput.safeParse(data, { error: z.locales.ja().localeError });
  if (!parsed.success) {
    throw new DashboardError(
      source,
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const d = parsed.data;
  const issues: { path: string; message: string }[] = [];
  const ids = new Set<string>();
  d.tiles.forEach((t, i) => {
    if (ids.has(t.id)) issues.push({ path: `tiles.${i}.id`, message: `id が重複しています: ${t.id}` });
    ids.add(t.id);
  });
  const columns = d.columns ?? 12;
  d.tiles.forEach((t, i) => {
    if (t.x + t.w > columns) {
      issues.push({ path: `tiles.${i}`, message: `x + w が列数 ${columns} を超えています（${t.id}）` });
    }
  });
  if (issues.length) throw new DashboardError(source, issues);
  return {
    name,
    title: d.title ?? name,
    ...(d.description ? { description: d.description } : {}),
    ...(d.metrics ? { metrics: d.metrics } : {}),
    columns,
    rowHeight: d.rowHeight ?? 80,
    tiles: d.tiles as TileSpec[],
  };
}

/** Parse a `*.dash.json` text. */
export function parseDashboardJson(jsonText: string, name: string, source = `${name}.dash.json`): Dashboard {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    throw new DashboardError(source, [{ path: "", message: `JSON として読めません: ${(e as Error).message}` }]);
  }
  return defineDashboard(data, name, source);
}

/** Validate a tile query given in code (the `query` export of a JSX tile). */
export function checkQuery(data: unknown, source: string) {
  const parsed = queryInput.safeParse(data, { error: z.locales.ja().localeError });
  if (!parsed.success) {
    throw new DashboardError(
      source,
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}
