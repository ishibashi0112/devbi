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

/** Render one dashboard of a project. */
export function Dashboard({ project, name, back }: { project: Project; name: string; back?: string }) {
  useInsertionEffect(injectStyles, []);
  const dashboard = Object.hasOwn(project.dashboards, name) ? project.dashboards[name] : undefined;
  if (!dashboard) return <div className="devbi-root devbi-error">ダッシュボード {name} がありません</div>;
  const tiles = [...dashboard.tiles].sort((a, b) => a.y - b.y || a.x - b.x);
  return (
    <DevbiProvider project={project} dashboard={dashboard}>
      <div className="devbi-root">
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
export function DevbiApp({ project: input }: { project: ProjectInput }) {
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
      <div className="devbi-root">
        <pre className="devbi-error devbi-dashboard">{loaded.error?.message}</pre>
      </div>
    );
  }
  const project = loaded.project;
  const names = Object.keys(project.dashboards).sort();
  const current = decodeURIComponent(hash.replace(/^#\/?/, ""));
  if (current && Object.hasOwn(project.dashboards, current)) {
    return <Dashboard key={current} project={project} name={current} {...(names.length > 1 ? { back: "#/" } : {})} />;
  }
  if (names.length === 1) return <Dashboard project={project} name={names[0]!} />;
  return (
    <div className="devbi-root">
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
