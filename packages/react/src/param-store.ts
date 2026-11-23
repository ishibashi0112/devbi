import {
  choiceValue,
  dashboardParams,
  formatValue,
  hasValue,
  resolveDefault,
  tileBindings,
  type Dashboard,
  type DashboardParam,
  type DatasetInfo,
  type ParamScalar,
  type ParamValue,
  type Query,
} from "devbi";
import type { DatasetResult } from "./dataset.js";

type Value = ParamValue | undefined;

export interface Choice {
  value: Exclude<ParamScalar, null>;
  label: string;
}

export interface ChoicesState {
  /** Waiting for the values its dataset needs, or reading it. */
  loading: boolean;
  items: Choice[];
  /** More than {@link MAX_CHOICES}: only the first are listed. */
  truncated: boolean;
  error: Error | null;
}

/** The most choices a parameter lists. */
export const MAX_CHOICES = 10_000;
/** The most values the API takes for one parameter (as @devbi/server's MAX_VALUES). */
export const MAX_VALUES = 1000;

const lower = (s: string) => s.toLowerCase();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const key = (v: unknown) => String(v);

/**
 * What a dataset tile sends: its parameters' values, or the labels of those still to fill in, or wait (choices), or
 * why it cannot be sent (more values than the API takes).
 */
export type DatasetRequest = { params: Record<string, ParamValue> } | { missing: string[] } | { waiting: true } | { error: string };

/** A tile's dataset has parameters to fill in first. Not an error: the tile says what to fill in. */
export class ParamsNeeded extends Error {
  constructor(readonly labels: string[]) {
    super(`${labels.join("、")}を入れてください`);
    this.name = "ParamsNeeded";
  }
}

/** A tile waits for a value that comes with the choices (`default=all`). */
export class ParamsWaiting extends Error {
  constructor() {
    super("パラメーターの候補を読んでいます");
    this.name = "ParamsWaiting";
  }
}

/**
 * The parameters of one dashboard (the bar above the tiles) and their values. With `apply: "button"` the bar edits a
 * draft, which 表示 applies; the tiles read the applied values. The choices of a parameter (`values=<dataset>`) are
 * read with the draft values (cascading choices follow what is picked before 表示).
 */
export class DashboardParams {
  readonly list: DashboardParam[];
  readonly problems: string[];
  readonly apply: "auto" | "button";
  private applied: Record<string, Value> = {};
  private draft: Record<string, Value> = {};
  /** Their default is `all`, which waits for the choices. */
  private pendingAll = new Set<string>();
  private choices = new Map<string, ChoicesState>();
  private choicesKey = new Map<string, string>();
  private listeners = new Set<() => void>();
  private version = 0;
  private started = false;
  /** Bumped by 更新: the tiles and the choices read again. */
  refreshes = 0;

  constructor(
    private readonly dashboard: Dashboard,
    private readonly datasets: Record<string, DatasetInfo>,
    private readonly read: (dataset: string, params: Record<string, ParamValue>) => Promise<DatasetResult>,
    given: Record<string, ParamValue> = {},
    private readonly now = new Date(),
  ) {
    const { params, problems } = dashboardParams(dashboard, datasets);
    this.list = params;
    this.problems = problems;
    this.apply = dashboard.apply ?? "auto";
    for (const p of params) {
      const g = Object.hasOwn(given, p.name) ? given[p.name] : undefined;
      let v: Value = g !== undefined ? g : this.defaultOf(p);
      // `all` waits for its choices (none when their dataset is not there: the bar says so, the tile asks for a value).
      if (v === undefined && g === undefined && p.multiple && p.default === "all" && p.values && Object.hasOwn(datasets, p.values)) {
        this.pendingAll.add(p.name);
      }
      if (Array.isArray(v) && !p.multiple) v = v[0];
      this.applied[p.name] = v;
      this.draft[p.name] = v;
    }
  }

  /** The choices as read for the bar's values now (not while they are being read, nor after they failed). */
  private readyChoices(p: DashboardParam): Choice[] | undefined {
    const st = this.choices.get(p.name);
    return st && !st.loading && !st.error ? st.items : undefined;
  }

  private defaultOf(p: DashboardParam, choices?: Choice[]): Value {
    return resolveDefault(p, { now: this.now, fiscalYearStart: this.dashboard.fiscalYearStart ?? 1, ...(choices ? { choices: choices.map((c) => c.value) } : {}) });
  }

