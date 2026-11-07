/** A value that can appear in a filter or a result cell. Dates are JS Dates in UTC. */
export type Scalar = string | number | boolean | null | Date;

/** Time grains for grouping by the time column. */
export type Grain = "day" | "week" | "month" | "quarter" | "year" | "fiscal_year";

export const GRAINS: readonly Grain[] = ["day", "week", "month", "quarter", "year", "fiscal_year"];

/**
 * A filter on one field (a dimension name or the time column name).
 * `between` is half-open: start <= value < end. Either end may be null (open).
 */
export type Filter =
  | { field: string; in: Scalar[] }
  | { field: string; between: [Scalar, Scalar] };

/** Sort by an output field. A string starting with "-" sorts descending. */
export type SortSpec = string | { field: string; desc?: boolean };

/**
 * What a tile asks for: which measures by which dimensions.
 * Tiles never write SQL; the runtime compiles this against a metrics view.
 */
export interface Query {
  /** Name of the metrics view (file `models/<name>.metrics.yaml`). Defaults to the dashboard's. */
  metrics?: string;
  measures?: string[];
  dimensions?: string[];
  /** Group by the time column truncated to this grain. The output field is named after the time column. */
  time?: Grain;
  /** Fixed filters for this tile, applied before selections from other tiles. */
  filters?: Filter[];
  sort?: SortSpec[];
  limit?: number;
}

export type FieldKind = "dimension" | "time" | "measure";

export interface FieldInfo {
  name: string;
  label: string;
  kind: FieldKind;
  format?: string;
  grain?: Grain;
  /** For comparison measures: how the value relates to the previous period. */
  compare?: "value" | "delta" | "ratio" | "change";
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
