/** The GUI editor's styles, on top of @devbi/react's (its colors and buttons). */
export const editorCss = `
.devbi-ed-bar { position: sticky; top: 0; z-index: 10; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin: -16px -20px 12px; padding: 10px 20px; background: var(--devbi-bg); border-bottom: 1px solid var(--devbi-border); }
.devbi-ed-bar h1 { font-size: 16px; margin: 0; font-weight: 650; }
.devbi-ed-file { color: var(--devbi-muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.devbi-ed-dirty { font-size: 12px; color: var(--devbi-accent); }
.devbi-ed-tools { margin-left: auto; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.devbi-ed-add { border: 1px solid var(--devbi-border); background: var(--devbi-card); color: inherit; border-radius: 6px; padding: 4px 8px; font: inherit; font-size: 13px; line-height: 1.6; cursor: pointer; }
.devbi-ed-notice { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 12px; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--devbi-border); background: var(--devbi-card); font-size: 13px; }
.devbi-ed-notice[data-kind="error"] { border-color: var(--devbi-down); }
.devbi-ed-notice[data-kind="error"] > span { color: var(--devbi-down); white-space: pre-wrap; }
.devbi-ed-notice[data-kind="warn"] { border-color: var(--devbi-accent); }
.devbi-ed-empty { padding: 40px 16px; text-align: center; border: 2px dashed var(--devbi-border); border-radius: var(--devbi-radius); color: var(--devbi-muted); }
.devbi-ed-grid { position: relative; }
.devbi-ed-grid .react-grid-layout { position: relative; transition: height 200ms ease; }
.devbi-ed-item { transition: transform 200ms ease, width 200ms ease, height 200ms ease; }
.devbi-ed-item.react-draggable-dragging, .devbi-ed-item.resizing { transition: none; z-index: 3; }
.devbi-ed-item.react-draggable-dragging { cursor: grabbing; }
/* Each tile's own layers (a table's sticky header, for one) stay under the cover. */
.devbi-ed-item > .devbi-tile { height: 100%; isolation: isolate; }
/* The tile shows its data, but clicks and drags go to the editor, not to the chart. */
.devbi-ed-cover { position: absolute; inset: 0; z-index: 1; cursor: grab; border-radius: var(--devbi-radius); }
.devbi-ed-item:hover > .devbi-ed-cover { box-shadow: inset 0 0 0 1px var(--devbi-accent); }
.devbi-ed-item.devbi-ed-selected > .devbi-ed-cover { box-shadow: inset 0 0 0 2px var(--devbi-accent); }
.devbi-ed-label { position: absolute; z-index: 2; left: 8px; bottom: 6px; max-width: calc(100% - 16px); padding: 1px 6px; border-radius: 4px; background: var(--devbi-accent-soft); color: var(--devbi-text); font-size: 11px; pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0; }
.devbi-ed-item:hover > .devbi-ed-label, .devbi-ed-item.devbi-ed-selected > .devbi-ed-label { opacity: 1; }
.devbi-ed-remove { position: absolute; z-index: 2; top: 6px; right: 6px; width: 24px; height: 24px; border: 1px solid var(--devbi-border); border-radius: 6px; background: var(--devbi-card); color: var(--devbi-muted); cursor: pointer; line-height: 1; opacity: 0; }
.devbi-ed-item:hover > .devbi-ed-remove, .devbi-ed-item.devbi-ed-selected > .devbi-ed-remove, .devbi-ed-remove:focus-visible { opacity: 1; }
.devbi-ed-remove:hover { color: var(--devbi-down); border-color: var(--devbi-down); }
.devbi-ed-grid .react-grid-placeholder { background: var(--devbi-accent-soft); border: 2px dashed var(--devbi-accent); border-radius: var(--devbi-radius); transition-duration: 100ms; z-index: 2; user-select: none; }
.devbi-ed-grid .react-resizable-handle { position: absolute; z-index: 2; }
.devbi-ed-grid .react-resizable-handle-se { right: 0; bottom: 0; width: 18px; height: 18px; cursor: se-resize; }
.devbi-ed-grid .react-resizable-handle-se::after { content: ""; position: absolute; right: 4px; bottom: 4px; width: 6px; height: 6px; border-right: 2px solid var(--devbi-muted); border-bottom: 2px solid var(--devbi-muted); }
.devbi-ed-grid .react-resizable-handle-e { right: 0; top: 18px; bottom: 18px; width: 8px; cursor: ew-resize; }
.devbi-ed-grid .react-resizable-handle-s { bottom: 0; left: 18px; right: 18px; height: 8px; cursor: ns-resize; }
.devbi-ed-form { max-width: 560px; margin: 24px auto; padding: 20px 24px; display: grid; gap: 14px; background: var(--devbi-card); border: 1px solid var(--devbi-border); border-radius: var(--devbi-radius); }
.devbi-ed-form h1 { font-size: 18px; margin: 0; }
.devbi-ed-field { display: grid; gap: 4px; font-size: 13px; }
.devbi-ed-field small { color: var(--devbi-muted); }
.devbi-ed-field input[aria-invalid="true"] + small { color: var(--devbi-down); }
.devbi-ed-form input, .devbi-ed-form select { font: inherit; color: inherit; background: var(--devbi-bg); border: 1px solid var(--devbi-border); border-radius: 6px; padding: 6px 8px; }
.devbi-ed-form input:focus-visible, .devbi-ed-form select:focus-visible { outline: 2px solid var(--devbi-accent); outline-offset: 1px; }
.devbi-ed-form .devbi-ed-buttons { display: flex; gap: 8px; justify-content: flex-end; }
.devbi-ed-body { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 16px; align-items: start; }
.devbi-ed-panel { position: sticky; top: 64px; max-height: calc(100vh - 80px); overflow: auto; display: grid; gap: 12px; padding: 14px 16px; background: var(--devbi-card); border: 1px solid var(--devbi-border); border-radius: var(--devbi-radius); font-size: 13px; }
.devbi-ed-panel h2 { font-size: 15px; margin: 0; overflow-wrap: anywhere; }
.devbi-ed-panel h3 { font-size: 12px; margin: 6px 0 0; padding-top: 10px; border-top: 1px solid var(--devbi-border); color: var(--devbi-muted); font-weight: 600; }
.devbi-ed-panel p { margin: 0; }
.devbi-ed-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.devbi-ed-panel input:not([type="checkbox"]), .devbi-ed-panel select, .devbi-ed-panel textarea { font: inherit; color: inherit; background: var(--devbi-bg); border: 1px solid var(--devbi-border); border-radius: 6px; padding: 5px 8px; min-width: 0; }
.devbi-ed-panel textarea { min-height: 96px; resize: vertical; }
.devbi-ed-panel textarea.devbi-ed-json { min-height: 180px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.devbi-ed-panel :is(input, select, textarea):focus-visible { outline: 2px solid var(--devbi-accent); outline-offset: 1px; }
.devbi-ed-panel input[aria-invalid="true"] { border-color: var(--devbi-down); }
.devbi-ed-field:has(input[aria-invalid="true"]) small { color: var(--devbi-down); }
.devbi-ed-panel fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: 4px; min-width: 0; }
.devbi-ed-panel legend { padding: 0; margin-bottom: 2px; }
.devbi-ed-name { display: flex; align-items: center; gap: 6px; min-height: 26px; }
.devbi-ed-name label, .devbi-ed-values label { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; cursor: pointer; }
.devbi-ed-name label > span:first-of-type { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.devbi-ed-code { color: var(--devbi-muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.devbi-ed-order { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 9px; background: var(--devbi-accent-soft); font-size: 11px; }
.devbi-ed-mini { border: 1px solid var(--devbi-border); background: var(--devbi-card); color: inherit; border-radius: 4px; padding: 0 6px; cursor: pointer; font-size: 12px; line-height: 1.7; white-space: nowrap; }
.devbi-ed-mini:hover { border-color: var(--devbi-accent); }
.devbi-ed-row { display: flex; gap: 6px; align-items: center; justify-content: space-between; }
.devbi-ed-row > select, .devbi-ed-row > input { flex: 1; }
.devbi-ed-filter { border: 1px solid var(--devbi-border); border-radius: 8px; padding: 8px; display: grid; gap: 6px; }
.devbi-ed-values { max-height: 200px; overflow: auto; display: grid; gap: 2px; }
.devbi-ed-warn { color: var(--devbi-down); }
.devbi-ed-promote { display: grid; gap: 8px; }
.devbi-ed-promote > .devbi-button { justify-self: start; }
.devbi-ed-danger { justify-self: start; margin-top: 4px; }
.devbi-ed-danger:hover { border-color: var(--devbi-down); color: var(--devbi-down); }
@media (max-width: 1180px) { .devbi-ed-body { grid-template-columns: minmax(0, 1fr) 260px; } }
/* Narrower: the panel sits over the bottom of the screen, so it stays in view next to the tile being set. */
@media (max-width: 940px) {
  .devbi-ed-body { grid-template-columns: minmax(0, 1fr); padding-bottom: 46vh; }
  .devbi-ed-panel { position: fixed; z-index: 20; left: 8px; right: 8px; top: auto; bottom: 8px; max-height: 44vh; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25); }
}
@media (prefers-reduced-motion: reduce) { .devbi-ed-item, .devbi-ed-grid .react-grid-layout { transition: none; } }
`;

let injected = false;

export function injectEditorStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.dataset.devbiEditorStyles = "";
  style.textContent = editorCss;
  document.head.append(style);
}
