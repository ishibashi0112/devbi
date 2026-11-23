import type { TileSpec } from "devbi";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { loadChunk } from "./chunk.js";
import { useDevbi } from "./context.js";
import { dataTiles, tileName } from "./export/tiles.js";

/** What the ファイル出力 menu can write: `xlsx` (Excel), `csv` (a tile's CSV, or every tile's in a ZIP), `pdf` (印刷・PDF). */
export type ExportKind = "xlsx" | "csv" | "pdf";

/** Every kind, in the menu's order. */
export const EXPORT_KINDS: readonly ExportKind[] = ["xlsx", "pdf", "csv"];

/** The `exports` option (`true`, `false`, or the kinds to offer, such as `["xlsx", "pdf"]`): the kinds in the menu. */
export function exportKinds(exports: boolean | readonly ExportKind[] | null | undefined): ExportKind[] {
  if (exports === undefined || exports === true) return [...EXPORT_KINDS];
  // false, and null from plain JavaScript
  if (!Array.isArray(exports)) return [];
  return EXPORT_KINDS.filter((k) => exports.includes(k));
}

const NAMES: Record<ExportKind, string> = { xlsx: "Excel", pdf: "PDF", csv: "CSV" };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The menu's items that can be chosen now, in order. */
const itemsOf = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];

function Item({ label, note, onSelect, className }: { label: ReactNode; note?: string; onSelect?: () => void; className?: string }) {
  const noteId = useId();
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={className}
      // an item that cannot be chosen (the tiles still being found): shown, skipped by the arrow keys
      disabled={!onSelect}
      {...(note ? { "aria-describedby": noteId } : {})}
      onClick={onSelect}
    >
      <span className="devbi-menu-label">{label}</span>
      {note && (
        // the description, not a part of the name (read through aria-describedby)
        <small id={noteId} aria-hidden="true">
          {note}
        </small>
      )}
    </button>
  );
}

/** The tiles' names in the menu: their titles, with the id after one that another tile has too. */
function menuNames(tiles: readonly TileSpec[]): string[] {
  const count = new Map<string, number>();
  for (const t of tiles) count.set(tileName(t), (count.get(tileName(t)) ?? 0) + 1);
  return tiles.map((t) => (count.get(tileName(t))! > 1 && t.title !== undefined ? `${t.title}（${t.id}）` : tileName(t)));
}

/**
 * The ファイル出力 menu at the top of a dashboard. Excel saves the data of every tile (as it is filtered now) as a
 * workbook; 印刷・PDF prints the dashboard as it is on the screen (the print dialog saves it as PDF); CSV saves one
 * tile's data, or every tile's in a ZIP.
 */
