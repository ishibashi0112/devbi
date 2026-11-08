import { useDevbiQuery } from "@devbi/react";
import { GRAINS, TILE_TYPES, TILE_TYPE_NAMES, compileQuery, type BuiltinTileType, type Grain, type MetricsView, type Query, type Scalar, type TileOptionSchema } from "devbi";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  changeType,
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

export interface PanelProps {
  metrics: Record<string, MetricsView>;
  /** The dashboard's file name (`dashboards/<name>.dash.json`). */
  name: string;
  spec: RawDashboard;
  selected: string | null;
  /** Inside the dashboard's DevbiProvider: a filter's values can be read from the data. */
  live: boolean;
  onSelect(id: string | null): void;
  /** `merge`: the same key as the change before folds both into one undo step (typing in a text box). */
  onChange(next: RawDashboard, merge?: string): void;
  onRemove(id: string): void;
  /** Clear a tile's selection (its period, for instance), so the tile starts over. */
  clearSelection(id: string): void;
}

/**
 * The property panel: the selected tile's type, title, data (measures, dimensions, time grain, filters, sort,
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

/** A label, a control and a hint under it, tied together for screen readers. */
function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children(ids: { id: string; "aria-describedby"?: string }): ReactNode }) {
  const id = useId();
  return (
    <div className="devbi-ed-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, ...(hint ? { "aria-describedby": `${id}-hint` } : {}) })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}

/** A text box whose typing, from focus to blur, is one undo step. */
function TextInput({
  value,
  onChange,
  multiline,
  ...rest
}: {
  value: string;
  onChange(value: string, merge: string): void;
  multiline?: boolean;
  id: string;
  placeholder?: string;
  "aria-describedby"?: string;
}) {
  const key = useId();
  const session = useRef(0);
  const common = {
    ...rest,
    value,
    onFocus: () => session.current++,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value, `${key}#${session.current}`),
  };
  return multiline ? <textarea {...common} /> : <input type="text" {...common} />;
}

function DashboardPanel({ metrics, name, spec, onChange }: PanelProps) {
  const names = Object.keys(metrics).sort();
  const current = typeof spec.metrics === "string" ? spec.metrics : "";
  return (
    <>
      <h2>ダッシュボード</h2>
      <Field label="見出し" hint={`空のときはファイル名（${name}）`}>
        {(ids) => (
          <TextInput {...ids} placeholder={name} value={typeof spec.title === "string" ? spec.title : ""} onChange={(v, merge) => onChange(setDashboardKey(spec, "title", v), merge)} />
        )}
      </Field>
      <Field label="説明" hint="見出しの横に出る一文">
        {(ids) => (
          <TextInput {...ids} value={typeof spec.description === "string" ? spec.description : ""} onChange={(v, merge) => onChange(setDashboardKey(spec, "description", v), merge)} />
        )}
      </Field>
      <Field label="指標ファイル" hint={names.length === 1 ? "指標ファイルが 1 つだけなので、指定しなくても使われます" : "タイルが使う models/<名前>.metrics.yaml"}>
        {(ids) => (
          <select {...ids} value={current} onChange={(e) => onChange(setDashboardKey(spec, "metrics", e.target.value))}>
            <option value="">指定しない</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {metrics[n]!.label}（{n}）
              </option>
            ))}
            {current && !names.includes(current) && <option value={current}>{current}（ありません）</option>}
          </select>
        )}
      </Field>
      <p className="devbi-hint">タイルを押すと、そのタイルの種類・見出し・データをここで変えられます。</p>
    </>
  );
}

