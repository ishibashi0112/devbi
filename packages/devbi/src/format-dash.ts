/**
 * Write a dash.json the way the examples are written by hand, so the GUI editor's saves make small git diffs:
 * one key per line, a tile's `"x": 0, "y": 0, "w": 12, "h": 1` on one line, and a short value (a query, options)
 * on one line. Moving a tile changes one line; adding one adds a block.
 */

/** A value goes on one line when the line is at most this wide (a full-width character counts as 2). */
const WIDTH = 100;
const INDENT = "  ";
const LAYOUT = ["x", "y", "w", "h"] as const;

// East Asian wide and full-width characters: CJK, kana, hangul, full-width forms.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏＀-｠￠-￦]/gu;

function width(text: string): number {
  return text.length + (text.match(WIDE)?.length ?? 0);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One line: `{ "a": 1, "b": ["x", "y"] }`. */
function compact(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(compact).join(", ")}]`;
  if (isObject(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    return entries.length ? `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${compact(x)}`).join(", ")} }` : "{}";
  }
  return JSON.stringify(v) ?? "null";
}

/** `value` after `prefix` at `depth`: on one line if it fits, else one entry per line. */
function fit(v: unknown, depth: number, prefix: string): string {
  const one = compact(v);
  // +1 for the comma that may follow.
  if (width(INDENT.repeat(depth) + prefix + one) + 1 <= WIDTH) return one;
  if (Array.isArray(v) && v.length) {
    const pad = INDENT.repeat(depth + 1);
    return `[\n${v.map((x) => pad + fit(x, depth + 1, "")).join(",\n")}\n${INDENT.repeat(depth)}]`;
  }
  if (isObject(v)) return block(Object.entries(v), depth, (k, x) => fit(x, depth + 1, `${JSON.stringify(k)}: `));
  return one;
}

function block(entries: [string, unknown][], depth: number, value: (key: string, v: unknown) => string, extra?: Map<string, string>): string {
  const pad = INDENT.repeat(depth + 1);
  const lines: string[] = [];
  for (const [k, v] of entries) {
    if (v === undefined) continue;
    const line = extra?.get(k);
    if (line !== undefined) {
      if (line) lines.push(pad + line);
      continue;
    }
    lines.push(`${pad}${JSON.stringify(k)}: ${value(k, v)}`);
  }
  return lines.length ? `{\n${lines.join(",\n")}\n${INDENT.repeat(depth)}}` : "{}";
}

/** A tile: one key per line, with x, y, w, h together where the first of them is. */
function tile(t: unknown, depth: number): string {
  if (!isObject(t)) return fit(t, depth, "");
  const extra = new Map<string, string>();
  if (LAYOUT.every((k) => typeof t[k] === "number")) {
    const first = Object.keys(t).find((k) => (LAYOUT as readonly string[]).includes(k))!;
    for (const k of LAYOUT) extra.set(k, "");
    extra.set(first, LAYOUT.map((k) => `${JSON.stringify(k)}: ${t[k]}`).join(", "));
  }
  return block(Object.entries(t), depth, (k, v) => fit(v, depth + 1, `${JSON.stringify(k)}: `), extra);
}

/**
 * A dashboard as dash.json text (ending in a newline), keeping the order of the keys as given. The GUI editor
 * writes with this; a hand-written file in the same style comes back unchanged.
 */
export function formatDashboardJson(spec: unknown): string {
  if (!isObject(spec)) return `${JSON.stringify(spec, null, 2)}\n`;
  const text = block(Object.entries(spec), 0, (k, v) => {
    if (k === "tiles" && Array.isArray(v)) {
      if (!v.length) return "[]";
      return `[\n${v.map((t) => INDENT.repeat(2) + tile(t, 2)).join(",\n")}\n${INDENT}]`;
    }
    return fit(v, 1, `${JSON.stringify(k)}: `);
  });
  return `${text}\n`;
}
