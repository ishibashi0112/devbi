import { getDimension, getMeasure, type CompareMeasure, type MeasureDef, type MetricsView, type RunningMeasure, type SqlMeasure } from "./metrics.js";
import { ident, literal, timeLiteral } from "./sql.js";
import type { FieldInfo, Filter, Grain, Query, Scalar, SortSpec } from "./types.js";

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryError";
  }
}

export interface CompileOptions {
  /** Filters from selections in other tiles. Filters on fields this view does not have are ignored. */
  filters?: Filter[];
  /** Use this SQL instead of the view's model (the runtime passes a materialized table). */
  model?: string;
}

export interface CompiledQuery {
  sql: string;
  fields: FieldInfo[];
}

interface Key {
  name: string;
  /** Expression over the model's columns. */
  expr: string;
}

const MS_PER_DAY = 86_400_000;

/** Expression truncating a date / timestamp expression to a grain. Always returns DATE. */
export function grainExpr(grain: Grain, expr: string, fiscalYearStart = 1): string {
  switch (grain) {
    case "day":
      return `CAST(${expr} AS DATE)`;
    case "fiscal_year":
      if (fiscalYearStart !== 1) {
        const n = fiscalYearStart - 1;
        return `CAST(date_trunc('year', ${expr} - INTERVAL ${n} MONTH) + INTERVAL ${n} MONTH AS DATE)`;
      }
      return `CAST(date_trunc('year', ${expr}) AS DATE)`;
    default:
      return `CAST(date_trunc('${grain}', ${expr}) AS DATE)`;
  }
}

