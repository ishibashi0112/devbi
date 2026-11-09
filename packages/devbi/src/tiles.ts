/**
 * The built-in tile types and their options: the contract between dash.json and `@devbi/react`.
 * Used to validate dash.json and to build its JSON Schema (editor completion).
 */
import { formatTime } from "./format.js";
import type { Grain } from "./types.js";

/** Initial periods for the `date-range` tile (`options.default`). */
export const DATE_RANGE_PRESETS = [
  "all",
  "latest_day",
  "last_7_days",
  "last_30_days",
  "latest_week",
  "latest_month",
  "previous_month",
  "latest_quarter",
  "previous_quarter",
  "last_12_months",
  "latest_year",
  "previous_year",
  "year_to_date",
  "latest_fiscal_year",
  "previous_fiscal_year",
] as const;

export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

/** The periods' names in the GUI editor, in the order of {@link DATE_RANGE_PRESETS}. */
const DATE_RANGE_LABELS = [
  "全期間",
  "最新の日",
  "直近7日",
  "直近30日",
  "最新の週",
  "最新の月",
  "前の月",
  "最新の四半期",
  "前の四半期",
  "直近12ヶ月",
  "最新の年",
  "前の年",
  "今年の累計",
  "最新の年度",
  "前の年度",
] as const;

/** A period of the `date-range` tile: its button's label and `[start, end)` (null for all). */
export interface DateRangeOption {
  key: DateRangePreset;
  label: string;
  range: [Date, Date] | null;
  /** Its calendar unit: `previous_period` compares with the one before (the same days of the previous month). */
  unit?: Grain;
  /** A button of its own (the rest are in a list of more periods, unless one is the tile's first period). */
  button: boolean;
}

const DAY = 86_400_000;
const utc = (y: number, m: number, d = 1) => new Date(Date.UTC(y, m, d));

/**
 * The `date-range` tile's periods, relative to the latest date in the data (not today), so daily or monthly updates
 * line up. The fiscal years only when the year does not start in January. `devbi-check` uses them to run a
 * dashboard's tiles in its first period, as the page opens.
 */
export function dateRangePresets(max: Date, fiscalYearStart = 1): DateRangeOption[] {
  const y = max.getUTCFullYear();
  const m = max.getUTCMonth();
  const d = max.getUTCDate();
  const day = utc(y, m, d);
  const monthStart = utc(y, m);
  const q = m - (m % 3);
  // Weeks start on Monday, as the week grain.
  const weekStart = utc(y, m, d - ((max.getUTCDay() + 6) % 7));
  const days = (n: number): [Date, Date] => [utc(y, m, d - n + 1), utc(y, m, d + 1)];
  const out: DateRangeOption[] = [
    { key: "all", label: "全期間", range: null, button: true },
    { key: "latest_day", label: formatTime(day, "day"), range: days(1), unit: "day", button: false },
    { key: "last_7_days", label: "直近7日", range: days(7), button: false },
    { key: "last_30_days", label: "直近30日", range: days(30), button: false },
    { key: "latest_week", label: formatTime(weekStart, "week"), range: [weekStart, new Date(weekStart.getTime() + 7 * DAY)], unit: "week", button: false },
    { key: "latest_month", label: formatTime(monthStart, "month"), range: [monthStart, utc(y, m + 1)], unit: "month", button: true },
    { key: "previous_month", label: formatTime(utc(y, m - 1), "month"), range: [utc(y, m - 1), monthStart], unit: "month", button: false },
    { key: "latest_quarter", label: formatTime(utc(y, q), "quarter"), range: [utc(y, q), utc(y, q + 3)], unit: "quarter", button: false },
    { key: "previous_quarter", label: formatTime(utc(y, q - 3), "quarter"), range: [utc(y, q - 3), utc(y, q)], unit: "quarter", button: false },
    { key: "last_12_months", label: "直近12ヶ月", range: [utc(y, m - 11), utc(y, m + 1)], unit: "year", button: true },
    { key: "latest_year", label: `${y}年`, range: [utc(y, 0), utc(y + 1, 0)], unit: "year", button: true },
    { key: "previous_year", label: `${y - 1}年`, range: [utc(y - 1, 0), utc(y, 0)], unit: "year", button: true },
    { key: "year_to_date", label: `${y}年累計`, range: [utc(y, 0), utc(y, m, d + 1)], unit: "year", button: true },
  ];
  if (fiscalYearStart !== 1) {
    const fs = fiscalYearStart - 1;
    const fy = m >= fs ? y : y - 1;
    out.push(
      { key: "latest_fiscal_year", label: `${fy}年度`, range: [utc(fy, fs), utc(fy + 1, fs)], unit: "fiscal_year", button: true },
      { key: "previous_fiscal_year", label: `${fy - 1}年度`, range: [utc(fy - 1, fs), utc(fy, fs)], unit: "fiscal_year", button: true },
    );
  }
  // Periods that contain the latest date end the day after it, so a comparison with
  // the previous period covers the same stretch of days (this month so far vs. the same days last month).
  const cap = utc(y, m, d + 1).getTime();
  for (const p of out) {
    if (p.range && p.range[1].getTime() > cap) p.range = [p.range[0], new Date(cap)];
  }
  return out;
}

