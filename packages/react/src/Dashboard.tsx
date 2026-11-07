import { formatTime, type Filter, type TileSpec } from "devbi";
import { useEffect, useInsertionEffect, useMemo, useState, type CSSProperties } from "react";
import { DevbiProvider, fieldInfo, useDevbi, useSelectionVersion } from "./context.js";
import { loadProject, type Project, type ProjectInput } from "./project.js";
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
}: {
  project: Project;
  name: string;
  back?: string;
  theme?: Theme;
  isolate?: boolean;
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

/**
 * A whole static site: a list of dashboards, and each dashboard at `#/<name>`.
 * With one dashboard it is shown directly.
 */
export function DevbiApp({ project: input, theme }: { project: ProjectInput; theme?: Theme }) {
  useInsertionEffect(injectStyles, []);
  const loaded = useMemo(() => {
    try {
      return { project: loadProject(input), error: null };
    } catch (e) {
      return { project: null, error: e as Error };
    }
  }, [input]);
  const hash = useHash();
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
  if (current && Object.hasOwn(project.dashboards, current)) {
    return <Dashboard key={current} project={project} name={current} theme={theme} {...(names.length > 1 ? { back: "#/" } : {})} />;
  }
  if (names.length === 1) return <Dashboard project={project} name={names[0]!} theme={theme} />;
  return (
    <div className="devbi-root" {...themeAttribute(theme)}>
      <div className="devbi-index">
        <h1>ダッシュボード</h1>
        {names.length === 0 ? (
          <p className="devbi-hint">dashboards/ に *.dash.json を置くとここに並びます</p>
        ) : (
          <ul>
            {names.map((n) => (
              <li key={n}>
                <a href={`#/${encodeURIComponent(n)}`}>
                  {project.dashboards[n]!.title}
                  {project.dashboards[n]!.description && <small>{project.dashboards[n]!.description}</small>}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
