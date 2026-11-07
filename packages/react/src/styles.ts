/** Default styles, injected once. Override the custom properties to theme. */
export const css = `
.devbi-root {
  --devbi-bg: #f6f7f9;
  --devbi-card: #ffffff;
  --devbi-text: #1d2330;
  --devbi-muted: #667085;
  --devbi-border: #e3e6eb;
  --devbi-accent: #3b6fe0;
  --devbi-accent-soft: rgba(59, 111, 224, 0.14);
  --devbi-up: #12805c;
  --devbi-down: #c4320a;
  --devbi-radius: 10px;
  background: var(--devbi-bg);
  color: var(--devbi-text);
  font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Noto Sans JP", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  min-height: 100%;
  box-sizing: border-box;
}
@media (prefers-color-scheme: dark) {
  .devbi-root:not([data-theme="light"]) {
    --devbi-bg: #12151b;
    --devbi-card: #1b1f27;
    --devbi-text: #e6e8ec;
    --devbi-muted: #98a2b3;
    --devbi-border: #2c323d;
    --devbi-accent: #7c9cf5;
    --devbi-accent-soft: rgba(124, 156, 245, 0.18);
    --devbi-up: #4cc38a;
    --devbi-down: #ff8a65;
  }
}
.devbi-root *, .devbi-root *::before, .devbi-root *::after { box-sizing: inherit; }
.devbi-root button { font: inherit; color: inherit; }
.devbi-dashboard { padding: 16px 20px 32px; max-width: 1600px; margin: 0 auto; }
.devbi-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; margin-bottom: 12px; }
.devbi-head h1 { font-size: 20px; margin: 0; font-weight: 650; }
.devbi-head p { margin: 0; color: var(--devbi-muted); }
.devbi-filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 28px; margin-bottom: 12px; }
.devbi-filters .devbi-chip { display: inline-flex; gap: 6px; align-items: center; border: 1px solid var(--devbi-border); background: var(--devbi-card); border-radius: 999px; padding: 2px 4px 2px 10px; font-size: 13px; }
.devbi-chip button { border: 0; background: none; cursor: pointer; color: var(--devbi-muted); padding: 0 6px; border-radius: 999px; }
.devbi-chip button:hover { background: var(--devbi-accent-soft); color: var(--devbi-text); }
.devbi-filters .devbi-clear-all { border: 0; background: none; color: var(--devbi-accent); cursor: pointer; padding: 2px 6px; }
.devbi-hint { color: var(--devbi-muted); font-size: 13px; }
.devbi-grid { display: grid; grid-template-columns: repeat(var(--devbi-columns, 12), minmax(0, 1fr)); grid-auto-rows: var(--devbi-row, 80px); gap: 12px; }
.devbi-tile { background: var(--devbi-card); border: 1px solid var(--devbi-border); border-radius: var(--devbi-radius); display: flex; flex-direction: column; min-width: 0; min-height: 0; position: relative; overflow: hidden; }
.devbi-tile.devbi-loading::after { content: ""; position: absolute; left: 0; top: 0; height: 2px; width: 40%; background: var(--devbi-accent); animation: devbi-load 1s ease-in-out infinite; }
@keyframes devbi-load { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
@media (prefers-reduced-motion: reduce) { .devbi-tile.devbi-loading::after { animation: none; width: 100%; opacity: 0.4; } }
.devbi-tile-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px 0; }
.devbi-tile-title h2 { font-size: 13px; font-weight: 600; margin: 0; color: var(--devbi-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.devbi-clear { border: 0; background: none; color: var(--devbi-accent); cursor: pointer; font-size: 12px; padding: 0 4px; }
.devbi-tile-body { flex: 1; min-height: 0; padding: 8px 14px 12px; overflow: auto; }
.devbi-tile-markdown .devbi-tile-body, .devbi-tile-date-range .devbi-tile-body { overflow: auto; }
.devbi-empty { color: var(--devbi-muted); font-size: 13px; }
.devbi-error { color: var(--devbi-down); font-size: 13px; white-space: pre-wrap; }
.devbi-kpi { display: flex; flex-direction: column; justify-content: center; height: 100%; }
.devbi-kpi-label { color: var(--devbi-muted); font-size: 12px; }
.devbi-tile-title + .devbi-tile-body .devbi-kpi-label { display: none; }
.devbi-kpi-value { font-size: clamp(22px, 3.2vw, 34px); font-weight: 650; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; line-height: 1.2; }
.devbi-kpi-sub { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 6px 0 0; font-size: 13px; }
.devbi-kpi-sub div { display: flex; gap: 6px; }
.devbi-kpi-sub dt { color: var(--devbi-muted); }
.devbi-kpi-sub dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
.devbi-up { color: var(--devbi-up); }
.devbi-down { color: var(--devbi-down); }
.devbi-chart { width: 100%; height: 100%; }
.devbi-chart svg { display: block; cursor: pointer; }
.devbi-chart figure { margin: 0; }
.devbi-barlist { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.devbi-barlist button { position: relative; display: flex; justify-content: space-between; gap: 12px; width: 100%; border: 0; background: none; text-align: left; padding: 5px 8px; border-radius: 6px; cursor: pointer; overflow: hidden; }
.devbi-barlist .devbi-bar { position: absolute; inset: 0 auto 0 0; background: var(--devbi-accent-soft); border-radius: 6px; z-index: 0; }
.devbi-barlist button > span:not(.devbi-bar) { position: relative; z-index: 1; }
.devbi-barlist-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.devbi-barlist-value { font-variant-numeric: tabular-nums; white-space: nowrap; }
.devbi-barlist-value small { color: var(--devbi-muted); margin-left: 6px; }
.devbi-barlist button:hover .devbi-bar { background: rgba(59, 111, 224, 0.24); }
.devbi-barlist button.devbi-selected { outline: 2px solid var(--devbi-accent); outline-offset: -2px; }
.devbi-dimmed { opacity: 0.45; }
.devbi-table-wrap { overflow: auto; height: 100%; }
.devbi-table { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
.devbi-table th, .devbi-table td { padding: 6px 8px; border-bottom: 1px solid var(--devbi-border); text-align: left; white-space: nowrap; }
.devbi-table thead th { position: sticky; top: 0; background: var(--devbi-card); z-index: 1; font-weight: 600; }
.devbi-table th button { border: 0; background: none; padding: 0; cursor: pointer; font-weight: 600; text-align: inherit; }
.devbi-table .devbi-num { text-align: right; }
.devbi-table tbody tr { cursor: pointer; }
.devbi-table tbody tr:hover { background: var(--devbi-accent-soft); }
.devbi-table tr.devbi-selected { background: var(--devbi-accent-soft); }
.devbi-pivot tbody th { font-weight: 500; }
.devbi-pivot tbody td { cursor: pointer; }
.devbi-pivot .devbi-total, .devbi-pivot tfoot th { font-weight: 650; }
.devbi-pivot tfoot td, .devbi-pivot tfoot th { position: sticky; bottom: 0; background: var(--devbi-card); }
.devbi-daterange { display: grid; gap: 8px; }
.devbi-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.devbi-chips button { border: 1px solid var(--devbi-border); background: none; border-radius: 999px; padding: 3px 12px; cursor: pointer; font-size: 13px; }
.devbi-chips button[aria-pressed="true"] { background: var(--devbi-accent); border-color: var(--devbi-accent); color: #fff; }
.devbi-daterange-inputs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.devbi-root input[type="date"], .devbi-root input[type="search"] { font: inherit; color: inherit; background: var(--devbi-card); border: 1px solid var(--devbi-border); border-radius: 6px; padding: 3px 8px; }
.devbi-select { display: flex; flex-direction: column; gap: 6px; height: 100%; }
.devbi-select-head { display: flex; gap: 6px; }
.devbi-select-head input { flex: 1; min-width: 0; }
.devbi-select-head button { border: 1px solid var(--devbi-border); background: none; border-radius: 6px; padding: 2px 10px; cursor: pointer; }
.devbi-select-head button:disabled { opacity: 0.5; cursor: default; }
.devbi-select ul { list-style: none; padding: 0; margin: 0; overflow: auto; }
.devbi-select label { display: flex; gap: 8px; align-items: center; padding: 3px 2px; cursor: pointer; }
.devbi-select label span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.devbi-select small { color: var(--devbi-muted); font-variant-numeric: tabular-nums; }
.devbi-markdown { font-size: 14px; }
.devbi-markdown > :first-child { margin-top: 0; }
.devbi-markdown h2 { font-size: 18px; } .devbi-markdown h3 { font-size: 15px; } .devbi-markdown h4 { font-size: 14px; }
.devbi-markdown code { background: var(--devbi-accent-soft); padding: 0 4px; border-radius: 4px; }
.devbi-markdown a { color: var(--devbi-accent); }
.devbi-index { padding: 24px 20px; max-width: 900px; margin: 0 auto; }
.devbi-index h1 { font-size: 20px; }
.devbi-index ul { list-style: none; padding: 0; display: grid; gap: 8px; }
.devbi-index a { display: block; padding: 12px 16px; background: var(--devbi-card); border: 1px solid var(--devbi-border); border-radius: var(--devbi-radius); color: inherit; text-decoration: none; }
.devbi-index a:hover { border-color: var(--devbi-accent); }
.devbi-index small { display: block; color: var(--devbi-muted); }
.devbi-back { color: var(--devbi-accent); text-decoration: none; font-size: 13px; }
.devbi-root :focus-visible { outline: 2px solid var(--devbi-accent); outline-offset: 2px; }
@media (max-width: 720px) {
  .devbi-dashboard { padding: 12px 16px 24px; }
  .devbi-grid { grid-template-columns: minmax(0, 1fr); grid-auto-rows: auto; }
  .devbi-grid > .devbi-tile { grid-column: 1 / -1 !important; grid-row: auto !important; height: var(--devbi-mobile-h, 240px); }
}
`;

let injected = false;

export function injectStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.dataset.devbi = "";
  style.textContent = css;
  document.head.prepend(style);
}
