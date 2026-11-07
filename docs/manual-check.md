# 動作チェックの手順

手元の Mac（または Windows / Linux）で DevBI のランタイムを動かして、画面を触って確かめるための手順です。所要時間は 15〜20 分ほど。

## 1. 準備（最初の一回だけ）

- Node.js 22.12 以上（`node -v` で確認。Vite 8 の条件です）
- pnpm 10.28（`pnpm -v` で確認）。入っていなければ、Node 24 までは `corepack enable` で入ります。Node 25 以降は corepack が付いてこないので `npm i -g pnpm@10.28.0` で入れます

```sh
git clone https://github.com/ishibashi0112/devbi.git
cd devbi
git checkout main                            # PR を試すときは、その PR のブランチ
pnpm install
```

## 2. 起動

```sh
pnpm example:dev
```

パッケージをビルドしてから、サンプル（`examples/sales`）の開発サーバーが立ち上がります。ブラウザで <http://localhost:5173> を開きます。止めるときは Ctrl+C。

## このサンプルの中身：ライブラリと自作の分かれ目

画面のほとんどは DevBI（`@devbi/react`）が出しています。サンプルのアプリが書いているのは、設定のファイル 2 つと、自作のタイル 1 つだけです。

| 画面の部分 | 出しているもの | ファイル |
| --- | --- | --- |
| ページの枠（タイトル、絞り込みのチップ、「すべて解除」、12 列のグリッド、ダークモード、スマホで 1 列） | DevBI | — |
| 期間、KPI ×4、月別売上、地域別売上、売上と前年同月、商品分類別の推移、地域 × 四半期、商品分類、商品別、説明の文 | DevBI の組み込みタイル。何をどこに出すかだけを JSON で書く | `dashboards/sales.dash.json` |
| 売上・件数・前年比などの計算の定義 | 利用者が YAML で書く。SQL への変換と集計は DevBI | `models/sales.metrics.yaml` |
| 「上位顧客（自作タイル）」 | **自作**。React で 60 行ほど。データの取得と絞り込みは DevBI が渡す | `dashboards/sales/TopCustomers.tsx` |
| アプリの入口 | `<DevbiApp>` を置くだけ（10 行） | `src/main.tsx`、`src/app.css` |

