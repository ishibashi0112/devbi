/**
 * Dashboard parameters (SSRS's report parameters): the values the `-- param:` lines of a dataset (`api/<name>.sql`)
 * ask for, shown above the tiles that read it (`query.dataset`). Shared by the browser (the parameter bar), the build
 * (what is embedded) and devbi-check: merging the definitions, defaults (`today`, `fiscal_year_start`, `all`), the
 * values in a URL.
 */
import type { TileSpec } from "./types.js";

export type ParamType = "text" | "integer" | "number" | "date" | "datetime" | "boolean";

export const PARAM_TYPES: readonly ParamType[] = ["text", "integer", "number", "date", "datetime", "boolean"];

/** A parameter of a dataset as `api/schema` lists it (and the build embeds it): its `-- param:` line, or only a name. */
export interface DatasetParameter {
  name: string;
  type?: ParamType;
  multiple?: boolean;
  label?: string;
  /** As written on the line: a value, a word (`today`, `all`…), or values separated by `,`. */
  default?: string;
  /** The dataset whose rows are the choices (1st column the value, 2nd the label). */
  values?: string;
  optional?: boolean;
  hidden?: boolean;
}

/** What the page knows of a dataset (embedded by the build): its parameters and the columns that tell rows apart. */
export interface DatasetInfo {
  parameters: DatasetParameter[];
  key?: string[];
}

/** One value of a parameter. Dates are `YYYY-MM-DD` text, dates and times `YYYY-MM-DDTHH:MM[:SS]`. */
export type ParamScalar = string | number | boolean | null;
/** A parameter's value: a list for a multiple-value one (without nulls). */
export type ParamValue = ParamScalar | Exclude<ParamScalar, null>[];

/** A parameter in dash.json's `params`: the same keys as a `-- param:` line, which it overrides. */
export interface DashboardParamSpec {
  /** `date`, or `text[]` for several values. */
  type?: string;
  label?: string;
  /** A value (a list for several values), or a word as on a `-- param:` line (`fiscal_year_start`, `all`). */
  default?: ParamValue;
  values?: string;
  optional?: boolean;
  hidden?: boolean;
}

/** What a tile's `query.params` puts in a dataset's parameter: a dashboard parameter, or a value of its own. */
export type ParamBinding = { param: string } | ParamValue;

/** A parameter of a dashboard: one input in the bar above the tiles. */
export interface DashboardParam {
  name: string;
  /** Undefined: a parameter without a `-- param:` line (any value, as text). */
  type?: ParamType;
  multiple: boolean;
  label: string;
  /** As written (`-- param:` text, or dash.json's value). See {@link resolveDefault}. */
  default?: ParamValue;
  values?: string;
  optional: boolean;
  hidden: boolean;
}

/** Day words of a default (date and datetime): today, the start of this month… with `+N` / `-N` days. */
export const DAY_WORDS = /^(today|tomorrow|yesterday|month_start|next_month_start|previous_month_start|year_start|fiscal_year_start)([+-][0-9]{1,5})?$/;

const lower = (s: string) => s.toLowerCase();

/** A query's binding of one of its dataset's parameters (names compare without case, as in SQL). */
function bindingOf(params: Record<string, ParamBinding> | undefined, name: string): ParamBinding | undefined {
  if (!params) return undefined;
  const key = Object.keys(params).find((k) => lower(k) === lower(name));
  return key === undefined ? undefined : params[key];
}

export function isParamRef(b: ParamBinding | undefined): b is { param: string } {
  return typeof b === "object" && b !== null && !Array.isArray(b) && typeof (b as { param?: unknown }).param === "string";
}

/** The type of a dash.json `type` (`text[]` → text, several values). Undefined when it is not one. */
export function parseParamType(text: string): { type: ParamType; multiple: boolean } | undefined {
  const m = /^([a-z]+)(\[\])?$/.exec(text);
  if (!m || !(PARAM_TYPES as readonly string[]).includes(m[1]!)) return undefined;
  return { type: m[1] as ParamType, multiple: !!m[2] };
}