function TilePanel({ metrics, spec, tile, live, onSelect, onChange, onRemove, clearSelection }: PanelProps & { tile: RawTile }) {
  const onTile = (update: (t: RawTile) => RawTile, merge?: string) => onChange(updateTile(spec, tile.id, update), merge);
  const type = typeof tile.type === "string" ? tile.type : undefined;
  const builtin = type && Object.hasOwn(TILE_TYPES, type) ? (type as BuiltinTileType) : undefined;
  const component = typeof tile.component === "string" ? tile.component : undefined;
  const showQuery = builtin ? TILE_TYPES[builtin].query : isObj(tile.query);
  return (
    <>
      <div className="devbi-ed-panel-head">
        <h2>{typeof tile.title === "string" && tile.title ? tile.title : tile.id}</h2>
        <button type="button" className="devbi-ed-mini" onClick={() => onSelect(null)}>
          ダッシュボード全体
        </button>
      </div>
      {component ? (
        <p className="devbi-hint">
          コードのタイルです（<code className="devbi-ed-code">{component}</code>）。中身とデータの指定はそのファイルで変えます。
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
        {(ids) => <TextInput {...ids} value={typeof tile.title === "string" ? tile.title : ""} onChange={(v, merge) => onTile((t) => setTileKey(t, "title", v), merge)} />}
      </Field>
      <IdField
        spec={spec}
        tile={tile}
        onRename={(id) => {
          clearSelection(tile.id);
          onChange(updateTile(spec, tile.id, (t) => setTileKey(t, "id", id)));
          onSelect(id);
        }}
      />
      {showQuery && <QueryEditor metrics={metrics} spec={spec} tile={tile} live={live} onTile={onTile} />}
      {builtin && Object.keys(TILE_TYPES[builtin].options).length > 0 && (
        <OptionsEditor metrics={metrics} spec={spec} tile={tile} type={builtin} onTile={onTile} clearSelection={clearSelection} />
      )}
      <button type="button" className="devbi-button devbi-ed-danger" onClick={() => onRemove(tile.id)}>
        このタイルを消す
      </button>
    </>
  );
}

/** The tile's id: taken when the box is left or Enter is pressed, and only when no other tile has it. */
function IdField({ spec, tile, onRename }: { spec: RawDashboard; tile: RawTile; onRename(id: string): void }) {
  const [text, setText] = useState(tile.id);
  useEffect(() => setText(tile.id), [tile.id]);
  const problem = idProblem(spec, tile.id, text);
  const commit = () => {
    if (problem) setText(tile.id);
    else if (text !== tile.id) onRename(text);
  };
  return (
    <Field label="名前（id）" hint={problem ?? "dash.json でタイルを見分ける名前"}>
      {(ids) => (
        <input
          {...ids}
          type="text"
          value={text}
          aria-invalid={!!problem}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !problem) commit();
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
  const own = typeof query.metrics === "string" ? query.metrics : "";
  const dashboardDefault = typeof spec.metrics === "string" ? spec.metrics : names.length === 1 ? names[0] : undefined;
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
            <select {...ids} value={own} onChange={(e) => set("metrics", e.target.value)}>
              <option value="">ダッシュボードと同じ{dashboardDefault ? `（${dashboardDefault}）` : ""}</option>
              {names.map((n) => (
                <option key={n} value={n}>
                  {metrics[n]!.label}（{n}）
                </option>
              ))}
              {own && !names.includes(own) && <option value={own}>{own}（ありません）</option>}
            </select>
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
          <FiltersEditor view={view} query={query} live={live} set={set} />
          <SortEditor view={view} query={query} set={set} />
          <Field label="件数" hint="空のときはすべての行">
            {(ids) => (
              <input
                {...ids}
                type="number"
                min={1}
                step={1}
                value={typeof query.limit === "number" ? query.limit : ""}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (e.target.value === "") set("limit", undefined);
                  else if (Number.isInteger(n) && n >= 1) set("limit", n, `${tile.id}:limit`);
                }}
              />
            )}
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

const plain = (v: Scalar): Scalar => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
const valueKey = (v: Scalar) => JSON.stringify(plain(v));
const valueText = (v: Scalar) => (v === null ? "（空欄）" : String(plain(v)));

/** Fixed filters: values of a dimension to keep, or days of the time column. */
function FiltersEditor({ view, query, live, set }: { view: MetricsView; query: Query; live: boolean; set(key: keyof Query, value: unknown): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const timeName = view.time?.name;
  const filters = (query.filters ?? []) as unknown[];
  const fields: [string, string][] = [
    ...(view.time ? [[view.time.name, view.time.label] as [string, string]] : []),
    ...Object.entries(view.dimensions).map(([n, d]) => [n, d.label] as [string, string]),
  ];
  const labelOf = (f: string) => fields.find(([n]) => n === f)?.[1] ?? f;
  const used = new Set(filters.map((f) => (isObj(f) ? f.field : undefined)));
  const write = (at: number | null, row: Exclude<FilterRow, { kind: "other" }>) => {
    const f = rowFilter(row);
    const next = [...filters];
    if (at === null) {
      if (!f) return;
      next.push(f);
      setDraft(null);
    } else if (f) next[at] = f;
    else next.splice(at, 1);
    set("filters", next);
  };
  const remove = (at: number) => set("filters", filters.filter((_, i) => i !== at));
  const rowFor = (field: string): Exclude<FilterRow, { kind: "other" }> =>
    field === timeName ? { kind: "period", field, from: null, to: null } : { kind: "in", field, values: [] };
  const editor = (row: Exclude<FilterRow, { kind: "other" }>, at: number | null) =>
    row.kind === "in" ? (
      live ? (
        <LiveValues metrics={view.name} row={row} onChange={(values) => write(at, { ...row, values })} />
      ) : (
        <TypedValues row={row} onChange={(values) => write(at, { ...row, values })} />
      )
    ) : (
      <div className="devbi-ed-row">
        <input type="date" aria-label={`${labelOf(row.field)}の始まり`} value={row.from ?? ""} onChange={(e) => write(at, { ...row, from: e.target.value || null })} />
        <span>〜</span>
        <input type="date" aria-label={`${labelOf(row.field)}の終わり（この日を含む）`} value={row.to ?? ""} onChange={(e) => write(at, { ...row, to: e.target.value || null })} />
      </div>
    );
  return (
    <fieldset>
      <legend>絞り込み</legend>
      {filters.map((f, i) => {
        const row = filterRow(f, timeName);
        const field = row.kind === "other" ? (isObj(f) && typeof f.field === "string" ? f.field : "?") : row.field;
        return (
          <div className="devbi-ed-filter" key={i}>
            <div className="devbi-ed-row">
              <strong>{labelOf(field)}</strong>
              <button type="button" className="devbi-ed-mini" aria-label={`${labelOf(field)}の絞り込みを消す`} onClick={() => remove(i)}>
                ×
              </button>
            </div>
            {row.kind === "other" ? (
              <>
                <code className="devbi-ed-code">{JSON.stringify(f)}</code>
                <small className="devbi-hint">ここでは変えられない形です。dash.json で直してください</small>
              </>
            ) : (
              editor(row, i)
            )}
          </div>
        );
      })}
      {draft !== null && (
        <div className="devbi-ed-filter">
          <div className="devbi-ed-row">
            <strong>{labelOf(draft)}</strong>
            <button type="button" className="devbi-ed-mini" onClick={() => setDraft(null)}>
              やめる
            </button>
          </div>
          {editor(rowFor(draft), null)}
        </div>
      )}
      {draft === null && fields.some(([n]) => !used.has(n)) && (
        <select aria-label="絞り込みを追加" value="" onChange={(e) => e.target.value && setDraft(e.target.value)}>
          <option value="">＋ 絞り込みを追加</option>
          {fields
            .filter(([n]) => !used.has(n))
            .map(([n, l]) => (
              <option key={n} value={n}>
                {l}
              </option>
            ))}
        </select>
      )}
    </fieldset>
  );
}

const LIMIT = 1000;

/** The dimension's values in the data, to check. */
function LiveValues({ metrics, row, onChange }: { metrics: string; row: Extract<FilterRow, { kind: "in" }>; onChange(values: Scalar[]): void }) {
  const query = useMemo((): Query => ({ metrics, dimensions: [row.field], limit: LIMIT }), [metrics, row.field]);
  const data = useDevbiQuery(query, { crossfilter: false });
  const [search, setSearch] = useState("");
  const chosen = new Set(row.values.map(valueKey));
  const all = [...row.values, ...data.rows.map((r) => plain(r[row.field] ?? null))];
  const seen = new Set<string>();
  const values = all.filter((v) => {
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

/** Values typed in, comma-separated (when the data cannot be read: the dashboard has a problem to fix first). */
function TypedValues({ row, onChange }: { row: Extract<FilterRow, { kind: "in" }>; onChange(values: Scalar[]): void }) {
  const [text, setText] = useState(row.values.map(valueText).join(", "));
  return (
    <input
      type="text"
      aria-label="値（カンマ区切り）"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() =>
        onChange(
          text
            .split(/[,、]/)
            .map((s) => s.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

/** Sort keys over the tile's output columns. */
function SortEditor({ view, query, set }: { view: MetricsView; query: Query; set(key: keyof Query, value: unknown): void }) {
  const keys = sortKeys(query.sort);
  const outputs: [string, string, boolean][] = [
    ...(query.measures ?? []).map((m) => [m, view.measures[m]?.label ?? m, true] as [string, string, boolean]),
    ...(query.dimensions ?? []).map((d) => [d, view.dimensions[d]?.label ?? d, false] as [string, string, boolean]),
    ...(query.time && view.time ? [[view.time.name, view.time.label, false] as [string, string, boolean]] : []),
  ];
  const labelOf = (f: string) => outputs.find(([n]) => n === f)?.[1] ?? f;
  const write = (next: typeof keys) => set("sort", sortSpecs(next));
  const free = outputs.filter(([n]) => !keys.some((k) => k.field === n));
  return (
    <fieldset>
      <legend>並び順</legend>
      {keys.map((k, i) => (
        <div className="devbi-ed-row" key={i}>
          <select aria-label={`${i + 1} 番目に並べる列`} value={k.field} onChange={(e) => write(keys.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}>
            {outputs.map(([n, l]) => (
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
  return (
    <>
      <h3>表示</h3>
      {entries.map(([key, o]) => {
        const value = options[key];
        return (
          <Field key={key} label={o.label} hint={o.description}>
            {(ids) => {
              if (o.enum) {
                return (
                  <select {...ids} value={typeof value === "string" ? value : ""} onChange={(e) => set(key, e.target.value)}>
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
              if (o.type === "number") {
                return (
                  <input
                    {...ids}
                    type="number"
                    value={typeof value === "number" ? value : ""}
                    onChange={(e) => set(key, e.target.value === "" ? undefined : Number(e.target.value), `${tile.id}:${key}`)}
                  />
                );
              }
              if (o.input === "field") {
                const fields: [string, string][] = view
                  ? [...(view.time ? [[view.time.name, view.time.label] as [string, string]] : []), ...Object.entries(view.dimensions).map(([n, d]) => [n, d.label] as [string, string])]
                  : [];
                return (
                  <select {...ids} value={typeof value === "string" ? value : ""} onChange={(e) => set(key, e.target.value)}>
                    <option value="">既定</option>
                    {fields.map(([n, l]) => (
                      <option key={n} value={n}>
                        {l}
                      </option>
                    ))}
                    {typeof value === "string" && value && !fields.some(([n]) => n === value) && <option value={value}>{value}（ありません）</option>}
                  </select>
                );
              }
              if (o.input === "metrics") {
                const names = Object.keys(metrics).sort();
                return (
                  <select {...ids} value={typeof value === "string" ? value : ""} onChange={(e) => set(key, e.target.value)}>
                    <option value="">ダッシュボードと同じ</option>
                    {names.map((n) => (
                      <option key={n} value={n}>
                        {metrics[n]!.label}（{n}）
                      </option>
                    ))}
                    {typeof value === "string" && value && !names.includes(value) && <option value={value}>{value}（ありません）</option>}
                  </select>
                );
              }
              return <TextInput {...ids} multiline={o.input === "text"} value={typeof value === "string" ? value : ""} onChange={(v, merge) => set(key, v, merge)} />;
            }}
          </Field>
        );
      })}
    </>
  );
}