組み込みタイルの中では、棒・折れ線・面グラフの描画に [Observable Plot](https://observablehq.com/plot/)（オープンソースのグラフライブラリ）を使っています。データの形を整える、軸を「万・億」で表示する、クリックで絞り込む、といった部分は DevBI が書いています。表のタイルは [spreadsheet-grid](https://github.com/ishibashi0112/datasheet-grid)（`@ishibashi0112/spreadsheet-grid`）を読み取り専用で使っています。KPI、ランキング、ピボット、期間、選択、文章のタイルは、DevBI が React と CSS だけで書いたものです。集計は DuckDB-wasm がブラウザの中で行います。

どのタイルも、同じ `TileProps`（集計済みの行、書式、絞り込みの関数）を受け取る自作タイルに差し替えられます。好きなグラフライブラリで描いてかまいません。

## 3. 画面で確かめること

数字はサンプルデータ（`examples/sales/data/sales.xlsx`、2024年4月〜2026年10月の架空の受注 6,044 行）のものです。

### 開いたとき

| # | やること | こうなれば OK |
| --- | --- | --- |
| 1 | ページを開く | 「売上ダッシュボード」に 13 個のタイルが並び、赤いエラーが出ていない。期間は「2026年度」が選ばれている |
| 2 | 左上の KPI「売上」を見る | 金額の下に「前年」「前年比」が出ている（2026/4/1 からデータの最終日 2026/10/30 までと、1 年前の同じ日付 2025/4/1〜10/30 の比較） |

### 期間

| # | やること | こうなれば OK |
| --- | --- | --- |
| 3 | 期間の「全期間」を押す | すべてのタイルが全期間の数字になる。前年・前年比は「—」になる（比べる期間が決まらないため。仕様どおり） |
| 4 | 「2025年度」を押す | 2025年4月〜2026年3月の数字になる |
| 5 | 日付の欄に開始日と終了日を入れる | その期間で絞られる。終了日の日も含む |

### クリックで絞り込む（クロスフィルタ）

| # | やること | こうなれば OK |
| --- | --- | --- |
| 6 | 「地域別売上」の「関東」を押す | 上に「地域: 関東」のチップが出て、ほかのタイル（KPI・グラフ・表）が関東だけの数字になる。「地域別売上」自身は全地域のまま、関東以外が薄くなる |
| 7 | 「月別売上」の棒を一本押す | その月で絞られる（上のチップにその月の期間が出る）。もう一度押すと外れる |
| 8 | 「商品分類」のチェックを二つ付ける | 二つの分類で絞られる |
| 9 | 「上位顧客」の行を押す | その顧客で絞られる。このタイルは `dashboards/sales/TopCustomers.tsx` に JSX で書いたもの |
| 10 | 「地域 × 四半期」の列の見出し（四半期）を押す | その四半期で絞られる |
| 11 | 「商品別」の表で、列の見出しにマウスを乗せて ⋮ →「昇順で並び替え」。行を押す。セルをドラッグして選び、⌘+C（Windows は Ctrl+C）で Excel に貼る | その列で並べ替わる。行を押すとその商品で絞られ、表のほかの行は薄くなる（もう一度押すと外れる）。Excel には、画面に出ている文字のまま表の形で貼れる |
| 12 | チップの ×、「すべて解除」、タイル右上の「解除」 | 絞り込みが外れて元に戻る |

### 見た目

| # | やること | こうなれば OK |
| --- | --- | --- |
| 13 | ブラウザの幅を狭くする（720px 以下） | タイルが 1 列に並ぶ。横スクロールが出ない |
| 14 | Mac をダークモードにする | 暗い配色になる |
| 15 | スマホで見る（`pnpm --filter devbi-example-sales dev --host` で起動し、同じ Wi-Fi のスマホから表示された Network の URL を開く） | 1 列で表示され、タップで絞り込める |

### ファイルを直すと

保存するとすぐ画面に反映されます（`examples/sales/` の中のファイル）。試したあとは `git checkout .` で元に戻せます。

| # | やること | こうなれば OK |
| --- | --- | --- |
| 16 | `dashboards/sales.dash.json` の `"title": "月別売上"` を別の言葉にして保存 | タイトルが変わる |
| 17 | 同じファイルで `"monthly"` タイルの `"w": 8` を `10` にして保存 | 画面に「タイル region が monthly と重なっています」と日本語で出る。戻すと直る |
| 18 | `models/sales.metrics.yaml` の `of: revenue` を `of: revenu` にして保存 | 画面に「指標 revenu がありません」とファイル名つきで出る。戻すと直る |
| 19 | `dashboards/sales/TopCustomers.tsx` の `limit: 10` を `5` にして保存 | 上位顧客が 5 社になる |
| 20 | `data/sales.xlsx` を Excel で開き、数字を変えて保存 | ページが読み込み直され、新しい数字になる |

### 配布用のビルド

| # | やること | こうなれば OK |
| --- | --- | --- |
| 21 | `pnpm example:preview` を実行して <http://localhost:4173> を開く | 開発サーバーと同じものが動く。`examples/sales/dist/` をそのまま社内のファイルサーバーや IIS に置けば、この形で見られる |

### エディタでの補完（VS Code）

`examples/sales` を VS Code で開きます（リポジトリのルートを開いてもよい）。補完に使う `examples/sales/.devbi/` は `pnpm example:dev` を動かすと作られます（開発サーバーなしなら `pnpm gen`）。

表の Ctrl+Space は、VS Code で候補を出すキーです（Windows / Linux）。**Mac では option + esc** を押してください。Mac の control + スペースは、たいてい日本語と英字の切り替えに使われていて、VS Code まで届きません。コマンドパレット（command + shift + P）の「候補をトリガー」（Trigger Suggest）でも同じです。JSON で `"` の中に文字を打つと、キーを押さなくても候補が出ることがあります。

| # | やること | こうなれば OK |
| --- | --- | --- |
| 22 | `dashboards/sales.dash.json` で、どれかのタイルの `"type": "bar"` の `bar` を消して Ctrl+Space | `kpi`、`bar`、`pivot` などの候補が説明つきで出る |
| 23 | 同じファイルの `"measures": ["revenue"]` の中で Ctrl+Space。次に `"revenue"` を `"revenu"` にする | 候補に `revenue`、`orders`、`revenue_yoy` などが出る。`"revenu"` には波線が出る |
| 24 | `"pivot"` タイルの `options` の中で Ctrl+Space | `totals` が候補に出る（`columns` はもう書いてあるので出ない）。`"totals": "no"` にすると波線 |
| 25 | `models/sales.metrics.yaml` の項目にマウスを乗せる。`compare:` の値を消して Ctrl+Space | 項目の説明が出る。`previous_year`、`previous_period` が候補に出る（拡張機能「YAML」を入れたとき。入っていなければ、開くと右下におすすめが出る） |
| 26 | `dashboards/sales/TopCustomers.tsx` の `defineQuery` の `"revenue"` を `"revenu"` にする | 赤い波線と「`"revenue"` ではありませんか」の旨のメッセージが出る。`r.` と打つと `revenue`、`orders`、`customer` などが候補に出る |
| 27 | 開発サーバーを動かしたまま、`sales.metrics.yaml` の `measures:` に `max_price: MAX(単価)` を足して保存 | 23 と 26 の候補に `max_price` が加わる（エディタによっては数秒かかる） |

試したあとは `git checkout .` で元に戻せます。

## 4. 自分の Excel で試す

会社の Excel でも試せます。**ファイルは PC の外に出ません**（ブラウザはこの PC の開発サーバーから読むだけで、作ったファイルは git にも入りません）。

```sh
pnpm try-xlsx ~/Desktop/売上一覧.xlsx --sheet 明細
```

- Excel を `examples/sales/data/local/` にコピーし、列の型を見て `models/local_〜.metrics.yaml` と `dashboards/local_〜.dash.json` の下書きを作ります。
- 文字の列は軸、数値の列は合計（単価や率は平均）、日付の列は期間になります。金額・売上らしい列が主役になります。
- 最後に表示される URL（`http://localhost:5173/#/local_売上一覧` など）を開きます。開発サーバーは別のターミナルで `pnpm example:dev`。
- 下書きの yaml / json は自由に直してください。保存するとすぐ反映されます。エディタでの補完（上の 22〜25）も効きます。

ターミナルに出る「シート・行数・列名と型・入っている行数・種類の数」には**値が入っていない**ので、そのまま共有できます。これを貼ってもらえれば、候補 A のサンプルデータを同じ形で作れます。

うまく読めないとき:

- 表の上に表題や空行がある → `model` の `read_xlsx(...)` に `range = 'A3:K5000'` のように表の範囲を足す
- 見出しが 2 段になっている、セルが結合されている → いまは 1 段の見出しだけ読めます。1 段にしたコピーで試してください
- `.xls` / `.xlsm` → Excel で `.xlsx` に保存し直す

## 5. 自動テスト

```sh
pnpm test        # 指標 → SQL、xlsx、書式（DuckDB Node で実際に SQL を流す）
pnpm e2e         # サンプルを静的ビルドして、ブラウザ（Playwright）で上の主な操作を確認
```

`pnpm e2e` は初回だけ `pnpm --filter devbi-example-sales exec playwright install chromium` でブラウザを入れます。

## いまの制限（v0）

- グラフの棒や点はマウス・タップでしか選べません（キーボード操作は未対応。リストとチップはキーボードで操作でき、表はセルを矢印キーで動かして Enter かスペースで選べます）
- 初回の読み込みが重めです。重いのは DuckDB-wasm（約 34MB、圧縮して 8.5MB）で、2 回目以降はブラウザのキャッシュから読みます。画面の JavaScript は最初に約 440KB を読み、グラフ（約 280KB）、表（約 225KB と CSS 約 73KB）、DuckDB を動かす部分（約 220KB）は使うときに別のファイルとして読みます
- `dist/` を新しいビルドで置き換えたときは、開いたままのページを読み込み直してください。まだ読んでいなかったグラフなどのファイルが見つからず、タイルに「ページを読み込み直してください」と出ます
- Parquet は DuckDB の拡張をインターネットから取りに行きます。社内で外に出られないときは xlsx / CSV で試してください