/** `type` as written: `date`, `text[]`. */
export function paramTypeText(p: { type?: ParamType; multiple?: boolean }): string {
  return `${p.type ?? "text"}${p.multiple ? "[]" : ""}`;
}

/** The tiles that read a dataset, in the order they are shown (top to bottom, left to right). */
export function datasetTiles(tiles: readonly TileSpec[]): TileSpec[] {
  return [...tiles].filter((t) => typeof t.query?.dataset === "string").sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * How a dataset tile fills its dataset's parameters: each from a dashboard parameter (the same name unless
 * `query.params` says `{ "param": … }`), or a value of the tile's own.
 */
export function tileBindings(
  tile: TileSpec,
  dataset: DatasetInfo,
): { name: string; param?: string; value?: ParamValue }[] {
  return dataset.parameters.map((p) => {
    const b = bindingOf(tile.query?.params as Record<string, ParamBinding> | undefined, p.name);
    if (b === undefined) return { name: p.name, param: p.name };
    if (isParamRef(b)) return { name: p.name, param: b.param };
    return { name: p.name, value: b };
  });
}

interface Source {
  /** Where it comes from, for messages: `api/order_lines.sql`. */
  from: string;
  def: DatasetParameter;
}

const KEYS = ["label", "default", "values", "optional", "hidden"] as const;

/**
 * The parameters of a dashboard, from the datasets its tiles read (and the datasets of their choices) and dash.json's
 * `params`: one per name, in the order of `params` and then of the tiles. `problems` lists what cannot be merged (the
 * same name with two types, or two labels that dash.json does not settle), as Japanese sentences.
 */
