import { z } from "zod";
import { GRAINS, type Grain, type TileSpec } from "./types.js";

/** Names known from the project's metrics files, for a stricter schema (editor completion). */
export interface SchemaNames {
  metrics: string[];
  measures: string[];
  dimensions: string[];
  /** Dimension names and time column names: what filters and sort can refer to. */
  fields: string[];
}

const nonEmpty = <T extends string>(list: readonly T[] | undefined) => (list && list.length ? (list as [T, ...T[]]) : undefined);

/** The dash.json schemas. With `names`, names of metrics files, measures and dimensions must be known ones. */
export function dashboardSchemas(names?: SchemaNames) {
  const nameOf = (list: string[] | undefined, what: string) => {
    const known = nonEmpty(list);
    return (known ? z.enum(known) : z.string().min(1)).describe(what);
  };
  const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
  const field = nameOf(names?.fields, "軸の名前か、time の列名");
  const filter = z.union(
    [
      z.strictObject({ field, in: z.array(scalar).describe("どれかに一致する行。null は空欄に一致") }),
      z.strictObject({
        field,
        between: z.tuple([scalar, scalar]).describe("[始まり, 終わり]。始まり ≦ 値 ＜ 終わり。null の側は無制限"),
        unit: z
          .enum(GRAINS as [Grain, ...Grain[]])
          .optional()
          .describe("期間の単位（month など）。previous_period の比較は、同じ日数ではなく、この単位で 1 つ前（前の月の同じ日）"),
      }),
    ],
    { error: '絞り込みは { "field": 名前, "in": [値, …] } か { "field": 名前, "between": [始まり, 終わり] } で書いてください' },
  );
  const sort = z.union(
    [
      z.string().min(1).describe('列の名前。"-revenue" のように先頭に - で降順'),
      z.strictObject({ field: z.string().min(1).describe("列の名前"), desc: z.boolean().optional().describe("true で降順") }),
    ],
    { error: '並べ替えは "列の名前"（降順は "-列の名前"）か { "field": 列の名前, "desc": true } で書いてください' },
  );
  const query = z
    .strictObject({
      metrics: nameOf(names?.metrics, "使う指標ファイルの名前（models/<名前>.metrics.yaml）。既定はダッシュボードの metrics").optional(),
      measures: z.array(nameOf(names?.measures, "指標の名前")).optional().describe("出す指標"),
      dimensions: z.array(nameOf(names?.dimensions, "軸の名前")).optional().describe("分ける軸"),
      time: z
        .enum(GRAINS as [Grain, ...Grain[]])
        .optional()
        .describe("時間の粒度。day / week（月曜始まり）/ month / quarter / year / fiscal_year。結果の列名は time の列名"),
      filters: z.array(filter).optional().describe("このタイルだけに常にかける絞り込み"),
      sort: z.array(sort).optional().describe("並べ替え。既定は時間の順、軸と指標があれば最初の指標の大きい順"),
      limit: z.number().int().positive().optional().describe("最大の行数"),
      period: z.boolean().optional().describe("false で、期間（date-range や時間のクリックでの選択）で絞らない"),
      malloy: z
        .string()
        .min(1)
        .optional()
        .describe(
          "指標と軸の名前で言えない集計を Malloy で書く（run: sales -> { group_by: 地域; aggregate: 売上 is 金額.sum() }）。指標ファイルの名前が、その明細の行（期間と選択で絞ったもの）。measures・dimensions・time・sort・limit とは一緒に使えない",
        ),
      sql: z
        .string()
        .min(1)
        .optional()
        .describe(
          "指標と軸の名前で言えない集計を SQL（DuckDB）で書く（SELECT 地域, SUM(金額) AS 売上 FROM sales GROUP BY 1）。FROM の指標ファイルの名前が、その明細の行（期間と選択で絞ったもの）。measures・dimensions・time・sort・limit とは一緒に使えない",
        ),
    })
    .superRefine((q, ctx) => {
      if (q.malloy !== undefined && q.sql !== undefined)
        ctx.addIssue({ code: "custom", message: "malloy と sql はどちらか一つにしてください", path: ["sql"] });
      if (q.malloy === undefined && q.sql === undefined) return;
      for (const k of ["measures", "dimensions", "time", "sort", "limit"] as const) {
        if (q[k] !== undefined)
          ctx.addIssue({
            code: "custom",
            message: `${q.malloy !== undefined ? "malloy" : "sql"} のクエリでは ${k} は使えません（クエリの中に書いてください）`,
            path: [k],
          });
      }
    })
    .describe("何を出すか。指標と軸の名前で指定する。名前で言えない集計は malloy か sql で書く");
  const gridInt = z.number().int().nonnegative();
  const tile = z
    .strictObject({
      id: z.string().min(1).describe("タイルの名前。ダッシュボードの中で重複できない"),
      x: gridInt.describe("左端の列（0 から）"),
      y: gridInt.describe("上端の行（0 から）"),
      w: z.number().int().positive().describe("幅（列の数）"),
      h: z.number().int().positive().describe("高さ（行の数）"),
      title: z.string().optional().describe("タイルの見出し"),
      // Any string at load time: an unknown type is that tile's error, not the dashboard's. The editor schema lists the types.
      type: z.string().min(1).optional().describe("組み込みタイルの種類。component とどちらか一つ"),
      component: z
        .string()
        .min(1)
        .optional()
        .describe("自作タイル（dashboards/ の中の .tsx / .jsx）。dash.json からの相対パス。type とどちらか一つ"),
      query: query.optional(),
      options: z.record(z.string(), z.unknown()).optional().describe("タイルの種類ごとの設定"),
    })
    .refine((t) => !!t.type !== !!t.component, { message: "type か component のどちらか一つを書いてください" });
  const dashboard = z
    .strictObject({
      $schema: z.string().optional().describe("エディタ用の JSON Schema の場所"),
      title: z.string().optional().describe("ダッシュボードの見出し。既定はファイル名"),
      description: z.string().optional().describe("見出しの横の説明"),
      metrics: nameOf(names?.metrics, "タイルが使う指標ファイルの名前（models/<名前>.metrics.yaml）。1 つだけなら省略可").optional(),
      columns: z.number().int().positive().optional().describe("グリッドの列数。既定は 12"),
      rowHeight: z.number().int().positive().optional().describe("1 行の高さ（px）。既定は 80"),
      tiles: z.array(tile).describe("タイルの並び"),
    })
    .meta({ title: "DevBI ダッシュボード（*.dash.json）" });
  return { query, tile, dashboard };
}

