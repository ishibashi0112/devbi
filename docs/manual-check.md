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
| 21 | `pnpm example:preview` を実行して <http://localhost:4173> を開く | 開発サーバーと同じものが動く。`examples/sales/dist/` をそのまま社内のファイルサーバーや IIS に置けば、この形で見られる（ただし「DB から」のダッシュボードは API が要るので、下の 28 の形で動かす） |

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
| 30 | <http://localhost:8080/api/schema> を開く | `orders` の説明とパラメーター `from` が JSON で出る |
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
| 38 | 開発者ツールのコンソールで `DevBI.dashboards` と打つ | `sales`、`sales-daily`、`sales-db` の 3 つが、タイトルつきで出る |
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
| 57 | <http://127.0.0.1:4179/api/schema> を開く | `orders` と `sales_daily` が並び、最後の `snapshots` は `[]`（C# の見本はスナップショットを作らない）。「売上の日次集計」は API から読むので、見出しの下の「…の時点」は出ない |
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
| 63 | <http://127.0.0.1:3000/devbi/api/schema> を開く | `orders` と `sales_daily` が並び、`snapshots` に `updatedAt`（60 で作った時刻）がある |
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
| 76 | 「閉じる」→「＋ 新しいダッシュボード」。ファイル名に `月次` と入れる。次に `monthly`、見出しに「月次の売上」と入れて「作って編集する」。「＋ タイルを追加」で「棒グラフ」を選んで保存し、「閉じる」 | `月次` では「半角の英数字と - _ で書いてください」と出て押せない。作ると空の編集画面（「＋ タイルを追加」から…）になり、棒グラフの月別売上が出る。`examples/sales/dashboards/monthly.dash.json` ができ、閉じると「月次の売上」のダッシュボードが出て、「← 一覧へ」の一覧に 4 つ並ぶ |
| 77 | ターミナルで `git checkout examples/sales/dashboards && rm examples/sales/dashboards/monthly.dash.json` | ページが読み込み直され、一覧が元の 3 つに戻る |
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

npm にはまだ出していないので、パッケージを npm に出す形に固めたもの（tarball）で確かめます。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 93 | `pnpm build && node packages/create-devbi/bin/create-devbi.js ~/devbi-try` | 「/Users/〜/devbi-try に DevBI のプロジェクトを作りました（git init 済み）。」と、`cd`・`npm install`・`npm run dev` が出る。`ls -a ~/devbi-try` で `.gitignore`、`README.md`、`dashboards/`、`models/`、`data/sales.xlsx`、`src/`、`vite.config.ts` があり、`package.json` の `devbi` などは `^0.1.0`（npm に出るまで、ここで `npm install` はできません。確かめたら `rm -rf ~/devbi-try`） |
| 94 | もう一度 93 と同じコマンド | 「/Users/〜/devbi-try は空ではありません」と出て、何も書かない |
| 95 | `pnpm check:packed`（Mac・Linux。5 分ほど。初回は React や Vite を npm から取ってきます） | npm で入れたものと pnpm で入れたもの、それぞれで型チェック・ビルドが通り、「1 passed」が 2 回出る。最後に、作ったプロジェクトの場所（`…/app-npm`、`…/app-pnpm`）が出る |
| 96 | 95 で出た `app-npm` のフォルダで `npm run dev`、<http://localhost:5173> を開く | 売上ダッシュボードが出る（確かめのため「上位顧客」の自作タイルは外してあり、「地域 × 四半期」は「コードにする」で書き出したあとの形）。「編集」で GUI エディタが開く |

### Excel・PDF に書き出す

`pnpm example:dev`（または `pnpm example:serve`）で開いた売上ダッシュボードで確かめます。

