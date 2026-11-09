import { useDevbiQuery } from "@devbi/react";
import {
  GRAINS,
  TILE_TYPES,
  TILE_TYPE_NAMES,
  compileQuery,
  isoDate,
  resolveComponent,
  type BuiltinTileType,
  type Grain,
  type MetricsView,
  type Query,
  type Scalar,
  type TileOptionSchema,
} from "devbi";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  changeType,
  fieldsOf,
  filterRow,
  idProblem,
  isObj,
  metricsNameOf,
  moveUp,
  rowFilter,
  setDashboardKey,
  setOption,
  setQueryKey,
  setTileKey,
  sortKeys,
  sortSpecs,
  toggle,
  updateTile,
  type FilterRow,
} from "./edit.js";
import type { RawDashboard, RawTile } from "./layout.js";

const GRAIN_LABELS: Record<Grain, string> = {
  day: "日",
  week: "週（月曜始まり）",
  month: "月",
  quarter: "四半期",
  year: "年",
  fiscal_year: "年度",
};

/** Takes a tile's new name typed but not yet taken; says which name became which. */
export type Flush = () => { from: string; to: string } | undefined;

export interface PanelProps {
  metrics: Record<string, MetricsView>;
  /** The dashboard's file name (`dashboards/<name>.dash.json`). */
  name: string;
  spec: RawDashboard;
  selected: string | null;
  /** Inside the dashboard's DevbiProvider: a filter's values can be read from the data. */
  live: boolean;
  onSelect(id: string | null): void;
  /** `merge`: the same key as the change before folds both into one undo step (typing in a box). */
  onChange(next: RawDashboard, merge?: string): void;
  onRemove(id: string): void;
  /** Clear a tile's selection (its period, for instance), so the tile starts over. */
  clearSelection(id: string): void;
  /** What to finish before the selection changes (a new name typed but not yet taken), or null. */
  registerFlush(flush: Flush | null): void;
  /** "コードにする": write the tile out as a .tsx file, point the tile at it and save. Whether it was done. */
  onPromote(id: string): Promise<boolean>;
  /** Whether there are unsaved changes (saved along with "コードにする"). */
  dirty: boolean;
}

/**
 * The property panel: the selected tile's type, title, data (measures, dimensions, time grain, period, filters, sort,
 * limit) and options, or, with no tile selected, the dashboard's title, description and metrics file. Every change
 * shows on the tiles at once and is one undo step.
 */
export function Panel(props: PanelProps) {
  const tile = props.selected ? props.spec.tiles.find((t) => t.id === props.selected) : undefined;
  return (
    <aside className="devbi-ed-panel" aria-label="設定">
      {tile ? <TilePanel key={tile.id} {...props} tile={tile} /> : <DashboardPanel {...props} />}
    </aside>
  );
}

type Ids = { id: string; "aria-describedby"?: string };

