import { TILE_TYPES, type BuiltinTileType, type Grain, type MetricsView } from "devbi";

/** A built-in tile as dash.json has it, to be written out as a promoted tile (`dashboards/<name>/<Name>.tsx`). */
export interface PromotedTile {
  id: string;
  type: BuiltinTileType;
  title?: string;
  query?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

const GRAIN_LABELS: Record<Grain, string> = { day: "日", week: "週", month: "月", quarter: "四半期", year: "年", fiscal_year: "年度" };

/** Names the file itself uses: a component with one of them would hide it. */
const USED = new Set(["Builtin", "TileProps", "RowOf"]);

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");

/**
 * The component's name, and its file's: the tile's id in PascalCase (`top-customers` → `TopCustomers`), from its
 * ASCII letters and digits; with none, the type's (`KpiTile`).
 */
export function componentName(id: string, type: string): string {
  let name = pascal(id).slice(0, 60) || `${pascal(type)}Tile`;
  if (/^\d/.test(name)) name = `Tile${name}`;
  return USED.has(name) ? `${name}Tile` : name;
}

const IDENT = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;

/**
 * Text from dash.json or metrics.yaml in a comment: one line, so it cannot end the comment and start code, and no
 * `@`, so it cannot be a pragma the compiler reads in any comment (`@jsxImportSource https://…` would load a module).
 */
const oneLine = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, " ").replaceAll("@", "＠");

const key = (k: string) => (k === "__proto__" ? `["__proto__"]` : IDENT.test(k) ? k : JSON.stringify(k));

/** A JSON value as a JS literal: on one line when short, else one entry per line. */
function literal(value: unknown, indent: string): string {
  const inner = `${indent}  `;
  const fits = (s: string) => indent.length + s.length <= 72;
  if (Array.isArray(value)) {
    const items = value.map((v) => literal(v, inner));
    const one = `[${items.join(", ")}]`;
    return fits(one) && !one.includes("\n") ? one : `[\n${items.map((i) => `${inner}${i},`).join("\n")}\n${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(([k, v]) => `${key(k)}: ${literal(v, inner)}`);
    if (!entries.length) return "{}";
    const one = `{ ${entries.join(", ")} }`;
    return fits(one) && !one.includes("\n") ? one : `{\n${entries.map((e) => `${inner}${e},`).join("\n")}\n${indent}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const names = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is string => typeof n === "string") : []);

/** The query's result columns (time, dimensions, measures), each with what it is, as far as the metrics file says. */
function columnsOf(query: Record<string, unknown>, view: MetricsView | undefined): { name: string; about: string; measure: boolean }[] {
  const out: { name: string; about: string; measure: boolean }[] = [];
  const about = (name: string, label: string) => (label === name ? name : `${name}（${label}）`);
  const grain = typeof query.time === "string" && Object.hasOwn(GRAIN_LABELS, query.time) ? (query.time as Grain) : undefined;
  if (grain && view?.time) {
    const { name, label } = view.time;
    out.push({ name, about: `${name}（${label === name ? "" : `${label}、`}${GRAIN_LABELS[grain]}ごと）`, measure: false });
  }
  for (const n of names(query.dimensions)) out.push({ name: n, about: about(n, view?.dimensions[n]?.label ?? n), measure: false });
  for (const n of names(query.measures)) out.push({ name: n, about: about(n, view?.measures[n]?.label ?? n), measure: true });
  return out;
}

const field = (name: string) => (IDENT.test(name) ? `r.${name}` : `r[${JSON.stringify(name)}]`);

/**
 * The source of a promoted tile: the same tile, drawn by the built-in component for now, with its query (checked
 * and typed by `defineQuery`) and options moved into the file, and a note on how to draw it yourself.
 */
export function promotedTileSource(tile: PromotedTile, options: { name: string; view?: MetricsView; metrics?: string }): string {
  const info = TILE_TYPES[tile.type];
  const what = `組み込みの${info.label}`;
  const title = oneLine(tile.title || tile.id);
  const hasQuery = info.query;
  const query = hasQuery ? (tile.query ?? {}) : undefined;
  const opts = tile.options && Object.keys(tile.options).length ? tile.options : undefined;
  const lines = [
    `// 「${title}」のタイル。GUI エディタの「コードにする」で、${what}から書き出したもの。`,
    "// このタイルのデータと描き方は、このファイルで変える（GUI で変えられるのは、位置・大きさ・見出し・名前）。",
    "// 自作タイルの書き方: https://github.com/ishibashi0112/devbi/blob/main/docs/reference.md#自作タイルjsx",
    `import { builtinTiles } from "@devbi/react";`,
    query ? `import { defineQuery, type RowOf, type TileProps } from "devbi";` : `import type { TileProps } from "devbi";`,
    "",
  ];
  if (query) {
    const metrics = typeof query.metrics === "string" ? query.metrics : options.metrics;
    lines.push(
      `// 何を出すか（SQL は書かない）。${metrics ? `指標と軸の名前は models/${oneLine(metrics)}.metrics.yaml のもの` : "指標と軸の名前で書く"}`,
      `export const query = defineQuery(${literal(query, "")});`,
      "",
    );
  }
  if (opts) lines.push(`// ${info.label}の設定（dash.json の "options" に書いていたもの）`, `const options = ${literal(opts, "")};`, "");
  lines.push(
    `// いまは${what}で描いている`,
    `const Builtin = builtinTiles${IDENT.test(tile.type) ? `.${tile.type}` : `[${JSON.stringify(tile.type)}]`}.component;`,
    "",
    `export default function ${options.name}(props: TileProps${query ? "<RowOf<typeof query>>" : ""}) {`,
  );
  const columns = query ? columnsOf(query, options.view) : [];
  if (query) {
    lines.push("  // 自分で描くときは、下の return を書き換える。props.rows が集計済みの行（ほかのタイルの選択で絞ったもの）で、");
    if (columns.length) {
      lines.push(`  // 列は ${oneLine(columns.map((c) => c.about).join("、"))}。例:`);
      // The first thing it is by (time or a dimension) and the first measure.
      const shown = [columns.find((c) => !c.measure), columns.find((c) => c.measure)]
        .filter((c) => !!c)
        .map((c) => `{props.format(${field(c.name)}, ${JSON.stringify(c.name)})}`);
      lines.push(
        "  //   return (",
        "  //     <ul>",
        "  //       {props.rows.map((r, i) => (",
        `  //         <li key={i}>${oneLine(shown.join(" "))}</li>`,
        "  //       ))}",
        "  //     </ul>",
        "  //   );",
      );
    } else {
      lines.push("  // 列は query に書いた指標・軸・時間。");
    }
    lines.push("  // 値の書式は props.format、クリックでほかのタイルを絞るのは props.select。");
  } else {
    lines.push("  // 自分で描くときは、下の return を書き換える。データが要るときは @devbi/react の useDevbiQuery で集計する。");
  }
  lines.push(opts ? "  return <Builtin {...props} tile={{ ...props.tile, options }} />;" : "  return <Builtin {...props} />;", "}", "");
  return lines.join("\n");
}
