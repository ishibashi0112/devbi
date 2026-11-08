import { DevbiProvider, TileFrame, injectStyles, themeAttribute, type DashboardEditorProps } from "@devbi/react";
import { TILE_TYPES, TILE_TYPE_NAMES, defineDashboard, formatDashboardJson, type BuiltinTileType, type Dashboard, type MetricsView, type TileSpec } from "devbi";
import { useCallback, useEffect, useInsertionEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ReactGridLayout, useContainerWidth, verticalCompactor, type Layout } from "react-grid-layout";
import { EditorError, readDashboard, writeDashboard, type DashboardFile } from "./api.js";
import { boxesOf, newTile, placeTiles, type Box, type RawDashboard } from "./layout.js";
import { injectEditorStyles } from "./styles.js";

/** Narrower than this, the 12 columns are too thin to drag (the dashboard shows in one column there anyway). */
const MIN_WIDTH = 720;
const GAP = 12;
const HISTORY = 100;
const TILE_STYLE: CSSProperties = { height: "100%" };

type Notice = { kind: "info" | "warn" | "error"; text: string; conflict?: boolean };

/** Up or left until something is in the way: the grid's own rule, applied when the file is opened too. */
function compact(spec: RawDashboard): RawDashboard {
  const boxes = verticalCompactor.compact(boxesOf(spec) as Layout, spec.columns ?? 12) as readonly Box[];
  return placeTiles(spec, boxes);
}

const same = (a: RawDashboard, b: RawDashboard) => a === b || formatDashboardJson(a) === formatDashboardJson(b);

/** The dashboard's metrics view, for a new tile's first measure and dimension. */
function viewFor(project: DashboardEditorProps["project"], spec: RawDashboard): { view?: MetricsView; needsMetrics: boolean } {
  const names = Object.keys(project.metrics).sort();
  const own = spec.metrics ?? (names.length === 1 ? names[0] : undefined);
  if (own) return { view: project.metrics[own], needsMetrics: false };
  return { view: names[0] ? project.metrics[names[0]] : undefined, needsMetrics: true };
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
}

/**
 * The GUI editor for one dashboard: drag tiles to move them, drag an edge or corner to resize, add and remove
 * tiles, and save to `dashboards/<name>.dash.json` (in the hand-written style, so the git diff is small). The tiles
 * show their data while you edit.
 */
