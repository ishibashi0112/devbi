import {
  checkParamValues,
  dashboardParams,
  datasetTiles,
  paramsFromSearch,
  paramsToSearch,
  type DashboardParam,
  type ParamValue,
  type TileSpec,
} from "devbi";
import { useCallback, useEffect, useInsertionEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DevbiProvider, fieldInfo, useDevbi, useParamsVersion, useSelectionVersion } from "./context.js";
import { describeFilter, snapshotText } from "./describe.js";
import { readDevUser, writeDevUser, type DevServer, type DevUserInfo, type EditorModule, type SavedDashboard } from "./dev.js";
import type { SnapshotInfo } from "./engine.js";
import { ExportMenu, exportKinds, type ExportKind } from "./ExportMenu.js";
import { formatTimesOfDay, loadProject, snapshotTimesOf, viewsOf, type Project, type ProjectInput } from "./project.js";
import { ParamBar } from "./ParamBar.js";
import { injectStyles } from "./styles.js";
import { TileFrame } from "./TileFrame.js";

function ActiveFilters() {
  const ctx = useDevbi();
  useSelectionVersion();
  // Dataset tiles take no part in the selections: a dashboard of only those (and text) has none to show.
  if (ctx.dashboard.tiles.every((t) => t.query?.dataset !== undefined || t.type === "markdown")) return null;
  const entries = ctx.selection.entries();
  let view: ReturnType<typeof ctx.view> | undefined;
  try {
    view = ctx.view();
  } catch {
    view = undefined;
  }
  const titles = new Map(ctx.dashboard.tiles.map((t) => [t.id, t.title ?? t.id]));
  return (
    <div className="devbi-filters" aria-live="polite">
      {entries.length === 0 ? (
        <span className="devbi-hint">グラフや表をクリックすると、ほかのタイルがその値で絞り込まれます</span>
      ) : (
        <>
          {entries.map((e) =>
            e.filters.map((f, i) => {
              const info = view ? fieldInfo(view, [], f.field) : { label: f.field };
              const isTime = view?.time?.name === f.field;
              const text = describeFilter(f, isTime);
              return (
                <span className="devbi-chip" key={`${e.tileId}-${i}`} title={`${titles.get(e.tileId)}で選択`}>
                  {info.label}: {text}
                  <button type="button" aria-label={`${info.label}の絞り込みを外す`} onClick={() => ctx.selection.set(e.tileId, e.filters.filter((x) => x !== f))}>
                    ×
                  </button>
                </span>
              );
            }),
          )}
          <button type="button" className="devbi-clear-all" onClick={() => ctx.selection.clear()}>
            すべて解除
          </button>
        </>
      )}
    </div>
  );
}

/** When the data was taken, for a dashboard that reads snapshots: the oldest of them. Nothing for live data. */
function SnapshotNote() {
  const ctx = useDevbi();
  const [info, setInfo] = useState<SnapshotInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const views = viewsOf(ctx.project, ctx.dashboard);
    // Only a dashboard with metrics files starts the engine (DuckDB-wasm).
    if (!views.length || !Object.keys(ctx.project.snapshots).length) return;
    void ctx.engine
      .then((engine) => Promise.all(views.map((v) => engine.snapshotsOf(v))))
      .then(
        (all) => alive && setInfo(all.flat()),
        () => undefined, // the tiles show the error
      );
    return () => {
      alive = false;
    };
  }, [ctx]);
  const text = snapshotText(info);
  if (!text) return null;
  return (
    <p className="devbi-snapshot" data-testid="snapshot-note">
      {text}
    </p>
  );
}

/** 更新: read the datasets again (a dashboard with dataset tiles). */
function RefreshButton() {
  const ctx = useDevbi();
  return (
    <button type="button" className="devbi-button" title="データベースから読み直す" onClick={() => ctx.refresh()}>
      更新
    </button>
  );
}

/**
 * Keeps the parameters in step with the outside: values given later (React's `params`, the address bar), the
 * `onParamsChange` callback, and the address (DevbiApp: `#/<name>?from=…`, values that are not their default).
 */