| # | すること | 期待する結果 |
| --- | --- | --- |
| 97 | 「地域別売上」の「関東」を押してから、見出しの右の「Excel」を押す | `売上ダッシュボード_20261108-1023.xlsx` のような名前でダウンロードされる。Excel で開くと、最初のシート「概要」に、タイトル・書き出した日時・「絞り込み　受注日: 2026/4/1〜2026/10/30、地域: 関東」と、タイルの一覧がある。一覧のタイルの名前を押すと、そのシートに移る |
| 98 | Excel で「月別売上」「上位顧客（自作タイル）」「地域 × 四半期」「商品別」のシートを見る | 2 行目にそのタイルの絞り込み（「地域: 関東」）。表の見出しは下にスクロールしても残り、フィルタのボタンが付いている。売上は「¥2,622,450」、前年比は「129.8%」のように画面と同じ表示で、セルを選ぶと数式バーには数値（2622450、1.2975…）。月は「2026年4月」と出て、セルの中身は日付（2026/4/1）。「地域 × 四半期」は画面と同じ形のクロス集計で、合計の行と列がある |
| 99 | 「印刷・PDF」を押す | ブラウザの印刷の画面が開き、プレビューは横向きでダッシュボードだけ（「Excel」などのボタン、チップの × はない。見出しの右に「2026/11/8 10:23 の表示」）。タイルがページの境目で切れていない。送り先を「PDF に保存」にして保存すると、`売上ダッシュボード_20261108.pdf` ができる |
| 100 | Mac をダークモードにして、もう一度「印刷・PDF」 | 画面は暗いまま、印刷のプレビューは白地の明るい色 |
| 101 | 埋め込みの見本（上の 35）で「印刷・PDF」を押す | 紺色のヘッダーや左のメニューは入らず、ダッシュボードだけが印刷のプレビューに出る |

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
pnpm check:packed  # パッケージを npm に出す形に固め、create-devbi で作ったプロジェクトに npm と pnpm で入れて確認（上の 95）
dotnet test dotnet/DevBI.sln   # C# の見本（.NET 10 SDK があるとき）
```

`pnpm e2e` は初回だけ `pnpm --filter devbi-example-sales exec playwright install chromium` でブラウザを入れます。

## いまの制限（v0）

- GUI エディタでは、タイルの配置、設定欄（種類・見出し・データ・表示、ダッシュボードの見出しなど）、新しいダッシュボード、組み込みのタイルを .tsx に書き出す「コードにする」ができます。編集は、開発サーバーを動かしているパソコンのブラウザで、タイルを並べる部分の幅が 640px 以上あるときにできます
- 自作タイルのファイル（`export const query` のあるもの）を直すと、ページ全体を読み込み直します（そのタイルだけの差し替えにはなりません）

- グラフの棒や点はマウス・タップでしか選べません（キーボード操作は未対応。リストとチップはキーボードで操作でき、表はセルを矢印キーで動かして Enter かスペースで選べます）
- 初回の読み込みが重めです。重いのは DuckDB-wasm（約 34MB、圧縮して 8.5MB）で、2 回目以降はブラウザのキャッシュから読みます。画面の JavaScript は最初に約 440KB を読み、グラフ（約 280KB）、表（約 225KB と CSS 約 73KB）、DuckDB を動かす部分（約 220KB）は使うときに別のファイルとして読みます
- `dist/` を新しいビルドで置き換えたときは、開いたままのページを読み込み直してください。まだ読んでいなかったグラフなどのファイルが見つからず、タイルに「ページを読み込み直してください」と出ます
- Parquet は DuckDB の拡張をインターネットから取りに行きます。社内で外に出られないときは xlsx / CSV で試してください
- `devbi-serve` は、SQL Server の Windows 認証（統合認証）にはまだつなげません（SQL Server 認証のユーザーで試してください）。Windows 認証は ASP.NET（C#）の見本でつなげます。C# の見本は SQL Server だけで、スナップショットは作りません
- スナップショットは Arrow の形で保存します（handoff では Parquet でしたが、DuckDB-wasm が Parquet の拡張をインターネットから取りに行くため）。時刻はサーバーの時計で、`devbi-serve` が止まっていた間の分は、次に起動したときに作ります
- どの SQL をスナップショットから読むかは、ビルドしたときに決まります。`-- snapshot:` の行を足したり消したりしたら、ビルドし直してください（ファイルが見つからないときは、API から読みます）
- `pnpm build` は `dist/` を作り直すので、スナップショットも消えます。`devbi-serve` は次に開かれたときに作り直しますが、IIS などに静的に置くときは、ビルドのあとに `devbi-snapshot` を動かしてください
- 埋め込みの `devbi-embed.js` は、ビルドしたときだけできます（開発サーバーの <http://localhost:5173/embed-demo.html> では出ません）。埋め込むページとほかのオリジンから配るときは CORS の設定が要ります（[リファレンス](reference.md#5-サーバーの設定)）
- 埋め込んだダッシュボードには、ページの CSS のうち要素の名前だけの指定は入りませんが、ID・クラス・疑似クラスの付いた指定（`#main td { … }`、`tr:nth-child(odd) td { … }`）は入ります（Shadow DOM での完全な切り離しはしていません）
- `read_api` のパラメーターは metrics.yaml に固定で書きます。期間を変えたときにデータベースから読み直す仕組みはまだありません。読む行は 100 万行までで、それより多いときは SQL の WHERE で絞ります
