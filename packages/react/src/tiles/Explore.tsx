import perspective, { type Client, type Table as PerspectiveTable } from "@finos/perspective";
import perspectiveViewer, { type HTMLPerspectiveViewerElement } from "@finos/perspective-viewer";
import "@finos/perspective-viewer-datagrid";
import "@finos/perspective-viewer-d3fc";
import "@finos/perspective-viewer/dist/css/pro.css";
import "@finos/perspective-viewer/dist/css/pro-dark.css";
import "@finos/perspective-viewer/dist/css/intl/ja.css";
import * as arrow from "apache-arrow";
import type { Query, TileProps } from "devbi";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDevbi, useDevbiRows } from "../context.js";
import type { PerspectiveBundle } from "../project.js";

// Perspective (its engine in a Web Worker, and the viewer) comes with the first explore tile, as its own chunk.
// Its WebAssembly is fetched once, from the URLs the Vite plugin gives.
let client: Promise<Client> | undefined;
function perspectiveClient(bundle: PerspectiveBundle): Promise<Client> {
  client ??= (async () => {
    await Promise.all([perspective.init_server(fetch(bundle.server)), perspectiveViewer.init_client(fetch(bundle.client))]);
    return perspective.worker();
  })();
  client.catch(() => (client = undefined));
  return client;
}

/**
 * Arrow IPC for Perspective, and its number columns. Perspective reads a decimal (a DECIMAL column, DuckDB's HUGEINT)
 * as an integer without its scale: a decimal goes as a double, and so does a 64-bit integer (DuckDB's BIGINT), which it
 * would read as a 32-bit one and could overflow when summed.
 */
function toPerspective(table: arrow.Table): { ipc: Uint8Array; numbers: string[] } {
  const wide = (t: arrow.DataType) => arrow.DataType.isDecimal(t) || (arrow.DataType.isInt(t) && (t as arrow.Int).bitWidth === 64);
  const numbers = table.schema.fields.filter((f) => arrow.DataType.isFloat(f.type) || wide(f.type)).map((f) => f.name);
  if (!table.schema.fields.some((f) => wide(f.type))) return { ipc: arrow.tableToIPC(table, "stream"), numbers };
  const columns: Record<string, arrow.Vector> = {};
  table.schema.fields.forEach((f, i) => {
    const vec = table.getChildAt(i)!;
    if (!wide(f.type)) {
      columns[f.name] = vec;
      return;
    }
    const scale = arrow.DataType.isDecimal(f.type) ? (f.type as arrow.Decimal).scale : undefined;
    const values = Array.from({ length: vec.length }, (_, r) => {
      const v = vec.get(r);
      if (v === null || v === undefined) return null;
      return scale === undefined ? Number(v) : arrow.util.bigNumToNumber(v as never, scale);
    });
    columns[f.name] = arrow.vectorFromArray(values, new arrow.Float64());
  });
  return { ipc: arrow.tableToIPC(new arrow.Table(columns), "stream"), numbers };
}

/** Numbers as Excel shows them: whole ones without ".00" (Perspective's default for a double), at most 2 decimals. */
function numberFormats(numbers: string[]): Record<string, unknown> {
  return Object.fromEntries(numbers.map((n) => [n, { number_format: { minimumFractionDigits: 0, maximumFractionDigits: 2 } }]));
}

/** Perspective's theme for the dashboard's light / dark (`data-theme` on `.devbi-root`, else the OS setting). */
function useTheme(ref: React.RefObject<HTMLElement | null>): "Pro Light" | "Pro Dark" {
  const [dark, setDark] = useState(false);
  useLayoutEffect(() => {
    const root = ref.current?.closest(".devbi-root");
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const read = () => {
      const t = root?.getAttribute("data-theme");
      setDark(t === "dark" || (t !== "light" && media.matches));
    };
    read();
    const observer = new MutationObserver(read);
    if (root) observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    media.addEventListener("change", read);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", read);
    };
  }, [ref]);
  return dark ? "Pro Dark" : "Pro Light";
}

/**
 * The `explore` tile: the rows of the metrics view's model, as they are, in Perspective. The viewer groups, splits,
 * aggregates and charts them as they like; `options.layout` is where it starts. The period and the selections of
 * other tiles filter the rows; the viewer's own filters do not filter other tiles.
 */
