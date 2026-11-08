import { injectStyles, themeAttribute, type NewDashboardProps } from "@devbi/react";
import { useId, useInsertionEffect, useState, type FormEvent } from "react";
import { writeDashboard } from "./api.js";
import type { RawDashboard } from "./layout.js";
import { injectEditorStyles } from "./styles.js";

/** Same rule as the dev server's (letters, digits, - and _): the name is the file name and the page's address. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The form for a new dashboard: its file name, heading and metrics file. Writes an empty dash.json. */
export function NewDashboard({ project, dev, theme, onCreated, onCancel }: NewDashboardProps) {
  useInsertionEffect(injectStyles, []);
  useInsertionEffect(injectEditorStyles, []);
  const id = useId();
  const views = Object.keys(project.metrics).sort();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [metrics, setMetrics] = useState(views[0] ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const taken = Object.hasOwn(project.dashboards, name);
  const nameProblem = !name
    ? null
    : !NAME.test(name)
      ? "半角の英数字と - _ で書いてください（先頭は英数字、64 文字まで）"
      : taken
        ? "その名前のダッシュボードはもうあります"
        : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name || nameProblem || busy) return;
    setBusy(true);
    setError(null);
    const spec: RawDashboard = {
      $schema: "../.devbi/dash.schema.json",
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(metrics ? { metrics } : {}),
      tiles: [],
    };
    try {
      const written = await writeDashboard(dev, name, spec, null);
      onCreated(name, { path: written.path, spec });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="devbi-root" {...themeAttribute(theme)}>
      <form className="devbi-ed-form" onSubmit={(e) => void submit(e)} aria-labelledby={`${id}-h`}>
        <h1 id={`${id}-h`}>新しいダッシュボード</h1>
        <div className="devbi-ed-field">
          <label htmlFor={`${id}-name`}>ファイル名</label>
          <input
            id={`${id}-name`}
            value={name}
            onChange={(e) => setName(e.target.value.trim())}
            placeholder="sales-monthly"
            autoFocus
            required
            aria-invalid={!!nameProblem}
            aria-describedby={`${id}-name-hint`}
          />
          <small id={`${id}-name-hint`}>{nameProblem ?? `dashboards/${name || "<ファイル名>"}.dash.json を作ります。ページの場所は #/${name || "<ファイル名>"}`}</small>
        </div>
        <div className="devbi-ed-field">
          <label htmlFor={`${id}-title`}>見出し</label>
          <input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={name || "月次の売上"} aria-describedby={`${id}-title-hint`} />
          <small id={`${id}-title-hint`}>空ならファイル名にします</small>
        </div>
        <div className="devbi-ed-field">
          <label htmlFor={`${id}-metrics`}>指標ファイル</label>
          {views.length ? (
            <select id={`${id}-metrics`} value={metrics} onChange={(e) => setMetrics(e.target.value)} aria-describedby={`${id}-metrics-hint`}>
              {views.map((v) => (
                <option key={v} value={v}>
                  {project.metrics[v]!.label === v ? v : `${project.metrics[v]!.label}（${v}）`}
                </option>
              ))}
            </select>
          ) : null}
          <small id={`${id}-metrics-hint`}>
            {views.length ? `タイルが使う指標と軸（models/${metrics}.metrics.yaml）` : "models/ に *.metrics.yaml がまだありません。先に指標と軸を書いてください"}
          </small>
        </div>
        {error && (
          <p className="devbi-error" role="alert">
            {error}
          </p>
        )}
        <div className="devbi-ed-buttons">
          <button type="button" className="devbi-button" onClick={onCancel}>
            やめる
          </button>
          <button type="submit" className="devbi-button devbi-button-primary" disabled={!name || !!nameProblem || busy}>
            {busy ? "作っています…" : "作って編集する"}
          </button>
        </div>
      </form>
    </div>
  );
}