  /** A parameter by name (without case, as in SQL). */
  find(name: string): DashboardParam | undefined {
    return this.list.find((p) => lower(p.name) === lower(name));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private changed() {
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  /** Start reading the choices (once the dashboard is on the page). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.loadChoices();
  }

  /** The value the tiles read. */
  value(name: string): Value {
    const p = this.find(name);
    return p ? this.applied[p.name] : undefined;
  }

  /** The value in the bar (the same as {@link value} unless `apply: "button"` has a change not shown yet). */
  draftValue(name: string): Value {
    const p = this.find(name);
    return p ? this.draft[p.name] : undefined;
  }

  /** All values the tiles read, by name (for the URL, `onParamsChange`). */
  values(): Record<string, ParamValue> {
    const out: Record<string, ParamValue> = {};
    for (const p of this.list) if (this.applied[p.name] !== undefined) out[p.name] = this.applied[p.name]!;
    return out;
  }

  /** The values that are not their default (for the URL: a link keeps today's `today`). */
  changedValues(): Record<string, ParamValue> {
    const out: Record<string, ParamValue> = {};
    for (const p of this.list) {
      const v = this.applied[p.name];
      if (v === undefined) continue;
      const def = this.defaultOf(p, this.readyChoices(p));
      if (!same(v, def)) out[p.name] = v;
    }
    return out;
  }

  /** The bar has a change 表示 has not applied. */
  dirty(): boolean {
    return this.list.some((p) => !same(this.draft[p.name], this.applied[p.name]));
  }

  /** Set a value from the bar: applied at once unless `apply: "button"`. */
  set(name: string, value: Value): void {
    const p = this.find(name);
    if (!p || same(this.draft[p.name], value)) return;
    this.draft[p.name] = value;
    this.pendingAll.delete(p.name);
    if (this.apply === "auto") this.applied[p.name] = value;
    this.changed();
    this.loadChoices();
  }

  /** 表示: the tiles read the bar's values. */
  applyDraft(): void {
    if (!this.dirty()) return;
    this.applied = { ...this.draft };
    this.changed();
  }

  /**
   * Values from outside (the URL, the embed, React's `params`): applied at once, in the bar too. With `others:
   * "default"` (an address, which leaves out the values that are their default), the parameters not given go back to
   * their default.
   */
  setValues(values: Record<string, ParamValue>, options: { others?: "keep" | "default" } = {}): void {
    let any = false;
    const given = new Set<string>();
    for (const [name, v] of Object.entries(values)) {
      const p = this.find(name);
      if (!p) continue;
      given.add(p.name);
      if (same(this.applied[p.name], v) && same(this.draft[p.name], v)) continue;
      this.applied[p.name] = v;
      this.draft[p.name] = v;
      this.pendingAll.delete(p.name);
      any = true;
    }
    if (options.others === "default") {
      for (const p of this.list) {
        if (given.has(p.name)) continue;
        const def = this.defaultOf(p, this.readyChoices(p));
        // `all` while its choices are being read: it waits for them (not when they failed).
        const waits =
          def === undefined && p.multiple && p.default === "all" && !!p.values && Object.hasOwn(this.datasets, p.values) && !this.choices.get(p.name)?.error;
        if (same(this.applied[p.name], def) && same(this.draft[p.name], def) && !waits) continue;
        this.applied[p.name] = def;
        this.draft[p.name] = def;
        if (waits) this.pendingAll.add(p.name);
        any = true;
      }
    }
    if (!any) return;
    this.changed();
    this.loadChoices();
  }

  /** 更新: read the tiles and the choices again (the caller drops its cached rows). */
  refresh(): void {
    this.refreshes++;
    this.choicesKey.clear();
    this.changed();
    this.loadChoices();
  }

  choicesOf(name: string): ChoicesState | undefined {
    const p = this.find(name);
    return p ? this.choices.get(p.name) : undefined;
  }

  /**
   * The values of a dataset's parameters, from `values` (by name, without case). `seen`: the choices' datasets asked
   * on the way (a ring of choices, which the bar reports, does not loop).
   */
  private valuesFor(dataset: DatasetInfo, from: Record<string, Value>, query?: Query, seen = new Set<string>()): DatasetRequest {
    const params: Record<string, ParamValue> = {};
    const missing: string[] = [];
    const tooMany: string[] = [];
    let waiting = false;
    const bindings = query
      ? tileBindings({ id: "", x: 0, y: 0, w: 1, h: 1, query }, dataset)
      : dataset.parameters.map((p) => ({ name: p.name, param: p.name, value: undefined }));
    for (const b of bindings) {
      if (b.param === undefined) {
        params[b.name] = b.value!;
        continue;
      }
      const p = this.find(b.param);
      if (!p) {
        missing.push(b.param);
        continue;
      }
      const v = from[p.name];
      if (this.pendingAll.has(p.name)) {
        // `all` waits for its choices; when those need values not filled in yet, the tile asks for them. The choices
        // are read with the bar's values (with apply: "button", before 表示 too), so this asks with those.
        const ds = p.values && !seen.has(p.values) ? this.datasets[p.values] : undefined;
        const before = ds ? this.valuesFor(ds, this.draft, undefined, new Set([...seen, p.values!])) : undefined;
        if (before && "missing" in before) missing.push(...before.missing.filter((m) => !missing.includes(m)));
        else waiting = true;
      } else if (!hasValue(p, v)) missing.push(p.label);
      else if (Array.isArray(v) && v.length > MAX_VALUES) tooMany.push(`${p.label}（${v.length.toLocaleString("ja-JP")} 個）`);
      else params[b.name] = v!;
    }
    if (missing.length) return { missing };
    if (waiting) return { waiting: true };
    if (tooMany.length) {
      return {
        error: `${tooMany.join("、")}: 1 つのパラメーターで送れる値は ${MAX_VALUES.toLocaleString("ja-JP")} 個までです。選ぶ値を減らしてください（すべてを読むなら、このパラメーターを使わない SQL にします）`,
      };
    }
    return { params };
  }

  /** What a tile's dataset query sends now. */
  request(query: Query, dataset: DatasetInfo): DatasetRequest {
    // A parameter a promoted tile's own query names, which no dash.json tile gave the bar.
    for (const b of tileBindings({ id: "", x: 0, y: 0, w: 1, h: 1, query }, dataset)) {
      if (b.param !== undefined && !this.find(b.param)) {
        throw new Error(
          `パラメーター ${b.param} の欄がありません（dash.json のタイルの query に dataset を書くか、params に ${b.param} の type を書いてください）`,
        );
      }
    }
    return this.valuesFor(dataset, this.applied, query);
  }

  /** Read the choices whose dataset's parameters have changed (with the bar's values). */
  private loadChoices(): void {
    if (!this.started) return;
    for (const p of this.list) {
      if (!p.values) continue;
      const ds = Object.hasOwn(this.datasets, p.values) ? this.datasets[p.values]! : undefined;
      if (!ds) continue; // the bar shows the problem
      const req = this.valuesFor(ds, this.draft, undefined, new Set([p.values]));
      const state = this.choices.get(p.name);
      if ("error" in req) {
        this.choicesKey.delete(p.name);
        this.choicesFailed(p, new Error(req.error));
        continue;
      }
      if (!("params" in req)) {
        // waits for the values its choices need
        if (!state?.loading) this.setChoices(p.name, { loading: true, items: state?.items ?? [], truncated: false, error: null });
        this.choicesKey.delete(p.name);
        continue;
      }
      const k = JSON.stringify([p.values, req.params, this.refreshes]);
      if (this.choicesKey.get(p.name) === k) continue;
      this.choicesKey.set(p.name, k);
      this.setChoices(p.name, { loading: true, items: state?.items ?? [], truncated: false, error: null });
      this.read(p.values, req.params).then(
        (result) => {
          if (this.choicesKey.get(p.name) !== k) return;
          const [first, second] = result.fields;
          const items: Choice[] = [];
          for (const row of result.rows.slice(0, MAX_CHOICES)) {
            const raw = first ? row[first.name] : undefined;
            const value = choiceValue(raw, p);
            if (value === undefined) continue;
            const label = second ? formatValue(row[second.name], second) : typeof raw === "string" ? raw : formatValue(raw, first);
            items.push({ value, label });
          }
          this.setChoices(p.name, { loading: false, items, truncated: result.rows.length > MAX_CHOICES, error: null });
          this.fit(p, items, result.rows.length > MAX_CHOICES);
        },
        (e: unknown) => {
          if (this.choicesKey.get(p.name) !== k) return;
          this.choicesFailed(p, e instanceof Error ? e : new Error(String(e)));
        },
      );
    }
  }

  /** The choices could not be read: the bar says why; `all` stops waiting (the tile then asks for a value). */
  private choicesFailed(p: DashboardParam, error: Error): void {
    this.pendingAll.delete(p.name);
    this.setChoices(p.name, { loading: false, items: [], truncated: false, error });
  }

  private setChoices(name: string, state: ChoicesState) {
    this.choices.set(name, state);
    this.changed();
  }

  /**
   * After the choices are read: `all` takes every one; a value no longer among them (the parameter above changed) is
   * dropped, and an empty one goes back to the default.
   */
  private fit(p: DashboardParam, items: Choice[], truncated: boolean): void {
    const known = new Set(items.map((c) => key(c.value)));
    const fitted = (v: Value): Value => {
      if (truncated || v === undefined || v === null) return v;
      if (Array.isArray(v)) {
        // None picked on purpose (`regions=` in the address) stays none.
        if (!v.length) return v;
        const kept = v.filter((x) => known.has(key(x)));
        return kept.length ? (kept.length === v.length ? v : kept) : this.defaultOf(p, items);
      }
      return known.has(key(v)) ? v : this.defaultOf(p, items);
    };
    let next: Value;
    let first = false;
    if (this.pendingAll.has(p.name)) {
      this.pendingAll.delete(p.name);
      next = items.map((c) => c.value);
      first = true;
    } else {
      next = fitted(this.draft[p.name]);
    }
    if (same(next, this.draft[p.name]) && !first) return;
    this.draft[p.name] = next;
    // The first value (from the default) is the tiles' too; a change after a pick waits for 表示 with the button.
    if (this.apply === "auto" || first || same(this.applied[p.name], undefined)) this.applied[p.name] = next;
    this.changed();
    this.loadChoices();
  }
}