const { query: queryInput, dashboard: dashboardInput } = dashboardSchemas();
export { queryInput };

export interface Dashboard {
  name: string;
  title: string;
  description?: string;
  metrics?: string;
  columns: number;
  rowHeight: number;
  tiles: TileSpec[];
}

export class DashboardError extends Error {
  constructor(
    readonly source: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(`${source}: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("\n")}`);
    this.name = "DashboardError";
  }
}

/** Check a parsed `*.dash.json`. Throws {@link DashboardError} listing every problem found. */
export function defineDashboard(data: unknown, name: string, source = `${name}.dash.json`): Dashboard {
  const parsed = dashboardInput.safeParse(data, { error: z.locales.ja().localeError });
  if (!parsed.success) {
    throw new DashboardError(
      source,
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const d = parsed.data;
  const issues: { path: string; message: string }[] = [];
  const ids = new Set<string>();
  d.tiles.forEach((t, i) => {
    if (ids.has(t.id)) issues.push({ path: `tiles.${i}.id`, message: `id が重複しています: ${t.id}` });
    ids.add(t.id);
  });
  const columns = d.columns ?? 12;
  d.tiles.forEach((t, i) => {
    if (t.x + t.w > columns) {
      issues.push({ path: `tiles.${i}`, message: `x + w が列数 ${columns} を超えています（${t.id}）` });
    }
    const hit = d.tiles.find((o, j) => j < i && t.x < o.x + o.w && o.x < t.x + t.w && t.y < o.y + o.h && o.y < t.y + t.h);
    if (hit) issues.push({ path: `tiles.${i}`, message: `タイル ${t.id} が ${hit.id} と重なっています（x, y, w, h を見直してください）` });
  });
  if (issues.length) throw new DashboardError(source, issues);
  return {
    name,
    title: d.title ?? name,
    ...(d.description ? { description: d.description } : {}),
    ...(d.metrics ? { metrics: d.metrics } : {}),
    columns,
    rowHeight: d.rowHeight ?? 80,
    tiles: d.tiles as TileSpec[],
  };
}

/** Parse a `*.dash.json` text. */
export function parseDashboardJson(jsonText: string, name: string, source = `${name}.dash.json`): Dashboard {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    throw new DashboardError(source, [{ path: "", message: `JSON として読めません: ${(e as Error).message}` }]);
  }
  return defineDashboard(data, name, source);
}

/** Validate a tile query given in code (the `query` export of a JSX tile). */
export function checkQuery(data: unknown, source: string) {
  const parsed = queryInput.safeParse(data, { error: z.locales.ja().localeError });
  if (!parsed.success) {
    throw new DashboardError(
      source,
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}

/**
 * Resolve a tile's `component` path against its dashboard file, as a path from the project root such as
 * `/dashboards/sales/TopCustomers.tsx`. A path starting with `/` is already from the project root.
 */
export function resolveComponent(dashboardPath: string, component: string): string {
  const dir = component.startsWith("/") ? "" : dashboardPath.slice(0, dashboardPath.lastIndexOf("/") + 1);
  const out: string[] = [];
  for (const p of `${dir}${component}`.split("/")) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return `/${out.join("/")}`;
}

/** Promoted tiles are bundled from `dashboards/**\/*.tsx|jsx`; anything else cannot be loaded. */
export function componentProblem(resolved: string): string | undefined {
  if (!resolved.startsWith("/dashboards/")) return "昇格したタイルは dashboards/ の中に置いてください";
  if (!/\.(tsx|jsx)$/.test(resolved)) return "昇格したタイルのファイルは .tsx か .jsx にしてください";
  return undefined;
}