export function DashboardEditor({ project: given, name, dev, theme, onSaved, onClose }: DashboardEditorProps) {
  useInsertionEffect(injectStyles, []);
  useInsertionEffect(injectEditorStyles, []);
  // The project as the editor opened with it: the page's copy changes with each save, and a new one would start
  // every tile's query again. Its metrics and promoted tiles do not change while the editor is open (a change to
  // those reloads the page, or waits for the editor to close).
  const [project] = useState(given);
  /** The file as last read or saved. */
  const [file, setFile] = useState<DashboardFile | null>(null);
  /** What is being edited. */
  const [spec, setSpec] = useState<RawDashboard | null>(null);
  const [past, setPast] = useState<RawDashboard[]>([]);
  const [future, setFuture] = useState<RawDashboard[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const dirty = !!file && !!spec && !same(file.spec, spec);
  /** Files changed on disk that the page has not taken in: it reloads when the editor closes. */
  const stale = useRef(false);
  const loaded = useRef(false);

  const open = useCallback(
    async (message?: Notice) => {
      try {
        const read = await readDashboard(dev, name);
        const tiles = Array.isArray(read.spec?.tiles) ? read.spec : { ...read.spec, tiles: [] };
        const compacted = compact(tiles);
        setFile(read);
        setSpec(compacted);
        setPast([]);
        setFuture([]);
        setLoadError(null);
        loaded.current = true;
        setNotice(
          compacted !== tiles
            ? { kind: "info", text: "空いている行があったので、タイルを上に詰めました（保存するまでファイルは変わりません）" }
            : (message ?? null),
        );
      } catch (e) {
        // Once open, what is on screen stays, with the reason it could not be read again.
        if (loaded.current) setNotice({ kind: "error", text: (e as Error).message });
        else setLoadError((e as Error).message);
      }
    },
    [dev, name],
  );
  useEffect(() => {
    void open();
  }, [open]);

  const change = useCallback(
    (next: RawDashboard) => {
      if (!spec || next === spec) return;
      setPast((p) => [...p.slice(-(HISTORY - 1)), spec]);
      setFuture([]);
      setSpec(next);
    },
    [spec],
  );
  const undo = useCallback(() => {
    if (!spec || !past.length) return;
    setFuture((f) => [spec, ...f]);
    setSpec(past[past.length - 1]!);
    setPast((p) => p.slice(0, -1));
  }, [spec, past]);
  const redo = useCallback(() => {
    if (!spec || !future.length) return;
    setPast((p) => [...p, spec]);
    setSpec(future[0]!);
    setFuture((f) => f.slice(1));
  }, [spec, future]);

  const save = useCallback(
    async (overwrite = false): Promise<boolean> => {
      // Nothing changed: no write (it would rewrite a hand-written file in the editor's style).
      if (!spec || !file || saving || (!overwrite && !dirty)) return false;
      setSaving(true);
      try {
        // Overwrite: write over whatever is on disk now (after a conflict the user chose to keep their version),
        // even a file that is no longer JSON (its version comes with the 422) or that is gone (null: create).
        const version = overwrite
          ? await readDashboard(dev, name).then(
              (f) => f.version,
              (e: unknown) => {
                if (e instanceof EditorError && e.status === 404) return null;
                if (e instanceof EditorError && e.status === 422 && typeof e.version === "string") return e.version;
                throw e;
              },
            )
          : file.version;
        const written = await writeDashboard(dev, name, spec, version);
        setFile(written);
        onSaved(name, { path: written.path, spec });
        setNotice({ kind: "info", text: `保存しました（${written.path.slice(1)}）` });
        return true;
      } catch (e) {
        const conflict = e instanceof EditorError && e.status === 409;
        setNotice({ kind: conflict ? "warn" : "error", text: (e as Error).message, conflict });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [spec, file, saving, dirty, dev, name, onSaved],
  );

  // Files changed elsewhere (VS Code, git): take this dashboard's new content when nothing is unsaved; with unsaved
  // changes, say so instead of losing them. Other files reload the page (the editor opens again) unless unsaved.
  const state = useRef({ dirty, open });
  state.current = { dirty, open };
  useEffect(
    () =>
      dev.onChange((change) => {
        const mine = change.file === `dashboards/${name}.dash.json`;
        if (!state.current.dirty && !mine) return false;
        stale.current = true;
        if (!state.current.dirty) {
          void state.current.open({ kind: "info", text: "ファイルが書き換えられたので読み込み直しました" });
          return true;
        }
        setNotice(
          mine
            ? { kind: "warn", text: `${change.file} が、ほかで書き換えられました`, conflict: true }
            : { kind: "warn", text: `${change.file} が変わりました。保存して閉じると反映されます` },
        );
        return true;
      }),
    [dev, name],
  );

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  const remove = useCallback(
    (id: string) => {
      if (!spec) return;
      // Compacted here, so the grid's own compaction changes nothing more: one step to undo.
      change(compact({ ...spec, tiles: spec.tiles.filter((t) => t.id !== id) }));
      setSelected((s) => (s === id ? null : s));
    },
    [spec, change],
  );

  const added = useRef<string | null>(null);
  const add = (type: BuiltinTileType) => {
    if (!spec) return;
    const { view, needsMetrics } = viewFor(project, spec);
    const tile = newTile(type, spec, view, needsMetrics);
    change(compact({ ...spec, tiles: [...spec.tiles, tile] }));
    setSelected(tile.id);
    added.current = tile.id;
  };
  useEffect(() => {
    if (!added.current) return;
    document.querySelector(`[data-editor-tile="${CSS.escape(added.current)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    added.current = null;
  });

  /** Leave the editor; the page reloads if files changed on disk while it was open. */
  const finish = () => {
    onClose();
    if (stale.current) location.reload();
  };
  const close = () => (dirty ? setClosing(true) : finish());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      } else if (isTyping(e.target)) {
        return;
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        remove(selected);
      } else if (e.key === "Escape") {
        setSelected(null);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [save, undo, redo, remove, selected]);

  const root = { ...themeAttribute(theme) };
  if (!spec || !file) {
    return (
      <div className="devbi-root" {...root}>
        <div className="devbi-dashboard">
          {loadError ? (
            <div className="devbi-ed-notice" data-kind="error">
              <span>{loadError}</span>
              <button type="button" className="devbi-button" onClick={onClose}>
                閉じる
              </button>
            </div>
          ) : (
            <p className="devbi-hint">dashboards/{name}.dash.json を読んでいます…</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="devbi-root devbi-editing" {...root}>
      <div className="devbi-dashboard">
        <div className="devbi-ed-bar" role="toolbar" aria-label="ダッシュボードの編集">
          <h1>{typeof spec.title === "string" && spec.title ? spec.title : name}</h1>
          <span className="devbi-ed-file">{file.path.slice(1)}</span>
          {dirty && <span className="devbi-ed-dirty">未保存の変更があります</span>}
          <div className="devbi-ed-tools">
            <select
              className="devbi-ed-add"
              aria-label="タイルを追加"
              value=""
              onChange={(e) => {
                if (e.target.value) add(e.target.value as BuiltinTileType);
              }}
            >
              <option value="">＋ タイルを追加</option>
              {TILE_TYPE_NAMES.map((t) => (
                <option key={t} value={t}>
                  {TILE_TYPES[t].label}
                </option>
              ))}
            </select>
            <button type="button" className="devbi-button" onClick={undo} disabled={!past.length} title="元に戻す（⌘Z / Ctrl+Z）">
              元に戻す
            </button>
            <button type="button" className="devbi-button" onClick={redo} disabled={!future.length} title="やり直す（⇧⌘Z / Ctrl+Y）">
              やり直す
            </button>
            <button type="button" className="devbi-button devbi-button-primary" onClick={() => void save()} disabled={!dirty || saving} title="保存（⌘S / Ctrl+S）">
              {saving ? "保存しています…" : "保存"}
            </button>
            <button type="button" className="devbi-button" onClick={close}>
              閉じる
            </button>
          </div>
        </div>
        {closing && (
          <div className="devbi-ed-notice" data-kind="warn" role="alert">
            <span>保存していない変更があります。</span>
            <button type="button" className="devbi-button devbi-button-primary" onClick={() => void save().then((ok) => ok && finish())}>
              保存して閉じる
            </button>
            <button type="button" className="devbi-button" onClick={finish}>
              保存せずに閉じる
            </button>
            <button type="button" className="devbi-button" onClick={() => setClosing(false)}>
              編集を続ける
            </button>
          </div>
        )}
        {notice && (
          <div className="devbi-ed-notice" data-kind={notice.kind} role={notice.kind === "info" ? "status" : "alert"}>
            <span>{notice.text}</span>
            {notice.conflict && (
              <>
                <button type="button" className="devbi-button" onClick={() => void open({ kind: "info", text: "ファイルから読み込み直しました" })}>
                  ファイルの内容を読み込む（ここでの変更は捨てる）
                </button>
                <button type="button" className="devbi-button" onClick={() => void save(true)}>
                  ここでの内容で上書きする
                </button>
              </>
            )}
            <button type="button" className="devbi-button" aria-label="お知らせを消す" onClick={() => setNotice(null)}>
              ×
            </button>
          </div>
        )}
        <Canvas project={project} name={name} path={file.path} spec={spec} selected={selected} onSelect={setSelected} onChange={change} onRemove={remove} />
      </div>
    </div>
  );
}

/** The dashboard as a grid of draggable, resizable tiles that show their data. */
function Canvas({
  project,
  name,
  path,
  spec,
  selected,
  onSelect,
  onChange,
  onRemove,
}: {
  project: DashboardEditorProps["project"];
  name: string;
  path: string;
  spec: RawDashboard;
  selected: string | null;
  onSelect(id: string | null): void;
  onChange(next: RawDashboard): void;
  onRemove(id: string): void;
}) {
  const { width, containerRef, mounted } = useContainerWidth();
  const checked = useMemo((): { dashboard: Dashboard & { path: string } } | { error: Error } => {
    try {
      return { dashboard: { ...defineDashboard(spec, name, path.slice(1)), path } };
    } catch (e) {
      return { error: e as Error };
    }
  }, [spec, name, path]);
  // The tiles' data stays while they move: a new context (and new queries) only when what they show changes.
  const content = JSON.stringify({ ...spec, tiles: spec.tiles.map(({ x: _x, y: _y, w: _w, h: _h, ...rest }) => rest) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shown = useMemo(() => ("dashboard" in checked ? checked.dashboard : null), [content]);
  const boxes = useMemo(() => boxesOf(spec), [spec]);
  const onLayoutChange = useCallback((layout: Layout) => onChange(placeTiles(spec, layout as readonly Box[])), [spec, onChange]);
  const tiles: TileSpec[] = "dashboard" in checked ? checked.dashboard.tiles : [];
  const columns = spec.columns ?? 12;
  const rowHeight = spec.rowHeight ?? 80;
  return (
    <div className="devbi-ed-grid" ref={containerRef}>
      {"error" in checked && (
        <div className="devbi-ed-notice" data-kind="error">
          <span>{checked.error.message}</span>
        </div>
      )}
      {spec.tiles.length === 0 && <div className="devbi-ed-empty">「＋ タイルを追加」から、数字やグラフを置いていきます</div>}
      {mounted && width > 0 && width < MIN_WIDTH && <p className="devbi-hint">タイルを動かすには、幅 {MIN_WIDTH}px 以上の画面で開いてください</p>}
      {mounted && width >= MIN_WIDTH && shown && (
        <DevbiProvider project={project} dashboard={shown}>
          <ReactGridLayout
            width={width}
            layout={boxes}
            gridConfig={{ cols: columns, rowHeight, margin: [GAP, GAP], containerPadding: [0, 0] }}
            dragConfig={{ enabled: true, cancel: ".devbi-ed-nodrag", threshold: 3 }}
            resizeConfig={{ enabled: true, handles: ["se", "e", "s"] }}
            compactor={verticalCompactor}
            onLayoutChange={onLayoutChange}
          >
            {tiles.map((t) => (
              <div
                key={t.id}
                data-editor-tile={t.id}
                className={`devbi-ed-item${selected === t.id ? " devbi-ed-selected" : ""}`}
                onPointerDown={() => onSelect(t.id)}
              >
                <TileFrame tile={t} style={TILE_STYLE} />
                <div className="devbi-ed-cover" aria-hidden="true" />
                <span className="devbi-ed-label">
                  {t.id} · {t.type ? (Object.hasOwn(TILE_TYPES, t.type) ? TILE_TYPES[t.type as BuiltinTileType].label : t.type) : t.component}
                </span>
                <button
                  type="button"
                  className="devbi-ed-remove devbi-ed-nodrag"
                  aria-label={`${t.title ?? t.id}を消す`}
                  title="このタイルを消す（Delete）"
                  onClick={() => onRemove(t.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </ReactGridLayout>
        </DevbiProvider>
      )}
    </div>
  );
}
