// What the two tables (GridTable for the metrics files, DatasetTable for the datasets) share without sharing their
// grids: each builds its own spreadsheet-grid with its own features, in its own chunk.
import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * The column menu and the tooltip sit at the end of the page, outside .devbi-root: give them DevBI's font. (Their
 * colors come from the --ssg-* the grid copies over from the table.)
 */
export const popups = { popover: "devbi-grid-popup", tooltip: "devbi-grid-popup" };

/**
 * The grid follows the dashboard's light / dark, like DevBI's CSS: `data-theme="light"` or `"dark"` on
 * `.devbi-root`, otherwise the OS setting. Watches the attribute, so switching it later works too.
 */
export function useTheme(ref: RefObject<HTMLElement | null>): "light" | "dark" | "auto" {
  const [theme, setTheme] = useState<"light" | "dark" | "auto">("auto");
  useLayoutEffect(() => {
    const root = ref.current?.closest(".devbi-root");
    if (!root) return;
    const read = () => {
      const t = root.getAttribute("data-theme");
      setTheme(t === "light" || t === "dark" ? t : "auto");
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [ref]);
  return theme;
}
