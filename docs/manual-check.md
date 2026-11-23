# 動作チェックの手順

手元の Mac（または Windows / Linux）で DevBI のランタイムを動かして、画面を触って確かめるための手順です。所要時間は 45 分ほど。

## 1. 準備（最初の一回だけ）

- Node.js 22.16 以上（`node -v` で確認。Vite 8 は 22.12 以上、サンプルの SQLite を読むには 22.16 以上が要ります）
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
| 「明細を自由に集計」のダッシュボードの「明細」（行・列・集計を見る人が選ぶ表とグラフ） | DevBI の組み込みタイル `explore`。中身は [Perspective](https://perspective.finos.org/)（オープンソース、Apache-2.0）で、DevBI は明細の行を期間と選択で絞って渡す | `dashboards/sales-explore.dash.json` |
| 「Malloy と SQL で集計」のダッシュボードの各タイル（指標と軸の名前では言えない集計） | 利用者が Malloy か SQL で書く。[Malloy](https://www.malloydata.dev/)（オープンソース、MIT）から SQL への変換、明細の行を期間と選択で絞ること、列の名前を指標ファイルの名前・書式にそろえること、描画は DevBI | `dashboards/sales-malloy.dash.json` |
| 「受注明細レポート」（SQL の結果をそのまま表に、見出しの下にパラメーターの欄） | 利用者が SQL（`api/order_lines.sql`）と、その先頭の `-- param:` の行を書く。欄、値を変えたときの読み直し、表、URL への値の読み書きは DevBI。集計はしない（DuckDB-wasm を読まない） | `dashboards/sales-report.dash.json` |
| 「上位顧客（自作タイル）」 | **自作**。React で 60 行ほど。データの取得と絞り込みは DevBI が渡す | `dashboards/sales/TopCustomers.tsx` |
| アプリの入口 | `<DevbiApp>` を置くだけ（10 行） | `src/main.tsx`、`src/app.css` |

組み込みタイルの中では、棒・折れ線・面グラフの描画に [Observable Plot](https://observablehq.com/plot/)（オープンソースのグラフライブラリ）を使っています。データの形を整える、軸を「万・億」で表示する、クリックで絞り込む、といった部分は DevBI が書いています。表のタイルは [spreadsheet-grid](https://github.com/ishibashi0112/datasheet-grid)（`@ishibashi0112/spreadsheet-grid`）を読み取り専用で使っています。探索（`explore`）のタイルは [Perspective](https://perspective.finos.org/) をそのまま使っています。KPI、ランキング、ピボット、期間、選択、文章のタイルは、DevBI が React と CSS だけで書いたものです。集計は DuckDB-wasm がブラウザの中で行います。

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
| 14 | Mac をダークモードにする | 暗い配色になる。「商品別」の表の ⋮ のメニューも、タイルと同じ暗い色で出る |
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
| 21 | `pnpm example:preview` を実行して <http://localhost:4173> を開く | 開発サーバーと同じものが動く。`examples/sales/dist/` をそのまま社内の Web サーバー（IIS など）に置けば、この形で見られる（`index.html` を直接開くのは不可。置き方は [deploying.md](deploying.md)）（ただし「DB から」のダッシュボードは API が要るので、下の 28 の形で動かす） |

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

### データベースから読む（API）

サンプルには、Excel と同じ受注を SQLite（`examples/sales/db/sales.sqlite`）に入れたデータベースがあります。「売上ダッシュボード（DB から）」は、それをサーバーの SQL（`examples/sales/api/orders.sql`）から読みます。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 28 | `pnpm example:serve` を実行して <http://localhost:8080> を開き、「売上ダッシュボード（DB から）」を開く。期間の「全期間」を押す | 売上が ¥193,161,410 で、Excel の「売上ダッシュボード」の全期間と同じ。ターミナルに `api/orders.sql: 6,044 行` のような行が出る |
| 29 | ブラウザの開発者ツールの「ネットワーク」で `query` を見る | 送っているのは `{"name":"orders","params":{"from":"2024-04-01"}}` だけで、SQL はブラウザに出てこない。絞り込みをしても `query` は増えない（ブラウザの中で集計し直している） |
| 30 | <http://localhost:8080/api/schema> を開く | `order_lines`・`orders`・`regions`・`sales_daily` の 4 つの説明とパラメーターが JSON で出る。`orders` は `"params": ["from"]` と `"parameters": [{"name": "from", "type": "date", "label": "受注日（から）"}]`、`order_lines` は `"key": ["受注番号", "行番号"]` も持つ（型の書き方は 150〜154） |
| 31 | `pnpm example:dev` で開き、`examples/sales/api/orders.sql` の最後の行の下に `AND c.region = '関東'` を足して保存 | ページが読み込み直され、DB 版のダッシュボードが関東だけの数字になる。消すと元に戻る |
| 32 | 同じファイルの `SELECT` を `DELETE FROM orders` に変えて保存 | タイルに「API の orders を読めません（400）: api/orders.sql: SELECT か WITH で始まる文だけ使えます（DELETE で始まっています）」と出る。戻すと直る |
| 33 | `pnpm example:dev` を動かしたまま <http://localhost:5173/api/orders.sql> と <http://localhost:5173/db/sales.sqlite> を開く | どちらも 403 で、中身は出ない（SQL とデータベースはサーバーだけが使う） |
| 34 | `pnpm example:serve` を動かしたまま、ターミナルで `curl -i -H "Host: example.com" http://localhost:8080/api/schema` | `403` と「この名前 (example.com) では開けません…」が返る。`Host` を付けなければ 200 |

### ほかのアプリの画面に埋め込む

`examples/sales/public/embed-demo.html` は、DevBI の外の「販売管理システム」のつもりのページです。自分の CSS を持ち、そこに `data-devbi="sales-db"` の div と `devbi-embed.js` の script を 1 本ずつ足しただけです。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 35 | `pnpm example:serve` を実行して <http://localhost:8080/embed-demo.html> を開く | 紺色のヘッダーと左のメニューの中に「売上ダッシュボード（DB から）」が出る。ページの見出し「売上の集計」は赤のまま、ダッシュボードの中の見出しやタイルの見出しは DevBI の見た目のまま（ページの CSS が入り込まない） |
| 36 | OS（またはブラウザ）をダークモードにして開き直す | ダッシュボードは明るいまま（`data-devbi-theme="light"`）。同じ状態で <http://localhost:8080/#/sales-db> を開くと、こちらはダークになる |
| 37 | 「レポート」で「売上ダッシュボード」を選ぶ | 同じ場所が Excel 版のダッシュボードに切り替わり、「上位顧客（自作タイル）」も出る（ページの JavaScript が `mount()` を呼んでいる） |
| 38 | 開発者ツールのコンソールで `DevBI.dashboards` と打つ | `sales`、`sales-daily`、`sales-db`、`sales-explore`、`sales-malloy`、`sales-report` の 6 つが、タイトルつきで出る |
| 39 | 開発者ツールの「ネットワーク」で `devbi-embed.js` を見る | 4KB ほど。残りは `assets/` のファイルを読んでいる（`_` で始まるファイルはない） |
| 40 | ブラウザの窓を 900px くらいまで狭くする | 左のメニューのぶん、ダッシュボードの幅は 720px より狭くなり、タイルが 1 列に並ぶ（窓はスマートフォンより広いまま） |
| 41 | 「地域別売上」の地域を 1 つクリックしてから、コンソールで `DevBI.mount("#report-area", { theme: "dark" })` | ダッシュボードがダークになり、上の絞り込みのチップは残る |
| 42 | コンソールで `DevBI.unmount("#report-area")`、続けて `DevBI.mountAll()` | ダッシュボードが消え、`mountAll()` は `0` を返して空のまま。`DevBI.mount("#report-area")` でまた出る（属性のとおり「売上ダッシュボード（DB から）」で明るい） |

### 毎朝のスナップショット

「売上の日次集計」は、データベースで日・地域・商品分類ごとに集計した SQL（`examples/sales/api/sales_daily.sql`）を、毎朝 6:00 に作ったファイルから読みます。SQL の先頭に `-- snapshot: 06:00` と書いてあるだけで、metrics.yaml は「DB から」と同じ書き方です。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 43 | `pnpm example:serve` を実行する | ターミナルに `スナップショット: sales_daily（06:00）` と `スナップショット sales_daily~9e979dd94c517434.arrows（api/sales_daily.sql）: 4,014 行` が出る。`examples/sales/dist/snapshots/` にそのファイルができる |
| 44 | <http://localhost:8080> の一覧を見る | 「売上の日次集計（毎朝のスナップショット）」の下にだけ「毎日 6:00 の時点のデータ」と出る |
| 45 | それを開き、期間の「全期間」を押す | 売上が ¥193,161,410 で、ほかの 2 つと同じ。見出しの下に「データは 11月8日 8:14 の時点（毎日 6:00 に更新）」のように、ファイルを作った時刻が出る |
| 46 | 開発者ツールの「ネットワーク」で読み込み直す | `query` はなく、`sales_daily~9e979dd94c517434.arrows` を GET で読んでいるだけ（2 回目からは `304`） |
| 47 | <http://localhost:8080/api/schema> を開く | `sales_daily` に `"snapshot": ["06:00"]`、最後の `snapshots` にファイル名と作った時刻（`updatedAt`）が出る |
| 48 | `devbi-serve` を動かしたまま、別のターミナルで `pnpm --filter devbi-example-sales exec devbi-snapshot` | `1 個を …/dist/snapshots に作りました` と出る。ページを読み込み直すと、見出しの時刻がいまの時刻に変わる（IIS などに置くときは、これをタスクスケジューラで毎朝動かす） |
| 49 | `pnpm example:dev` で「売上の日次集計」を開く | 開発サーバーはファイルを作らず、毎回データベースから読む。見出しの時刻は開いた時刻 |

### SQL Server・Oracle・MySQL から読む（Docker があるとき）

サンプルの SQLite と同じ 4 つの表を、Docker で動かしたデータベースに写して、同じ `api/*.sql` で読みます。どのデータベースも、ドライバー（`mssql`、`oracledb`、`mysql2`）はサンプルに入っています。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 50 | `docker run -d --name devbi-mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=DevBI_test1 -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest` を実行し、20 秒ほど待って `pnpm --filter devbi-example-sales copy-db mssql://sa:DevBI_test1@127.0.0.1:1433/master` | `customers 40 行、products 10 行、orders 3029 行、order_lines 6044 行 を mssql://127.0.0.1:1433/master に写しました` と出る（Apple シリコンの Mac は、Docker Desktop の設定で Rosetta を使う） |
| 51 | `DEVBI_DB=mssql://sa:DevBI_test1@127.0.0.1:1433/master pnpm example:serve` で開き、「売上ダッシュボード（DB から）」で「全期間」を押す | 売上が ¥193,161,410。ターミナルに `api/orders.sql: 6,044 行` が出る。「売上の日次集計」も同じ金額 |
| 52 | MySQL: `docker run -d --name devbi-mysql -e MYSQL_ROOT_PASSWORD=devbi -e MYSQL_DATABASE=devbi -p 3306:3306 mysql:8.4`、`copy-db mysql://root:devbi@127.0.0.1:3306/devbi`、`DEVBI_DB=` をその URL にして 51 と同じ | 同じく ¥193,161,410 |
| 53 | Oracle: `docker run -d --name devbi-oracle -e ORACLE_PASSWORD=devbi -e APP_USER=devbi -e APP_USER_PASSWORD=devbi -p 1521:1521 gvenzl/oracle-free:23-slim-faststart`（`docker logs devbi-oracle` に `DATABASE IS READY TO USE!` が出るまで待つ）、`copy-db oracle://devbi:devbi@127.0.0.1:1521/FREEPDB1`、51 と同じ | 同じく ¥193,161,410 |
| 54 | 51 のまま、`examples/sales/api/orders.sql` の `SELECT` を `DELETE FROM orders` に変えて開き直す | 「SELECT か WITH で始まる文だけ使えます」と出て、表は消えない。戻すと直る |

終わったら `docker rm -f devbi-mssql devbi-mysql devbi-oracle` で消せます。

### ASP.NET（C#）の見本（.NET 10 SDK があるとき）

`devbi-serve` の代わりに、ASP.NET Core のサンプル（`dotnet/samples/DevBI.Sample`）で同じダッシュボードを出します。データベースは 50 の SQL Server です（`copy-db` まで済ませておく）。.NET 10 SDK は <https://dotnet.microsoft.com/download> から入れます。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 55 | `pnpm example:build` のあと、`ConnectionStrings__DEVBI_DB="Server=127.0.0.1,1433;Database=master;User Id=sa;Password=DevBI_test1;TrustServerCertificate=true" dotnet run --project dotnet/samples/DevBI.Sample -- --urls http://127.0.0.1:4179`（Windows の PowerShell では `$env:ConnectionStrings__DEVBI_DB="…"` を先に実行） | `Now listening on: http://127.0.0.1:4179` と出る |
| 56 | <http://127.0.0.1:4179/#/sales-db> を開き、「全期間」を押す | 売上が ¥193,161,410。ターミナルに `api/orders.sql: 6,044 行、… ms` が出る |
| 57 | <http://127.0.0.1:4179/api/schema> を開く | `order_lines`・`orders`・`regions`・`sales_daily` が 30 と同じ `parameters` と `key` で並び、最後の `snapshots` は `[]`（C# の見本はスナップショットを作らない）。「売上の日次集計」は API から読むので、見出しの下の「…の時点」は出ない |
| 58 | 55 の `ConnectionStrings__DEVBI_DB` を付けずに起動し、56 を開く | タイルに「接続先がありません。DEVBI_DB の接続を DevBIOptions.Connect で返してください」 |
| 59 | `DEVBI_TEST_MSSQL=mssql://sa:DevBI_test1@127.0.0.1:1433/master dotnet test dotnet/DevBI.sln` | `Passed!` と出て、`Failed:` が 0 |

WebForms（.NET Framework）の `DevBIHttpHandler` は、Windows の IIS でだけ動きます。手元のアプリで試すときは、リファレンスの「[WebForms・MVC 5](reference.md#webformsmvc-5net-framework-472-以降)」のとおり `Global.asax` と `web.config` に足し、`dist/` を `~/Scripts/devbi/` に置いて、ページに `<div data-devbi="sales-db" data-devbi-theme="light"></div>` と `devbi-embed.js` の 2 行を足します。56 と同じ金額が出れば動いています。

### Next.js のアプリに置く

同じダッシュボードを、Next.js 16 のアプリ（`examples/nextjs`）の画面に置きます。API は `app/devbi/[...path]/route.ts` が答えます（`devbi-serve` は使わない）。データベースはサンプルの SQLite です。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 60 | `pnpm example:nextjs` | `examples/sales/dist` を `public/devbi` に写し、`next build` のあと `Ready` と出る。初回は `[devbi] スナップショット sales_daily~9e979dd94c517434.arrows（api/sales_daily.sql）: 4,014 行、… ms` も出る |
| 61 | <http://127.0.0.1:3000/> を開き、ダッシュボードの「全期間」を押す | 紺の帯（社内ポータル）の下に赤い見出し「売上」と、「売上ダッシュボード（DB から）」。売上が ¥193,161,410。ダッシュボードの見出しは赤くならない。ターミナルに `[devbi] api/orders.sql: 6,044 行、… ms` |
| 62 | 上の帯の「日次集計（毎朝）」を押す | ページを読み込み直さずに「売上の日次集計」に変わり、見出しの下に「データは …の時点（毎日 6:00 に更新）」。「全期間」で ¥193,161,410。ブラウザの「戻る」で 61 のダッシュボードに戻る |
| 63 | <http://127.0.0.1:3000/devbi/api/schema> を開く | `order_lines`・`orders`・`regions`・`sales_daily` が並び、`snapshots` に `updatedAt`（60 で作った時刻）がある |
| 64 | 60 を止め、`pnpm --filter devbi-example-nextjs dev` で開発サーバーを動かし、61 を開く | 同じ金額が出る（開発サーバーでも route.ts の API が動く） |
| 65 | （SQL Server があるとき）50 の `copy-db` と `pnpm --filter devbi-example-nextjs build` のあと、`DEVBI_DB=mssql://sa:DevBI_test1@127.0.0.1:1433/master DEVBI_SNAPSHOTS=snapshots-mssql pnpm --filter devbi-example-nextjs start` で起動し、61 を開く | 同じ ¥193,161,410。ターミナルに `[devbi] api/orders.sql: 6,044 行` が出て、「mssql が要ります」は出ない |
| 66 | `pnpm e2e:nextjs` | `4 passed` |

### GUI エディタ（開発サーバー）

`pnpm example:dev` で開きます。保存するとサンプルのファイル（`examples/sales/dashboards/`）が書き換わるので、最後の 77 で元に戻します。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 67 | <http://localhost:5173/#/sales> を開き、見出しの右の「編集」を押す | 上に「売上ダッシュボード dashboards/sales.dash.json」と、「＋ タイルを追加」「元に戻す」「やり直す」「保存」「閉じる」の帯が出る。タイルは数字やグラフを出したまま。マウスを乗せると青い枠と「monthly · 棒グラフ」のような名札、右上に × が出る |
| 68 | 「地域別売上」をつかんで、左の「月別売上」の上へドラッグ | 動かしている間は行き先に青い点線の枠が出て、「月別売上」が押し下げられる。離すとそこに収まり、「未保存の変更があります」と出る |
| 69 | 「元に戻す」を押し、「月別売上」の右端をつかんで左へドラッグ | 68 の前に戻る。「月別売上」の幅が列の単位で狭くなる（グラフも描き直される） |
| 70 | ⌘S（Windows は Ctrl+S）。ターミナルで `git diff examples/sales/dashboards` | 「保存しました（dashboards/sales.dash.json）」と出る。差分は `"id": "monthly"` の下の `"x": 0, "y": 3, "w": …` の 1 行だけ。ページは読み込み直されない |
| 71 | 「＋ タイルを追加」で「数字（KPI）」を選ぶ | いちばん下に「売上」の KPI が金額つきで出て、そこまでスクロールする |
| 72 | 足したタイルの右上の × を押す。続けて ⌘Z | 消えて、⌘Z で戻る。タイルを押して選び Delete を押しても消える |
| 73 | 「閉じる」 | 「保存していない変更があります」と、「保存して閉じる」「保存せずに閉じる」「編集を続ける」が出る。「保存せずに閉じる」で、70 で保存した形のダッシュボードに戻る |
| 74 | もう一度「編集」を押し、VS Code で `sales.dash.json` の `"title"` を変えて保存 | エディタの見出しがその言葉に変わり、「読み込み直しました」と出る |
| 75 | エディタでタイルを 1 つ動かしてから、VS Code で `"title"` をもう一度変えて保存 | 「dashboards/sales.dash.json が、ほかで書き換えられました」と、「ファイルの内容を読み込む（ここでの変更は捨てる）」「ここでの内容で上書きする」が出る。「保存」を押しても「エディタで開いたあとに書き換えられています」で断られる。「ファイルの内容を読み込む」で VS Code で直した内容になる |
| 76 | 「閉じる」→「＋ 新しいダッシュボード」。ファイル名に `月次` と入れる。次に `monthly`、見出しに「月次の売上」と入れて「作って編集する」。「＋ タイルを追加」で「棒グラフ」を選んで保存し、「閉じる」 | `月次` では「半角の英数字と - _ で書いてください」と出て押せない。作ると空の編集画面（「＋ タイルを追加」から…）になり、棒グラフの月別売上が出る。`examples/sales/dashboards/monthly.dash.json` ができ、閉じると「月次の売上」のダッシュボードが出て、「← 一覧へ」の一覧に 6 つ並ぶ |
| 77 | ターミナルで `git checkout examples/sales/dashboards && rm examples/sales/dashboards/monthly.dash.json` | ページが読み込み直され、一覧が元の 5 つに戻る |
| 78 | `pnpm example:preview` で <http://localhost:4173> を開く | 「編集」も「＋ 新しいダッシュボード」も出ない（ビルドにはエディタが入らない） |

#### 設定欄（プロパティパネル）

続けて `pnpm example:dev` で <http://localhost:5173/#/sales> を開き、「編集」を押します。最後の 87 で元に戻します。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 79 | 何も押さずに右の設定欄を見る | 「ダッシュボード」の見出し・説明・指標ファイルが出る。見出しを「売上（会議用）」に変えると、上の帯の見出しもすぐ変わる |
| 80 | 「月別売上」のタイルを押す | 設定欄が「月別売上」になり、種類「棒グラフ」、指標は「売上」にチェック、期間の単位は「月」 |
| 81 | 種類を「折れ線グラフ」、指標の「受注件数」にもチェック、期間の単位を「四半期」 | 変えるたびにタイルがすぐ変わる（折れ線、受注件数の線が増える、四半期ごと）。ほかのタイルは読み込み直さない |
| 82 | 見出しの欄の最後に「（税込）」と打ち、「元に戻す」を 1 回 | 打っている間タイルの見出しも変わる。「元に戻す」1 回で「月別売上」に戻る（1 文字ずつではない） |
| 83 | 「地域別売上」を押し、「＋ 絞り込みを追加」で「商品分類」→「保守」にチェック | 商品分類の値（保守・工具・部品・消耗品）がデータから出る。チェックすると地域別の金額が保守だけの数字になる |
| 84 | 「＋ 並び順を追加」で「地域」、向きを「大きい順」、件数に 3 | ランキングが 3 件（関東、近畿、北海道・東北）になる。地域の名前の文字の大きい順 |
| 85 | 「地域 × 四半期」を押し、表示の「合計の行と列」を「いいえ」。次に一番上の期間のタイルを押し、「最初の期間」を「前の年度」 | 合計の行と列が消える。期間のタイルが前の年度を選んだ状態になり、ほかのタイルもその期間になる |
| 86 | ⌘S。ターミナルで `git diff examples/sales/dashboards` | 変えたキーだけが差分に出る（`"title"`、`"type"`、`"query"`、`"options"` の行）。足したキーは手で書くときと同じ場所（例: `query` の `"filters"` は `"dimensions"` の後） |
| 87 | ターミナルで `git checkout examples/sales/dashboards` | ページが読み込み直され、元のダッシュボードに戻る |

#### コードにする

続けて `pnpm example:dev` で <http://localhost:5173/#/sales> を開き、「編集」を押します。最後の 92 で元に戻します。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 88 | 「地域 × 四半期」を押し、設定欄のいちばん下の「コードにする…」を押す | 「dashboards/sales/ に .tsx ファイルを書き出し、このタイルはそのファイルで描くようにして、ダッシュボードを保存します」と、「書き出す」「やめる」が出る |
| 89 | 「書き出す」 | ページの上のほう（帯の下）に「dashboards/sales/RegionQuarter.tsx に書き出して、保存しました」と出る。タイルは同じ表のままで、名札が「region-quarter · ./sales/RegionQuarter.tsx」になる。設定欄は見出しと名前だけになる。ページは読み込み直されない |
| 90 | ターミナルで `git diff examples/sales/dashboards` と `cat examples/sales/dashboards/sales/RegionQuarter.tsx` | dash.json は「地域 × 四半期」の `"type"`・`"query"`・`"options"` の行が消え、`"component": "./sales/RegionQuarter.tsx"` が入っただけ。.tsx には `export const query = defineQuery({ measures: ["revenue"], dimensions: ["region"], time: "quarter" })`、`const options = { columns: "受注日" }`、自分で描くときの例（コメント）がある |
| 91 | 「閉じる」。VS Code で RegionQuarter.tsx を開き、例の 7 行（`//   return (` から `//   );` まで）の先頭の `//` を外し、いちばん下の `return <Builtin … />;` の行を消して保存 | ページが読み込み直され、「地域 × 四半期」が「2026年Q2 ¥8,530,630」のような箇条書きになる。ほかのタイルで地域を選ぶと、箇条書きも絞られる |
| 92 | ターミナルで `git checkout examples/sales/dashboards && rm examples/sales/dashboards/sales/RegionQuarter.tsx` | ページが読み込み直され、元の表に戻る |

### 雛形（create-devbi）と npm に出す前の確かめ

npm にある版ではなく、いまのコードを npm に出す形に固めたもの（tarball）で確かめます。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 93 | `pnpm build && node packages/create-devbi/bin/create-devbi.js ~/devbi-try` | 「/Users/〜/devbi-try に DevBI のプロジェクトを作りました（git init 済み）。」と、`cd`・`npm install`・`npm run dev` が出る。`ls -a ~/devbi-try` で `.gitignore`、`README.md`、`dashboards/`、`models/`、`data/sales.xlsx`、`src/`、`vite.config.ts` があり、`package.json` の `devbi` などは `^` + いまの版（`packages/create-devbi/package.json` の版。その版を npm に出す前は、ここで `npm install` はできません。確かめたら `rm -rf ~/devbi-try`） |
| 94 | もう一度 93 と同じコマンド | 「/Users/〜/devbi-try は空ではありません」と出て、何も書かない |
| 95 | `pnpm check:packed`（Mac・Linux。5 分ほど。初回は React や Vite を npm から取ってきます） | npm で入れたものと pnpm で入れたもの、それぞれで型チェック・ビルドが通り、「1 passed」が 2 回出る。最後に、作ったプロジェクトの場所（`…/app-npm`、`…/app-pnpm`）が出る |
| 96 | 95 で出た `app-npm` のフォルダで `npm run dev`、<http://localhost:5173> を開く | 売上ダッシュボードが出る（確かめのため「上位顧客」の自作タイルは外してあり、「地域 × 四半期」は「コードにする」で書き出したあとの形）。「編集」で GUI エディタが開く |

### ファイル出力（Excel・PDF）

`pnpm example:dev`（または `pnpm example:serve`）で開いた売上ダッシュボードで確かめます。見出しの右の「ファイル出力」のメニューから選びます。メニューそのものと CSV は、下の「[ファイル出力の CSV](#ファイル出力の-csv)」（193〜198）で確かめます。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 97 | 「地域別売上」の「関東」を押してから、見出しの右の「ファイル出力」→「Excel（.xlsx）」を押す | `売上ダッシュボード_20261108-1023.xlsx` のような名前でダウンロードされる。Excel で開くと、最初のシート「概要」に、タイトル・書き出した日時・「絞り込み　受注日: 2026/4/1〜2026/10/30、地域: 関東」と、タイルの一覧がある。一覧のタイルの名前を押すと、そのシートに移る |
| 98 | Excel で「月別売上」「上位顧客（自作タイル）」「地域 × 四半期」「商品別」のシートを見る | 2 行目にそのタイルの絞り込み（「地域: 関東」）。表の見出しは下にスクロールしても残り、フィルタのボタンが付いている。売上は「¥2,622,450」、前年比は「129.8%」のように画面と同じ表示で、セルを選ぶと数式バーには数値（2622450、1.2975…）。月は「2026年4月」と出て、セルの中身は日付（2026/4/1）。「地域 × 四半期」は画面と同じ形のクロス集計で、合計の行と列がある |
| 99 | 「ファイル出力」→「印刷・PDF」を押す | ブラウザの印刷の画面が開き、プレビューは横向きでダッシュボードだけ（「ファイル出力」などのボタン、チップの × はない。見出しの右に「2026/11/8 10:23 の表示」）。タイルがページの境目で切れていない。送り先を「PDF に保存」にして保存すると、`売上ダッシュボード_20261108.pdf` ができる |
| 100 | Mac をダークモードにして、もう一度「印刷・PDF」 | 画面は暗いまま、印刷のプレビューは白地の明るい色 |
| 101 | 埋め込みの見本（上の 35）で「印刷・PDF」を押す | 紺色のヘッダーや左のメニューは入らず、ダッシュボードだけが印刷のプレビューに出る |
| 102 | ブラウザの幅を狭くして（タイルが 1 列になるまで）「印刷・PDF」 | 1 列のままで、どのタイルもページの境目で切れない（高いタイルは 1 ページに 1 つ） |

### ファイルを確かめる（devbi-check・devbi-inspect）と AI 向けの手順

ブラウザを開かずに、ターミナルで確かめます。`pnpm build` のあと、`examples/sales` のフォルダで動かします（`cd examples/sales`）。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 103 | `pnpm check` | 指標ファイル 3 つの行数（`models/sales.metrics.yaml: 6,044 行、指標 7・軸 4` など）と、ダッシュボードごとのタイルの行数が出て、最後に「問題はありません」。ダッシュボードの行には「date-range の最初の期間: 受注日 2026年度（2026-04-01〜2026-10-30）」（画面を開いたときと同じ期間で流す）。2 秒ほど |
| 104 | `models/sales.metrics.yaml` の `SUM(数量)` を `SUM(数)` にして、もう一度 `pnpm check` | `✗ models/sales.metrics.yaml: 指標 quantity: Binder Error: Referenced column "数" not found …` と、次の行に `Candidate bindings: "数量", …`。売上ダッシュボードの `kpi-qty`（数量）と `products`（商品別）のタイルは「quantity のエラーのため確かめていません」。最後に「エラー 1 件、注意 0 件」で、`echo $?` は 1 |
| 105 | 104 を戻し、`dashboards/sales.dash.json` の `"measures": ["orders"]` を `["orderz"]` にして `pnpm check` | `✗ dashboards/sales.dash.json: タイル kpi-orders（受注件数）: 指標 orderz は sales にありません（sales の指標: revenue・orders・…）` |
| 106 | `pnpm inspect -- data/sales.xlsx` | `data/sales.xlsx（シート「明細」の A1:I6045）: 6,044 行、9 列` と、列ごとの型・範囲・種類の数。`地域` には「多い値: 関東 (2,322)、近畿 (1,325)、…」。2 行目に「シート: 明細・メモ」。最後に「最初の 10 行」の表（`受注日 \| 受注番号 \| …` の見出しと 10 行） |
| 107 | `pnpm inspect -- sales_daily` | 指標ファイル `sales_daily` の `model` の結果（受注日・地域・商品分類・金額・数量・明細数の 6 列、4,014 行）。サンプルの SQLite から読む |
| 108 | `pnpm inspect -- data/sales.xlsx --range C1:D --rows 2` | `（シート「明細」の C1:D6045）: 6,044 行、2 列` で、列は `顧客` と `地域` だけ。最初の行は 2 行 |
| 109 | `pnpm inspect -- --sql "SELECT 地域, SUM(金額) AS 売上 FROM read_xlsx('data/sales.xlsx', sheet = '明細') GROUP BY 1 ORDER BY 2 DESC"` | `SQL: 6 行、2 列` と、「最初の 6 行」に `関東 \| 72393280`、`近畿 \| 42290840`、…（地域ごとの売上の合計、大きい順）。`FROM 'data/sales.csv'` のように `read_` の関数を使わないと、「データのファイルは read_csv('data/…') のように read_ の関数で読んでください」 |
| 110 | `pnpm check -- --values 2` | タイルごとに、画面と同じ書式の最初の 2 行。`kpi-revenue: 売上 ¥48,052,590、売上 前年 ¥48,138,860、売上 前年比 99.8%` は、`pnpm dev` で売上ダッシュボードを開いたとき（2026年度）の「売上」のタイルと同じ数字 |
| 111 | `examples/sales` を Claude Code（か、AGENTS.md を読むほかの AI）で開き、「data/sales.xlsx から、商品分類ごとの売上と数量を見るダッシュボードを作って」と頼む | AI が `pnpm inspect` でデータを見て、作る指標とタイルを先に示す（売上の列や件数の数え方を聞いてくることもある）。ファイルを書いたあと `pnpm check` を流し、最後に作ったファイル、check の結果、開く URL（`http://localhost:5173/#/…`）と、そこに出るはずの数字を伝える。開くとダッシュボードが出て、その数字と同じ |

試したあとは `git checkout .` で元に戻せます。

### 期間の名前、前の期間との比較、期間で絞らないタイル

`pnpm example:dev` で売上ダッシュボードを開いて確かめます。ファイルを変えたものは、試したあと `git checkout .` で戻せます。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 112 | 期間のボタンの横の「ほかの期間」を開く | 「2026/10/30」「直近7日」「直近30日」「2026/10/26週」「2026年9月」「2026年Q4」「2026年Q3」が並ぶ（データの最終日 2026/10/30 が基準） |
| 113 | 「ほかの期間」で「直近7日」を選ぶ。次に「全期間」を押す | 一覧が青くなり、ボタンはどれも押されていない。上のチップは「受注日: 2026/10/24〜2026/10/30」。「全期間」を押すと、一覧は「ほかの期間」に戻る |
| 114 | `models/sales.metrics.yaml` の `measures` に `revenue_pp: { of: revenue, compare: previous_period, as: value }` を足し、`dashboards/sales.dash.json` の `kpi-revenue` の `measures` の最後に `"revenue_pp"` を足す。期間の「2026年10月」を押し、次に「ほかの期間」で「2026年Q4」を選ぶ | 2026年10月: 売上 ¥5,689,340、「売上 前期間」は 9/1〜9/30 の ¥5,591,360。2026年Q4（10/1〜10/30）: 「売上 前期間」は前の四半期の同じ日 7/1〜7/30 の ¥7,575,910（30 日前の 9 月ではない） |
| 115 | `models/sales.metrics.yaml` の `revenue` に `better: lower` を足す（`{ sql: SUM(金額), label: 売上, format: "¥#,##0", better: lower }`）。「2026年度」を押す | 「売上 前年比 99.8%」（減った）が、赤から緑になる。`better` を消すと赤に戻る |
| 116 | `dashboards/sales.dash.json` の `kpi-orders` の `query` を `{ "measures": ["orders"], "period": false }` にする | 「受注件数」は、どの期間を選んでも全期間の 3,029。「地域別売上」の「関東」を押すと 1,153（期間以外の選択はかかる）。`examples/sales` で `pnpm check -- --values 1` を流しても `kpi-orders: 受注件数 3,029` |
| 117 | 116 を戻し、`pnpm example:dev` の GUI エディタ（上の「GUI エディタ」と同じく開く）で「受注件数」のタイルを選び、設定欄の「期間で絞るか」を「絞らない（いつも全期間）」にして保存 | タイルが 3,029 になり、dash.json のそのタイルの `query` に `"period": false` が入る（ほかの行は変わらない）。「絞る」に戻すとキーが消える |

### 明細を自由に集計（探索タイル・Perspective）

`pnpm example:dev` で <http://localhost:5173/#/sales-explore>（一覧の「明細を自由に集計」）を開きます。期間は「2026年度」から始まります。ファイルを変えたものは、試したあと `git checkout .` で戻せます。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 118 | 開く | 右の「明細」に表が出て、いちばん上の合計の行が 金額 48,052,590・数量 15,335・受注番号 767（異なり数）、その下に商品分類ごと（保守・工具・消耗品・部品）。金額に「.00」は付かない。右に設定の欄（行・列・並べ替え・絞り込み・値・すべての列）が日本語で出る。合計は「地域別売上」の 6 地域の合計と同じ |
| 119 | 「地域別売上」の「関東」を押す。もう一度押す | 明細の合計が 18,599,290・6,167・292 になる（関東だけ）。もう一度押すと 118 に戻る |
| 120 | 設定の欄の「行」の「商品分類」を外し、「すべての列」の「顧客」を「行」へドラッグ。次に期間の「2025年度」を押す | 顧客ごとの行になる。期間を変えても顧客ごとのまま（並べ方は残る。ページを開き直すと商品分類ごとに戻る） |
| 121 | 設定の欄のいちばん上の「表」を押し、「縦棒」を選ぶ | 顧客ごとの縦棒のグラフになる |
| 122 | OS（またはブラウザ）をダークモードにする | Perspective の表と設定の欄も暗い色になる |
| 123 | 期間を「2026年度」に戻し、「ファイル出力」→「Excel（.xlsx）」 | シートは「概要」「地域別売上」「明細」。「明細」は 3 行目に「明細の行です。…」、5 行目から 受注日・受注番号・顧客・地域・商品分類・商品・数量・単価・金額 の 1,532 行（関東を選んでいれば 595 行）。日付は日付、金額は数値で、金額の合計は 118 の合計と同じ |
| 124 | 「ファイル出力」→「印刷・PDF」 | 印刷の画面の「明細」のタイルに、いまの並べ方の表（合計の行と、行ごとの数字）が出る。グラフにしているときも表で、「グラフは印刷では表で出します」と書いてある |
| 125 | `examples/sales` で `pnpm check -- --values 1` | `dashboards/sales-explore.dash.json` の行に `explore 1,532 行:` と、最初の行「受注日 2026-10-30、受注番号 J13027、…、金額 67,300」 |
| 126 | `dashboards/sales-explore.dash.json` の explore の `"query": {}` を `"query": { "limit": 1000 }` にして保存 | タイルの上に「新しいほうから 1,000 行だけを集計しています。期間で絞るか、query の limit を大きくしてください」と出て、合計が小さくなる。`pnpm check` でも「明細が 1,000 行を超えるため…」の注意が出る |
| 127 | 126 を戻し、売上ダッシュボードで「編集」→「商品別」のタイルを押し、種類を「探索（自由に集計）」 | タイルに Perspective の表が出る。データの欄は「指標ファイル」「期間で絞るか」「絞り込み」「件数」だけ（指標・軸・期間の単位・並び順は出ない）。表示に「最初の並べ方」の欄が出る |
| 128 | 「最初の並べ方」に `{ group_by: 地域 }` と入れて欄を出る。次に `{ "group_by": ["地域"], "columns": ["金額"] }` にして欄を出る。保存して `git diff examples/sales/dashboards` | 1 つ目は「JSON として読めません（…）」と出て、タイルもファイルも変わらない。2 つ目でタイルが地域ごとの金額になる。差分は「商品別」の `"type": "explore"` と `"options": { "layout": … }` で、`query` は消える（明細のタイルが使わない指標・軸・件数だったため）。`git checkout examples/sales/dashboards` で戻す |
| 129 | 127 と同じく「商品別」を「探索（自由に集計）」にして、「最初の並べ方」を `{ "plugin": "Bar" }` にして欄を出る。次に `{ "group_by": ["地"] }`、最後に `{ "group_by": ["地域"], "columns": ["金額"] }` にして、そのつど欄を出る | 1 つ目はタイルに「options.layout の plugin "Bar" はありません（Datagrid、X Bar、…のどれかにしてください）」、2 つ目は「options.layout の並べ方を使えません（Unknown column "地" …）」と出る（どちらもタイルが「読み込み中」のまま止まらない）。3 つ目でエラーが消え、地域ごとの金額になる |

### Malloy と SQL で書いたタイル

`pnpm example:dev` で「Malloy と SQL で集計」（`#/sales-malloy`）を開いて確かめます。ファイルを変えたものは、試したあと `git checkout .` で戻せます。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 130 | 開く（期間は 2026年度） | 「地域別売上」（Malloy）は 関東 ¥18,599,290 から 6 地域で、売上ダッシュボードの「地域別売上」と同じ。「商品分類ごとの売上と構成比（SQL）」は 工具 ¥15,440,040・32.1、保守 ¥15,370,350・32、部品 ¥12,781,900・26.6、消耗品 ¥4,460,300・9.3。「受注の回数ごとの顧客数」は横軸が受注の回数（3〜39）の縦棒。「月別売上（大口の受注だけ）」は 2026年4月〜10月の折れ線 |
| 131 | 「地域別売上」の「関東」を押す | 上に「地域: 関東」が出て、ほかの 3 つのタイルが関東だけになる（SQL の表の売上の合計が ¥18,599,290） |
| 132 | 「すべて解除」を押し、「月別売上（大口の受注だけ）」の月の点を押す | 上に「受注日: 2025年6月」のような月のチップが出て、ほかのタイルがその月だけになる |
| 133 | 「受注の回数ごとの顧客数」の棒を押す | 何も絞られない（受注回数は指標ファイルの軸ではないため） |
| 134 | `pnpm check -- --values 1` | `dashboards/sales-malloy.dash.json` の行に `region 6 行: 地域 関東、売上 ¥18,599,290`、`share 4 行: 商品分類 工具、売上 ¥15,440,040、構成比（%） 32.1` など |
| 135 | 売上ダッシュボードで「編集」→「地域別売上」を押し、「書き方」を「Malloy で書く」 | 欄に `run: sales -> { group_by: 顧客 … aggregate: 件数 is count() }` が入り、タイルが顧客ごとの件数になる。指標・軸の欄は消える |
| 136 | Malloy の欄を `run: sales -> {`・`  group_by: 地`・`}` の 3 行にして欄を出る。次に `run: sales -> { group_by: 地域; aggregate: revenue is 金額.sum() }` にして ⌘Enter | 1 つ目はタイルに「Malloy: '地' is not defined（2 行目）」。2 つ目で関東 ¥18,599,290 からの地域別売上に戻る（`revenue` の名前なので ¥ の書式） |
| 137 | 「書き方」を「SQL で書く」、次に「指標と軸を選ぶ」。保存して `git diff examples/sales/dashboards` | SQL では `SELECT 顧客, COUNT(*) AS 件数 …` が入り、タイルが顧客ごとの件数になる。戻すと指標「売上」・軸「顧客」がチェックされた状態になり、差分は `"dimensions": ["customer"]` だけ。`git checkout examples/sales/dashboards` で戻す |

### ライブデモ（OSS の npm と GitHub）

`examples/oss` は、作者の npm パッケージの日ごとのダウンロード数と、GitHub のリポジトリのいまのスター・フォーク・issue の数のダッシュボードです（スターが付いた日は、GitHub がサインインした人にしか出さないので取りません）。公開するデモは GitHub Actions（`.github/workflows/pages.yml`）が毎朝本物の数字を取ってビルドし、ドキュメントのサイトの `/demo/` に置きます。手元では、作りものの数字（`pnpm --filter devbi-example-oss fixture`）で確かめます。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 138 | `pnpm --filter devbi-example-oss fixture` のあと `pnpm demo:dev` で <http://localhost:5173> を開く | 一覧を通らずに「OSS の npm と GitHub」が開く（ダッシュボードが 1 つだけのため）。期間は「直近30日」（2026/10/10〜2026/11/8）。「ダウンロード」12,451（前期間増減率 7.7%、1 日あたり 415）、「ダウンロードの累計（全期間）」61,199、「いまのスター」49 |
| 139 | 「パッケージ別」の「example-cli」を押す | 上に「パッケージ: example-cli」が出て、日ごとの折れ線、「パッケージ別の累計（全期間）」、「リポジトリ別（Malloy）」が example-cli だけになる（example/cli 1,353）。「いまのスター」と「リポジトリ（いまの数字）」は変わらない（パッケージの軸がないため） |
| 140 | 「すべて解除」を押し、「リポジトリ別（Malloy）」の「example/grid」の行を押す | 上に「リポジトリ: example/grid」が出て、「いまのスター」が 42、「リポジトリ（いまの数字）」が example/grid の 1 行になる |
| 141 | 「曜日ごとの 1 日あたり（SQL）」を見る | 月〜日の 7 本の棒で、土・日が低い |
| 142 | ネットワークのある所で `pnpm demo:fetch` のあと `pnpm --filter devbi-example-oss check` | 作者のパッケージごとのダウンロード数とリポジトリのスターが出て、最後に「data/ に書きました」。check は「問題はありません」 |
| 143 | GitHub のリポジトリの Settings → Pages で Source を「GitHub Actions」にし、Actions の「Pages」を「Run workflow」で動かす | <https://ishibashi0112.github.io/devbi/demo/> にデモ、<https://ishibashi0112.github.io/devbi/> にドキュメントのサイトが出る。前のデモのアドレス（<https://ishibashi0112.github.io/devbi/#/oss>）はデモに移る。Pages が有効でないあいだは、Pages のワークフローは公開せずに「GitHub Pages が有効ではないため…」とだけ出す。GitHub は、60 日コミットのないリポジトリの毎朝の実行を止める。止まったら Actions の「Pages」で「Enable workflow」を押す |

### ドキュメントのサイト

README.md と docs/*.md（`handoff.md` を除く）を、VitePress（`docs/.vitepress/`）で 1 つのサイトにします。ページはこれらのファイルそのもので、サイトのためにほかに書くのはトップページ（`docs/index.md`）だけです。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 144 | `pnpm docs:dev` で <http://localhost:5173/devbi/> を開く | トップに「開発者が自社アプリ・社内システムに組み込む、コードで管理する BI」と 6 つの特長、「はじめる」のコマンド、「向いているとき」「DevBI がしないこと」。上の左にロゴと検索、右に「はじめる」「リファレンス」「社内に公開する」「開発」「ライブデモ」と、外観の切り替え・GitHub・npm |
| 145 | 上の「リファレンス」を押し、左の「リファレンス」の下の「dash.json」を押す | その見出しまで動き、左の「dash.json」と、右の「このページの内容」の「dash.json」が強調される。本文の最初の目次の「自作タイル（JSX）」を押すと、その見出しに動き、左の「自作タイル（JSX）」が強調される |
| 146 | 「リファレンス」の最初の段落の「README」と「manual-check.md」、「社内に公開する」の「GitHub Pages」の節の「pages.yml」を押す | README と manual-check.md は、サイトの中の「リポジトリと開発」「動作チェックの手順」が開く。pages.yml はサイトのページではないので、GitHub のそのファイルが別のタブで開く |
| 147 | 上の検索（Ctrl+K、Mac は ⌘K）に「スナップショット」、次に「埋め込む」と入れる | どちらもリファレンス・社内に公開する・動作チェックの手順の見出しが出て、押すとその見出しに動く（日本語の単語で引ける） |
| 148 | 「ライブデモ」を押す | `pnpm docs:dev` では 404（デモはサイトに入っていないため）。公開したサイトではデモが開く（143） |
| 149 | `pnpm docs:build` | 「build complete」で `docs/.vitepress/dist/` にできる。ページ・ファイル・見出し（`#…`）へのリンクが切れていると、どのファイルのどのリンクかを出して止まる |

### SQL のパラメーターの型と複数の値

`examples/sales/api/order_lines.sql` は、先頭の `-- param:` の行でパラメーターの型を決めています（受注日の「から」「まで」は日付、地域は複数の文字。書き方は[リファレンス](reference.md#パラメーターの型---param)）。サーバーは、型に合わない値を SQL に渡す前に断ります。下の curl は、どれも `pnpm example:serve` を動かしたまま、次のコマンドの `-d '…'` の中身を表のとおりに変えて実行します。

```sh
curl -s -X POST -H "Content-Type: application/json" -d '{"name":"order_lines","params":{"from":"2024-04-01","to":null,"regions":["関東","近畿"],"customer":null}}' http://localhost:8080/api/query -o /dev/null -w "%{http_code} %header{x-devbi-rows}\n"
```

| # | すること | 期待する結果 |
| --- | --- | --- |
| 150 | 上のコマンドをそのまま実行し、次に `"regions":["関東","近畿"]` を `"regions":"関東"` にする | `200 3647`（関東と近畿の 2024/4/1 からの明細）、次は `200 2322`（配列でない 1 つの値は、1 つだけの一覧として読む） |
| 151 | `"from":"2024-04-01"` を `"from":"2024/04/01"` に、次に `"to":null` を `"to":"2024-04-31"` にする（`-o /dev/null` を外すと文も出る） | どちらも `400`。文は「api/order_lines.sql: パラメーター from には日付（'2024-04-01' の形の文字）を渡してください（"2024/04/01" が来ました）」と、`to` の同じ文（4 月 31 日はない日） |
| 152 | `"regions":[]` にする | `400` で「パラメーター regions に 1 つ以上の値を渡してください」 |
| 153 | `params` の中に `"user.region":"関東"` を足す | `400` で「パラメーター user.region は渡せません（user. で始まる名前は、ログインした人の値のために取ってあります）」（ブラウザから、ログインした人の値を装えない） |
| 154 | `order_lines.sql` の `-- param: to date` を `-- param: to day` に変えて保存し、<http://localhost:8080/api/schema> を開く。150 のコマンドも実行する | `order_lines` は `error` だけになり「api/order_lines.sql（4 行目）: 型 day は使えません。text・integer・number・date・datetime・boolean のどれかを書いてください（複数の値は text[] のように）」。curl も `400`。`date` に戻すと直る |

ASP.NET（C#）の見本（55）でも、アドレスを `http://127.0.0.1:4179/api/query` にして 150〜153 が同じ結果になります。Next.js の見本（61）では `http://127.0.0.1:3000/devbi/api/query` です。SQL Server・Oracle・MySQL（50〜53）でも同じ行数です。

### レポート（パラメーターの欄と SQL の結果の表）

「受注明細レポート」（`examples/sales/dashboards/sales-report.dash.json`）は、上に `api/customer_totals.sql`（顧客別）、下に `api/order_lines.sql`（受注明細）の結果をそのまま表に出します。見出しの下の欄は、SQL の `-- param:` の行から作られます（書き方は[リファレンス](reference.md#レポートパラメーターの欄とsql-の結果の表)）。`pnpm example:serve` を動かして、<http://localhost:8080/#/sales-report> を開きます。行数は、ターミナルの `api/order_lines.sql: … 行` の行で見ます。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 155 | 開く | 見出しの下に「受注日（から）」（今年度の始まり。2027 年 3 月までは 2026/04/01）、「受注日（まで）」（空）、「地域」（「すべて（6）」）、「顧客」（「（指定なし）」）の 4 つの欄。下の表は 2026/4/1 からの明細で、`1,532 行` |
| 156 | 開発者ツールの「ネットワーク」を見る | 地域の候補は `snapshots/regions.arrows`（毎朝のスナップショット。175）。`query` は 3 つ: `customers`（顧客の候補。地域の 6 つ）、`customer_totals` と `order_lines`（`{"from":"2026-04-01","to":null,"regions":[…6 つ],"customer":null}`）。`duckdb` や `.wasm` のファイルは読んでいない |
| 157 | 「地域」を押し、「すべて外す」を押して「関東」にチェックし、欄の外を押す | 欄が「関東」になり、表を読み直す（`595 行`）。アドレスが `#/sales-report?regions=…`（関東）になる |
| 158 | 「受注日（から）」を 2024/04/01、「受注日（まで）」を 2024/04/30 にし、「地域」で「近畿」にもチェックする | `95 行`。アドレスは `from=2024-04-01&to=2024-04-30&regions=近畿&regions=関東`。このアドレスを新しいタブで開くと、同じ値の欄と表で開く |
| 159 | 「ファイル出力」→「Excel（.xlsx）」を押す | 「受注明細」のシートの 2 行目が「パラメーター: 受注日（から） 2024-04-01、受注日（まで） 2024-04-30、地域 近畿・関東、顧客 （指定なし）」（「顧客別」のシートは顧客なし）。「概要」のシートにも同じ値の行。受注日の列は Excel の日付で、いちばん下に太字の「合計」の行 |
| 160 | 「更新」を押す | 同じ値でもう一度読む（ターミナルに `95 行` がもう 1 行）。「地域」を一度「関東」だけにしてから戻したときは、読み直さない（覚えている） |
| 161 | 「受注日（から）」を消して、欄の外を押す | 表に「受注日（から）を入れてください」と出て、`query` は増えない。日付を入れると戻る |
| 162 | アドレスの `from=2024-04-01` を `from=2024/04/01` にして開き直す | 「受注日（から）」は今年度の始まりで開く。コンソールに「アドレスのパラメーター from の値 "2024/04/01" は日付（2024-04-01 の形）ではないので使いません」 |
| 163 | 埋め込みのページ <http://localhost:8080/embed-demo.html> のコンソールで `DevBI.mount("#report-area", { dashboard: "sales-report", params: { from: "2024-04-01", regions: ["九州・沖縄"] } })` | 受注明細レポートに替わり、地域が「九州・沖縄」、表はその地域だけ。ページのアドレスは変わらない |
| 164 | `pnpm example:dev` で <http://localhost:5173/#/sales-report> を開き、`dashboards/sales-report.dash.json` の `"fiscalYearStart": 4,` の下に `"apply": "button",` を足して保存 | 欄の右に「表示」のボタン。値を変えても表は変わらず、「表示」を押すと読み直す。戻す |
| 165 | 同じく、`api/order_lines.sql` の `label=受注日（から）` を `label=開始日` に変えて保存 | ページが読み込み直され、欄の名前が「開始日」になる。戻す |
| 166 | `pnpm example:check` | `dashboards/sales-report.dash.json: タイル 3（クエリを実行 0）` と、`customers: データセット customer_totals（api/customer_totals.sql）を読むタイル。列 6 個の名前はデータベースに聞いて確かめました。行はデータベースから読むため数えていません`、`lines` の同じ行（列 10 個）。最後は「問題はありません」 |

#### 表の options（列・グループ・合計・クリック）

<http://localhost:8080/#/sales-report?from=2024-04-01> を開きます（全期間。「顧客別」は 40 顧客、「受注明細」は 6,044 行）。表の書き方は[リファレンス](reference.md#表の-options)にあります。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 167 | 「顧客別」の表を見る | 列は「地域・顧客・受注数・数量・金額」（`顧客ID` は隠してある）。地域ごとのグループの行（「▾ 九州・沖縄 (3件)」で ¥19,293,490 など）があり、▾ で閉じられる。金額に横棒。いちばん下に「合計 3,029 59,421 ¥193,161,410」 |
| 168 | 「青葉工業」の行をクリック | その行に色が付き、欄の「顧客」が「青葉工業」、アドレスに `customer=5`。下の「受注明細」は青葉工業だけ（`276 行`）で、合計の行は「2,673 ¥10,012,620」。「顧客別」は読み直さない |
| 169 | もう一度「青葉工業」の行をクリック | 色が消え、「顧客」が「（指定なし）」、アドレスから `customer` が消え、明細は全員に戻る（覚えているので読み直さない）。欄の「顧客」で選んでも同じように絞れる |
| 170 | 「受注明細」を横にスクロールする | 受注日の列は左に残る。合計の行は「数量」と「金額」だけ（「単価」は足さない: `agg` を書いた列だけ） |
| 171 | アドレスを `#/sales-report?from=2024-04-01&to=2024-04-30` にして、「受注明細」の検索欄に `グリス` と打つ | 商品がグリスの行だけ（`172 行` → 23 行）。合計の行もその行の合計。データベースへは行かない（ターミナルの行数は増えない） |
| 172 | 「地域」の見出しにマウスを置いて ⋮ →「フィルター…」→「（すべて選択）」を外して「関東」にチェック →「閉じる」 | 関東のグリスだけ 8 行、合計は「100 ¥86,800」。検索欄の下に絞り込みの札（× で外れる） |
| 173 | そのまま「ファイル出力」→「Excel（.xlsx）」を押す | 「受注明細」のシートの 3 行目が「表の検索・列のフィルターで絞った行です」、その下に画面と同じ 8 行と「合計 … 100 … 86800」。「顧客別」のシートは「地域」の列が先頭で、`顧客ID` の列はない |
| 174 | 「受注日」の ⋮ →「フィルター…」 | 値の一覧が「2024 年」の下に月と日。「4 月」→「1 日」だけにすると、2024/4/1 の 7 行（日付は 1 日もずれない）。「範囲」でも絞れる |
| 175 | 「顧客別」の ⋮ →「列の表示」 | 右に「フィルター・列・並び替え」のパネル。「列」に、隠した「顧客ID」（チェックなし）と「地域（グループ化中）」。顧客ID にチェックすると出る。そのあとパラメーターを変えても、列の並び・固定・表示はそのまま。「受注日（まで）」を「受注日（から）」より前にして行が 0 件（「行がありません」）になってから戻しても、そのまま |
| 176 | `pnpm example:serve` のターミナルと <http://localhost:8080/api/schema> を見る | 起動したときに「スナップショット: sales_daily（06:00）、regions（06:00）」。`snapshots` に `regions`（`"dashboards":["sales-report"]`。受注明細レポートの地域の候補）。`order_lines` と `customer_totals` は既定値に `fiscal_year_start` と `all` があるので作らない |
| 177 | `examples/sales/dashboards/` に `try.dash.json` を `{"title": "地域の一覧", "tiles": [{"id": "r", "x": 0, "y": 0, "w": 6, "h": 4, "type": "table", "title": "地域", "query": {"dataset": "regions"}}]}` で置き、`pnpm example:serve` で開き直す | 一覧の「地域の一覧」に「毎日 6:00 の時点のデータ」。開くと、表の見出しの右に「11月23日 6:00 の時点」のような時刻（マウスを置くと説明）。「更新」を押すと時刻が消え、データベースから読む。確かめたら `try.dash.json` を消す |
| 178 | `dashboards/sales-report.dash.json` の明細の `"agg": "sum"` を `"agg": "median"` にして `pnpm example:check` | `タイル lines: options.columns[7].agg は sum・avg・min・max・count のどれかです` のエラー。画面の表にも同じ文が出る。戻す |
| 179 | `pnpm example:dev` で <http://localhost:5173/#/sales-report> を開き、「編集」で「顧客別」の表を選ぶ | 設定欄の「表示」に「列」「グループ」「合計の行」「検索欄」「行のクリック」。「売上ダッシュボード」の表（指標ファイルの表）を選んだときは、これらは出ない |
| 180 | 続けて「グループ」を `{}` にして欄の外を押し、次に `["地域", "顧客"]` にして欄の外を押す | `{}` では欄の下に「[ ] で囲んだ JSON の配列にしてください」と出て、表は変わらない。`["地域", "顧客"]` では、地域の中に顧客のグループ。保存せずに閉じる |

#### 列を聞く（devbi-check・pnpm gen・api/describe）

データセットの結果の列を、行を読まずにデータベースに聞きます（[リファレンス](reference.md#データセットの行の型)）。サンプルの接続先は `examples/sales/.env` の SQLite です。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 181 | `dashboards/sales-report.dash.json` の顧客別（`customers`）の `options.columns` の `"顧客",` を `"顧客名",` にして `pnpm example:check` | `✗ dashboards/sales-report.dash.json: タイル customers（顧客別（…））: options.columns の「顧客名」は結果の列にありません（列: 顧客ID、地域、顧客、受注数、数量、金額）`。戻す |
| 182 | `api/order_lines.sql` の `-- key: 受注番号, 行番号` を `-- key: 受注番号, 行` にして `pnpm example:check` | `✗ api/order_lines.sql: -- key: の 行 は結果の列にありません（列: 受注日、受注番号、行番号、…）` が 1 回だけ。戻す |
| 183 | `DEVBI_DB=postgres://devbi@127.0.0.1:1/x pnpm example:check`（つながらない接続先） | レポートのタイルの行が「データベースにつながらないため、列の名前は確かめていません。」で、列の名前のエラーや注意は出ない（DB 版の指標ファイルの `read_api` は、いつもどおりエラー） |
| 184 | `pnpm gen` のあと `examples/sales/.devbi/env.d.ts` を開く | `interface DatasetRegistry` に `"order_lines"` の `params: "from" \| "to" \| "regions" \| "customer";` と `row: {` の下に `"受注番号": string \| null;`、`"数量": number \| null;` など。計算した列（`"金額"`）と SQLite の `DATE` の列（`"受注日"`）は `import("devbi").Scalar`。`.devbi/columns.json`（git に入っているもの）は変わらない（`git status` に出ない） |
| 185 | `DEVBI_DB=postgres://devbi@127.0.0.1:1/x pnpm --filter devbi-example-sales gen` | 「データセットの列を聞けませんでした（行の型は前に聞いたまま。…）」と、6 つのデータセットごとに `api/orders.sql: connect ECONNREFUSED 127.0.0.1:1` のような理由。終了コードは 0 で、`env.d.ts` の `row` は 184 のまま |
| 186 | `pnpm example:dev` を動かしたまま、`api/regions.sql` の `SELECT DISTINCT region AS 地域` を `SELECT DISTINCT region AS 地域, 1 AS one` にして保存 | 1〜2 秒で `.devbi/env.d.ts` の `"regions"` の `row` に `"one": import("devbi").Scalar;` が加わる。戻すと消える |
| 187 | 開発サーバーを動かしたまま、`curl -s -X POST -H "Content-Type: application/json" -d '{"name":"order_lines"}' http://localhost:5173/api/describe` | `{"name":"order_lines","columns":[{"name":"受注日","type":"date","dbType":"DATE"},…]}`（10 列）。`pnpm example:serve` の `http://localhost:8080/api/describe` には同じものを送っても `405`（開発サーバーだけ） |

#### GUI エディタでデータセットの列を選ぶ

GUI エディタの設定欄で、データセットの表の列を、データベースが答えた列から選びます（[リファレンス](reference.md#設定欄プロパティパネル)）。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 188 | `pnpm example:dev` で <http://localhost:5173/#/sales-report> を開き、「編集」で「顧客別」の表を選ぶ | 設定欄の「データ」に「データの元」（データセット（api/ の SQL））、「データセット」（customer_totals）、「パラメーター: 受注日（から）、受注日（まで）、地域」。その下の「列」に、顧客ID（`INTEGER`、「隠す」）・顧客・受注数・数量・金額のチェックと、チェックのない「地域」（「グループ」）。数秒たっても「データベースに列を聞いています…」のままにならない |
| 189 | 続けて「受注数」のチェックを外し、「金額」の ⋯ で「列の見出し」を「売上」にし、「売上」の ↑ を押す | 表の列が「地域・顧客・売上・数量」の順になり、すぐ表に出る。「地域」の ⋯ には「この列の値で行をまとめる（グループ）」だけがあり、外すと地域のまとまりが消える。⌘Z で 1 つずつ戻る。保存せずに閉じる |
| 190 | 「顧客別」を選び、「データセット」を `regions` にする。次に「データの元」を「指標ファイル（集計する）」にする | `regions` では「列」が「地域」だけになり、表も地域の列だけ（「グループ」「行のクリック」は消える）。指標ファイルにすると、データの欄が「書き方」「指標」「軸」になり、表は指標の表になる。保存せずに閉じる |
| 191 | `DEVBI_DB=postgres://devbi@127.0.0.1:1/x pnpm --filter devbi-example-sales dev`（つながらない接続先）で開き、188 と同じく「顧客別」を選ぶ | 「列」に「列を聞けませんでした（api/customer_totals.sql: connect ECONNREFUSED 127.0.0.1:1）」と「もう一度」。dash.json に書いてある列（顧客ID・顧客・受注数・数量・金額）とグループの地域だけが、型なしで並ぶ。チェックや ⋯ はそのまま使える |
| 192 | <http://localhost:5173/#/sales> で「編集」、「商品別」の表を選び、「データの元」を「データセット（api/ の SQL）」にする | データセットは customer_totals になり、表がすぐ顧客ID・地域・顧客・受注数・数量・金額の列になる（受注日と地域のパラメーターは既定値。「パラメーター from の欄がありません」は出ない）。保存せずに閉じる |

### ファイル出力の CSV

`pnpm example:serve` で <http://localhost:8080/#/sales>（売上ダッシュボード）を開きます。CSV は、ほかのプログラムに読ませるための、表示形式のない値です（[リファレンス](reference.md#csv)）。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 193 | 見出しの右の「ファイル出力」を押す。Esc を押し（ボタンが選ばれたまま）、↓ を押して、↓・↑ を押す。メニューの中の「CSV（.csv）」の見出しを押してから Esc | メニューが開き、上から「Excel（.xlsx）」、線、「印刷・PDF」、線、「CSV（.csv）」の見出しと「すべてのタイル（.zip）」、そのあとにタイルの名前（売上・受注件数 … 商品別の 12。期間の欄と説明の文はない）。Esc で閉じ、↓ でまた開いて、矢印で選んでいるもの（枠と色）が動く。見出しを押してもメニューは開いたままで、Esc で閉じる。メニューの外を押しても閉じる。ダークモードでも読める色 |
| 194 | 「地域別売上」の「関東」を押してから、「ファイル出力」→「月別売上」 | `売上ダッシュボード_月別売上_20261123-2033.csv` のような名前でダウンロードされる。Excel で開くと文字化けせず、A 列「受注日」は 2026/4/1 から月の初めの日付、B 列「売上」は ¥ もカンマもない数（関東だけの値。97 の Excel の「月別売上」のシートと同じ数）。テキストエディタで開くと 1 行目が `受注日,売上`、2 行目が `2026-04-01,2622450` のような形 |
| 195 | そのまま「ファイル出力」→「すべてのタイル（.zip）」 | `売上ダッシュボード_20261123-2033.zip` のような名前。開く（Mac はダブルクリック、Windows はエクスプローラーで右クリック →「すべて展開」）と、`売上.csv`・`受注件数.csv` … `商品別.csv` の 12 個で、名前が文字化けしていない。ファイルの日時は書き出した時刻。`地域 × 四半期.csv` は `地域,受注日,売上` の縦の形（クロス集計ではない。合計の行もない）、`売上.csv` の「売上 前年比」は `1.29…` のような比の値（% ではない）、`地域別売上.csv` は 6 地域（自分の選択では絞らない） |
| 196 | <http://localhost:8080/#/sales-report?from=2024-04-01&to=2024-04-30> で、171・172 のように「グリス」と「関東」で絞り、「ファイル出力」→「受注明細」 | `受注明細レポート_受注明細_….csv`。画面と同じ列と 8 行で、合計の行はない。受注日は `2024-04-..` の形 |
| 197 | ブラウザの幅をスマートフォンほどに狭くし、「ファイル出力」→「Excel（.xlsx）」のあと、もう一度「ファイル出力」を押す（エラーが出てボタンが左に寄ったときも） | メニューが画面の左右からはみ出さない（ボタンが左にあるときは、ボタンの左端から右に開く） |
| 198 | 埋め込みの見本（上の 35）で、ブラウザのコンソールに `DevBI.mount("#report-area", { exports: ["xlsx", "pdf"] })`。次に `DevBI.mount("#report-area", { exports: false })` | 1 つ目で、「ファイル出力」のメニューから CSV がなくなる（Excel と印刷・PDF だけ）。2 つ目で「ファイル出力」のボタンがなくなる |

### 行レベル制御（サーバーの中心）

ログインした人ごとに見える行を変える仕組みの、サーバーの部分です（[リファレンス](reference.md#利用者ごとに見える行を変える行レベル制御)）。開発サーバーで「この人として見る」画面と、`devbi-serve` が前のサーバーからユーザー名を受け取る口はまだないので、ここではスナップショットの直しと、Node から利用者を渡したときの答えを確かめます。199〜202 は `pnpm example:serve` を動かしたまま、203 は `pnpm build` のあとで実行します。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 199 | `curl -s -o /dev/null -w "%{http_code}\n" --path-as-is "http://localhost:8080/snapshots//sales_daily~9e979dd94c517434.arrows"`、次に `//` を `/` にして同じコマンド | 1 つ目は `404`（前は `dist/snapshots/` のファイルがそのまま返っていた）、2 つ目は `200`。スナップショットは API の口からだけ返る |
| 200 | `devbi-serve` を止め、`examples/sales/dist/snapshots/` に `old.arrows` という名前の空のファイルを置いてから、`pnpm --filter devbi-example-sales serve` で動かし直す | ターミナルに `スナップショット: 今は作らない old.arrows を消しました` と出て、ファイルがなくなる（`sales_daily~….arrows` と `regions.arrows` は残る） |
| 201 | `examples/sales/api/regions.sql` の 2 行目（`-- snapshot: 06:00`）の下に `-- access: all` を足して保存し、<http://localhost:8080/api/schema> と <http://localhost:8080/#/sales-db> を開き直す | `{"error":"ログインしていません"}`。ダッシュボードのタイルにも「API の orders を読めません（401）: ログインしていません」。ファイルが行レベル制御を使い始めたので、ログインしていない人には何も返さない。足した行を消すと、どちらも元に戻る |
| 202 | `examples/sales/api/regions.sql` の 1 行目の下に `-- Access log の件数も見る` を足して保存し、<http://localhost:8080/api/schema> を開く。次にその行を `--- roles: 経理` に変えて開き直し、最後に足した行を消す | 1 つ目はいつもどおり一覧が出る（`:` のない説明では行レベルのモードにならない）。2 つ目は `{"error":"ログインしていません"}`（`--` のすぐあとでない `roles:` も、黙って読み飛ばさず守る側に倒れる） |
| 203 | 下のコマンドを実行する（地域で絞る SQL を一時的に足し、利用者を渡して読み、最後に消す） | `関東 16`、`近畿 10`、`' OR 1=1 -- 0`（値に `'` があっても SQL は変わらない）、`401 ログインしていません`、`400 api/orders.sql は、だれにどの行を見せるかが書いてありません。…（行レベルのモード: api/my_customers.sql に :user. があるため）` の 5 行 |

```sh
cd examples/sales
printf -- "-- 自分の地域の顧客\nSELECT id FROM customers WHERE region = :user.region\n" > api/my_customers.sql
node --input-type=module -e '
import { createApiHandler, loadEnv } from "@devbi/server";
const api = createApiHandler({ dir: ".", env: loadEnv(".") });
for (const region of ["関東", "近畿", "\x27 OR 1=1 --"]) {
  const { rows } = await api.run("my_customers", {}, { user: { id: "yamada", attrs: { region } } });
  console.log(region, rows);
}
await api.run("my_customers").catch((e) => console.log(e.status, e.message));
await api.run("orders", { from: "2024-04-01" }, { user: { id: "yamada" } }).catch((e) => console.log(e.status, e.message));
await api.close();'
rm api/my_customers.sql
cd ../..
```

### 行レベル制御（開発サーバーで、この人として見る）

`vite.config.ts` の `devbi({ devUsers })` に書いた人として、開発サーバーの API を読む画面です（[リファレンス](reference.md#開発サーバーでこの人として見るdevusers)）。見本は、`api/orders.sql` が `:user.region` で絞る小さなプロジェクト（`examples/sales/e2e/rls/`）です。`examples/sales` で `pnpm exec vite --config e2e/rls.vite.config.ts` を動かし、<http://127.0.0.1:5180> を開きます。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 204 | 開いたまま、何も選ばない | 右上に「表示する利用者 （ログインなし）」。タイルに「API の orders を読めません（401）: ログインしていません（開発サーバーのダッシュボードの右上の『表示する利用者』で選びます）」 |
| 205 | 「表示する利用者」で `yamada（CORP\yamada・営業・region 関東）` を選ぶ | ページが読み込み直され、「担当の売上」が ¥72,393,280、「地域別」は関東だけ。「全社の地域別」（`-- access: all`）は 6 つの地域が全部出る。ターミナルに `devbi: CORP\yamada api/orders.sql: 2,322 行、… ms` |
| 206 | `suzuki` を選び、次に `sato` を選ぶ | suzuki は ¥42,290,840 で近畿だけ。sato は「API の orders を読めません（403）: 利用者 sato に属性 region がありません（api/orders.sql の :user.region）」 |
| 207 | 開発サーバーを止め、`pnpm exec vite --config e2e/rls.vite.config.ts --host` で動かし直して、同じネットワークのスマホかほかのパソコンで、ターミナルに出た Network の URL を開き、yamada を選ぶ | 「…ログインしていません（『表示する利用者』は、開発サーバーを動かしているパソコンで開いたページからだけ使えます）」。このパソコンで開いたページでは今までどおり読める |
| 208 | yamada を選んだまま、同じブラウザでもう一つタブを開いて suzuki を選び、前のタブに戻る | 前のタブも読み込み直され、「表示する利用者」が suzuki になり、近畿だけ（前のタブに yamada の行が残らない） |

### 行レベル制御（devbi-check・devbi-inspect で確かめる）

行レベルのモードのプロジェクトを、`devUsers` の人として確かめます（[リファレンス](reference.md#行レベル制御のプロジェクトを確かめる)）。`pnpm build` のあと、`examples/sales` のフォルダで動かします。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 209 | `pnpm exec devbi-check --dir e2e/rls` | 最初の行が「行レベルのモードです（access/ フォルダがあるため）。データは読んでいません（devUsers を書くか --as を付けます）」。指標ファイルとタイル kpi-revenue・region は「確かめていません（… ログインした人が要ります …）」で、注意 1 件。`examples/sales/vite.config.ts` の `devbi()` は `e2e/rls` を指さないので、`devUsers` を読まない |
| 210 | `pnpm exec devbi-check --dir e2e/rls --config e2e/rls.vite.config.ts` | 「データを yamada・suzuki・sato として流しました」。`models/my_sales.metrics.yaml（yamada として）: 2,322 行`、`（suzuki として）: 1,325 行`、sato は「確かめていません（sato は API の orders を読めません: 利用者 sato に属性 region がありません …）」。ダッシュボードも人ごとに 3 つ。最後に「⚠ models/my_sales.metrics.yaml: sato として: 確かめていません: …」と「エラー 0 件、注意 1 件」 |
| 211 | `pnpm exec devbi-check --dir e2e/rls --config e2e/rls.vite.config.ts --as suzuki --values 3` | 「データを suzuki として流しました」。`kpi-revenue: 売上 ¥42,290,840`、`region: 地域 近畿、売上 ¥42,290,840`。最後に「問題はありません」。`--as tanaka` にすると「devUsers に tanaka がありません（e2e/rls.vite.config.ts にあるのは yamada・suzuki・sato）」で終了コード 2 |
| 212 | `pnpm exec devbi-inspect --dir e2e/rls --config e2e/rls.vite.config.ts --as yamada my_sales`、次に `--config` と `--as` を外して同じコマンド | 1 つ目は「2,322 行、9 列」で、地域は「1 種類 関東 (2,322)」。2 つ目は「API の orders を読んでいません: 行レベルのモードなので、ログインした人が要ります。…」 |
| 213 | `pnpm exec vite --config e2e/rls.vite.config.ts` を動かしたまま、別のターミナルで `pnpm exec devbi-check --dir e2e/rls --config e2e/rls.vite.config.ts --as yamada --url http://127.0.0.1:5180/` | 2 行目に「置いた先 http://127.0.0.1:5180/: ログインが要る API です（行レベルのモードで動いています）」。開発サーバーを止めて `pnpm serve`（行レベル制御を使っていないサンプルの `devbi-serve`）を動かし、`--url http://localhost:8080/` にすると、「✗ --url: http://localhost:8080/api/schema が、ログインしていない人に SQL の一覧を返しました。置いた先は行レベルのモードで動いていません …」で、終了コード 1 |

### 行レベル制御（devbi-serve で、前のサーバーから受け取る）

前に置いたサーバー（IIS・nginx）がヘッダーで渡すユーザー名で、`devbi-serve` が人ごとに行を返すかを確かめます（[リファレンス](reference.md#前のサーバーからユーザー名を受け取るdevbi-serve)）。前のサーバーの代わりに curl でヘッダーを付けます。`pnpm build` のあと、`examples/sales` のフォルダで、見本の小さなプロジェクトをビルドして動かします。

```sh
pnpm exec vite build --config e2e/rls.vite.config.ts --outDir e2e/rls/dist --emptyOutDir
pnpm exec devbi-serve --dir e2e/rls --user-header X-DevBI-User
```

| # | すること | 期待する結果 |
| --- | --- | --- |
| 214 | 起動したときのターミナル | 「ログインした人: 127.0.0.1・::1 からのリクエストの X-DevBI-User。行レベルのモードです」 |
| 215 | 別のターミナルで `curl -s http://127.0.0.1:8080/api/schema`、次に `curl -s -H 'X-DevBI-User: CORP\yamada' http://127.0.0.1:8080/api/schema` | 1 つ目は `{"error":"ログインしていません（前のサーバーから X-DevBI-User が届いていません）","access":1}`。2 つ目は SQL の一覧と、最後に `"access":1,"user":{"id":"CORP\\yamada"}` |
| 216 | `curl -s -o /dev/null -w "%{http_code}\n" -H 'X-DevBI-User: CORP\yamada' -H 'Content-Type: application/json' -d '{"name":"orders","params":{"from":"2024-04-01"}}' http://127.0.0.1:8080/api/query` | `200`。`devbi-serve` のターミナルに `CORP\yamada api/orders.sql: 2,322 行、… ms`（関東の行だけ。地域は `e2e/rls/access/user.sql` から） |
| 217 | 216 の `CORP\yamada` を `CORP\sato` にする（`-o /dev/null -w …` を外す） | `{"error":"利用者 CORP\\sato に属性 region がありません（api/orders.sql の :user.region）"}`（`access/user.sql` にいない人） |
| 218 | `curl -s -H 'X-DevBI-User: a' -H 'X-DevBI-User: b' http://127.0.0.1:8080/api/schema`、次に `curl -s -H 'X-DevBI-User: a, b' http://127.0.0.1:8080/api/schema` | 1 つ目は `{"error":"X-DevBI-User が 2 つあります。前のサーバーは、ブラウザから来た X-DevBI-User を上書きします（足しません）"}`、2 つ目は `{"error":"X-DevBI-User の値に , があります（2 つの値を 1 行にしたもののようです）。…"}`。ターミナルに「リクエストを断りました: …」 |
| 219 | `devbi-serve` を止め、`--trusted-proxy 10.0.0.1` を足して動かし直し、215 の 2 つ目を 2 回 | 2 回とも `{"error":"ログインしていません（このサーバーは、前に置いたサーバーを通して開きます）","access":1}`。ターミナルには「X-DevBI-User を使いませんでした（127.0.0.1 は --trusted-proxy にありません）。…」が 1 回だけ |
| 220 | `devbi-serve` を止め、`printf s3cret > /tmp/devbi-secret` のあと、`--trusted-proxy` の代わりに `--proxy-secret-file /tmp/devbi-secret` を付けて動かし直す。215 の 2 つ目と、それに `-H 'X-DevBI-Proxy-Secret: s3cret'` を足したもの | 1 つ目は「…前に置いたサーバーを通して開きます」、2 つ目は 215 と同じ `"user":{"id":"CORP\\yamada"}` |

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
pnpm test        # 指標 → SQL、xlsx、書式（DuckDB Node で実際に SQL を流す）、API（SQLite）。パッケージのソースを直接読むので、ビルドは要らない
pnpm e2e         # パッケージとサンプルをビルドして devbi-serve で開き、ブラウザ（Playwright）で上の主な操作を確認。GUI エディタは Vite の開発サーバーで、サンプルのコピー（examples/sales/e2e-work/）を相手に確認
pnpm e2e:nextjs  # Next.js の見本（examples/nextjs）を next start で開いて確認
pnpm example:check  # サンプルの指標とすべてのタイルのクエリをデータに流して確認（上の 103）
pnpm check:packed  # パッケージを npm に出す形に固め、create-devbi で作ったプロジェクトに npm と pnpm で入れて確認（上の 95）
dotnet test dotnet/DevBI.sln   # C# の見本（.NET 10 SDK があるとき）
```

`pnpm e2e` は初回だけ `pnpm --filter devbi-example-sales exec playwright install chromium` でブラウザを入れます。

## いまの制限（v0）

- GUI エディタでは、タイルの配置、設定欄（種類・見出し・データ・表示、ダッシュボードの見出しなど）、新しいダッシュボード、組み込みのタイルを .tsx に書き出す「コードにする」ができます。編集は、開発サーバーを動かしているパソコンのブラウザで、タイルを並べる部分の幅が 640px 以上あるときにできます
- 自作タイルのファイル（`export const query` のあるもの）を直すと、ページ全体を読み込み直します（そのタイルだけの差し替えにはなりません）

- グラフの棒や点はマウス・タップでしか選べません（キーボード操作は未対応。リストとチップはキーボードで操作でき、表はセルを矢印キーで動かして Enter かスペースで選べ、Alt+↓（Mac は Option+↓）で列のメニューを開けます）
- 探索（`explore`）のタイルは、最初に出すときに Perspective（JS 約 420KB・CSS 約 110KB と WebAssembly 約 3.2MB）を読みます。タイルの中で変えた並べ方は保存しません（開き直すと `layout` に戻る）。明細は新しいほうから 100,000 行まで（`query.limit` で変える）で、ブラウザのメモリに乗る分だけです。合計の行の「TOTAL」と集計の名前（sum など）は Perspective の英語のままです
- 初回の読み込みが重めです。重いのは DuckDB-wasm（約 34MB、圧縮して 8.5MB）で、2 回目以降はブラウザのキャッシュから読みます。画面の JavaScript は最初に約 440KB を読み、グラフ（約 280KB）、表（約 290KB と CSS 約 79KB）、DuckDB を動かす部分（約 220KB）は使うときに別のファイルとして読みます
- `dist/` を新しいビルドで置き換えたときは、開いたままのページを読み込み直してください。まだ読んでいなかったグラフなどのファイルが見つからず、タイルに「ページを読み込み直してください」と出ます
- Parquet は DuckDB の拡張をインターネットから取りに行きます。社内で外に出られないときは xlsx / CSV で試してください
- `devbi-serve` は、SQL Server の Windows 認証（統合認証）にはまだつなげません（SQL Server 認証のユーザーで試してください）。Windows 認証は ASP.NET（C#）の見本でつなげます。C# の見本は SQL Server だけで、スナップショットは作りません
- スナップショットは Arrow の形で保存します（handoff では Parquet でしたが、DuckDB-wasm が Parquet の拡張をインターネットから取りに行くため）。時刻はサーバーの時計で、`devbi-serve` が止まっていた間の分は、次に起動したときに作ります
- どの SQL をスナップショットから読むかは、ビルドしたときに決まります。`-- snapshot:` の行を足したり消したりしたら、ビルドし直してください（ファイルが見つからないときは、API から読みます）
- `pnpm build` は `dist/` を作り直すので、スナップショットも消えます。`devbi-serve` は次に開かれたときに作り直しますが、IIS などに静的に置くときは、ビルドのあとに `devbi-snapshot` を動かしてください
- 埋め込みの `devbi-embed.js` は、ビルドしたときだけできます（開発サーバーの <http://localhost:5173/embed-demo.html> では出ません）。埋め込むページとほかのオリジンから配るときは CORS の設定が要ります（[リファレンス](reference.md#5-サーバーの設定)）
- 埋め込んだダッシュボードには、ページの CSS のうち要素の名前だけの指定は入りませんが、ID・クラス・疑似クラスの付いた指定（`#main td { … }`、`tr:nth-child(odd) td { … }`）は入ります（Shadow DOM での完全な切り離しはしていません）
- `read_api` のパラメーターは metrics.yaml に固定で書きます。期間を変えたときにデータベースから読み直す仕組みはまだありません。読む行は 100 万行までで、それより多いときは SQL の WHERE で絞ります
