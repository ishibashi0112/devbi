import { formatTime, type Filter, type TileSpec } from "devbi";
import { useCallback, useEffect, useInsertionEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { DevbiProvider, fieldInfo, useDevbi, useSelectionVersion } from "./context.js";
import type { DevServer, EditorModule, SavedDashboard } from "./dev.js";
import type { SnapshotInfo } from "./engine.js";
import { formatTimesOfDay, loadProject, snapshotTimesOf, viewsOf, type Project, type ProjectInput } from "./project.js";
import { injectStyles } from "./styles.js";
import { TileFrame } from "./TileFrame.js";

const DAY = 86_400_000;

function describe(f: Filter, format: (v: unknown) => string, isTime: boolean): string {
  if ("in" in f) return f.in.map((v) => format(v)).join("、");
  const [lo, hi] = f.between;
  if (isTime && lo instanceof Date && hi instanceof Date) {
    const last = new Date(hi.getTime() - DAY);
    const monthly = lo.getUTCDate() === 1 && hi.getUTCDate() === 1;
    if (monthly) {
      const months = (hi.getUTCFullYear() - lo.getUTCFullYear()) * 12 + hi.getUTCMonth() - lo.getUTCMonth();
      if (months === 1) return formatTime(lo, "month");
      return `${formatTime(lo, "month")}〜${formatTime(last, "month")}`;
    }
    return `${formatTime(lo, "day")}〜${formatTime(last, "day")}`;
  }
  return `${lo === null ? "" : format(lo)}〜${hi === null ? "" : format(hi)}`;
}

function ActiveFilters() {
  const ctx = useDevbi();
  useSelectionVersion();
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
              const text = describe(f, (v) => (v === null ? "（空欄）" : v instanceof Date ? formatTime(v, "day") : String(v)), isTime);
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

/** `11月8日 6:00` */
function formatMadeAt(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** When the data was taken, for a dashboard that reads snapshots: the oldest of them. Nothing for live data. */
function SnapshotNote() {
  const ctx = useDevbi();
  const [info, setInfo] = useState<SnapshotInfo[]>([]);
  useEffect(() => {
    let alive = true;
    void ctx.engine
      .then((engine) => Promise.all(viewsOf(ctx.project, ctx.dashboard).map((v) => engine.snapshotsOf(v))))
      .then(
        (all) => alive && setInfo(all.flat()),
        () => undefined, // the tiles show the error
      );
    return () => {
      alive = false;
    };
  }, [ctx]);
  if (info.length === 0) return null;
  const oldest = info.reduce((a, b) => (a.at <= b.at ? a : b));
  const times = [...new Set(info.flatMap((i) => i.times))].sort();
  return (
    <p className="devbi-snapshot" data-testid="snapshot-note">
      データは {formatMadeAt(oldest.at)} の時点（毎日 {formatTimesOfDay(times)} に更新）
    </p>
  );
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
  actions,
}: {
  project: Project;
  name: string;
  back?: string;
  theme?: Theme;
  isolate?: boolean;
  /** Buttons at the end of the heading (DevbiApp's 編集 on the dev server). */
  actions?: ReactNode;
}) {
  useInsertionEffect(injectStyles, []);
  const root = { ...themeAttribute(theme), ...(isolate ? { "data-devbi-isolate": "" } : {}) };
  const dashboard = Object.hasOwn(project.dashboards, name) ? project.dashboards[name] : undefined;
  if (!dashboard) {
    const names = Object.keys(project.dashboards).sort();
    return (
      <div className="devbi-root devbi-error" {...root}>
        ダッシュボード {name} がありません（{names.length ? `あるのは ${names.join(", ")}` : "dashboards/ に *.dash.json がありません"}）
      </div>
    );
  }
  const tiles = [...dashboard.tiles].sort((a, b) => a.y - b.y || a.x - b.x);
  return (
    <DevbiProvider key={projectKey(project)} project={project} dashboard={dashboard}>
      <div className="devbi-root" ref={narrowRef} {...root}>
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
            {actions && <div className="devbi-actions">{actions}</div>}
          </div>
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
 * A whole static site: a list of dashboards, and each dashboard at `#/<name>`.
 * With one dashboard it is shown directly. On the dev server with `@devbi/editor` installed, each dashboard has
 * an 編集 button (the GUI editor) and new dashboards can be made.
 */
export function DevbiApp({ project: input, theme }: { project: ProjectInput; theme?: Theme }) {
  useInsertionEffect(injectStyles, []);
  const dev = input.dev?.editor ? input.dev : undefined;
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
  const [editing, setEditingState] = useState<string | null>(() => (dev ? readEditing() : null));
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
  const current = decodeURIComponent(hash.replace(/^#\/?/, ""));
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
  if (dev && shown !== null && editing === shown) {
    return (
      <EditorHost dev={dev} theme={theme}>
        {(editor) => <editor.DashboardEditor key={shown} project={project} name={shown} dev={dev} theme={theme} onSaved={onSaved} onClose={() => setEditing(null)} />}
      </EditorHost>
    );
  }
  const newButton = dev && (
    <button type="button" className="devbi-button" onClick={() => setCreating(true)}>
      ＋ 新しいダッシュボード
    </button>
  );
  if (shown !== null) {
    const actions = dev && (
      <>
        <button type="button" className="devbi-button devbi-button-primary" onClick={() => setEditing(shown)}>
          編集
        </button>
        {newButton}
      </>
    );
    return (
      <Dashboard key={shown} project={project} name={shown} theme={theme} actions={actions || undefined} {...(names.length > 1 ? { back: "#/" } : {})} />
    );
  }
  return (
    <div className="devbi-root" {...themeAttribute(theme)}>
      <div className="devbi-index">
        <h1>ダッシュボード</h1>
        {newButton && <p>{newButton}</p>}
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