function ParamsSync({
  given,
  onChange,
  onValues,
  url,
}: {
  given: Record<string, ParamValue> | undefined;
  onChange: ((values: Record<string, ParamValue>) => void) | undefined;
  /** The values that are not their default, after each change (what a store made again starts with). */
  onValues: (values: Record<string, ParamValue>) => void;
  url: string | undefined;
}) {
  const { params: store } = useDevbi();
  const version = useParamsVersion();
  const givenKey = JSON.stringify(given ?? null);
  const firstGiven = useRef(givenKey);
  useEffect(() => {
    if (givenKey === firstGiven.current) return; // the store started with them
    firstGiven.current = givenKey;
    if (given) store.setValues(given);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [givenKey, store]);
  // Another address typed in (or 戻る): its values.
  useEffect(() => {
    if (url === undefined) return;
    const on = () => {
      const [path = "", search = ""] = location.hash.replace(/^#\/?/, "").split("?");
      if (decodeURIComponent(path) !== url && path !== "") return;
      const problems: string[] = [];
      // The address leaves out the values that are their default: those go back to it.
      store.setValues(paramsFromSearch(store.list, search, problems), { others: "default" });
      for (const p of problems) console.warn(`DevBI: ${p}`);
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, [url, store]);
  const values = JSON.stringify(store.values());
  const last = useRef<string | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onValuesRef = useRef(onValues);
  onValuesRef.current = onValues;
  useEffect(() => {
    if (values === last.current) return;
    last.current = values;
    onChangeRef.current?.(JSON.parse(values) as Record<string, ParamValue>);
    const changed = store.changedValues();
    onValuesRef.current(changed);
    if (url !== undefined && store.list.length) {
      const search = paramsToSearch(store.list, changed);
      const hash = `#/${encodeURIComponent(url)}${search ? `?${search}` : ""}`;
      // Not a new history entry for each value (戻る goes to the page before), and no hashchange.
      if (location.hash !== hash) history.replaceState(history.state, "", hash);
    }
  }, [values, version, url, store]);
  return null;
}

/** The latest values, for this dashboard's parameters as they are now (a saved file may have changed a type). */
function seedFor(list: DashboardParam[] | undefined, values: Record<string, ParamValue>): Record<string, ParamValue> {
  return list ? checkParamValues(list, values).values : {};
}

function tileStyle(t: TileSpec, rowHeight: number): CSSProperties {
  return {
    gridColumn: `${t.x + 1} / span ${t.w}`,
    gridRow: `${t.y + 1} / span ${t.h}`,
    ["--devbi-mobile-h" as string]: `${Math.max(140, Math.round(t.h * rowHeight * 0.9))}px`,
  };
}

/** Below this width (of the dashboard, not the window) the tiles go in one column. */
export const NARROW_WIDTH = 720;

/** A ref that sets `data-devbi-narrow` on the element while it is narrower than NARROW_WIDTH (before paint). */
function narrowRef(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return;
  const update = (width: number) => el.toggleAttribute("data-devbi-narrow", width < NARROW_WIDTH);
  update(el.getBoundingClientRect().width);
  if (typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (entry) update(entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
  });
  observer.observe(el);
  return () => observer.disconnect();
}

/** Light or dark: `auto` follows the OS setting. Inside another app, `light` keeps the dashboard light like the page. */
export type Theme = "auto" | "light" | "dark";

/** The `data-theme` of `.devbi-root` for a theme (none for auto). */
export function themeAttribute(theme: Theme | undefined): { "data-theme"?: "light" | "dark" } {
  return theme === "light" || theme === "dark" ? { "data-theme": theme } : {};
}

const projectIds = new WeakMap<Project, number>();
let nextProjectId = 1;

/** Another project object starts the dashboard fresh (selections and tile state), not half updated. */
function projectKey(project: Project): number {
  let id = projectIds.get(project);
  if (id === undefined) projectIds.set(project, (id = nextProjectId++));
  return id;
}

/**
 * Render one dashboard of a project. Pass the same project object each time (it is `loadProject()`'s result).
 * `isolate`: inside another app's page, keep that page's CSS for plain elements (h1 { … }, td { … }) out.
 */
export function Dashboard({
  project,
  name,
  back,
  theme,
  isolate,
  exports = true,
  actions,
  params,
  onParamsChange,
  paramsInUrl,
}: {
  project: Project;
  name: string;
  back?: string;
  theme?: Theme;
  isolate?: boolean;
  /**
   * The ファイル出力 menu in the heading (Excel, 印刷・PDF, CSV). Default `true`; `false` leaves it out, a list such as
   * `["xlsx", "pdf"]` offers only those.
   */
  exports?: boolean | readonly ExportKind[];
  /** Buttons at the end of the heading (DevbiApp's 編集 on the dev server). */
  actions?: ReactNode;
  /**
   * Values of the dashboard's parameters (the bar above the tiles), such as the customer chosen in the app around it:
   * `{ customer: 1024, regions: ["関東"] }`. Changing them later sets them again. Values are not permissions: the
   * person can change them (rows a person may see are decided on the server, by `:user.*`).
   */
  params?: Record<string, unknown>;
  /** Called with every parameter's value when one changes (and once they are first known). */
  onParamsChange?: (values: Record<string, ParamValue>) => void;
  /** The parameters' values are in the address (`#/<name>?from=2026-04-01`): DevbiApp's. */
  paramsInUrl?: boolean;
}) {
  useInsertionEffect(injectStyles, []);
  // The element printed (ファイル出力 → 印刷・PDF), and narrow layout by its width.
  const rootEl = useRef<HTMLDivElement | null>(null);
  const rootRef = useCallback((el: HTMLDivElement | null) => {
    rootEl.current = el;
    const stop = narrowRef(el);
    return () => {
      rootEl.current = null;
      stop?.();
    };
  }, []);
  const root = { ...themeAttribute(theme), ...(isolate ? { "data-devbi-isolate": "" } : {}) };
  const dashboard = Object.hasOwn(project.dashboards, name) ? project.dashboards[name] : undefined;
  // The values given (the address first, then `params`), checked against the parameters' types.
  const paramsKey = JSON.stringify(params ?? null);
  const checked = useMemo(() => {
    if (!dashboard) return undefined;
    const list = dashboardParams(dashboard, project.datasets).params;
    if (!list.length) return undefined;
    const { values, problems } = checkParamValues(list, (params ?? {}) as Record<string, unknown>);
    for (const p of problems) console.warn(`DevBI: ${p}`);
    return { list, values };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard, project, paramsKey]);
  const [fromUrl] = useState(() => {
    if (!paramsInUrl || !checked || typeof location === "undefined") return {};
    const problems: string[] = [];
    const values = paramsFromSearch(checked.list, location.hash.split("?")[1] ?? "", problems);
    for (const p of problems) console.warn(`DevBI: ${p}`);
    return values;
  });
  const [given] = useState(() => ({ ...fromUrl, ...checked?.values }));
  const givenLater = checked?.values;
  // The values a store made again starts with (the dev server's project after a file is saved): the latest ones.
  const seed = useRef(given);
  if (!dashboard) {
    const names = Object.keys(project.dashboards).sort();
    return (
      <div className="devbi-root devbi-error" {...root}>
        ダッシュボード {name} がありません（{names.length ? `あるのは ${names.join(", ")}` : "dashboards/ に *.dash.json がありません"}）
      </div>
    );
  }
  const tiles = [...dashboard.tiles].sort((a, b) => a.y - b.y || a.x - b.x);
  const readsDatasets = datasetTiles(dashboard.tiles).length > 0;
  const kinds = exportKinds(exports);
  return (
    <DevbiProvider key={projectKey(project)} project={project} dashboard={dashboard} params={seedFor(checked?.list, seed.current)}>
      <ParamsSync given={givenLater} onChange={onParamsChange} onValues={(v) => (seed.current = v)} url={paramsInUrl ? name : undefined} />
      <div className="devbi-root" ref={rootRef} {...root}>
        <div className="devbi-dashboard">
          {back && (
            <a className="devbi-back" href={back}>
              ← 一覧へ
            </a>
          )}
          <div className="devbi-head">
            <h1>{dashboard.title}</h1>
            {dashboard.description && <p>{dashboard.description}</p>}
            <SnapshotNote />
            {(kinds.length > 0 || actions || readsDatasets) && (
              <div className="devbi-actions">
                {readsDatasets && <RefreshButton />}
                {kinds.length > 0 && <ExportMenu root={rootEl} kinds={kinds} />}
                {actions}
              </div>
            )}
          </div>
          <ParamBar />
          <ActiveFilters />
          <div
            className="devbi-grid"
            style={{ ["--devbi-columns" as string]: dashboard.columns, ["--devbi-row" as string]: `${dashboard.rowHeight}px` }}
          >
            {tiles.map((t) => (
              <TileFrame key={t.id} tile={t} style={tileStyle(t, dashboard.rowHeight)} />
            ))}
          </div>
        </div>
      </div>
    </DevbiProvider>
  );
}

function useHash(): string {
  const [hash, setHash] = useState(() => (typeof location === "undefined" ? "" : location.hash));
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

/** Which dashboard the GUI editor has open, kept over the reloads the dev server makes (models/ changed). */
const EDITING = "devbi:editing";

function readEditing(): string | null {
  try {
    return sessionStorage.getItem(EDITING);
  } catch {
    return null;
  }
}

function writeEditing(name: string | null) {
  try {
    if (name === null) sessionStorage.removeItem(EDITING);
    else sessionStorage.setItem(EDITING, name);
  } catch {
    // no storage (a private window): the editor closes on reload
  }
}

/** Loads the GUI editor (@devbi/editor) on first use; the dev server only. */
function EditorHost({ dev, theme, children }: { dev: DevServer; theme?: Theme; children: (editor: EditorModule) => ReactNode }) {
  const [state, setState] = useState<{ editor?: EditorModule; error?: Error }>({});
  useEffect(() => {
    let live = true;
    dev.editor?.().then(
      (editor) => live && setState({ editor }),
      (e: unknown) => live && setState({ error: e instanceof Error ? e : new Error(String(e)) }),
    );
    return () => {
      live = false;
    };
  }, [dev]);
  if (state.editor) return <>{children(state.editor)}</>;
  return (
    <div className="devbi-root" {...themeAttribute(theme)}>
      <div className="devbi-dashboard">
        {state.error ? <pre className="devbi-error">GUI エディタを読み込めません: {state.error.message}</pre> : <p className="devbi-hint">エディタを読み込んでいます…</p>}
      </div>
    </div>
  );
}

/**
 * 「表示する利用者」 (the dev server's devUsers): the API answers as the one picked. The page loads again, so no rows
 * of the user before stay in its tables.
 */
function DevUserPicker({ users }: { users: readonly DevUserInfo[] }) {
  const [current] = useState(readDevUser);
  // A pick another tab made since this page read its rows: read them again as that one (one browser, one pick).
  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible" && readDevUser() !== current) location.reload();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [current]);
  // One no longer in devUsers stays listed, so that （ログインなし） can be picked to drop it.
  const gone = current !== "" && !users.some((u) => u.name === current);
  return (
    <label className="devbi-dev-user" title="開発サーバーだけのものです。選んだ人として API が答えます">
      表示する利用者
      <select
        value={current}
        onChange={(e) => {
          writeDevUser(e.target.value);
          location.reload();
        }}
      >
        <option value="">（ログインなし）</option>
        {gone && <option value={current}>{`${current}（devUsers にありません）`}</option>}
        {users.map((u) => (
          <option key={u.name} value={u.name}>
            {u.note ? `${u.name}（${u.note}）` : u.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * A whole static site: a list of dashboards, and each dashboard at `#/<name>`.
 * With one dashboard it is shown directly. On the dev server with `@devbi/editor` installed, each dashboard has
 * an 編集 button (the GUI editor) and new dashboards can be made.
 */
export function DevbiApp({
  project: input,
  theme,
  exports = true,
}: {
  project: ProjectInput;
  theme?: Theme;
  /** The ファイル出力 menu on each dashboard (Excel, 印刷・PDF, CSV). Default `true`; a list offers only those kinds. */
  exports?: boolean | readonly ExportKind[];
}) {
  useInsertionEffect(injectStyles, []);
  const dev = input.dev?.editor ? input.dev : undefined;
  const users = input.dev?.users?.length ? input.dev.users : undefined;
  // The editor's saves, shown without reloading the page (the dev server reloads it for changes made elsewhere).
  const [saved, setSaved] = useState<Record<string, SavedDashboard>>({});
  const merged = useMemo(() => (Object.keys(saved).length ? { ...input, dashboards: { ...input.dashboards, ...saved } } : input), [input, saved]);
  const loaded = useMemo(() => {
    try {
      return { project: loadProject(merged), error: null };
    } catch (e) {
      return { project: null, error: e as Error };
    }
  }, [merged]);
  const hash = useHash();
  // The editor opens again after a reload only on the dashboard it was editing (not if the address changed since).
  const [editing, setEditingState] = useState<string | null>(() => {
    const name = dev ? readEditing() : null;
    const here = typeof location === "undefined" ? "" : decodeURIComponent(location.hash.replace(/^#\/?/, "").split("?")[0]!);
    if (name !== null && here !== name && (here !== "" || Object.keys(input.dashboards).length !== 1)) {
      writeEditing(null);
      return null;
    }
    return name;
  });
  const [creating, setCreating] = useState(false);
  const setEditing = useCallback((name: string | null) => {
    writeEditing(name);
    setEditingState(name);
  }, []);
  const onSaved = useCallback((name: string, file: SavedDashboard) => setSaved((s) => ({ ...s, [name]: file })), []);
  if (loaded.error || !loaded.project) {
    return (
      <div className="devbi-root" {...themeAttribute(theme)}>
        <pre className="devbi-error devbi-dashboard">{loaded.error?.message}</pre>
      </div>
    );
  }
  const project = loaded.project;
  const names = Object.keys(project.dashboards).sort();
  // `#/<name>?from=…`: the dashboard, and its parameters' values (read by the Dashboard).
  const current = decodeURIComponent(hash.replace(/^#\/?/, "").split("?")[0]!);
  const shown = current && Object.hasOwn(project.dashboards, current) ? current : names.length === 1 ? names[0]! : null;

  if (dev && creating) {
    return (
      <EditorHost dev={dev} theme={theme}>
        {(editor) => (
          <editor.NewDashboard
            project={project}
            dev={dev}
            theme={theme}
            onCreated={(name, file) => {
              onSaved(name, file);
              setCreating(false);
              setEditing(name);
              location.hash = `#/${encodeURIComponent(name)}`;
            }}
            onCancel={() => setCreating(false)}
          />
        )}
      </EditorHost>
    );
  }
  // The editor stays on its dashboard when the address changes (the browser's back button): unsaved changes are
  // kept until it is closed.
  if (dev && editing !== null && Object.hasOwn(project.dashboards, editing)) {
    return (
      <EditorHost dev={dev} theme={theme}>
        {(editor) => <editor.DashboardEditor key={editing} project={project} name={editing} dev={dev} theme={theme} onSaved={onSaved} onClose={() => setEditing(null)} />}
      </EditorHost>
    );
  }
  const newButton = dev && (
    <button type="button" className="devbi-button" onClick={() => setCreating(true)}>
      ＋ 新しいダッシュボード
    </button>
  );
  const picker = users && <DevUserPicker users={users} />;
  if (shown !== null) {
    const actions = (dev || picker) && (
      <>
        {picker}
        {dev && (
          <button type="button" className="devbi-button devbi-button-primary" onClick={() => setEditing(shown)}>
            編集
          </button>
        )}
        {newButton}
      </>
    );
    return (
      <Dashboard
        key={shown}
        project={project}
        name={shown}
        theme={theme}
        exports={exports}
        actions={actions || undefined}
        paramsInUrl
        {...(names.length > 1 ? { back: "#/" } : {})}
      />
    );
  }
  return (
    <div className="devbi-root" {...themeAttribute(theme)}>
      <div className="devbi-index">
        <h1>ダッシュボード</h1>
        {(newButton || picker) && (
          <p className="devbi-index-actions">
            {picker}
            {newButton}
          </p>
        )}
        {names.length === 0 ? (
          <p className="devbi-hint">dashboards/ に *.dash.json を置くとここに並びます</p>
        ) : (
          <ul>
            {names.map((n) => {
              const d = project.dashboards[n]!;
              const times = snapshotTimesOf(project, d);
              return (
                <li key={n}>
                  <a href={`#/${encodeURIComponent(n)}`}>
                    {d.title}
                    {d.description && <small>{d.description}</small>}
                    {times.length > 0 && <small className="devbi-snapshot">毎日 {formatTimesOfDay(times)} の時点のデータ</small>}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
