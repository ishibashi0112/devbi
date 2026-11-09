# 作業手順（AI 向け）

このフォルダは [DevBI](https://github.com/ishibashi0112/devbi) のダッシュボードのプロジェクトです。AI（Claude Code、Codex、Cursor など）がここでダッシュボードや指標を作る・直すときは、この手順に従ってください。

## プロジェクトの形

| 場所 | 中身 |
| --- | --- |
| `data/` | データのファイル（xlsx・csv など）。入力なので、頼まれないかぎり変えない |
| `models/<名前>.metrics.yaml` | 指標と軸。SQL はここ（`model` と指標の `sql`）にだけ書く |
| `dashboards/<名前>.dash.json` | タイルの並び。指標と軸を名前で指す（SQL は書かない）。画面の URL は `#/<名前>` |
| `dashboards/<名前>/*.tsx` | 自作タイル。組み込みのタイルで表せないときだけ |
| `api/<名前>.sql` | データベースから読むとき（`read_api('<名前>')`）。接続先は `.env.local` |
| `.devbi/`・`dist/`・`node_modules/` | 作られるもの。手で書かない |

ファイルの書き方の正本は `node_modules/devbi/docs/reference.md` です（入っている DevBI の版のもの）。ここにないキーや値を推測で使わず、そこで確かめてください。キーの一覧は `.devbi/dash.schema.json` と `.devbi/metrics.schema.json` にもあります（`pnpm gen` で作られます）。

## 手順

### 1. 調べる

- 使うデータのファイルごとに `pnpm inspect -- data/<ファイル>` を実行し、列の名前・型・範囲・空の数・多い値を見る。Excel を開かなくても中身が分かります。ほかのシートは `pnpm inspect -- data/<ファイル> --sheet <シート名>`
- 指標ファイルの `model` が返す列は `pnpm inspect -- <指標ファイルの名前>` で見られます
- `models/` と `dashboards/` の今のファイルを読む。新しく作るときも書き方の手本にする
- `pnpm check` を実行して、今の状態を知る（もとからあるエラーと、自分が足したエラーを分けるため）

### 2. 方針を決めて伝える

ファイルを書く前に、次を短く伝えます。

- 指標ファイル: 読むデータ（`model`）、`time` にする日付の列、軸、指標（集計の式と表示名）
- ダッシュボード: 何のためのものか、どのタイルをどこに置くか

データだけでは決められないことは、推測で埋めずに聞きます。たとえば、どの列が売上か、合計か平均か、件数は行の数か伝票の数か、年度の始まりの月、除く値（返品・テストデータなど）、誰が何を見るためのものか。答えがないと作れないときは、ファイルを書かずに質問で終えます。

### 3. 書く

下の「書き方の決まり」に従って書きます。

### 4. 確かめる

1. `pnpm check` を実行し、✗（エラー）がなくなるまで直す。⚠（注意）も読み、意図どおりかを確かめる（0 行の結果、確かめられなかったもの）
2. `.tsx` を書いた・変えたときは `pnpm typecheck` も
3. 終わったら、次を伝える
   - 作った・変えたファイル
   - `pnpm check` の最後の行（「問題はありません」か、残した注意とその理由）
   - 確かめられなかったこと
   - `pnpm dev` で開いて見てほしいところ（`http://localhost:5173/#/<ダッシュボードの名前>`）。人が知っている数字（月の合計など）と比べられるタイルがあれば、それも

`check` が通っても、数字が業務として正しいかまでは分かりません。

## 書き方の決まり

### 指標ファイル（metrics.yaml）

- 1 行目は `# yaml-language-server: $schema=../.devbi/metrics.schema.json`
- データは `read_xlsx('data/x.xlsx', sheet = 'シート名')`、`read_csv('data/x.csv')` のように `read_` の関数で、プロジェクトからの相対パスで読む。`FROM 'data/x.csv'` はブラウザで読めない
- 型は `model` で直す（`CAST(列 AS DATE)`、`strptime(列, '%Y/%m/%d')::DATE`、`TRY_CAST(列 AS DOUBLE)`）。`time` の列は日付か日時にする
- 指標と軸の名前は英小文字と `_`（`revenue`、`order_count`）。表示名は `label` に、書式は `format` に（`"¥#,##0"`、`"#,##0"`、`"0.0%"`）
- 前年比・前年差・累計は SQL で書かず、`{ of: revenue, compare: previous_year, as: ratio }` や `{ of: revenue, running: fiscal_year }` にする（`time` が要る）
- 単価や率は、合計どうしの割り算にする（`avg_price: { sql: revenue / quantity }`）。行ごとの比を `AVG` しない
- 件数は、数えるものに合わせる（明細の行なら `COUNT(*)`、伝票なら `COUNT(DISTINCT 伝票番号)`）

### ダッシュボード（dash.json）

- 最初のキーは `"$schema": "../.devbi/dash.schema.json"`。`"metrics"` に指標ファイルの名前
- グリッドは 12 列。`x + w` は 12 まで、タイルは重ねない
- 並べ方の目安（上から）: 期間 `date-range`（`w` 12・`h` 1）、数字 `kpi`（`w` 3・`h` 2 を 4 つ）、推移とランキング（`bar`・`line` は `w` 8・`h` 4、`barlist` は `w` 4・`h` 4）、表 `table`・`pivot`（`h` 5）
- 種類の選び方: 1 つの数字は `kpi`、時間の推移は `bar`（比べる系列があれば `line`）、内訳の推移は `area`、順位は `barlist`（`limit` 10 ほど）、2 つの項目の掛け合わせは `pivot`、一覧は `table`（`limit` を付ける）、値で絞る入口は `select`
- 比較の指標（`compare`）は、`time` のあるクエリか、`date-range` のあるダッシュボードで使う（全期間のままだと空になる）
- タイルの `id` は英小文字と `-`、`title` は日本語

### 自作タイル（.tsx）

- 組み込みのタイルで表せないときだけ書く
- `export const query = defineQuery({ ... })` でデータを宣言し、`TileProps<RowOf<typeof query>>` を受け取る。`fetch` や SQL で別にデータを読まない
- 値は `format(値, 列の名前)` で表示し、クリックでの絞り込みは `select(...)` で

### しないこと

- `data/` のファイルを変える・消す（頼まれたときを除く）
- `.devbi/`・`dist/` を手で書く
- 接続先やパスワードを、git に入るファイルに書く（`.env.local` に書く）
- 頼まれていない指標・軸・ダッシュボードを消す、名前を変える（ほかのダッシュボードや自作タイルが名前で使っている）
- `pnpm check` を通さずに終える
