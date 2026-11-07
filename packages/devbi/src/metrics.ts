import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ident, replaceIdentifiers, scanIdentifiers, trimSql } from "./sql.js";

const NAME_RE = /^[\p{L}_][\p{L}\p{N}_]*$/u;

const text = z.string().min(1);

const dimensionInput = z.union([
  text,
  z.strictObject({
    column: text.optional(),
    sql: text.optional(),
    label: text.optional(),
    description: z.string().optional(),
    format: z.string().optional(),
  }),
]);

const compareInput = z.strictObject({
  of: text,
  compare: z.enum(["previous_year", "previous_period"]),
  as: z.enum(["value", "delta", "ratio", "change"]).optional(),
  label: text.optional(),
  description: z.string().optional(),
  format: z.string().optional(),
});

const runningInput = z.strictObject({
  of: text,
  running: z.union([z.literal(true), z.enum(["all", "year", "fiscal_year"])]),
  label: text.optional(),
  description: z.string().optional(),
  format: z.string().optional(),
});

const sqlMeasureInput = z.strictObject({
  sql: text,
  label: text.optional(),
  description: z.string().optional(),
  format: z.string().optional(),
});

const measureInput = z.union([text, sqlMeasureInput, compareInput, runningInput]);

const timeInput = z.union([
  text,
  z.strictObject({
    column: text,
    label: text.optional(),
    fiscal_year_start: z.number().int().min(1).max(12).optional(),
  }),
]);

const metricsInput = z.strictObject({
  label: text.optional(),
  description: z.string().optional(),
  model: text,
  time: timeInput.optional(),
  dimensions: z.record(z.string(), dimensionInput).optional(),
  measures: z.record(z.string(), measureInput),
});

export type MetricsViewInput = z.input<typeof metricsInput>;

export interface DimensionDef {
  name: string;
  label: string;
  /** SQL expression over the model's columns. */
  expr: string;
  description?: string;
  format?: string;
}

export interface TimeDef {
  /** Output field name; the same as the column. */
  name: string;
  column: string;
  label: string;
  expr: string;
  /** Month (1-12) the fiscal year starts. 1 = calendar year. */
  fiscalYearStart: number;
}

interface MeasureBase {
  name: string;
  label: string;
  format?: string;
  description?: string;
}

export interface SqlMeasure extends MeasureBase {
  kind: "sql";
  /** As written in the YAML. */
  sql: string;
  /** With references to other measures expanded. An aggregate expression. */
  expr: string;
  /** Measures referenced directly by `sql`. */
  refs: string[];
}

export interface CompareMeasure extends MeasureBase {
  kind: "compare";
  of: string;
  compare: "previous_year" | "previous_period";
  as: "value" | "delta" | "ratio" | "change";
}

export interface RunningMeasure extends MeasureBase {
  kind: "running";
  of: string;
  reset: "all" | "year" | "fiscal_year";
}

export type MeasureDef = SqlMeasure | CompareMeasure | RunningMeasure;

export interface MetricsView {
  name: string;
  label: string;
  description?: string;
  /** Model SQL with trailing semicolons removed. */
  model: string;
  time?: TimeDef;
  dimensions: Record<string, DimensionDef>;
  measures: Record<string, MeasureDef>;
}

export interface MetricsIssue {
  path: string;
  message: string;
}

export class MetricsError extends Error {
  constructor(
    readonly source: string,
    readonly issues: MetricsIssue[],
  ) {
    super(`${source}: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("\n")}`);
    this.name = "MetricsError";
  }
}

const COMPARE_LABEL: Record<CompareMeasure["compare"], Record<CompareMeasure["as"], string>> = {
  previous_year: { value: "前年", delta: "前年差", ratio: "前年比", change: "前年増減率" },
  previous_period: { value: "前期間", delta: "前期間差", ratio: "前期間比", change: "前期間増減率" },
};

/** Parse and check a `*.metrics.yaml` text. Throws {@link MetricsError} listing every problem found. */
export function parseMetricsYaml(yamlText: string, name: string, source = `${name}.metrics.yaml`): MetricsView {
  let data: unknown;
  try {
    data = parseYaml(yamlText);
  } catch (e) {
    throw new MetricsError(source, [{ path: "", message: `YAML として読めません: ${(e as Error).message}` }]);
  }
  return defineMetricsView(data, name, source);
}

