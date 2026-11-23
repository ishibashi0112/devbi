import { fromText, paramText, splitList, type DashboardParam, type ParamScalar, type ParamValue } from "devbi";
import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { useDevbi, useParamsVersion } from "./context.js";
import type { Choice, ChoicesState } from "./param-store.js";

type Value = ParamValue | undefined;
type One = Exclude<ParamScalar, null>;

/** What a text box shows for a value. */
function textOf(v: Value): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map(paramText).join(", ");
  return paramText(v);
}

/** What to fill in, when a typed value does not fit. */
function hintOf(p: DashboardParam): string {
  switch (p.type) {
    case "integer":
      return "整数を入れてください";
    case "number":
      return "数値を入れてください";
    case "date":
      return "日付を入れてください";
    case "datetime":
      return "日時を入れてください";
    default:
      return "";
  }
}

/** The value a text box holds, or undefined when it does not fit the type (empty: null when optional). */
function parse(p: DashboardParam, text: string): { value: Value } | undefined {
  if (p.multiple) {
    const parts = splitList(text);
    const list = parts.map((t) => fromText(p, t));
    return list.every((v) => v !== undefined) ? { value: list as One[] } : undefined;
  }
  if (text.trim() === "") return { value: p.optional ? null : undefined };
  const v = fromText(p, text);
  return v === undefined ? undefined : { value: v };
}

/** The form of an input: the browser's date and time pickers for dates. */
function inputType(p: DashboardParam): string {
  if (p.multiple) return "text";
  return p.type === "date" ? "date" : p.type === "datetime" ? "datetime-local" : "text";
}

/** A typed value: committed with Enter, on leaving the box, and (dates) a moment after the picker sets one. */
function TextField({ id, param: p, value, onCommit }: { id: string; param: DashboardParam; value: Value; onCommit: (v: Value) => void }) {
  const [text, setText] = useState(() => textOf(value));
  const [bad, setBad] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A value set elsewhere (the URL, the choices, 更新) shows here.
  useEffect(() => {
    setText(textOf(value));
    setBad(false);
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = (t: string) => {
    clearTimeout(timer.current);
    const r = parse(p, t);
    setBad(!r);
    if (r) onCommit(r.value);
  };
  const picker = inputType(p) !== "text";
  return (
    <>
      <input
        id={id}
        type={inputType(p)}
        value={text}
        step={p.type === "datetime" ? 60 : undefined}
        inputMode={p.type === "integer" ? "numeric" : p.type === "number" ? "decimal" : undefined}
        placeholder={p.multiple ? "値を , で区切って" : p.optional ? "（指定なし）" : undefined}
        aria-invalid={bad || undefined}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          // A picker sets a whole date at once; typing a year sets one each digit: wait for the last.
          if (picker) {
            clearTimeout(timer.current);
            timer.current = setTimeout(() => commit(t), 800);
          }
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            commit(e.currentTarget.value);
          }
        }}
      />
      {bad && <span className="devbi-param-bad">{hintOf(p) || "値を確かめてください"}</span>}
    </>
  );
}