export function dashboardParams(
  dashboard: { tiles: readonly TileSpec[]; params?: Record<string, DashboardParamSpec> },
  datasets: Record<string, DatasetInfo>,
): { params: DashboardParam[]; problems: string[] } {
  const problems: string[] = [];
  const order: string[] = [];
  const sources = new Map<string, Source[]>();
  const specs = dashboard.params ?? {};
  const add = (name: string, src?: Source) => {
    const key = lower(name);
    if (!sources.has(key)) {
      sources.set(key, []);
      order.push(name);
    }
    if (src) sources.get(key)!.push(src);
  };
  for (const name of Object.keys(specs)) add(name);
  const has = (name: string) => Object.hasOwn(datasets, name);

  for (const t of datasetTiles(dashboard.tiles)) {
    const name = t.query!.dataset!;
    if (!has(name)) {
      problems.push(`タイル ${t.id}: データセット ${name} がありません（api/${name}.sql）`);
      continue;
    }
    const ds = datasets[name]!;
    for (const key of Object.keys(t.query?.params ?? {})) {
      if (!ds.parameters.some((p) => lower(p.name) === lower(key))) {
        const names = ds.parameters.map((p) => p.name);
        problems.push(
          `タイル ${t.id}: query.params の ${key} は api/${name}.sql のパラメーターにありません（${names.length ? `あるのは ${names.join("、")}` : "パラメーターはありません"}）`,
        );
      }
    }
    for (const b of tileBindings(t, ds)) {
      if (b.param === undefined) continue;
      const def = ds.parameters.find((p) => p.name === b.name)!;
      add(b.param, { from: `api/${name}.sql`, def });
    }
  }

  // The datasets of the choices read the dashboard's parameters of the same names (cascading choices).
  const merged = new Map<string, DashboardParam>();
  const expanded = new Map<string, string>();
  const valuesOf = (key: string): string | undefined => {
    const spec = specFor(specs, key);
    if (spec && Object.hasOwn(spec, "values")) return spec.values;
    return sources.get(key)?.find((s) => s.def.values)?.def.values;
  };
  // Until nothing changes: a parameter the choices add may have choices of its own.
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of [...order]) {
      const key = lower(name);
      const v = valuesOf(key);
      if (v === undefined || expanded.get(key) === v) continue;
      expanded.set(key, v);
      changed = true;
      if (!has(v)) {
        problems.push(`パラメーター ${name} の候補のデータセット ${v} がありません（api/${v}.sql）`);
        continue;
      }
      for (const def of datasets[v]!.parameters) add(def.name, { from: `api/${v}.sql（${name} の候補）`, def });
    }
  }
  // A ring of choices (A's choices need B, whose choices need A) never settles.
  const needs = (key: string): string[] => {
    const v = valuesOf(key);
    return v !== undefined && has(v) ? datasets[v]!.parameters.map((p) => lower(p.name)) : [];
  };
  for (const name of order) {
    const start = lower(name);
    const seen = new Set<string>();
    const stack = [...needs(start)];
    while (stack.length) {
      const k = stack.pop()!;
      if (k === start) {
        problems.push(`パラメーター ${name} の候補が、まわりまわって ${name} 自身の値を使っています（values の輪）`);
        break;
      }
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push(...needs(k));
    }
  }

  for (const name of order) {
    const key = lower(name);
    const spec = specFor(specs, key);
    const list = sources.get(key)!;
    const typed = list.filter((s) => s.def.type);
    let type: { type: ParamType; multiple: boolean } | undefined;
    for (const s of typed) {
      const t = { type: s.def.type!, multiple: !!s.def.multiple };
      if (!type) type = t;
      else if (type.type !== t.type || type.multiple !== t.multiple) {
        const first = typed[0]!;
        problems.push(`パラメーター ${name} の型が ${first.from}（${paramTypeText(first.def)}）と ${s.from}（${paramTypeText(s.def)}）で違います`);
        break;
      }
    }
    if (spec?.type !== undefined) {
      const t = parseParamType(spec.type);
      if (!t) problems.push(`params の ${name}: type「${spec.type}」は使えません（${PARAM_TYPES.join("・")}。複数の値は text[] のように）`);
      else if (type && (type.type !== t.type || type.multiple !== t.multiple)) {
        problems.push(`params の ${name}: type「${spec.type}」が ${typed[0]!.from} の ${paramTypeText(typed[0]!.def)} と違います`);
      } else type = t;
    }
    if (!list.length && spec?.type === undefined) {
      problems.push(`params の ${name} は、どのデータセットのパラメーターでもないので type を書いてください`);
    }
    const p: DashboardParam = {
      name,
      ...(type ? { type: type.type } : {}),
      multiple: !!type?.multiple,
      label: name,
      optional: false,
      hidden: false,
    };
    for (const k of KEYS) {
      const given = spec && Object.hasOwn(spec, k) ? spec[k] : undefined;
      if (given !== undefined) {
        (p as unknown as Record<string, unknown>)[k] = given;
        continue;
      }
      const seen = typed.filter((s) => s.def[k] !== undefined);
      const first = seen[0];
      if (!first) continue;
      const other = seen.find((s) => JSON.stringify(s.def[k]) !== JSON.stringify(first.def[k]));
      if (other) {
        problems.push(
          `パラメーター ${name} の ${k} が ${first.from} と ${other.from} で違います。dash.json の params に ${name} の ${k} を書いて決めてください`,
        );
      }
      (p as unknown as Record<string, unknown>)[k] = first.def[k];
    }
    const defaultProblem = p.default === undefined ? undefined : defaultIssue(p);
    if (defaultProblem) problems.push(`パラメーター ${name} の default: ${defaultProblem}`);
    if (p.multiple && p.optional) problems.push(`パラメーター ${name}: 複数の値のパラメーターは optional にできません（1 つ以上を選びます）`);
    merged.set(key, p);
  }
  return { params: order.map((n) => merged.get(lower(n))!), problems };
}

function specFor(specs: Record<string, DashboardParamSpec>, key: string): DashboardParamSpec | undefined {
  const k = Object.keys(specs).find((n) => lower(n) === key);
  return k === undefined ? undefined : specs[k];
}

/** A day word (`today`, `month_start-1`…) for a date or datetime parameter. */
const isDayWord = (p: { type?: ParamType }, text: string) => (p.type === "date" || p.type === "datetime") && DAY_WORDS.test(text);

