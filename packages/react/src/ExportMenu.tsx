import type { TileSpec } from "devbi";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { loadChunk } from "./chunk.js";
import { useDevbi } from "./context.js";
import { dataTiles, tileName } from "./export/tiles.js";

/** What the ファイル出力 menu can write: `xlsx` (Excel), `csv` (a tile's CSV, or every tile's in a ZIP), `pdf` (印刷・PDF). */
export type ExportKind = "xlsx" | "csv" | "pdf";

/** Every kind, in the menu's order. */
export const EXPORT_KINDS: readonly ExportKind[] = ["xlsx", "pdf", "csv"];

/** The `exports` option (`true`, `false`, or the kinds to offer, such as `["xlsx", "pdf"]`): the kinds in the menu. */
export function exportKinds(exports: boolean | readonly ExportKind[] | undefined): ExportKind[] {
  if (exports === undefined || exports === true) return [...EXPORT_KINDS];
  if (exports === false) return [];
  return EXPORT_KINDS.filter((k) => exports.includes(k));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The menu's items that can be chosen now, in order. */
const itemsOf = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];

function Item({ label, note, onSelect, className }: { label: ReactNode; note?: string; onSelect: () => void; className?: string }) {
  const noteId = useId();
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={className}
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
  // The tiles that have a CSV: found each time the menu opens (null while looking).
  const [tiles, setTiles] = useState<TileSpec[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const csvId = useId();
  const withCsv = kinds.includes("csv");

  useEffect(() => {
    if (!open || !withCsv) return;
    let live = true;
    setTiles(null);
    dataTiles(ctx).then(
      (t) => live && setTiles(t),
      () => live && setTiles([]),
    );
    return () => {
      live = false;
    };
    // the dashboard's tiles as they are when it opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, withCsv]);

  // Opened: the first item has the focus (the arrow keys move it). A press outside closes it.
  useEffect(() => {
    if (!open) return;
    itemsOf(menu.current)[0]?.focus();
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const close = (focus = true) => {
    setOpen(false);
    if (focus) button.current?.focus();
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
        setOpen(true);
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
    } else {
      return;
    }
  };

  const sections: ReactNode[] = [];
  if (kinds.includes("xlsx"))
    sections.push(<Item key="xlsx" label="Excel（.xlsx）" note="すべてのタイルを、タイルごとのシートに" onSelect={xlsx} />);
  if (kinds.includes("pdf"))
    sections.push(<Item key="pdf" label="印刷・PDF" note="画面のとおりに印刷（「PDF に保存」で PDF に）" onSelect={print} />);
  if (withCsv) {
    sections.push(
      <div key="csv" role="group" aria-labelledby={csvId}>
        <div className="devbi-menu-heading" id={csvId}>
          CSV（.csv）
        </div>
        <small className="devbi-menu-hint">タイルごとに、表示形式なしの値で</small>
        {tiles === null ? (
          <div className="devbi-menu-hint">…</div>
        ) : tiles.length === 0 ? (
          <div className="devbi-menu-hint">データを読むタイルがありません</div>
        ) : (
          <>
            {tiles.length > 1 && <Item className="devbi-menu-tile" label="すべてのタイル（.zip）" note="タイルごとの CSV を 1 つの ZIP に" onSelect={zip} />}
            {tiles.map((t) => (
              <Item key={t.id} className="devbi-menu-tile" label={tileName(t)} onSelect={csv(t)} />
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
          title="いま表示している状態のまま、Excel・PDF・CSV のファイルにします"
          onClick={() => setOpen(!open)}
        >
          {busy === "data" ? "書き出し中…" : busy === "print" ? "準備中…" : "ファイル出力"}
          {busy === null && (
            <span className="devbi-caret" aria-hidden="true">
              ▾
            </span>
          )}
        </button>
        {open && (
          <div className="devbi-menu" role="menu" id={menuId} aria-label="ファイル出力" ref={menu}>
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
