/**
 * The built-in tile types and their options: the contract between dash.json and `@devbi/react`.
 * Used to validate dash.json and to build its JSON Schema (editor completion).
 */

/** Initial periods for the `date-range` tile (`options.default`). */
export const DATE_RANGE_PRESETS = [
  "all",
  "latest_month",
  "last_12_months",
  "latest_year",
  "previous_year",
  "year_to_date",
  "latest_fiscal_year",
  "previous_fiscal_year",
] as const;

export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

/** A JSON Schema fragment for one option (kept small: enough for completion and hover text). */
export interface TileOptionSchema {
  type?: "string" | "boolean" | "number";
  enum?: readonly string[];
  description: string;
}

export interface TileTypeInfo {
  description: string;
  /** Whether the tile reads data through `query` (date-range and markdown do not). */
  query: boolean;
  options: Record<string, TileOptionSchema>;
}

export const TILE_TYPES = {
  kpi: {
    description: "大きな数字。最初の指標を大きく、残りの指標をその下に出す。比較の指標は良し悪しで色が付く",
    query: true,
    options: {},
  },
  bar: {
    description: "棒グラフ。横軸は time、なければ最初の軸。2 つ目の軸か 2 つ目以降の指標は色分けの系列。棒をクリックで選択",
    query: true,
    options: {},
  },
  line: {
    description: "折れ線グラフ。軸の決め方は bar と同じ。点をクリックで選択",
    query: true,
    options: {},
  },
  area: {
    description: "積み上げ面グラフ。軸の決め方は bar と同じ。系列は大きい順に積む",
    query: true,
    options: {},
  },
  barlist: {
    description: "横棒のランキング。最初の軸を最初の指標で並べる。行をクリックで選択",
    query: true,
    options: {},
  },
  table: {
    description: "表。すべての列を出す。見出しで並べ替え、行をクリックでその行の軸の値を選択",
    query: true,
    options: {},
  },
  pivot: {
    description: "クロス集計。1 つの項目を列に、残りの軸を行に、最初の指標をセルに。合計の行と列つき",
    query: true,
    options: {
      columns: { type: "string", description: "列にする項目（軸の名前か time の列名）。既定は最後の軸か時間" },
      totals: { type: "boolean", description: "false で合計の行と列を消す" },
    },
  },
  select: {
    description: "最初の軸の値の一覧から選ぶ。9 件以上で検索欄が出る",
    query: true,
    options: {
      multiple: { type: "boolean", description: "false で 1 つだけ選ぶ（既定は複数）" },
    },
  },
  "date-range": {
    description: "期間の選択。time の列で全タイルを絞る。query は書かない",
    query: false,
    options: {
      default: {
        enum: DATE_RANGE_PRESETS,
        description: "最初に選ぶ期間。「最新」はデータの最終日が基準",
      },
      metrics: { type: "string", description: "使う指標ファイル（ダッシュボードの metrics と違うとき）" },
    },
  },
  markdown: {
    description: "文章。**太字**、*斜体*、`コード`、[リンク](URL)、# 見出し、- 箇条書き。query は書かない",
    query: false,
    options: {
      text: { type: "string", description: "本文（Markdown）" },
    },
  },
} as const satisfies Record<string, TileTypeInfo>;

export type BuiltinTileType = keyof typeof TILE_TYPES;

export const TILE_TYPE_NAMES = Object.keys(TILE_TYPES) as [BuiltinTileType, ...BuiltinTileType[]];