/** A label, a control and a hint under it, tied together for screen readers. */
function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children(ids: Ids): ReactNode }) {
  const id = useId();
  return (
    <div className="devbi-ed-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, ...(hint ? { "aria-describedby": `${id}-hint` } : {}) })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}

/** A merge key that stays the same from focus to blur: the edits in between are one undo step. */
function useMergeKey(): { key: () => string; onFocus: () => void } {
  const id = useId();
  const session = useRef(0);
  return { key: () => `${id}#${session.current}`, onFocus: () => void session.current++ };
}

function TextInput({
  value,
  onChange,
  multiline,
  ...rest
}: Ids & { value: string; onChange(value: string, merge: string): void; multiline?: boolean; placeholder?: string }) {
  const merge = useMergeKey();
  const common = { ...rest, value, onFocus: merge.onFocus, onChange: (e: { target: { value: string } }) => onChange(e.target.value, merge.key()) };
  return multiline ? <textarea {...common} /> : <input type="text" {...common} />;
}

/** A number box: empty removes the key; something that is not a number yet ("-", "1e") is left alone. */
function NumberInput({ value, onChange, integer, ...rest }: Ids & { value: number | undefined; onChange(value: number | undefined, merge: string): void; integer?: boolean }) {
  const merge = useMergeKey();
  return (
    <input
      {...rest}
      type="number"
      {...(integer ? { min: 1, step: 1 } : {})}
      value={value ?? ""}
      onFocus={merge.onFocus}
      onChange={(e) => {
        if (e.target.value === "") {
          if (!e.target.validity.badInput) onChange(undefined, merge.key());
          return;
        }
        const n = Number(e.target.value);
        if (Number.isFinite(n) && (!integer || (Number.isInteger(n) && n >= 1))) onChange(n, merge.key());
      }}
    />
  );
}

/** A metrics file to pick, with the one written in the file even when it does not exist. */
function MetricsSelect({ metrics, value, empty, onChange, ...ids }: Ids & { metrics: Record<string, MetricsView>; value: string; empty: string; onChange(v: string): void }) {
  const names = Object.keys(metrics).sort();
  return (
    <select {...ids} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {names.map((n) => (
        <option key={n} value={n}>
          {metrics[n]!.label}（{n}）
        </option>
      ))}
      {value && !names.includes(value) && <option value={value}>{value}（ありません）</option>}
    </select>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function DashboardPanel({ metrics, name, spec, onChange }: PanelProps) {
  const single = Object.keys(metrics).length === 1;
  return (
    <>
      <h2>ダッシュボード</h2>
      <Field label="見出し" hint={`空のときはファイル名（${name}）`}>
        {(ids) => <TextInput {...ids} placeholder={name} value={str(spec.title)} onChange={(v, merge) => onChange(setDashboardKey(spec, "title", v), merge)} />}
      </Field>
      <Field label="説明" hint="見出しの横に出る一文">
        {(ids) => <TextInput {...ids} value={str(spec.description)} onChange={(v, merge) => onChange(setDashboardKey(spec, "description", v), merge)} />}
      </Field>
      <Field label="指標ファイル" hint={single ? "指標ファイルが 1 つだけなので、指定しなくても使われます" : "タイルが使う models/<名前>.metrics.yaml"}>
        {(ids) => <MetricsSelect {...ids} metrics={metrics} value={str(spec.metrics)} empty="指定しない" onChange={(v) => onChange(setDashboardKey(spec, "metrics", v))} />}
      </Field>
      <p className="devbi-hint">タイルを押すと、そのタイルの種類・見出し・データをここで変えられます。</p>
    </>
  );
}

function TilePanel({ metrics, name, spec, tile, live, onSelect, onChange, onRemove, clearSelection, registerFlush, onPromote, dirty }: PanelProps & { tile: RawTile }) {
  const onTile = (update: (t: RawTile) => RawTile, merge?: string) => onChange(updateTile(spec, tile.id, update), merge);
  const type = typeof tile.type === "string" ? tile.type : undefined;
  const builtin = type && Object.hasOwn(TILE_TYPES, type) ? (type as BuiltinTileType) : undefined;
  const component = typeof tile.component === "string" ? tile.component : undefined;
  const showQuery = builtin ? TILE_TYPES[builtin].query : isObj(tile.query);
  return (
    <>
      <div className="devbi-ed-panel-head">
        <h2>{str(tile.title) || tile.id}</h2>
        <button type="button" className="devbi-ed-mini" onClick={() => onSelect(null)}>
          ダッシュボード全体
        </button>
      </div>
      {component ? (
        <p className="devbi-hint">
          コードのタイルです（<code className="devbi-ed-code">{resolveComponent(`/dashboards/${name}.dash.json`, component).slice(1)}</code>
          ）。中身とデータの指定はそのファイルで変えます。
        </p>
      ) : (
        <Field label="種類" hint={builtin ? TILE_TYPES[builtin].description : undefined}>
          {(ids) => (
            <select
              {...ids}
              value={type ?? ""}
              onChange={(e) => {
                clearSelection(tile.id);
                onTile((t) => changeType(spec, t, e.target.value as BuiltinTileType, metrics));
              }}
            >
              {TILE_TYPE_NAMES.map((t) => (
                <option key={t} value={t}>
                  {TILE_TYPES[t].label}
                </option>
              ))}
              {!builtin && <option value={type ?? ""}>{type}（ありません）</option>}
            </select>
          )}
        </Field>
      )}
      <Field label="見出し" hint="空のときは見出しなし">
        {(ids) => <TextInput {...ids} value={str(tile.title)} onChange={(v, merge) => onTile((t) => setTileKey(t, "title", v), merge)} />}
      </Field>
      <IdField
        spec={spec}
        tile={tile}
        registerFlush={registerFlush}
        onRename={(id, follow) => {
          clearSelection(tile.id);
          onChange(updateTile(spec, tile.id, (t) => setTileKey(t, "id", id)));
          if (follow) onSelect(id);
        }}
      />
      {showQuery && <QueryEditor metrics={metrics} spec={spec} tile={tile} live={live} onTile={onTile} />}
      {builtin && Object.keys(TILE_TYPES[builtin].options).length > 0 && (
        <OptionsEditor metrics={metrics} spec={spec} tile={tile} type={builtin} onTile={onTile} clearSelection={clearSelection} />
      )}
      {builtin && <Promote folder={`dashboards/${name}/`} dirty={dirty} onPromote={() => onPromote(tile.id)} />}
      <button type="button" className="devbi-button devbi-ed-danger" onClick={() => onRemove(tile.id)}>
        このタイルを消す
      </button>
    </>
  );
}

/**
 * "コードにする": the tile written out as a .tsx file, which draws it from then on. Its data and drawing are then
 * changed in the file, so the panel asks once more first.
 */
function Promote({ folder, dirty, onPromote }: { folder: string; dirty: boolean; onPromote(): Promise<boolean> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const heading = useId();
  return (
    <section className="devbi-ed-promote" aria-labelledby={heading}>
      <h3 id={heading}>コードにする</h3>
      {asking ? (
        <>
          <p>
            <code className="devbi-ed-code">{folder}</code> に .tsx ファイルを書き出し、このタイルはそのファイルで描くようにして、ダッシュボードを保存します
            {dirty ? "（保存していないほかの変更も、いっしょに保存します）" : ""}。そのあと、このタイルのデータと描き方はファイルで変えます（ここで変えられるのは、見出しと名前だけになります）。
          </p>
          <div className="devbi-ed-row">
            <button
              type="button"
              className="devbi-button devbi-button-primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onPromote().then((done) => {
                  setBusy(false);
                  if (done) setAsking(false);
                });
              }}
            >
              {busy ? "書き出しています…" : "書き出す"}
            </button>
            <button type="button" className="devbi-button" disabled={busy} onClick={() => setAsking(false)}>
              やめる
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="devbi-hint">組み込みのタイルでは足りない表示は、React のコードで描けます。はじめは同じ見た目のまま書き出します。</p>
          <button type="button" className="devbi-button devbi-ed-promote-start" onClick={() => setAsking(true)}>
            コードにする…
          </button>
        </>
      )}
    </section>
  );
}

/**
 * The tile's id: taken when the box is left or Enter is pressed, and only when no other tile has it. Pressing
 * another tile (or between the tiles) takes it first, through `registerFlush`, so it is not lost when the panel
 * switches to that tile.
 */
function IdField({
  spec,
  tile,
  registerFlush,
  onRename,
}: {
  spec: RawDashboard;
  tile: RawTile;
  registerFlush(flush: Flush | null): void;
  /** `follow`: the panel stays on this tile (under its new name). */
  onRename(id: string, follow: boolean): void;
}) {
  const [text, setText] = useState(tile.id);
  useEffect(() => setText(tile.id), [tile.id]);
  const problem = idProblem(spec, tile.id, text);
  const done = useRef(false);
  const take = (follow: boolean) => {
    if (done.current || problem || text === tile.id) return undefined;
    // Taken on the way out (another tile pressed): a blur that may follow must not take it again.
    done.current = !follow;
    onRename(text, follow);
    return { from: tile.id, to: text };
  };
  const latest = useRef(take);
  latest.current = take;
  useEffect(() => {
    registerFlush(() => latest.current(false));
    return () => registerFlush(null);
  }, [registerFlush]);
  return (
    <Field label="名前（id）" hint={problem ?? "dash.json でタイルを見分ける名前"}>
      {(ids) => (
        <input
          {...ids}
          type="text"
          value={text}
          aria-invalid={!!problem}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => (problem ? setText(tile.id) : take(true))}
          onKeyDown={(e) => {
            if (e.key === "Enter") take(true);
          }}
        />
      )}
    </Field>
  );
}

