import { useState, type RefObject } from "react";
import { loadChunk } from "./chunk.js";
import { useDevbi } from "./context.js";

/**
 * The Excel and 印刷・PDF buttons at the top of a dashboard. Excel saves the data of every tile (as it is filtered now)
 * as a workbook; 印刷・PDF prints the dashboard as it is on the screen (the print dialog saves it as PDF).
 */
export function ExportButtons({ root }: { root: RefObject<HTMLElement | null> }) {
  const ctx = useDevbi();
  const [busy, setBusy] = useState<"xlsx" | "print" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (kind: "xlsx" | "print", failed: string, work: () => Promise<void>) => async () => {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(`${failed}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const xlsx = run("xlsx", "Excel に書き出せませんでした", async () => {
    const { exportXlsx } = await loadChunk(() => import("./export/xlsx.js"));
    await exportXlsx(ctx);
  });
  const print = run("print", "印刷できませんでした", async () => {
    const el = root.current;
    if (!el) return;
    const { printDashboard, printTitle } = await loadChunk(() => import("./export/print.js"));
    await printDashboard(el, printTitle(ctx.dashboard.title, new Date()));
  });
  return (
    <>
      <button
        type="button"
        className="devbi-button"
        disabled={busy !== null}
        title="いま表示しているデータを、タイルごとのシートにして Excel ファイルで保存します"
        onClick={xlsx}
      >
        {busy === "xlsx" ? "書き出し中…" : "Excel"}
      </button>
      <button
        type="button"
        className="devbi-button"
        disabled={busy !== null}
        title="画面のとおりに印刷します。印刷の画面で送り先を「PDF に保存」にすると PDF になります"
        onClick={print}
      >
        {busy === "print" ? "準備中…" : "印刷・PDF"}
      </button>
      {error && (
        <span className="devbi-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