export function Explore({ tile }: TileProps) {
  const ctx = useDevbi();
  const query = (tile.query ?? {}) as Query;
  const data = useDevbiRows(query, { tileId: tile.id });
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<HTMLPerspectiveViewerElement | null>(null);
  const loaded = useRef<PerspectiveTable | null>(null);
  const theme = useTheme(host);
  const [error, setError] = useState<Error | null>(null);
  const [drawing, setDrawing] = useState(true);
  const bundle = ctx.project.perspective;
  const layout = tile.options?.layout;
  const layoutKey = JSON.stringify(layout ?? null);

  // One viewer element for the tile's life (React does not render inside it).
  useLayoutEffect(() => {
    const el = document.createElement("perspective-viewer") as HTMLPerspectiveViewerElement;
    const box = host.current!;
    box.append(el);
    viewer.current = el;
    (box as unknown as Record<symbol, unknown>)[PRINT] = () => printTable(el, box.clientHeight);
    return () => {
      viewer.current = null;
      // Before Perspective has loaded, the element is not one of its viewers yet (no delete).
      if (typeof el.delete === "function") void el.delete().catch(() => {});
      el.remove();
      void loaded.current?.delete().catch(() => {});
      loaded.current = null;
    };
  }, []);

  // New rows (another period, a selection): a new table, keeping how the viewer has arranged it.
  const first = useRef(true);
  useEffect(() => {
    const el = viewer.current;
    if (!el || !data.table || !bundle) return;
    let live = true;
    setDrawing(true);
    (async () => {
      const worker = await perspectiveClient(bundle);
      const { ipc, numbers } = toPerspective(data.table!);
      const table = await worker.table(ipc.buffer as ArrayBuffer);
      if (!live) {
        await table.delete();
        return;
      }
      // First the layout from dash.json (with the settings open, so it is plain that the rows can be rearranged).
      const own = isObject(layout) ? layout : {};
      const config = first.current
        ? {
            settings: true,
            ...own,
            columns_config: { ...numberFormats(numbers), ...(isObject(own.columns_config) ? own.columns_config : {}) },
            theme,
          }
        : await el.save();
      await el.load(table);
      await el.restore(config as never);
      first.current = false;
      const old = loaded.current;
      loaded.current = table;
      await old?.delete().catch(() => {});
    })().then(
      () => {
        if (live) {
          setError(null);
          setDrawing(false);
        }
      },
      (e: unknown) => {
        if (live) {
          setError(e instanceof Error ? e : new Error(String(e)));
          setDrawing(false);
        }
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.table, bundle]);

  // The layout changed in dash.json (the GUI editor): start again from it.
  useEffect(() => {
    if (first.current || !viewer.current) return;
    void viewer.current.restore({ ...(isObject(layout) ? layout : {}), theme } as never).catch((e: unknown) => setError(e as Error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  useEffect(() => {
    if (!first.current) void viewer.current?.restore({ theme } as never).catch(() => {});
  }, [theme]);

  const problem = !bundle
    ? "Perspective の WebAssembly の場所がありません（@devbi/vite のプラグインで開いてください）"
    : (data.error ?? error)?.message;
  const busy = !problem && (data.loading || drawing);
  return (
    <div className="devbi-explore" aria-busy={busy}>
      {problem && <div className="devbi-error">{problem}</div>}
      {data.truncated && (
        <p className="devbi-explore-note">
          新しいほうから {data.limit.toLocaleString("ja-JP")} 行だけを集計しています。期間で絞るか、query の limit を大きくしてください
        </p>
      )}
      <div className="devbi-explore-viewer" ref={host} hidden={!!problem} data-devbi-snapshot="" />
    </div>
  );
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** What the 印刷・PDF button calls on a part it cannot copy (Perspective draws in its own shadow DOM): what to print. */
const PRINT = Symbol.for("devbi.print");

/**
 * The viewer's current view as a plain table, for printing: its rows and columns as arranged (a chart as its table),
 * as many rows as fit in `height`.
 */
async function printTable(el: HTMLPerspectiveViewerElement, height: number): Promise<HTMLElement> {
  const view = await el.getView();
  const table = await el.getTable();
  const config = (await el.save()) as { group_by?: string[]; plugin?: string };
  const fit = Math.max(3, Math.floor(height / 24) - 3);
  // The columns' types as aggregated (a distinct count of text is a number); the grouped columns' as in the table.
  const [rows, count, types, source] = await Promise.all([
    view.to_json({ start_row: 0, end_row: fit }) as Promise<Record<string, unknown>[]>,
    view.num_rows() as Promise<number>,
    view.schema() as Promise<Record<string, string>>,
    table.schema() as Promise<Record<string, string>>,
  ]);
  const text = (v: unknown, type: string | undefined): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number" && type === "date") return new Date(v).toISOString().slice(0, 10).replaceAll("-", "/");
    if (typeof v === "number" && type === "datetime") return new Date(v).toLocaleString("ja-JP");
    if (typeof v === "number") return v.toLocaleString("ja-JP", { maximumFractionDigits: 2 });
    return String(v);
  };
  const cell = (tag: "th" | "td", value: string, cls?: string) => {
    const c = document.createElement(tag);
    c.textContent = value;
    if (cls) c.className = cls;
    return c;
  };
  const groups = config.group_by ?? [];
  const keys = rows.length ? Object.keys(rows[0]!).filter((k) => k !== "__ROW_PATH__") : [];
  // A split column is `関東|金額`: its value's type is the last part's.
  const typeOf = (key: string) => types[key.split("|").at(-1)!];
  const out = document.createElement("div");
  out.className = "devbi-explore-print";
  const grid = document.createElement("table");
  const head = grid.createTHead().insertRow();
  if (groups.length) head.append(cell("th", groups.join(" / ")));
  for (const k of keys) head.append(cell("th", k.replaceAll("|", " / "), typeOf(k) === "string" ? undefined : "devbi-num"));
  const body = grid.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    if (groups.length) {
      const path = Array.isArray(r.__ROW_PATH__) ? r.__ROW_PATH__ : [];
      const th = cell("th", path.length ? text(path.at(-1), source[groups[path.length - 1]!]) : "合計");
      th.style.paddingLeft = `${4 + Math.max(0, path.length - 1) * 12}px`;
      tr.append(th);
    }
    for (const k of keys) tr.append(cell("td", text(r[k], typeOf(k)), typeOf(k) === "string" ? undefined : "devbi-num"));
  }
  out.append(grid);
  const notes = [
    ...(config.plugin && config.plugin !== "Datagrid" ? ["グラフは印刷では表で出します"] : []),
    ...(count > rows.length ? [`${count.toLocaleString("ja-JP")} 行のうち最初の ${rows.length} 行`] : []),
  ];
  if (notes.length)
    out.append(Object.assign(document.createElement("p"), { className: "devbi-explore-note", textContent: notes.join("。") }));
  return out;
}