type OnTile = (update: (t: RawTile) => RawTile, merge?: string) => void;

function QueryEditor({ metrics, spec, tile, live, onTile }: { metrics: Record<string, MetricsView>; spec: RawDashboard; tile: RawTile; live: boolean; onTile: OnTile }) {
  const query = (isObj(tile.query) ? tile.query : {}) as Query;
  const names = Object.keys(metrics).sort();
  const name = metricsNameOf(metrics, spec, tile);
  const view = name && Object.hasOwn(metrics, name) ? metrics[name] : undefined;
  const set = (key: keyof Query, value: unknown, merge?: string) => onTile((t) => setQueryKey(t, key, value), merge);
  const own = str(query.metrics);
  const dashboardDefault = str(spec.metrics) || (names.length === 1 ? names[0] : undefined);
  // What the tile would say instead of its data (an unknown name, nothing to show), next to the boxes that fix it.
  let problem: string | undefined;
  if (view) {
    try {
      compileQuery(view, query);
    } catch (e) {
      problem = (e as Error).message;
    }
  }
  return (
    <>
      <h3>データ</h3>
      {problem && <p className="devbi-ed-warn">{problem}</p>}
      {(names.length > 1 || own) && (
        <Field label="指標ファイル">
          {(ids) => (
            <MetricsSelect {...ids} metrics={metrics} value={own} empty={`ダッシュボードと同じ${dashboardDefault ? `（${dashboardDefault}）` : ""}`} onChange={(v) => set("metrics", v)} />
          )}
        </Field>
      )}
      {!view ? (
        <p className="devbi-ed-warn">{name ? `指標ファイル models/${name}.metrics.yaml がありません` : "使う指標ファイルを選んでください"}</p>
      ) : (
        <>
          <NameList legend="指標" defs={view.measures} chosen={query.measures ?? []} onChange={(v) => set("measures", v)} />
          <NameList legend="軸" defs={view.dimensions} chosen={query.dimensions ?? []} onChange={(v) => set("dimensions", v)} />
          {(view.time || query.time) && (
            <Field label={`期間の単位${view.time ? `（${view.time.label}）` : ""}`}>
              {(ids) => (
                <select {...ids} value={query.time ?? ""} onChange={(e) => set("time", e.target.value)}>
                  <option value="">分けない</option>
                  {GRAINS.map((g) => (
                    <option key={g} value={g}>
                      {GRAIN_LABELS[g]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          {(view.time || query.period !== undefined) && (
            <Field label="期間で絞るか" hint="期間は、date-range のタイルで選んだ期間と、時間のグラフでクリックした期間">
              {(ids) => (
                <select {...ids} value={query.period === false ? "false" : ""} onChange={(e) => set("period", e.target.value === "false" ? false : undefined)}>
                  <option value="">絞る</option>
                  <option value="false">絞らない（いつも全期間）</option>
                </select>
              )}
            </Field>
          )}
          <FiltersEditor view={view} query={query} live={live} set={set} />
          <SortEditor view={view} query={query} set={set} />
          <Field label="件数" hint="空のときはすべての行">
            {(ids) => <NumberInput {...ids} integer value={typeof query.limit === "number" ? query.limit : undefined} onChange={(n, merge) => set("limit", n, merge)} />}
          </Field>
        </>
      )}
    </>
  );
}

/**
 * Measures or dimensions to check. The order in the query is the order they were checked (the first one is the one
 * a tile shows first); ↑ moves one earlier. Names the metrics file does not have stay listed, to uncheck.
 */
function NameList({ legend, defs, chosen, onChange }: { legend: string; defs: Record<string, { label: string }>; chosen: readonly string[]; onChange(v: string[]): void }) {
  const names = [...Object.keys(defs), ...chosen.filter((n) => !Object.hasOwn(defs, n))];
  if (!names.length) return null;
  return (
    <fieldset>
      <legend>{legend}</legend>
      {names.map((n) => {
        const at = chosen.indexOf(n);
        const known = Object.hasOwn(defs, n);
        const label = known ? defs[n]!.label : n;
        return (
          <div className="devbi-ed-name" key={n}>
            <label>
              <input type="checkbox" checked={at >= 0} onChange={() => onChange(toggle(chosen, n))} />
              <span>{label}</span>
              {known && label !== n && <code className="devbi-ed-code">{n}</code>}
              {!known && <span className="devbi-ed-warn">（ありません）</span>}
            </label>
            {at >= 0 && chosen.length > 1 && <span className="devbi-ed-order" aria-label={`${at + 1} 番目`}>{at + 1}</span>}
            {at > 0 && (
              <button type="button" className="devbi-ed-mini" aria-label={`${label}を前へ`} title="前へ" onClick={() => onChange(moveUp(chosen, n))}>
                ↑
              </button>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

const plain = (v: Scalar): Scalar => (v instanceof Date ? isoDate(v) : v);
const valueKey = (v: Scalar) => JSON.stringify(plain(v));
const valueText = (v: Scalar) => (v === null ? "（空欄）" : String(plain(v)));

type EditableRow = Exclude<FilterRow, { kind: "other" }>;

/**
 * Fixed filters: values of a dimension to keep, or days of the time column. A filter that would filter nothing (no
 * value checked, no day given) is not written; its box stays open (as a draft) until it is given one or closed.
 * Boxes are keyed by field, so a box keeps its state (what is typed, focus) when its filter is written or removed.
 */
function FiltersEditor({ view, query, live, set }: { view: MetricsView; query: Query; live: boolean; set(key: keyof Query, value: unknown, merge?: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const timeName = view.time?.name;
  const filters = (query.filters ?? []) as unknown[];
  const fields = fieldsOf(view);
  const labelOf = (f: string) => fields.find(([n]) => n === f)?.[1] ?? f;
  const fieldOf = (f: unknown) => (isObj(f) && typeof f.field === "string" ? f.field : "?");
  const used = new Set(filters.map(fieldOf));
  const write = (at: number | null, row: EditableRow, merge?: string) => {
    const f = rowFilter(row);
    const next = [...filters];
    if (at === null) {
      if (!f) return;
      next.push(f);
      setDraft(null);
    } else if (f) next[at] = f;
    else {
      next.splice(at, 1);
      setDraft(row.field);
    }
    set("filters", next, merge);
  };
  const blank = (field: string): EditableRow => (field === timeName ? { kind: "period", field, from: null, to: null } : { kind: "in", field, values: [] });
  const seen = new Map<string, number>();
  const keyOf = (field: string) => {
    const n = seen.get(field) ?? 0;
    seen.set(field, n + 1);
    return `${field}#${n}`;
  };
  const boxes = filters.map((f, i) => {
    const row = filterRow(f, timeName);
    const field = fieldOf(f);
    return (
      <FilterBox key={keyOf(field)} label={labelOf(field)} close="×" closeLabel={`${labelOf(field)}の絞り込みを消す`} onClose={() => set("filters", filters.filter((_, j) => j !== i))}>
        {row.kind === "other" ? (
          <>
            <code className="devbi-ed-code">{JSON.stringify(f)}</code>
            <small className="devbi-hint">ここでは変えられない形です。dash.json で直してください</small>
          </>
        ) : (
          <FilterInputs view={view} row={row} live={live} labelOf={labelOf} onChange={(r, merge) => write(i, r, merge)} />
        )}
      </FilterBox>
    );
  });
  if (draft !== null && !used.has(draft)) {
    boxes.push(
      <FilterBox key={keyOf(draft)} label={labelOf(draft)} close="やめる" closeLabel={`${labelOf(draft)}の絞り込みをやめる`} onClose={() => setDraft(null)}>
        <FilterInputs view={view} row={blank(draft)} live={live} labelOf={labelOf} onChange={(r, merge) => write(null, r, merge)} />
      </FilterBox>,
    );
  }
  const free = fields.filter(([n]) => !used.has(n) && n !== draft);
  return (
    <fieldset>
      <legend>絞り込み</legend>
      {boxes}
      {free.length > 0 && (
        <select aria-label="絞り込みを追加" value="" onChange={(e) => e.target.value && setDraft(e.target.value)}>
          <option value="">＋ 絞り込みを追加</option>
          {free.map(([n, l]) => (
            <option key={n} value={n}>
              {l}
            </option>
          ))}
        </select>
      )}
    </fieldset>
  );
}

function FilterBox({ label, close, closeLabel, onClose, children }: { label: string; close: string; closeLabel: string; onClose(): void; children: ReactNode }) {
  return (
    <div className="devbi-ed-filter">
      <div className="devbi-ed-row">
        <strong>{label}</strong>
        <button type="button" className="devbi-ed-mini" aria-label={closeLabel} onClick={onClose}>
          {close}
        </button>
      </div>
      {children}
    </div>
  );
}

function FilterInputs({
  view,
  row,
  live,
  labelOf,
  onChange,
}: {
  view: MetricsView;
  row: EditableRow;
  live: boolean;
  labelOf(field: string): string;
  onChange(row: EditableRow, merge?: string): void;
}) {
  const merge = useMergeKey();
  if (row.kind === "in") {
    return live ? <LiveValues metrics={view.name} row={row} onChange={(values) => onChange({ ...row, values })} /> : <TypedValues row={row} onChange={(values) => onChange({ ...row, values })} />;
  }
  // A date box reports each step of typing a date (the year one digit at a time): one undo step from focus to blur.
  return (
    <div className="devbi-ed-row">
      <input
        type="date"
        aria-label={`${labelOf(row.field)}の始まり`}
        value={row.from ?? ""}
        onFocus={merge.onFocus}
        onChange={(e) => onChange({ ...row, from: e.target.value || null }, merge.key())}
      />
      <span>〜</span>
      <input
        type="date"
        aria-label={`${labelOf(row.field)}の終わり（この日を含む）`}
        value={row.to ?? ""}
        onFocus={merge.onFocus}
        onChange={(e) => onChange({ ...row, to: e.target.value || null }, merge.key())}
      />
    </div>
  );
}

const LIMIT = 1000;

/** The dimension's values in the data, to check. */
function LiveValues({ metrics, row, onChange }: { metrics: string; row: Extract<FilterRow, { kind: "in" }>; onChange(values: Scalar[]): void }) {
  const query = useMemo((): Query => ({ metrics, dimensions: [row.field], limit: LIMIT }), [metrics, row.field]);
  const data = useDevbiQuery(query, { crossfilter: false });
  const [search, setSearch] = useState("");
  const chosen = new Set(row.values.map(valueKey));
  const seen = new Set<string>();
  const values = [...row.values, ...data.rows.map((r) => plain(r[row.field] ?? null))].filter((v) => {
    const k = valueKey(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const shown = search ? values.filter((v) => valueText(v).toLowerCase().includes(search.toLowerCase())) : values;
  if (data.error) return <p className="devbi-ed-warn">{data.error.message}</p>;
  return (
    <>
      {values.length > 8 && <input type="search" aria-label="値を探す" placeholder="値を探す" value={search} onChange={(e) => setSearch(e.target.value)} />}
      <div className="devbi-ed-values">
        {data.loading && !data.rows.length && <small className="devbi-hint">値を読んでいます…</small>}
        {shown.map((v) => {
          const k = valueKey(v);
          return (
            <label key={k}>
              <input
                type="checkbox"
                checked={chosen.has(k)}
                onChange={() => onChange(chosen.has(k) ? row.values.filter((x) => valueKey(x) !== k) : [...row.values, plain(v)])}
              />
              <span>{valueText(v)}</span>
            </label>
          );
        })}
      </div>
      {data.rows.length >= LIMIT && <small className="devbi-hint">最初の {LIMIT} 件を出しています</small>}
    </>
  );
}

/**
 * Values typed in, comma-separated (when the data cannot be read: the dashboard has a problem to fix first). Only
 * a changed text is written, and a value written as it was keeps its type (`null`, numbers).
 */
function TypedValues({ row, onChange }: { row: Extract<FilterRow, { kind: "in" }>; onChange(values: Scalar[]): void }) {
  const written = row.values.map(valueText).join(", ");
  const [text, setText] = useState(written);
  useEffect(() => setText(written), [written]);
  return (
    <input
      type="text"
      aria-label="値（カンマ区切り）"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text === written) return;
        const tokens = text
          .split(/[,、]/)
          .map((s) => s.trim())
          .filter(Boolean);
        onChange(tokens.map((t) => row.values.find((v) => valueText(v) === t) ?? t));
      }}
    />
  );
}

/** Sort keys over the tile's output columns, each column once. */
function SortEditor({ view, query, set }: { view: MetricsView; query: Query; set(key: keyof Query, value: unknown): void }) {
  const keys = sortKeys(query.sort);
  const outputs: [string, string, boolean][] = [
    ...(query.measures ?? []).map((m) => [m, view.measures[m]?.label ?? m, true] as [string, string, boolean]),
    ...(query.dimensions ?? []).map((d) => [d, view.dimensions[d]?.label ?? d, false] as [string, string, boolean]),
    ...(query.time && view.time ? [[view.time.name, view.time.label, false] as [string, string, boolean]] : []),
  ];
  const labelOf = (f: string) => outputs.find(([n]) => n === f)?.[1] ?? f;
  const write = (next: typeof keys) => set("sort", sortSpecs(next));
  const usedElsewhere = (i: number) => new Set(keys.filter((_, j) => j !== i).map((k) => k.field));
  const free = outputs.filter(([n]) => !keys.some((k) => k.field === n));
  return (
    <fieldset>
      <legend>並び順</legend>
      {keys.map((k, i) => (
        <div className="devbi-ed-row" key={i}>
          <select aria-label={`${i + 1} 番目に並べる列`} value={k.field} onChange={(e) => write(keys.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}>
            {outputs
              .filter(([n]) => !usedElsewhere(i).has(n))
              .map(([n, l]) => (
                <option key={n} value={n}>
                  {l}
                </option>
              ))}
            {!outputs.some(([n]) => n === k.field) && <option value={k.field}>{k.field}（結果にありません）</option>}
          </select>
          <select
            aria-label={`${labelOf(k.field)}の向き`}
            value={k.desc ? "desc" : "asc"}
            onChange={(e) => write(keys.map((x, j) => (j === i ? { ...x, desc: e.target.value === "desc" } : x)))}
          >
            <option value="asc">小さい順</option>
            <option value="desc">大きい順</option>
          </select>
          <button type="button" className="devbi-ed-mini" aria-label={`${labelOf(k.field)}の並び順を消す`} onClick={() => write(keys.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      {free.length > 0 && (
        <select
          aria-label="並び順を追加"
          value=""
          onChange={(e) => {
            const o = outputs.find(([n]) => n === e.target.value);
            if (o) write([...keys, { field: o[0], desc: o[2] }]);
          }}
        >
          <option value="">＋ 並び順を追加</option>
          {free.map(([n, l]) => (
            <option key={n} value={n}>
              {l}
            </option>
          ))}
        </select>
      )}
      {!keys.length && <small className="devbi-hint">指定しないときは、時間の順か、最初の指標の大きい順</small>}
    </fieldset>
  );
}

/** The tile type's options (TILE_TYPES[type].options). Left at 既定, an option is not written. */
function OptionsEditor({
  metrics,
  spec,
  tile,
  type,
  onTile,
  clearSelection,
}: {
  metrics: Record<string, MetricsView>;
  spec: RawDashboard;
  tile: RawTile;
  type: BuiltinTileType;
  onTile: OnTile;
  clearSelection(id: string): void;
}) {
  const options = isObj(tile.options) ? tile.options : {};
  const entries = Object.entries(TILE_TYPES[type].options) as [string, TileOptionSchema][];
  const name = metricsNameOf(metrics, spec, tile);
  const view = name && Object.hasOwn(metrics, name) ? metrics[name] : undefined;
  // The period picker takes its default when it starts: start it over so the change shows.
  const restart = type === "date-range";
  const set = (key: string, value: unknown, merge?: string) => {
    if (restart) clearSelection(tile.id);
    onTile((t) => setOption(t, key, value), merge);
  };
  const control = (key: string, o: TileOptionSchema, ids: Ids) => {
    const value = options[key];
    if (o.enum) {
      return (
        <select {...ids} value={str(value)} onChange={(e) => set(key, e.target.value)}>
          <option value="">既定</option>
          {o.enum.map((v, i) => (
            <option key={v} value={v}>
              {o.enumLabels?.[i] ?? v}
            </option>
          ))}
        </select>
      );
    }
    if (o.type === "boolean") {
      return (
        <select {...ids} value={typeof value === "boolean" ? String(value) : ""} onChange={(e) => set(key, e.target.value === "" ? undefined : e.target.value === "true")}>
          <option value="">既定</option>
          <option value="true">はい</option>
          <option value="false">いいえ</option>
        </select>
      );
    }
    if (o.type === "number") return <NumberInput {...ids} value={typeof value === "number" ? value : undefined} onChange={(n, merge) => set(key, n, merge)} />;
    if (o.input === "field") {
      const fields = view ? fieldsOf(view) : [];
      const current = str(value);
      return (
        <select {...ids} value={current} onChange={(e) => set(key, e.target.value)}>
          <option value="">既定</option>
          {fields.map(([n, l]) => (
            <option key={n} value={n}>
              {l}
            </option>
          ))}
          {current && !fields.some(([n]) => n === current) && <option value={current}>{current}（ありません）</option>}
        </select>
      );
    }
    if (o.input === "metrics") return <MetricsSelect {...ids} metrics={metrics} value={str(value)} empty="ダッシュボードと同じ" onChange={(v) => set(key, v)} />;
    return <TextInput {...ids} multiline={o.input === "text"} value={str(value)} onChange={(v, merge) => set(key, v, merge)} />;
  };
  return (
    <>
      <h3>表示</h3>
      {entries.map(([key, o]) => (
        <Field key={key} label={o.label} hint={o.description}>
          {(ids) => control(key, o, ids)}
        </Field>
      ))}
    </>
  );
}