function toDate(v: Scalar): Date | undefined {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string") {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function predicate(f: Filter, expr: string, isTime: boolean): string {
  const lit = isTime ? timeLiteral : literal;
  if ("in" in f) {
    const values = f.in.filter((v) => v !== null);
    const parts: string[] = [];
    if (values.length) parts.push(`${expr} IN (${values.map(lit).join(", ")})`);
    if (values.length !== f.in.length) parts.push(`${expr} IS NULL`);
    if (!parts.length) return "FALSE";
    return parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`;
  }
  const [lo, hi] = f.between;
  const parts: string[] = [];
  if (lo !== null) parts.push(`${expr} >= ${lit(lo)}`);
  if (hi !== null) parts.push(`${expr} < ${lit(hi)}`);
  return parts.length ? parts.join(" AND ") : "TRUE";
}

function where(preds: string[], indent: string): string {
  if (!preds.length) return "";
  return `\n${indent}WHERE ${preds.join(`\n${indent}  AND `)}`;
}

function resolveSort(sort: readonly SortSpec[] | undefined, fields: FieldInfo[]): { field: string; desc: boolean }[] {
  const names = new Set(fields.map((f) => f.name));
  let order: { field: string; desc: boolean }[];
  if (sort?.length) {
    order = sort.map((s) => {
      const spec = typeof s === "string" ? { field: s.replace(/^-/, ""), desc: s.startsWith("-") } : { field: s.field, desc: !!s.desc };
      if (!names.has(spec.field)) throw new QueryError(`並べ替えの ${spec.field} は結果の列にありません`);
      return spec;
    });
  } else {
    const time = fields.find((f) => f.kind === "time");
    const measure = fields.find((f) => f.kind === "measure");
    const hasDims = fields.some((f) => f.kind === "dimension");
    order = time ? [{ field: time.name, desc: false }] : measure && hasDims ? [{ field: measure.name, desc: true }] : [];
  }
  // Break ties with the group keys (time, then the dimensions in order). Each row has its own keys, so the order,
  // and the rows a limit keeps, are the same on every run and machine (DuckDB's parallel GROUP BY has no order).
  const used = new Set(order.map((o) => o.field));
  const keys = [...fields.filter((f) => f.kind === "time"), ...fields.filter((f) => f.kind === "dimension")];
  return [...order, ...keys.filter((f) => !used.has(f.name)).map((f) => ({ field: f.name, desc: false }))];
}

function orderLimit(order: { field: string; desc: boolean }[], limit: number | undefined, prefix = ""): string {
  let s = "";
  if (order.length) {
    s += `\nORDER BY ${order.map((o) => `${prefix}${ident(o.field)} ${o.desc ? "DESC" : "ASC"} NULLS LAST`).join(", ")}`;
  }
  if (limit !== undefined) s += `\nLIMIT ${Math.floor(limit)}`;
  return s;
}

/**
 * Compile a tile query against a metrics view into DuckDB SQL.
 *
 * - Measures that reference other measures are expanded inline.
 * - `compare` measures join the same aggregation over a shifted time range.
 * - `running` measures are window sums over the time grain.
 */
export function compileQuery(view: MetricsView, query: Query, options: CompileOptions = {}): CompiledQuery {
  const measures: MeasureDef[] = (query.measures ?? []).map((n) => {
    const m = getMeasure(view, n);
    if (!m) throw new QueryError(`指標 ${n} は ${view.name} にありません`);
    return m;
  });
  const dims: Key[] = (query.dimensions ?? []).map((n) => {
    const d = getDimension(view, n);
    if (!d) throw new QueryError(`軸 ${n} は ${view.name} にありません`);
    return { name: d.name, expr: d.expr };
  });
  const grain = query.time;
  const time = view.time;
  if (grain && !time) throw new QueryError(`${view.name} には time（日付の列）がありません`);
  if (!measures.length && !dims.length && !grain) throw new QueryError("measures か dimensions を一つ以上指定してください");

  const fieldOf = (name: string): { expr: string; isTime: boolean } | undefined => {
    if (time && name === time.name) return { expr: time.expr, isTime: true };
    const d = getDimension(view, name);
    return d ? { expr: d.expr, isTime: false } : undefined;
  };
  for (const f of query.filters ?? []) {
    if (!fieldOf(f.field)) throw new QueryError(`フィルタの ${f.field} は ${view.name} の軸にありません`);
  }
  const filters = [...(query.filters ?? []), ...(options.filters ?? [])].filter((f) => fieldOf(f.field));
  const preds = (timeExpr: string | undefined) =>
    filters.map((f) => {
      const { expr, isTime } = fieldOf(f.field)!;
      return predicate(f, isTime && timeExpr ? timeExpr : expr, isTime);
    });

  const keys: Key[] = [...dims];
  if (grain && time) keys.push({ name: time.name, expr: grainExpr(grain, time.expr, time.fiscalYearStart) });

  const fields: FieldInfo[] = [
    ...dims.map((d) => {
      const def = view.dimensions[d.name]!;
      return { name: d.name, label: def.label, kind: "dimension" as const, ...(def.format ? { format: def.format } : {}) };
    }),
    ...(grain && time ? [{ name: time.name, label: time.label, kind: "time" as const, grain }] : []),
    ...measures.map((m) => ({
      name: m.name,
      label: m.label,
      kind: "measure" as const,
      ...(m.format ? { format: m.format } : {}),
      ...(m.kind === "compare" ? { compare: m.as } : {}),
    })),
  ];
  const order = resolveSort(query.sort, fields);
  const model = options.model ?? view.model;
  const head = `WITH ${ident("__model")} AS (\n${indent(model, "  ")}\n)`;
  const from = `FROM ${ident("__model")}`;

  const simple = measures.every((m) => m.kind === "sql");
  if (simple) {
    const cols = [
      ...keys.map((k) => `${k.expr} AS ${ident(k.name)}`),
      ...(measures as SqlMeasure[]).map((m) => `${m.expr} AS ${ident(m.name)}`),
    ];
    const group = keys.length ? "\nGROUP BY ALL" : "";
    const sql = `${head}\nSELECT\n  ${cols.join(",\n  ")}\n${from}${where(preds(undefined), "")}${group}${orderLimit(order, query.limit)}`;
    return { sql, fields };
  }

  // Aggregates needed in the current period: requested sql measures and every `of` target.
  const aggs = new Map<string, SqlMeasure>();
  for (const m of measures) {
    const target = m.kind === "sql" ? m : (getMeasure(view, m.of) as SqlMeasure);
    aggs.set(target.name, target);
  }
  const range = timeRange(filters, time?.name);
  const ctes: string[] = [];
  const aggCols = (list: SqlMeasure[]) => list.map((m) => `${m.expr} AS ${ident(m.name)}`);
  ctes.push(cte("__cur", keys.map((k) => `${k.expr} AS ${ident(k.name)}`), aggCols([...aggs.values()]), preds(undefined)));

  // One shifted aggregation per comparison kind.
  const joins: string[] = [];
  const prevAlias = new Map<string, string | null>();
  for (const m of measures) {
    if (m.kind !== "compare" || prevAlias.has(m.compare)) continue;
    const shift = shiftInterval(m.compare, grain, range);
    if (!shift) {
      prevAlias.set(m.compare, null);
      continue;
    }
    const alias = `p${prevAlias.size + 1}`;
    prevAlias.set(m.compare, alias);
    const shifted = `(${time!.expr} + ${shift})`;
    const prevKeys = keys.map((k) =>
      k.name === time!.name && grain ? `${grainExpr(grain, shifted, time!.fiscalYearStart)} AS ${ident(k.name)}` : `${k.expr} AS ${ident(k.name)}`,
    );
    const targets = [...new Set(measures.filter((x): x is CompareMeasure => x.kind === "compare" && x.compare === m.compare).map((x) => x.of))];
    const name = `__${m.compare}`;
    // `+ INTERVAL 1 YEAR` maps Feb 29 onto Feb 28; by the day that would count two days of last year, and Feb 29 has no match anyway.
    const leapDay = m.compare === "previous_year" && grain === "day" ? [`NOT (month(${time!.expr}) = 2 AND day(${time!.expr}) = 29)`] : [];
    ctes.push(cte(name, prevKeys, aggCols(targets.map((t) => view.measures[t] as SqlMeasure)), [...preds(shifted), ...leapDay]));
    const on = keys.length ? keys.map((k) => `c.${ident(k.name)} IS NOT DISTINCT FROM ${alias}.${ident(k.name)}`).join("\n  AND ") : "TRUE";
    joins.push(`LEFT JOIN ${ident(name)} AS ${alias}\n  ON ${on}`);
  }

  const timeKey = grain && time ? `c.${ident(time.name)}` : undefined;
  const cols = [
    ...keys.map((k) => `c.${ident(k.name)}`),
    ...measures.map((m) => `${measureOut(m, prevAlias, timeKey, dims, time?.fiscalYearStart ?? 1)} AS ${ident(m.name)}`),
  ];
  const sql = `${head},\n${ctes.join(",\n")}\nSELECT\n  ${cols.join(",\n  ")}\nFROM ${ident("__cur")} AS c${joins.map((j) => `\n${j}`).join("")}${orderLimit(order, query.limit)}`;
  return { sql, fields };
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");
}

function cte(name: string, keys: string[], aggs: string[], preds: string[]): string {
  const cols = [...keys, ...aggs];
  const group = keys.length ? "\n  GROUP BY ALL" : "";
  return `${ident(name)} AS (\n  SELECT\n    ${cols.join(",\n    ")}\n  FROM ${ident("__model")}${where(preds, "  ")}${group}\n)`;
}

function measureOut(
  m: MeasureDef,
  prevAlias: Map<string, string | null>,
  timeKey: string | undefined,
  dims: Key[],
  fiscalYearStart: number,
): string {
  if (m.kind === "sql") return `c.${ident(m.name)}`;
  const cur = `c.${ident(m.of)}`;
  if (m.kind === "running") return runningOut(m, cur, timeKey, dims, fiscalYearStart);
  const alias = prevAlias.get(m.compare);
  if (!alias) return "CAST(NULL AS DOUBLE)";
  const prev = `${alias}.${ident(m.of)}`;
  switch (m.as) {
    case "value":
      return prev;
    case "delta":
      return `${cur} - ${prev}`;
    case "ratio":
      return `${cur} / NULLIF(${prev}, 0)`;
    case "change":
      return `${cur} / NULLIF(${prev}, 0) - 1`;
  }
}

function runningOut(m: RunningMeasure, cur: string, timeKey: string | undefined, dims: Key[], fiscalYearStart: number): string {
  if (!timeKey) return cur;
  const partition = dims.map((d) => `c.${ident(d.name)}`);
  if (m.reset === "year") partition.push(grainExpr("year", timeKey));
  if (m.reset === "fiscal_year") partition.push(grainExpr("fiscal_year", timeKey, fiscalYearStart));
  const by = partition.length ? `PARTITION BY ${partition.join(", ")} ` : "";
  return `SUM(${cur}) OVER (${by}ORDER BY ${timeKey} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
}

/** The intersection of `between` filters on the time column. */
export function timeRange(filters: Filter[], timeName: string | undefined): { start?: Date; end?: Date } {
  let start: Date | undefined;
  let end: Date | undefined;
  if (!timeName) return {};
  for (const f of filters) {
    if (f.field !== timeName || !("between" in f)) continue;
    const lo = f.between[0] === null ? undefined : toDate(f.between[0]);
    const hi = f.between[1] === null ? undefined : toDate(f.between[1]);
    if (lo && (!start || lo > start)) start = lo;
    if (hi && (!end || hi < end)) end = hi;
  }
  return { ...(start ? { start } : {}), ...(end ? { end } : {}) };
}

const PERIOD_INTERVAL: Record<Grain, string> = {
  day: "INTERVAL 1 DAY",
  week: "INTERVAL 7 DAY",
  month: "INTERVAL 1 MONTH",
  quarter: "INTERVAL 3 MONTH",
  year: "INTERVAL 1 YEAR",
  fiscal_year: "INTERVAL 1 YEAR",
};

/**
 * How far back the comparison period is, or undefined when the current period is unbounded
 * (no time grain and no closed time range), in which case the comparison is NULL.
 */
function shiftInterval(
  compare: CompareMeasure["compare"],
  grain: Grain | undefined,
  range: { start?: Date; end?: Date },
): string | undefined {
  const bounded = !!grain || (!!range.start && !!range.end);
  if (!bounded) return undefined;
  if (compare === "previous_year") return grain === "week" ? "INTERVAL 364 DAY" : "INTERVAL 1 YEAR";
  if (grain) return PERIOD_INTERVAL[grain];
  const days = Math.round((range.end!.getTime() - range.start!.getTime()) / MS_PER_DAY);
  return days > 0 ? `INTERVAL ${days} DAY` : undefined;
}

/** SQL for the min and max of the time column, for period pickers. */
export function compileTimeExtent(view: MetricsView, options: CompileOptions = {}): string {
  if (!view.time) throw new QueryError(`${view.name} には time（日付の列）がありません`);
  const model = options.model ?? view.model;
  return `WITH ${ident("__model")} AS (\n${indent(model, "  ")}\n)\nSELECT\n  MIN(${view.time.expr}) AS ${ident("min")},\n  MAX(${view.time.expr}) AS ${ident("max")}\nFROM ${ident("__model")}`;
}