/** Check a metrics view given as a plain object (the parsed YAML). */
export function defineMetricsView(data: unknown, name: string, source = `${name}.metrics.yaml`): MetricsView {
  const parsed = metricsInput.safeParse(data, { error: z.locales.ja().localeError });
  if (!parsed.success) {
    throw new MetricsError(
      source,
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const input = parsed.data;
  const issues: MetricsIssue[] = [];
  const checkName = (path: string, n: string) => {
    if (!NAME_RE.test(n)) issues.push({ path, message: `名前に使えるのは文字・数字・_ だけで、先頭は数字以外です: ${n}` });
  };

  let time: TimeDef | undefined;
  if (input.time !== undefined) {
    const t = typeof input.time === "string" ? { column: input.time } : input.time;
    time = {
      name: t.column,
      column: t.column,
      label: ("label" in t && t.label) || t.column,
      expr: ident(t.column),
      fiscalYearStart: ("fiscal_year_start" in t && t.fiscal_year_start) || 1,
    };
  }

  const dimensions: Record<string, DimensionDef> = {};
  for (const [dname, d] of Object.entries(input.dimensions ?? {})) {
    checkName(`dimensions.${dname}`, dname);
    const def = typeof d === "string" ? { column: d } : d;
    if (!!def.column === !!def.sql) {
      issues.push({ path: `dimensions.${dname}`, message: "column か sql のどちらか一つを書いてください" });
      continue;
    }
    if (time && dname === time.name) {
      issues.push({ path: `dimensions.${dname}`, message: `time の列と同じ名前は使えません: ${dname}` });
    }
    dimensions[dname] = {
      name: dname,
      label: ("label" in def && def.label) || dname,
      expr: def.column ? ident(def.column) : `(${def.sql})`,
      ...("description" in def && def.description ? { description: def.description } : {}),
      ...("format" in def && def.format ? { format: def.format } : {}),
    };
  }

  const measures: Record<string, MeasureDef> = {};
  for (const [mname, m] of Object.entries(input.measures)) {
    checkName(`measures.${mname}`, mname);
    if (mname in dimensions || (time && mname === time.name)) {
      issues.push({ path: `measures.${mname}`, message: `軸と同じ名前は使えません: ${mname}` });
    }
    const base = (def: { label?: string; description?: string; format?: string }) => ({
      name: mname,
      label: def.label ?? mname,
      ...(def.description ? { description: def.description } : {}),
      ...(def.format ? { format: def.format } : {}),
    });
    if (typeof m === "string" || "sql" in m) {
      const def = typeof m === "string" ? { sql: m } : m;
      measures[mname] = { kind: "sql", ...base(def), sql: trimSql(def.sql), expr: "", refs: [] };
    } else if ("compare" in m) {
      measures[mname] = { kind: "compare", ...base(m), of: m.of, compare: m.compare, as: m.as ?? "ratio" };
    } else {
      measures[mname] = { kind: "running", ...base(m), of: m.of, reset: m.running === true ? "all" : m.running };
    }
  }

  // Resolve references between sql measures, and `of` targets.
  const sqlNames = new Set(Object.values(measures).filter((m) => m.kind === "sql").map((m) => m.name));
  for (const m of Object.values(measures)) {
    if (m.kind !== "sql") continue;
    m.refs = [
      ...new Set(
        scanIdentifiers(m.sql)
          .filter((t) => !t.qualified && !t.call && t.name !== m.name && t.name in measures)
          .map((t) => t.name),
      ),
    ];
    for (const r of m.refs) {
      if (!sqlNames.has(r)) {
        issues.push({
          path: `measures.${m.name}`,
          message: `${r} は前年比・累計の指標なので式の中では使えません。式は sql の指標だけを参照できます`,
        });
      }
    }
  }
  const expanding = new Set<string>();
  const expand = (name: string, path: string[]): string => {
    const m = measures[name] as SqlMeasure;
    if (m.expr) return m.expr;
    if (expanding.has(name)) {
      issues.push({ path: `measures.${path[0]}`, message: `指標の参照が循環しています: ${[...path, name].join(" → ")}` });
      return "NULL";
    }
    expanding.add(name);
    const expr = replaceIdentifiers(m.sql, (id) =>
      id !== name && sqlNames.has(id) ? `(${expand(id, [...path, name])})` : undefined,
    );
    expanding.delete(name);
    m.expr = expr;
    return expr;
  };
  for (const name of sqlNames) expand(name, []);

  for (const m of Object.values(measures)) {
    if (m.kind === "sql") continue;
    const target = measures[m.of];
    if (!target) {
      issues.push({ path: `measures.${m.name}.of`, message: `指標 ${m.of} がありません` });
      continue;
    }
    if (target.kind !== "sql") {
      issues.push({ path: `measures.${m.name}.of`, message: `of には sql の指標を指定してください（${m.of} は ${target.kind}）` });
      continue;
    }
    if (!time) {
      issues.push({ path: `measures.${m.name}`, message: "前年比・累計を使うには time（日付の列）を書いてください" });
    }
    if (m.kind === "compare") {
      if (m.label === m.name) m.label = `${target.label} ${COMPARE_LABEL[m.compare][m.as]}`;
      if (!m.format) {
        const fmt = m.as === "ratio" || m.as === "change" ? "0.0%" : target.format;
        if (fmt) m.format = fmt;
      }
    } else {
      if (m.label === m.name) m.label = `${target.label} 累計`;
      if (!m.format && target.format) m.format = target.format;
    }
  }

  if (issues.length) throw new MetricsError(source, issues);
  return {
    name,
    label: input.label ?? name,
    ...(input.description ? { description: input.description } : {}),
    model: trimSql(input.model),
    ...(time ? { time } : {}),
    dimensions,
    measures,
  };
}
