# DevBI リファレンス（v0）

DevBI のファイル形式と API の一覧です。v0 なので、1.0 までに名前や形が変わることがあります。使い方の流れは [README](../README.md)、画面での確かめ方は [manual-check.md](manual-check.md) を見てください。

- [プロジェクトの形](#プロジェクトの形)
- [metrics.yaml](#metricsyaml)（指標と軸）
- [dash.json](#dashjson)（タイルの並び）
- [組み込みタイル](#組み込みタイル)
- [自作タイル（JSX）](#自作タイルjsx)
- [エディタでの補完と型（pnpm gen）](#エディタでの補完と型pnpm-gen)
- [書式](#書式)
- [@devbi/vite](#devbivite)
- [@devbi/react](#devbireact)
- [devbi（コア）](#devbiコア)
- [見た目の変更（CSS 変数）](#見た目の変更css-変数)
- [コマンド](#コマンド)

## プロジェクトの形

```
dashboards/
  <名前>.dash.json        # ダッシュボード 1 つ。URL は #/<名前>
  <名前>/Xxx.tsx          # 自作タイル（dashboards/ の中の .tsx / .jsx）
models/
  <名前>.metrics.yaml     # 指標と軸。dash.json の "metrics" で名前を指す
data/
  *.xlsx / *.csv / *.arrow / *.parquet / *.json
.devbi/                   # pnpm gen が作る（エディタの補完と TypeScript の型）。git に入れない
```

`@devbi/vite` がこの 3 つのフォルダを読み、検証してアプリに渡します。間違いがあると、ファイル名と項目つきの日本語のエラーが開発サーバーの画面に出ます。

## metrics.yaml

```yaml
# yaml-language-server: $schema=../.devbi/metrics.schema.json
label: 売上
model: SELECT * FROM read_xlsx('data/sales.xlsx', sheet = '明細')
time: { column: 受注日, fiscal_year_start: 4 }
dimensions:
  customer: { column: 顧客, label: 顧客 }
measures:
  revenue: { sql: SUM(金額), label: 売上, format: "¥#,##0" }
  revenue_yoy: { of: revenue, compare: previous_year, as: ratio }
```

### いちばん上のキー

| キー | 必須 | 中身 |
| --- | --- | --- |
| `model` | ○ | 元になる表を作る DuckDB の SQL。下の「データの読み方」を参照 |
| `measures` | ○ | 指標（集計する値）。名前 → 定義 |
| `dimensions` | | 軸（分けたり絞ったりする値）。名前 → 定義 |
| `time` | | 日付の列。期間の絞り込み、時間の粒度、前年比・累計に使う |
| `label` | | 表示名。既定はファイル名 |
| `description` | | 説明 |

名前（指標・軸）に使えるのは文字・数字・`_` で、先頭は数字以外です。日本語の名前も使えます。指標と軸で同じ名前は使えません。

### データの読み方（`model`）

| 関数 | 読むもの | 補足 |
| --- | --- | --- |
| `read_xlsx('data/x.xlsx', sheet = '明細', range = 'A3:K5000', header = true, all_varchar = false)` | Excel | DevBI が自前で読む。引数は `sheet` 以外は省略可 |
| `read_csv('data/x.csv')` / `read_csv_auto(...)` | CSV | DuckDB が読む |
| `read_arrow('data/x.arrow')` | Arrow IPC | DuckDB が読む |
| `read_parquet('data/x.parquet')` | Parquet | DuckDB の拡張が要る（[@devbi/vite](#devbivite) の `extensionRepository`） |
| `read_json(...)` / `read_ndjson(...)` | JSON | DuckDB が読む |

パスはプロジェクトからの相対パスで、ブラウザが `data/` から取りに行きます。`https://` の URL も書けます。ブラウザではワイルドカード（`*`）は使えません。`model` の中では JOIN や WHERE、列の計算など、DuckDB の SQL が自由に書けます。

Excel の読み方: 見出しは最初の空でない行（`header = false` なら見出しなしで、列名は `column1`、`column2`…）。同じ見出しが重なると `_2` を付けます。型は中身から決めます（文字・整数・数値・真偽・日付・日時）。日付はセルの表示形式（和暦の表示形式を含む）で見分けます。空の行は飛ばします。数式のセルは、Excel が最後に保存した値を使います。

### `time`

```yaml
time: 受注日                                   # 列名だけでもよい
time: { column: 受注日, label: 受注日, fiscal_year_start: 4 }
```

| キー | 中身 |
| --- | --- |
| `column` | 日付か日時の列 |
| `label` | 表示名。既定は列名 |
| `fiscal_year_start` | 年度の始まりの月（1〜12）。既定は 1。4 なら「2026年度」は 2026/4/1〜2027/3/31 |

### `dimensions`

```yaml
dimensions:
  region: 地域                                    # 列名だけ（表示名は region）
  customer: { column: 顧客, label: 顧客 }
  big: { sql: "金額 >= 100000", label: 大口 }     # 式も書ける
```

| キー | 中身 |
| --- | --- |
| `column` / `sql` | 列名か、`model` の列を使った SQL の式。どちらか一つ |
| `label` | 表示名。既定は名前 |
| `format` | 値の書式（[書式](#書式)） |
| `description` | 説明 |

### `measures`

指標には 3 種類あります。

**集計（`sql`）**

```yaml
revenue: { sql: SUM(金額), label: 売上, format: "¥#,##0" }
orders: COUNT(DISTINCT 受注番号)          # 文字列だけなら sql
avg_order: { sql: revenue / orders }      # ほかの集計の指標を名前で使える
```

- 集計関数（`SUM`、`COUNT`、`AVG`、`MIN`、`MAX`、`MEDIAN` など）を使った DuckDB の式です。
- 式の中にほかの `sql` 指標の名前を書くと、その式に置き換えて 1 本の SQL にします（`avg_order` は `(SUM(金額)) / (COUNT(DISTINCT 受注番号))`）。循環するとエラーになります。
- 集計関数の括弧の中と、`FILTER (...)`、`OVER (...)`、`WITHIN GROUP (...)` の中の名前は、指標ではなく列として扱います。指標と同じ名前の列も、そこでは列として使えます（`amount: SUM(amount)`）。
- `"金額"` のように二重引用符で囲んだ名前、`t.金額` のような修飾された名前、文字列の中は置き換えません。

**比較（`compare`）**

```yaml
revenue_yoy: { of: revenue, compare: previous_year, as: ratio }
revenue_pp:  { of: revenue, compare: previous_period, as: delta }
```

| キー | 中身 |
| --- | --- |
| `of` | 比べる `sql` 指標 |
| `compare` | `previous_year`（1 年前）か `previous_period`（直前の同じ長さの期間） |
| `as` | `value`（比較先の値）、`delta`（差）、`ratio`（比、既定）、`change`（増減率 = 比 − 1） |

- 既定の表示名は「売上 前年比」「売上 前期間差」などです。`ratio` と `change` の既定の書式は `0.0%` で、それ以外は `of` の書式を引き継ぎます。
- 値が出るのは、期間が決まっているときだけです。つまり、クエリに `time`（時間の粒度）があるか、期間の絞り込みがあるときです。全期間のままだと空（NULL、画面では「—」）になります。
- `previous_year` を時間の粒度で使うと、同じ月（同じ四半期・同じ年）の 1 年前と比べます。週は 52 週前（364 日前）です。日で比べるとき、前年の 2/29 には対応する日がないので比べません。
- `previous_period` は、時間の粒度があればその 1 つ前（前月・前四半期など）、期間の絞り込みだけなら同じ日数だけ前と比べます。

**累計（`running`）**

```yaml
revenue_cum:  { of: revenue, running: true }          # 全期間の累計
revenue_ytd:  { of: revenue, running: year }          # 1 月で戻る
revenue_fytd: { of: revenue, running: fiscal_year }   # 年度の始まりで戻る
```

時間の粒度があるクエリで、時間の順に足し上げます。軸があれば軸ごとに足します。時間の粒度がないと、`of` と同じ値になります。既定の表示名は「売上 累計」です。

比較と累計には `time` が必要です。比較と累計は `sql` 指標の式の中では使えません。

## dash.json

```json
{
  "$schema": "../.devbi/dash.schema.json",
  "title": "売上",
  "metrics": "sales",
  "tiles": [
    { "id": "monthly", "x": 0, "y": 0, "w": 8, "h": 4, "type": "bar", "title": "月別売上",
      "query": { "measures": ["revenue"], "time": "month" } },
    { "id": "top", "x": 8, "y": 0, "w": 4, "h": 4, "component": "./sales/TopCustomers.tsx" }
  ]
}
```

### いちばん上のキー

| キー | 中身 |
| --- | --- |
| `tiles` | タイルの配列（必須） |
| `title` / `description` | 見出しと説明。既定の見出しはファイル名 |
| `metrics` | タイルが使う指標ファイルの名前（`models/<名前>.metrics.yaml`）。指標ファイルが 1 つだけなら省略可 |
| `columns` | グリッドの列数。既定は 12 |
| `rowHeight` | 1 行の高さ（px）。既定は 80 |
| `$schema` | エディタの補完用（[下記](#エディタでの補完と型pnpm-gen)）。DevBI は中身を見ない |

### タイル

| キー | 中身 |
| --- | --- |
| `id` | タイルの名前。ダッシュボードの中で重複できない |
| `x`, `y`, `w`, `h` | グリッド上の位置と大きさ（列・行の数）。はみ出し（`x + w > columns`）と、ほかのタイルとの重なりはエラー |
| `type` | [組み込みタイル](#組み込みタイル)の種類。ない種類を書くと、そのタイルにエラーが出る（エディタでは波線） |
| `component` | [自作タイル](#自作タイルjsx)のファイル。dash.json からの相対パスか、`/dashboards/...` |
| `title` | タイルの見出し |
| `query` | 何を出すか（下記）。自作タイルはファイルの中に書いてもよい |
| `options` | タイルごとの設定 |

`type` か `component` のどちらか一つを書きます。

幅が 720px 以下の画面では、タイルは `y`、`x` の順に 1 列に並びます。

### `query`

| キー | 中身 |
| --- | --- |
| `measures` | 指標の名前の配列 |
| `dimensions` | 軸の名前の配列 |
| `time` | 時間の粒度。`day`、`week`（月曜始まり）、`month`、`quarter`、`year`、`fiscal_year`。結果の列名は `time` の列名 |
| `filters` | このタイルだけに常にかける絞り込み（下記） |
| `sort` | 並べ替え。`"revenue"` は昇順、`"-revenue"` は降順。`{ "field": "revenue", "desc": true }` とも書ける |
| `limit` | 最大の行数 |
| `metrics` | ダッシュボードとは別の指標ファイルを使うとき |

`measures` か `dimensions` か `time` のどれかが要ります。`sort` を書かないときは、`time` があれば時間の順、軸と指標があれば最初の指標の大きい順、軸だけなら軸の順です。`sort` を書いたときも書かないときも、同じ値の行は時間、軸の順に並べるので、どの PC でも同じ順になり、`limit` で残る行も変わりません。

絞り込み（`filters` の要素。クリックでの選択も同じ形）:

```json
{ "field": "region", "in": ["関東", "近畿", null] }
{ "field": "受注日", "between": ["2026-04-01", "2026-10-31"] }
```

- `field` は軸の名前か、`time` の列名です。
- `in` は値のどれかに一致する行です。`null` は空欄に一致します。
- `between` は「始まり ≦ 値 ＜ 終わり」で、終わりの日は含みません。どちらかを `null` にすると、その側は無制限です。

## 組み込みタイル

| `type` | 出すもの | クエリの使い方 | `options` | クリック |
| --- | --- | --- | --- | --- |
| `kpi` | 大きな数字 | 最初の指標を大きく、残りの指標をその下に。比較の指標は良し悪しで色が付く | | なし |
| `bar` | 棒グラフ | 横軸は `time`、なければ最初の軸。2 つ目の軸か 2 つ目以降の指標は色分けの系列 | | 棒でその値を選ぶ |
| `line` | 折れ線 | `bar` と同じ | | 点でその値を選ぶ |
| `area` | 積み上げ面グラフ | `bar` と同じ（系列は大きい順に積む） | | その値を選ぶ |
| `barlist` | 横棒のランキング | 最初の軸を最初の指標で | | 行でその値を選ぶ |
| `table` | 表 | すべての列。見出しで並べ替え | | 行でその行の軸の値を選ぶ |
| `pivot` | クロス集計 | 1 つの項目を列に、残りの軸を行に、最初の指標をセルに。合計の行と列つき | `columns`: 列にする項目（既定は最後の軸か時間）。`totals: false` で合計を消す | 列見出し・行で選ぶ |
| `select` | 値の一覧から選ぶ | 最初の軸の値（指標があれば値も表示）。9 件以上で検索欄が出る | `multiple: false` で 1 つだけ選ぶ | チェックで選ぶ |
| `date-range` | 期間の選択 | `query` は書かない。`time` の列が対象 | `default`: 最初の期間（下記）。`metrics`: 指標ファイル | 期間で全タイルを絞る |
| `markdown` | 文章 | `query` は書かない | `text`: 本文（`**太字**`、`*斜体*`、`` `コード` ``、`[リンク](URL)`、`#` 見出し、`-` 箇条書き） | なし |

`date-range` の期間の名前（`options.default` に書く）: `all`（全期間）、`latest_month`（最新の月）、`last_12_months`、`latest_year`、`previous_year`、`year_to_date`（今年の累計）、`latest_fiscal_year`、`previous_fiscal_year`。「最新」はデータの最終日が基準で、期間の終わりはデータの最終日で切ります。

選択は、選んだタイル以外のすべてのタイルにかかります。選んだタイル自身は絞られず、選んだもの以外が薄くなります。選択は画面上のチップで外せます。

## 自作タイル（JSX）

`dashboards/` の中に `.tsx` か `.jsx` を置き、dash.json の `component` で指します。

```tsx
import { defineQuery, type RowOf, type TileProps } from "devbi";

// 欲しいデータを宣言する（SQL は書かない）。dash.json の "query" が優先
export const query = defineQuery({ measures: ["revenue", "orders"], dimensions: ["customer"], limit: 10 });

export default function TopCustomers({ rows, format, select, selection }: TileProps<RowOf<typeof query>>) {
  return (
    <ol>
      {rows.map((r) => (
        <li key={String(r.customer)}>
          <button onClick={() => select({ field: "customer", in: [r.customer ?? null] })}>
            {format(r.customer, "customer")} {format(r.revenue, "revenue")}
          </button>
        </li>
      ))}
    </ol>
  );
}
```

- `defineQuery({...})` は、指標と軸の名前を `models/*.metrics.yaml` と照らし合わせます（[`pnpm gen`](#エディタでの補完と型pnpm-gen) のあと）。`"revenu"` と書くと、エディタに「`"revenue"` ではありませんか」と出ます。候補はすべての指標ファイルの名前をまとめたものなので、`metrics` で選んだファイルにない名前は、読み込み時にタイルのエラーになります。
- `RowOf<typeof query>` で `rows` の列に型が付きます（指標は `number | null`、軸は値、`time` を書いたときの時間の列は `Date | null`）。`r.` と打つと列の名前が補完されます。
- `import type { Query } from "devbi"` で `export const query: Query = {...}` と書いてもかまいません。その場合、名前は読み込み時にだけ検証されます。

### `TileProps`

組み込みタイルも同じものを受け取ります。`TileProps<行の型>` で `rows` の型を指定できます（既定は `Row`）。

| プロパティ | 型 | 中身 |
| --- | --- | --- |
| `rows` | `Row[]` | 集計済みの行。ほかのタイルの選択がかかった結果。キーは指標・軸・時間の名前 |
| `fields` | `FieldInfo[]` | 列の情報（`name`、`label`、`kind`: `dimension` / `time` / `measure`、`format`、`grain`、比較の指標なら `compare`） |
| `query` | `Query` | 実際に使ったクエリ |
| `selection` | `Filter[]` | このタイルが選んでいるもの（強調表示に使う） |
| `filters` | `Filter[]` | ほかのタイルから `rows` にかかっている絞り込み |
| `select` | `(f: Filter \| Filter[] \| null) => void` | このタイルの選択を決める。ほかのタイルが絞られる。`null` で解除 |
| `format` | `(value, field) => string` | 値を書式どおりの文字にする（指標の書式、時間の粒度） |
| `label` | `(field) => string` | 列の表示名 |
| `loading` | `boolean` | 集計中 |
| `error` | `Error \| null` | 集計のエラー |
| `tile` | `TileSpec` | dash.json に書いたタイル（`options` など） |

値の型（`Row` の値）: 文字、数値、真偽、`null`、`Date`（日付は UTC の 0 時）。

自作タイルで使える関数（`@devbi/react` から import）:

- `useDevbiQuery(query, { tileId?, crossfilter? })` … 追加の集計。`tileId` を渡すと、そのタイル自身の選択を除いた絞り込みがかかります。`crossfilter: false` で絞り込みなし。戻り値は `{ rows, fields, filters, loading, error }`。
- `useTileSize()` … タイルの中身の幅と高さ（px）。
- `useTimeExtent(metrics?)` … データの最初と最後の日付。

タイルの中でエラーが起きても、そのタイルにエラーが出るだけで、ほかのタイルは動き続けます。

## エディタでの補完と型（pnpm gen）

`pnpm gen`（中身は `@devbi/vite` の `devbi-gen`）が `models/*.metrics.yaml` を読んで、`.devbi/` に次の 3 つを書きます。`@devbi/vite` も、開発サーバーとビルドの開始時と、metrics.yaml を保存したときに同じものを書き直します。

| ファイル | 使い道 |
| --- | --- |
| `.devbi/dash.schema.json` | dash.json の JSON Schema。タイルの種類（説明つき）、種類ごとの `options`、`query` の指標・軸・時間の名前を補完し、間違いに波線を出す |
| `.devbi/metrics.schema.json` | metrics.yaml の JSON Schema。キーの補完と説明、`compare` / `as` / `running` などの値の候補 |
| `.devbi/env.d.ts` | TypeScript 用の名前の一覧。[`defineQuery` と `RowOf`](#自作タイルjsx) が使う |

使うための設定（`pnpm try-xlsx` が作る下書きには最初から入っていて、`.devbi/` も作り直します）:

| ファイル | 書くこと |
| --- | --- |
| dash.json | 先頭に `"$schema": "../.devbi/dash.schema.json"`。VS Code はこれだけで補完が効く |
| metrics.yaml | 1 行目に `# yaml-language-server: $schema=../.devbi/metrics.schema.json`。VS Code は拡張機能「YAML」（`redhat.vscode-yaml`）が要る。このリポジトリか examples/sales を開くとおすすめに出る |
| tsconfig.json | `"include"` に `".devbi/*.d.ts"` を足す。`".devbi"` だけだと、点で始まるフォルダは読まれない。`".devbi/env.d.ts"` とファイル名で書くと、エディタを開いたあとにできたファイルに気づかない |

- 名前の候補は、すべての指標ファイルの分をまとめたものです。そのタイルの指標ファイルにある名前かどうかは、読み込み時に検証します。
- `.devbi/` は git に入れません（手元で試す `local_*` の名前が入るため）。clone した直後は `pnpm gen` か `pnpm example:dev` で作られます。
- 読めない metrics.yaml があると、エラーを出して、その分の名前を入れずに書きます。開発サーバーで書きかけのときは、そのファイルの最後に読めた名前を残します。
- 名前の入っていない共通の JSON Schema は、パッケージの `devbi/schema/dash.schema.json` と `devbi/schema/metrics.schema.json` にもあります。

`devbi-gen [--dir <フォルダ>] [--check]`:

| オプション | 中身 |
| --- | --- |
| `--dir` | `models/` のあるフォルダ。既定は今のフォルダ |
| `--check` | 何も書かずに、古いファイルがあれば一覧を出して終了コード 1 |

読めない metrics.yaml があったときも終了コード 1 です。フォルダに `models/` がないときは、何も書かずに終了コード 2 です。

## 書式

指標と軸の `format` に書きます。Excel の表示形式の一部と同じ書き方です。

| 書き方 | 例 | 表示 |
| --- | --- | --- |
| `#,##0` | 1234567 | 1,234,567 |
| `#,##0.0` / `0.00` | 1234.5 | 1,234.5 / 1234.50 |
| `#,##0.##` | 1234.5 | 1,234.5（小数は必要なときだけ） |
| `0.0%` | 0.123 | 12.3% |
| `¥#,##0` / `#,##0"円"` | 1200 | ¥1,200 / 1,200円 |
| `#,##0,` / `#,##0,,` | 1234567 | 1,235 / 1（末尾の `,` 1 つで千、2 つで百万で割る） |
| `正;負;ゼロ` | `#,##0;▲#,##0;"なし"` | -500 → ▲500、0 → なし |
| `compact` | 123456789 | 1.2億 |
| `compact:¥:` / `compact::件` | 34000 | ¥3.4万 / 3.4万件 |

`format` がないときは、整数は桁区切り、小数は 2 桁までです。時間は粒度に合わせて「2026年5月」「2026年Q2」「2026年度」「2026/5/4週」「2026/5/1」と表示します。

## @devbi/vite

```ts
// vite.config.ts
import devbi from "@devbi/vite";
import react from "@vitejs/plugin-react";
export default { base: "./", plugins: [react(), devbi()] };
```

```tsx
// src/main.tsx
import { DevbiApp } from "@devbi/react";
import project from "virtual:devbi";
createRoot(document.getElementById("root")!).render(<DevbiApp project={project} />);
```

`devbi(options)`:

| オプション | 中身 |
| --- | --- |
| `dir` | `dashboards/`、`models/`、`data/` のあるフォルダ。Vite の root からの相対パス。既定は root |
| `extensionRepository` | DuckDB の拡張（Parquet）を取りに行く URL。社内のサーバーに置いた拡張を使うとき |

- `virtual:devbi` は、検証済みのダッシュボードと指標、自作タイル、DuckDB-wasm のファイルの URL を `<DevbiApp>` に渡す形で出します。TypeScript の型は tsconfig の `"types"` に `"@devbi/vite/client"` を足すと入ります。
- 開発サーバーでは、dash.json・metrics.yaml・data/ のファイルを保存するとページを読み込み直します。
- 開発サーバーとビルドの開始時、metrics.yaml を保存したときに `.devbi/` を書き直します（[エディタでの補完と型](#エディタでの補完と型pnpm-gen)）。
- コマンド `devbi-gen` と、同じことをする関数 `generate(dir, { check? })` も入っています。
- ビルドでは、`model` が読むデータのファイルを `dist/` にコピーします。`base: "./"` にしておくと、`dist/` をどのフォルダに置いても動きます。

## @devbi/react

| 名前 | 中身 |
| --- | --- |
| `<DevbiApp project={…} />` | アプリ全体。`#/<名前>` でダッシュボード、複数あれば一覧を出す |
| `<Dashboard project={…} name="sales" back?="#/" />` | ダッシュボード 1 つ。`project` は `loadProject()` の戻り値 |
| `loadProject(input)` | `virtual:devbi` の中身（`ProjectInput`）を検証して `Project` にする。`<DevbiApp>` は中でこれを呼ぶ |
| `useDevbiQuery`、`useTileSize`、`useTimeExtent` | [自作タイル](#自作タイルjsx)を参照 |
| `useDevbi()` | ダッシュボードの文脈（`project`、`dashboard`、`engine`、`selection`、`view(name?)`） |
| `DevbiProvider` | `<Dashboard>` の中で使っている文脈。自分でタイルを並べるとき用 |
| `createEngine({ bundle, baseUrl?, extensionRepository?, debug? })` | DuckDB-wasm を立ち上げる。`query(sql)` と `loadView(view)` を持つ。ふつうは `<DevbiApp>` が自動で作る |
| `DashboardSelection` | クロスフィルタの状態（`set`、`clear`、`own`、`filtersFor`、`entries`、`subscribe`） |
| `builtinTiles` | 組み込みタイルの一覧（`type` → コンポーネント） |
| `renderMarkdown(text)` | `markdown` タイルの描画を React の要素で返す（HTML は解釈しない） |

DuckDB-wasm のエンジンはページに 1 つで、ダッシュボードを切り替えても使い回します。同じ SQL の結果はページを開いている間キャッシュします。

## devbi（コア）

ブラウザでも Node でも動きます。テストやスクリプト、ほかのツールから使えます。

| 名前 | 中身 |
| --- | --- |
| `parseMetricsYaml(text, name)` / `defineMetricsView(obj, name)` | metrics.yaml を検証して `MetricsView` にする。間違いは `MetricsError`（`issues` に項目ごと） |
| `parseDashboardJson(text, name)` / `defineDashboard(obj, name)` | dash.json を検証する。間違いは `DashboardError` |
| `checkQuery(obj, source)` | クエリだけを検証する |
| `compileQuery(view, query, { filters?, model? })` | クエリを DuckDB の SQL にする。戻り値は `{ sql, fields }`。名前の間違いは `QueryError` |
| `compileTimeExtent(view)` | 日付の最初と最後を出す SQL |
| `readXlsx(bytes, { sheet?, range?, header?, allVarchar? })` | Excel を型つきの列で読む。戻り値は `{ sheet, rowCount, columns: [{ name, type, values }] }` |
| `listSheets(bytes)` | シートの名前 |
| `writeXlsx([{ name, rows }])` | Excel を書く（テストやサンプルデータ用） |
| `formatNumber(value, format?)` / `formatTime(date, grain?, fiscalYearStart?)` / `formatValue(value, field?)` | [書式](#書式)どおりの文字にする |
| `getMeasure(view, name)` / `getDimension(view, name)` | 名前で引く |
| `defineQuery(query)` / `RowOf<typeof query>` | 名前を検査するクエリと、その行の型（[自作タイル](#自作タイルjsx)） |
| `dashboardJsonSchema(names?)` / `metricsJsonSchema()` | dash.json と metrics.yaml の JSON Schema。`names`（`{ metrics, measures, dimensions, fields }`）を渡すと、その名前だけを許す |
| `TILE_TYPES` / `TILE_TYPE_NAMES` / `DATE_RANGE_PRESETS` | 組み込みタイルの種類（説明と `options`）、`date-range` の期間の名前 |
| 型 | `Query`、`Filter`、`Row`、`Scalar`、`FieldInfo`、`TileSpec`、`TileProps`、`Grain`、`MetricsView`、`Dashboard`、`MetricsRegistry`（`.devbi/env.d.ts` が名前を足す）など |

## 見た目の変更（CSS 変数）

次の CSS 変数を上書きすると色を変えられます。DevBI の CSS より後に読み込まれるように、同じセレクタで書いてください。

```css
.devbi-root { --devbi-accent: #0a7f6f; }
@media (prefers-color-scheme: dark) {
  .devbi-root:not([data-theme="light"]) { --devbi-accent: #4fd1c0; }
}
```

| 変数 | 使い道 | ライト / ダークの既定 |
| --- | --- | --- |
| `--devbi-bg` | ページの背景 | `#f6f7f9` / `#12151b` |
| `--devbi-card` | タイルの背景（グラフのツールチップも） | `#ffffff` / `#1b1f27` |
| `--devbi-text` | 文字 | `#1d2330` / `#e6e8ec` |
| `--devbi-muted` | 補足の文字 | `#667085` / `#98a2b3` |
| `--devbi-border` | 枠線 | `#e3e6eb` / `#2c323d` |
| `--devbi-accent` / `--devbi-accent-soft` | 強調と選択 | `#3b6fe0` / `#7c9cf5` |
| `--devbi-up` / `--devbi-down` | 前年比などの良し悪し | `#12805c`・`#c4320a` / `#4cc38a`・`#ff8a65` |
| `--devbi-radius` | タイルの角の丸み | `10px` |

自作タイルでもこの変数を使えば、ダークモードに合わせて色が変わります。

## コマンド

リポジトリのルートで実行します。

| コマンド | 中身 |
| --- | --- |
| `pnpm example:dev` | パッケージをビルドして、サンプルの開発サーバーを開く（<http://localhost:5173>） |
| `pnpm example:preview` | サンプルを静的ビルドして開く（<http://localhost:4173>） |
| `pnpm try-xlsx <Excel> [--sheet 名前] [--name local_名前] [--force]` | 手元の Excel から下書きのダッシュボードを作る。ファイルは git に入らない |
| `pnpm gen` | パッケージをビルドして、サンプルの `.devbi/`（補完と型）を作り直す。開発サーバーを動かしている間は自動 |
| `pnpm test` | 単体テスト（指標 → SQL を DuckDB で実際に流す、xlsx、書式） |
| `pnpm e2e` | サンプルを静的ビルドして、ブラウザで操作を確かめる |
| `pnpm typecheck` / `pnpm build` | 型チェック（サンプルは `.devbi/` を作ってから） / パッケージのビルド |