/** One value from a list: the choices, or はい / いいえ. */
function SelectField({
  id,
  param: p,
  value,
  items,
  loading,
  onCommit,
}: {
  id: string;
  param: DashboardParam;
  value: Value;
  items: Choice[];
  loading: boolean;
  onCommit: (v: Value) => void;
}) {
  const at = value === undefined || value === null ? -1 : items.findIndex((c) => String(c.value) === String(value));
  // A value that is not (yet) among the choices still shows.
  const extra = at === -1 && value !== undefined && value !== null && !Array.isArray(value);
  const current = at >= 0 ? String(at) : extra ? "extra" : value === null ? "null" : "";
  return (
    <select
      id={id}
      value={current}
      disabled={loading && !items.length}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "null") onCommit(null);
        else if (v !== "" && v !== "extra") onCommit(items[Number(v)]!.value);
      }}
    >
      {value === undefined && (
        <option value="" disabled>
          {loading ? "読み込み中…" : "選んでください"}
        </option>
      )}
      {p.optional && <option value="null">（指定なし）</option>}
      {extra && <option value="extra">{paramText(value as One)}</option>}
      {items.map((c, i) => (
        <option key={i} value={String(i)}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

/** Several values from the choices: a list of check boxes that opens below; the value is set when it closes. */
function MultiField({ id, param: p, value, state, onCommit }: { id: string; param: DashboardParam; value: Value; state: ChoicesState | undefined; onCommit: (v: Value) => void }) {
  const items = state?.items ?? [];
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  const list = Array.isArray(value) ? value : [];
  const close = (commit: boolean) => {
    setOpen(false);
    if (!commit) return;
    // In the choices' order; values beyond a cut list (more than 10,000 choices) stay as they are.
    const shown = new Set(items.map((c) => String(c.value)));
    const next = [
      ...items.filter((c) => picked.has(String(c.value))).map((c) => c.value),
      ...(state?.truncated ? list.filter((v) => !shown.has(String(v))) : []),
    ];
    const key = (vs: readonly unknown[]) => JSON.stringify(vs.map(String).sort());
    if (key(next) !== key(list)) onCommit(next);
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) closeRef.current(true);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const labels = new Map(items.map((c) => [String(c.value), c.label]));
  const names = list.map((v) => labels.get(String(v)) ?? paramText(v));
  const summary =
    state?.loading && !items.length
      ? "読み込み中…"
      : list.length === 0
        ? "選んでください"
        : items.length > 0 && list.length === items.length && !state?.truncated
          ? `すべて（${items.length}）`
          : names.length > 2
            ? `${names.slice(0, 2).join("、")} ほか ${names.length - 2}`
            : names.join("、");
  return (
    <div
      className="devbi-multi"
      ref={box}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close(true);
          box.current?.querySelector("button")?.focus();
        }
      }}
      onBlur={(e: FocusEvent<HTMLDivElement>) => {
        if (open && !box.current?.contains(e.relatedTarget as Node | null)) close(true);
      }}
    >
      <button
        id={id}
        type="button"
        className="devbi-multi-button"
        aria-expanded={open}
        disabled={!!state?.loading && !items.length}
        onClick={() => {
          if (open) close(true);
          else {
            setPicked(new Set(list.map(String)));
            setOpen(true);
          }
        }}
      >
        {summary}
      </button>
      {open && (
        <div className="devbi-multi-list" role="group" aria-label={p.label}>
          <div className="devbi-multi-tools">
            <button type="button" onClick={() => setPicked(new Set(items.map((c) => String(c.value))))}>
              すべて選ぶ
            </button>
            <button type="button" onClick={() => setPicked(new Set())}>
              すべて外す
            </button>
          </div>
          {items.map((c, i) => (
            <label key={i}>
              <input
                type="checkbox"
                checked={picked.has(String(c.value))}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(String(c.value));
                  else next.delete(String(c.value));
                  setPicked(next);
                }}
              />
              {c.label}
            </label>
          ))}
          {state?.truncated && <p className="devbi-hint">ほかにもあります（最初の {items.length.toLocaleString("ja-JP")} 件）</p>}
        </div>
      )}
    </div>
  );
}

function ParamField({ param: p }: { param: DashboardParam }) {
  const { params: store } = useDevbi();
  const id = useId();
  const value = store.draftValue(p.name);
  const state = p.values ? store.choicesOf(p.name) : undefined;
  const commit = (v: Value) => store.set(p.name, v);
  let control;
  if (p.values && p.multiple) control = <MultiField id={id} param={p} value={value} state={state} onCommit={commit} />;
  else if (p.values) control = <SelectField id={id} param={p} value={value} items={state?.items ?? []} loading={!!state?.loading} onCommit={commit} />;
  else if (p.type === "boolean" && !p.multiple)
    control = (
      <SelectField
        id={id}
        param={p}
        value={value}
        items={[
          { value: true, label: "はい" },
          { value: false, label: "いいえ" },
        ]}
        loading={false}
        onCommit={commit}
      />
    );
  else control = <TextField id={id} param={p} value={value} onCommit={commit} />;
  return (
    <div className="devbi-param" data-param={p.name}>
      <label htmlFor={id}>{p.label}</label>
      {control}
      {state?.error && <span className="devbi-param-bad">候補を読めません: {state.error.message}</span>}
    </div>
  );
}

/**
 * The dashboard's parameters, under its heading (SSRS's toolbar): one input each, in the order of dash.json's
 * `params` and then of the tiles. With `apply: "button"`, 表示 applies what was changed.
 */
export function ParamBar() {
  const { params: store } = useDevbi();
  useParamsVersion();
  const shown = store.list.filter((p) => !p.hidden);
  if (!shown.length && !store.problems.length) return null;
  return (
    <form
      className="devbi-params"
      aria-label="パラメーター"
      onSubmit={(e) => {
        e.preventDefault();
        store.applyDraft();
      }}
    >
      {store.problems.length > 0 && <pre className="devbi-error devbi-params-problems">{store.problems.join("\n")}</pre>}
      {shown.map((p) => (
        <ParamField key={p.name} param={p} />
      ))}
      {store.apply === "button" && (
        <button type="submit" className="devbi-button devbi-button-primary" disabled={!store.dirty()}>
          表示
        </button>
      )}
    </form>
  );
}
