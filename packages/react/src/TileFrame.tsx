import { checkQuery, type Filter, type Query, type TileProps, type TileSpec } from "devbi";
import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { makeFormatters, useDevbi, useDevbiQuery, useSelectionVersion } from "./context.js";
import { resolveComponent, type TileModule } from "./project.js";
import { builtinTiles } from "./tiles/index.js";
import { TileSizeContext } from "./tiles/util.js";

class ErrorBoundary extends Component<{ children: ReactNode; resetKey: unknown }, { error: Error | null; key: unknown }> {
  override state: { error: Error | null; key: unknown } = { error: null, key: undefined };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(props: { resetKey: unknown }, state: { error: Error | null; key: unknown }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }
  override render() {
    return this.state.error ? <div className="devbi-error">{this.state.error.message}</div> : this.props.children;
  }
}

function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: Math.floor(el.clientWidth), height: Math.floor(el.clientHeight) });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function useTileModule(tile: TileSpec, dashboardPath: string) {
  const { project } = useDevbi();
  const [state, setState] = useState<{ mod: TileModule | null; error: Error | null }>({ mod: null, error: null });
  useEffect(() => {
    if (!tile.component) return;
    const path = resolveComponent(dashboardPath, tile.component);
    const load = project.components[path];
    if (!load) {
      setState({ mod: null, error: new Error(`タイルのファイル ${path} がありません`) });
      return;
    }
    let live = true;
    load().then(
      (mod) => live && setState({ mod, error: null }),
      (e: unknown) => live && setState({ mod: null, error: e instanceof Error ? e : new Error(String(e)) }),
    );
    return () => {
      live = false;
    };
  }, [tile.component, dashboardPath, project]);
  return state;
}

/** One grid cell: title, loading state, errors, and the tile component with {@link TileProps}. */
export function TileFrame({ tile, style }: { tile: TileSpec; style: CSSProperties }) {
  const ctx = useDevbi();
  const builtin = tile.type ? builtinTiles[tile.type] : undefined;
  const mod = useTileModule(tile, ctx.dashboard.path);
  const query: Query | null = useMemo(() => {
    if (builtin?.noQuery) return null;
    if (tile.query) return tile.query;
    if (mod.mod?.query) return checkQuery(mod.mod.query, tile.component ?? tile.id) as Query;
    return null;
  }, [builtin, tile, mod.mod]);
  const data = useDevbiQuery(query, { tileId: tile.id });
  useSelectionVersion();
  const selection = ctx.selection.own(tile.id);
  const select = useCallback(
    (f: Filter | Filter[] | null) => ctx.selection.set(tile.id, f === null ? null : Array.isArray(f) ? f : [f]),
    [ctx.selection, tile.id],
  );
  const view = useMemo(() => {
    try {
      return ctx.view(query?.metrics ?? (tile.options?.metrics as string | undefined));
    } catch {
      return undefined;
    }
  }, [ctx, query?.metrics, tile.options?.metrics]);
  const { format, label } = useMemo(() => makeFormatters(view, data.fields), [view, data.fields]);
  const [ref, size] = useSize();

  const unknownType = tile.type && !builtin;
  const Body = builtin?.component ?? mod.mod?.default;
  const error =
    (unknownType ? new Error(`タイルの種類 ${tile.type} はありません（使えるのは ${Object.keys(builtinTiles).join(", ")}）`) : null) ??
    mod.error ??
    data.error;
  const props: TileProps = {
    rows: data.rows,
    fields: data.fields,
    query: query ?? {},
    selection,
    filters: data.filters,
    select,
    format,
    label,
    loading: data.loading,
    error: data.error,
    tile,
  };
  return (
    <section
      className={`devbi-tile devbi-tile-${tile.type ?? "component"}${data.loading ? " devbi-loading" : ""}`}
      style={style}
      data-tile={tile.id}
      aria-busy={data.loading}
    >
      {tile.title && (
        <header className="devbi-tile-title">
          <h2>{tile.title}</h2>
          {selection.length > 0 && (
            <button type="button" className="devbi-clear" onClick={() => select(null)} aria-label={`${tile.title}の選択を解除`}>
              解除
            </button>
          )}
        </header>
      )}
      <div className="devbi-tile-body" ref={ref}>
        <TileSizeContext.Provider value={size}>
          {error ? (
            <div className="devbi-error">{error.message}</div>
          ) : Body ? (
            <ErrorBoundary resetKey={data.rows}>
              <Body {...props} />
            </ErrorBoundary>
          ) : null}
        </TileSizeContext.Provider>
      </div>
    </section>
  );
}
