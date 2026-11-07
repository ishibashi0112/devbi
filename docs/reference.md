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
- [データベースから読む（@devbi/server）](#データベースから読むdevbiserver)
- [ほかのアプリの画面に埋め込む](#ほかのアプリの画面に埋め込む)
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
api/
  <名前>.sql              # read_api('<名前>') でデータベースから読む SELECT。サーバーだけが使う（ビルドに入らず、開発サーバーもブラウザに渡さない）
dist/snapshots/           # 毎朝のスナップショット（devbi-serve / devbi-snapshot が作る。git に入れない）
.env                      # API の接続先（DEVBI_DB=...）。パスワードを含む本物の接続先は .env.local に書き、git に入れない
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
| `read_api('orders', from = '2025-04-01')` | データベース | サーバーの `api/orders.sql` の結果を API から受け取る。[データベースから読む](#データベースから読むdevbiserver) |

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
| `table` | 表（[spreadsheet-grid](https://github.com/ishibashi0112/datasheet-grid)、読み取り専用） | すべての列。列の見出しの ⋮ で並べ替えと列幅の調整。セルを選んで Ctrl+C（Mac は ⌘+C）で、表示どおりの文字でコピーし、Excel に貼れる | | 行のクリック（またはセルで Enter かスペース）で、その行の軸と時間の値を選ぶ。もう一度で解除。Shift・⌘・Ctrl を押したままのクリックは、コピーする範囲を広げるだけ |
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
| `embed` | `true` で、ビルドのときに `devbi-embed.js` も作る（[ほかのアプリの画面に埋め込む](#ほかのアプリの画面に埋め込む)）。`base` は `"./"` にしておく（`/` で始まると警告）。既定は `false` |

- `virtual:devbi` は、検証済みのダッシュボードと指標、自作タイル、DuckDB-wasm のファイルの URL を `<DevbiApp>` に渡す形で出します。TypeScript の型は tsconfig の `"types"` に `"@devbi/vite/client"` を足すと入ります。
- 開発サーバーでは、dash.json・metrics.yaml・data/ のファイルを保存するとページを読み込み直します。
- 開発サーバーとビルドの開始時、metrics.yaml を保存したときに `.devbi/` を書き直します（[エディタでの補完と型](#エディタでの補完と型pnpm-gen)）。
- コマンド `devbi-gen` と、同じことをする関数 `generate(dir, { check? })` も入っています。
- ビルドでは、`model` が読むデータのファイルを `dist/` にコピーします。`base: "./"` にしておくと、`dist/` をどのフォルダに置いても動きます。`api/` の SQL はコピーしません。
- `api/` があると、開発サーバーと `vite preview` に読み取り API を付けます（[データベースから読む](#データベースから読むdevbiserver)）。`api/` は起動したときにあるかを見るので、あとから作ったときは起動し直します。接続先は環境変数か、Vite のやり方で読む `.env` ファイル（Vite の `envDir`、ふつうは root の `.env`、`.env.local`、`.env.[mode]`）の `DEVBI_DB…` から読みます。
- `api/` の SQL の先頭の `-- snapshot:` の行を読み、どの SQL を[スナップショット](#毎朝のスナップショット)から読むかを `virtual:devbi` に入れます（SQL の中身は入れません）。開発サーバーと `vite preview` は、スナップショットのファイルを保存せず、聞かれるたびにデータベースから読んで返します。
- 開発サーバーは、`api/` の SQL と SQLite のファイル（`*.sqlite`、`*.sqlite3`、`*.db` と、`DEVBI_DB…` の `sqlite:` が指すファイル）をブラウザに渡しません（Vite の `server.fs.deny` に足します。`.env` は Vite がもとから渡しません）。

## データベースから読む（@devbi/server）

データベースの表は、サーバーに置いた SQL ファイルを通して読みます。ブラウザは SQL を送らず、名前とパラメーターだけを送ります。

```
api/orders.sql（サーバー）  ──  SELECT を読み取り専用で実行  ──▶  Arrow で返す
        ▲                                                          │
read_api('orders', from = '2024-04-01')（metrics.yaml の model）  ◀──┘  ブラウザの DuckDB-wasm が集計
```

1 つのダッシュボードを開くと、`read_api` 1 つにつき 1 回だけ API を呼びます。そのあとの絞り込みや並べ替えは、ブラウザの中で集計し直します。

開くたびにデータベースへ行かず、毎朝決まった時刻に作ったものを読ませることもできます（[毎朝のスナップショット](#毎朝のスナップショット)）。

### `api/<名前>.sql`

```sql
-- 受注の明細（1 行 = 受注の 1 明細）。受注日が :from 以降のもの。
SELECT o.order_date AS 受注日, c.name AS 顧客, c.region AS 地域, l.qty * l.unit_price AS 金額
  FROM orders o
  JOIN order_lines l ON l.order_no = o.order_no
  JOIN customers c ON c.id = o.customer_id
 WHERE o.order_date >= :from
```

- 1 つのファイルに書けるのは、`SELECT` か `WITH` で始まる文 1 つだけです。最後の `;` はあってもなくてもかまいません。
- `INSERT`、`UPDATE`、`DELETE`、`SELECT ... INTO`、`FOR UPDATE` など、書き込みやロックにつながる言葉があると実行しません。同じ名前の列は `"update"` のように引用符で囲みます。
- `:名前` がパラメーターです。値は `read_api` の引数から来ます。同じ名前は何度でも使えます。大文字と小文字は区別しません。PostgreSQL の `::date` はパラメーターになりません。
- SELECT のすぐ上のコメントは、説明として `api/schema` に出ます。
- ファイルの先頭の `--` のコメントの中に `-- connection: erp` の行を書くと、接続先を `DEVBI_DB_ERP` にします（SELECT より前に書きます。間に空の行があってもかまいません）。
- 同じところに `-- snapshot: 06:00` の行を書くと、[スナップショット](#毎朝のスナップショット)から読むようになります。
- 引用符などの読み方は、接続先のデータベースに合わせます（SQLite と SQL Server の `[列名]`、PostgreSQL の `$$ … $$`）。
- ファイルを保存すると、開発サーバーではページを読み込み直します。`devbi-serve` は呼ばれるたびにファイルを読むので、止めなくても反映されます。

### `read_api`

```yaml
model: SELECT * FROM read_api('orders', from = '2024-04-01')
```

- 最初の引数は `api/` のファイル名（`.sql` なし）です。
- パラメーターは `名前 = 値` の形で書きます。値に書けるのは文字（`'…'`）、数値、`true` / `false`、`null` だけです。SQL のすべてのパラメーターに値が要ります。
- `read_api` の結果は、ほかの `read_*` と同じように `model` の SQL の中で表として使えます（JOIN、WHERE、`CAST` など）。
- ビルドの時に、`api/<名前>.sql` があるかを確かめます。

### 接続先

接続先の URL は環境変数に書きます。`devbi-serve` は、プロジェクトのフォルダ（`--dir`）の `.env` と `.env.local` も読みます（`.env.local` が優先、すでにある環境変数がさらに優先）。開発サーバーは Vite のやり方で `.env` ファイルを読みます（[@devbi/vite](#devbivite)）。ふつうはどちらも同じフォルダです。

| 変数 | 使うファイル |
| --- | --- |
| `DEVBI_DB` | ふつうの `api/*.sql` |
| `DEVBI_DB_<名前>` | `-- connection: <名前>` と書いた `api/*.sql`（名前は大文字、英数字以外は `_`） |

| データベース | URL の例 | 補足 |
| --- | --- | --- |
| SQLite | `sqlite:db/sales.sqlite` | 相対パスはプロジェクトのフォルダから。読み取り専用で開く。Node 22.16 以上。時間の上限はなく、重い SQL のあいだはほかのリクエストも待つ（手元や小さいデータ向け） |
| PostgreSQL | `postgres://user:pass@host:5432/db` | `pg` を入れる（`npm install pg`）。毎回 `BEGIN READ ONLY` の中で実行し、60 秒で打ち切る。日付はデータベースの `DateStyle` によらず読める |

- データベースのユーザーは SELECT の権限だけにしてください。上の確認は最初の守りで、最後の守りではありません。
- パスワードに `@` や `:` が入るときは、`%40`、`%3A` のように書きます。
- PostgreSQL の `timestamptz` は、接続のタイムゾーンでの時刻になります。変えるときは URL に `?options=-c%20TimeZone%3DAsia%2FTokyo` を足します。

列の型は次のように受け取ります。

| データベースの型 | DuckDB での型 |
| --- | --- |
| 整数 | `BIGINT` |
| 小数（`numeric`、`real`、`double` など） | `DOUBLE` |
| 真偽 | `BOOLEAN` |
| 日付 | `DATE` |
| 日時（`timestamp`、`timestamptz`） | `TIMESTAMP`（ミリ秒まで。データベースでの時刻のまま、時差は付けない） |
| そのほか（文字、`json` など） | `VARCHAR` |

SQLite は値と、表の列の宣言（`INTEGER`、`REAL`、`TEXT`、`DATE`、`DATETIME`、`BOOLEAN` など）から型を決めます。

- `DATE` / `DATETIME` の列の文字は、日付・日時として読みます。`Z` や `+09:00` が付いていても、書いてある時刻のままにします。
- 結果が 0 行のときや、列が全部 NULL のときは、宣言の型になります。
- `l.qty * l.unit_price` や `SUM(...)` などの計算した列には宣言がないので、中身から決めます。0 行や全部 NULL で決まらないときは DuckDB の `NULL` 型になります。`SUM()` も比較もそのまま通るので、タイルはエラーにならず空になります。
- パラメーターの整数は整数として渡します（`TEXT` の列に `code = :code` で `10` を渡すと、SQL に `code = 10` と書いたときと同じく `'10'` に当たります）。

### 毎朝のスナップショット

重い集計や、日に 1 回の更新で足りるデータは、決まった時刻に作ったものを読ませます。開くたびにデータベースへは行きません。

```sql
-- 日・地域・商品分類ごとの売上。受注日が :from 以降のもの。
-- snapshot: 06:00
SELECT o.order_date AS 受注日, c.region AS 地域, SUM(l.qty * l.unit_price) AS 金額
  FROM …
 WHERE o.order_date >= :from
 GROUP BY o.order_date, c.region
```

- `api/<名前>.sql` の先頭のコメントに `-- snapshot: 06:00` と書きます。時刻はサーバーの時計で、`-- snapshot: 06:00, 12:00` のように何回でも書けます。
- metrics.yaml の書き方は変わりません（`read_api('sales_daily', from = '2024-04-01')`）。
- 作るのは、`models/` の `read_api` で使っているものだけです。パラメーターは `read_api` に書いた値で、値の組ごとに 1 つ作ります。
- 中身は API の答えと同じ Arrow で、サイトの `snapshots/` に `<名前>.arrows`（パラメーターがあれば `<名前>~<16 桁>.arrows`。[ファイル名の決め方](#api-の形)）として置きます。
- ブラウザは API ではなくこのファイルを読みます。ダッシュボードの見出しの下に「データは 11月8日 6:00 の時点（毎日 6:00 に更新）」と出し、一覧には「毎日 6:00 の時点のデータ」と出します。
- どの SQL をファイルから読むかは、ビルドしたときに決まります。`-- snapshot:` の行を足したり消したり、`read_api` のパラメーターを変えたりしたら、ビルドし直します。
- ファイルがないとき（`404`）は、API から読みます（そのときは「…の時点」は出しません）。API もないときは、タイルに「スナップショット（snapshots/…）がありません。サーバーで devbi-snapshot を実行するか…」と出ます。

作るのは次のどれかです。

- **`devbi-serve`**: 起動したときに、ないものと、最後の時刻より古いものを作ります。そのあとは毎日その時刻に作り直します。まだないファイルを聞かれたときは、その場で作ってから返します。
- **`devbi-snapshot`**: いま作ります。`devbi-serve` を使わず、IIS などにサイトを置くときに、Windows のタスクスケジューラ（または cron）から毎朝動かします。
- **開発サーバー**: ファイルは作らず、聞かれるたびにデータベースから読みます。

```sh
npx devbi-snapshot --dir C:\reports\sales --out C:\inetpub\wwwroot\sales
```

| オプション | 中身 |
| --- | --- |
| `--dir` | プロジェクトのフォルダ（`api/`、`models/`、`.env` のある場所）。既定は今のフォルダ |
| `--out` | サイトのフォルダ。`<out>/snapshots/` に置く。既定は `<dir>/dist`（`@devbi/vite` の `dir` を変えたときは、ビルドの中のそのフォルダ） |
| `--max-rows` / `--timeout` / `--debug` | `devbi-serve` と同じ |
| `<名前>…` | その SQL のものだけ作る（`devbi-snapshot sales_daily`）。書かなければ全部 |

- 作れなかったものがあると、終了コードが 1 になります。前のファイルはそのまま残ります（新しいファイルは、書き終わってから置き換えます）。くわしい理由はログに出ます。
- IIS では `.arrows` も配れるように、`web.config` の `<staticContent>` に `<mimeMap fileExtension=".arrows" mimeType="application/vnd.apache.arrow.stream" />` を足します（[サーバーの設定](#5-サーバーの設定)）。
- `pnpm build` は `dist/` を作り直すので、`snapshots/` も消えます。`devbi-serve` は次に聞かれたときに作り直します。静的に置くときは、ビルドしたあとに `devbi-snapshot` を動かします。

### `devbi-serve`

ビルドしたサイト（`dist/`）と API を、1 つのプロセスで出します。社内のサーバーで動かすときの形です。

```sh
pnpm build                  # dist/ を作る
npx devbi-serve --dir .     # http://127.0.0.1:8080/
```

| オプション | 中身 |
| --- | --- |
| `--dir` | プロジェクトのフォルダ（`api/` と `.env` のある場所）。既定は今のフォルダ |
| `--static` | 出すサイトのフォルダ。既定は `<dir>/dist` |
| `--port` / `--host` | 既定は `8080` / `127.0.0.1`（このコンピューターからだけ） |
| `--allowed-hosts` | IP アドレスと `localhost` のほかに、ブラウザが使ってよいホスト名（カンマ区切り）。`.corp.local` はその下の名前すべて、`all` はどれでも。IIS などから転送するときは、利用者が開く名前（`reports.corp.local` など）を書く |
| `--max-rows` | 1 回に返す行の上限。既定は 1,000,000。超えると日本語のエラー |
| `--timeout` | 1 回の SQL の時間の上限（秒）。既定は 60（PostgreSQL） |
| `--debug` | データベースのエラーをそのままブラウザに返す。ふつうは「サーバーのログを見てください」とだけ返し、くわしい内容はログに書く |

- 社内の人に見せるときは、IIS などを前に置いて Windows 認証をかけ、`devbi-serve` には IIS から転送します。`devbi-serve` 自身はログインの仕組みを持ちません。
- API はパスの最後が `/api/schema`、`/api/query`、`/snapshots/<ファイル>.arrows` のリクエストに答えます。前に何が付いていてもかまわないので、`/reports/` の下に転送しても動きます。
- [スナップショット](#毎朝のスナップショット)を、決まった時刻に `<static>/snapshots/` に作ります。
- 知らないホスト名で来たリクエストは `403` で断ります。ほかのサイトが自分の名前をこのコンピューターに向けて（DNS リバインディング）、ブラウザから API を読むのを防ぐためです。`--host 0.0.0.0` で社内に出すときも、名前で開くなら `--allowed-hosts` にその名前を書きます。
- `dist/assets/` のファイルは長くキャッシュさせ、ほかは毎回確かめさせます。Parquet などの部分読み（Range）にも答えます。
- 開発サーバー（`vite`）と `vite preview` にも、`@devbi/vite` が同じ API を付けます。こちらはデータベースのエラーをそのまま出します。

### API の形

ほかの言語のサーバー（ASP.NET など）で同じ API を作るときの決まりです。

`GET <場所>/api/schema`

```json
{
  "datasets": [
    { "name": "orders", "description": "受注の明細…", "params": ["from"], "connection": "DEVBI_DB" },
    { "name": "sales_daily", "description": "…", "params": ["from"], "connection": "DEVBI_DB", "snapshot": ["06:00"] }
  ],
  "snapshots": [
    { "file": "sales_daily~9e979dd94c517434.arrows", "name": "sales_daily", "params": { "from": "2024-04-01" },
      "times": ["06:00"], "models": ["sales_daily"], "updatedAt": "2026-11-08T21:00:00.000Z" }
  ]
}
```

`snapshots` は、作るスナップショットと、最後に作った時刻（まだなければ `null`）です。作れなかったときは `error` も付きます。

`POST <場所>/api/query`（`Content-Type: application/json`）

```json
{ "name": "orders", "params": { "from": "2024-04-01" } }
```

- 成功: `200`、`Content-Type: application/vnd.apache.arrow.stream`（Arrow IPC のストリーム）。8 KB を超えて `Accept-Encoding: gzip` なら gzip で返す。行数は `X-DevBI-Rows` ヘッダー。
- 失敗: `{ "error": "日本語のメッセージ" }` と、`400`（パラメーターや SQL の決まり違反）、`404`（その名前の SQL がない）、`405`、`413`、`415`（JSON 以外）、`422`（行が多すぎる）、`500`（データベースのエラー、接続先がない）。ブラウザはこのメッセージをタイルに出します。
- `Content-Type: application/json` 以外は受け付けません。ほかのサイトのページから、ブラウザに確かめさせずに送ることができないようにするためです。

`GET <サイト>/snapshots/<ファイル>.arrows`

- スナップショットのファイルです。ふつうの静的ファイルとして置けば足ります（API のサーバーでなくてよい）。ブラウザは `Last-Modified` を「何時点のデータか」として出します。
- ブラウザは毎回確かめに来ます（`Cache-Control: no-cache` と同じ。変わっていなければ `304` で足ります）。
- `404` のときは、ブラウザは `POST …/api/query` で読みます。
- `devbi-serve` では、まだなければ作ってから返し、`If-Modified-Since` に `304` で答えます。`models/` の `read_api` で使っていないものは `404` です。作れなかったときは、API と同じ `{ "error": … }` と、SQL の失敗なら同じ状態コード（行が多すぎれば `422`）を返します。
- ファイル名は、`read_api` の名前とパラメーターから決めます。パラメーターがなければ `<名前>.arrows` です。あれば、引数の名前（小文字）を UTF-16 の順（JavaScript の `sort()`、C# の `StringComparer.Ordinal`）で並べた `[[名前, 値], …]` を JavaScript の `JSON.stringify` で書いた文字列（空白なし、日本語はそのまま）の UTF-8 に、FNV-1a（64 ビット）をかけた値を 16 桁の小文字の 16 進数にして、`<名前>~<16 桁>.arrows` とします。値は文字・数値・`true` / `false`・`null` で、数値は JavaScript の書き方です。`read_api('orders', from = '2024-04-01')` は `[["from","2024-04-01"]]` から `orders~9e979dd94c517434.arrows` になり、`read_api('売上', 地域 = '関東', n = 1.5, all = true, none = null)` は `[["all",true],["n",1.5],["none",null],["地域","関東"]]` から `売上~ada27a0b5a13b1c4.arrows` になります（devbi の `snapshotFile(name, params)`）。

`createApiHandler({ dir, env?, maxRows?, timeoutMs?, exposeErrors?, log?, snapshotDir? })` は、この API を Node の `http` のハンドラーとして返します（`handle(req, res)` が `false` なら API 以外のリクエスト）。`run(name, params)` で SQL を 1 つ実行し、`snapshots`（`make`、`catchUp`、`schedule`、`status` など）でスナップショットを扱えます。`snapshotDir` がなければ、スナップショットは聞かれるたびに作って保存しません。ホスト名の確認はしないので、自分のサーバーに組み込むときはそちらで確かめます（`isHostAllowed(req.headers.host, allowedHosts)` が使えます）。`serve(options)` は `devbi-serve` の中身で、`allowedHosts` も受け取ります。

## ほかのアプリの画面に埋め込む

ダッシュボードを、社内の既存のアプリ（ASP.NET の WebForms や MVC、ほかの React のアプリなど）の画面の中に出せます。要るのは、ビルドでできる `devbi-embed.js` と、画面に足す 2 行だけです。

### 1. ビルドで `devbi-embed.js` を作る

```ts
// vite.config.ts
export default { base: "./", plugins: [react(), devbi({ embed: true })] };
```

- `pnpm build` で、`dist/` に `devbi-embed.js` ができます。名前は毎回同じです。
- `dist/` を丸ごと、アプリから配れる場所（例: `/Scripts/devbi/`）に置きます。
- データ（`data/`）、エンジン（`assets/`）、API は、`devbi-embed.js` のある場所を基準に探します。
- `base` は `"./"` にします。書かないとき（Vite の既定の `"/"`）や、`base: "/reports/"` のように `/` で始めたときは、サイトを同じサーバーのその場所に置いたページからしか動かないので、ビルドで警告を出します。`https://…` で始まる URL ならどこからでも動きます。
- ほかに、ビルドで警告を出すもの: `build.cssCodeSplit: false`（表の CSS が埋め込みに付かない）、`preserveEntrySignatures: false`（`"exports-only"` に直す）。入口（`build.rolldownOptions.input`）に `devbi-embed` という名前があるとエラーです。
- 開発サーバー（`pnpm dev`）では作られません。試すときは、ビルドして `devbi-serve` か `vite preview` で開きます。サンプルの `examples/sales/public/embed-demo.html` がその例です。

### 2. 画面に 2 行を足す

```html
<div data-devbi="sales" data-devbi-theme="light"></div>
<script type="module" src="/Scripts/devbi/devbi-embed.js"></script>
```

| 属性 | 中身 |
| --- | --- |
| `data-devbi` | ダッシュボードの名前（`dashboards/<名前>.dash.json`）。ダッシュボードが 1 つだけなら空でよい |
| `data-devbi-theme` | `light`、`dark`、`auto`（既定。OS の設定に合わせる）。明るい画面に置くときは `light` |
| `data-devbi-api` | 読み取り API の場所（`read_api` を使うとき）。既定は `devbi-embed.js` と同じ場所の `api/`。アプリに API を足したときは、その場所（例: `/MyApp/devbi/api/`）。相対パス（`api2/`）は、ページではなく `devbi-embed.js` のある場所からです。ページとも `devbi-embed.js` とも違うサーバーは使いません（要るときは JavaScript の `mount` に `apiUrl` で渡します） |

- `<script type="module">` は、ページを読み終わってから動きます。`<head>` に書いても、div より前に書いてもかまいません。
- 1 つのページに、いくつでも置けます。DuckDB のエンジンは `devbi-embed.js` 1 本につき 1 つで、API の場所が違うダッシュボードも同じエンジンを使います。
- 幅は置いた場所いっぱいです。高さはタイルの並びで決まり、スクロールはページのものです。置いた場所の幅が 720px より狭いと、スマートフォンと同じようにタイルを 1 列に並べます（画面の幅ではなく、ダッシュボードの幅で決めます）。
- ページの CSS のうち、要素の名前だけの指定（`h1 { … }`、`td { … }`、`ul { … }`、`button { … }` など）は、ダッシュボードの中ではブラウザの既定に戻します。文字の揃えや字間など、ページから引き継ぐ指定も戻します。ページの CSS が `@layer` の中にあれば、どれだけ強くても戻します。
- 戻せないもの: ID・クラス・属性・疑似クラスの付いた指定（`#main td { … }`、`.content h2 { … }`、`tr:nth-child(odd) td { … }`、`a:link { … }`）は DevBI の打ち消しより強いので、ダッシュボードの中にも届きます。そのときはページの CSS の側で、`:not([data-devbi] *)` を付けるなどして `[data-devbi]` の中を外してください。`div`、`span`、`svg`、`img` への指定も戻しません。
- 埋め込むダッシュボードの自作タイルの CSS を `@layer` に入れると（Tailwind など）、`div` と `span` 以外の要素への指定は、同じ理由で戻されます。DevBI のアプリ（`<DevbiApp>`）の中では戻しません。
- 同じページに、ほかのプロジェクトの `devbi-embed.js` があってもかまいません。それぞれ自分の持っているダッシュボードだけを出し、どれも持っていない名前のときだけ「ダッシュボード … がありません」を出します。同じ `devbi-embed.js` を 2 回読み込んでも（URL の `?v=…` 違いなど）、出したものはそのままです。

### 3. JavaScript から使う

```html
<script type="module">
  import { dashboards, mount } from "/Scripts/devbi/devbi-embed.js";
  mount("#report", { dashboard: "sales" });
</script>
```

同じものが `window.DevBI` にも入ります。`devbi-embed.js` が動き始めると（`window.DevBI` ができると）、`window` に `devbi:ready` イベントが出ます。ダッシュボードのデータを読み終わったという意味ではありません。あとから動くスクリプトでは、先に `window.DevBI` があるかを見てください。

| 名前 | 中身 |
| --- | --- |
| `dashboards` | ダッシュボードの一覧（`name`、`title`、`description`）。画面のメニューを作るとき |
| `mount(要素かセレクタ, { dashboard?, theme?, apiUrl?, fetch?, isolate? })` | ダッシュボードを出す。書かなかったものは要素の `data-devbi…` 属性から取る。`isolate: false` で、ページの CSS を打ち消さない（既定は `true`）。同じ要素にもう一度呼ぶと切り替わる（ダッシュボード・API・`fetch` が変わると最初から、`theme` だけなら絞り込みはそのまま）。戻り値の `unmount()` は、そのあと同じ要素に `mount` し直していたら何もしない。`fetch` は API を呼ぶときに使う関数（ヘッダーを足すとき） |
| `mountAll(root?)` | `data-devbi` の付いた要素のうち、まだ出していないものに出す。ページから消えた要素のものは片付ける。`unmount` で消した要素には出さない。ページにほかのプロジェクトの `devbi-embed.js` があれば、そちらのダッシュボードもそちらが出す。戻り値は新しく出した数 |
| `unmount(要素かセレクタ)` | ダッシュボードを消す（ページのどの `devbi-embed.js` が出したものでも）。もう一度出すときは `mount` |

ASP.NET の UpdatePanel のように画面の一部を入れ替えるページでは、入れ替えのあとに `mountAll()` を呼びます。

```js
Sys.WebForms.PageRequestManager.getInstance().add_endRequest(() => window.DevBI?.mountAll());
```

### 4. API とログイン

- `read_api` を使うダッシュボードには、読み取り API が要ります。`devbi-serve` を同じサーバーで動かすか、アプリに同じ形の API（[API の形](#api-の形)）を足して、`data-devbi-api` でその場所を指します。
- アプリのログイン（Cookie、Windows 認証）は、同じオリジンならそのまま API に届きます。
- CSRF のトークンなど、ヘッダーが要るときは `mount` の `fetch` で足します。

```js
mount("#report", { dashboard: "sales", fetch: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, "X-CSRF-Token": token } }) });
```

### 5. サーバーの設定

- `dist/` は、ページと同じオリジン（スキーム・ホスト・ポートが同じ）から配るのがかんたんです。ほかのオリジンから配るときは、そのサーバーがすべてのファイルに CORS のヘッダー（`Access-Control-Allow-Origin`）を付ける必要があります。API がほかのオリジンにあるときは、API にも CORS が要り、Cookie は送られません。
- IIS は `.wasm` を配らないことがあります。`dist/` に `web.config` を置いて足します（`.arrows` は[スナップショット](#毎朝のスナップショット)のファイル）。

```xml
<configuration>
  <system.webServer>
    <staticContent>
      <remove fileExtension=".wasm" />
      <mimeMap fileExtension=".wasm" mimeType="application/wasm" />
      <remove fileExtension=".arrows" />
      <mimeMap fileExtension=".arrows" mimeType="application/vnd.apache.arrow.stream" />
    </staticContent>
  </system.webServer>
</configuration>
```

- ページに Content Security Policy があるときは、次を許します: `script-src` に DevBI の場所と `'wasm-unsafe-eval'`（DuckDB の WebAssembly）、`style-src` に `'unsafe-inline'`（DevBI とグラフが `<style>` を足す）、`worker-src` に DevBI の場所（ほかのオリジンから配るときは `blob:`）、`connect-src` に DevBI の場所と API の場所。

### 色を変える

[CSS 変数](#見た目の変更css-変数)は、ページの CSS に書きます（`devbi-embed.js` は、DevBI のアプリの `app.css` などを読みません）。DevBI の CSS はページの `<head>` のいちばん前に入るので、同じセレクタで書けばページの CSS が勝ちます。

### React のアプリに置く

DevBI の Vite プラグインを入れた React 19 のアプリでは、部品として置けます。`project` は 1 回だけ作って、毎回同じものを渡します（別のものを渡すと、ダッシュボードが最初からになります）。アプリの CSS を打ち消すときは `isolate` を付けます。

```tsx
import { Dashboard, loadProject } from "@devbi/react";
import input from "virtual:devbi";
const project = loadProject(input);
// …
<Dashboard project={project} name="sales" theme="light" isolate />
```

ほかの React のアプリ（Vite でない、React 18 など）では、`devbi-embed.js` を使います。DevBI は自分の React で動くので、アプリの React の版は関係ありません。URL は変数にして `import()` に渡します（文字列をそのまま書くと、TypeScript やバンドラーがそのファイルを探しに行きます）。

```tsx
const DEVBI = "/Scripts/devbi/devbi-embed.js";

function DevbiDashboard({ name }: { name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    let unmount = () => {};
    import(/* @vite-ignore */ /* webpackIgnore: true */ DEVBI).then((devbi) => {
      if (alive && ref.current) unmount = devbi.mount(ref.current, { dashboard: name, theme: "light" }).unmount;
    });
    return () => {
      alive = false;
      unmount();
    };
  }, [name]);
  return <div ref={ref} />;
}
```

## @devbi/react

| 名前 | 中身 |
| --- | --- |
| `<DevbiApp project={…} theme? />` | アプリ全体。`#/<名前>` でダッシュボード、複数あれば一覧を出す |
| `<Dashboard project={…} name="sales" back?="#/" theme? isolate? />` | ダッシュボード 1 つ。`project` は `loadProject()` の戻り値で、毎回同じものを渡す（別のものだと最初から）。`theme` は `"auto"`（既定。OS の設定）、`"light"`、`"dark"`。`isolate` で、ページの CSS の要素の名前だけの指定を打ち消す（[埋め込み](#2-画面に-2-行を足す)と同じ）。幅が 720px より狭いとタイルを 1 列に並べる |
| `mountDashboard(要素, project, { dashboard?, theme?, apiUrl?, fetch?, isolate? })` / `unmountDashboard(要素)` | React を使っていないページの要素に、ダッシュボードを出す / 消す。`devbi-embed.js` の `mount` の中身 |
| `startEmbed(input, { auto?, global? })` | `devbi-embed.js` の中身。`data-devbi` の要素に出し（`auto: false` で出さない）、`window.DevBI` を作って `devbi:ready` を出す（`global: false` でしない）。ふつうは `@devbi/vite` の `embed` が使う |
| `loadProject(input)` | `virtual:devbi` の中身（`ProjectInput`）を検証して `Project` にする。`<DevbiApp>` は中でこれを呼ぶ。`ProjectInput.snapshots` は、`-- snapshot:` の行がある SQL の名前と時刻（`@devbi/vite` が入れる） |
| `snapshotTimesOf(project, dashboard)` | そのダッシュボードが読むスナップショットの時刻（`["06:00"]` など。なければ空）。一覧の「毎日 6:00 の時点のデータ」に使っている |
| `useDevbiQuery`、`useTileSize`、`useTimeExtent` | [自作タイル](#自作タイルjsx)を参照 |
| `useDevbi()` | ダッシュボードの文脈（`project`、`dashboard`、`engine`、`selection`、`view(name?)`） |
| `DevbiProvider` | `<Dashboard>` の中で使っている文脈。自分でタイルを並べるとき用 |
| `createEngine({ bundle, baseUrl?, apiUrl?, fetch?, snapshots?, extensionRepository?, debug? })` | DuckDB-wasm を立ち上げる。`apiUrl` は `read_api` の API の場所（既定は `baseUrl` の下の `api/`。最後の `/` はなくてもよい）、`fetch` は API を呼ぶときに使う関数（ヘッダーを足すときなど）。`query(sql)` と `loadView(view, { apiUrl?, fetch? })` を持つ（`loadView` に渡すと、そのビューだけほかの API から読む。同じエンジンで、API ごとに別の表になる。`useDevbi().engine` の `loadView(view)` は、そのダッシュボードの API と `fetch` で読む）。`snapshots` は[スナップショット](#毎朝のスナップショット)から読む SQL の名前と時刻で、`snapshotsOf(view)` はそのビューが読んだスナップショットと、作られた時刻を返す。ふつうは `<DevbiApp>` が自動で作る。エンジンのコード（DuckDB-wasm の JS と Apache Arrow）は最初の呼び出しで別のファイルとして読む |
| `DashboardSelection` | クロスフィルタの状態（`set`、`clear`、`own`、`filtersFor`、`entries`、`subscribe`） |
| `builtinTiles` | 組み込みタイルの一覧（`type` → `{ component }`）。グラフ（`bar`、`line`、`area`）と `table` は `React.lazy` で、Observable Plot と spreadsheet-grid は、はじめて使うときに読む。自分で描くときは `<C {...props} />` の形で、`<Suspense>` の中に置く（関数として呼ばない） |
| `renderMarkdown(text)` | `markdown` タイルの描画を React の要素で返す（HTML は解釈しない） |

DuckDB-wasm のエンジンはページに 1 つで、ダッシュボードを切り替えても、API の場所が違うダッシュボードを並べても使い回します。同じ SQL の結果はページを開いている間キャッシュします。

## devbi（コア）

ブラウザでも Node でも動きます。テストやスクリプト、ほかのツールから使えます。

| 名前 | 中身 |
| --- | --- |
| `parseMetricsYaml(text, name)` / `defineMetricsView(obj, name)` | metrics.yaml を検証して `MetricsView` にする。間違いは `MetricsError`（`issues` に項目ごと） |
| `parseDashboardJson(text, name)` / `defineDashboard(obj, name)` | dash.json を検証する。間違いは `DashboardError` |
| `checkQuery(obj, source)` | クエリだけを検証する |
| `compileQuery(view, query, { filters?, model? })` | クエリを DuckDB の SQL にする。戻り値は `{ sql, fields }`。名前の間違いは `QueryError` |
| `compileTimeExtent(view)` | 日付の最初と最後を出す SQL |
| `scanSources(sql)` / `apiParams(source)` | `model` の中の `read_*(...)` と `read_api(...)` を見つける / `read_api` の引数をパラメーターの値にする |
| `apiCalls(sql)` / `snapshotFile(name, params)` | `model` の中の `read_api` の名前とパラメーター / そのスナップショットのファイル名（ブラウザとサーバーで同じ） |
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
.devbi-root[data-theme="dark"] { --devbi-accent: #4fd1c0; }
```

ライト / ダークは、ふつうは OS の設定に合わせます。`.devbi-root` の `data-theme` が `"light"` ならいつもライト、`"dark"` ならいつもダークです（`<Dashboard theme>` や埋め込みの `data-devbi-theme` で付きます）。日付の入力などのブラウザの部品も、`color-scheme` で同じ側に合わせます。

埋め込んだダッシュボード（`mount`、`devbi-embed.js`、`<Dashboard isolate>`）の `.devbi-root` には `data-devbi-isolate` が付き、中の `h1`、`td`、`ul`、`button` などは、ページの CSS の要素の名前だけの指定を受けず、ブラウザの既定から始まります（[埋め込み](#2-画面に-2-行を足す)）。埋め込む自作タイルの CSS は、要素の名前だけでなくクラスを付けて、`@layer` の外に書いてください（`.my-tile td { … }`）。幅が 720px より狭いダッシュボードには `data-devbi-narrow` が付き、タイルが 1 列になります。

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

`table` タイルの表（spreadsheet-grid）は、背景・文字・枠線・強調の色をこの変数から取ります。ライト / ダークは `.devbi-root` に合わせます（`data-theme` が `"light"` か `"dark"` ならそれ、ほかは OS の設定）。表だけを変えるときは、`.devbi-root .devbi-table-grid` に spreadsheet-grid の変数（`--ssg-*`）を書きます。列見出しの ⋮ のメニューはページの最後に出るので、その色は spreadsheet-grid のライト / ダークの既定のままです。

## コマンド

リポジトリのルートで実行します。

| コマンド | 中身 |
| --- | --- |
| `pnpm example:dev` | パッケージをビルドして、サンプルの開発サーバーを開く（<http://localhost:5173>） |
| `pnpm example:preview` | サンプルを静的ビルドして開く（<http://localhost:4173>） |
| `pnpm example:serve` | サンプルをビルドして、`devbi-serve` で開く（<http://localhost:8080>）。「売上ダッシュボード（DB から）」はサンプルの SQLite を API から読み、「売上の日次集計」は起動したときに作ったスナップショットを読む |
| `pnpm --filter devbi-example-sales exec devbi-snapshot` | サンプルのスナップショットを、いま `dist/snapshots/` に作る（先にビルド） |
| `pnpm try-xlsx <Excel> [--sheet 名前] [--name local_名前] [--force]` | 手元の Excel から下書きのダッシュボードを作る。ファイルは git に入らない |
| `pnpm gen` | パッケージをビルドして、サンプルの `.devbi/`（補完と型）を作り直す。開発サーバーを動かしている間は自動 |
| `pnpm test` | 単体テスト（指標 → SQL を DuckDB で実際に流す、xlsx、書式、API）。パッケージのソースを直接読むので、先にビルドしなくてよい。`DEVBI_TEST_PG` に PostgreSQL の URL を入れると、PostgreSQL のテストも流す |
| `pnpm e2e` | パッケージとサンプルをビルドして `devbi-serve` で開き、ブラウザで操作を確かめる |
| `pnpm --filter devbi-example-sales gen:db` | `data/sales.xlsx` から、サンプルの SQLite（`db/sales.sqlite`）を作り直す |
| `pnpm typecheck` / `pnpm build` | 型チェック（サンプルは `.devbi/` を作ってから） / パッケージのビルド |
