# SQL データセットを表に繋ぐ（設計）

状態: 設計（実装はまだ）。2026-11-23 作成。
関連: 行レベル制御の設計（`docs/design/row-level-security.md`、別の PR）。パラメーターの予約名 `:user.*`、権限の確かめ、スナップショットの扱いはそちらに合わせる（[9 章](#9-守りと行レベル制御)）。

このファイルはドキュメントサイトのページにはならない（`docs/` の下のフォルダは載せない）。実装した分は、その PR で [reference.md](../reference.md) と [manual-check.md](../manual-check.md) に書く。

## 1. 何を作るか

SSRS（SQL Server Reporting Services）のように、

1. SQL を名前を付けて「データセット」として置き、
2. タイル（まず表）に「このデータセット」と書けば、
3. DevBI が SQL の列とパラメーターを読み取り、パラメーターの入力欄と表を出す。

表には spreadsheet-grid（作者のライブラリ、MIT）を使う。SSRS の表（Tablix）は HTML を描いて終わりだが、こちらは画面の中で並べ替え・列ごとの絞り込み・グループと小計・合計・範囲を選んで Excel へのコピー・100 万行のスクロールができる。ここを差別化の中心に置く。

ねらいの形（いちばん短い書き方）:

```sql
-- api/order_lines.sql
-- 受注の明細。受注日が :from から :to の前まで、選んだ地域のもの。
-- param: from date label=受注日（から） default=month_start
-- param: to date label=受注日（まで） default=tomorrow
-- param: regions text[] label=地域 values=regions default=all
-- key: 受注番号, 行番号
SELECT o.order_date AS 受注日, o.order_no AS 受注番号, l.line_no AS 行番号, c.name AS 顧客, c.region AS 地域,
       p.name AS 商品, l.qty AS 数量, l.qty * l.unit_price AS 金額
  FROM orders o
  JOIN order_lines l ON l.order_no = o.order_no
  JOIN customers c ON c.id = o.customer_id
  JOIN products p ON p.id = l.product_id
 WHERE o.order_date >= :from AND o.order_date < :to
   AND c.region IN (:regions)
```

```json
{ "id": "lines", "type": "table", "x": 0, "y": 0, "w": 12, "h": 8, "title": "受注明細",
  "query": { "dataset": "order_lines" } }
```

これだけで、ダッシュボードの見出しの下に「受注日（から）」「受注日（まで）」「地域」の入力欄が出て、値を変えるとサーバーが SQL を実行し直し、表が入れ替わる。

## 2. SSRS の流れと、いまの DevBI

### 2.1 SSRS

| SSRS | 中身 |
| --- | --- |
| データソース | 接続先（共有できる） |
| データセット（共有データセット `.rsd`） | SQL とクエリのパラメーター（`@from`）。フィールド（列）はクエリから自動で決まる |
| レポートのパラメーター | 型、表示名、既定値、候補の一覧（別のデータセットから）、複数の値、NULL を許す、隠す。候補の一覧は前のパラメーターに連動できる（カスケード） |
| Tablix（表） | データセットに結び付ける。行グループと小計、並べ替えのボタン、表示の切り替え（開閉） |
| 実行 | パラメーターを入れて「レポートの表示」で、サーバーが SQL を実行して描く。ページに分けて出す |
| そのほか | ドリルスルー（行から別のレポートへ値を渡す）、サブレポート、購読（メール配信）、印刷向けのページのレイアウト、URL にパラメーターを書いて開く |

### 2.2 いまの DevBI にあるもの

- `api/<名前>.sql`: サーバーに置く SELECT 1 文。`:名前` がパラメーター、`-- connection:` で接続先、`-- snapshot:` で毎朝のファイル。書き込みにつながる文は通さず、読み取り専用のトランザクションで実行する（SQLite / PostgreSQL / SQL Server / Oracle / MySQL）。コードの中でもこれを `Dataset` と呼んでいて、`GET api/schema` は `datasets` を返す。つまり **SSRS の共有データセットにあたるものは、もうある**。
- `read_api('<名前>', from = '2024-04-01')`: metrics.yaml の `model` から読む。パラメーターは**書いた値で固定**。ページを開くと 1 回だけ読み、あとはブラウザの DuckDB-wasm で集計する。
- `table` タイル: spreadsheet-grid（`/lite` に列メニューと列幅の自動調整だけ）。中身は指標ファイルの集計の結果か、`query.sql`（ブラウザの DuckDB の SQL）の結果。
- `query.sql` / `query.malloy`: 指標ファイルの行（明細）を、ブラウザの中で SQL / Malloy で集計する。

### 2.3 足りないもの

| SSRS にあるもの | いまの DevBI | 足りないもの |
| --- | --- | --- |
| データセット | `api/<名前>.sql` | パラメーターの型・表示名・既定値・候補・複数の値 |
| フィールド（列）の自動 | 実行した結果の Arrow の列 | 実行する前に列が分からない（エディタで列を選べない、`devbi-check` で列名を確かめられない） |
| レポートのパラメーター | なし（`read_api` に値を書くだけ） | 入力欄、値を変えたら読み直す、URL・埋め込みから値を渡す |
| 表をデータセットに結ぶ | SQL → metrics.yaml（指標が 1 つは要る）→ dash.json の 3 段 | データセットを直接タイルに書けない |
| 大きな結果 | 全部をブラウザへ（上限 100 万行） | サーバーで絞ってページごとに読む形 |
| 行グループと小計 | `pivot` タイル | 表の中のグループと小計、合計の行（spreadsheet-grid にはある） |
| ドリルスルー | なし | 行をクリックして別の表のパラメーターに入れる |

### 2.4 SQL を書ける場所の整理

この設計で、SQL を書く場所は 3 つになる。混ざらないように役目を分ける。

| 場所 | どこで動く | 何の SQL | 何に使う |
| --- | --- | --- | --- |
| `api/<名前>.sql`（データセット） | サーバー（社内の DB） | その DB の SQL | DB から行を取る。パラメーターで DB 側で絞る。**表に直接つなぐのはこれ** |
| metrics.yaml の `model` | ブラウザ（DuckDB-wasm） | DuckDB の SQL | ファイルや `read_api` の行をまとめて 1 つの表にする。指標と軸の元 |
| タイルの `query.sql` | ブラウザ（DuckDB-wasm） | DuckDB の SQL | 指標ファイルの行を、名前では言えない形で集計する |

## 3. 全体の形

```
api/order_lines.sql ── -- param: の行（型・表示名・既定値・候補）
        │                -- key: の行（行を見分ける列）
        ▼
GET api/schema ─────────▶ ブラウザ: パラメーターの欄を作る（dash.json の params で上書き）
                                │ 値が決まる・変わる
                                ▼
POST api/query {name, params}  ◀── 表（ブラウザで持つ）: 結果を全部受け取り、grid が並べ替え・絞り込み・小計
POST api/rows  {name, params, start, end, filters, sort} ◀── 表（サーバーで絞る）: 見えている分だけ
        │
        ▼
サーバー: データセットの SQL（中に :user.* の行レベル制御）→ 表の絞り込み・並べ替え・ページ → 読み取り専用で実行 → Arrow
```

## 4. データセット（`api/<名前>.sql`）

### 4.1 `-- param:` の行

`-- connection:` と `-- snapshot:` と同じく、ファイルの先頭のコメントに書く。1 つのパラメーターに 1 行。

```sql
-- param: from date label=受注日（から） default=month_start
-- param: regions text[] label=地域 values=regions default=all
-- param: customer integer label=顧客 optional
-- param: status text label=状態 values=statuses default=受付
```

- 形: `-- param: <名前> <型> <キー>=<値> …`。値に空白を入れるときは `label="受注日 から"` と `"` で囲む。
- `<名前>` は SQL の `:名前` と同じ（大文字と小文字は区別しない）。SQL にない名前を書く、型を書かない、同じ名前を 2 回書くのはエラー。
- `-- param:` を書かないパラメーターは、いまと同じ（型なし。文字・数値・真偽・null をそのまま渡す）。入力欄は文字の欄になる。今の `api/*.sql` と `read_api` はそのまま動く。
- `user` と `user.` で始まる名前は書けない（行レベル制御の予約名。[9 章](#9-守りと行レベル制御)）。

| キー | 中身 |
| --- | --- |
| `label` | 入力欄の名前。既定はパラメーターの名前 |
| `default` | 既定値（[4.5](#45-既定値)） |
| `values` | 候補の一覧を出すデータセットの名前（[4.4](#44-候補の一覧と連動)） |
| `optional` | 空でもよい。空のときは NULL を渡す。書かなければ、値が入るまで表を出さず「受注日（から）を入れてください」と出す |
| `hidden` | 入力欄を出さない（URL・埋め込み・クリックからだけ入る） |

別ファイル（`api/<名前>.yaml`）に書く案も考えたが、SQL と 2 つのファイルがずれやすいので、1 つのファイルに書く案をすすめる（[14 章](#14-決めてほしいこと)の 1）。

### 4.2 型と値の渡し方

| 型 | 入力欄 | ブラウザから送る値 | サーバーの検査と渡し方 |
| --- | --- | --- | --- |
| `text` | 文字の欄（候補があれば選ぶ欄） | 文字 | 長さの上限（4,000 文字） |
| `integer` | 数の欄 | 数 | 整数か |
| `number` | 数の欄 | 数 | 有限の数か |
| `date` | 日付の欄 | `'2026-04-01'` | 日付として読めるか。DB ごとに日付として比べられる形で渡す |
| `datetime` | 日時の欄 | `'2026-04-01T09:00'`（時差なし） | 同上 |
| `boolean` | チェック | `true` / `false` | Oracle（23ai より前）と SQLite は `1` / `0`（いまと同じ） |

- サーバーは、ブラウザの値を型で検査してから渡す。型に合わない値は 400 と日本語のメッセージ。
- 日付をドライバーにどの形で渡すか（文字か、ドライバーの日付の型か）は DB ごとに決める。Oracle の Thin モードは JavaScript の日付をサーバーの時差で読む問題がある（[reference.md の Oracle の注意](../reference.md#接続先)）ので、`NLS_DATE_FORMAT` に合わせた文字で渡す案が有力。5 つの DB のテストで決める。
- metrics.yaml の `read_api('orders', from = '2024-04-01')` の値も同じ検査を通る。

### 4.3 複数の値（`text[]` など）

型に `[]` を付けると複数の値。SQL では `IN (:regions)` の形でだけ使える（それ以外の場所に書くと、読み込むときにエラー）。

- サーバーが値の数だけ広げる: `IN (:regions)` → `IN (?, ?, ?)`（PostgreSQL なら `$2, $3, $4`）。値はすべてパラメーターで渡し、SQL に値を書き込まない。
- 1 つも選ばないのは「入っていない」扱い（`optional` でも同じ。`IN ()` は書けないので）。「すべて」は候補の値を全部送る（SSRS の「すべて選択」と同じ）。
- 上限は 1 つのパラメーターに 1,000 個（Oracle の IN の上限が 1,000、SQL Server のパラメーターの上限が 2,100）。超えるときは「候補を絞るか、すべてのときはこのパラメーターを使わない SQL にしてください」と出す。候補が 1,000 を超えそうな軸（顧客など）は、複数の値ではなく `optional` の 1 つの値（`(:customer IS NULL OR c.id = :customer)`）をすすめる、と reference に書く。

### 4.4 候補の一覧と連動

`values=regions` は、`api/regions.sql` の結果を候補にする。1 列目が値、2 列目（あれば）が表示名。

```sql
-- api/regions.sql
-- 地域の一覧（受注のある地域だけ）。
SELECT DISTINCT region AS 値 FROM customers ORDER BY 1
```

- 候補のデータセットにもパラメーターがあれば、同じ名前のパラメーターの値で実行する。たとえば `api/customers_in.sql` が `WHERE region IN (:regions)` なら、地域を変えると顧客の候補が読み直される（SSRS のカスケード）。
- 連動は名前でたどる。輪になる（A の候補が B を使い、B の候補が A を使う）とエラー。
- 上の値が変わって、下の値が候補から外れたら外す（既定値があれば既定値に戻す）。
- 候補は 10,000 件まで。超えたら打ち切って「ほかにもあります」と出す。

### 4.5 既定値

| 書き方 | 意味 |
| --- | --- |
| `default=2024-04-01`、`default=10`、`default=受付` | その値 |
| `default=today` / `tomorrow` / `yesterday` | 今日 / 明日 / 昨日 |
| `default=month_start` / `next_month_start` / `previous_month_start` | 今月 / 来月 / 先月の 1 日 |
| `default=year_start` / `fiscal_year_start` | 今年の 1/1 / 今年度の初日（年度の始まりは `fiscal_year_start` の月。dash.json の `params` か、データセットの `-- param:` の `fiscal_year_start=4`） |
| `default=today-30` | 30 日前（`+` も書ける） |
| `default=all` | 複数の値で、候補の全部 |
| `default=関東,近畿` | 複数の値（`,` 区切り） |

- 「今日」は**見ている人のブラウザの日付**。`date-range` の「最新の月」（データの最終日が基準）とは違う。データベースから取る前なので、データの最終日はまだ分からないため。
- 既定値のないパラメーターは、入れるまで表を出さない（`optional` なら NULL）。

### 4.6 `-- key:` の行

```sql
-- key: 受注番号, 行番号
```

結果の 1 行を見分ける列（結果の列の名前）。次のことに使う。

- 表の行の見分け（行を選んだまま読み直しても、同じ行に選択が残る）。
- サーバーで絞る表（[7.3](#73-サーバーで絞ってページ送りrows-server)）の並べ替えの最後に足す。同じ値の行の並びが毎回同じでないと、ページの境目で行が重なったり抜けたりするため。サーバーで絞る表には `-- key:` が要る（ないと `devbi-check` とタイルでエラー）。

### 4.7 SQL を読み取る（列とパラメーターの型）

「SQL を解析して表示する」のうち、列の名前と型は、**DevBI が SQL を自前で読むのではなく、データベースに聞く**。5 つの DB の書き方の違い（Oracle の大文字の別名、SQL Server の `[列]`、計算した列の型）を自前で正しく読むのは無理があり、DB に聞けば実際に返る列と同じになるため。どの DB も、実行せずに結果の列を返す仕組みがある。

| DB | 結果の列（実行しない） | パラメーターの型 |
| --- | --- | --- |
| SQL Server | `sp_describe_first_result_set` | `sp_describe_undeclared_parameters` |
| PostgreSQL | `PREPARE` + `pg_prepared_statements.result_types`（16 以上。15 以下は `LIMIT 0` で包んで実行） | `pg_prepared_statements.parameter_types` |
| Oracle | node-oracledb の `getStatementInfo()` | なし |
| MySQL / MariaDB | mysql2 の `prepare()` の `columns` | なし（数だけ） |
| SQLite | `prepare()` の `columns()` | なし |

- これを「列を聞く」口（`describe`）として @devbi/server に足す。使うのは開発のときだけ（GUI エディタの列の一覧、`devbi-check` の列名の確かめ、`pnpm gen` の行の型）。ページを開いたときの表の列は、いまと同じく返ってきた Arrow の列から決める（聞きに行く往復を増やさない）。
- パラメーターの型を DB が教えてくれるとき（SQL Server、PostgreSQL）は、`-- param:` がないパラメーターに「`-- param: from date` と書くと日付の欄になります」と `devbi-check` が教える。勝手に型を決めはしない（書いたものだけが動きを決める）。
- Oracle の桁の指定のない `NUMBER` や SQLite の計算した列のように、型が中身で決まる列は「実行するまで分からない」として扱う。

## 5. ダッシュボードのパラメーター（dash.json の `params`）

### 5.1 書かなくても出る

ダッシュボードのタイルが読むデータセットの `-- param:` から、パラメーターの欄を作る。同じ名前のパラメーターは 1 つの欄にまとめる（明細の表と、地域別の小計の表が同じ `from` を使えば、欄は 1 つ）。

### 5.2 書いて変える

```json
{
  "title": "受注明細",
  "params": {
    "from": { "label": "期間（から）", "default": "fiscal_year_start", "fiscal_year_start": 4 },
    "to": { "label": "期間（まで）", "default": "tomorrow" },
    "regions": { "default": ["関東"] },
    "customer": { "type": "integer", "hidden": true }
  },
  "tiles": [ … ]
}
```

- キーは `-- param:` と同じ（`type`、`label`、`default`、`values`、`optional`、`hidden`、`fiscal_year_start`）。`default` の複数の値は配列でも書ける。
- 書いたものが `-- param:` より勝つ。`type` が `-- param:` と食い違うとエラー。
- 欄の並びは `params` に書いた順、そのあとに書いていないものをタイルの順に。

### 5.3 タイルとのつなぎ方

タイルの `query.params` で、データセットのパラメーターに何を入れるかを書く。書かなければ同じ名前のダッシュボードのパラメーター。

```json
"query": {
  "dataset": "order_lines",
  "params": {
    "from": { "param": "start" },
    "status": "出荷済み"
  }
}
```

- `{ "param": "<名前>" }` はダッシュボードのパラメーター、それ以外（文字・数・真偽・null・配列）は固定の値。固定の値を入れたパラメーターは欄に出ない。
- 同じデータセットを、固定の値を変えて 2 つのタイルに置ける（「受付」の表と「出荷済み」の表）。

### 5.4 欄の見た目と、読み直すとき

- 欄はダッシュボードの見出しの下に横に並べる（SSRS のツールバーの位置）。狭い画面では 1 列。`date-range` などのタイルとは別の場所で、タイルの並び（x, y）には入らない。
- 値を変えたら、決まった時点ですぐ読み直す（日付は選び終えたとき、文字は Enter か欄を離れたとき、複数の値は一覧を閉じたとき）。SSRS のように「表示」ボタンを押してから読む形も選べるようにする（`"apply": "button"`。重い SQL のダッシュボード向け）。どちらを既定にするかは [14 章](#14-決めてほしいこと)の 3。
- 読み直している間は前の表を薄くして残す（空にしない）。
- 見出しの横に「更新」（同じパラメーターで DB から読み直す）。
- 必須のパラメーターが空のタイルは、表の代わりに「受注日（から）を入れてください」。

### 5.5 URL・埋め込み・React から値を渡す

- URL: `#/sales-report?from=2026-04-01&regions=関東,近畿`。値を変えると URL も変わるので、その URL を送れば同じ表が開く（SSRS の URL アクセスと同じ）。
- 埋め込み: `<div data-devbi="sales-report" data-devbi-params='{"customer": 1024}'>`、`DevBI.mount(el, { params })`。
- React: `<Dashboard params={{ customer: 1024 }} onParamsChange={…} />`。社内アプリの画面で選んでいる顧客を渡す、といった使い方。
- `hidden` のパラメーターも、これらからは入る。**パラメーターは見る人が変えられる値なので、権限には使わない**（URL を書き換えれば別の顧客になる）。見せてよい行を決めるのは行レベル制御（`:user.*`）の役目（[9 章](#9-守りと行レベル制御)）。

## 6. タイルから読む（`query.dataset`）

### 6.1 書き方

`query.sql` / `query.malloy` と同じく、`query` の中に書く。

| キー | 中身 |
| --- | --- |
| `dataset` | `api/<名前>.sql` の名前 |
| `params` | データセットのパラメーターに入れるもの（[5.3](#53-タイルとのつなぎ方)） |

- `measures`・`dimensions`・`time`・`sort`・`limit`・`malloy`・`sql`・`metrics`・`filters`・`period` とは一緒に使えない（並べ替えと件数は SQL か表の操作で）。
- 自作タイル（JSX）も `export const query = { dataset: "order_lines" }` で、`rows` と `fields` を受け取れる。

### 6.2 列（`fields`）の決め方

返ってきた Arrow の列から、`query.sql` のタイルと同じ考え方で決める。

| 列の型 | `fields` の `kind` | 既定の書式 |
| --- | --- | --- |
| 数（整数・小数） | `measure` | 数の書式（`#,##0`。小数は `#,##0.##`） |
| 日付・日時 | `dimension` | `2026/04/01`、`2026/04/01 9:00` |
| 文字・真偽 | `dimension` | そのまま |

- `-- key:` の列は数でも `dimension`（受注番号に 3 桁の区切りを付けない）。
- 表の `options.columns`（[7.1](#71-表の-options)）で、表示名・書式・種類を列ごとに変えられる。

### 6.3 表のほかのタイル

`rows` と `fields` で描くタイル（`kpi`、`bar`、`line`、`area`、`barlist`、`pivot`）は、そのままデータセットの結果も描ける（`bar` の横軸は最初の軸の列）。`explore`（Perspective）にデータセットの明細を入れるのも同じ仕組みでできる。ただし最初に作るのは表で、ほかのタイルは表のあと（[13 章](#13-進め方)）。

`select` と `date-range` は指標ファイルのためのタイルなので、データセットには使わない。データセットを絞るのはパラメーターの欄。

### 6.4 ほかのタイルとの絞り込み（クロスフィルタ）

最初の版では、データセットのタイルはクロスフィルタに入らない（ほかのタイルのクリックで絞られず、表のクリックもほかを絞らない）。データセットの列と指標ファイルの軸は名前も意味も別なので、勝手に結ぶと間違える。代わりに次の 2 つを用意する。

- **行のクリックでパラメーターを入れる**（SSRS のドリルスルーの代わり）: `"options": { "click": { "params": { "customer": "顧客ID" } } }` で、行をクリックすると、その行の `顧客ID` の列の値がダッシュボードのパラメーター `customer` に入る。`customer` を使う別の表（その顧客の明細）が読み直される。もう一度クリックで外す。
- 後で: 列と軸を明示して結ぶ（`"options": { "columns": [{ "field": "地域", "dimension": "region" }] }`）。クリックで指標ファイルのタイルを絞り、ほかのタイルの選択をこの表の絞り込みに入れる。

## 7. 表（spreadsheet-grid）

### 7.1 表の `options`

データセットの表で使える `options`（指標ファイルの表では今と同じ）。

```json
"options": {
  "columns": [
    "受注日",
    { "field": "顧客", "width": 200, "pin": "left" },
    { "field": "金額", "label": "金額（円）", "format": "¥#,##0", "agg": "sum", "style": "bar" },
    { "field": "受注番号", "hidden": true }
  ],
  "groupBy": ["地域"],
  "totals": true,
  "click": { "params": { "customer": "顧客ID" } },
  "rows": "client"
}
```

| キー | 中身 | spreadsheet-grid の機能 |
| --- | --- | --- |
| `columns` | 出す列と順。文字は列の名前だけ、`{ field, … }` で細かく。書かなければ全部の列を SQL の順に | `columns` |
| `columns[].label` / `format` / `width` / `align` / `hidden` | 見出し、[書式](../reference.md#書式)、幅、寄せ、隠す | `title`、`valueFormatter`、`width`、`align` |
| `columns[].pin` | `left` / `right` に固定 | 3 つのペインの固定列 |
| `columns[].filter` | 列の絞り込みの種類。`auto`（既定。型から）/ `text` / `number` / `date` / `set` / `none` | `filterType` |
| `columns[].agg` | グループと合計の行の集計（`sum` / `avg` / `min` / `max` / `count`） | `aggFunc` |
| `columns[].style` | `bar`（データバー）/ `scale`（色の濃さ）/ `{ "chips": { "遅れ": "critical", … } }` | `conditionalFormat` |
| `groupBy` | 行グループにする列（順に階層）。小計は `agg` の列。ブラウザで持つ表だけ | `rowGroup` |
| `totals` | 表の下に合計の行 | `totalRow` |
| `search` | 上の検索欄（全部の列から探して絞る）。既定はブラウザで持つ表で `true` | グローバルフィルター、`find`（Ctrl+F） |
| `click` | 行のクリックで入れるパラメーター（[6.4](#64-ほかのタイルとの絞り込みクロスフィルタ)） | `onCellClick` |
| `rows` | `client`（既定。結果を全部ブラウザへ）/ `server`（サーバーで絞ってページごと） | `rows` / `dataSource`（SSRM） |

いまの表タイルと同じく、読み取り専用、Ctrl+C（Mac は ⌘+C）で表示どおりの文字をコピー、ライト・ダーク、列の見出しの ⋮ で並べ替えと列幅。

spreadsheet-grid は `/lite` で使う機能だけを選んで組み込んでいる。データセットの表は機能が多い（絞り込み、グループ、合計、条件付き書式、検索、SSRM）ので、今の表タイルとは別のファイル（別の JS のまとまり）にして、データセットの表のあるページだけで読む。今の表タイルの大きさは変えない。

### 7.2 ブラウザで持つ（`rows: "client"`）

- パラメーターが決まるたびに `POST api/query` を 1 回。結果（Arrow）をそのまま表に渡す。並べ替え・列の絞り込み・グループ・合計・検索はブラウザの中なので、DB へは行かず、すぐ変わる。
- 上限はいまと同じ 1,000,000 行（`--max-rows`）。目安として 10 万行くらいまではこちら。
- このタイルの行は DuckDB-wasm を通らない。データセットのタイルだけのダッシュボードは、DuckDB-wasm（数 MB）を読まずに開ける。

### 7.3 サーバーで絞ってページ送り（`rows: "server"`）

spreadsheet-grid の SSRM（`dataSource.getRows({ startIndex, endIndex, query })`）をそのまま使う。

- 表が見えている範囲のブロック（100 行ずつ）だけを `POST api/rows` で読む。列の絞り込み・並べ替え・検索の欄は、grid がサーバーへ送る記述子（`ServerSideQuery`）を DevBI のサーバーが WHERE と ORDER BY にする（[8.5](#85-表の絞り込みから-where-へ)）。
- 件数は、絞り込みが変わったときだけ数える（最初のブロックで `COUNT(*)` も聞き、同じ絞り込みのあいだはブラウザで覚えておく）。
- 列の絞り込みの候補（値の一覧から選ぶ）は `POST api/values`（`DISTINCT`、1,000 件で打ち切り）。
- 合計の行は `POST api/aggregate`（絞り込んだあとの全体の `SUM` など）。
- グループと小計は使えない（spreadsheet-grid のグループはブラウザで持つ表だけ。[15 章](#15-spreadsheet-grid-の穴)）。
- Excel への書き出しは、絞り込みと並べ替えを付けた `POST api/query` で全部の行を読んで書く（上限 1,000,000 行。Excel の行の上限は 1,048,576）。
- スナップショットからは読まない（DB に SQL を投げる形なので）。
- `-- key:` が要る（[4.6](#46----key-の行)）。

どちらを既定にするかは [14 章](#14-決めてほしいこと)の 2。

### 7.4 SSRS の表と比べて

| | SSRS の Tablix | DevBI のデータセットの表 |
| --- | --- | --- |
| 並べ替え | 見出しのボタンで描き直し（サーバー） | 見出しのメニュー。ブラウザで持つ表ならその場で |
| 列ごとの絞り込み | なし（パラメーターで作る） | 文字・数・日付・値の一覧から選ぶ |
| グループと小計 | レイアウトで作る | `groupBy` と `agg`。見る人が開閉、列メニューからグループを変えられる |
| コピー | なし（Excel に書き出す） | 範囲を選んで Ctrl+C、そのまま Excel に貼れる |
| 大きな結果 | ページに分けて描く | 100 万行まで 1 つの表でスクロール、それより大きければサーバーで絞る表 |
| 条件付きの見た目 | 式で色を書く | データバー、色の濃さ、状態のチップ |
| 埋め込み | Report Viewer（iframe） | 社内アプリの画面に React 部品か script 1 本 |
| 定義 | RDL（XML、Report Builder で作る） | SQL ファイルと JSON（git の差分が読める、AI にも書かせやすい） |

## 8. サーバーの API

API の形は C#（ASP.NET）の見本と、Next.js の `createApiHandler` も同じに保つ（[reference.md の API の形](../reference.md#api-の形)）。

### 8.1 `GET api/schema`

各データセットに `parameters` と `key` を足す。今の `params`（名前の配列）は残す（今のブラウザと C# の見本を壊さないため）。

```json
{ "name": "order_lines", "description": "受注の明細…", "params": ["from", "to", "regions"],
  "parameters": [
    { "name": "from", "type": "date", "label": "受注日（から）", "default": "month_start" },
    { "name": "regions", "type": "text", "multiple": true, "label": "地域", "values": "regions", "default": "all" }
  ],
  "key": ["受注番号", "行番号"], "connection": "DEVBI_DB" }
```

### 8.2 `POST api/query`

- `params` の値に配列（複数の値のパラメーター）が書けるようになる。型の検査をする。
- サーバーで絞る表の書き出しのために、`filters`・`sort`・`globalText`（grid の `ServerSideQuery` と同じ形）を足せる。

### 8.3 足す口

| 口 | 送るもの | 返すもの |
| --- | --- | --- |
| `POST api/rows` | `{ name, params, start, end, filters?, sort?, globalText?, count? }` | Arrow（その範囲の行）。`count: true` なら `X-DevBI-Total-Rows` に絞り込んだあとの件数 |
| `POST api/values` | `{ name, params, column, filters?, globalText?, search?, limit? }` | `{ "values": […], "truncated": false }` |
| `POST api/aggregate` | `{ name, params, filters?, globalText?, aggs: { "金額": "sum" } }` | `{ "金額": 1234567 }` |
| `POST api/describe`（開発のときだけ） | `{ name }` | `{ "columns": [{ "name": "受注日", "type": "DATE" }, …], "params": { "from": "date" } }` |

- どれも `api/query` と同じく `Content-Type: application/json` だけを受け付け、同じ時間の上限・行の上限で、同じ入口（行レベル制御の `run(name, params, { user })`）を通る。
- `describe` は `@devbi/vite`（開発サーバー）と CLI だけで有効にし、`devbi-serve` と本番の C# では出さない（本番では使い道がないので、口を増やさない）。

### 8.4 包み方

`api/rows`・`api/values`・`api/aggregate` と、絞り込みのある `api/query` は、データセットの SQL を包んで実行する。

```sql
WITH <データセットの先頭の WITH の中身>,
     __devbi_d AS (<データセットの最後の SELECT（最後の ORDER BY を外したもの）>)
SELECT * FROM __devbi_d
 WHERE <表の絞り込み>
 ORDER BY <並べ替え>, <-- key: の列>
 <ページ>
```

- データセットの先頭の `WITH` は外へ出す。SQL Server は派生表と CTE の中に `WITH` を書けないため。ほかの DB でも同じ形にそろえる（DB ごとに形を変えると、テストの組み合わせが増えるので）。
- 最後の（いちばん外の）`ORDER BY` は外し、表で並べ替えていないときの並びに使う。SQL Server は `TOP` か `OFFSET` のない `ORDER BY` を派生表と CTE の中に書けないため。
- SQL Server の最後の `OPTION (…)` は外の SQL の最後へ移す。`FOR XML` / `FOR JSON` のデータセットは包めないので、サーバーで絞る表ではエラー。
- 先頭の `WITH`、最後の `ORDER BY`、`OPTION` の場所は、今の `sqltext.ts`（引用符とコメントを読み分ける部分）で、括弧の外のものを探す。DevBI が SQL の文法を全部読むのではなく、この 3 つの場所だけを探す。
- ページ: PostgreSQL・MySQL・SQLite は `LIMIT ? OFFSET ?`、SQL Server（2012 以上）と Oracle（12c 以上）は `OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`。Oracle 11g（Thick モード）ではサーバーで絞る表は使えない（ブラウザで持つ表は使える）。
- 空の値は、並べ替えの向きによらず最後（spreadsheet-grid と同じ）。PostgreSQL と Oracle は `NULLS LAST`、ほかは `CASE WHEN x IS NULL THEN 1 ELSE 0 END` を先に置く。
- 読み取り専用の確かめ（SELECT か WITH で始まる 1 文だけ）は、いまと同じくデータセットのファイルに対して行う。包む部分は DevBI が作る文なので、ブラウザから来たものは列の名前と値だけ。

### 8.5 表の絞り込みから WHERE へ

grid が送る `ColumnFilterValue`（`kind` で分かれる）を、DB ごとの WHERE にする。

| `kind` | WHERE |
| --- | --- |
| `set`（`include` / `exclude`） | `x IN (?, …)` / `x NOT IN (?, …)`。空白（`''`）は `x IS NULL OR x = ''` に読みかえる |
| `number`（比較 / 範囲 / 空 / 空でない） | `x >= ?`、`x BETWEEN ? AND ?`、`x IS NULL` … |
| `text`（部分一致） | `LOWER(x) LIKE LOWER(?) ESCAPE '\'`（`%` と `_` はエスケープ） |
| `textSet` / `numberSet` / `dateSet` | 条件 AND 選んだ値 |
| `dateSet` の相対の期間（今日・今月・過去 30 日） | サーバーの日付で範囲にする（スナップショットの時刻と同じく、サーバーの時計） |
| 検索の欄（`globalText`） | 文字の列ごとの部分一致を OR で（数と日付の列は探さない。DB ごとに文字にした形が画面の書式と違うため） |
| 並べ替え（`sort`） | `ORDER BY "列" ASC / DESC` |

- 列の名前は、そのデータセットの結果の列と照らしてから、DB の書き方で引用符に囲む（引用符の文字は二重にする）。結果の列は `describe` で聞き、SQL の文の中身ごとにサーバーが覚えておく。知らない列の名前は 400。
- 値はすべてパラメーターで渡す。
- `custom`（自前の絞り込み）は使わない（データセットの表の列には設定しない）。

### 8.6 ASP.NET・Next.js

- C# の見本（`dotnet/`）にも同じ口と包み方を足す。テストは Node の側と同じ答えになるかを比べる（スナップショットのファイル名のときと同じやり方）。
- Next.js は `createApiHandler` の `fetch` がそのまま新しい口に答える。

## 9. 守りと行レベル制御

- ブラウザから SQL は来ない、という今の約束は変えない。来るのはデータセットの名前、パラメーターの値、表の絞り込み・並べ替えの記述子（列の名前と値）だけ。列の名前は結果の列と照らし、値はパラメーターで渡す。
- パラメーターは見る人が変えられる値。権限には使わない。見せてよい行は、行レベル制御の設計どおりデータセットの SQL に `WHERE c.region = :user.region` と書く（値はサーバーがログインした人から入れる）。
  - ブラウザから来るパラメーターの名前が `user` か `user.` で始まるもの（大文字と小文字を問わず）は 400。
  - `-- param:` と dash.json の `params` にも、その名前は書けない。
- `api/query`・`rows`・`values`・`aggregate` は、どれも行レベル制御と同じ入口（ログインの確かめ 401、`-- roles:` の 403、`:user.*` の値）を通る。件数・候補・合計も、`:user.*` で絞ったあとの SQL を包んで出すので、見えない行は数にも候補にも出ない。`-- roles:` に入らない人には `api/schema` にもデータセットが出ない（行レベル制御の設計）。
- 人ごとに中身が変わる答えは `Cache-Control: no-store`。
- サーバーで絞る表は、スクロールと絞り込みのたびに小さな SQL を投げる。1 つずつは時間の上限（`--timeout`）で止まる。1 人が同時に投げる数は、ブラウザ側で前の要求を止めてから次を投げる（grid が `signal` で止める）ことで抑える。DB への同時の接続の数の上限は、行レベル制御と合わせて実装の PR で決める。
- パラメーターの値は URL に出る。人に見せたくない値（社員番号など）を、パラメーターで渡す形にしない（`:user.*` で）。

## 10. スナップショットとキャッシュ

- ブラウザ: 結果は（データセット、パラメーターの値）ごとに覚える（サーバーで絞る表は、さらに絞り込み・並べ替え・範囲ごと）。前の値に戻したときは読み直さない。「更新」で捨てて読み直す。
- スナップショット（`-- snapshot:`）は、**既定のパラメーターの組だけ**を作る。データセットのタイルで、パラメーターが既定のままならファイルを読み、変えたら API で読む（ファイルがない・違うときに API で読むのは今と同じ）。
  - 既定値が「今日」などのときは、作る時点のサーバーの日付で決める。ブラウザの日付と違う（日付が変わる前後）ときは、ファイル名が違うので API で読む。
  - 作るものの一覧は、今の「models/ の `read_api`」に「dashboards/ のデータセットのタイル（既定のパラメーター）」を足す。
  - `:user.*` を使うデータセットと `-- roles:` のデータセットは、`-- access: all` のほかはスナップショットにできない（行レベル制御の設計）。
- サーバーで絞る表は、スナップショットを使わない。

## 11. エディタ・devbi-check・pnpm gen・書き出し

- **GUI エディタ**: 設定欄の「データ」で「指標ファイル」と「データセット」を選べる。データセットを選ぶと、`describe` で列の一覧が出て、出す列・順・表示名・書式・グループ・合計を選べる。パラメーターの欄は既定値で動く。SQL ファイルそのものはエディタでは書かない（VS Code や Claude Code で書く。エディタは dash.json だけを書く今の約束のまま）。
- **コードにする**: データセットの表も TSX にできる（`export const query = { dataset: "order_lines" }` と組み込みの表）。
- **devbi-check**: データセットの名前、パラメーターのつなぎ方、`-- param:` の書き方、`IN (:複数)` 以外での複数の値、連動の輪、`-- key:` を確かめる。DB につながるときは `describe` で列の名前（`options.columns`、`-- key:`、`click`）も確かめる。つながらないときは書き方だけ。
- **pnpm gen**: データセットの名前とパラメーターの名前を補完に出す（dash.json の JSON Schema）。DB につながるときは、列から行の型を作る（`RowOf<typeof query>` が使える）。
- **Excel と PDF**: Excel は、ブラウザで持つ表なら grid の今の表示（絞り込み・並べ替え・グループのあと。`getExportData`）を、サーバーで絞る表なら絞り込みを付けて全部の行を読んで書く。シートの注記にパラメーターの値を書く。印刷は今の表と同じく、見えている行を表にする（サーバーで絞る表は読み込んだ分だけで、そう注記する）。

## 12. 作らないもの

- 帳票（印刷のページのレイアウト、ページの切れ目、ヘッダーとフッター）と、メールの配信（購読）。handoff の範囲外のまま。
- RDL（SSRS のファイル）を読んで描くこと。代わりに、後で「`.rsd` / `.rdl` から SQL とパラメーターを取り出して `api/*.sql` を作る」移行の道具は考えられる（候補だけ）。
- セルの式の言語（`=Fields!金額.Value * 1.1`）。計算した列は SQL で書く。足りなければ自作タイル。
- 表からの書き込み（spreadsheet-grid には書き戻しの仕組みがあるが、DevBI は読み取り専用の約束）。
- サブレポート（表の中に別の表）。行のクリックでパラメーターを入れる（[6.4](#64-ほかのタイルとの絞り込みクロスフィルタ)）と、後で展開行（spreadsheet-grid の Master/Detail）で足りるかを見る。

## 13. 進め方

それぞれ 1 つの PR。各 PR で reference.md と manual-check.md を直し、サンプル（examples/sales）に SSRS 風のダッシュボードを 1 つ足す。

1. **データセットのパラメーター（サーバー）**: `-- param:` と `-- key:` の読み込み、型の検査と渡し方、複数の値の展開、`api/schema` の `parameters`・`key`、`user.*` を弾く、C# の見本も同じに。5 つの DB でテスト。行レベル制御の PR と同じ `run` を触るので、先に入ったほうに合わせる。
2. **パラメーターの欄とデータセットの表（ブラウザで持つ）**: dash.json の `params`、欄（見出しの下）、`query.dataset`、`query.params`、URL・埋め込み・React からの値、「更新」、表の `options`（`columns`・`groupBy`・`totals`・`search`・列の絞り込み・`style`）、候補の一覧と連動（`values`）、行のクリックでパラメーター（`click`）、Excel・印刷、スナップショットの既定の組、`devbi-check`。大きければ「欄と `query.dataset`」と「表の `options` と候補」の 2 つに分ける。
3. **サーバーで絞る表（SSRM）**: `api/rows`・`api/values`・`api/aggregate`、包み方、絞り込みから WHERE、5 つの DB のページの書き方、C# の見本。
4. **列を聞く（describe）とエディタ**: 5 つの DB の `describe`、GUI エディタのデータセットの選択と列の一覧、`devbi-check` の列の確かめ、`pnpm gen` の行の型。
5. 後で（決まってから）: 表のほかのタイル（`bar` など）と `explore` にデータセット、列と軸を結ぶクロスフィルタ、metrics.yaml の `read_api` からパラメーターを使う（`read_api('orders', from = $from)`。ページを開いている間にデータが変わらないという今の前提を変えるので、別に設計する）、展開行、表のことばで絞り込み（spreadsheet-grid の `/ai`）、`.rsd` / `.rdl` からの移行。

## 14. 決めてほしいこと

それぞれ、おすすめで進めてよいかを確かめたい。

1. **パラメーターの書き場所**: SQL ファイルの先頭のコメント（`-- param:`）。**おすすめ**。1 つのファイルで済み、今の `-- connection:` / `-- snapshot:` と同じ書き方。別ファイル（`api/<名前>.yaml`）なら JSON Schema の補完が効くが、SQL とずれやすい。
2. **表の既定の読み方**: ブラウザで持つ（`rows: "client"`）を既定にし、大きな表だけ `rows: "server"` を書く。**おすすめ**。絞り込みとグループがその場で効き、作りも簡単。サーバーで絞る表は、グループと小計が使えない。
3. **読み直すとき**: 値が決まったらすぐ読み直す。**おすすめ**。重い SQL のダッシュボードだけ `"apply": "button"` で SSRS と同じ「表示」ボタンにする。逆（ボタンを既定）にもできる。
4. **最初に作る範囲**: [13 章](#13-進め方)の 1 と 2（ブラウザで持つ表まで）。**おすすめ**。サーバーで絞る表（3）は、実際の表の大きさを見てから。

## 15. spreadsheet-grid の穴

この設計で見つかった、spreadsheet-grid（1.3.0）にないもの。DevBI の側で困る順。

- **SSRM で行グループと小計**: グループはブラウザで持つ表だけ。サーバーで絞る表で SSRS の行グループの形を出せない。AG Grid Enterprise の SSRM はグループの行をサーバーに聞く形（グループの値の一覧 → 開いたグループの中の行）を持っている。DevBI のサーバーは `GROUP BY` で答えられる。
- **多段の列見出し**: SSRS の列グループ（月ごとに「数量・金額」を並べる）の見出し。ライブラリの「大きな未実装」に既にある。
- **SSRM の件数を毎回返さなくてよい形**: `getRows` の答えに毎回 `totalRowCount` が要る。DevBI はブラウザで覚えて返すので困らないが、「件数は最初のブロックだけ」「件数が分からないまま（もっと読む）」が選べると、大きな表で `COUNT(*)` を省ける。

これらは DevBI の側の工夫で避けられるので、急がない。