export function ExportMenu({ root, kinds }: { root: RefObject<HTMLElement | null>; kinds: readonly ExportKind[] }) {
  const ctx = useDevbi();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"data" | "print" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The tiles that have a CSV: found each time the menu opens (null while looking, and while closed).
  const [tiles, setTiles] = useState<TileSpec[] | null>(null);
  // Where the menu's left edge is, from the button's (px): when there is no room for it on the button's left (on a
  // phone, the button wrapped left), it opens rightward, moved back as far as the screen's right edge needs. None: it
  // ends at the button's right edge.
  const [shift, setShift] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // The item that has the focus when it opens: the last with ↑ on the button (as the WAI-ARIA menu button does).
  const startAt = useRef<"first" | "last">("first");
  // The item it gave the focus to when it opened (until the viewer moves it).
  const placed = useRef<HTMLElement | null>(null);
  const menuId = useId();
  const csvId = useId();
  const csvHintId = useId();
  const withCsv = kinds.includes("csv");

  useEffect(() => {
    if (!open || !withCsv) return;
    let live = true;
    dataTiles(ctx).then(
      (t) => live && setTiles(t),
      () => live && setTiles([]),
    );
    return () => {
      live = false;
      // so it opens again with the tiles as they are then, not a moment of the old ones
      setTiles(null);
    };
    // the dashboard's tiles as they are when it opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, withCsv]);

  // Open: a press outside, or Esc wherever the focus is, closes it.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: globalThis.KeyboardEvent) => {
      // inside the box, its own handler does it
      if (e.key === "Escape" && !box.current?.contains(document.activeElement)) setOpen(false);
    };
    // capture: before a part of the page that stops the press from going further
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  // Opened, or the tiles came: an item has the focus unless one has it already (the arrow keys move it; a menu of CSV
  // only has none until its tiles come). And which way it opens, now that its width is known.
  useLayoutEffect(() => {
    const el = menu.current;
    if (!open || !el) {
      setShift(null);
      return;
    }
    const at = document.activeElement;
    // still where it was put (the last item before the tiles came): moved to the first or last item again
    if (!at || !el.contains(at) || at === el || at === placed.current) {
      const items = itemsOf(el);
      placed.current = (startAt.current === "last" ? items.at(-1) : items[0]) ?? null;
      placed.current?.focus();
    }
    const b = box.current?.getBoundingClientRect();
    if (!b) return;
    const width = el.offsetWidth;
    const screen = document.documentElement.clientWidth;
    // 8px from the screen's edges (the menu is at most the screen less 32px wide)
    setShift(b.right - width >= 8 ? null : Math.max(8 - b.left, Math.min(0, screen - 8 - (b.left + width))));
  }, [open, tiles]);

  const close = (focus = true) => {
    setOpen(false);
    if (focus) button.current?.focus();
  };
  const openMenu = (at: "first" | "last") => {
    startAt.current = at;
    setOpen(true);
  };
  const run = (kind: "data" | "print", failed: string, work: () => Promise<void>) => () => {
    close();
    setBusy(kind);
    setError(null);
    work()
      .catch((e: unknown) => setError(`${failed}: ${message(e)}`))
      .finally(() => {
        setBusy(null);
        // The button had the focus until it was disabled: give it back, unless the viewer has gone on elsewhere.
        requestAnimationFrame(() => {
          const at = document.activeElement;
          if (!at || at === document.body) button.current?.focus();
        });
      });
  };
  const xlsx = run("data", "Excel に書き出せませんでした", async () => {
    const { exportXlsx } = await loadChunk(() => import("./export/xlsx.js"));
    await exportXlsx(ctx);
  });
  const print = run("print", "印刷できませんでした", async () => {
    const el = root.current;
    if (!el) return;
    const { printDashboard, printTitle } = await loadChunk(() => import("./export/print.js"));
    await printDashboard(el, printTitle(ctx.dashboard.title, new Date()));
  });
  const csv = (tile: TileSpec) =>
    run("data", "CSV に書き出せませんでした", async () => {
      const { exportTileCsv } = await loadChunk(() => import("./export/csv.js"));
      await exportTileCsv(ctx, tile);
    });
  const zip = run("data", "CSV に書き出せませんでした", async () => {
    const { exportCsvZip } = await loadChunk(() => import("./export/csv.js"));
    await exportCsvZip(ctx);
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (e.target === button.current && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        openMenu(e.key === "ArrowUp" ? "last" : "first");
      }
      return;
    }
    const items = itemsOf(menu.current);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      go(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      go(at < 0 ? -1 : at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(-1);
    }
  };

  const sections: ReactNode[] = [];
  if (kinds.includes("xlsx"))
    sections.push(<Item key="xlsx" label="Excel（.xlsx）" note="すべてのタイルを、タイルごとのシートに" onSelect={xlsx} />);
  if (kinds.includes("pdf"))
    sections.push(<Item key="pdf" label="印刷・PDF" note="画面のとおりに印刷（「PDF に保存」で PDF に）" onSelect={print} />);
  if (withCsv) {
    const names = tiles ? menuNames(tiles) : [];
    sections.push(
      <div key="csv" role="group" aria-labelledby={csvId} aria-describedby={csvHintId}>
        <div className="devbi-menu-heading" id={csvId}>
          CSV（.csv）
        </div>
        <small className="devbi-menu-hint" id={csvHintId}>
          タイルごとに、表示形式なしの値で
        </small>
        {tiles === null ? (
          <Item className="devbi-menu-tile" label="タイルを調べています…" />
        ) : tiles.length === 0 ? (
          <Item className="devbi-menu-tile" label="データを読むタイルがありません" />
        ) : (
          <>
            {tiles.length > 1 && <Item className="devbi-menu-tile" label="すべてのタイル（.zip）" note="タイルごとの CSV を 1 つの ZIP に" onSelect={zip} />}
            {tiles.map((t, i) => (
              <Item key={t.id} className="devbi-menu-tile" label={names[i]} onSelect={csv(t)} />
            ))}
          </>
        )}
      </div>,
    );
  }

  return (
    <>
      {/* Closed by a press outside, Esc or Tab, not on blur: a press on the menu's scroll bar or heading moves the focus
          out of it in some browsers. */}
      <div className="devbi-export" ref={box} onKeyDown={onKeyDown}>
        <button
          ref={button}
          type="button"
          className="devbi-button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={busy !== null}
          title={`いま表示している状態のまま、${kinds.map((k) => NAMES[k]).join("・")} のファイルにします`}
          onClick={() => (open ? setOpen(false) : openMenu("first"))}
        >
          {busy === "data" ? "書き出し中…" : busy === "print" ? "準備中…" : "ファイル出力"}
          {busy === null && (
            <span className="devbi-caret" aria-hidden="true">
              ▾
            </span>
          )}
        </button>
        {open && (
          // tabIndex: a press on the menu between its items keeps the focus in it (Esc and the arrow keys still work)
          <div
            className="devbi-menu"
            style={shift === null ? undefined : { left: `${shift}px`, right: "auto" }}
            role="menu"
            id={menuId}
            aria-label="ファイル出力"
            ref={menu}
            tabIndex={-1}
          >
            {sections.flatMap((s, i) => (i === 0 ? [s] : [<div key={`sep${i}`} role="separator" />, s]))}
          </div>
        )}
      </div>
      {error && (
        <span className="devbi-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
