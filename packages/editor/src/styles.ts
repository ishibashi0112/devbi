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
.devbi-ed-item > .devbi-tile { height: 100%; }
/* The tile shows its data, but clicks and drags go to the editor, not to the chart. */
.devbi-ed-cover { position: absolute; inset: 0; cursor: grab; border-radius: var(--devbi-radius); }
.devbi-ed-item:hover > .devbi-ed-cover { box-shadow: inset 0 0 0 1px var(--devbi-accent); }
.devbi-ed-item.devbi-ed-selected > .devbi-ed-cover { box-shadow: inset 0 0 0 2px var(--devbi-accent); }
.devbi-ed-label { position: absolute; left: 8px; bottom: 6px; max-width: calc(100% - 16px); padding: 1px 6px; border-radius: 4px; background: var(--devbi-accent-soft); color: var(--devbi-text); font-size: 11px; pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0; }
.devbi-ed-item:hover > .devbi-ed-label, .devbi-ed-item.devbi-ed-selected > .devbi-ed-label { opacity: 1; }
.devbi-ed-remove { position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; border: 1px solid var(--devbi-border); border-radius: 6px; background: var(--devbi-card); color: var(--devbi-muted); cursor: pointer; line-height: 1; opacity: 0; }
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
