// The 印刷・PDF button: the dashboard as it is on the screen, printed from a copy in a hidden frame, so only the
// dashboard is printed (not the page around an embedded one) and the screen does not change. The browser's print
// dialog saves it as PDF ("PDF に保存").

/** The width printed on, in CSS pixels: A4 landscape (297 mm) less 10 mm margins on each side. */
export const PAGE_WIDTH = 1040;

/** How long to wait for the tiles still loading before printing what there is. */
const SETTLE_MS = 20_000;
/** How long to wait for the copy's styles, images and fonts. */
const LOAD_MS = 10_000;

let previous: HTMLIFrameElement | undefined;

// The page's frames, not the hidden frame's (a browser may hold back drawing a frame out of view).
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Until no tile in `root` is loading (or SETTLE_MS have passed). */
async function settled(root: HTMLElement): Promise<void> {
  const end = Date.now() + SETTLE_MS;
  while (root.querySelector('[aria-busy="true"]') && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
}

const isTag = <K extends keyof HTMLElementTagNameMap>(el: Element, tag: K): el is HTMLElementTagNameMap[K] => el.localName === tag;

/** What cloneNode leaves behind: typed text, ticked boxes, chosen options, drawn canvases. */
function copyState(from: HTMLElement, to: HTMLElement) {
  const a = [from, ...from.querySelectorAll("*")];
  const b = [to, ...to.querySelectorAll("*")];
  a.forEach((el, i) => {
    const copy = b[i];
    if (!copy || copy.localName !== el.localName) return;
    if (isTag(el, "input") && isTag(copy, "input")) {
      copy.value = el.value;
      copy.checked = el.checked;
    } else if (isTag(el, "select") && isTag(copy, "select")) {
      copy.selectedIndex = el.selectedIndex;
    } else if (isTag(el, "textarea") && isTag(copy, "textarea")) {
      copy.value = el.value;
    } else if (isTag(el, "canvas") && isTag(copy, "canvas") && el.width && el.height) {
      try {
        copy.getContext("2d")?.drawImage(el, 0, 0);
      } catch {
        // a canvas with another site's image cannot be read
      }
    }
  });
}

/**
 * Scrolled lists and tables show the same rows: what the returned function sets on the copy (once it is laid out). The
 * elements are paired now, while the copy is still the same tree.
 */
function scrollOf(from: HTMLElement, to: HTMLElement): () => void {
  const a = [...from.querySelectorAll("*")];
  const b = [...to.querySelectorAll("*")];
  const scrolled = a.flatMap((el, i) => (b[i] && (el.scrollTop || el.scrollLeft) ? [{ el: b[i], top: el.scrollTop, left: el.scrollLeft }] : []));
  return () => {
    for (const { el, top, left } of scrolled) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  };
}

/**
 * The tiles of each grid in bands of rows that no tile crosses, each band a grid of its own kept on one page: the
 * browser then breaks pages only between bands (inside one grid, a tile on a page break is not reliably kept whole).
 */
function splitIntoBands(copy: HTMLElement) {
  for (const grid of copy.querySelectorAll<HTMLElement>(".devbi-grid")) {
    const tiles = [...grid.children].map((child) => {
      const el = child as HTMLElement;
      const start = Number.parseInt(el.style.gridRowStart, 10);
      const end = start + Number.parseInt(el.style.gridRowEnd.replace(/^span\s+/, ""), 10);
      return { el, start, end };
    });
    if (tiles.some((t) => !Number.isFinite(t.start) || !Number.isFinite(t.end))) continue; // placed some other way
    tiles.sort((a, b) => a.start - b.start);
    const bands: { start: number; end: number; tiles: HTMLElement[] }[] = [];
    for (const t of tiles) {
      const band = bands[bands.length - 1];
      if (band && t.start < band.end) {
        band.end = Math.max(band.end, t.end);
        band.tiles.push(t.el);
      } else {
        bands.push({ start: t.start, end: t.end, tiles: [t.el] });
      }
    }
    if (bands.length < 2) continue;
    for (const band of bands) {
      const part = grid.cloneNode(false) as HTMLElement; // the same columns and row height
      part.classList.add("devbi-print-band");
      for (const el of band.tiles) {
        el.style.gridRowStart = String(Number.parseInt(el.style.gridRowStart, 10) - band.start + 1);
        part.append(el);
      }
      grid.before(part);
    }
    grid.remove();
  }
}

function loaded(el: HTMLLinkElement | HTMLImageElement): Promise<void> {
  return new Promise((resolve) => {
    el.addEventListener("load", () => resolve(), { once: true });
    el.addEventListener("error", () => resolve(), { once: true });
  });
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Print the dashboard in `root` (a `.devbi-root`): a copy of it in a hidden frame, laid out as wide as on the screen
 * and scaled to the page (A4 landscape), in light colors, without the buttons. `title` names the PDF the browser saves.
 */
export async function printDashboard(root: HTMLElement, title: string, now = new Date()): Promise<void> {
  await settled(root);
  previous?.remove();
  const dashboard = root.querySelector<HTMLElement>(".devbi-dashboard") ?? root;
  const width = Math.max(1, Math.ceil(dashboard.getBoundingClientRect().width));
  const zoom = Math.min(1, PAGE_WIDTH / width);

  const frame = document.createElement("iframe");
  previous = frame;
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.dataset.devbiPrintFrame = "";
  frame.style.cssText = `position: fixed; left: -${width + 100}px; top: 0; width: ${width}px; height: 800px; border: 0;`;
  const ready = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  frame.srcdoc = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body></body></html>`;
  document.body.append(frame);
  await ready;
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) throw new Error("印刷の準備ができませんでした");

  // The page's styles (DevBI's, the table's, the project's), in their order.
  const waits: Promise<void>[] = [];
  for (const node of document.querySelectorAll('style, link[rel~="stylesheet"]')) {
    const copy = doc.importNode(node, true) as HTMLElement;
    if (isTag(node, "link") && isTag(copy, "link")) {
      copy.href = node.href;
      waits.push(loaded(copy));
    }
    doc.head.append(copy);
  }
  const page = doc.createElement("style");
  page.textContent =
    `@page { size: landscape; margin: 10mm; }\n` +
    `html, body { margin: 0; background: #fff; }\n` +
    `.devbi-root[data-devbi-print] .devbi-dashboard { width: ${width}px; max-width: none; margin: 0; padding: 0; zoom: ${zoom}; }\n` +
    `.devbi-print-band { break-inside: avoid; }\n` +
    `.devbi-print-band + .devbi-print-band { margin-top: 12px; }`;
  doc.head.append(page);

  const copy = doc.importNode(root, true);
  // Paired with the screen's elements while the copy is still the same tree.
  copyState(root, copy);
  const scroll = scrollOf(root, copy);
  copy.setAttribute("data-theme", "light");
  copy.setAttribute("data-devbi-print", "");
  for (const el of copy.querySelectorAll(".ssg-theme-dark")) el.classList.remove("ssg-theme-dark");
  const printed = doc.createElement("p");
  printed.className = "devbi-printed";
  printed.textContent = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${now.getHours()}:${pad(now.getMinutes())} の表示`;
  copy.querySelector(".devbi-head")?.append(printed);
  doc.body.append(copy);
  splitIntoBands(copy);
  for (const img of copy.querySelectorAll("img")) if (!img.complete) waits.push(loaded(img));

  // Styles, images and fonts, but not forever (a stylesheet that never answers).
  await Promise.race([Promise.all([...waits, doc.fonts?.ready]), new Promise((r) => setTimeout(r, LOAD_MS))]);
  await nextFrame();
  scroll();
  await nextFrame();

  win.addEventListener("afterprint", () => setTimeout(() => frame.remove(), 0), { once: true });
  win.focus();
  win.print();
}

/** `<title>_<yyyymmdd>`: the name the PDF is saved as. */
export function printTitle(title: string, now: Date): string {
  return `${title}_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}
