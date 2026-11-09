/** A value that can appear in a filter or a result cell. Dates are JS Dates in UTC. */
export type Scalar = string | number | boolean | null | Date;

/** Time grains for grouping by the time column. */
export type Grain = "day" | "week" | "month" | "quarter" | "year" | "fiscal_year";

export const GRAINS: readonly Grain[] = ["day", "week", "month", "quarter", "year", "fiscal_year"];

/**
 * A filter on one field (a dimension name or the time column name).
 * `between` is half-open: start <= value < end. Either end may be null (open). `unit` is the period's calendar unit
 * (a month of the date-range tile, a clicked month bar): `previous_period` then compares with the unit before (the
 * same days of the previous month), not the same number of days before.
 */
export type Filter =
  | { field: string; in: Scalar[] }
  | { field: string; between: [Scalar, Scalar]; unit?: Grain };

/** Sort by an output field. A string starting with "-" sorts descending. */
export type SortSpec = string | { field: string; desc?: boolean };

/**
 * What a tile asks for: which measures by which dimensions.
 * Tiles never write SQL; the runtime compiles this against a metrics view.
 */
export interface Query {
  /** Name of the metrics view (file `models/<name>.metrics.yaml`). Defaults to the dashboard's. */
  metrics?: string;
  measures?: readonly string[];
  dimensions?: readonly string[];
  /** Group by the time column truncated to this grain. The output field is named after the time column. */
  time?: Grain;
  /** Fixed filters for this tile, applied before selections from other tiles. */
  filters?: readonly Filter[];
  sort?: readonly SortSpec[];
  limit?: number;
  /** `false`: the period (selections on the time column: the date-range tile, a clicked time bucket) does not filter this tile. */
  period?: boolean;
}

/**
 * Names in the project's metrics files, filled in by the generated `.devbi/env.d.ts`
 * (`pnpm gen`, or the Vite plugin on start). Empty when not generated: names are then plain strings.
 *
 * ```ts
 * declare module "devbi" {
 *   interface MetricsRegistry {
 *     sales: { measures: "revenue" | "orders"; dimensions: "customer"; time: "受注日" };
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MetricsRegistry {}

type Registered = [keyof MetricsRegistry] extends [never] ? false : true;
type RegistryPart<K extends "measures" | "dimensions" | "time"> = {
  [V in keyof MetricsRegistry]: MetricsRegistry[V] extends Record<K, infer N extends string> ? N : never;
}[keyof MetricsRegistry];

/** Names of metrics files (`models/<name>.metrics.yaml`). */
export type MetricsName = Registered extends true ? keyof MetricsRegistry & string : string;
/** Measure names across the project's metrics files. */
export type MeasureName = Registered extends true ? RegistryPart<"measures"> : string;
/** Dimension names across the project's metrics files. */
export type DimensionName = Registered extends true ? RegistryPart<"dimensions"> : string;
/** Time column names across the project's metrics files. */
export type TimeName = Registered extends true ? RegistryPart<"time"> : string;

/** A {@link Query} whose names are checked against the generated {@link MetricsRegistry}. */
export interface TypedQuery<
  M extends MeasureName = MeasureName,
  D extends DimensionName = DimensionName,
  T extends Grain | undefined = Grain | undefined,
> extends Query {
  metrics?: MetricsName;
  measures?: readonly M[];
  dimensions?: readonly D[];
  time?: T;
}

/**
 * Declare a tile's query with name completion and checks (after `pnpm gen`), and keep its literal type
 * so {@link RowOf} can type the rows.
 *
 * ```tsx
 * export const query = defineQuery({ measures: ["revenue"], dimensions: ["customer"], limit: 10 });
 * export default function Top({ rows }: TileProps<RowOf<typeof query>>) { rows[0]?.revenue; }
 * ```
 */
export function defineQuery<
  const M extends MeasureName = never,
  const D extends DimensionName = never,
  const T extends Grain | undefined = undefined,
>(query: TypedQuery<M, D, T>): TypedQuery<M, D, T> {
  return query;
}

/**
 * The row type of a query declared with {@link defineQuery}: measures are numbers (or null),
 * dimensions are scalars, and the time column is a Date (or null for empty dates) when the query has a time grain.
 */
export type RowOf<Q> = Q extends TypedQuery<infer M, infer D, infer T>
  ? { [K in M]: number | null } & { [K in D]: Scalar } & ([T] extends [Grain] ? TimeColumns : unknown)
  : Row;

// Without generated names the time column's name is unknown, so it is left out (rather than typing every key).
type TimeColumns = string extends TimeName ? unknown : { [K in TimeName]: Date | null };

export type FieldKind = "dimension" | "time" | "measure";

export interface FieldInfo {
  name: string;
  label: string;
  kind: FieldKind;
  format?: string;
  grain?: Grain;
  /** For comparison measures: how the value relates to the previous period. */
  compare?: "value" | "delta" | "ratio" | "change";
  /** A measure where less is better (`better: lower` in the metrics file): an increase is bad. */
  better?: "lower";
}

/** One row of a query result, keyed by field name. */
export type Row = Record<string, Scalar>;

/** A tile as written in dash.json. Either a built-in `type` or a promoted `component`. */
export interface TileSpec {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  type?: string;
  component?: string;
  query?: Query;
  options?: Record<string, unknown>;
}

/**
 * The contract every tile implements, built-in or promoted to JSX.
 *
 * ```tsx
 * import type { TileProps } from "devbi";
 * export const query = { measures: ["total_revenue"], dimensions: ["customer"], limit: 10 };
 * export default function TopCustomers({ rows, select, format }: TileProps) { ... }
 * ```
 */
export interface TileProps<R extends Row = Row> {
  rows: R[];
  fields: FieldInfo[];
  query: Query;
  /** Filters this tile has set (to highlight what is selected). */
  selection: Filter[];
  /** Filters from other tiles that were applied to `rows`. */
  filters: Filter[];
  /** Set this tile's selection. Other tiles are cross-filtered by it. `null` clears it. */
  select: (filters: Filter | Filter[] | null) => void;
  /** Format a value of the given field for display (measure formats, time grains). */
  format: (value: unknown, field: string) => string;
  /** Display label of a field. */
  label: (field: string) => string;
  loading: boolean;
  error: Error | null;
  tile: TileSpec;
}
