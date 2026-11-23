# DevBI リファレンス（v0）

DevBI のファイル形式と API の一覧です。v0 なので、1.0 までに名前や形が変わることがあります。使い方の流れは [README](../README.md)、画面での確かめ方は [manual-check.md](manual-check.md)、社内の人に見せる置き方（静的なサイト、`devbi-serve`、社内のアプリへの埋め込み）は [deploying.md](deploying.md) を見てください。

- [はじめる（create-devbi）](#はじめるcreate-devbi)
- [プロジェクトの形](#プロジェクトの形)
- [metrics.yaml](#metricsyaml)（指標と軸）
- [dash.json](#dashjson)（タイルの並び）
- [組み込みタイル](#組み込みタイル)
- [ファイル出力（Excel・CSV・PDF）](#ファイル出力)
- [自作タイル（JSX）](#自作タイルjsx)
- [エディタでの補完と型（pnpm gen）](#エディタでの補完と型pnpm-gen)
- [ファイルを確かめる（devbi-check）](#ファイルを確かめるdevbi-check)
- [AI に作らせる（AGENTS.md）](#ai-に作らせるagentsmd)
- [書式](#書式)
- [@devbi/vite](#devbivite)
- [GUI エディタ（@devbi/editor）](#gui-エディタdevbieditor)
- [データベースから読む（@devbi/server）](#データベースから読むdevbiserver)
- [ASP.NET（C#）で API を出す](#aspnetcで-api-を出す)
- [Next.js に置く](#nextjs-に置く)
- [ほかのアプリの画面に埋め込む](#ほかのアプリの画面に埋め込む)
- [@devbi/react](#devbireact)
- [devbi（コア）](#devbiコア)
- [見た目の変更（CSS 変数）](#見た目の変更css-変数)
- [コマンド](#コマンド)

## はじめる（create-devbi）

```sh
npm create devbi@latest my-reports     # pnpm create devbi my-reports / yarn create devbi my-reports / bun create devbi my-reports
cd my-reports
npm install
npm run dev                            # http://localhost:5173 。見出しの右の「編集」で GUI エディタ
```

`my-reports/` に、サンプルの売上ダッシュボード（架空の受注明細の Excel、自作タイル 1 つ）と、Vite・React・GUI エディタの設定が入ったプロジェクトができます。中身はこのリポジトリの `examples/sales` の売上ダッシュボードと同じです。

- フォルダは、ないか空のものにします（`.git` だけはあってよい）。名前を書かなければ聞かれます（ターミナルでないときは `my-reports`）
- AI 向けの作業手順 `AGENTS.md` と、Claude Code がそれを読むための `CLAUDE.md` も置きます（[AI に作らせる](#ai-に作らせるagentsmd)）
- `git init` もします。git のリポジトリの中（モノレポなど）ではしません。`--no-git` でしない（`npm create` では `npm create devbi@latest my-reports -- --no-git` のように `--` のあとに）
- Yarn 2 以降では、`node_modules` を作る `.yarnrc.yml`（`nodeLinker: node-modules`）も置きます（Plug'n'Play のままだと、`@devbi/vite` が GUI エディタを見つけられないため）
- package.json の名前はフォルダ名から作ります（英数字以外は `-`。残らなければ `devbi-reports`）
- DevBI のパッケージ（`devbi`、`@devbi/react`、`@devbi/vite`、`@devbi/editor`）は `create-devbi` と同じ版を `^` で入れます。React・Vite・TypeScript は、このリポジトリでテストしている版です
- できるスクリプト: `dev`（開発サーバー）、`build`（`dist/` に静的なサイト）、`preview`（ビルドしたものを開く）、`gen`（[補完と型](#エディタでの補完と型pnpm-gen)）、`typecheck`（`devbi-gen` と `tsc`）、`check`（[ファイルを確かめる](#ファイルを確かめるdevbi-check)）、`inspect`（[データの中を見る](#データの中を見るdevbi-inspect)）
- データベースから読むとき（[@devbi/server](#データベースから読むdevbiserver)）は、`npm install -D @devbi/server` とドライバー（`pg` など）を足します

## プロジェクトの形

```
dashboards/
  <名前>.dash.json        # ダッシュボード 1 つ。URL は #/<名前>
  <名前>/Xxx.tsx          # 自作タイル（dashboards/ の中の .tsx / .jsx）
models/
  <名前>.metrics.yaml     # 指標と軸。dash.json の "metrics" で名前を指す
data/
  *.xlsx / *.csv / *.arrows / *.parquet / *.json
api/
  <名前>.sql              # read_api('<名前>') でデータベースから読む SELECT。サーバーだけが使う（ビルドに入らず、開発サーバーもブラウザに渡さない）
dist/snapshots/           # 毎朝のスナップショット（devbi-serve / devbi-snapshot が作る。git に入れない）
.env                      # API の接続先（DEVBI_DB=...）。パスワードを含む本物の接続先は .env.local に書き、git に入れない
.devbi/                   # pnpm gen が作る（エディタの補完と TypeScript の型）。git に入れない（columns.json のほかは）
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
| `read_xlsx('data/x.xlsx', sheet = '明細', range = 'A3:K', header = true, all_varchar = false)` | Excel | DevBI が自前で読む。引数は `sheet` 以外は省略可 |
| `read_csv('data/x.csv')` / `read_csv_auto(...)` | CSV | DuckDB が読む |
| `read_arrow('data/x.arrows')` | Arrow IPC のストリーム形式 | DuckDB が読む。Arrow の file 形式（Feather v2。`.arrow` によく使う形）は読めない（「ArrowIpcDecoderDecodeHeader … failed」のエラー） |
| `read_parquet('data/x.parquet')` | Parquet | DuckDB の拡張が要る（[@devbi/vite](#devbivite) の `extensionRepository`） |
| `read_json(...)` / `read_ndjson(...)` | JSON | DuckDB の拡張（json）が要る（`extensionRepository`） |
| `read_api('orders', from = '2025-04-01')` | データベース | サーバーの `api/orders.sql` の結果を API から受け取る。[データベースから読む](#データベースから読むdevbiserver) |

パスはプロジェクトからの相対パスで、ブラウザが `data/` から取りに行きます。`https://` の URL も書けます。ブラウザではワイルドカード（`*`）は使えません。`model` の中では JOIN や WHERE、列の計算など、DuckDB の SQL が自由に書けます。

Excel の読み方: 見出しは最初の空でない行（`range` があればその中の。`header = false` なら見出しなしで、列名は `column1`、`column2`…）。表の上に表題やメモの行があるときは、`range` で見出しの行から読みます。`range` は `A3:K5000` のように書き、終わりの行を省くと最後の行まで（`A3:K`）、行を両方省くと列のすべて（`A:K`）です。同じ見出しが重なると `_2` を付けます。型は中身から決めます（文字・整数・数値・真偽・日付・日時）。日付はセルの表示形式（和暦の表示形式を含む）で見分けます。空の行は飛ばします。数式のセルは、Excel が最後に保存した値を使います。

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
complaints: { sql: COUNT(*), label: クレーム, better: lower }   # 少ないほうが良い指標
```

- 集計関数（`SUM`、`COUNT`、`AVG`、`MIN`、`MAX`、`MEDIAN` など）を使った DuckDB の式です。
- 式の中にほかの `sql` 指標の名前を書くと、その式に置き換えて 1 本の SQL にします（`avg_order` は `(SUM(金額)) / (COUNT(DISTINCT 受注番号))`）。循環するとエラーになります。
- 集計関数の括弧の中と、`FILTER (...)`、`OVER (...)`、`WITHIN GROUP (...)` の中の名前は、指標ではなく列として扱います。指標と同じ名前の列も、そこでは列として使えます（`amount: SUM(amount)`）。
- `"金額"` のように二重引用符で囲んだ名前、`t.金額` のような修飾された名前、文字列の中は置き換えません。
- `better: lower` は、少ないほうが良い指標（クレームの件数、不良の数、対応にかかった時間など）です。`kpi` の比較の色が逆になります（増えると赤）。既定は `higher` です。

**比較（`compare`）**

```yaml
revenue_yoy: { of: revenue, compare: previous_year, as: ratio }
revenue_pp:  { of: revenue, compare: previous_period, as: delta }
```

| キー | 中身 |
| --- | --- |
| `of` | 比べる `sql` 指標 |
| `compare` | `previous_year`（1 年前）か `previous_period`（1 つ前の期間） |
| `as` | `value`（比較先の値）、`delta`（差）、`ratio`（比、既定）、`change`（増減率 = 比 − 1） |
| `better` | 良い向き（`higher` か `lower`）。既定は `of` の指標の `better` |

- 既定の表示名は「売上 前年比」「売上 前期間差」などです。`ratio` と `change` の既定の書式は `0.0%` で、それ以外は `of` の書式を引き継ぎます。
- 値が出るのは、期間が決まっているときだけです。つまり、クエリに `time`（時間の粒度）があるか、期間の絞り込みがあるときです。全期間のままだと空（NULL、画面では「—」）になります。
- `previous_year` を時間の粒度で使うと、同じ月（同じ四半期・同じ年）の 1 年前と比べます。週は 52 週前（364 日前）です。日で比べるとき、前年の 2/29 には対応する日がないので比べません。期間の単位（下記）が週か日のときも同じです（`latest_week` の前年は 52 週前の同じ曜日から）。
- `previous_period` は、時間の粒度があればその 1 つ前（前月・前四半期など）と比べます。期間の絞り込みだけのときは、期間の単位で 1 つ前と比べます。
  - 単位があるのは、`date-range` の日・週・月・四半期・年・年度の期間と、時間のグラフでクリックした期間です（`filters` では `unit`）。前の単位の同じ日と比べます。たとえばデータが 10/30 までなら、`latest_month`（10/1〜10/30）は前の月の 9/1〜9/30、`latest_quarter`（10/1〜10/30）は前の四半期の 7/1〜7/30、`year_to_date` は前の年の同じ日までです。
  - 単位のない期間（`last_7_days`・`last_30_days`、日付の欄で選んだ期間、`unit` のない `between`）は、同じ日数だけ前と比べます（直近 7 日なら、その前の 7 日）。
  - 期間が重なるとき（年度を選び、さらに月の棒をクリック）は、いちばん短い期間（その月）の単位です。同じ長さなら細かいほうの単位で、クリックした順には左右されません。
- `kpi` では、2 つ目からの指標のうち `as` が `ratio`・`change`・`delta` のものに色が付きます（増えると緑、減ると赤。変わらなければ色なし）。`better: lower` の指標は逆で、増えると赤、減ると緑です。大きく出す最初の指標と `value` には付きません。

**累計（`running`）**

```yaml
revenue_cum:  { of: revenue, running: true }          # 全期間の累計（running: all とも書ける）
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
| `params` | パラメーターの欄の設定（[レポート](#dashjson-の-params)） |
| `fiscalYearStart` | パラメーターの既定値の `fiscal_year_start`（年度の始まり）の月。1〜12。既定は 1 |
| `apply` | `"auto"`（既定。欄の値が決まるとすぐ表を読み直す）か `"button"`（「表示」を押したときに読み直す） |
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
| `sort` | 並べ替えの配列（`["-revenue", "region"]`）。`"revenue"` は昇順、`"-revenue"` は降順。`{ "field": "revenue", "desc": true }` とも書ける |
| `limit` | 最大の行数 |
| `period` | `false` で、期間（`date-range` で選んだ期間と、時間のグラフでクリックした期間）で絞らない。「いま対応中のすべて」「全期間の累計」のように、期間に関係なく出すタイルに。ほかの選択（地域のクリックなど）はかかる |
| `metrics` | ダッシュボードとは別の指標ファイルを使うとき |
| `malloy` / `sql` | 指標と軸の名前で言えない集計を、Malloy か SQL で書く（[下記](#malloy-と-sql-で書く)） |
| `dataset` / `params` | サーバーの `api/<名前>.sql` の結果を、そのまま出す（[レポート](#データセットを読むタイルquerydataset)）。表（`table`）と自作タイルだけ |

`measures` か `dimensions` か `time` のどれかが要ります（`malloy` か `sql` か `dataset` を書くときは要らない）（[`explore`](#探索explore) は別で、`metrics`・`filters`・`limit`・`period` だけを使い、`query` は書かなくてもよい）。`sort` を書かないときは、`time` があれば時間の順、軸と指標があれば最初の指標の大きい順、軸だけなら軸の順です。`sort` を書いたときも書かないときも、同じ値の行は時間、軸の順に並べるので、どの PC でも同じ順になり、`limit` で残る行も変わりません。

絞り込み（`filters` の要素。クリックでの選択も同じ形）:

```json
{ "field": "region", "in": ["関東", "近畿", null] }
{ "field": "受注日", "between": ["2026-04-01", "2026-10-31"] }
{ "field": "受注日", "between": ["2026-10-01", "2026-11-01"], "unit": "month" }
```

- `field` は軸の名前か、`time` の列名です。
- `in` は値のどれかに一致する行です。`null` は空欄に一致します。
- `between` は「始まり ≦ 値 ＜ 終わり」で、終わりの日は含みません。どちらかを `null` にすると、その側は無制限です。
- `between` の `unit`（`day`・`week`・`month`・`quarter`・`year`・`fiscal_year`）は、その期間の単位です。`previous_period` の比較が、同じ日数ではなく、前の単位の同じ日になります（上の `measures` の比較）。
- タイルの `filters`、期間（`date-range`）、ほかのタイルのクリックでの選択は、すべて重ねてかかります（AND。期間どうしは重なる部分）。選択と期間は、その項目（期間なら `time` の列）を持つ指標ファイルのタイルにだけかかります。期間に関係なく出したいタイル（「いま対応中のすべて」など）は `"period": false` にします（期間だけが外れ、ほかの選択はかかります）。

### Malloy と SQL で書く

構成比や、多段の集計（顧客ごとに受注を数え、その回数ごとに顧客を数える）のような、指標と軸の名前では言えない集計は、`query` に [Malloy](https://www.malloydata.dev/)（MIT）か SQL（DuckDB）で書けます。組み込みタイルが、その結果をいつもどおりに描きます。

```json
{ "id": "region", "type": "barlist", "title": "地域別売上",
  "query": { "malloy": "run: sales -> { group_by: 地域; aggregate: revenue is 金額.sum() }" } }
{ "id": "repeat", "type": "bar", "title": "受注の回数ごとの顧客数",
  "query": { "malloy": "run: sales -> { group_by: 顧客; aggregate: 受注回数 is count(受注番号) } -> { group_by: 受注回数; aggregate: 顧客数 is count() }" } }
{ "id": "share", "type": "table", "title": "商品分類ごとの構成比",
  "query": { "sql": "SELECT 商品分類, SUM(金額) AS revenue, ROUND(100 * SUM(金額) / SUM(SUM(金額)) OVER (), 1) AS \"構成比（%）\" FROM sales GROUP BY ALL ORDER BY 2 DESC" } }
```

- 指標ファイルの名前（`models/sales.metrics.yaml` なら `sales`）が、その `model` の行（明細）です。Malloy では source（`->` の前、`extend` の前、`join_one:` などの後）、SQL では表（`FROM` と `JOIN` の後）として読みます。列の名前や別名（`AS sales`）は、指標ファイルの名前と同じでも読みません。2 つ以上の指標ファイルを読んでもよい。
- 読む行には、期間（`date-range`、時間のクリック）と、ほかのタイルの選択が、その指標ファイルの項目ならかかります（`"period": false` で期間を外せる）。期間で絞ったあとの行なので、前の期間と比べる集計は、指標ファイルの比較の指標（`compare:`）で書きます。`filters` も書けます（`metrics` の指標ファイル、なければ読む 1 つの指標ファイルの軸で）。
- 行の列は `model` の列と、式で書いた軸（`sql:` の軸）をその名前で。`column:` の軸は、その列のまま（`地域`）です。`model` の列と同じ名前の軸（大文字と小文字の違いだけのものも）は、その列の代わりに軸の値が軸の名前で入ります（元の列は読めなくなるので、読みたいときは軸の名前を変えます。`time` の列は置きかえません）。
- 結果の列のうち、指標ファイルの軸の列（`地域`）か軸の名前（`region`）の列は、その軸になります。見出しは軸の `label` で、クリックするとほかのタイルを絞ります。名前を変えた列（`group_by: エリア is 地域`）は、見出しだけがその名前です。Malloy では、`time` の列を月などで切った列（`group_by: 月 is 受注日.month`）も時間の軸になり、クリックでその月を選びます。SQL の日付の列と、Malloy の週（`.week`。Malloy の週は日曜始まりで、DevBI の週は月曜始まり）は、時間の軸にならず、クリックしても絞りません。
- 指標は、Malloy では `aggregate:` の列、SQL では数の列です。指標ファイルの指標と同じ名前（`revenue`）にすると、その `label` と `format`（`¥#,##0`）で出ます。
- `measures`・`dimensions`・`time`・`sort`・`limit` とは一緒に使えません（並べ替えと件数はクエリの中に書く）。`pivot` は、合計の行と列を出しません（集計のしかたをクエリが決めるため）。Malloy の `nest:` は表にならないので使えません。明細の行をそのまま読む `explore` のタイルでも使えません。
- Malloy の `run:` は省けます。Malloy の間違いは、何行目かとともにタイルに出ます（`Malloy: '地' is not defined（2 行目）`）。
- Malloy は、最初に Malloy のタイルを出すときに、別のファイルとして読みます（約 1.8MB、圧縮して約 440KB）。Malloy のタイルのないダッシュボードでは読みません。SQL は読み込むものがありません。
- `devbi-check` も、Malloy と SQL のタイルを実行して確かめます。

## 組み込みタイル

| `type` | 出すもの | クエリの使い方 | `options` | クリック |
| --- | --- | --- | --- | --- |
| `kpi` | 大きな数字 | 最初の指標を大きく、残りの指標をその下に。比較の指標は良し悪しで色が付く | | なし |
| `bar` | 棒グラフ | 横軸は `time`、なければ最初の軸。2 つ目の軸か 2 つ目以降の指標は色分けの系列 | | 棒でその値を選ぶ |
| `line` | 折れ線 | `bar` と同じ | | 点でその値を選ぶ |
| `area` | 積み上げ面グラフ | `bar` と同じ（系列は大きい順に積む） | | その値を選ぶ |
| `barlist` | 横棒のランキング | 最初の軸を最初の指標で | | 行でその値を選ぶ |
| `table` | 表（[spreadsheet-grid](https://github.com/ishibashi0112/datasheet-grid)、読み取り専用） | すべての列（数値の列は見出しも右寄せ）。列の見出しの ⋮（キーボードではセルで Alt+↓、Mac は Option+↓）で並べ替えと列幅の調整。セルを選んで Ctrl+C（Mac は ⌘+C）で、表示どおりの文字でコピーし、Excel に貼れる | | 行のクリック（またはセルで Enter かスペース）で、その行の軸と時間の値を選ぶ。もう一度で解除。Shift・⌘・Ctrl を押したままのクリックは、コピーする範囲を広げるだけ |
| `pivot` | クロス集計 | 1 つの項目を列に、残りの軸を行に、最初の指標をセルに。合計の行と列つき | `columns`: 列にする項目（既定は最後の軸か時間）。`totals: false` で合計を消す | 列見出し・行で選ぶ |
| `explore` | 明細を自由に集計する表とグラフ（[Perspective](https://perspective.finos.org/)） | 指標ファイルの `model` の行をそのまま（集計しない）。`query` は `metrics`・`filters`・`limit`・`period` だけ（[下記](#探索explore)） | `layout`: 開いたときの並べ方 | なし（ほかのタイルの選択と期間で絞られる） |
| `select` | 値の一覧から選ぶ | 最初の軸の値（指標があれば値も表示）。9 件以上で検索欄が出る | `multiple: false` で 1 つだけ選ぶ | チェックで選ぶ |
| `date-range` | 期間の選択 | `query` は書かない。`time` の列が対象 | `default`: 最初の期間（下記）。`metrics`: 指標ファイル | 期間で全タイルを絞る（`query.period` が `false` のタイルを除く） |
| `markdown` | 文章 | `query` は書かない | `text`: 本文（`**太字**`、`*斜体*`、`` `コード` ``、`[リンク](URL)`、`#` 見出し、`-` 箇条書き） | なし |

`date-range` の期間の名前（`options.default` に書く）:

| 名前 | 期間 | 出し方 |
| --- | --- | --- |
| `all` | 全期間 | ボタン |
| `latest_day` | 最新の日 | 一覧 |
| `last_7_days` / `last_30_days` | 直近 7 日 / 直近 30 日 | 一覧 |
| `latest_week` | 最新の週（月曜始まり） | 一覧 |
| `latest_month` / `previous_month` | 最新の月 / 前の月 | ボタン / 一覧 |
| `latest_quarter` / `previous_quarter` | 最新の四半期 / 前の四半期 | 一覧 |
| `last_12_months` | 直近 12 ヶ月 | ボタン |
| `latest_year` / `previous_year` / `year_to_date` | 最新の年 / 前の年 / 今年の累計 | ボタン |
| `latest_fiscal_year` / `previous_fiscal_year` | 最新の年度 / 前の年度（`time` に `fiscal_year_start` があるときだけ） | ボタン |

- 「一覧」の期間は、ボタンの横の「ほかの期間」から選びます。`default` に書いた期間は、一覧の期間でもボタンに出ます。
- 「最新」「直近」は、今日ではなく、データの最終日が基準です。最終日を含む期間は、その日で終わります（10/30 までなら `latest_month` は 10/1〜10/30）。

選択は、選んだタイル以外のすべてのタイルにかかります。選んだタイル自身は絞られず、選んだもの以外が薄くなります。選択は画面上のチップで外せます。

### 探索（`explore`）

指標ファイルの `model` の行（明細）を、見る人が自由に並べて集計するタイルです。中身は [Perspective](https://perspective.finos.org/)（Apache-2.0）で、行にする列・列に分ける列・出す列とその集計（合計、件数、異なり数、平均など）・並べ替え・絞り込みを、タイルの中の設定（左の欄）で変えられます。表のほか、棒・折れ線・散布図・ヒートマップなどのグラフにもできます。

```json
{
  "id": "explore",
  "x": 0, "y": 1, "w": 12, "h": 6,
  "type": "explore",
  "title": "明細",
  "query": { "filters": [{ "field": "region", "in": ["関東"] }] },
  "options": {
    "layout": {
      "group_by": ["商品分類"],
      "columns": ["金額", "数量", "受注番号"],
      "aggregates": { "金額": "sum", "数量": "sum", "受注番号": "distinct count" }
    }
  }
}
```

- 読むのは `model` の列そのままです（指標や軸の名前ではなく、`model` の SQL が出す列。`layout` にもその列名を書きます）。指標の式（`SUM(金額)` など）は使いません。
- 期間（`date-range`）とほかのタイルでの選択で絞ります。絞るのは、その項目（軸か `time` の列）の式で、ほかのタイルと同じです。`"period": false` なら期間では絞りません。タイルの中での絞り込みや並べ替えは、このタイルの中だけで、ほかのタイルは絞りません。タイルの中をクリックしても選択にはなりません。
- 行は新しいほう（`time` の列の大きいほう。同じ日時の行は、すべての列の順）から、`query.limit` 行（既定は 100,000 行）までです。多いときは、タイルの上に「新しいほうから 100,000 行だけを集計しています」と出ます（`time` のない指標ファイルでは、すべての列の順で先頭から）。画面、Excel、`devbi-check` で同じ行になります。期間で絞るか、`limit` を大きくしてください（すべてブラウザで集計するので、多いほど重くなります）。
- 期間や選択が変わると、行を読み直します。タイルの中で変えた並べ方は、そのまま残ります（ページを開き直すと `layout` に戻ります）。
- 暗い色の画面（`data-theme="dark"`、OS の設定）では、Perspective も暗い色になります。
- Perspective は最初の `explore` のタイルを出すときに読みます（JS 約 420KB・CSS 約 110KB と、WebAssembly 約 3.2MB）。`explore` のないダッシュボードでは読みません。WebAssembly の場所は `@devbi/vite` が `virtual:devbi` に入れます（`ProjectInput.perspective`。explore か自作タイルのあるとき）。

`options.layout`（Perspective の設定。どれも省略できる）:

| キー | 中身 |
| --- | --- |
| `group_by` | 行にする列の配列（`["地域", "商品分類"]` で地域ごと、その中を商品分類ごと）。合計の行が付く |
| `split_by` | 列に分ける列の配列 |
| `columns` | 出す列の配列。既定はすべての列 |
| `aggregates` | 列ごとの集計（`{ "金額": "sum" }`）。`sum`・`count`・`distinct count`・`avg`・`mean`・`min`・`max`・`median`・`first`・`last` など。既定は、数は `sum`、文字は `count` |
| `sort` | 並べ替え（`[["金額", "desc"]]`） |
| `filter` | タイルの中だけの絞り込み（`[["地域", "==", "関東"]]`） |
| `plugin` | 見せ方。`Datagrid`（表、既定）・`Y Bar`（縦棒）・`X Bar`（横棒）・`Y Line`（折れ線）・`Y Area`（面）・`X/Y Scatter`（散布図）・`Heatmap`・`Treemap`・`Sunburst` など |
| `settings` | `false` で、開いたときにタイルの中の設定の欄を閉じておく（既定は開いておく） |
| `columns_config` | 列ごとの表示（`{ "金額": { "number_format": { "maximumFractionDigits": 0 } } }`）。数の列は、既定で小数を 2 桁まで、整数は `.00` なしで出す |

Perspective が使えない `layout`（ない列の名前、ない `plugin`）は、タイルに「options.layout の並べ方を使えません（…）」「options.layout の plugin "…" はありません（…のどれかにしてください）」と出ます。GUI エディタで直せば、そのまま新しい並べ方になります。

いまの制限:

- タイルの中で変えた並べ方は保存しません（ページを開き直すと `layout` に戻ります）。残したい並べ方は、Perspective の設定の欄で作り、GUI エディタの「最初の並べ方」に JSON で貼ります（ブラウザの開発者ツールで `document.querySelector("perspective-viewer").save()` の結果）。
- 指標の `format`（`¥#,##0` など）は使いません（`model` の列を読むため）。
- 100,000 行を超えるデータを全部集計するには、`limit` を大きくします。ブラウザのメモリに乗る分だけです。

## ファイル出力

ダッシュボードの見出しの右に「ファイル出力 ▾」のメニューがあります（ビルドしたサイト、開発サーバー、埋め込み、`<Dashboard>` のどれでも）。どれも、いま画面に出ている状態（期間や選択での絞り込み、パラメーターの値）のままを書き出します。サーバーは使わず、ブラウザの中で作ります。

| メニュー | できるもの |
| --- | --- |
| Excel（.xlsx） | データを読むタイルすべてを、タイルごとのシートにしたブック（[Excel](#excel)） |
| 印刷・PDF | 画面のとおりのダッシュボードの印刷。印刷の画面の「PDF に保存」で PDF（[印刷・PDF](#印刷pdf)） |
| CSV（.csv）→ すべてのタイル（.zip） | タイルごとの CSV を 1 つにまとめた ZIP（[CSV](#csv)） |
| CSV（.csv）→ タイルの名前 | そのタイル 1 つの CSV |

メニューは、ボタンを押すか、ボタンで ↓（最後の項目から: ↑）を押すと開きます。↑↓・Home・End で選び、Enter で書き出し、Esc・Tab・メニューの外を押すと閉じます。CSV のタイルの一覧は、データを読むタイル（Excel でシートになるもの）だけで、ダッシュボードの並び順です（タイルが 1 つなら「すべてのタイル」はありません）。

### Excel

メニューの「Excel（.xlsx）」。ブラウザのダウンロードで `<ダッシュボードのタイトル>_<年月日>-<時分>.xlsx`（例: `売上ダッシュボード_20261108-1023.xlsx`）を保存します。

- 最初のシート「概要」: タイトル、説明、書き出した日時、データの時点（[スナップショット](#毎朝のスナップショット)を読むとき）、いまの絞り込み、タイルの一覧（名前を押すとそのシートへ。行数、メモ）
- データを読むタイル 1 つにつき 1 シート。ダッシュボードの並び順で、シートの名前はタイルの `title`（なければ `id`。Excel で使えない `[]:*?/\` は空白にし、31 文字まで、同じ名前には `(2)` を付ける）。1 行目にタイトル、2 行目にそのタイルにかかった絞り込み（`query.filters` と、ほかのタイルでの選択）、4 行目から表。表の見出しは固定され、オートフィルタが付きます
- 行は画面と同じです。ほかのタイルでの選択で絞り、選んだタイル自身は絞りません。`limit` もそのままです。表（`table`）の列のメニューでの並べ替えや絞り込みは入りません（クエリの `order` の順です）
- 数字は数値のままで、指標の `format` を Excel の表示形式にして付けます（`¥#,##0` → `"¥"#,##0`、`0.0%`・`#,##0"円"`・`正;負;ゼロ` はそのまま。色や条件の `[Red]`・`[>100]` は落とします）。`compact`（万・億）は Excel にないので `#,##0` です。`format` のない指標は `#,##0`（小数は `#,##0.0#`）
- 日付は日付のままで、時間の粒度の表示形式です（月は `2026年4月`、年は `2026年`、年度は `2026年度`、週は `2026/4/6週`、日は `2026/4/1`）。四半期は Excel に表示形式がないので、`2026年Q2` の文字です。真偽（はい・いいえ）も文字です。指標でない 16 桁以上の整数（コードや ID）は、Excel が 15 桁までしか持たないので文字で書きます
- `pivot` は画面と同じクロス集計で、合計の行と列が付きます（行の項目がないときは、1 行だけなので合計の行は付けません）。「概要」の行数は、クロス集計の行の数です
- `explore` は、読んでいる明細の行（期間とほかのタイルの選択で絞ったもの。`limit` まで）を書きます。Excel のピボットテーブルで集計し直すためのものです。タイルの中で並べた表は入りません（その表は、タイルの中の上にある「書き出し」のボタンで、CSV などで保存できます）。日付は日付、数は数値のままです（表示形式は整数が `#,##0`、小数が `#,##0.0#`。15 桁を超える整数のコードは文字）
- 自作タイル（JSX）は、`query` を export しているものだけ、その結果の表を書きます。自分でデータを読むタイルは、「概要」のメモに「書き出せません」と書いて飛ばします。`markdown` と `date-range` はシートを作りません
- エラーになったタイルは、「概要」のメモにエラーを書き、ほかのタイルは書き出します。1 シートは Excel の上限（1,048,576 行）までです。列の上限（16,384 列）を超える `pivot`（列の項目の値が多すぎるもの）は、メモに書いて飛ばします
- 大きな表は時間がかかります（12 列 10 万行で数秒）。書き出しているあいだ、メニューのボタンは「書き出し中…」です

### CSV

1 つのタイルは `<ダッシュボードのタイトル>_<タイルの名前>_<年月日>-<時分>.csv`（例: `売上ダッシュボード_月別売上_20261123-2033.csv`）、すべてのタイルは `<ダッシュボードのタイトル>_<年月日>-<時分>.zip` で、ZIP の中は `<タイルの名前>.csv` です（タイルの名前は `title`、なければ `id`。ファイル名に使えない `\ / : * ? " < > |` は `_` にし、同じ名前には ` (2)` を付けます。長いタイトルは、ファイル名が 255 バイトに収まるように切ります）。メニューでは、同じ `title` のタイルは `売上（kpi-a）` のように `id` を添えます。

- ほかのプログラムやデータベースに読ませるためのものです。値は表示形式を付けず、そのままです: 数は `2622450`・`0.1297`（`¥#,##0` や `0.0%` の書式は付けない。小数は有効数字 15 桁まで）、日付は `2026-04-01`、真偽は `true`・`false`、空は空欄。時刻のある列は、列ごとにそろえて `2026-04-01 09:30:00`（ミリ秒のある列は `2026-04-01 09:30:00.250`）。時間の粒度でまとめた列（月・四半期・年度など）は、その期間の最初の日です（`2026年4月` は `2026-04-01`、`2026年Q2` は `2026-04-01`）
- 整数は 9,007,199,254,740,991（2^53−1、16 桁）までそのままです。それより大きい整数（19 桁の ID など）は、画面と同じく丸まります（DevBI がブラウザの数で持つため）。そういう ID は、SQL で文字の列にしてください（`CAST(id AS VARCHAR)`）
- 1 行目は列の見出し（指標と軸の `label`）で、2 行目からデータです。タイトルや絞り込みのメモの行はありません
- 文字は UTF-8（BOM 付き。Excel で開いても文字化けしない）、改行は CRLF、区切りは `,` です。`,`・`"`・改行・前後の空白のある値は `"…"` で囲みます。`=`・`+`・`-`・`@`（とタブ・CR）で始まる文字の値と見出しは、表計算ソフトで式として動かないよう、先頭に `'` を付けます（`-12.5` のような数の形のものは付けません）
- 行と列は Excel のシートと同じです（ほかのタイルでの選択で絞り、選んだタイル自身は絞らない。`limit` もそのまま）。違うのは次のところです
  - `pivot` はクロス集計にせず、クエリの結果の行のまま（`地域,受注日,売上` の縦の形）です。合計の行と列もありません
  - レポートの表（`query.dataset`）は、画面のとおりの列と行（見る人の並べ替えと絞り込み）で、合計の行はありません
  - Excel の行数の上限はありません（`explore` は `limit` まで）
- 「すべてのタイル」で書き出せなかったタイル（エラーになったもの、自分でデータを読む自作タイル）は、ZIP の中の `書き出せなかったタイル.txt` に名前とわけを書き、ほかのタイルは書き出します。メニューのタイルの一覧には、書き出せるタイルだけが出ます
- Shift_JIS では書きません。Shift_JIS しか読めないシステムに入れるときは、Excel で開いて「CSV（コンマ区切り）」で保存し直してください

### 印刷・PDF

メニューの「印刷・PDF」。ブラウザの印刷の画面を開きます。送り先を「PDF に保存」（Safari は「PDF として保存」）にすると PDF になります。PDF の名前は `<タイトル>_<年月日>` です。

- 画面のとおりのダッシュボードを、見えない枠（iframe）に写して印刷します。埋め込んだダッシュボードでも、まわりのページは印刷しません。画面はそのままです
- 写すのは、ダッシュボード（`.devbi-root`）と、埋め込みならそれを置いた要素の `data-devbi…` 属性、それにページのスタイルすべて（`<style>`・`<link>`、CSS-in-JS が足したものも）です。ページの CSS の `:not([data-devbi] *)` は写しでも効きます。外側の要素に付けた指定（`#report-area .devbi-root { … }`、`html.dark .devbi-root { … }`）は写しに届かないので、色を変えるときは `.devbi-root` か `[data-devbi]` に書いてください
- 用紙は横向きです。画面の幅のまま並べて、紙の幅（A4 の横）に収まるように縮めます。ダークモードでも、白地の明るい色で印刷します。プロジェクトで変えた色（`.devbi-root { --devbi-accent: … }`）はそのままです
- 印刷するのは、ボタン（「ファイル出力」も）・チップの ×・「すべて解除」・一覧へのリンクを除いたものです。見出しの右に、印刷した時刻（「2026/11/8 10:23 の表示」）が付きます
- タイルがページの境目で切れないように、どのタイルもまたがない行の区切りで改ページします（1 ページより高いタイルの並びは途中で切れます）。幅が 720px より狭くタイルが 1 列のときは、どのタイルの間でも改ページします
- 読み込み中のタイルがあれば、読み終わるのを待ちます（20 秒まで）
- 表（`table`）とスクロールする一覧は、画面に見えている行だけです（スクロールした位置のまま）。全部の行は Excel で
- `explore` は、タイルの中でいま並べている表を、タイルに入るだけの行で印刷します（グラフにしているときも表で。Perspective の描いたものは写せないため）
- ブラウザのメニューの「印刷」（Ctrl+P・⌘+P）でも、白地の明るい色で、ボタンなしで印刷します。ただしページ全体を印刷し、グラフは画面の大きさのままです

### メニューを出さない・一部だけにする

`exports` に `false` でメニューを出さず、種類の配列でそれだけを出します。種類は `xlsx`（Excel）、`pdf`（印刷・PDF）、`csv`（CSV）です。

| 書くところ | 出さない | Excel と PDF だけ（CSV を出さない） |
| --- | --- | --- |
| `<Dashboard>`・`<DevbiApp>` | `exports={false}` | `exports={["xlsx", "pdf"]}` |
| `mountDashboard(要素, project, { … })`・`devbi-embed.js` の `mount(…, { … })` | `exports: false` | `exports: ["xlsx", "pdf"]` |
| 埋め込みの属性 | `data-devbi-exports="false"` | `data-devbi-exports="xlsx,pdf"` |

属性に知らない種類（`excel` など）を書くと、その種類は出さず、ブラウザのコンソールにエラーを出します。メニューを出さないのは、見せ方の設定です。権限ではありません（画面に出ている数字は写せます）。人によって見てはいけない行があるなら、SQL の側で絞る仕組みが要ります（[行レベル制御の設計](design/row-level-security.md)）。

## 自作タイル（JSX）

`dashboards/` の中に `.tsx` か `.jsx` を置き、dash.json の `component` で指します。GUI エディタの「[コードにする](#コードにする)」で、組み込みのタイルから同じ見た目のファイルを書き出して始めることもできます。

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
- データセットを読むクエリ（`defineQuery({ dataset: "order_lines" })`）では、`RowOf<typeof query>` はデータベースが答えた列の型です（[データセットの行の型](#データセットの行の型)）。データセットの名前と `params` の名前も `api/` の SQL と照らし合わせます。
- `import type { Query } from "devbi"` で `export const query: Query = {...}` と書いてもかまいません。その場合、名前は読み込み時にだけ検証されます。

### `TileProps`

組み込みタイルも同じものを受け取ります。`TileProps<行の型>` で `rows` の型を指定できます（既定は `Row`）。

| プロパティ | 型 | 中身 |
| --- | --- | --- |
| `rows` | `Row[]` | 集計済みの行。ほかのタイルの選択がかかった結果。キーは指標・軸・時間の名前 |
| `fields` | `FieldInfo[]` | 列の情報（`name`、`label`、`kind`: `dimension` / `time` / `measure`、`format`、`grain`、比較の指標なら `compare`、`better: lower` の指標なら `better`） |
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

- `useDevbiQuery(query, { tileId?, crossfilter? })` … 追加の集計。`tileId` を渡すと、そのタイル自身の選択を除いた絞り込みがかかります。`crossfilter: false` で絞り込みなし（`query` の `period: false` なら、期間だけを外す）。戻り値は `{ rows, fields, filters, loading, error }`。
- `useTileSize()` … タイルの中身の幅と高さ（px）。
- `useTimeExtent(metrics?)` … データの最初と最後の日付。

タイルの中でエラーが起きても、そのタイルにエラーが出るだけで、ほかのタイルは動き続けます。

## エディタでの補完と型（pnpm gen）

`pnpm gen`（中身は `@devbi/vite` の `devbi-gen`）が `models/*.metrics.yaml` と `api/*.sql` を読んで、`.devbi/` に次のファイルを書きます。`@devbi/vite` も、開発サーバーとビルドの開始時と、metrics.yaml と `api/` の SQL を保存したときに同じものを書き直します。

| ファイル | 使い道 |
| --- | --- |
| `.devbi/dash.schema.json` | dash.json の JSON Schema。タイルの種類（説明つき）、種類ごとの `options`、`query` の指標・軸・時間の名前を補完し、間違いに波線を出す |
| `.devbi/metrics.schema.json` | metrics.yaml の JSON Schema。キーの補完と説明、`compare` / `as` / `running` などの値の候補 |
| `.devbi/env.d.ts` | TypeScript 用の名前の一覧と、データセットの行の型。[`defineQuery` と `RowOf`](#自作タイルjsx) が使う |
| `.devbi/columns.json` | データセット（`api/*.sql`）の結果の列（名前・型・NULL になりうるか）を、データベースに最後に聞いたときのまま覚えておくもの。`env.d.ts` の行の型のもと。データセットがあって、データベースに聞いたときだけ書く。**これだけは git に入れます**（下） |

使うための設定（`pnpm try-xlsx` が作る下書きには最初から入っていて、`.devbi/` も作り直します）:

| ファイル | 書くこと |
| --- | --- |
| dash.json | 先頭に `"$schema": "../.devbi/dash.schema.json"`。VS Code はこれだけで補完が効く |
| metrics.yaml | 1 行目に `# yaml-language-server: $schema=../.devbi/metrics.schema.json`。VS Code は拡張機能「YAML」（`redhat.vscode-yaml`）が要る。このリポジトリか examples/sales を開くとおすすめに出る |
| tsconfig.json | `"include"` に `".devbi/*.d.ts"` を足す。`".devbi"` だけだと、点で始まるフォルダは読まれない。`".devbi/env.d.ts"` とファイル名で書くと、エディタを開いたあとにできたファイルに気づかない |

- 名前の候補は、すべての指標ファイルの分をまとめたものです。そのタイルの指標ファイルにある名前かどうかは、読み込み時に検証します。
- `.devbi/` は git に入れません（手元で試す `local_*` の名前が入るため）。clone した直後は `pnpm gen` か `pnpm example:dev` で作られます。ただし `.devbi/columns.json` は git に入れます。データベースにつながらない CI やほかの人の手元でも、同じ行の型になるようにです（`.gitignore` は `.devbi/*` と `!.devbi/columns.json`。`create-devbi` で作ったプロジェクトは最初からそうなっています）。データベースの列が変わると、このファイルの差分に出ます。
- 読めない metrics.yaml があると、エラーを出して、その分の名前を入れずに書きます。開発サーバーで書きかけのときは、そのファイルの最後に読めた名前を残します。
- 名前の入っていない共通の JSON Schema は、パッケージの `devbi/schema/dash.schema.json` と `devbi/schema/metrics.schema.json` にもあります。

### データセットの行の型

`pnpm gen` は、`api/*.sql` のデータセットごとに、接続先のデータベースに結果の列を聞きます。行は読みません（SQL Server は `sp_describe_first_result_set`、PostgreSQL は `LIMIT 0` に包んで読み取り専用で実行、Oracle・MySQL・SQLite は準備（prepare）だけ）。パラメーターは型の見本の値（日付なら `2000-01-01`）か `NULL` で聞きます。接続先は [`devbi-check`](#ファイルを確かめるdevbi-check) と同じく、環境変数とプロジェクトの `.env`・`.env.local` の `DEVBI_DB…` です。

```ts
// .devbi/env.d.ts（抜き出し）
interface DatasetRegistry {
  "order_lines": {
    params: "from" | "to" | "regions" | "customer";
    row: {
      "受注日": Date | null;
      "顧客": string | null;
      "数量": number | null;
      "金額": import("devbi").Scalar;
    };
  };
}
```

- 列の型は、ブラウザに来る値の型です。文字は `string`、整数と小数は `number`、真偽は `boolean`、日付と日時は `Date`。データベースが「NULL にならない」と答えた列（SQL Server・Oracle の `NOT NULL` の列、MySQL の日付と日時でない `NOT NULL` の列）のほかは `| null` が付きます（MySQL の `NOT NULL` の日付にも、0000-00-00 が入っていると `null` が来るため）。
- 値を見るまで型が決まらない列は `Scalar`（どの値でも）です。SQLite の計算した列（`SUM(…)` など）と、SQLite で `DATE`・`DATETIME`・`BOOLEAN` と宣言した列（SQLite は日付を文字で持つので、すべての値が `2026-04-01` の形のときだけ日付として来ます）がそうです。
- パラメーターの名前（`params`）は、データベースに聞かずに SQL ファイルから入ります。読めない SQL ファイルのあいだは、どの名前でも通します。
- データベースが答えないとき（接続先がない、つなげない、20 秒たっても答えない、SQL が間違っている）は、前に聞いた列（`.devbi/columns.json`）のままにして、「データセットの列を聞けませんでした」と、どれがなぜかを出します（終了コードは 0）。一度も聞けていないデータセットの行は、列の名前を決めない `Row` です。データセットは 1 つずつ聞き、つながらなかった接続先（`DEVBI_DB…`）のほかのデータセットには聞きに行きません。
- 20 秒は、データベースに止めさせる時間の上限です（表の作りを変えている途中で、そのロックを待つときなど。PostgreSQL は `statement_timeout`、SQL Server は取り消し、Oracle は `callTimeout`、MySQL は接続を閉じる）。PostgreSQL は、つなぐのにも 15 秒の上限があります（ページの読み込みも同じ）。
- 開発サーバーは、起動したときにすべてのデータセットに、`api/` の SQL を保存したときには中身が変わったデータセットに、裏で聞き直します（ページは待たせません）。ビルドと `vite preview` は聞かず、前に聞いた列を使います。データベースの表の列を変えたとき（SQL はそのまま）は、`pnpm gen` か開発サーバーの起動し直しで型が変わります。

`devbi-gen [--dir <フォルダ>] [--check] [--no-db]`:

| オプション | 中身 |
| --- | --- |
| `--dir` | `models/` か `api/` のあるフォルダ。既定は今のフォルダ |
| `--check` | 何も書かずに、古いファイルがあれば一覧を出して終了コード 1。データベースにも聞く（`--no-db` を付けなければ） |
| `--no-db` | データセットの列をデータベースに聞かない（前に聞いた列のまま） |

読めない metrics.yaml があったときも終了コード 1 です。フォルダに `models/` も `api/` もないときは、何も書かずに終了コード 2 です。

## ファイルを確かめる（devbi-check）

`pnpm check`（中身は `@devbi/vite` の `devbi-check`）が、ブラウザを開かずに、ダッシュボードが表示できるかを確かめます。metrics.yaml や dash.json を書いたら（人でも AI でも）流し、出たものを直して、もう一度流します。

確かめること:

1. 開発サーバーが読むときと同じ検証。metrics.yaml・dash.json の書き方、`model` が読むデータのファイルと `api/` の SQL があるか、自作タイルのファイルがあるか。`api/*.sql` は、どのダッシュボードも使っていないものも読み、読めないもの（SELECT か WITH の文でない、`-- roles:`・`-- access:` の書き間違いなど）はその SQL ファイルのエラーにします（`devbi-serve` が `api/schema` でエラーを返すもの）。[データセットのタイル](#データセットを読むタイルquerydataset)の `api/` の SQL があって読めるか、`query.params` の名前、パラメーターの欄にまとめられるか（型の違い、候補の輪など）
2. 指標ファイルごとに、`model` の SQL をデータに流す（行数を出し、0 行なら注意）。`time` の列（日付か日時になっているか）、軸を一つずつ、指標を一つずつ流す（`compare` と `running` の指標は `time: month` でも）
3. タイルごとに、`query` を SQL にしてデータに流す（行数を出し、0 行なら注意）。`date-range` に最初の期間（`options.default`）があれば、画面を開いたときと同じく、その `time` の列を持つ指標ファイルのタイルをその期間で流す（比較の指標にも値が出る）。`"period": false` のタイルは期間なしで流す。画面が使わない `default`（ない期間の名前や、`fiscal_year_start` のない指標ファイルでの年度）は注意。タイルの種類が要る形か（kpi には指標、bar・line・area には指標と時間か軸、barlist には軸と指標、select には軸、pivot には指標と `options.columns` の列）。自作タイルは、画面と同じく dash.json の `query`、なければファイルの `export const query`（Vite で読む）を流す。`explore` は明細の行を読む SQL を流し、行数を出す（`limit` を超えるときと、`query` に使わないキー（`measures` など）があるときは注意。`--values` では最初の行を `model` の列のまま出す）

SQL を流すのは、ブラウザと同じ DuckDB-wasm（Node で動かす）です。xlsx は画面と同じく DevBI が読み、`read_api` は `api/` の SQL を接続先で流します（`devbi-serve` と同じく、環境変数とプロジェクトの `.env`・`.env.local` の `DEVBI_DB…`。Vite の `.env.[mode]` は読みません）。ブラウザと同じく、データのファイルは `read_csv('data/…')` のように `read_` の関数に書いたものだけを読みます（`FROM 'data/x.csv'` はエラー）。

```
$ pnpm check
models/sales.metrics.yaml: 6,044 行、指標 7・軸 4
dashboards/sales.dash.json: タイル 14（クエリを実行 9、date-range の最初の期間: 受注日 2026年度（2026-04-01〜2026-10-30））
  kpi-revenue 1 行、kpi-avg 1 行、monthly 7 行、region 0 行、vs-last-year 7 行、…
  kpi-qty・products: quantity のエラーのため確かめていません

✗ models/sales.metrics.yaml: 指標 quantity: Binder Error: Referenced column "数" not found in FROM clause!
    Candidate bindings: "数量", "商品", "地域"
✗ dashboards/sales.dash.json: タイル kpi-orders（受注件数）: 指標 orderz は sales にありません（sales の指標: revenue・orders・quantity・…）
⚠ dashboards/sales.dash.json: タイル region（地域別売上）: 結果が 0 行です（date-range の最初の期間 受注日 2026年度（2026-04-01〜2026-10-30） で。query.filters や指標の式を確かめてください）

エラー 2 件、注意 1 件
```

- ✗（エラー）は、そのままだと画面でエラーになるもの。⚠（注意）は、表示はできるが見直したいものと、確かめられなかったもの
- 一つの間違いは一つのエラーにします。エラーのある指標を使う指標（`revenue / orders` や `of: revenue`）、エラーのある time の列を使う比較・累計の指標、それらを使うタイルは、「… のエラーのため確かめていません」とだけ出します。`model` が 0 行のときの注意も、指標ファイルに 1 つだけです
- DuckDB のエラー（`Binder Error` など）は DuckDB の英語のままです。`Candidate bindings` は、近い名前の列の候補です
- 期間は `date-range` の最初の期間だけです（`default` がない・`all` なら全期間）。ほかの期間を選んだときの数字と、ほかのタイルのクリックでの絞り込みは確かめません
- データセットのタイル（`query.dataset`）は、パラメーターの値でデータベースから読むので、流しません（行数の代わりに「データセット … を読むタイル」と出します）。`api/` と `dashboards/` があれば、`models/` のないプロジェクトでも動きます
- データベースにつながるときは、データセットの結果の列をデータベースに聞いて（[`pnpm gen`](#データセットの行の型) と同じく、行は読みません）、表の `options.columns`・`options.groupBy`・`options.click` の列の名前（エラーはタイルに）と、SQL の `-- key:` の列の名前（エラーは SQL ファイルに 1 回）を確かめます。タイルの行は「列 6 個の名前はデータベースに聞いて確かめました。」のようになります。つながらないとき（接続先がない、つなげない、20 秒たっても答えない）は名前を確かめず、「データベースにつながらないため、列の名前は確かめていません。」と出します（同じ接続先のほかのデータセットには、もう聞きに行きません）。SQL が間違っていてデータベースが答えないときは、その SQL ファイルに注意を 1 回出します
- 確かめないもの: 接続先がないときの `read_api`（注意）、URL のデータ、DuckDB の拡張（Parquet、JSON、`current_date` の icu など）をインターネットから取ってこられないときのその SQL（注意）、Node で読み込めない自作タイル（`window` を読むなど。プロジェクトの vite.config も使わないので、そこでの設定が要るものも。注意）、自作タイルが `query` の外で読むデータ、見た目（色・幅・高さ）

`--values` を付けると、タイルごとに、結果の最初の行を画面と同じ書式で出します。作ったダッシュボードの数字を、人が知っている数字や `devbi-inspect --sql` で別に数えた数字と比べるときに使います。

```
$ pnpm check -- --values 2
dashboards/sales.dash.json: タイル 14（クエリを実行 12、date-range の最初の期間: 受注日 2026年度（2026-04-01〜2026-10-30））
  kpi-revenue: 売上 ¥48,052,590、売上 前年 ¥48,138,860、売上 前年比 99.8%
  monthly 7 行:
    受注日 2026年4月、売上 ¥7,329,090
    受注日 2026年5月、売上 ¥7,855,210 …
```

### 行レベル制御のプロジェクトを確かめる

[行レベルのモード](#行レベルのモード絞り忘れを止める)のプロジェクトでは、データを読むのにログインした人が要ります。`devbi-check` は、`vite.config.ts` の [`devUsers`](#開発サーバーでこの人として見るdevusers) に書いた人ごとに、その人としてデータを流します（`--as suzuki` なら、その人だけ）。

```
$ pnpm exec devbi-check --dir e2e/rls --config e2e/rls.vite.config.ts
行レベルのモードです（access/ フォルダがあるため）。データを yamada・suzuki・sato として流しました
models/my_sales.metrics.yaml（yamada として）: 2,322 行、指標 2・軸 2
models/my_sales.metrics.yaml（suzuki として）: 1,325 行、指標 2・軸 2
models/my_sales.metrics.yaml（sato として）: 確かめていません（sato は API の orders を読めません: 利用者 sato に属性 region がありません（api/orders.sql の :user.region））
dashboards/my-sales.dash.json（yamada として）: タイル 3（クエリを実行 2）
  kpi-revenue 1 行、region 1 行
…

⚠ models/my_sales.metrics.yaml: sato として: 確かめていません: sato は API の orders を読めません: 利用者 sato に属性 region がありません（api/orders.sql の :user.region）

エラー 0 件、注意 1 件
```

- 最初の行に、行レベルのモードになったわけと、だれとして流したかを出します。人ごとに結果が違うので、指標ファイルとダッシュボードの行は人ごとに出します（`date-range` の最初の期間も、その人の行の最終日から数えるので人ごと）。エラーと注意は、一部の人だけのものに「sato として: 」を付けます（全員に出たものは 1 回）
- `devUsers` は、今のフォルダかプロジェクトのフォルダの `vite.config.*` の `devbi()` のうち、`--dir` のフォルダを指すもの（`devbi({ dir })` を Vite の root から）から読みます。ほかの名前や場所の設定ファイルは `--config` で指します。`devUsers` がないときはデータを読まず、指標ファイルとタイルは「確かめていません」（注意）です。ファイルの検査（下）はします
- その人が読めない SQL（`:user.region` の属性がない、`-- roles:` にない役割）は、その人の「確かめていません」の注意です。画面では、その人に 403 が出ます
- 行レベルのモードでの検査（データベースは使いません）:
  - だれにどの行を見せるかが書いていない `api/*.sql`（`:user.` も `-- access: all` もない）と、`:user` だけの名前はエラーです
  - `:user_id`・`:login`・`:社員番号` のような、ログインした人の値らしい名前のふつうのパラメーターは注意です。ブラウザが値を変えられるので、`:user.id` か `:user.<属性>` を使います
  - `model` が `read_api` の外のファイル（`read_xlsx('data/…')` など）を読むときは注意です。だれが開いても同じ行が届きます（マスタなら問題ありません）
  - `snapshots/` と `dist/snapshots/` に、今は作らないスナップショットのファイル（人で絞るようになった SQL の全員の行、`-- snapshot:` を消した SQL のものなど）があればエラーです（行レベルのモードでなければ注意）。`devbi-serve` か `devbi-snapshot` を動かすと消えます。IIS などに写したものは、写し先からも消します
- 二人以上として読めたときは、`:user.` を使う SQL（パラメーターのないもの）、`model` の `read_api`、ダッシュボードの最初の画面のデータセットを、人ごとに流して比べます。その人の値をくり返すだけの列（`SELECT :user.region AS 地域, …`）を除いて、全員に同じ行を返したら、その SQL に注意を出します（`:user.` を書いたのに `WHERE` で絞っていないなど。属性の値が同じ人どうしや、絞っても同じ行になるときは問題ありません。全員 0 行のときは比べません）
- `--url https://intra.example.com/devbi/` を付けると、置いた先の `api/schema` に、ログインせずに聞いて、API が行レベル制御を知っているか（`"access": 1`）を確かめます。DevBI の `401`（`{ "error": "ログインしていません", "access": 1 }`）なら、行レベルのモードで動いています。行レベルのモードのプロジェクトで、ログインしていない人に SQL の一覧を返したら、置いた先は行レベルのモードで動いていない（新しい `api/*.sql` を置いていない、ホストがログインした人を渡していない、など）ので、エラーです。知らない古い API（アプリにコピーしたままの C# など）は、行レベルのモードならエラー、そうでなければ注意です。DevBI の答えでないとき（サイトのログインの画面や、ほかのログインの `401` が返るなど）、つながらないとき（20 秒まで待ちます）は注意です。サイトのログインが要る場所は、`devbi-check` からは聞けません

`devbi-check [--dir <フォルダ>] [--values [行数]] [--as <devUsers の名前>] [--config <vite.config.ts>] [--url <置いた場所>] [--json]`:

| オプション | 中身 |
| --- | --- |
| `--dir` | `models/` のあるフォルダ。既定は今のフォルダ |
| `--values` | タイルごとに結果の最初の行を、画面と同じ書式で出す。既定は 5 行（`--values 1` で 1 行） |
| `--as` | `devUsers` のこの人としてだけデータを読む。行レベルのモードでは、付けなければ `devUsers` の全員 |
| `--config` | `devUsers` を読む Vite の設定ファイル。既定は今のフォルダかプロジェクトのフォルダの `vite.config.*` |
| `--url` | 置いた先の API が行レベル制御を知っているかを確かめる（上） |
| `--json` | 結果を JSON で出す。`findings`（`{ level: "error" \| "warning", file, message, as? }` の一覧。`as` は一部の人だけに出たときのその人たち）、`views`（指標ファイルごとの行数）、`tiles`（タイルごとの行数か、流さなかったわけ。`--values` なら `values` に最初の行）、`periods`（ダッシュボードごとの、流した期間の一覧）。行レベルのモードでは `rowLevel`（モードになったわけ）と `as`（流した人）、`views` と `tiles` にも `as`。二人以上なら、期間は `periodsAs`（人ごとの `periods`）で、`periods` は空。`--url` なら `url`（`{ url, access, status, note }`） |

エラーがあれば終了コード 1、注意だけなら 0 です。フォルダに `models/` がないときや、確かめること自体ができなかったとき（DuckDB が動かないなど）は 2 です。

### データの中を見る（devbi-inspect）

`pnpm inspect -- <ファイル>`（中身は `devbi-inspect`）が、データのファイルの列を出します。metrics.yaml を書く前に、列の名前と型、どんな値が入っているかを見ます（Excel を開けない AI にも使えます）。

```
$ pnpm inspect -- data/sales.xlsx
data/sales.xlsx（シート「明細」の A1:I6045）: 6,044 行、9 列
  シート: 明細・メモ（ほかのシートは --sheet <名前>）

受注日: DATE、2024-04-01 〜 2026-10-30、672 種類
顧客: VARCHAR、40 種類
  多い値: 青葉工業 (276)、三河工業 (256)、青葉商事 (244)、…
数量: BIGINT、1 〜 40、40 種類

最初の 10 行（6,044 行のうち。--rows <数> で変えられます）:
受注日 | 受注番号 | 顧客 | …
2024-04-01 | J10001 | 青葉商事 | …
```

- 列ごとに、`model` の SQL から見える型（xlsx は DevBI の読み方で決まる型）、範囲（文字の列は出さない）、種類の数、空のセルの数。文字と真偽の列は、多い値とその行数。そのあとに最初の行
- Excel は、読んだセルの範囲（見出しの行から）も出します。値のある列の半分以上に見出しがないとき（表の上の表題の行を見出しとして読んだとき。見出しも値もない列は数えない）は ⚠ を出し、`--range` で読む範囲（`A2:K` など）を示します
- ファイルの代わりに指標ファイルの名前（`pnpm inspect -- sales`）か、そのパス（`models/sales.metrics.yaml`。`models/` の外のものも）を書くと、その `model` の SQL の結果の列を出します。データのパスはプロジェクトからです
- `--sql "SELECT …"` で、ファイルの代わりに SELECT の結果を出します。`model` と同じく `read_xlsx('data/…')` などでデータを読みます。ファイルを書く前に型の直し方を試すときや、数字を別に数えて確かめるときに使います（`pnpm inspect -- --sql "SELECT 地域, SUM(金額) AS 売上 FROM read_xlsx('data/sales.xlsx', sheet = '明細') GROUP BY 1"`）
- ファイルは、今のフォルダからのパスか、プロジェクトのフォルダからのパスで書きます。プロジェクトの外のファイルも読めます。xlsx・CSV・TSV・Parquet・Arrow・JSON（Parquet と JSON は DuckDB の拡張をインターネットから取ってきます）
- 値がそのまま出ます。人に渡すときは気をつけてください（`pnpm try-xlsx` は値を出しません）

`devbi-inspect <ファイル | 指標ファイル> [--sheet <シート名>] [--range <セル範囲>] [--values <数>] [--rows <数>] [--as <devUsers の名前>] [--config <vite.config.ts>] [--dir <フォルダ>] [--json]`、`devbi-inspect --sql "<SELECT>" [...]`:

| オプション | 中身 |
| --- | --- |
| `--dir` | プロジェクトのフォルダ。指標ファイル、データ、`.env` をここから読む。既定は今のフォルダ |
| `--sheet` | Excel のシート。既定は最初のシート |
| `--range` | Excel の読むセルの範囲。`read_xlsx` の `range` と同じ（`A3:K`） |
| `--sql` | ファイルの代わりに、この SELECT の結果を見る |
| `--values` | 文字の列に出す多い値の数。既定は 8。0 で出さない |
| `--rows` | 出す最初の行の数。既定は 10。0 で出さない |
| `--as` | 行レベルのモードで、`model` の `read_api` を `devUsers` のこの人として読む（[`devbi-check` と同じ](#行レベル制御のプロジェクトを確かめる)）。付けないと、`read_api` の指標ファイルは読めません |
| `--config` | `devUsers` を読む Vite の設定ファイル（`devbi-check` と同じ） |
| `--json` | 結果を JSON で出す（`head` に最初の行、`notes` に ⚠ の中身） |

読めないときは終了コード 1 です。

## AI に作らせる（AGENTS.md）

`create-devbi` で作ったプロジェクトと `examples/sales` には、AI がダッシュボードを作るときの作業手順 `AGENTS.md` があります。Codex・Cursor など多くの AI が読み、Claude Code は `CLAUDE.md`（中身は `@AGENTS.md` の読み込み）から読みます。AI に「data/ の Excel から〇〇のダッシュボードを作って」と頼むと、この手順で進みます。

1. 調べる: `inspect` でデータの列と値と最初の行を見て（Excel の表の上の表題の行は `--range` で飛ばす）、今の `models/`・`dashboards/` を読み、`check` で今の状態を知る。型の直し方は `inspect --sql` で試す
2. 方針を伝える: 指標ファイル（読むデータ、日付の列、軸、指標）とタイルの並びを先に示す。データから決められないこと（何を数えるか、平均の対象、空欄の扱い、どの日付で期間を区切るか、年度の始まりなど）は、聞くことと置いた想定を並べる。答えがないと作れないときだけ、書かずに質問で終える
3. 書く: 書き方の決まり（`read_` の関数で読む、`time` は日付に、前年比は `compare` で、12 列のグリッドの並べ方の目安、自作タイルは最後の手段、など）に従う
4. 確かめる: `check` のエラーがなくなるまで直し、`check --values` でタイルの数字を見て、主な数字を `inspect --sql` で別に数えて比べる。作ったファイル・`check` の結果・`dev` で見てほしいところと出るはずの数字・置いた想定を伝える

- 手順の中のファイルの書き方は、`node_modules/devbi/docs/reference.md`（このリファレンスと同じもの。`devbi` のパッケージに入っていて、入れた版に合う）を見るように書いてあります
- プロジェクトに合わせて書き足してかまいません（データの意味、社内の言葉、ダッシュボードを見る人など）。`create-devbi` の版を上げても `AGENTS.md` は書き換わりません
- コマンドは作ったときのパッケージマネージャーに合わせてあります（`npm run check`、`pnpm check` など。Yarn は `yarn run check`。Yarn 1 の `yarn check` は Yarn 自身のコマンドのため）。`check` と `inspect` の引数は `--` のあとに書きます（`npm run inspect -- data/x.xlsx --sheet 明細`）

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

「ファイル出力」の「Excel」で書き出すと、同じ書式が Excel の表示形式になります（[書き出し](#excel)）。CSV には書式を付けません（[CSV](#csv)）。

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
| `extensionRepository` | DuckDB の拡張（Parquet・JSON・`current_date` などの ICU）を取りに行く場所。社内のサーバーに置いた拡張を使うとき。ブラウザは `<場所>/v2.0.0/wasm_eh/<名前>.duckdb_extension.wasm` を読む。相対パスはページではなく `assets/` から数えるので、サーバーの根元からのパス（`/sales/duckdb-ext`）か URL で書く（[社外に出られないネットワーク](deploying.md#社外に出られないネットワーク)） |
| `embed` | `true` で、ビルドのときに `devbi-embed.js` も作る（[ほかのアプリの画面に埋め込む](#ほかのアプリの画面に埋め込む)）。`base` は `"./"` にしておく（`/` で始まると警告）。既定は `false` |

- `virtual:devbi` は、検証済みのダッシュボードと指標、自作タイル、DuckDB-wasm のファイルの URL を `<DevbiApp>` に渡す形で出します。[`explore`](#探索explore) のタイルか自作タイル（`component`。「コードにする」で書き出した explore もこれ）のあるダッシュボードがあるとき（と開発サーバー）は、Perspective の WebAssembly の URL も入れます（ビルドでは、そのときだけ `dist/` に入ります。ブラウザが読むのは explore のタイルを出すときだけ）。TypeScript の型は tsconfig の `"types"` に `"@devbi/vite/client"` を足すと入ります。
- 開発サーバーでは、dash.json・metrics.yaml・data/・api/ のファイルを保存したときと、`dashboards/` に自作タイルのファイル（`.tsx`・`.jsx`）を足したり消したりしたときに、ページを読み込み直します（GUI エディタで編集中は[別の動き](#ほかで書き換えたとき)）。自作タイルのファイルを直したときは、Vite（React）の決まりどおりです（`export const query` のあるファイルは、ページを読み込み直します）。
- プロジェクトに `@devbi/editor` が入っていると、開発サーバーでだけ [GUI エディタ](#gui-エディタdevbieditor)を付けます（`vite.config.ts` や `main.tsx` は変えなくてよい）。ビルド、`vite preview` には入りません。
- 開発サーバーでは、npm から入れた `@devbi/editor`・`devbi`・`@devbi/react` を、Vite の `optimizeDeps.include` に足して先にまとめます（エディタを開いたときや、「コードにする」で書き出したファイルを読んだときに、Vite が新しい依存を見つけてページを読み込み直さないように）。DuckDB-wasm も、ほかと同じく先にまとめます（`optimizeDeps.exclude` に入れると、npm で入れたときは集計が動かず、pnpm で入れたときは開けません）。
- 開発サーバーとビルドの開始時、metrics.yaml と `api/` の SQL を保存したときに `.devbi/` を書き直します（[エディタでの補完と型](#エディタでの補完と型pnpm-gen)）。開発サーバーは、データセットの列もデータベースに裏で聞きます（[データセットの行の型](#データセットの行の型)）。
- コマンド `devbi-gen` と、同じことをする関数 `generate(dir, { check?, describe?, api?, env? })` も入っています（`describe` は `"all"`・`"changed"`・`false`。結果の `unasked` に、列を聞けなかったデータセットとわけ）。
- コマンド [`devbi-check`](#ファイルを確かめるdevbi-check) と [`devbi-inspect`](#データの中を見るdevbi-inspect) も入っています（DuckDB-wasm を Node で動かすので、`@duckdb/duckdb-wasm` と `apache-arrow` に依存します）。
- ビルドでは、`model` が読むデータのファイルを `dist/` にコピーします。`base: "./"` にしておくと、`dist/` をどのフォルダに置いても動きます。`api/` の SQL はコピーしません。
- `api/` があると、開発サーバーと `vite preview` に読み取り API を付けます（[データベースから読む](#データベースから読むdevbiserver)）。`snapshots/` の下の `.arrows`（`devbi-serve` が `dist/snapshots/` に作ったものなど）は、API からだけ返し、静的なファイルとしては配りません。`api/` は起動したときにあるかを見るので、あとから作ったときは起動し直します。接続先は環境変数か、Vite のやり方で読む `.env` ファイル（Vite の `envDir`、ふつうは root の `.env`、`.env.local`、`.env.[mode]`）の `DEVBI_DB…` から読みます。
- `api/` の SQL の先頭の `-- snapshot:` の行を読み、どの SQL を[スナップショット](#毎朝のスナップショット)から読むかを `virtual:devbi` に入れます（SQL の中身は入れません）。開発サーバーと `vite preview` は、スナップショットのファイルを保存せず、聞かれるたびにデータベースから読んで返します。
- 開発サーバーと `vite preview` の読み取り API は、知らない `Host`（IP・localhost・`server.allowedHosts` / `preview.allowedHosts` 以外の名前）の要求に答えず、Vite の確認（403）に回します（ほかのサイトが自分の名前をこのパソコンに向けて API を読む DNS rebinding を防ぐ）。
- 開発サーバーは、`api/` の SQL、`access/` のファイル、SQLite のファイル（`*.sqlite`、`*.sqlite3`、`*.db` と、`DEVBI_DB…` の `sqlite:` が指すファイル）をブラウザに渡しません（Vite の `server.fs.deny` に足します。`.env` は Vite がもとから渡しません）。
- `devUsers`（`{ 名前: { id?, roles?, attrs? } }`）を書くと、開発サーバーの画面で、だれとして API を読むかを選べます（[開発サーバーで、この人として見る](#開発サーバーでこの人として見るdevusers)）。

## GUI エディタ（@devbi/editor）

開発サーバー（`vite`）の画面で、タイルを並べて dash.json に保存します。ビルドには入りません。

```sh
pnpm add -D @devbi/editor
```

入れると、`@devbi/vite` が開発サーバーでだけ読み込み、`<DevbiApp>` の見出しの右に「編集」と「＋ 新しいダッシュボード」が出ます。設定は要りません。

タイルを押すと、右の設定欄（プロパティパネル）に、そのタイルの種類・見出し・データ（指標・軸・期間の単位・絞り込み・並び順・件数）・表示の設定が出ます。何も選んでいないときは、ダッシュボードの見出し・説明・指標ファイルです。組み込みのタイルで足りない表示は、設定欄の「[コードにする](#コードにする)」で `.tsx` のファイルに書き出し、React で描けます。

### できること

| すること | やり方 |
| --- | --- |
| タイルを動かす | タイルをドラッグ。行き先にあるタイルは押し下げられ、空いた行には下のタイルが上がる |
| 大きさを変える | タイルの右端・下端・右下の角をドラッグ。列と行の単位で変わる |
| タイルを足す | 「＋ タイルを追加」で種類を選ぶ。いちばん下に、種類ごとの大きさで置く。最初からデータが出るように、指標ファイルの最初の指標を、時間の列があれば月別（なければ最初の軸別）で出す |
| タイルを消す | タイルの右上の ×。またはタイルを押して選び、Delete（設定欄やボタンを押したあとの Delete では消さない）。設定欄の「このタイルを消す」でも |
| タイルの設定を変える | タイルを押す。右の設定欄で変えると、そのタイルにすぐ出る（[設定欄](#設定欄プロパティパネル)） |
| ダッシュボードの設定を変える | タイルの間を押すか、設定欄の「ダッシュボード全体」。見出し・説明・指標ファイル |
| コードにする | タイルを押し、設定欄の「コードにする…」→「書き出す」。`dashboards/<ダッシュボード>/<名前>.tsx` に書き出し、タイルはそのファイルで描く（[コードにする](#コードにする)） |
| 元に戻す / やり直す | ボタンか ⌘Z / ⇧⌘Z（Windows は Ctrl+Z / Ctrl+Y）。100 回まで |
| 保存 | 「保存」か ⌘S（Windows は Ctrl+S） |
| 閉じる | 「閉じる」。保存していない変更があれば、保存するか捨てるかを聞く |
| 新しいダッシュボード | 「＋ 新しいダッシュボード」で、ファイル名（半角の英数字と `-` `_`）、見出し、指標ファイルを決める。`dashboards/<ファイル名>.dash.json` ができ、そのまま編集に入る |

編集中もタイルはデータを出したままです。クリックはタイルを選ぶのに使うので、クロスフィルタはしません（期間のタイルの最初の期間は効きます）。タイルを並べる部分の幅が 640px より狭いと編集できません。窓の幅が 940px 以下では、設定欄は画面の下に重なって出ます。

新しいタイルの種類ごとの大きさ（列 × 行、12 列のとき）: `kpi` 3×2、`bar`・`line`・`area` 6×4、`barlist` 4×4、`table` 12×5、`pivot` 8×5、`explore` 12×6、`select` 3×5、`date-range` 12×1、`markdown` 12×2。

### 設定欄（プロパティパネル）

| 欄 | dash.json に書くもの |
| --- | --- |
| 種類 | `type`。データを使う種類どうしなら `query` はそのまま（`explore` と、ほかのデータを使う種類の間では、`query` の `metrics`・`filters`・`period` だけを残し、ほかは新しいタイルと同じに）。`date-range`・`markdown` にすると `query` を消し、データを使う種類に戻すと、新しいタイルと同じ `query` から始める。`options` は新しい種類にもあるものだけ残し、ほかは新しいタイルと同じ。タイルが自分の指標ファイルを使っていれば、`query.metrics` と `date-range` の `options.metrics` の間で引き継ぐ |
| 見出し | `title`。空にするとキーを消す |
| 名前（id） | `id`。Enter を押すか、欄を出たとき（ほかのタイルを押したときも）に変わる。空や、ほかのタイルと同じ名前にはできない |
| データの元 | 表（`table`）で、`api/` に SQL があるときだけ。「指標ファイル（集計する）」か「データセット（api/ の SQL）」（[データセットを読むタイル](#データセットを読むタイルquerydataset)）。データセットにすると `query` を `{ "dataset": "<名前の順で最初のデータセット>" }` にし、指標ファイルに戻すと `query` を新しいタイルと同じに、`options` の列・グループ・合計・検索・行のクリックを消す |
| データセット | `query.dataset`。ほかのデータセットにすると、`query.params` と、`options` の `columns`・`groupBy`・`click`（前のデータセットのパラメーターと列の名前）を消す。パラメーターは名前を出すだけで、値はダッシュボードの欄で変える（タイルだけの値や欄の名前は `query.params`、SQL と `-- param:` は `api/<名前>.sql` で書きかえる） |
| 列（データセット） | `options.columns` と `options.groupBy`。開発サーバーの [`api/describe`](#api-の形) で、データベースに結果の列（名前とデータベースの型）を聞いて並べる。チェックで出すか（全部外すことはできない）、↑ で 1 つ前へ、⋯ で列の見出し `label`・数の書式 `format`・集計 `agg`・はじめは隠す `hidden`・グループ（`groupBy` に足す・外す。出していない列でも）。チェックを外すと `columns` から消える（その列の見出しなどは、設定欄でほかのタイルを選ぶまでは、チェックし直すと戻る）。全部の列を SQL の順で何も書かないときは `columns` を消す。「全部の列を SQL の順に戻す」でも消す。`columns` に書いて結果にない列は「（結果にありません）」と出るので外す。データベースが答えないときは、わけと「もう一度」を出し、`options` の `columns`・`groupBy` に書いてある列だけ並べる（`columns` がなければ、答えるまで列は選べない）。書いてある列は、キーの順もそのまま（足したキーはいつもの順に入る）。`width`・`style` などほかのキーも残す（「表示」の「列」の JSON で書く） |
| 書き方 | 「指標と軸を選ぶ」「Malloy で書く」「SQL で書く」。Malloy か SQL にすると、`query` の指標・軸・期間の単位・並び順・件数を消し、`query.malloy`（`query.sql`）に、指標ファイルの最初の軸ごとの件数（時間のグラフなら月ごと）を数えるクエリを書く。戻すと、新しいタイルと同じ指標と軸から始める（クエリが読んでいた指標ファイルがダッシュボードのものでなければ、`query.metrics` に書く）。`explore` では出ない |
| Malloy / SQL | `query.malloy` / `query.sql`。欄を出たとき（⌘Enter、⌘S、ほかのタイルを押したときも）に書き、タイルに出る。間違いはタイルに出る。空にはできない |
| 指標ファイル | `query.metrics`（指標ファイルが 2 つ以上あるときに出る）。「ダッシュボードと同じ」でキーを消す。Malloy・SQL では「絞り込みとクリックの指標ファイル」（2 つ以上を読むとき） |
| 指標 / 軸 | `query.measures` / `query.dimensions`。チェックした順に並び（横の数字が順番）、↑ で 1 つ前へ。最初のものがタイルの主役（KPI の大きな数字、ランキングの軸など）。指標ファイルにない名前は「（ありません）」と出るので外す |
| 期間の単位 | `query.time`。日・週（月曜始まり）・月・四半期・年・年度。「分けない」でキーを消す |
| 期間で絞るか | `query.period`。「絞らない（いつも全期間）」で `false`、「絞る」でキーを消す。指標ファイルに `time` があるときに出る |
| 絞り込み | `query.filters`。軸は、データにある値から選ぶ（`in`。9 件以上で検索欄）。時間の列は、始まりの日と終わりの日（終わりの日を含む。ファイルには次の日を書く: `between` は 始まり ≦ 値 ＜ 終わり）。値を 1 つも選んでいない・日付がない絞り込みは書かない（欄は「やめる」まで残る）。ほかの形の絞り込みは書いたまま見せ、消すことだけできる |
| 並び順 | `query.sort`。結果の列（選んだ指標・軸・時間）から。大きい順は `"-revenue"` のように先頭に `-` |
| 件数 | `query.limit`。空でキーを消す（`explore` では、空のとき 100,000 行まで） |
| 表示 | `options`。種類ごとの設定（`pivot` の列にする項目・合計の行と列、`select` の複数選べる、`date-range` の最初の期間・指標ファイル、`markdown` の本文、`explore` の最初の並べ方）。「既定」でキーを消す。`explore` の最初の並べ方は JSON で書き、欄を出たとき（ほかのタイルを押したとき、⌘S のときも）に、`{ }` の形の JSON なら書きます。書くと、タイルはその並べ方で始め直します（読めないときは、そのわけを欄の下に出し、ファイルは変えません。空にするとキーを消す） |
| ダッシュボード | 見出し `title`、説明 `description`、指標ファイル `metrics` |

- 変えると、そのタイルにすぐ出ます。集計し直すのは変えたタイルだけで、期間などの選択はそのままです（期間のタイルの「最初の期間」を変えたときは、その期間から始め直します）。
- 見出しなどの文字・数・日付の欄は、打ち始めてから欄を出るまでが 1 回の「元に戻す」です。
- キーを足すときは、手で書くときと同じ場所に入れます（タイルは `id`、`x`〜`h`、`type`、`title`、`query`、`options` の順、`query` は `metrics`、`measures`、`dimensions`、`time`、`filters`、`sort`、`limit`、`period`、`malloy`、`sql`、`dataset`、`params` の順。データセットの表の列は `field`、`label`、`format`、`width`、`align`、`pin`、`hidden`、`filter`、`agg`、`style` の順）。ファイルにあるキーは動かしません。
- タイルにデータが出ないとき（指標も軸もない、名前が指標ファイルにない、など）は、そのわけを設定欄の「データ」の下にも出します。指標も軸も外したときは `"query": {}` を残します（タイルがわけを出すように）。
- `explore` のタイルでは、データの欄は指標ファイル・期間で絞るか・絞り込み・件数だけです（指標・軸・期間の単位・並び順は使わないので出しません。ファイルに書いてあれば、そう出して「消す」で消せます）。
- 自作タイル（`component`）は、見出しと名前だけ変えられます（中身とデータの指定は、そのファイルで変えます）。

### コードにする

組み込みのタイルを、[自作タイル（JSX）](#自作タイルjsx)のファイルに書き出します。書き出した直後は組み込みのタイルで描くので、見た目は変わりません。そこから、そのファイルを VS Code や Claude Code で書き換えて、組み込みのタイルにない表示にします。

```tsx
// 「地域 × 四半期」のタイル。GUI エディタの「コードにする」で、組み込みのクロス集計から書き出したもの。
// このタイルのデータと描き方は、このファイルで変える（GUI で変えられるのは、位置・大きさ・見出し・名前）。
// 自作タイルの書き方: https://github.com/ishibashi0112/devbi/blob/main/docs/reference.md#自作タイルjsx
import { builtinTiles } from "@devbi/react";
import { defineQuery, type RowOf, type TileProps } from "devbi";

// 何を出すか（SQL は書かない）。指標と軸の名前は models/sales.metrics.yaml のもの
export const query = defineQuery({ measures: ["revenue"], dimensions: ["region"], time: "quarter" });

// クロス集計の設定（dash.json の "options" に書いていたもの）
const options = { columns: "受注日" };

// いまは組み込みのクロス集計で描いている
const Builtin = builtinTiles.pivot.component;

export default function RegionQuarter(props: TileProps<RowOf<typeof query>>) {
  // 自分で描くときは、下の return を書き換える。props.rows が集計済みの行（ほかのタイルの選択で絞ったもの）で、
  // 列は 受注日（四半期ごと）、region（地域）、revenue（売上）。例:
  //   return (
  //     <ul>
  //       {props.rows.map((r, i) => (
  //         <li key={i}>{props.format(r.受注日, "受注日")} {props.format(r.revenue, "revenue")}</li>
  //       ))}
  //     </ul>
  //   );
  // 値の書式は props.format、クリックでほかのタイルを絞るのは props.select。
  return <Builtin {...props} tile={{ ...props.tile, options }} />;
}
```

- ファイルは `dashboards/<ダッシュボードのファイル名>/` に、タイルの名前（id）を PascalCase にした名前で書きます（`region-quarter` → `RegionQuarter.tsx`。英数字がない名前は `KpiTile.tsx` のように種類から）。同じ名前のファイルがあれば `RegionQuarter2.tsx` のように次の名前にし、ほかのファイルを上書きすることはありません。
- dash.json のタイルは、`type`・`query`・`options` を消して `"component": "./<ダッシュボード>/<名前>.tsx"` を書きます。`id`・位置と大きさ・`title` はそのまま残り、GUI で変えられます。`query` と `options` はファイルに移ります（`query` は `defineQuery` で書くので、名前の補完と `rows` の型が付きます）。
- 書き出したら、そのままダッシュボードを保存します（保存していないほかの変更も、いっしょに保存します）。ページは読み込み直しません。保存してあるので、このあとファイルを直してページが読み込み直されても、なくなる変更はありません。
- 「元に戻す」で組み込みのタイルに戻ります（保存するまで dash.json は戻りません）。書き出したファイルは残り、同じタイルをもう一度書き出すと、内容が同じならそのファイルを使います。
- 書き出しているあいだにそのタイルを変えたときは、ファイルは書きますが、タイルはそのままにします（もう一度押すと、変えたあとのタイルで書き出します）。
- ダッシュボードのファイル名に `#` か `?` があるときは書き出せません（開発サーバーが、そのフォルダのファイルを読めないため）。
- データを使わない種類（`date-range`、`markdown`）は、`query` のないファイルになります。データが要るときは `useDevbiQuery` で集計します。
- `explore` は、`query` を export しないファイルになります（export すると集計のクエリとして読まれるため）。`query` はファイルの中の定数で、組み込みのタイルに渡します。自分で描くときは、`useDevbiRows(query, { tileId })` で明細の行（Arrow の表）を読みます。
- 書き出したファイルは、11 種類すべてで型チェック（`tsc`）が通る形です。

### 保存のしかた（git の差分）

手で書いたときと同じ形で書くので、タイルを 1 つ動かすと、そのタイルの 1 行だけが変わります。

```diff
     {
       "id": "region",
-      "x": 8, "y": 3, "w": 4, "h": 4,
+      "x": 6, "y": 3, "w": 4, "h": 4,
       "type": "barlist",
```

- キー 1 つに 1 行。タイルの `x`、`y`、`w`、`h` は 1 行にまとめる
- 1 行が 100 桁（全角の文字は 2 桁）に収まる値（`query`、`options`）は 1 行、収まらなければ中を 1 項目 1 行
- キーの順番はファイルのまま。ファイルにないキー（`columns` など）は足さない

この形で書く関数は `devbi` の `formatDashboardJson(spec)` です。リポジトリの見本の dash.json は、この関数に通しても 1 文字も変わりません。

開いたときに空いている行があると、タイルを上に詰めて表示し、そう知らせます（保存するまでファイルは変わりません）。

### ほかで書き換えたとき

| 変わったもの | 保存していない変更がないとき | あるとき |
| --- | --- | --- |
| 編集中の dash.json（VS Code、git など） | 読み込み直して「読み込み直しました」 | 知らせて、「ファイルの内容を読み込む（ここでの変更は捨てる）」か「ここでの内容で上書きする」を選ぶ。そのまま「保存」しても断られる |
| metrics.yaml・data/・api/・ほかの dash.json、`dashboards/` に足した・消した自作タイルのファイル | ページを読み込み直し、エディタが開き直る | 知らせるだけ（閉じるとページを読み込み直して反映される） |
| 自作タイルのファイルの中身 | Vite（React）の決まりどおり。`export const query` のあるファイルは、ページを読み込み直し、エディタが開き直る | ページを読み込み直す前に、ブラウザが「このページを離れますか」と聞く（離れると、保存していない変更はなくなる） |

- エディタで保存したファイルの変更では、保存したページは読み込み直しません（同じダッシュボードを開いているほかのタブは読み込み直します）。
- 編集中にファイルから読み込み直したときは、エディタを閉じるとページも読み込み直します。
- 読めないファイル（書きかけの JSON など）になったときは、画面はそのままで、読めない理由を出します。「ここでの内容で上書きする」は、読めないファイルにも書けます。
- 変更がないときの「保存」（⌘S）は何も書きません（ほかの形で手書きしたファイルを書き直さない）。
- ブラウザの「戻る」などでアドレスが変わっても、エディタは閉じません（保存していない変更は残る）。ページを読み込み直すと、そのダッシュボードのアドレスのときだけエディタが開き直ります。

### 書き込み口の守り

エディタは開発サーバーの `…/__devbi/editor/dashboards/<名前>` で dash.json を読み書きし、`…/__devbi/editor/dashboards/<名前>/tiles`（POST）で「コードにする」のファイルを書きます。

- 開発サーバー（`vite`）にだけあります。`vite preview`、`devbi-serve`、ビルドしたサイトにはありません
- 開発サーバーを動かしているパソコンからの要求にだけ答えます。`vite --host` でほかのパソコンやスマホから開いたページでは、見ることはできても保存できません（ブラウザと開発サーバーが別のパソコンになる Codespaces なども同じ）
- ほかのサイトからは書けません（専用のヘッダー `X-DevBI-Editor`、`Origin` がこの開発サーバーであること、`Host` が IP・localhost・Vite の `server.allowedHosts` の名前であることを見ます。HTTPS の開発サーバーでは、Vite と同じく `Host` は見ません）
- 書くのは `dashboards/<名前>.dash.json` だけで、ビルドと同じ検証（重なり、列数、指標ファイルと自作タイルのファイルがあるか）を通らないものは書きません。書くときは隣に一時ファイルを書いて置き換えるので、途中までのファイルを開発サーバーや VS Code が読むことはありません
- 開いたあとにファイルが変わっていたら、上書きせずに断ります（409）
- 「コードにする」で書くのは、`dashboards/<名前>/` の新しい `.tsx` だけです。中身は送られた組み込みのタイル（dash.json と同じ検証を通ったもの）から開発サーバーが作り、送られたコードを書くことはありません。見出しや指標ファイルのラベルはコメントに 1 行で入れ、`@` は全角の `＠` にします（`@jsxImportSource` のような、コンパイラーが読む指示にならないように）。あるファイルは上書きしません（2 つのタブから同時に書き出しても、別の名前になります）

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
- 同じところに `-- param:` の行（[パラメーターの型](#パラメーターの型---param)）と `-- key:` の行（[行を見分ける列](#行を見分ける列---key)）、`-- roles:` と `-- access:` の行（[利用者ごとに見える行を変える](#利用者ごとに見える行を変える行レベル制御)）も書けます。これらの行は、説明には入りません。
- `:user.region` や `:user.id` は、パラメーターではなく、ログインした人の値です（[利用者ごとに見える行を変える](#利用者ごとに見える行を変える行レベル制御)）。
- 引用符などの読み方は、接続先のデータベースに合わせます（SQLite と SQL Server の `[列名]`、PostgreSQL の `$$ … $$`）。
- ファイルを保存すると、開発サーバーではページを読み込み直します。`devbi-serve` は呼ばれるたびにファイルを読むので、止めなくても反映されます。

### パラメーターの型（`-- param:`）

SSRS のレポートのパラメーターのように、パラメーターに型・表示名・既定値・候補を付けます。ファイルの先頭のコメントに、1 つのパラメーターにつき 1 行書きます（サンプルの `examples/sales/api/order_lines.sql`）。

```sql
-- 受注の明細を、受注日と地域で絞る。
-- param: from date label=受注日（から） default=fiscal_year_start
-- param: to date label=受注日（まで） optional
-- param: regions text[] label=地域 values=regions default=all
-- key: 受注番号, 行番号
SELECT …
 WHERE o.order_date >= :from
   AND (:to IS NULL OR o.order_date <= :to)
   AND c.region IN (:regions)
```

- 形は `-- param: <名前> <型> <キー>=<値> …` です。値に空白を入れるときは `label="受注日 から"` と `"` で囲みます（`"` そのものは `""`）。`<名前>` は SQL の `:名前` と同じ（大文字と小文字は区別しない）です。
- 型を書いたパラメーターは、サーバーが値を型で確かめてから、データベースに型付きで渡します。合わない値は `400` と「パラメーター from には日付（'2024-04-01' の形の文字）を渡してください（"2024/04/01" が来ました）」のようなメッセージです。`read_api` の値も同じように確かめます。
- `-- param:` を書かないパラメーターは今までどおりです（型なし。文字・数値・真偽・null をそのまま渡す）。
- 書き方が違うと、`api/order_lines.sql（3 行目）: 型 day は使えません。…` のように、何行目の何が違うかを出します（`api/schema` のそのデータセットの `error` と、`api/query` の `400`）。SQL にない名前、型のない行、同じ名前の 2 行目、知らないキー、型に合わない既定値はエラーです。
- 名前が `user.` で始まるパラメーターは書けません（ログインした人の値のために取ってあります。大文字と小文字は問いません）。`user_id`、`username` などは使えます。
- `-- param:` と `-- key:` は、`-- connection:` と同じく、ファイルの先頭から続く `--` のコメント（空の行は入ってよい）の中に書きます。SQL や `/* … */` よりあとの行に書くと、何もしない代わりに「api/x.sql（5 行目）: -- param: は、ファイルの先頭から続く -- のコメントの中に書いてください…」のエラーになります。
- 0.1.1 までは、`-- param: …` や `-- key: …` で始まる行は、先頭なら説明の文、SQL の中ならただのコメントでした。今は指示として読む（SQL の中ではエラーになる）ので、そう書いていたら言い方を変えてください。

| 型 | 送る値 | 確かめること |
| --- | --- | --- |
| `text` | 文字 | 4,000 文字まで |
| `integer` | 数（整数） | 整数か（±9,007,199,254,740,991 まで） |
| `number` | 数 | 有限の数か |
| `date` | `"2024-04-01"` | 暦にある日付か |
| `datetime` | `"2024-04-01T09:00"`（`T` は空白でも。秒と 6 桁までの小数も書ける。時差は書かない） | 日時として読めるか。`"2024-04-01"` は 0:00 |
| `boolean` | `true` / `false` | 真偽か |

| キー | 中身 |
| --- | --- |
| `label` | 入力欄の名前。書かなければパラメーターの名前 |
| `default` | 既定値。`2024-04-01`、`10` のような値のほか、日付と日時では `today`・`tomorrow`・`yesterday`・`month_start`・`next_month_start`・`previous_month_start`・`year_start`・`fiscal_year_start` と、`today-30` のような日数の足し引き。複数の値では `関東,近畿`（`,` 区切り）と、候補（`values`）があれば `all`（候補の全部） |
| `values` | 候補の一覧を出すデータセットの名前（`api/regions.sql` なら `regions`）。1 列目が値、2 列目（あれば）が表示名 |
| `optional` | 空でもよい（`null` を受け付け、データベースには NULL を渡す）。書かなければ `null` は `400` |
| `hidden` | 入力欄を出さない |

`label`・`default`・`values`・`hidden` は、ダッシュボードの入力欄（[パラメーターの欄](#パラメーターの欄)）のためのものです（サーバーは `api/schema` に出すだけで、既定値を入れることはしません。値はいつも送る側が渡します）。

**複数の値**: 型に `[]` を付ける（`text[]`、`integer[]` など）と、値を配列で受け取ります（1 つの値だけ送ると、1 つの値の配列として読みます）。SQL では `IN (:regions)`（`NOT IN` も）の形でだけ使えます（ほかの場所に書くとエラー）。サーバーは値の数だけプレースホルダーを並べ（`IN (?, ?, ?)`）、値はすべてパラメーターで渡します。

- 1 つも選ばないことはできません（空の配列は `400`）。`optional` も付けられません。
- 1 つのパラメーターに 1,000 個まで、1 つの SQL の全体で 2,000 個まで（MySQL と SQLite は、同じパラメーターを 2 か所に書くと 2 つ分に数えます）です。超えるときは、候補を絞るか、「すべて」のときはこのパラメーターを使わない SQL にします。
- 「すべて」を候補の値の全部で送ると、その列が NULL の行と候補にない値の行は出ません。NULL の行も出したいときは、複数の値にせず、`optional` の 1 つの値で `(:customer IS NULL OR c.id = :customer)` と書きます。
- `read_api` からは配列を渡せないので、`read_api('order_lines', regions = '関東')` のように 1 つの値で読みます。

**データベースへの渡し方**: 日付と日時は `YYYY-MM-DD` と `YYYY-MM-DD HH:MM:SS` の文字で渡し、SQL の側で日付として読みます。データベースやセッションの日付の書き方の設定によらず同じに読めます。

| データベース | 型を書いたパラメーターの書き換え |
| --- | --- |
| PostgreSQL | どの型も `CAST($1 AS date)`（`timestamp`、`bigint`、`numeric`、`text`、`boolean`）。型の決まらない場所（`:customer IS NULL OR …`）でも「could not determine data type」にならない。`uuid` や列挙型の列と比べるときは `CAST(:id AS uuid)` か `id::text = :id` と書く |
| SQL Server | 日付は `CAST(@p1 AS date)`、日時は `CAST(@p1 AS datetime2)`。ほかは今までどおり |
| Oracle | 日付は `TO_DATE(:p1, 'YYYY-MM-DD')`、日時は `TO_DATE(:p1, 'YYYY-MM-DD HH24:MI:SS')`（秒の小数があるときだけ `TO_TIMESTAMP`。DATE の列の索引が使えるように） |
| MySQL / MariaDB | 日付は `CAST(? AS DATE)`、日時は `CAST(? AS DATETIME(6))` |
| SQLite | 書き換えない（日付を文字で持つため）。日時は `2024-04-01 09:00:00` の形（日付と時刻の間は空白。SQLite の `datetime()` や `CURRENT_TIMESTAMP` と同じ）で渡す。文字どうしで比べるので、列が `2024-04-01T08:00:00` のように `T` で持つときは `replace(ts, 'T', ' ') >= :since` と書くか、型を書かずに送られた文字のまま渡す。日付だけの列と日時のパラメーターは `'2024-04-03' < '2024-04-03 00:00:00'` になる |

### 行を見分ける列（`-- key:`）

```sql
-- key: 受注番号, 行番号
```

結果の 1 行を見分ける列（結果の列の名前）を `,` 区切りで書きます。名前に `,` があるときは `"行, 番号"` と囲みます。`api/schema` の `key` に出ます。表で行を選んだまま読み直したときと、サーバーでページを送る表（次の版から）に使います。

### `read_api`

```yaml
model: SELECT * FROM read_api('orders', from = '2024-04-01')
```

- 最初の引数は `api/` のファイル名（`.sql` なし）です。
- パラメーターは `名前 = 値` の形で書きます。値に書けるのは文字（`'…'`）、数値、`true` / `false`、`null` だけです。SQL のすべてのパラメーターに値が要ります。`-- param:` で型を書いたパラメーターは、その型で確かめます（`date` なら `from = '2024-04-01'`）。
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
| PostgreSQL | `postgres://user:pass@host:5432/db` | `pg` を入れる（`npm install pg`）。毎回 `BEGIN READ ONLY` の中で実行する。日付はデータベースの `DateStyle` によらず読める |
| SQL Server | `mssql://user:pass@host:1433/db` | `mssql` を入れる（`npm install mssql`）。SQL Server 認証。名前付きインスタンスは `?instance=SQLEXPRESS`（ポートを書かなければ SQL Browser で探す）、暗号化は `?encrypt=true`（サーバーの証明書も確かめるときは `&trustServerCertificate=false`。書かなければ確かめない）、Always On の読み取り用のセカンダリは `?applicationIntent=ReadOnly`。読み取り専用のトランザクションがないので、毎回トランザクションの中で実行して、必ずロールバックする |
| Oracle | `oracle://user:pass@host:1521/サービス名` | `oracledb` を入れる（`npm install oracledb`）。Thin モードで、Oracle Instant Client は要らない。11g、古い形式のパスワード、ネットワークの暗号化が必須のサーバーは `?client=thick`（Instant Client が要る。場所は `&libDir=`）。ほかのユーザーの表を名前だけで読むときは `?schema=OWNER`。毎回 `SET TRANSACTION READ ONLY` の中で実行する（データの書き換えは止まるが、表を作る・消すなどの DDL はこのトランザクションの外で確定するので止まらない） |
| MySQL / MariaDB | `mysql://user:pass@host:3306/db`（`mariadb://` も可） | `mysql2` を入れる（`npm install mysql2`）。毎回、読み取り専用のセッション（`SET SESSION TRANSACTION READ ONLY`）で実行する。データの書き換えも DDL も、データベースが断る。終わるたびに接続をリセットする（ユーザー変数や `GET_LOCK()` のロックは残らない） |

- SQLite のほかは、時間の上限（`--timeout`、既定 60 秒）を過ぎるとデータベースに止めさせ、「60 秒を過ぎたので止めました」と返します。時間は、行を受け取り終えるまでの全体で数えます。行の上限（`--max-rows`）を超えた分は、データベースから読みません（SQL に `LIMIT 1000` や `TOP 1000` のような、もっと大きい上限が書いてあっても）。

- データベースのユーザーは SELECT の権限だけにしてください。いちばん確かな守りはこの権限です。DevBI の守り（SELECT か WITH で始まる文だけ通す、読み取り専用のトランザクション）は、その手前の守りです。たとえば Oracle では、`PRAGMA AUTONOMOUS_TRANSACTION` で書き込む関数を SELECT から呼ぶと、その書き込みは確定します。
- パスワードに `@` や `:` が入るときは、`%40`、`%3A` のように書きます。
- PostgreSQL の `timestamptz` は、接続のタイムゾーンでの時刻になります。変えるときは URL に `?options=-c%20TimeZone%3DAsia%2FTokyo` を足します。
- `devbi-serve` は、SQL Server の Windows 認証（統合認証）にはまだつなげません。SELECT の権限だけの SQL Server 認証のユーザーを作ってください。Windows 認証でつなぐときは、[ASP.NET（C#）の見本](#windows-認証で-sql-server-につなぐ)を使います。
- Oracle では、引用符で囲まない列名や別名は大文字になります（`AS amount` は `AMOUNT`）。metrics.yaml の SQL（DuckDB）は大文字と小文字を区別しないので、`amount` のまま書けます。`AS 金額` のような日本語の別名は、そのままです。
- Oracle は、接続ごとに日付の書き方（`NLS_DATE_FORMAT`）を `YYYY-MM-DD HH24:MI:SS` にします。`WHERE order_date >= :from` に `'2024-04-01'` を渡せます。
- Oracle の SQL には（23ai より前は）真偽がないので、パラメーターの `true` / `false` は `1` / `0` で渡します。
- Oracle の文字のパラメーターは `VARCHAR2` として渡るので、`CHAR(5)` の列とは、後ろの空白の分だけ一致しません（`code = :code` に `'A'` を渡しても `'A    '` に当たらない）。`TRIM(code) = :code` か、`code = CAST(:code AS CHAR(5))` と書きます。
- Oracle の `DATE` と `TIMESTAMP` は、ドライバーが DevBI のサーバーのタイムゾーンで日時にしてから読むので、夏時間のある地域では、夏時間が始まるときに飛ばされる 1 時間の値が 1 時間後になります。西暦 1〜99 年の日付は 1901〜1999 年になります（日本のタイムゾーンで動かすなら、1948〜1951 年の夏時間のほかは影響しません）。
- 同じ列名が 2 つある結果（`SELECT a.id, b.id`）はエラーにします。Oracle だけは、ドライバーが 2 つめを `ID_1` にします。

列の型は次のように受け取ります。

| データベースの型 | DuckDB での型 |
| --- | --- |
| 整数（Oracle は `NUMBER(10)` のように小数の桁が 0 のもの） | `BIGINT`（`BIGINT` に収まらない値がある列は `DOUBLE`。MySQL の `BIGINT UNSIGNED` の大きな値や、Oracle の `NUMBER(30)` など） |
| 小数（`numeric`、`decimal`、`money`、`real`、`float`、`double`、Oracle の `NUMBER(10,2)` など） | `DOUBLE` |
| 真偽（PostgreSQL の `boolean`、SQL Server の `bit`、MySQL の `BIT(1)`） | `BOOLEAN` |
| 日付 | `DATE` |
| 日時（`timestamp`、`timestamptz`、`datetime`、`datetime2`、`smalldatetime`、Oracle の `TIMESTAMP WITH TIME ZONE`） | `TIMESTAMP`（ミリ秒まで。データベースでの時刻のまま、時差は付けない） |
| そのほか（文字、`json`、時刻だけの `time`、`uniqueidentifier` など） | `VARCHAR` |
| バイナリ（`varbinary`、`RAW`、`BLOB` など） | `VARCHAR`（Base64） |

- MySQL の `BOOLEAN`（中身は `TINYINT(1)`）は整数のままです。
- SQL Server の `datetimeoffset` と、Oracle の `TIMESTAMP WITH TIME ZONE`・`TIMESTAMP WITH LOCAL TIME ZONE` は、UTC での時刻になります。
- SQL Server の `sql_variant` は中身から決めます（日時が入っていれば `TIMESTAMP`）。`FOR JSON` と `FOR XML` の結果は、1 つの文字の値です。
- MySQL の `'0000-00-00'` や、月か日が 0 の日付（`sql_mode` で許したとき）は、NULL になります。
- Oracle の `DATE` は時刻も持つので、結果の値がすべて 0:00 なら `DATE`、そうでなければ `TIMESTAMP` にします。
- Oracle の桁の指定のない `NUMBER` と、計算した列（`SUM(...)` など）は、中身から決めます（すべて整数なら `BIGINT`）。

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
- 作るのは、`models/` の `read_api` で使っているものと、`dashboards/` の[レポート](#レポートパラメーターの欄とsql-の結果の表)の表と候補が、パラメーターを既定値のままで読むものです。パラメーターは `read_api` に書いた値（レポートでは既定値）で、値の組ごとに 1 つ作ります。
- レポートの表と候補は、既定値がどれも決まった 1 つの値（文字・数・真偽・`null`）のときだけ作ります。`today`・`fiscal_year_start` などの日付の言葉、`all`、複数の値があると作りません（いつもデータベースから読みます）。言葉は日によって値が変わり、`all` は候補を読むまで値が決まらないためです。パラメーターのない SQL（候補の一覧など）は 1 つ作ります。
- 中身は API の答えと同じ Arrow で、サイトの `snapshots/` に `<名前>.arrows`（パラメーターがあれば `<名前>~<16 桁>.arrows`。[ファイル名の決め方](#api-の形)）として置きます。
- ブラウザは API ではなくこのファイルを読みます。ダッシュボードの見出しの下に「データは 11月8日 6:00 の時点（毎日 6:00 に更新）」と出し、一覧には「毎日 6:00 の時点のデータ」と出します。レポートの表は、タイルの見出しの右に「11月8日 6:00 の時点」と出します。欄の値を変えるとデータベースから読み、既定値に戻すとまたファイルを読みます。「更新」を押したあとは、そのページではファイルを読みません（データベースから読み直すためのボタンなので）。
- どの SQL をファイルから読むかは、ビルドしたときに決まります。`-- snapshot:` の行を足したり消したり、`read_api` のパラメーターやレポートの既定値を変えたりしたら、ビルドし直します。
- `api/schema` の `snapshots` に、作るものの一覧が出ます（`models` にそれを読む指標ファイル、`dashboards` にそれで開くダッシュボード）。
- ファイルがないとき（`404`）は、API から読みます（そのときは「…の時点」は出しません）。API もないときは、タイルに「スナップショット（snapshots/…）がありません。サーバーで devbi-snapshot を実行するか…」と出ます。

作るのは次のどれかです。

- **`devbi-serve`**: 起動したときに、ないものと、最後の時刻より古いものを作ります。そのあとは毎日その時刻に作り直します。まだないファイルを聞かれたときは、その場で作ってから返します。`api/<名前>.sql` をファイルより後に保存したとき（列を減らした、`WHERE` を足したなど）も、次に聞かれたときと起動したときに作り直します（前の行と列を返し続けないため）。
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
- `devbi-serve`（起動したとき。`schedule: false` でも。それと決まった時刻）、`devbi-snapshot`、Node のホストの `createApiHandler`（最初にスナップショットを聞かれたとき）は、今は作らないスナップショットのファイル（`-- snapshot:` の行を消した SQL、`read_api` のパラメーターを変える前のもの、人で絞るようになった SQL のもの）を `snapshots/` から消し、ログに「スナップショット: 今は作らない orders.arrows を消しました」と書きます。消すのは `snapshots/` のすぐ下の `.arrows` のファイルと、1 時間より前に書きかけで残った `.tmp` のファイルだけです。読めない SQL ファイルや指標ファイルがあるあいだは、まだ `-- snapshot:` の行がある SQL のファイルは消しません（その SQL のファイルかもしれないため）。行レベルのモードで `-- access: all` がないために作らない SQL は、読めないファイルとは数えません。IIS に写すときは `robocopy /MIR`（写し先にしかないファイルを消す）を使います。
- `:user.` で絞る SQL と `-- roles:` のある SQL には、`-- snapshot:` を書けません（ファイルは全員に同じなので）。[行レベルのモード](#行レベルのモード絞り忘れを止める)では、`-- access: all` のある SQL のものだけを作ります。

### 利用者ごとに見える行を変える（行レベル制御）

ログインした人ごとに、見せてよい行だけを返します。ログインの仕組み（Windows 認証、Entra ID・Okta などの OpenID Connect、SAML）は DevBI にはなく、ホスト（ASP.NET や Next.js のアプリ、前に置いたサーバー）がログインを確かめて、だれが見ているか（利用者）を API に渡します。DevBI は、`api/*.sql` の中の `:user.region` のような名前にその人の値を入れて実行します。設計の考え方は [設計書](design/row-level-security.md) にあります。

```sql
-- 自分の地域の受注
SELECT o.order_date AS 受注日, c.name AS 顧客, c.region AS 地域, l.qty * l.unit_price AS 金額
  FROM orders o
  JOIN order_lines l ON l.order_no = o.order_no
  JOIN customers c ON c.id = o.customer_id
 WHERE o.order_date >= :from
   AND c.region = :user.region
```

- **絞り込みは、サーバーが実行する `api/*.sql` にだけ書きます。** `metrics.yaml` の `model`、`dash.json` の `filters`、パラメーターの欄は、ブラウザに届いた行の中で絞るだけなので、見せない行を守れません（開発者ツールで、届いた行はすべて見えます）。サーバーから出ていかない行は、ブラウザでどうやっても見えません。
- `metrics.yaml` と `dash.json` の書き方は変わりません。同じダッシュボードが、人ごとに違う行で動きます。
- いちばん確かな守りは、今と同じくデータベースの権限です（DevBI のユーザーは SELECT だけ）。

今は、Node のサーバー（`@devbi/server` の `createApiHandler`）、[`devbi-serve`](#前のサーバーからユーザー名を受け取るdevbi-serve)（前に置いたサーバーからヘッダーで受け取る）、開発サーバーの「[この人として見る](#開発サーバーでこの人として見るdevusers)」、[`devbi-check` の確かめ](#行レベル制御のプロジェクトを確かめる)でこの形が動きます。C#（ASP.NET）と Next.js の見本は、このあと順に足します（[設計書の作る順番](design/row-level-security.md#10-作る順番pr-の分け方)）。

#### `:user.<属性>` と `:user.id`

```sql
 WHERE c.region = :user.region
   AND o.sales_rep = :user.id
```

- `:user.id` はログインした人の ID、`:user.<名前>` はその人の属性です。ふつうのパラメーターと同じく、データベースのパラメーター（`$1`、`@p1`、`:p1`、`?`）で渡します。SQL の文字に値をつなげることはないので、値に `'` が入っていても SQL は変わりません。
- 値はサーバーだけが入れます。ブラウザから名前が `user.` で始まるパラメーターが来たら `400` です。`read_api('orders', user.region = '近畿')` のようには書けません。
- ログインしていない人には `401`（「ログインしていません」）、その属性がない人には `403`（「利用者 CORP\yamada に属性 region がありません（api/orders.sql の :user.region）」）を返し、SQL は実行しません。値が `null`、空の文字、空白だけの属性も、ないものとして `403` です（`(:user.region IS NULL OR …)` で全部の行が出てしまうのを防ぐため。Oracle は空の文字を `NULL` として扱います）。
- 属性の名前は、大文字と小文字を区別しません（`:USER.Region` も同じ）。`user` のところは半角の英字だけで比べます。`:user_id` や `:username` は、ブラウザが値を送るふつうのパラメーターです。
- 属性は 1 つの値（文字・数値・真偽）だけです。担当の地域が複数ある、のようなときは、権限の表を作って JOIN します（下の「よくある書き方」）。`',' || :user.regions || ',' LIKE …` のように文字でつないだ一覧にはしません（`%` や `_` を含む値、空の一覧で壊れます）。

#### `-- roles:` と `-- access: all`

```sql
-- 給与の明細。経理と管理者だけ。
-- roles: 経理, CORP\Managers
-- access: all
SELECT …
```

```sql
-- 商品のマスタ。ログインした人は全員、全部の行を見てよい。
-- access: all
SELECT code AS 商品コード, name AS 商品名 FROM products
```

- `-- roles:` に書いた役割のどれかを持つ人だけが、その SQL を読めます。ほかの人には `403` を返し、`api/schema` の一覧にも出しません。区切りは `,`（`、` も可）。名前は完全に一致したときだけ通します（大文字と小文字も区別します。Windows のグループのように区別しない名前は、ホストがそろえて渡します）。
- `-- access: all` は「この SQL は人で絞らない（ログインした人には全部の行を返す）」と、わざと決めたしるしです。書けるのは `all` だけです。`:user.` と同じファイルには書けません（どちらのつもりかわからないので）。
- どちらも、`-- connection:` と同じく、ファイルの先頭から続く `--` のコメントの中に書きます。
- 書き間違いで、守ったつもりの決まりが黙って効かなくなるのを防ぐため、次はエラーです（`api/schema` のそのデータセットの `error` と、`api/query` の `400`）: `-- role:`・`-- acess:` のような近い書き間違い、`:` のない `-- roles 経理`・`-- access all`、全角の `ｒｏｌｅｓ`・`：`、`--` のすぐあとでない `roles:`・`access:`（`--- roles:`、`-- @roles:`、`-- ※roles:`、説明の文の途中）、中身のない `-- roles:`、`all` 以外の `-- access:`、2 つ目の `-- roles:`・`-- access:`、先頭のコメントより後ろ（SQL の中や `/* … */` の中）の `roles:`・`access:`。説明の文が `-- Roles of …` で始まるときや、文の中に `access:` があるときも、この決まりに当たるので、言い回しを変えます。`--` のあとの空白は全角でもかまいません。`:` のない `access` は、ふつうの説明（`-- Access log`）として読みます（`-- access: all` を書き忘れても、断るほうに倒れるだけなので）。
- `-- roles:` と `-- access:` を知らない古いサーバー（アプリにコピーしたままの C# など）は、この行をただのコメントとして読み、だれにでも読ませます。置いた先のサーバーの `api/schema` に `"access": 1` があるかを確かめます。特に見せたくない SQL は、役割の確かめを SQL にも書いておくと、古いサーバーでも止まります（`AND EXISTS (SELECT 1 FROM devbi_user_roles r WHERE r.login = :user.id AND r.role = '経理')`）。

#### 行レベルのモード（絞り忘れを止める）

いちばん起こりやすい事故は、あとから足した `api/*.sql` で絞り忘れることです。そこで、プロジェクトが**行レベルのモード**のときは、次の決まりにします。

1. **すべての** `api/*.sql` に、`:user.` か `-- access: all` が要ります。どちらもないファイルは実行せず、`400` と「api/x.sql は、だれにどの行を見せるかが書いてありません。:user.… で絞るか、全員に全部の行を見せるなら -- access: all を書いてください（行レベルのモード: …）」を返します。`:user`（点なし）も、`:user.id` の書き間違いとしてエラーです。
2. **すべての**リクエスト（`api/schema`、`api/query`、`snapshots/`、ホストが呼ぶ `run`）に、ログインが要ります。利用者がなければ `401` です。ホストが利用者を渡し忘れても、行が出ていくことはありません。

行レベルのモードになるのは、次のどれかのときです。メッセージの最後の（ ）に、どれでなったかが出ます。

- **ホストの設定で決めたとき**（勧める形）: `createApiHandler({ requireUser: true })`。ファイルを消したり書き間違えたりしても外れないので、本番では必ず付けます。
- **プロジェクトのファイルが行レベル制御を使っているとき**: `api/*.sql` のどれかの文字に `:user.` があるか、`--` のコメントの中に `roles:` か `access:` があるか（全角の文字と `：` も半角として読みます）、`access/` フォルダがあるとき。SQL として読んだ結果ではなく、ただの文字の検索で決めます（引用符の中や SQL の後ろのコメントでもモードにします。迷ったら守る側に倒すため）。`:` のない `-- Access log` のような説明では、モードになりません。

ホストが利用者を渡しているのに、どちらでもないときは、サーバーのログに 1 回だけ「利用者を受け取っていますが、行レベルのモードになっていません…」と書きます。

この決まりで止められるのは「書き忘れ」だけです。`SELECT :user.id AS 見ている人, …` のように、`:user.` を使っていても絞っていない SQL は止められないので、SQL はレビューします。

#### ホストから利用者を渡す

```ts
import { createApiHandler } from "@devbi/server";

const api = createApiHandler({ dir, requireUser: true });

// node:http や Express: ログインを確かめたあとで
await api.handle(req, res, { user: { id: req.user.id, roles: req.user.roles, attrs: { region: req.user.region } } });

// Web 標準の Request（Next.js の route.ts など）
const response = await api.fetch(request, { user });

// SQL を 1 つ実行する（テストや自分のジョブ）
await api.run("orders", { from: "2024-04-01" }, { user });
```

| 項目 | 中身 |
| --- | --- |
| `id` | 利用者の、**あとから変わらない、ほかの人が名乗れない** ID（文字）。SQL では `:user.id`。Entra ID なら `oid`、ほかの OpenID Connect なら `sub`、Windows 認証ならアカウント名（`CORP\yamada`）。メールアドレスは、本人が変えられたり確かめられていなかったりするので勧めません。前後の空白は除き、空ならログインしていない人です |
| `roles` | 役割（文字の配列）。`-- roles:` と比べます。Windows や Entra ID のグループは、属性ではなく役割として渡します |
| `attrs` | 属性（`{ 名前: 値 }`）。SQL では `:user.<名前>`。値は文字・数値・真偽。`null`・空の文字・空白だけは「その属性はない」です。`undefined` は渡していないのと同じです（`access/user.sql` の値を使います）。名前は文字・数字・`_`（`id` は使えません） |

- `user` を渡さない（`undefined` か `null`）のは、ログインしていない人です。
- 形の違うもの（`id` が文字でない、`attrs` に `id` がある、など）を渡すと、ホストの書き間違いとして `500` と、そのわけを返します。
- `api/query` の答えは、今と同じ `Cache-Control: no-store` です（人によって中身が違うので、どこのキャッシュにも残しません）。
- サーバーのログの 1 行に、利用者の ID が付きます（`CORP\yamada api/orders.sql: 1,234 行、85 ms`）。だれが何を読んだかの記録になります。
- 同じオリジンの API なら、アプリの Cookie や Windows 認証がそのまま API に届くので、ホストはそこから利用者を作ります。ほかのオリジンの API には Cookie が送られないので、行レベル制御は同じオリジンの API でだけ使えます。
- ページを読み込み直さずに利用者が変わるアプリ（SPA でログアウトして、別の人でログインする）では、ページの中に前の人の行が残ります。ログアウトしたら、ページを読み込み直します。
- `{ user }` と一緒に `signInHint` を渡すと、ログインしていないときの `401` のメッセージの（ ）に入ります（`{ user, signInHint: "社内ポータルからログインします" }` → 「ログインしていません（社内ポータルからログインします）」）。タイルにそのまま出ます。

#### 前のサーバーからユーザー名を受け取る（`devbi-serve`）

`devbi-serve` はログインの仕組みを持たないので、前に置いた nginx・oauth2-proxy などが確かめたユーザー名を、ヘッダーで受け取ります。

```sh
npx devbi-serve --dir . --user-header X-DevBI-User
```

- ヘッダーの値が `:user.id` になります。役割と属性は [`access/user.sql`](#利用者の属性と役割を表から引くaccessusersql) から引きます。`--user-lowercase` で小文字にそろえます（Windows のアカウント名は、大文字と小文字が人や端末で変わることがあるため）。そのときは、`access/user.sql` の表のログイン名や、`:user.id` と比べる列も小文字で入れておきます（または SQL で `LOWER(u.login) = :user.id`）。全角の英字や K（ケルビンの記号。小文字にすると k）のような、ふつうと違う形の文字が入った名前は、ほかの人の名前と同じになることがあるので `400` で断ります
- `--user-header` を付けると、行レベルのモードです（ファイルを消したり書き間違えたりしても外れません）。`:user.` も `-- access: all` もない SQL は、だれにも返しません
- 信じるのは、`--trusted-proxy` の IP アドレス（既定は `127.0.0.1` と `::1`）からつながってきたリクエストのヘッダーだけです。`X-Forwarded-For` は見ません。ほかからのリクエストのヘッダーは使わず、ログインしていない人として `401` を返し、ログに書きます（同じ相手は 1 分に 1 回、全部で 1 分に 10 件まで）。`::ffff:10.0.0.5` は `10.0.0.5` として読みます。IPv4 のアドレスをすべて含んでしまう IPv6 の範囲（`::/8` など）と、`fe80::1%eth0` のようなゾーン付きのアドレスはエラーです。社内のほかのパソコンから `devbi-serve` に直接つないで、ヘッダーでほかの人になるのを止めるためです
- `127.0.0.1` を信じると、そのコンピューターで動くほかのプログラムや、リモート デスクトップでログインした人も信じることになります。サーバーをほかの用途と分けられないときは、`--proxy-secret-file` で合言葉を足し、前のサーバーが `X-DevBI-Proxy-Secret` ヘッダーに入れます。合言葉は半角の英数字と記号で書きます（UTF-8 で保存したファイル。全角の文字や UTF-16 のファイルはエラー）。合言葉のファイルと、合言葉を書いた前のサーバーの設定ファイルは、サービスのアカウントと管理者だけが読めるようにします
- 同じヘッダーが 2 つあるリクエストと、値に `,` があるリクエスト（2 つの値を 1 行にまとめたもの）は `400` で断ります（前のサーバーが、ブラウザから来たヘッダーを上書きせずに足しているため）。値が空や空白だけなら、ログインしていない人です（`401`）。値は UTF-8 で読みます（UTF-8 でなければ `400`）。前後の半角の空白とタブは除きます（全角の空白などは、名前の一部のまま）
- **前のサーバーは、ブラウザから来た同じ名前のヘッダーを、必ず消すか上書きします。** そうしないと、利用者が自分でヘッダーを付けて、ほかの人になれます。nginx の `proxy_set_header` は上書きします（ただし `location` の中に `proxy_set_header` を 1 つでも書くと、外側のものを引き継がないので、`devbi-serve` に送る `location` ごとに書きます）。IIS の ARR の転送（[deploying.md の例](deploying.md#前に-iis-や-nginx-を置く)）は、ブラウザから来たヘッダーをそのまま渡すので、そのままでは `--user-header` を付けません。IIS の Windows 認証で人ごとに行を変えるなら、ASP.NET のアプリに埋め込む形にします
- ヘッダーを見るのは API のリクエストだけです。サイトのファイル（`dist/`）は、だれにでも同じものを返します
- 置き方の例（nginx と oauth2-proxy）は [deploying.md](deploying.md#ログインした人ごとに見える行を変える) にあります

#### 開発サーバーで、この人として見る（`devUsers`）

```ts
// vite.config.ts
devbi({
  devUsers: {
    yamada: { id: "CORP\\yamada", roles: ["営業"], attrs: { region: "関東" } },
    suzuki: { roles: ["営業"], attrs: { region: "近畿" } },
    admin: { roles: ["管理"] },
  },
});
```

- `devUsers` を書くと、開発サーバー（`vite`）のダッシュボードの上と一覧に「表示する利用者 （ログインなし）▾」が出ます。選ぶとページを読み込み直し、API がその人として答えます（Power BI の「ロールとして表示」と同じ使い方）。前の人の行はページに残りません。選んだ人はブラウザに一つです。ほかのタブで選び直すと、前のタブも、戻ったときに読み込み直します（同じパソコンのほかの開発サーバーとも同じ選択です）。
- 最初は「（ログインなし）」で、行レベルのモードのプロジェクトでは、タイルに「API の orders を読めません（401）: ログインしていません（開発サーバーのダッシュボードの右上の『表示する利用者』で選びます）」と出ます。埋め込み（`embed`）や自作の `<Dashboard>` のページには選ぶ欄がないので、ダッシュボードのページで選んでから開きます。
- 形はホストが渡す利用者と同じ `{ id, roles, attrs }` です（[ホストから利用者を渡す](#ホストから利用者を渡す)）。`id` を書かないと、`devUsers` の名前（`suzuki`）が `:user.id` になります。`attrs` を書かない人は、`access/user.sql` があればそこから引きます（開発用のデータベースに表があれば）。形が違うと、開発サーバーが起動しません（「devbi: devUsers の yamada: …」）。名前は空でない文字で書きます。
- 選んだ人は、Cookie（`devbi-dev-user`）で開発サーバーに伝えます。開発サーバーはこの Cookie を、**開発サーバーを動かしているパソコンで開いたページからだけ**読みます（GUI エディタの保存と同じ確かめ方）。`vite --host` でほかのパソコンから開いた人が Cookie を自分で付けても、だれにもなれません（`.env` のデータベースを読まれないため）。
- 「このパソコンから」は、開発サーバーへのつながりがこのパソコンから来ていることです。プロキシーやトンネルを通ったしるしのヘッダー（`X-Forwarded-For`・`Forwarded`・`Via` など）があるリクエストの Cookie は読みません。`server.allowedHosts: true` のときは、localhost か IP アドレスで開いたページの Cookie だけを読みます（ほかのサイトが自分の名前をこのパソコンに向けて読むのを止めるため）。それでも、ターミナルサーバーのように何人もが使うパソコンでは、ほかの人もこのパソコンからつなげます。開発サーバーは、自分だけが使うパソコンで動かします
- `devUsers` の名前・ID・役割・属性はページに入るので、`vite --host` では、ほかのパソコンで開いたページにも見えます（選んでも読めません）。実在の人の情報は書かず、開発用の人を書きます
- `vite preview`、ビルドしたサイト、`devbi-serve`、C# は、この Cookie も `devUsers` も読みません。本番では、ホストがログインした人を渡します。
- 見本: `examples/sales/e2e/rls/`（`api/orders.sql` が `:user.region` で絞る小さなプロジェクト）を、`examples/sales` で `pnpm exec vite --config e2e/rls.vite.config.ts` で開きます（<http://127.0.0.1:5180>）。

#### 利用者の属性と役割を表から引く（`access/user.sql`）

ホストが `id` だけを渡すとき（Windows 認証のユーザー名だけ、など）は、属性と役割をデータベースの表から引きます。

```sql
-- 利用者の属性。:user.id はログイン名（CORP\yamada）。
-- connection: hr
SELECT u.region AS region, u.dept AS dept, u.roles AS roles
  FROM devbi_users u
 WHERE u.login = :user.id
```

- プロジェクトの `access/user.sql` に置きます。`api/` の外なので、ブラウザから名前で呼ばれることはありません。開発サーバーは `access/` のファイルをブラウザに配らず（`403`）、`pnpm build` も `dist/` に入れません。`access/` フォルダがあると、プロジェクトは行レベルのモードになります。
- `api/*.sql` と同じ決まり（SELECT か WITH の文 1 つ、読み取り専用、`-- connection:`）で実行します。使えるパラメーターは `:user.id` だけで、`:user.id` で行を選ぶことが要ります。
- 結果が 1 行なら、列が属性になります（列名は大文字と小文字を区別しない。`id` という列は使えません）。`roles` という列は、`,` で区切って役割にします。0 行なら、表には属性も役割もない人です。2 行以上なら `500` です（どちらの行の人か決められないため）。
- ホストが渡したものと両方あるときは、役割はどちらかにあれば持っていて、属性はホストが渡したものが先です。ホストが同じ名前で `null` や空を渡したら、その属性はありません（表の値も使いません）。`undefined`（`{ region: claims.region }` で、その値がないとき）は渡していないのと同じで、表の値を使います。
- 使うのは、SQL が `:user.id` のほかの属性か `-- roles:` を使うときだけです。結果は `createApiHandler({ userCacheMs })` の間（既定は 60,000 ミリ秒 = 60 秒）覚えておきます。表で役割を外しても、その間は前の役割のままです。
- ユーザー名の大文字と小文字は、SQL ごとに `LOWER()` を書かず、ホストがそろえて渡します。

#### よくある書き方

```sql
-- 担当の地域が 1 つ
 WHERE c.region = :user.region

-- 担当の地域が複数（権限の表を作って JOIN する）
 WHERE c.region IN (SELECT r.region FROM devbi_user_regions r WHERE r.login = :user.id)

-- 管理者は全部（全部を見てよい人も、SQL に書いて決める）
 WHERE c.region IN (SELECT r.region FROM devbi_user_regions r WHERE r.login = :user.id)
    OR EXISTS (SELECT 1 FROM devbi_admins a WHERE a.login = :user.id)

-- 自分の担当の受注だけ
 WHERE o.sales_rep = :user.id
```

- 「集計は見せるが明細は見せない」は、サーバーの SQL で `GROUP BY` して明細を送らないことでしか守れません（`-- access: all` を付けた集計の SQL にします）。ブラウザに届いた行は、探索のタイルや開発者ツールでそのまま見えます。
- 権限の表と比べる列（`login` など）が、大文字と小文字・全角と半角・アクセントを区別しない照合順序（SQL Server の `Japanese_CI_AS`、MySQL の `utf8mb4_0900_ai_ci` など）だと、`ｙａｍａｄａ` が `yamada` と一致します。利用者が自分で名前を決められる ID を使うときは、区別する照合順序の列にするか、変わらない ID を使います。

#### 行レベル制御の外にあるもの

- `data/` の Excel・CSV と、スナップショットのファイルは、だれが読んでも同じファイルです。人で絞る SQL（`:user.`、`-- roles:`）には `-- snapshot:` を書けず、行レベルのモードでは `-- access: all` の SQL のスナップショットだけを作ります（[毎朝のスナップショット](#毎朝のスナップショット)）。サイト全体にログインをかけて守ります。
- Malloy・SQL・探索のタイル、自作タイル、Excel・PDF・CSV への書き出しは、ブラウザに届いた行から作るので、そのままで人ごとの行になります。

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
| `--timeout` | 1 回の SQL の時間の上限（秒）。既定は 60（SQLite のほか） |
| `--debug` | データベースのエラーをそのままブラウザに返す。ふつうは「サーバーのログを見てください」とだけ返し、くわしい内容はログに書く |
| `--user-header` | 前に置いたサーバー（nginx など）が、ログインした人の名前を入れるヘッダー（`X-DevBI-User`）。[行レベル制御](#前のサーバーからユーザー名を受け取るdevbi-serve)で使う。付けると行レベルのモード（`--require-user`）になる |
| `--trusted-proxy` | `--user-header` を信じる、前のサーバーの IP アドレス（カンマ区切り。`10.0.0.0/24` のような範囲も）。既定は `127.0.0.1,::1`（同じコンピューターの nginx など） |
| `--proxy-secret-file` | 前のサーバーが `X-DevBI-Proxy-Secret` ヘッダーに入れる合言葉のファイル。あると、合言葉が合うリクエストのヘッダーだけを信じる |
| `--user-lowercase` | 受け取った名前を小文字にそろえる（`CORP\Yamada` と `corp\yamada` を同じ人にする）。表のログイン名も小文字で入れておく |
| `--user-cache` | `access/user.sql` の結果を覚えておく秒数。既定は 60。0 で毎回読む。`--user-header` と一緒に使う |
| `--require-user` | 行レベルのモードにする（[行レベルのモード](#行レベルのモード絞り忘れを止める)）。`--user-header` を付けたときは要らない |

- 社内の人に見せるときは、IIS などを前に置いて Windows 認証をかけ、`devbi-serve` には IIS から転送します。`devbi-serve` 自身はログインの仕組みを持ちません。人ごとに見える行を変えるときは、前のサーバーがログインした人の名前をヘッダーで渡します（`--user-header`。IIS の ARR の転送は、そのままでは使えません）。
- API はパスの最後が `/api/schema`、`/api/query`、`/snapshots/<ファイル>.arrows` のリクエストに答えます。前に何が付いていてもかまわないので、`/reports/` の下に転送しても動きます。
- [スナップショット](#毎朝のスナップショット)を、決まった時刻に `<static>/snapshots/` に作ります。`snapshots/` の下のファイルは、API（`…/snapshots/<ファイル>.arrows`）からだけ返し、静的なファイルとしては返しません（`/snapshots//x.arrows` や `/snapshots/x.arrows/` のように書いても `404`）。API はだれが聞いているかを確かめ（[行レベル制御](#利用者ごとに見える行を変える行レベル制御)）、今は作らないファイルを返さないためです。
- 知らないホスト名で来たリクエストは `403` で断ります。ほかのサイトが自分の名前をこのコンピューターに向けて（DNS リバインディング）、ブラウザから API を読むのを防ぐためです。`--host 0.0.0.0` で社内に出すときも、名前で開くなら `--allowed-hosts` にその名前を書きます。
- `dist/assets/` のファイルは長くキャッシュさせ、ほかは毎回確かめさせます。Parquet などの部分読み（Range）にも答えます。
- 開発サーバー（`vite`）と `vite preview` にも、`@devbi/vite` が同じ API を付けます。こちらはデータベースのエラーをそのまま出します。

### API の形

ほかの言語のサーバーで同じ API を作るときの決まりです。ASP.NET には C# の見本があります（[ASP.NET（C#）で API を出す](#aspnetcで-api-を出す)）。

`GET <場所>/api/schema`

```json
{
  "datasets": [
    { "name": "order_lines", "description": "受注の明細を…", "params": ["from", "to", "regions", "customer"],
      "parameters": [
        { "name": "from", "type": "date", "label": "受注日（から）", "default": "fiscal_year_start" },
        { "name": "to", "type": "date", "label": "受注日（まで）", "optional": true },
        { "name": "regions", "type": "text", "multiple": true, "label": "地域", "default": "all", "values": "regions" },
        { "name": "customer", "type": "integer", "label": "顧客", "optional": true, "values": "customers" }
      ],
      "key": ["受注番号", "行番号"], "connection": "DEVBI_DB" },
    { "name": "orders", "description": "受注の明細…", "params": ["from"], "parameters": [{ "name": "from", "type": "date", "label": "受注日（から）" }], "connection": "DEVBI_DB" },
    { "name": "regions", "description": "地域の一覧…", "params": [], "parameters": [], "connection": "DEVBI_DB" },
    { "name": "sales_daily", "description": "…", "params": ["from"], "parameters": [{ "name": "from", "type": "date", "label": "受注日（から）" }],
      "connection": "DEVBI_DB", "snapshot": ["06:00"] }
  ],
  "snapshots": [
    { "file": "sales_daily~9e979dd94c517434.arrows", "name": "sales_daily", "params": { "from": "2024-04-01" },
      "times": ["06:00"], "models": ["sales_daily"], "updatedAt": "2026-11-08T21:00:00.000Z" }
  ]
}
```

- `params` はパラメーターの名前（SQL に出てくる順）です。
- `parameters` はパラメーターごとに 1 つで、`-- param:` を書いたものがその行の順に先、書いていないものがそのあとに SQL に出てくる順（`name` だけ）です。キーは書いたものだけが出ます（`multiple`、`optional`、`hidden` は `true` のときだけ。`label` と `default` は書いたとおりの文字）。
- `key` は `-- key:` の列で、書いていなければありません。
- 読めないファイルは `{ "name": …, "error": "…" }` です。
- `access` は `1` です（行レベル制御を知っているサーバーのしるし）。利用者を受け取ったときは `"user": { "id": "CORP\\yamada" }` も付きます（役割と属性は返しません）。
- [行レベルのモード](#行レベルのモード絞り忘れを止める)では、ログインしていないと `401` です。`-- roles:` の役割を持っていない SQL は、一覧に出しません。`params` と `parameters` に `:user.` のものは出ません（ブラウザが値を渡すものではないので）。

`snapshots` は、作るスナップショットと、最後に作った時刻（まだなければ `null`）です。作れなかったときは `error` も付きます。

`POST <場所>/api/query`（`Content-Type: application/json`）

```json
{ "name": "orders", "params": { "from": "2024-04-01" } }
{ "name": "order_lines", "params": { "from": "2024-04-01", "to": null, "regions": ["関東", "近畿"], "customer": null } }
```

- `params` の値は、文字・数値・`true` / `false`・`null` と、複数の値のパラメーター（`text[]` など）には配列です。本文は 256 KB まで（超えると `413`）。
- 名前が `user.` で始まるパラメーターは、いつも `400` です（ログインした人の値のために取ってあります）。行レベルのモードでは、名前が `user` そのもののパラメーターも `400` です。

- 成功: `200`、`Content-Type: application/vnd.apache.arrow.stream`（Arrow IPC のストリーム）。8 KB を超えて `Accept-Encoding: gzip` なら gzip で返す。行数は `X-DevBI-Rows` ヘッダー。
- 失敗: `{ "error": "日本語のメッセージ" }` と、`400`（パラメーターや SQL の決まり違反）、`401`（ログインしていない。`"access": 1` も付く）、`403`（その SQL を読む役割がない、`:user.` の属性がない）、`404`（その名前の SQL がない）、`405`、`413`、`415`（JSON 以外）、`422`（行が多すぎる）、`500`（データベースのエラー、接続先がない）。ブラウザはこのメッセージをタイルに出します。
- `Content-Type: application/json` 以外は受け付けません。ほかのサイトのページから、ブラウザに確かめさせずに送ることができないようにするためです。

`POST <場所>/api/describe`（`Content-Type: application/json`。開発サーバーだけ）

```json
{ "name": "order_lines" }
```

- データセットの結果の列を、データベースに聞いて返します（行は読みません。聞き方は[データセットの行の型](#データセットの行の型)）。`devbi-check` と `pnpm gen` も、同じことを中で呼びます。
- 成功: `200` と `{ "name": "order_lines", "columns": [{ "name": "受注日", "type": "date", "dbType": "DATE", "nullable": false }, …] }`。`type` は `string`・`int`・`float`・`bool`・`date`・`timestamp`（値を見るまで決まらない列にはない）、`dbType` はデータベースの型の名前、`nullable` はデータベースが答えたときだけ（`false` は NULL にならない）。
- 失敗: API と同じ `{ "error": … }` と、`400`（`name` がない、SQL の決まり違反）、`404`、`405`（POST 以外）、`500`（データベースのエラー、接続先がない）、`501`（列を聞けない接続）。
- 開くのは開発サーバーだけです（`createApiHandler({ describe: true })`）。`devbi-serve`、`vite preview`、C# と Next.js の見本にはありません（`404` か `405`）。

`GET <サイト>/snapshots/<ファイル>.arrows`

- スナップショットのファイルです。ふつうの静的ファイルとして置けば足ります（API のサーバーでなくてよい）。ブラウザは `Last-Modified` を「何時点のデータか」として出します。
- ブラウザは毎回確かめに来ます（`Cache-Control: no-cache` と同じ。変わっていなければ `304` で足ります）。
- `404` のときは、ブラウザは `POST …/api/query` で読みます。
- `devbi-serve` では、まだなければ作ってから返し、`If-Modified-Since` に `304` で答えます。`models/` の `read_api` で使っていないものは `404` です。作れなかったときは、API と同じ `{ "error": … }` と、SQL の失敗なら同じ状態コード（行が多すぎれば `422`）を返します。行レベルのモードでは、ログインしていないと、作る前に `401` です。
- ファイル名は、`read_api` の名前とパラメーターから決めます。パラメーターがなければ `<名前>.arrows` です。あれば、引数の名前（小文字）を UTF-16 の順（JavaScript の `sort()`、C# の `StringComparer.Ordinal`）で並べた `[[名前, 値], …]` を JavaScript の `JSON.stringify` で書いた文字列（空白なし、日本語はそのまま）の UTF-8 に、FNV-1a（64 ビット）をかけた値を 16 桁の小文字の 16 進数にして、`<名前>~<16 桁>.arrows` とします。値は文字・数値・`true` / `false`・`null` で、数値は JavaScript の書き方です。`read_api('orders', from = '2024-04-01')` は `[["from","2024-04-01"]]` から `orders~9e979dd94c517434.arrows` になり、`read_api('売上', 地域 = '関東', n = 1.5, all = true, none = null)` は `[["all",true],["n",1.5],["none",null],["地域","関東"]]` から `売上~ada27a0b5a13b1c4.arrows` になります（devbi の `snapshotFile(name, params)`）。

`createApiHandler({ dir, env?, maxRows?, timeoutMs?, exposeErrors?, describe?, log?, snapshotDir?, requireUser?, userCacheMs? })` は、この API を Node の `http` のハンドラーとして返します（`handle(req, res)` が `false` なら API 以外のリクエスト）。Web 標準の `Request` / `Response` で書くサーバー（Next.js の `route.ts` など）では `fetch(request)` を使います（API 以外のリクエストなら `undefined`）。`fetch` は gzip で返しません（[Next.js に置く](#nextjs-に置く)）。どちらも、3 つめ（`fetch` は 2 つめ）の引数 `{ user, signInHint? }` でログインした人を渡します（[ホストから利用者を渡す](#ホストから利用者を渡す)）。`run(name, params, { user }?)` で SQL を 1 つ実行し（複数の値のパラメーターには配列を渡します。`api/query` と同じ確かめをし、エラーには `status` が付きます）、`describe(name)` でその結果の列を聞き（`describe: true` でなくても使えます。`describe: true` は `api/describe` の口を開けるだけ）、`snapshots`（`make`、`catchUp`、`schedule`、`status` など）でスナップショットを扱えます。`snapshotDir` がなければ、スナップショットは聞かれるたびに作って保存しません。ホスト名の確認はしないので、自分のサーバーに組み込むときはそちらで確かめます（`isHostAllowed(req.headers.host, allowedHosts)` が使えます）。`serve(options)` は `devbi-serve` の中身で、`allowedHosts` も受け取ります。

## レポート（パラメーターの欄と、SQL の結果の表）

SSRS のレポートのように、`api/<名前>.sql`（データセット）の結果を、そのまま表のタイルに出します。ダッシュボードの見出しの下に、SQL の `-- param:` の行から作った入力欄（パラメーターの欄）が並び、値を変えると、サーバーがその値で SQL を実行し直します。ブラウザで集計はしないので、DuckDB-wasm を読みません（指標ファイルのタイルがないダッシュボードは、そのぶん軽く開きます）。表は spreadsheet-grid で、列・グループ・合計の行・行のクリックを `options` で決め（[表の options](#表の-options)）、見る人は見出しのメニューで並べ替えと絞り込みができます。サンプルは `examples/sales/dashboards/sales-report.dash.json`（「受注明細レポート」: 顧客別の表をクリックすると、下の明細がその顧客だけになる）と `api/customer_totals.sql`・`api/order_lines.sql` です。

```json
{
  "$schema": "../.devbi/dash.schema.json",
  "title": "受注明細レポート",
  "fiscalYearStart": 4,
  "tiles": [
    { "id": "lines", "x": 0, "y": 0, "w": 12, "h": 9, "type": "table", "title": "受注明細",
      "query": { "dataset": "order_lines" } }
  ]
}
```

指標ファイル（`models/`）がなくても動きます。API は `read_api` と同じもの（`devbi-serve`、開発サーバー、[C# の見本](#aspnetcで-api-を出す)、[Next.js](#nextjs-に置く)）です。パラメーターの定義は、ビルドのときに `@devbi/vite` が `api/*.sql` から読んでページに入れます（SQL は入れません。`api/schema` に出るものと同じ、パラメーターと `-- key:` だけ）。ビルドのあとにサーバーの SQL ファイルの `-- param:` を書きかえたときは、ビルドし直すまで欄は前のままです（合わない値はサーバーが `400` で断ります）。

### データセットを読むタイル（`query.dataset`）

- `query.dataset` に `api/` のファイル名（`.sql` なし）を書きます。今は表（`table`）と自作タイルだけです。
- `query` には `dataset` と `params` だけを書きます。`measures`・`filters`・`sort`・`limit` などとは一緒に書けません（並べ替えと件数は SQL の中に書きます）。
- 列は、`options.columns`（[下](#表の-options)）を書かなければ SQL の結果のとおりの順と名前です。数の列は右寄せで 3 桁区切り、日付と日時の列は `2026/4/1` の形です。`-- key:` の列は、数でも区切りません。
- 期間（`date-range`）とほかのタイルのクリックでの選択は、データセットのタイルにはかかりません。データセットのタイルの行をクリックしても、ほかのタイルは絞りません。値で絞るのはパラメーターです（行のクリックで値を入れるのは `options.click`）。指標ファイルのタイルと同じダッシュボードに並べられます。
- 同じ値で読んだ結果は 5 組まで覚えておき、値を戻したときはデータベースへ行きません。見出しの右の「更新」で、表と候補をデータベースから読み直します。
- SQL に `-- snapshot:` の行があり、パラメーターの既定値がどれも決まった値なら、既定値のままのあいだは[毎朝のスナップショット](#毎朝のスナップショット)を読みます。
- 「Excel」では、表のシートの 2 行目に `パラメーター: 受注日（から） 2024-04-01、…` が、「概要」のシートにも同じ行が入ります。表は画面のとおりに書きます（見えている列とその順、見る人の並べ替えと絞り込み、合計の行。グループは閉じていても全部の行を、グループの列を先頭にして）。見る人が検索や列の絞り込みで絞っていれば、3 行目に「表の検索・列のフィルターで絞った行です」と入ります。「印刷・PDF」は、欄を今の値のまま、表は画面に見えている形で印刷します（「表示」のボタンは出しません）。

`query.params` は、データセットのパラメーターに何を入れるかです。書かなければ、パラメーターと同じ名前の欄の値です。

```json
"query": {
  "dataset": "order_lines",
  "params": { "from": { "param": "since" }, "regions": ["関東"] }
}
```

- `{ "param": "since" }`: ダッシュボードのパラメーター `since` の値です。2 つのデータセットの、名前の違うパラメーターを 1 つの欄にまとめるときに使います。
- 値（`"2024-04-01"`、`10`、`["関東"]`、`null`）: このタイルだけの決まった値です。欄は出ません。
- データセットにない名前はエラーです。

自作タイル（`component`）の `export const query` に `dataset` を書くこともできます（`defineQuery` で書くと、[行に型が付きます](#データセットの行の型)）が、欄は dash.json のタイルからだけ作ります。自作タイルが使うパラメーターは、dash.json のそのタイルの `query` に `dataset` を書くか、`params` に `type` を書いて欄を作ってください（ないと「パラメーター x の欄がありません」のエラーです）。

### 表の `options`

データセットの表（`"type": "table"` と `query.dataset`）は、[spreadsheet-grid](https://www.npmjs.com/package/@ishibashi0112/spreadsheet-grid) で出します。`options` で、どの列をどう出すか、グループ、合計の行、行のクリックを決めます。

```json
{
  "id": "customers", "x": 0, "y": 0, "w": 12, "h": 7, "type": "table", "title": "顧客別",
  "query": { "dataset": "customer_totals" },
  "options": {
    "columns": [
      { "field": "顧客ID", "hidden": true },
      "顧客",
      "受注数",
      { "field": "金額", "format": "¥#,##0", "style": "bar" }
    ],
    "groupBy": ["地域"],
    "totals": true,
    "click": { "params": { "customer": "顧客ID" } }
  }
}
```

| キー | 中身 |
| --- | --- |
| `columns` | 出す列とその順。列の名前か、`{ "field": "列の名前", … }`（下の表）。書かなければ全部の列を SQL の順に |
| `groupBy` | 行をまとめる列（`["地域", "顧客"]` で、地域の中に顧客）。グループの行に件数と、集計（`agg`）の列の小計が出て、▾ で閉じられる。`columns` になくてよい |
| `totals` | `true` で、表のいちばん下に合計の行。見る人が絞り込むと、残った行の合計 |
| `search` | 上の検索欄（どの列の文字でも探して、合う行だけにする）。既定は出す。`false` で出さない |
| `click` | 行をクリックすると、その行の列の値をダッシュボードのパラメーターに入れる: `{ "params": { "パラメーターの名前": "列の名前" } }`。同じ行をもう一度クリックすると、そのパラメーターを既定値に戻す |

`columns` の 1 つの列:

| キー | 中身 |
| --- | --- |
| `field` | SQL の結果の列の名前（要る） |
| `label` | 見出し。既定は列の名前 |
| `format` | 数の書式（`"¥#,##0"`、`"#,##0"`、`"0.0%"`）。日付の列は `2026/4/1` のまま |
| `width` | 幅（px）。書かなければ中身に合わせる |
| `align` | `left`・`center`・`right`。既定は数が右、ほかは左 |
| `pin` | `left`・`right`。横にスクロールしても、その端に残る |
| `hidden` | `true` で最初は隠す（見る人が列の見出しのメニュー「列の表示」で出せる）。クリックで使う ID の列など |
| `filter` | `false` で、その列の見出しのメニューに絞り込みを出さない |
| `agg` | グループと合計の行に出す集計: `sum`・`avg`・`min`・`max`・`count`（行の数）。どの列にも `agg` がなければ、数の列（`-- key:` の列を除く）を `sum` で出す。ある列に書けば、書いた列だけ（単価のように足しても意味のない列を除くとき） |
| `style` | `"bar"`（値の大きさの横棒）、`"scale"`（値の大きさで色の濃さ）、`{ "chips": { "遅れ": "critical", "完了": "good" } }`（値ごとの色の札。色は `neutral`・`info`・`good`・`warning`・`critical`） |

- `columns`・`groupBy`・`click` に書いた列が結果にないと、表の代わりに「options.columns の「顧客名」は結果の列にありません（列: …）」と出ます。書き方の誤り（`agg` の値など）は `pnpm check` でも出ます。
- `click` のパラメーターは、そのダッシュボードの欄にあるものです（ほかのデータセットの表が使うパラメーターか、dash.json の `params` に `type` を書いたもの）。値はパラメーターの型に直して入れます（`顧客ID` の `5` を `integer` のパラメーターに。複数の値のパラメーターには、その 1 つだけの値）。クリックした行は色が付きます。Enter か Space でも同じです。Shift・Ctrl（⌘）を押しながらのクリックは、コピーのためのセルの選択だけで、値は入れません。
- 見る人は、列の見出しのメニュー（⋮）で、並べ替え、値の一覧や条件での絞り込み（日付は年・月・日の一覧と範囲も）、この列でのグループ、列の固定、幅、隠した列の表示ができます。絞り込んだ列は、検索欄の下に札で出ます（× で外す）。表の中で Ctrl+F（⌘F）を押すと、行を減らさずに文字を探します。セルを選んで Ctrl+C（⌘C）でコピーすると、Excel に表示のとおり（`¥1,200`、`2026/4/1`）貼れます。これらはブラウザの中だけの操作で、データベースへは行きません。パラメーターの値を変えても、列の並びや固定などはそのままです。
- 日付は、データベースの日付のまま絞り込みます（見る人の PC の時間帯で日がずれません）。
- 行は全部をブラウザに持ちます（サーバーの行数の上限まで。既定は 100 万行）。行がとても多い表は、パラメーターで絞ります。
- 指標ファイルの表（`query.dataset` のない表）では、この `options` は使えません（`pnpm check` のエラー）。その表は query の列をすべて出し、見出しで並べ替え、行のクリックでほかのタイルを絞ります。
- GUI エディタでは、データセットの表のときだけ、この `options` が「表示」に出ます（`columns`・`groupBy`・`click` は JSON で書きます。`columns` と `groupBy` は `[ ]` の配列、`click` は `{ }`）。出す列と順、見出し・書式・集計・隠す・グループは、「データ」の「列」でデータベースが答えた列から選べます（[設定欄](#設定欄プロパティパネル)）。「コードにする」で書き出した表も、`options` をファイルの中に持って同じように描き、Excel も画面のとおりに書きます。

### パラメーターの欄

- 欄は、データセットのタイルが使うパラメーターごとに 1 つです。並びは、dash.json の `params` に書いた順、そのあとタイルの順（上から、左から）に、SQL の `-- param:` の順です。
- 同じ名前のパラメーター（大文字と小文字は区別しない）は、データセットが違っても 1 つの欄です。型が違うとエラーです。表示名（`label`）や既定値が違うときは、dash.json の `params` でどちらかに決めます。
- 候補（`values`）のデータセットのパラメーターも欄になります。地域を選ぶと、その地域の顧客だけが候補になる、のような連動です。上の欄の値を変えて、下の欄の値が新しい候補にないときは、下の欄は既定値に戻ります（既定値がなければ空）。候補は 10,000 件まで出します。

| パラメーター | 欄 |
| --- | --- |
| `date` / `datetime` | ブラウザの日付（日時）の入力。選ぶか、打って Enter か、欄を離れると決まる |
| `text`・`integer`・`number` | 文字の入力。Enter か、欄を離れると決まる。型に合わない値は、欄の横に「整数を入れてください」など |
| `boolean` | はい / いいえ |
| 候補（`values`）あり | 一覧から選ぶ。`optional` なら「（指定なし）」もある |
| 複数の値で候補あり | チェックの一覧（「すべて選ぶ」「すべて外す」）。閉じたときに決まる。全部なら「すべて（6）」 |
| 複数の値で候補なし | `,` 区切りで打つ |
| `hidden` | 欄を出さない（値は既定値、URL、埋め込みから） |

- 既定値の日付の言葉（`today`、`month_start`、`fiscal_year_start` など）は、見ている人の PC の日付で決めます。`fiscal_year_start`（年度の始まり）の月は、dash.json の `fiscalYearStart`（既定は 1）です。
- `default=all`（候補の全部）は、候補を読み終えてから表を読みます。候補を読めないときは、表は「地域を入れてください」のように値を求めます。
- 複数の値は、1 つのパラメーターで 1,000 個まで送れます（サーバーの上限。「すべて」も同じ）。超えると表に「… 1,000 個までです」と出ます。候補が多いパラメーターは、`all` にせず、上の欄で候補を絞ります。
- 値がないパラメーター（`optional` でなく、既定値もない）があると、表は読まずに「受注日（から）を入れてください」と出します。
- 値は、欄で決まるとすぐに表を読み直します。dash.json に `"apply": "button"` と書くと、欄の右に「表示」のボタンが出て、押したときに読み直します（いくつも変えてから 1 回だけ読むとき）。候補の連動は、「表示」を押す前の欄の値で動きます。
- 欄の値は、見る人が選べる絞り込みです。見てよい行の制限（権限）ではありません。人によって見てはいけない行があるなら、SQL の中を `:user.` で絞ります（[利用者ごとに見える行を変える](#利用者ごとに見える行を変える行レベル制御)）。値は、サーバーでも型を確かめます。

### dash.json の `params`

欄の表示名や既定値を、このダッシュボードだけ変えるときに書きます。

```json
"params": {
  "from": { "label": "いつから", "default": "year_start" },
  "since": { "type": "date", "label": "いつから" },
  "customer": { "hidden": true }
}
```

- キーは `-- param:` の行と同じ（`type`・`label`・`default`・`values`・`optional`・`hidden`）で、SQL の行より優先します。`type` は `"date"` や `"text[]"` のように書き、SQL の行の型と違うとエラーです。
- どのデータセットのパラメーターでもない名前（`query.params` の `{ "param": … }` でだけ使う名前）には、`type` が要ります。
- `default` は値（複数の値なら配列）か、`-- param:` と同じ言葉（`"fiscal_year_start"`、`"today-30"`、`"all"`）です。
- `user` と、`user.` で始まる名前は使えません（ログインした人の値のために取ってあります）。
- 書いた順に欄が並びます。

### URL・埋め込み・React から値を渡す

- アプリ（`<DevbiApp>`）では、URL の `#/` のあとに値が入ります: `#/sales-report?from=2024-04-01&regions=関東&regions=近畿`。欄の値を変えると URL も変わる（ブラウザの履歴は増えない）ので、そのままリンクにして渡せます。既定値のままの値は入りません（`today` のような既定値は、リンクを開いた日の値になります）。空にした `optional` の値と、何も選ばない複数の値は `to=`・`regions=` です。型に合わない値は使わず、既定値で開きます（開発者ツールのコンソールに注意が出ます）。開いたあとにアドレスを書きかえたときは、書いていないパラメーターは既定値に戻ります。
- 埋め込み: `<div data-devbi="sales-report" data-devbi-params='{"from": "2024-04-01", "regions": ["関東"]}'>`（[属性](#2-画面に-2-行を足す)）。JavaScript からは `mount(el, { params, onParamsChange })`。埋め込みと React の部品は、置いたページの URL を変えません。
- React: `<Dashboard>` の `params` と `onParamsChange`（下の例）。`params` を変えると、その欄の値も変わります（ほかの欄はそのまま）。`onParamsChange` は、どれかの値が変わるたびに、全部の値で呼ばれます。

  ```tsx
  <Dashboard project={project} name="sales-report" params={{ customer: 1024 }} onParamsChange={(values) => setValues(values)} />
  ```

- 渡した値も型で確かめ、合わない値は使いません（コンソールに注意が出ます）。日付は `"2024-04-01"`、日時は `"2024-04-01T09:00"`、複数の値は配列です。

## ASP.NET（C#）で API を出す

`devbi-serve` を別に動かさず、ASP.NET のアプリに同じ API（[API の形](#api-の形)）を足す見本です（`dotnet/`）。データベースは SQL Server だけです。アプリのログイン（Windows 認証など）がそのまま API にもかかります。

| プロジェクト | 中身 |
| --- | --- |
| `dotnet/src/DevBI.Server` | API の本体。`api/*.sql` を読んで確かめ、SQL Server で実行し、Arrow で返す。Web の仕組みには依存しない（netstandard2.0 と net10.0。.NET Framework 4.7.2 以降でも動く） |
| `dotnet/src/DevBI.Server.AspNetCore` | ASP.NET Core（.NET 10）用。`app.MapDevBIApi(...)` |
| `dotnet/src/DevBI.Server.SystemWeb` | .NET Framework の ASP.NET（WebForms、MVC 5）用。`DevBIHttpHandler`（`IHttpHandler`） |
| `dotnet/samples/DevBI.Sample` | サンプル（`examples/sales`）を `devbi-serve` の代わりに ASP.NET Core で出す |

NuGet にはまだ出していません。アプリのソリューションにプロジェクトを足して参照するか、`DevBI.Server` の 5 つの `.cs` をアプリにコピーして、NuGet で `Apache.Arrow` と（.NET Framework では）`System.Text.Json` を入れます。コピーするときは、C# 8 以降の書き方を使っているので、古い形式の `.csproj`（.NET Framework の既定は C# 7.3）に `<LangVersion>latest</LangVersion>` を足します（Visual Studio 2019 以降）。

### ASP.NET Core

```csharp
using DevBI.Server;
using DevBI.Server.AspNetCore;
using Microsoft.Data.SqlClient;

var api = new DevBIApi(new DevBIOptions
{
    // devbi/api/*.sql。wwwroot の外に置く（SQL をブラウザから読ませない）
    Directory = Path.Combine(builder.Environment.ContentRootPath, "devbi"),
    // DEVBI_DB（-- connection: erp なら DEVBI_DB_ERP）の接続。appsettings.json の ConnectionStrings から
    Connect = name => builder.Configuration.GetConnectionString(name) is { Length: > 0 } cs ? new SqlConnection(cs) : null,
});
app.MapDevBIApi("/reports", api).RequireAuthorization();   // /reports/api/schema と /reports/api/query
```

- ビルドした `dist/` を `wwwroot/reports/` に置くと、ダッシュボードは `/reports/` で開け、API は既定の場所（`/reports/api/`）で答えます。
- `.arrows`（[スナップショット](#毎朝のスナップショット)と、データの Arrow）と、データに使うなら `.parquet` は、ASP.NET Core の静的ファイルが型を知らないので、`FileExtensionContentTypeProvider` に足します（`dotnet/samples/DevBI.Sample/Program.cs`）。
- `MapDevBIApi` の戻り値には、`.RequireAuthorization()` などのふつうの設定が付けられます。

### WebForms・MVC 5（.NET Framework 4.7.2 以降）

`Global.asax` で API を作り、`web.config` で `api/` の下のリクエストを渡します。

```csharp
protected void Application_Start(object sender, EventArgs e)
{
    DevBIHttpHandler.Api = new DevBIApi(new DevBIOptions
    {
        Directory = Server.MapPath("~/App_Data/devbi"),   // ~/App_Data/devbi/api/orders.sql など
        Connect = name => name == "DEVBI_DB" ? new SqlConnection(ConfigurationManager.ConnectionStrings["DevBI"].ConnectionString) : null,
        Log = line => System.Diagnostics.Trace.WriteLine(line),
    });
}
```

```xml
<location path="Scripts/devbi/api">
  <system.webServer>
    <handlers>
      <add name="DevBI" path="*" verb="*" type="DevBI.Server.SystemWeb.DevBIHttpHandler, DevBI.Server.SystemWeb" preCondition="integratedMode" />
    </handlers>
  </system.webServer>
</location>
```

- `dist/` は `~/Scripts/devbi/` に置きます。埋め込みの API の既定の場所（`devbi-embed.js` と同じ場所の `api/`）が `~/Scripts/devbi/api/` なので、`data-devbi-api` は要りません。
- `api/*.sql` は `App_Data` の下に置きます。IIS は `App_Data` のファイルを配りません。
- IIS の統合パイプライン（既定）で、`web.config` に `<httpRuntime targetFramework="4.5" />` 以降があるアプリで動きます（Visual Studio で作ったアプリにはあります）。`System.Data.SqlClient` でも `Microsoft.Data.SqlClient` でもかまいません。
- MVC 5 のアプリでは、既定のルート（`{controller}/{action}/{id}`）が `web.config` のハンドラーより先に `Scripts/devbi/api/query` をつかむので、`RouteConfig` の `MapRoute` より前に `routes.IgnoreRoute("Scripts/devbi/api/{*pathInfo}");` を足します。
- `web.config` の `<httpErrors existingResponse="Replace">` は、API の日本語のエラーも IIS のエラーページに置き換えます。その設定があるときは、`location` の中で `<httpErrors existingResponse="PassThrough" />` にします。
- 古い形式のプロジェクト（`packages.config`）で `System.Text.Json` を入れると、NuGet が `web.config` にバインド リダイレクトを足します。足されていないと「アセンブリが見つからない」エラーになるので、そのときは NuGet で入れ直します。

### Windows 認証で SQL Server につなぐ

接続文字列に `Integrated Security=true`（`Server=db01;Database=sales;Integrated Security=true;TrustServerCertificate=true`）と書くと、Windows のアカウントで SQL Server につながります。IIS では、アプリケーション プールのアカウント（`IIS AppPool\<プール名>`、ほかのコンピューターの SQL Server からは `<ドメイン>\<Web サーバー名>$`）です。そのアカウントに、読ませる表の SELECT の権限だけを付けます。利用者ひとりひとりのアカウントではつなぎません（DevBI の API は、だれが開いても同じ行を返します）。

`<identity impersonate="true" />` にしている WebForms のアプリでは、開いた利用者のアカウントでつながることがあります。そのときは利用者ごとの権限になり、ほかのコンピューターの SQL Server には Kerberos の委任の設定が要ります。アプリケーション プールのアカウントでつなぐなら、SQL Server 認証のユーザーを使うのがかんたんです。

### `DevBIOptions`

| 名前 | 中身 |
| --- | --- |
| `Directory` | `api/` のあるフォルダ |
| `Connect` | 接続の名前（`DEVBI_DB`、`DEVBI_DB_ERP` など）から、新しい、まだ開いていない `DbConnection` を返す関数。ないときは `null`（「接続先がありません。DEVBI_DB の接続を DevBIOptions.Connect で返してください」の `500`）。1 回の API ごとに呼び、使い終わると閉じる（ADO.NET の接続プールが使い回す） |
| `MaxRows` | 1 回に返す行の上限。既定は 1,000,000 |
| `Timeout` | 1 回の SQL の時間の上限。既定は 60 秒。`TimeSpan.Zero` で上限なし |
| `ExposeErrors` | データベースのエラーをそのままブラウザに返す（`devbi-serve` の `--debug`）。既定は `false` |
| `Log` | 1 回ごとの行（`api/orders.sql: 6,044 行、381 ms`）と、エラーのくわしい内容を受け取る関数 |

`api.RunAsync(name, parameters)` で SQL を 1 つ実行できます（戻り値は Arrow のバイト列と行数。複数の値のパラメーターには `string[]` などの配列を渡します）。`Dataset.Parse(name, text)` の `Parameters` と `Key` で、`-- param:` と `-- key:` の中身を読めます。`api.HandleAsync(request)` は HTTP の 1 回分で、ほかの Web の仕組みにつなぐときに使います（パスから `schema` / `query` を取るのは `DevBIApi.ActionOf(path)`）。

### `devbi-serve` との違い

- SQL Server だけです。SQL は SQL Server の書き方（`[名前]` の引用符など）で確かめ、パラメーターは `@p1`、`@p2` … で渡します。`-- param:` の型の確かめ方とメッセージ、日付の渡し方（`CAST(@p1 AS date)`）、複数の値の広げ方も `devbi-serve` と同じです。型の受け取り方（[接続先](#接続先)の表）、状態コード、メッセージは `devbi-serve` と同じです。違うメッセージは、接続先がないとき（「DEVBI_DB の接続を DevBIOptions.Connect で返してください」）と、時間切れの案内（「`DevBIOptions.Timeout` で延ばせます」）だけです。
- `geography`・`geometry`・`hierarchyid` の列は、読めずにエラーになります。`location.STAsText() AS location` や `node.ToString() AS node` のように、SQL で文字にしてください。
- スナップショットは作りません。`api/schema` の `snapshots` はいつも空です。`-- snapshot:` の行がある SQL のダッシュボードは、`devbi-snapshot`（Node）でサイトの `snapshots/` に作ったファイルがあればそれを、なければ API を読みます。
- 知らないホスト名を断る仕組み（DNS リバインディングの対策）は持ちません。ASP.NET Core では `AllowedHosts`（appsettings.json）、IIS ではサイトのバインドにホスト名を書きます。
- パスの前に何が付いても答える `devbi-serve` と違い、`MapDevBIApi` に渡した場所（WebForms では `web.config` の `location`）でだけ答えます。

## Next.js に置く

Next.js（App Router、16 で確かめています）のアプリに、ダッシュボードと API を足す形です。見本は `examples/nextjs` です。API は `route.ts` 1 つで、`createApiHandler` の `fetch(request)` が答えます。ダッシュボードは `devbi-embed.js` で出すので、アプリの React の版や、Turbopack・webpack の設定とは関係ありません。

```
アプリ/
  public/devbi/                    DevBI のプロジェクトの dist/ を写したもの（devbi-embed.js、assets/、data/。snapshots/ は写さない）
  app/devbi/[...path]/route.ts     /devbi/api/schema、/devbi/api/query、/devbi/snapshots/<ファイル>
  lib/devbi.ts                     createApiHandler（サーバー全体で 1 つ）
  instrumentation.ts               起動したときと毎朝の時刻に、スナップショットを作る
  components/devbi-dashboard.tsx   ダッシュボードを出す部品（"use client"）
```

アプリに `@devbi/server`（Node 22.16 以上）と、使うデータベースのドライバ（`mssql` など。[接続先](#接続先)）を入れます。`npm install @devbi/server` で入れます（見本の `examples/nextjs` は、このリポジトリの pnpm のワークスペースでつないでいる）。

```ts
// next.config.ts: node_modules の @devbi/server をバンドルせず、Node でそのまま動かす
const config: NextConfig = { serverExternalPackages: ["@devbi/server"] };
```

```ts
// lib/devbi.ts
import path from "node:path";
import { createApiHandler, loadEnv, type ApiHandler } from "@devbi/server";

// DevBI のプロジェクト（api/*.sql、models/、DEVBI_DB の書いてある .env）
const dir = path.resolve(/* turbopackIgnore: true */ process.env.DEVBI_DIR ?? "../reports");
const shared = globalThis as typeof globalThis & { devbi?: ApiHandler };
export const devbi = (shared.devbi ??= createApiHandler({
  dir,
  env: loadEnv(dir),
  snapshotDir: path.resolve(/* turbopackIgnore: true */ "snapshots"),
  log: (line) => console.log(`[devbi] ${line}`),
}));
```

```ts
// app/devbi/[...path]/route.ts
import { isHostAllowed } from "@devbi/server";
import { devbi } from "@/lib/devbi";

const allowedHosts = (process.env.DEVBI_ALLOWED_HOSTS ?? "").split(",").filter(Boolean);

async function answer(request: Request): Promise<Response> {
  if (!isHostAllowed(request.headers.get("host") ?? undefined, allowedHosts)) {
    return Response.json({ error: "このホスト名では開けません" }, { status: 403 });
  }
  // アプリのログインの確かめ方をここに（ほかの route と同じもの）
  return (await devbi.fetch(request)) ?? Response.json({ error: "見つかりません" }, { status: 404 });
}

export { answer as GET, answer as HEAD, answer as POST };
```

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { devbi } = await import("./lib/devbi");
  devbi.snapshots.schedule();
  void devbi.snapshots.catchUp().catch((e: Error) => console.error(`[devbi] スナップショット: ${e.message}`));
}
```

部品は、[React のアプリに置く](#react-のアプリに置く)の `DevbiDashboard` と同じで、URL を `/devbi/devbi-embed.js` にし、ファイルの先頭に `"use client";` を書きます（`import()` には `/* webpackIgnore: true */ /* turbopackIgnore: true */` を付けます）。ページでは `<DevbiDashboard name="sales" />` のように置きます。

- `dist/` は `public/devbi/` に、`next build` の前に写します（見本は `prebuild` で写す）。ダッシュボードの API の既定の場所は `devbi-embed.js` と同じ場所の `api/`（`/devbi/api/`）なので、`data-devbi-api` は要りません。`public/` のファイルは route より先に配られ、残りの `/devbi/…` に route が答えます。
- `dist/snapshots/` は写しません（`devbi-snapshot` の既定の置き場所なので、あることがあります）。写すと、route より先に `public/` の古いファイルが配られます。`dist/index.html` も、DevBI だけのページなので要りません（見本は写さない）。
- スナップショットは `public/` に置きません（`next start` は、動き始めたあとで `public/` に足したファイルを配りません）。サーバーのフォルダ（`snapshotDir`）に作り、route が返します。まだなければ作ってから返し、`If-Modified-Since` に `304` で答えるのは `devbi-serve` と同じです。いつも動いているサーバーがない置き方では、`instrumentation.ts` の代わりに `devbi-snapshot --dir <プロジェクト> --out <フォルダ>` をタスクスケジューラや cron で動かし、`snapshotDir` を `<フォルダ>/snapshots` にします。
- `fetch` は gzip で返しません。Next.js は route の答えの `Content-Encoding` を消してしまい、Arrow の型（`application/vnd.apache.arrow.stream`）は自分では圧縮しないためです。行が多いときは、前に置く IIS や nginx で、この型も圧縮させます（nginx なら `gzip_types` に足す）。
- ログイン: 同じオリジンなので、アプリの Cookie はそのまま API に届きます。route の中で、アプリのほかの route と同じように確かめます。ただし `public/devbi/` のファイル（`devbi-embed.js`、`data/` の Excel や CSV など）は route を通らずに配られます。データのファイルもログインで守るときは、`proxy.ts` の `matcher` に `/devbi/:path*` を入れます（`proxy.ts` は `public/` のファイルの前にも動きます）。
- ホスト名: `devbi-serve` と同じく、IP アドレスと `localhost` のほかは `DEVBI_ALLOWED_HOSTS`（カンマ区切り。`.corp.local` はその下の名前すべて）に書いた名前だけを通します。IP アドレスでは開けるので、手元で試すときは `next dev --hostname 127.0.0.1` のように、このコンピューターだけで待ち受けます（見本の `dev` と `start` はそうしている。Next.js の既定はすべてのネットワークから）。
- バンドル: `serverExternalPackages` は、`node_modules` にある `@devbi/server` にだけ効きます。ワークスペースでつないだもの（見本）はバンドルされますが、データベースのドライバは `import()` を Node に任せて読むので、どちらでも動きます。ドライバはアプリの `node_modules` から探します。
- Next.js は、`next build` と `next dev` のたびに、匿名の利用データを Vercel に送ります（既定でそうなっている）。社外に出さないときは、アプリの `.env` に `NEXT_TELEMETRY_DISABLED=1` を書きます（見本はそうしている）。
- `lib/devbi.ts` で `globalThis` に置くのは、`next dev` がファイルを直すたびに読み込み直しても、データベースの接続を作り直さないためです。`next dev` でもそのまま動きます。
- `path.resolve` の `/* turbopackIgnore: true */` は、「サーバーが動いてから読むフォルダで、ビルドに含めるファイルではない」という印です。付けないと、`next build` が「プロジェクト全体をたどる」警告を出します。

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
| `data-devbi-exports` | `false` で「ファイル出力」のメニューを出さない。`xlsx,pdf` のように種類を並べると、それだけを出す（[ファイル出力](#メニューを出さない一部だけにする)） |
| `data-devbi-params` | パラメーターの値の JSON（`'{"from": "2024-04-01", "regions": ["関東"]}'`）。[レポート](#url埋め込みreact-から値を渡す)の欄の値になる。JSON として読めないときはコンソールにエラーを出して使わない |
| `data-devbi-api` | 読み取り API の場所（`read_api` を使うとき）。既定は `devbi-embed.js` と同じ場所の `api/`。アプリに API を足したときは、その場所（例: `/MyApp/devbi/api/`）。相対パス（`api2/`）は、ページではなく `devbi-embed.js` のある場所からです。ページとも `devbi-embed.js` とも違うサーバーは使いません（要るときは JavaScript の `mount` に `apiUrl` で渡します） |

- `<script type="module">` は、ページを読み終わってから動きます。`<head>` に書いても、div より前に書いてもかまいません。
- 1 つのページに、いくつでも置けます。DuckDB のエンジンは `devbi-embed.js` 1 本につき 1 つで、API の場所が違うダッシュボードも同じエンジンを使います。
- 「ファイル出力」の「印刷・PDF」は、ダッシュボードだけを印刷します（まわりのページは入りません）。ページの CSS は写しにも入りますが、外側の要素に付けた指定は届きません（[印刷・PDF](#印刷pdf)）。
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
| `mount(要素かセレクタ, { dashboard?, theme?, apiUrl?, fetch?, isolate?, exports?, params?, onParamsChange? })` | ダッシュボードを出す。`params` はパラメーターの値（同じ要素にもう一度呼ぶと、ほかはそのままで値だけ変わる）、`onParamsChange` は値が変わったときに全部の値で呼ばれる関数（[レポート](#url埋め込みreact-から値を渡す)）。書かなかったものは要素の `data-devbi…` 属性から取る。`isolate: false` で、ページの CSS を打ち消さない（既定は `true`）。`exports: false` で「ファイル出力」のメニューを出さない（`["xlsx", "pdf"]` のように種類を並べると、それだけ）。同じ要素にもう一度呼ぶと切り替わる（ダッシュボード・API・`fetch` が変わると最初から、`theme` だけなら絞り込みはそのまま）。戻り値の `unmount()` は、そのあと同じ要素に `mount` し直していたら何もしない。`fetch` は API を呼ぶときに使う関数（ヘッダーを足すとき） |
| `mountAll(root?)` | `data-devbi` の付いた要素のうち、まだ出していないものに出す。ページから消えた要素のものは片付ける。`unmount` で消した要素には出さない。ページにほかのプロジェクトの `devbi-embed.js` があれば、そちらのダッシュボードもそちらが出す。戻り値は新しく出した数 |
| `unmount(要素かセレクタ)` | ダッシュボードを消す（ページのどの `devbi-embed.js` が出したものでも）。もう一度出すときは `mount` |

ASP.NET の UpdatePanel のように画面の一部を入れ替えるページでは、入れ替えのあとに `mountAll()` を呼びます。

```js
Sys.WebForms.PageRequestManager.getInstance().add_endRequest(() => window.DevBI?.mountAll());
```

### 4. API とログイン

- `read_api` を使うダッシュボードには、読み取り API が要ります。`devbi-serve` を同じサーバーで動かすか、アプリに同じ形の API（[API の形](#api-の形)）を足して、`data-devbi-api` でその場所を指します。ASP.NET のアプリには、[C# の見本](#aspnetcで-api-を出す)をそのまま足せます。
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

ほかの React のアプリ（Vite でない、React 18 など）では、`devbi-embed.js` を使います（Next.js は [Next.js に置く](#nextjs-に置く)）。DevBI は自分の React で動くので、アプリの React の版は関係ありません。URL は変数にして `import()` に渡します（文字列をそのまま書くと、TypeScript やバンドラーがそのファイルを探しに行きます）。

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
| `<DevbiApp project={…} theme? exports? />` | アプリ全体。`#/<名前>` でダッシュボード、複数あれば一覧を出す。開発サーバーで `@devbi/editor` が入っていると、「編集」と「＋ 新しいダッシュボード」を出す（[GUI エディタ](#gui-エディタdevbieditor)）。`exports={false}` で「ファイル出力」のメニューを出さない（`exports={["xlsx", "pdf"]}` でそれだけ） |
| `<Dashboard project={…} name="sales" back?="#/" theme? isolate? exports? actions? params? onParamsChange? paramsInUrl? />` | ダッシュボード 1 つ。`params` と `onParamsChange` は[パラメーターの値](#url埋め込みreact-から値を渡す)を渡す口と聞く口。`paramsInUrl` で値を URL（`#/<名前>?from=…`）に読み書きする（`<DevbiApp>` が付ける）。見出しの右に「ファイル出力」のメニュー（[ファイル出力](#ファイル出力)。`exports={false}` で出さない、`exports={["xlsx", "pdf"]}` でそれだけ）。`actions` はその右に置くボタンなど。`project` は `loadProject()` の戻り値で、毎回同じものを渡す（別のものだと最初から）。`theme` は `"auto"`（既定。OS の設定）、`"light"`、`"dark"`。`isolate` で、ページの CSS の要素の名前だけの指定を打ち消す（[埋め込み](#2-画面に-2-行を足す)と同じ）。幅が 720px より狭いとタイルを 1 列に並べる |
| `mountDashboard(要素, project, { dashboard?, theme?, apiUrl?, fetch?, isolate?, exports?, params?, onParamsChange? })` / `unmountDashboard(要素)` | React を使っていないページの要素に、ダッシュボードを出す / 消す。`devbi-embed.js` の `mount` の中身 |
| `startEmbed(input, { auto?, global? })` | `devbi-embed.js` の中身。`data-devbi` の要素に出し（`auto: false` で出さない）、`window.DevBI` を作って `devbi:ready` を出す（`global: false` でしない）。ふつうは `@devbi/vite` の `embed` が使う |
| `loadProject(input)` | `virtual:devbi` の中身（`ProjectInput`）を検証して `Project` にする。`<DevbiApp>` は中でこれを呼ぶ。`ProjectInput.snapshots` は、`-- snapshot:` の行がある SQL の名前と時刻（`@devbi/vite` が入れる）。`ProjectInput.datasets` は、`api/*.sql` ごとのパラメーターと `-- key:`（`{ parameters, key? }`。`@devbi/vite` が入れる）。`ProjectInput.perspective` は Perspective の WebAssembly の URL（`{ server, client }`。`explore` が使う。`@devbi/vite` が入れる）。`ProjectInput.dev` は開発サーバーでだけ `@devbi/vite` が入れる（GUI エディタ、ファイルの変更の知らせ、ページを開いたあとに書き出した自作タイルを読む `importTile(path)`、`devUsers` の一覧 `users`（`{ name, note? }[]`。`<DevbiApp>` の「表示する利用者」）。型は `DevServer`） |
| `EXPORT_KINDS` / `ExportKind` | 「ファイル出力」の種類（`"xlsx"`・`"pdf"`・`"csv"`）。`exports` に並べる |
| `themeAttribute(theme)` / `injectStyles()` | `.devbi-root` に付ける `data-theme` / DevBI の CSS をページに入れる（`<Dashboard>` は自分で入れる）。GUI エディタが使う |
| `snapshotTimesOf(project, dashboard)` | そのダッシュボードが読むスナップショットの時刻（`["06:00"]` など。なければ空）。一覧の「毎日 6:00 の時点のデータ」に使っている |
| `useDevbiQuery`、`useTileSize`、`useTimeExtent` | [自作タイル](#自作タイルjsx)を参照 |
| `useDevbiRows(query, { tileId? })` | `model` の行をそのまま読む（`explore` のタイルが使う）。期間とほかのタイルの選択（`tileId` のタイルのもの以外）で絞る。戻り値は `{ table, limit, truncated, newest, filters, loading, error }`（`table` は Apache Arrow の表で、新しいほうから `limit` 行まで。`truncated` は、それより多かったか） |
| `useDevbi()` | ダッシュボードの文脈（`project`、`dashboard`、`engine`、`selection`、`view(name?)`、`params`（パラメーターの欄の値）、`readDataset(name, values)`、`refresh()`（「更新」））。`engine` は、はじめて読んだときに DuckDB-wasm を立ち上げる（データセットだけのダッシュボードは立ち上げない） |
| `DevbiProvider` | `<Dashboard>` の中で使っている文脈。自分でタイルを並べるとき用 |
| `createEngine({ bundle, baseUrl?, apiUrl?, fetch?, snapshots?, extensionRepository?, debug? })` | DuckDB-wasm を立ち上げる。`apiUrl` は `read_api` の API の場所（既定は `baseUrl` の下の `api/`。最後の `/` はなくてもよい）、`fetch` は API を呼ぶときに使う関数（ヘッダーを足すときなど）。`query(sql)`（結果はキャッシュする）、`table(sql)`（Arrow の表だけ。キャッシュしない。多い行用）と `loadView(view, { apiUrl?, fetch? })` を持つ（`loadView` に渡すと、そのビューだけほかの API から読む。同じエンジンで、API ごとに別の表になる。`useDevbi().engine` の `loadView(view)` は、そのダッシュボードの API と `fetch` で読む）。`snapshots` は[スナップショット](#毎朝のスナップショット)から読む SQL の名前と時刻で、`snapshotsOf(view)` はそのビューが読んだスナップショットと、作られた時刻を返す。ふつうは `<DevbiApp>` が自動で作る。エンジンのコード（DuckDB-wasm の JS と Apache Arrow）は最初の呼び出しで別のファイルとして読む |
| `DashboardSelection` | クロスフィルタの状態（`set`、`clear`、`own`、`filtersFor`、`entries`、`subscribe`） |
| `builtinTiles` | 組み込みタイルの一覧（`type` → `{ component }`。キーは組み込みの種類の名前だけなので `builtinTiles.bar.component` と書ける）。グラフ（`bar`、`line`、`area`）と `table` は `React.lazy` で、Observable Plot と spreadsheet-grid は、はじめて使うときに読む。自分で描くときは `<C {...props} />` の形で、`<Suspense>` の中に置く（関数として呼ばない。自作タイルは、もとから `<Suspense>` の中）。「[コードにする](#コードにする)」で書き出したファイルが使う |
| `renderMarkdown(text)` | `markdown` タイルの描画を React の要素で返す（HTML は解釈しない） |

DuckDB-wasm のエンジンはページに 1 つで、ダッシュボードを切り替えても、API の場所が違うダッシュボードを並べても使い回します。同じ SQL の結果はページを開いている間キャッシュします。

## devbi（コア）

ブラウザでも Node でも動きます。テストやスクリプト、ほかのツールから使えます。

| 名前 | 中身 |
| --- | --- |
| `parseMetricsYaml(text, name)` / `defineMetricsView(obj, name)` | metrics.yaml を検証して `MetricsView` にする。間違いは `MetricsError`（`issues` に項目ごと） |
| `parseDashboardJson(text, name)` / `defineDashboard(obj, name)` | dash.json を検証する。間違いは `DashboardError` |
| `formatDashboardJson(spec)` | dash.json を、手で書いたときと同じ形の文字にする（[保存のしかた](#保存のしかたgit-の差分)）。GUI エディタが保存に使う |
| `checkQuery(obj, source)` | クエリだけを検証する |
| `compileQuery(view, query, { filters?, model? })` | クエリを DuckDB の SQL にする。戻り値は `{ sql, fields }`。名前の間違いは `QueryError` |
| `compileRows(view, query, { filters?, model? })` | `model` の行をそのまま読む SQL（`explore`）。`query` の `filters`・`limit`（既定は `EXPLORE_ROWS` = 100,000）だけを使い、新しいほうから（同じ日時は、すべての列の順で）`limit + 1` 行を読む（多かったかが分かるように）。戻り値は `{ sql, limit, newest }`（`newest` は `time` の列で並べたか）。`malloy`・`sql` のクエリは `QueryError`（`ROWS_CUSTOM`） |
| `compileTimeExtent(view)` | 日付の最初と最後を出す SQL |
| `customQuery(query)` / `customViews(query, names)` / `customMainView(query, views)` | `malloy` か `sql` のクエリか（`{ lang, text }`）/ それが表（source）として読む指標ファイルの名前 / その絞り込みとクリックの指標ファイル |
| `compileSource(view, { columns, filters?, model? })` | Malloy・SQL のクエリが読む行の SQL（`model` の列 `columns` と式の軸、絞り込み。列と同じ名前の軸は、その列を置きかえる） |
| `compileMalloy(text, [{ name, table, schema }])` | Malloy を DuckDB の SQL にする（Malloy はこのとき読み込む）。戻り値は `{ sql, columns }`。間違いは `QueryError` |
| `withSources(sql, [{ table, sql }])` / `customTable(lang, name)` | SQL の前に、指標ファイルの行を CTE として足す / その名前 |
| `customFields(lang, columns, view)` / `sqlColumns(columns)` / `customSelectable(fields, view)` | 結果の列を、指標ファイルの軸・時間・指標の `fields` にする（軸の列はその軸の名前に）/ DuckDB の型から列の種類 / クリックでほかのタイルを絞る列（指標ファイルの軸と、粒度のある時間） |
| `scanSources(sql)` / `apiParams(source)` | `model` の中の `read_*(...)` と `read_api(...)` を見つける / `read_api` の引数をパラメーターの値にする |
| `apiCalls(sql)` / `snapshotFile(name, params)` | `model` の中の `read_api` の名前とパラメーター / そのスナップショットのファイル名（ブラウザとサーバーで同じ） |
| `readXlsx(bytes, { sheet?, range?, header?, allVarchar? })` | Excel を型つきの列で読む。戻り値は `{ sheet, rowCount, columns: [{ name, type, values }], range? }`（`range` は読んだセルの範囲で、見出しの行を含む。`A1:K3068`） |
| `listSheets(bytes)` | シートの名前 |
| `writeXlsx([{ name, rows }])` | Excel を書く（テストやサンプルデータ用。シートごとに表 1 つ、日付は Excel の日付） |
| `Workbook` | 書式つきの Excel を書く（依存なし）。`new Workbook({ font? })`（既定は游ゴシック）、`book.sheet(名前)`（Excel で使える名前にして、重なれば `(2)` を付ける）、`sheet.add(...セル)` で 1 行（セルは値か `{ v, s?, link?, text?, noWidth? }`。`s` は `{ bold, italic, underline, strike, size, color, fill, border, wrap, format }`、`format` は Excel の表示形式。`link` は `'シート'!A1` のようなブックの中の場所。`text` は列幅を決める表示の文字）、`sheet.skip(n?)`、`sheet.freeze = { rows, cols? }`、`sheet.filter = [見出しの行, 最後の行, 列の数]`（0 から数える）、`sheet.widths`（列幅を決めるとき）、`await book.toBytes()`。日付は Excel の日付になる（表示形式がなければ `yyyy/m/d`、時刻があれば `yyyy/m/d h:mm`）。数値はどれも数値で書く（Excel は 15 桁まで）。列幅は中身から（全角は 2 文字ぶん、60 まで）。印刷は A4 横で幅に合わせる。1 シートは 1,048,576 行・16,384 列まで（`MAX_ROWS`・`MAX_COLS`。超えると `add` がエラー） |
| `addResultTable(sheet, rows, fields, { fiscalYearStart? })` / `resultCell(value, field, fiscalYearStart?, style?)` | クエリの結果（`rows` と `fields`）を、見出しつきの表で書く（見出しを固定し、オートフィルタを付ける）/ 結果の値 1 つをセルにする。数値と日付はそのままで、[書き出し](#excel)と同じ表示形式になる。「ファイル出力」の「Excel」が使う |
| `csvParts(rows, fields)` / `csvValue(value, time?)` / `csvTimeFormat(values)` / `CSV_BOM` | クエリの結果を CSV にする（見出しは `fields` の `label`。UTF-8 の BOM で始まり、改行は CRLF。日時は列ごとにそろえる）。戻り値は文字の配列で、そのまま `new Blob(parts)` に渡せる（100 万行でも 1 つの文字にしない）/ 値 1 つを CSV のセルの文字にする（[CSV](#csv)と同じ。`time` は `"date"`・`"time"`・`"ms"`）/ 列の値から、その列の日時の形を決める。「ファイル出力」の CSV が使う |
| `writeZip([{ name, data, modified? }])` | ZIP を作る（依存なし。deflate は `CompressionStream`）。`data` は `Uint8Array`・文字・文字の配列、`modified` は展開したときのファイルの日時。名前は UTF-8 |
| `excelNumberFormat(format)` / `excelTimeFormat(grain, fiscalYearStart?, withTime?)` | [書式](#書式)を Excel の表示形式にする / 時間の粒度を Excel の表示形式にする（四半期は `undefined`） |
| `formatNumber(value, format?)` / `formatTime(date, grain?, fiscalYearStart?)` / `formatValue(value, field?)` | [書式](#書式)どおりの文字にする |
| `getMeasure(view, name)` / `getDimension(view, name)` | 名前で引く |
| `defineQuery(query)` / `RowOf<typeof query>` | 名前を検査するクエリと、その行の型（[自作タイル](#自作タイルjsx)） |
| `dashboardJsonSchema(names?)` / `metricsJsonSchema()` | dash.json と metrics.yaml の JSON Schema。`names`（`{ metrics, measures, dimensions, fields }`）を渡すと、その名前だけを許す |
| `dateRangePresets(max, fiscalYearStart?)` | `date-range` の期間の一覧（`{ key, label, range: [始まり, 終わり) \| null }`）。データの最終日 `max` から数える。画面と `devbi-check` が使う |
| `TILE_TYPES` / `TILE_TYPE_NAMES` / `DATE_RANGE_PRESETS` | 組み込みタイルの種類（`label` は短い名前、`description`、`options`、`size` は GUI エディタで足したときの大きさ）、`date-range` の期間の名前。`options` のそれぞれ（`TileOptionSchema`）には、GUI エディタの設定欄の名前 `label`、`enum` の値の名前 `enumLabels`（JSON Schema の `enumDescriptions` にもなり、VS Code の補完に出る）、入れ方 `input`（`text` は複数行、`field` は軸か時間の列、`metrics` は指標ファイル、`json` は JSON で書くオブジェクト）がある。`rows: true` の種類（`explore`）は、`model` の行を読み、`query` は `metrics`・`filters`・`limit`・`period` だけを使う |
| 型 | `Query`、`Filter`、`Row`、`Scalar`、`FieldInfo`、`TileSpec`、`TileProps`、`Grain`、`MetricsView`、`Dashboard`、`MetricsRegistry`・`DatasetRegistry`（`.devbi/env.d.ts` が名前と行の型を足す）、`DatasetName`・`DatasetRow<名前>` など |

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

印刷（「印刷・PDF」とブラウザの印刷）では、背景を白（`--devbi-bg: #ffffff`）にし、ダークの色が効くところ（OS のダークモードや `data-theme="dark"`）にはライトの色を入れます。上のように `.devbi-root` で変えた色は、紙の上でもそのままです。紙の上だけ色を変えるときは、`@media print { .devbi-root.devbi-root { --devbi-accent: …; } }` のように書きます（クラスを 2 つ重ねると、ダークモードから印刷するときも効きます）。

自作タイルでもこの変数を使えば、ダークモードに合わせて色が変わります。

`table` タイルの表（spreadsheet-grid）は、背景・文字・枠線・強調の色をこの変数から取ります。ライト / ダークは `.devbi-root` に合わせます（`data-theme` が `"light"` か `"dark"` ならそれ、ほかは OS の設定）。列見出しの ⋮ のメニューも、タイルと同じ色と書体です（メニューは表の外に出ますが、開くときに表の変数を写します）。表だけを変えるときは、`.devbi-root .devbi-table-grid` に spreadsheet-grid の変数（`--ssg-*`。メニューは `--ssg-panel-*`）を書きます。

## コマンド

リポジトリのルートで実行します。

| コマンド | 中身 |
| --- | --- |
| `pnpm example:dev` | パッケージをビルドして、サンプルの開発サーバーを開く（<http://localhost:5173>）。「編集」で GUI エディタ（保存するとサンプルの dash.json が変わるので、試したあとは `git checkout examples/sales/dashboards`） |
| `pnpm example:preview` | サンプルを静的ビルドして開く（<http://localhost:4173>） |
| `pnpm example:serve` | サンプルをビルドして、`devbi-serve` で開く（<http://localhost:8080>）。「売上ダッシュボード（DB から）」はサンプルの SQLite を API から読み、「売上の日次集計」は起動したときに作ったスナップショットを読む |
| `pnpm example:nextjs` | サンプルのダッシュボードを、Next.js のアプリ（`examples/nextjs`）に置いて開く（<http://127.0.0.1:3000>）。API は `app/devbi/[...path]/route.ts`。`DEVBI_DB` を付けて起動すると、そのデータベースから読む（SQL Server は `copy-db` で表を写してから） |
| `pnpm --filter devbi-example-sales exec devbi-snapshot` | サンプルのスナップショットを、いま `dist/snapshots/` に作る（先にビルド） |
| `pnpm try-xlsx <Excel> [--sheet 名前] [--name local_名前] [--force]` | 手元の Excel から下書きのダッシュボードを作る。ファイルは git に入らない |
| `pnpm gen` | パッケージをビルドして、サンプルの `.devbi/`（補完と型）を作り直す。開発サーバーを動かしている間は自動 |
| `pnpm example:check` | パッケージをビルドして、サンプルの指標とすべてのタイルのクエリをデータに流して確かめる（[devbi-check](#ファイルを確かめるdevbi-check)） |
| `pnpm --filter devbi-example-sales inspect <ファイル>` | サンプルのフォルダで、データのファイルの列を見る（[devbi-inspect](#データの中を見るdevbi-inspect)） |
| `pnpm test` | 単体テスト（指標 → SQL を DuckDB で実際に流す、xlsx、書式、API）。パッケージのソースを直接読むので、先にビルドしなくてよい。`DEVBI_TEST_PG`、`DEVBI_TEST_MSSQL`、`DEVBI_TEST_MYSQL`、`DEVBI_TEST_MARIADB`、`DEVBI_TEST_ORACLE` に URL を入れると、そのデータベースのテストも流す（表を作り直すので、テスト用のデータベースで） |
| `pnpm e2e` | パッケージとサンプルをビルドして `devbi-serve` で開き、ブラウザで操作を確かめる。GUI エディタは、サンプルを `examples/sales/e2e-work/` に写して Vite の開発サーバー（ポート 5179）で確かめる（git に入らない） |
| `pnpm e2e:nextjs` | Next.js の見本をビルドして `next start` で開き、ブラウザで確かめる |
| `pnpm --filter devbi-example-sales gen:db` | `data/sales.xlsx` から、サンプルの SQLite（`db/sales.sqlite`）を作り直す |
| `pnpm --filter devbi-example-sales copy-db <URL>` | サンプルの 4 つの表を、SQL Server・Oracle・MySQL に写す（先に同じ名前の表を消す）。`DEVBI_DB` をその URL にすると、「DB から」のダッシュボードがそのデータベースから読む |
| `pnpm typecheck` / `pnpm build` | 型チェック（サンプルは `.devbi/` を作ってから） / パッケージのビルド |
| `pnpm check:packed` | （Mac・Linux）パッケージを npm に出す形（`pnpm pack`）に固め、`create-devbi` で作ったプロジェクトに npm と pnpm で入れて、型チェック・`check`・ビルド・開発サーバーと GUI エディタ（「コードにする」でページが読み込み直されないこと）を確かめる。作ったプロジェクトは一時フォルダに残る（場所が最後に出る）。`DEVBI_PACKED_DIR` で場所を決められる |
| `node scripts/version.mjs <版>` | 公開する 6 つのパッケージの版をそろえて変える。公開のしかたは [releasing.md](releasing.md) |
| `pnpm release [--dry-run] [--yes]` | 6 つのパッケージを、手元から npm に出す（[releasing.md](releasing.md)）。main と同じで変更がないこと・その CI が通っていること・版がそろっていること・npm のログイン・Organization `devbi` のメンバーであることを確かめ、ビルドしてパックし（git にないファイルが入っていたら止まる）、一覧を見せて `y` を待ってから `npm publish`（passkey で確認）。npm にもうある版は飛ばす。`--dry-run` はアップロードだけしない（ログイン不要）、`--yes` は `y` を待たない |
| `pnpm docs:dev` / `pnpm docs:build` | ドキュメントのサイト（README.md と docs/*.md、VitePress）を開発サーバーで開く（<http://localhost:5173/devbi/>） / `docs/.vitepress/dist/` にビルドする。ページ・ファイル・見出し（`#…`）へのリンクが切れていると、ビルドが止まる。公開は `.github/workflows/pages.yml` が、ライブデモ（`/demo/`）といっしょにする |
| `dotnet test dotnet/DevBI.sln` | C# の見本のテスト（.NET 10 SDK）。SQL ファイルの読み方が TypeScript と同じか（`packages/server/test/fixtures/sqlserver-cases.json` と比べる）と、HTTP の答え方。`DEVBI_TEST_MSSQL` があれば SQL Server でも流す |
| `dotnet run --project dotnet/samples/DevBI.Sample -- --urls http://127.0.0.1:4179` | サンプルのビルド（`dist/`）と API を ASP.NET Core で出す。接続は環境変数 `ConnectionStrings__DEVBI_DB` に ADO.NET の接続文字列で（先に `copy-db` で SQL Server に表を写す） |
| `E2E_BASE_URL=http://127.0.0.1:4179 pnpm --filter devbi-example-sales exec playwright test` | e2e を、`devbi-serve` ではなく、そこで動いているサーバーに向けて流す |