/**
 * Why a default does not fit its parameter, or undefined. As the server reads a `-- param:` line: each value of a
 * list may be a day word; `all` is every choice with `values`, and the text "all" itself without (an error unless text).
 */
function defaultIssue(p: DashboardParam): string | undefined {
  const d = p.default;
  if (Array.isArray(d)) {
    if (!p.multiple) return "1 つの値のパラメーターに配列は書けません";
    for (const v of d) {
      if (typeof v === "string" && isDayWord(p, v)) continue;
      const bad = scalarIssue(p, v);
      if (bad) return bad;
    }
    return undefined;
  }
  if (typeof d === "string") {
    if (p.multiple && d === "all" && p.values) return undefined;
    const parts = p.multiple ? splitList(d) : [d];
    for (const part of parts) {
      if (isDayWord(p, part)) continue;
      const v = fromText(p, part);
      if (v === undefined) return `「${part}」は${wants(p)}ではありません`;
    }
    return undefined;
  }
  if (d === null) return p.optional ? undefined : "null は optional のパラメーターだけで使えます";
  return scalarIssue(p, d as ParamScalar);
}

function scalarIssue(p: DashboardParam, v: ParamScalar): string | undefined {
  if (v === null) return "null は使えません";
  const ok = typeof v === "string" ? fromText(p, v) !== undefined : checkScalar(p, v) !== undefined;
  return ok ? undefined : `${JSON.stringify(v)} は${wants(p)}ではありません`;
}

function wants(p: { type?: ParamType }): string {
  switch (p.type) {
    case "integer":
      return "整数";
    case "number":
      return "数値";
    case "date":
      return "日付（2024-04-01 の形）";
    case "datetime":
      return "日時（2024-04-01T09:00 の形）";
    case "boolean":
      return "true か false";
    default:
      return "文字";
  }
}