/** One option of a tile type: a JSON Schema fragment (completion and hover text) plus what the GUI editor shows. */
export interface TileOptionSchema {
  type?: "string" | "boolean" | "number";
  enum?: readonly string[];
  /** A short name for each `enum` value, in the same order (the GUI editor, and hover text in VS Code). */
  enumLabels?: readonly string[];
  description: string;
  /** A short name for the GUI editor's property panel. */
  label: string;
  /**
   * How the GUI editor asks for a string: `text` (several lines), `field` (a dimension or the time column of the
   * tile's metrics file), `metrics` (a metrics file). Default: one line.
   */
  input?: "text" | "field" | "metrics";
}

export interface TileTypeInfo {
  /** A short name for menus (the GUI editor). */
  label: string;
  description: string;
  /** The size a new tile of this type starts at, in grid columns and rows (the GUI editor). */
  size: { w: number; h: number };
  /** Whether the tile reads data through `query` (date-range and markdown do not). */
  query: boolean;
  options: Record<string, TileOptionSchema>;
}

export const TILE_TYPES = {
  kpi: {
    label: "数字（KPI）",
    size: { w: 3, h: 2 },
    description: "大きな数字。最初の指標を大きく、残りの指標をその下に出す。比較の指標は良し悪しで色が付く（better: lower の指標は減ると良い）",
    query: true,
    options: {},
  },
  bar: {
    label: "棒グラフ",
    size: { w: 6, h: 4 },
    description: "棒グラフ。横軸は time、なければ最初の軸。2 つ目の軸か 2 つ目以降の指標は色分けの系列。棒をクリックで選択",
    query: true,
    options: {},
  },
  line: {
    label: "折れ線グラフ",
    size: { w: 6, h: 4 },
    description: "折れ線グラフ。軸の決め方は bar と同じ。点をクリックで選択",
    query: true,
    options: {},
  },
  area: {
    label: "面グラフ",
    size: { w: 6, h: 4 },
    description: "積み上げ面グラフ。軸の決め方は bar と同じ。系列は大きい順に積む",
    query: true,
    options: {},
  },
  barlist: {
    label: "ランキング",
    size: { w: 4, h: 4 },
    description: "横棒のランキング。最初の軸を最初の指標で並べる。行をクリックで選択",
    query: true,
    options: {},
  },
  table: {
    label: "表",
    size: { w: 12, h: 5 },
    description: "表。すべての列を出す。見出しで並べ替え、行をクリックでその行の軸の値を選択",
    query: true,
    options: {},
  },
  pivot: {
    label: "クロス集計",
    size: { w: 8, h: 5 },
    description: "クロス集計。1 つの項目を列に、残りの軸を行に、最初の指標をセルに。合計の行と列つき",
    query: true,
    options: {
      columns: { type: "string", label: "列にする項目", input: "field", description: "列にする項目（軸の名前か time の列名）。既定は最後の軸か時間" },
      totals: { type: "boolean", label: "合計の行と列", description: "false で合計の行と列を消す" },
    },
  },
  select: {
    label: "選択リスト",
    size: { w: 3, h: 5 },
    description: "最初の軸の値の一覧から選ぶ。9 件以上で検索欄が出る",
    query: true,
    options: {
      multiple: { type: "boolean", label: "複数選べる", description: "false で 1 つだけ選ぶ（既定は複数）" },
    },
  },
  "date-range": {
    label: "期間",
    size: { w: 12, h: 1 },
    description: "期間の選択。time の列を持つ指標ファイルのタイルを絞る（query.period が false のタイルは除く）。主な期間はボタン、ほかは「ほかの期間」から。query は書かない",
    query: false,
    options: {
      default: {
        enum: DATE_RANGE_PRESETS,
        enumLabels: DATE_RANGE_LABELS,
        label: "最初の期間",
        description: "最初に選ぶ期間。「最新」「直近」はデータの最終日が基準",
      },
      metrics: { type: "string", label: "指標ファイル", input: "metrics", description: "使う指標ファイル（ダッシュボードの metrics と違うとき）" },
    },
  },
  markdown: {
    label: "文章",
    size: { w: 12, h: 2 },
    description: "文章。**太字**、*斜体*、`コード`、[リンク](URL)、# 見出し、- 箇条書き。query は書かない",
    query: false,
    options: {
      text: { type: "string", label: "本文", input: "text", description: "本文（Markdown）" },
    },
  },
} as const satisfies Record<string, TileTypeInfo>;

export type BuiltinTileType = keyof typeof TILE_TYPES;

export const TILE_TYPE_NAMES = Object.keys(TILE_TYPES) as [BuiltinTileType, ...BuiltinTileType[]];