/** `関東, 近畿` → `["関東", "近畿"]` (empty parts dropped). */
export function splitList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A local date as `YYYY-MM-DD`. */
export function localDateText(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM-DD` when the text is a date on the calendar. */
export function dateText(text: string): string | undefined {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return undefined;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days ? text : undefined;
}

/** `YYYY-MM-DDTHH:MM[:SS[.fff]]` for a date and time (T or a space between, no time zone), or a date (midnight). */
export function datetimeText(text: string): string | undefined {
  if (dateText(text)) return `${text}T00:00`;
  const m = /^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(\.[0-9]{1,6})?)?$/.exec(text);
  if (!m || !dateText(m[1]!)) return undefined;
  if (Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] ?? 0) > 59) return undefined;
  return `${m[1]}T${m[2]}:${m[3]}${m[4] !== undefined && (m[4] !== "00" || m[5]) ? `:${m[4]}${m[5] ?? ""}` : ""}`;
}

/** A value typed in (or from the URL) as the parameter's type; undefined when it is not one. "" is not a value. */
export function fromText(p: { type?: ParamType }, text: string): Exclude<ParamScalar, null> | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  switch (p.type) {
    case "integer":
      return /^[+-]?[0-9]+$/.test(t) && Number.isSafeInteger(Number(t)) ? Number(t) : undefined;
    case "number": {
      if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)(e[+-]?[0-9]+)?$/i.test(t)) return undefined;
      const n = Number(t);
      return Number.isFinite(n) ? n : undefined;
    }
    case "date":
      return dateText(t);
    case "datetime":
      return datetimeText(t);
    case "boolean":
      return t === "true" ? true : t === "false" ? false : undefined;
    default:
      return text;
  }
}

/** A value of the right type as it is (a number for a number, …), or undefined. */
function checkScalar(p: { type?: ParamType }, v: Exclude<ParamScalar, null>): Exclude<ParamScalar, null> | undefined {
  switch (p.type) {
    case "integer":
      return typeof v === "number" && Number.isSafeInteger(v) ? v : undefined;
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    case "boolean":
      return typeof v === "boolean" ? v : undefined;
    case "date":
    case "datetime":
    case "text":
      return typeof v === "string" ? fromText(p, v) : undefined;
    default:
      return v;
  }
}

/** A value as text: for an input, the URL. */
export function paramText(v: Exclude<ParamScalar, null>): string {
  return typeof v === "string" ? v : String(v);
}

/** The first day of the fiscal year that `d` is in (local dates), with its first month (1–12). */
function fiscalStart(y: number, m: number, start: number): [number, number] {
  return [m >= start ? y : y - 1, start];
}

/** A day word (`today`, `fiscal_year_start-1`…) as a local date `YYYY-MM-DD`, from `now` (the viewer's clock). */
export function dayWord(word: string, now: Date, fiscalYearStart = 1): string | undefined {
  const m = DAY_WORDS.exec(word);
  if (!m) return undefined;
  const y = now.getFullYear();
  const mo = now.getMonth(); // 0-based
  const d = now.getDate();
  let day: Date;
  switch (m[1]) {
    case "today":
      day = new Date(y, mo, d);
      break;
    case "tomorrow":
      day = new Date(y, mo, d + 1);
      break;
    case "yesterday":
      day = new Date(y, mo, d - 1);
      break;
    case "month_start":
      day = new Date(y, mo, 1);
      break;
    case "next_month_start":
      day = new Date(y, mo + 1, 1);
      break;
    case "previous_month_start":
      day = new Date(y, mo - 1, 1);
      break;
    case "year_start":
      day = new Date(y, 0, 1);
      break;
    default: {
      const [fy, fm] = fiscalStart(y, mo + 1, Math.min(12, Math.max(1, Math.trunc(fiscalYearStart))));
      day = new Date(fy, fm - 1, 1);
    }
  }
  if (m[2]) day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + Number(m[2]));
  return localDateText(day);
}

/**
 * A parameter's first value: its default, with words worked out (`today` from `now`, `all` = every choice). Undefined
 * when it has none (it must be filled in; an optional one without a default is null), or `all` before the choices
 * are known (`choices` undefined).
 */
export function resolveDefault(
  p: DashboardParam,
  options: { now: Date; fiscalYearStart?: number; choices?: readonly Exclude<ParamScalar, null>[] },
): ParamValue | undefined {
  const d = p.default;
  if (d === undefined) return p.optional && !p.multiple ? null : undefined;
  // One value as written: a day word worked out, else read as the type.
  const one = (text: string): Exclude<ParamScalar, null> => {
    if (p.type === "date" || p.type === "datetime") {
      const day = dayWord(text, options.now, options.fiscalYearStart);
      if (day !== undefined) return p.type === "date" ? day : `${day}T00:00`;
    }
    return fromText(p, text) ?? text;
  };
  if (Array.isArray(d)) return d.map((v) => (typeof v === "string" ? one(v) : v));
  if (typeof d !== "string") return p.multiple && d !== null ? [d] : d;
  if (p.multiple) {
    if (d === "all" && p.values) return options.choices ? [...options.choices] : undefined;
    return splitList(d).map(one);
  }
  return one(d);
}

/** Whether a parameter has a value a dataset can run with (an optional one may be null; a list needs one value). */
export function hasValue(p: DashboardParam, v: ParamValue | undefined): boolean {
  if (v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return v !== null || p.optional;
}

/** The values in a URL's query (`?from=2026-04-01&regions=関東&regions=近畿`), of the parameters it names. */
export function paramsFromSearch(
  params: readonly DashboardParam[],
  search: string | URLSearchParams,
  /** Values left out (they do not fit the type), as sentences. */
  problems?: string[],
): Record<string, ParamValue> {
  const q = typeof search === "string" ? new URLSearchParams(search.replace(/^\?/, "")) : search;
  const out: Record<string, ParamValue> = {};
  const bad = (p: DashboardParam, t: string) => problems?.push(`アドレスのパラメーター ${p.name} の値 ${JSON.stringify(t)} は${wants(p)}ではないので使いません`);
  for (const p of params) {
    const key = [...q.keys()].find((k) => lower(k) === lower(p.name));
    if (key === undefined) continue;
    const texts = q.getAll(key);
    if (p.multiple) {
      const list: Exclude<ParamScalar, null>[] = [];
      for (const t of texts) {
        if (t.trim() === "") continue;
        const v = fromText(p, t);
        if (v === undefined || v === null) bad(p, t);
        else list.push(v);
      }
      // `regions=` alone: none picked (not the default).
      if (list.length || texts.every((t) => t.trim() === "")) out[p.name] = list;
    } else {
      const t = texts[texts.length - 1] ?? "";
      if (t.trim() === "") {
        if (p.optional) out[p.name] = null;
        continue;
      }
      const v = fromText(p, t);
      if (v !== undefined) out[p.name] = v;
      else bad(p, t);
    }
  }
  return out;
}

/** The values as a URL's query, in the parameters' order (null as an empty value). */
export function paramsToSearch(params: readonly DashboardParam[], values: Record<string, ParamValue | undefined>): string {
  const q = new URLSearchParams();
  for (const p of params) {
    const v = values[p.name];
    if (v === undefined || (v === null && p.multiple)) continue;
    if (Array.isArray(v)) {
      for (const x of v) q.append(p.name, paramText(x));
      if (!v.length) q.append(p.name, ""); // none picked
    }
    else q.append(p.name, v === null ? "" : paramText(v));
  }
  return q.toString();
}

/**
 * Values given from outside (the embed's `data-devbi-params`, React's `params`) for the dashboard's parameters, as
 * their types; a value that does not fit is left out (and named in `problems`).
 */
export function checkParamValues(
  params: readonly DashboardParam[],
  given: Record<string, unknown>,
): { values: Record<string, ParamValue>; problems: string[] } {
  const values: Record<string, ParamValue> = {};
  const problems: string[] = [];
  for (const [name, raw] of Object.entries(given)) {
    const p = params.find((x) => lower(x.name) === lower(name));
    if (!p) {
      problems.push(`パラメーター ${name} はこのダッシュボードにありません`);
      continue;
    }
    const one = (v: unknown): Exclude<ParamScalar, null> | undefined =>
      typeof v === "string" ? fromText(p, v) : typeof v === "number" || typeof v === "boolean" ? checkScalar(p, v) : undefined;
    if (p.multiple) {
      const list = (Array.isArray(raw) ? raw : [raw]).map(one);
      if (list.length && list.every((v) => v !== undefined)) values[p.name] = list as Exclude<ParamScalar, null>[];
      else problems.push(`パラメーター ${name} の値 ${JSON.stringify(raw)} は${wants(p)}の一覧ではありません`);
    } else if (raw === null && p.optional) {
      values[p.name] = null;
    } else {
      const v = one(raw);
      if (v !== undefined) values[p.name] = v;
      else problems.push(`パラメーター ${name} の値 ${JSON.stringify(raw)} は${wants(p)}ではありません`);
    }
  }
  return { values, problems };
}

/** A choice's value from a dataset's first column (a Date as `YYYY-MM-DD`, or with its time). */
export function choiceValue(v: unknown, p: { type?: ParamType } = {}): Exclude<ParamScalar, null> | undefined {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) {
    // Arrow's dates and timestamps without a zone come as UTC: the date and time as the database has them, written
    // as the parameter's values are (`2026-04-01T00:00` for a datetime, with the seconds when there are some).
    const iso = v.toISOString().replace(/Z$/, "").replace(/\.000$/, "");
    if (p.type === "date") return iso.slice(0, 10);
    if (p.type !== "datetime" && iso.endsWith("T00:00:00")) return iso.slice(0, 10);
    return datetimeText(iso) ?? iso;
  }
  // Beyond 2^53 a number would not be the same id: the digits as text (an integer parameter then says so).
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  // Text from a database without dates (SQLite's `2026-04-01 09:00:00`): as the parameter's type reads it.
  if (typeof v === "string" && p.type !== undefined && p.type !== "text") return fromText(p, v) ?? v;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}
