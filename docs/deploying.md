# 社内に公開する

DevBI のダッシュボードを、社内の人がブラウザで見られるようにする方法をまとめたページです。置き方は 3 つあり、どれも同じプロジェクト（`dashboards/`、`models/`、`data/`、`api/`）をビルドしたものを、別の場所に置くだけです。

ファイル形式とコマンドのくわしい一覧は [reference.md](reference.md) にあります。このページは、どれを選ぶかと、置くときの手順・設定・気をつけることを扱います。

> このページのコマンドは、npm から入れる形（`npm create devbi@latest`、`npm install -D @devbi/server`）で書いています。このリポジトリで試すときは、`examples/sales` で、`pnpm example:build`（`examples/sales/dist/` を作る）と `pnpm example:serve`（`devbi-serve` で開く）が同じものです。

- [3 つの置き方](#3-つの置き方)
- [どの置き方でも同じこと](#どの置き方でも同じこと)
- [1. 静的なサイトとして置く](#1-静的なサイトとして置く)
- [2. 社内のサーバーで devbi-serve を動かす](#2-社内のサーバーで-devbi-serve-を動かす)
- [3. 社内のアプリに埋め込む](#3-社内のアプリに埋め込む)
- [公開する前のチェックリスト](#公開する前のチェックリスト)

## 3 つの置き方

| | 1. 静的なサイト | 2. `devbi-serve` | 3. 社内のアプリに埋め込む |
| --- | --- | --- | --- |
| 置くもの | `dist/` を Web サーバー（IIS、nginx、S3、GitHub Pages など）に写す | `dist/` と API を、社内のサーバーの Node のプロセス 1 つで出す | `dist/` をアプリの静的ファイルに写し、画面に 2 行足す。API はアプリに足す |
| データ | Excel・CSV などのファイル。データベースは毎朝のスナップショット | データベースを開くたびに読む（API）か、毎朝のスナップショット | 2 と同じ（API はアプリの中） |
| サーバーで動くもの | なし（スナップショットを使うときだけ、毎朝 `devbi-snapshot`） | `devbi-serve`（Node 22.16 以上）。前に IIS や nginx を置く | 今あるアプリ（ASP.NET、Next.js など） |
| ログイン | Web サーバーの認証（IIS の Windows 認証など） | 前に置いた IIS や nginx の認証 | アプリのログインがそのまま API にもかかる（`data/` などの静的なファイルにかかるかは、アプリごとに確かめる） |
| 向いている場面 | 日に 1 回の更新で足りる、まず小さく始める、部署の中で見る | データベースの最新を見せたい、レポートの置き場を 1 か所にしたい | いつもの業務の画面の中に出したい、権限をアプリに任せたい |

選び方の目安:

- データが Excel や CSV だけなら **1**。サーバーで動かすものがなく、いちばん手軽です。
- データベースから読むが、朝の時点の数字で足りるなら **1 ＋ 毎朝のスナップショット**。Web サーバーは静的なままで、毎朝 `devbi-snapshot` を動かすだけです。
- 開くたびにデータベースの最新が要るなら **2** か **3**。
- 社内のアプリがあり、そのログインと画面の中で見せたいなら **3**。

3 つは排他ではありません。同じプロジェクトを 1 で置いて試し、あとから 2 や 3 に足せます。

## どの置き方でも同じこと

### ビルドしたもの（`dist/`）

```sh
npm run build      # dist/ ができる（npm run preview で http://localhost:4173 に開いて確かめられる）
```

| `dist/` の中 | 中身 |
| --- | --- |
| `index.html` | ダッシュボードの一覧と、ダッシュボード（URL は `#/<名前>`） |
| `assets/` | JavaScript、CSS、DuckDB のエンジン（WebAssembly）。名前に中身のハッシュが付く |
| `data/` | `models/` の `read_xlsx` などが読むファイル（使っているものだけを、同じ名前で写す） |
| `devbi-embed.js` | 埋め込み用のスクリプト（`devbi({ embed: true })` のときだけ。[3](#3-社内のアプリに埋め込む)） |
| `snapshots/` | 毎朝のスナップショット。ビルドでは作られず、`devbi-serve` か `devbi-snapshot` が作る |

- `vite.config.ts` の `base: "./"`（`create-devbi` の雛形はそうなっています）で、`dist/` をどのフォルダ（`/reports/sales/` など）に置いても動きます。
- 画面の切り替えは URL の `#/` のあとで決まるので、Web サーバーに書き換え（rewrite）の設定は要りません。
- `api/` の SQL と `.env`・`.env.local`（接続先とパスワード）は `dist/` に入りません。
- `npm run build` は `dist/` を作り直すので、`dist/snapshots/` も消えます。

### Web サーバーから配る（ファイルを直接開かない）

`dist/index.html` をダブルクリックしたり、ファイル共有（`\\server\share\…`）の上で開いたりしても、画面は真っ白のままです（ブラウザが `file://` のページからスクリプトやデータを読まないため）。かならず Web サーバーから `http://` か `https://` で開きます。ファイル共有に置きたいときは、IIS の仮想ディレクトリでそのフォルダを指すなど、Web サーバーを通します。

社内の `http://`（HTTPS でない）でも動きます。ただし Basic 認証のようにパスワードがそのまま流れるログインを使うときは、HTTPS にします。

ブラウザは Edge か Chrome などの今のものにします。Edge の IE モード（会社の「エンタープライズ モード サイト一覧」で、社内のサイトが IE モードで開くようになっていることがあります）では、画面は真っ白です。

### ログインと、データが見える範囲

集計はブラウザの中でします。そのため、**ダッシュボードを開ける人は、そのダッシュボードの元の行をすべて受け取っています**。

- `data/` の Excel や CSV、スナップショット（`snapshots/*.arrows`）は、URL を知っていれば直接ダウンロードできます。
- 読み取り API（`api/query`）に届く人は、`api/` の**どの SQL でも**、名前とパラメーターを自分で送って読めます（`api/schema` が一覧を返します）。ダッシュボードに出していない SQL も同じです。
- パラメーター（`read_api('orders', from = '…')` の値）はブラウザが送るので、利用者が書き換えられます。見せてはいけない行を、パラメーターや絞り込みで隠さないでください。
- 人によって見せる行を変えるには、ホストがログインした人を API に渡し、`api/*.sql` の中を `:user.region` のように絞ります（[行レベル制御](reference.md#利用者ごとに見える行を変える行レベル制御)）。今は Node のサーバー（`@devbi/server` を自分のアプリに組み込む形）と、`devbi-serve`（前に置いたサーバーからユーザー名を受け取る。[ログインした人ごとに見える行を変える](#ログインした人ごとに見える行を変える)）で使えます。C# と Next.js の見本はこのあと足します。使わないあいだは、API はだれが開いても同じ行を返します。

なので、守るのは「サイト（と API）に入れる人」です。

- サイト全体にログインをかけます（IIS の Windows 認証、前に置いた nginx の認証、アプリのログインなど）。`dist/` の中の静的なファイル（`data/`、`snapshots/`）にもかかっているかを確かめます。
- Windows 認証で、`reports.corp.local` のように `.` の入った名前で開くと、ブラウザがその名前を「ローカル イントラネット」と見なさず、毎回ユーザー名とパスワードを聞くことがあります。サインインしたままで開けるようにするには、その名前をグループ ポリシーなどでイントラネットのゾーンに入れます。
- 見せる範囲の違う人たちには、プロジェクト（ダッシュボードとデータと `api/`）を分けて、置き場所ごとにログインと権限を分けます。
- データベースのユーザーは、読ませる表の SELECT の権限だけにします（[接続先](reference.md#接続先)）。

### 社外に出られないネットワーク

DuckDB のエンジン、グラフ、表、`explore` の Perspective、Malloy は、どれも `dist/` に入っていて、社外のサーバーへは取りに行きません。Excel・CSV・スナップショット・読み取り API のダッシュボードは、下の表のものを使わなければ、社外への通信がなくても動きます。

DuckDB-wasm は、次のものを使うときに、DuckDB の拡張を `https://extensions.duckdb.org/v2.0.0/wasm_eh/<名前>.duckdb_extension.wasm` から取りに行きます。外に出られないと、タイルに「Extension Autoloading Error … could not be fetched from …」と出ます。

| 使うもの | 拡張 |
| --- | --- |
| `read_parquet`（Parquet のファイル） | `parquet` |
| `read_json`・`read_json_auto`・`read_ndjson`（JSON のファイル） | `json` |
| `current_date`、`today()`、`date_trunc('day', now())`、`AT TIME ZONE` など（日付とタイムゾーンの計算） | `icu` |

どちらかにします。

- 使わない。データは Excel か CSV にし（DevBI は xlsx を自分で読むので、拡張は要りません）、「今日」はデータの最終日から数えます（`date-range` の「最新」「直近」はそうなっています）。
- 拡張のファイルを社内に置く。外に出られるコンピューターで上の URL のファイル（`parquet`・`json`・`icu` のうち使うもの）を取り、プロジェクトの `public/duckdb-ext/v2.0.0/wasm_eh/` に置きます（ビルドで `dist/` に入り、サイトといっしょに配られます）。`vite.config.ts` で、その場所をサーバーの根元からのパスで指します。

  ```ts
  // サイトが http://reports.corp.local/sales/ のとき
  devbi({ extensionRepository: "/sales/duckdb-ext" })
  ```

  - `./duckdb-ext` のような相対パスは、ページではなく `assets/`（DuckDB の Worker の場所）から数えます。根元からのパスか、`https://…` で書きます。
  - ほかのサーバー（ほかのオリジン）に置くときは、そのサーバーが CORS のヘッダーを付け、ログインなしで返す必要があります（ブラウザはほかのオリジンにログインの情報を送りません）。
  - `v2.0.0` は DevBI が使っている DuckDB の版なので、DevBI を上げたときに変わることがあります。取りに行く URL は、タイルのエラーにそのまま出ます。

`model` に `https://…` の URL で書いたファイルは、ブラウザがその URL から直接読みます。社外のファイルは読めません。

### 置いたあとに確かめる

ブラウザでダッシュボードを開き、開発者ツール（F12）で次を見ます。

- **Console にエラーがない。** ダッシュボードが「読み込み中」のまま止まり、`Incorrect response MIME type. Expected 'application/wasm'` と出るときは、Web サーバーが `.wasm` を `application/wasm` で返していません（IIS はよくこうなります。[IIS の設定](#手順の例windows-の-iis)）。
- **Network で `assets/duckdb-base-….wasm` が `200` か `304` で、`Content-Type: application/wasm`。** このファイルは約 34 MB（gzip で約 8.5 MB）あり、最初の 1 回だけ読みます。Web サーバーが `.wasm` も圧縮すると、最初の表示が速くなります。名前にハッシュが付いているので、ブラウザに長くキャッシュさせてかまいません。
- **ログインをかけたなら、別のブラウザ（シークレットウィンドウ）で `…/data/<ファイル>` を開くと、ログインを求められる。**

## 1. 静的なサイトとして置く

`dist/` を Web サーバーのフォルダに写すだけです。サーバーは計算せず、利用者のブラウザがファイルを取って集計します。

### 手順の例（Windows の IIS）

社内の Windows サーバーの IIS に、`http://reports.corp.local/sales/` として置く例です。

1. **`web.config` を `public/` に置く。** プロジェクトの `public/` のファイルはビルドで `dist/` にそのまま入るので、写すたびに設定が付いていきます。

   ```xml
   <!-- public/web.config -->
   <configuration>
     <system.webServer>
       <staticContent>
         <!-- IIS が知らない型（知らない拡張子のファイルは 404 になる） -->
         <remove fileExtension=".wasm" />
         <mimeMap fileExtension=".wasm" mimeType="application/wasm" />
         <remove fileExtension=".arrows" />
         <mimeMap fileExtension=".arrows" mimeType="application/vnd.apache.arrow.stream" />
         <!-- data/ に Parquet を置くとき -->
         <remove fileExtension=".parquet" />
         <mimeMap fileExtension=".parquet" mimeType="application/vnd.apache.parquet" />
         <!-- index.html、devbi-embed.js、data/、snapshots/ は、開くたびに新しいものがあるか確かめさせる -->
         <clientCache cacheControlMode="DisableCache" />
       </staticContent>
     </system.webServer>
     <!-- assets/ は名前に中身のハッシュが付くので、長くキャッシュさせてよい -->
     <location path="assets">
       <system.webServer>
         <staticContent>
           <clientCache cacheControlMode="UseMaxAge" cacheControlMaxAge="365.00:00:00" />
         </staticContent>
       </system.webServer>
     </location>
   </configuration>
   ```

2. **ビルドして、サイトのフォルダに写す。**

   ```bat
   npm run build
   robocopy C:\reports\sales\dist C:\inetpub\wwwroot\sales /MIR /XD snapshots
   ```

   `/MIR` は、`dist/` にないファイルをサイトのフォルダから消します。`/XD snapshots` で、サーバーで作ったスナップショットを消さないようにします。

3. **ログインをかける。** IIS マネージャーでそのフォルダ（かサイト）の「認証」を開き、「Windows 認証」を有効、「匿名認証」を無効にします（「Windows 認証」は、IIS の役割サービスの「Windows 認証」を入れると出ます）。見せる人をしぼるときは、フォルダの NTFS のアクセス権か、`public/web.config` に書く承認規則で決めます。

   ```xml
   <!-- public/web.config の <system.webServer> の中に足す（営業部のグループだけ） -->
   <security>
     <authorization>
       <remove users="*" roles="" verbs="" />
       <add accessType="Allow" roles="CORP\営業部" />
     </authorization>
   </security>
   ```

   承認規則には、IIS の役割サービスの「URL 承認」が要ります。IIS マネージャーでこのフォルダに設定したもの（承認規則、MIME の種類、HTTP 応答ヘッダーなど）は、このフォルダの `web.config` に書かれるので、次に `robocopy /MIR` で写すと `dist/web.config` に置き換わって消えます。このフォルダの設定は `public/web.config` に書くか、親のフォルダかサイトに設定します（Windows 認証の有効・無効と NTFS のアクセス権は、`web.config` に書かれないので消えません）。

4. **開いて確かめる。** `http://reports.corp.local/sales/` を開き、[置いたあとに確かめる](#置いたあとに確かめる)を見ます。URL は最後の `/` まで書きます（IIS はフォルダの URL に `/` がないと付けて開き直します）。

- `.wasm` の圧縮: IIS の静的圧縮は、そのままでは `application/wasm`（と、スナップショットの `application/vnd.apache.arrow.stream`）を圧縮しません。サーバーの「構成エディター」で `system.webServer/httpCompression` の `staticTypes` に足します（サイトの `web.config` には書けない設定です）。また IIS は、10 秒の間に 2 回聞かれたファイルだけを圧縮するので、`system.webServer/serverRuntime` の `frequentHitThreshold` を `1` にすると、最初の人から圧縮されます。
- `robocopy` は、ファイルを写せたときも終了コードが 1（1〜7 は成功）です。スクリプトやタスクスケジューラで成否を見るときは、8 以上を失敗とします。
- `<remove>` を先に書くのは、IIS がもともとその拡張子を知っているときに、同じものを重ねて足したエラーにならないようにするためです。

### nginx などのとき

```nginx
location /reports/sales/ {
    alias /srv/www/reports/sales/;          # dist/ を写した場所
    add_header Cache-Control "no-cache";
    gzip on;
    gzip_types application/wasm application/javascript text/javascript text/css application/vnd.apache.arrow.stream;
}
location /reports/sales/assets/ {
    alias /srv/www/reports/sales/assets/;
    add_header Cache-Control "public, max-age=31536000, immutable";
    gzip on;
    gzip_types application/wasm application/javascript text/javascript text/css;
}
```

- `mime.types` に `application/wasm  wasm;` がなければ足します。`.arrows` は型を知らなくても読めますが（`application/octet-stream` で届けば足ります）、圧縮させるなら `mime.types` に `application/vnd.apache.arrow.stream  arrows;` を足します（`types { … }` を `location` に書くと、ほかの型が消えるので `mime.types` に）。
- 写すときは `rsync -a --delete --exclude snapshots/ dist/ /srv/www/reports/sales/` のように、スナップショットを消さないようにします。
- Apache や、ほかの Web サーバーでも同じです。要るのは、`.wasm` を `application/wasm` で返すことと、`assets/` 以外を長くキャッシュさせないことです。

### データを新しくする

**Excel や CSV を差し替える。** データのファイルは同じ名前で `dist/data/` に入っていて、ビルドの中には入っていません。シートの名前と列が同じなら、サイトの `data/sales.xlsx` を新しいものに置き換えるだけで、ビルドし直さずに新しい数字になります（期間の「最新」も、データの最終日から決まります）。

- 共有フォルダの Excel を毎朝写すなら、タスクスケジューラで `robocopy \\fileserver\営業\集計 C:\inetpub\wwwroot\sales\data 売上明細.xlsx` のように動かします（`models/` の `read_xlsx('data/売上明細.xlsx', …)` と同じ名前で）。タスクを動かすアカウントには、共有フォルダを読む権限と、サイトの `data/` に書く権限が要ります。
- `data/` を「開くたびに確かめる」設定（上の `web.config` の `DisableCache`、nginx の `no-cache`）にしておきます。Web サーバーが `Cache-Control` を送らないと、ブラウザは前のファイルをしばらく使い続けることがあります。
- プロジェクトの `data/` のファイルも同じものにしておきます。次にビルドして写すと、プロジェクトの `data/` のファイルに戻るためです。

**データベースを、毎朝のスナップショットで読む。** Web サーバーは静的なままで、データベースの数字を出せます。静的なサイトには API がないので、`-- snapshot:` の行のない `read_api` は読めません（タイルに「API の … を読めません（404）」のようなエラーが出ます。`devbi-check` では見つかりません）。

1. `api/<名前>.sql` の先頭に `-- snapshot: 06:00` と書き、`models/` で `read_api('<名前>', …)` から読みます（[毎朝のスナップショット](reference.md#毎朝のスナップショット)）。
2. 開発のプロジェクトで `npm install -D @devbi/server mssql`（ドライバーはデータベースに合わせる。[接続先](reference.md#接続先)）をしてコミットしておきます。
3. サイトを置くサーバー（か、データベースとサイトのフォルダの両方に届くサーバー）に、Node 22.16 以上と、プロジェクトのフォルダを置き（`git clone` して `npm ci`）、接続先を `.env.local` に書きます（`DEVBI_DB=mssql://…`）。`.env.local` にはデータベースのパスワードが入るので、タスクを動かすアカウントと管理者だけが読めるようにします。
4. 毎朝、タスクスケジューラ（Linux なら cron）で動かします。

   ```bat
   C:\reports\sales\node_modules\.bin\devbi-snapshot.cmd --dir C:\reports\sales --out C:\inetpub\wwwroot\sales
   ```

   タスクスケジューラでは、「プログラム」に `C:\reports\sales\node_modules\.bin\devbi-snapshot.cmd`、「引数」に `--dir C:\reports\sales --out C:\inetpub\wwwroot\sales`、「開始」にプロジェクトのフォルダを書き、「ユーザーがログオンしているかどうかにかかわらず実行する」にします。時刻は `-- snapshot:` に書いた時刻に合わせます（画面に「毎日 6:00 に更新」と出るのは、`-- snapshot:` の時刻です）。

   - タスクを動かすアカウントには、`C:\inetpub\wwwroot\sales\snapshots` に書く権限が要ります（`C:\inetpub\wwwroot` は、ふつうは管理者しか書けません）。
   - タスクスケジューラは出力を残さないので、作れなかったときのくわしい理由を残すなら、「プログラム」を `cmd.exe`、「引数」を `/c C:\reports\sales\node_modules\.bin\devbi-snapshot.cmd --dir … --out … >> C:\reports\logs\snapshot.log 2>&1` にします。`C:\reports\logs` は先に作り、タスクのアカウントが書けるようにしておきます（フォルダがないと、何も動かず、何も残らずに終わります）。
   - `npx devbi-snapshot` でも動きますが、`node_modules` にないときに、npm から同じ名前のものを聞かずに入れようとするので、タスクでは `node_modules\.bin` の中のものを直接指します。

- 作れなかったものがあると終了コードが 1 になり、前のファイルが残ります。タスクスケジューラの「前回の実行結果」で分かります。
- まだ一度も作っていないと、タイルに「スナップショット（snapshots/…）がありません。サーバーで devbi-snapshot を実行するか…」と出ます。ビルドして写したあとに、一度手で動かします。
- `devbi-snapshot` は SQL Server の Windows 認証でつなげません。SELECT の権限だけの SQL Server 認証のユーザーを使います。

**毎朝ビルドし直して置く。** データを取るスクリプトとビルドを、CI（社内のネットワークの中で動く GitHub Actions のセルフホストランナー、Azure Pipelines のエージェントなど）で毎朝動かし、`dist/` を写します。ライブデモの [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) がこの形です（毎朝 npm と GitHub から数字を取り、`devbi-check` で確かめてからビルドして、GitHub Pages に置く）。ビルドの前に `devbi-check` を通すと、データの形が変わったときに、壊れたダッシュボードを出さずに止まります。

### GitHub Pages

リポジトリの Settings → Pages で Source を「GitHub Actions」にし、`dist/` を `actions/upload-pages-artifact` と `actions/deploy-pages` で出します（[pages.yml](../.github/workflows/pages.yml)）。`https://<ユーザー>.github.io/<リポジトリ>/` の下に出るので、`base: "./"` のままにします。

- **GitHub Pages のサイトは、ふつうは誰でも見られます。** 社内だけに見せる（プライベートに公開する）には、GitHub Enterprise Cloud の Organization が要ります。社外に出してよいデータ（デモや公開の統計）のときだけ使ってください。
- API がないので、`read_api` はスナップショットからしか読めません。ワークフローがデータベースに届くときだけ、ビルドしたあとに `devbi-snapshot --out dist` で `dist/snapshots/` に作ってから上げる形になります。

### S3 などのオブジェクトストレージ、ほかの静的ホスティング

`dist/` をそのまま上げれば動きます。気をつけるのは次の 2 つです。

- `.wasm` を `application/wasm` で上げる（ツールによっては型を決めずに `application/octet-stream` で上げます）。上げたあと、[置いたあとに確かめる](#置いたあとに確かめる)で見ます。
- S3 の静的ウェブサイトのホスティングは、インターネットに公開する前提の機能です。社内だけに見せるなら、CloudFront などの前で認証をかけるか、社内のネットワークからだけ届くようにします。Azure Static Web Apps など、ほかのサービスも、ログインをかけられるかで選びます。

## 2. 社内のサーバーで devbi-serve を動かす

`devbi-serve` は、ビルドしたサイトと読み取り API（`api/*.sql` を読み取り専用で実行して Arrow で返す）を、1 つの Node のプロセスで出します。毎朝のスナップショットも、決まった時刻に自分で作ります。

```
利用者のブラウザ ──https──▶ IIS / nginx（ログイン、HTTPS、圧縮） ──http──▶ devbi-serve（127.0.0.1:8080） ──▶ SQL Server / Oracle / MySQL / PostgreSQL
```

### サーバーに置くもの

```
C:\reports\sales\           プロジェクト（git clone したもの）
  api\  models\  dashboards\  data\
  .env.local                DEVBI_DB=mssql://devbi_reader:…@db01:1433/sales（git に入れない）
  node_modules\             npm install で入る（@devbi/server と、使うデータベースのドライバー）
  dist\                     npm run build で作る
```

開発のプロジェクトで、先に `@devbi/server` とデータベースのドライバー（SQL Server は `mssql`、Oracle は `oracledb`、MySQL は `mysql2`、PostgreSQL は `pg`）を入れてコミットしておきます。

```sh
npm install -D @devbi/server mssql
```

サーバーでは、ロックファイルのとおりに入れます（サーバーで `npm install <名前>` をすると `package.json` が変わり、次の `git pull` が止まります）。

```bat
git clone https://…/reports.git C:\reports\sales
cd C:\reports\sales
npm ci
npm run build
REM http://127.0.0.1:8080/ で開く（このコンピューターからだけ）
npx devbi-serve --dir . --port 8080
```

- Node は 22.16 以上です（Linux のディストリビューションの `nodejs` は古いことがあるので、`node -v` で確かめます）。
- サーバーがインターネットに出られないときは、`npm ci` に社内の npm のレジストリかプロキシが要ります（`npm config set registry …`、`npm config set https-proxy …`。TLS を検査するプロキシなら `cafile` も）。どちらもないときは、同じ OS の別のコンピューターで `npm ci` した `node_modules` ごと写します。
- `.env.local` には、データベースのパスワードが入ります。サービスを動かすアカウントと管理者だけが読めるように、ファイルのアクセス権をしぼります。
- データベースのユーザーは SELECT の権限だけにします。`devbi-serve` も SELECT か WITH で始まる文しか通さず、PostgreSQL・Oracle・MySQL では読み取り専用のトランザクション、SQL Server では毎回ロールバックするトランザクションで実行しますが、いちばん確かな守りはデータベースの権限です。
- `devbi-serve` は SQL Server の Windows 認証（統合認証）でつなげません。SQL Server 認証のユーザーを使うか、[3 の ASP.NET の見本](#aspnet-core)を使います。
- オプション（`--max-rows`、`--timeout`、`--debug` など）は [devbi-serve](reference.md#devbi-serve) にあります。`--debug` は、データベースのエラーをそのままブラウザに返すので、社内に出すときは付けません。

### 前に IIS や nginx を置く

`devbi-serve` はログインの仕組みも HTTPS も持たないので、社内に出すときは前に IIS や nginx を置き、そこでログイン・HTTPS・圧縮をして、`devbi-serve` に転送します。`devbi-serve` は `--host 127.0.0.1`（既定）のままにして、前のサーバーからだけ届くようにします。

**`/reports/` の下に転送するときは、`/reports` を外して渡します。** API（`…/api/query` など）はパスの前に何が付いても答えますが、サイトのファイルは `dist/` の中のパスで探すので、`/reports/index.html` のまま渡すと 404 になります。

IIS（URL Rewrite と Application Request Routing を入れ、ARR の「Server Proxy Settings」で「Enable proxy」にしたもの）のサイトの `web.config` の例:

```xml
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <!-- /reports を /reports/ に（./assets/ を /reports/assets/ として読ませる） -->
        <rule name="devbi-slash" stopProcessing="true">
          <match url="^reports$" />
          <action type="Redirect" url="reports/" />
        </rule>
        <!-- /reports/xxx を http://127.0.0.1:8080/xxx に -->
        <rule name="devbi" stopProcessing="true">
          <match url="^reports/(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:8080/{R:1}" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
```

nginx の例:

```nginx
location = /reports { return 301 /reports/; }
location /reports/ {
    proxy_pass http://127.0.0.1:8080/;     # 最後の / で、/reports/ を外して渡す
    proxy_set_header Host $host;
    proxy_read_timeout 90s;                # devbi-serve の --timeout（既定 60 秒）より長く
    gzip on;
    gzip_types application/wasm application/javascript text/javascript text/css;
}
```

- **ホスト名**: `devbi-serve` は、IP アドレスと `localhost` のほかの名前で来たリクエストを断ります（DNS リバインディングの対策）。IIS の ARR も上の nginx の例も、利用者の開いた名前（`reports.corp.local`）を Host のまま渡すので、`--allowed-hosts reports.corp.local` を付けて起動します。`http://reports/` のような短い名前でも開くなら、`--allowed-hosts reports.corp.local,reports` のように両方書きます。ブラウザに「この名前 (…) では開けません。devbi-serve を --allowed-hosts … を付けて起動してください」と出たら、出ている名前を足します。
- **待ち時間**: 前のサーバーの待ち時間の上限は、`devbi-serve` の `--timeout`（既定 60 秒）より長くします（nginx の `proxy_read_timeout` は既定 60 秒、IIS は ARR の「Server Proxy Settings」の「Time-out」）。短いと、重い SQL が終わる前に 502 や 504 になります。
- **圧縮**: API の答えは `devbi-serve` が gzip にします。サイトのファイルは圧縮しないので、`.wasm`（約 34 MB）などは前のサーバーで圧縮させます。IIS では、ARR が転送した答えは「動的コンテンツの圧縮」で圧縮されるので、IIS の役割サービスの「動的コンテンツの圧縮」を入れ、`httpCompression` の `dynamicTypes` に `application/wasm` を足します（1 の静的圧縮の設定は、転送した答えには効きません）。
- **ログイン**: IIS ならそのサイトで「Windows 認証」を有効、「匿名認証」を無効にします。ログインは前のサーバーだけで決まり、`devbi-serve` は利用者がだれかを知りません（だれが開いても同じ行を返します。[ログインと、データが見える範囲](#ログインとデータが見える範囲)）。人ごとに見える行を変えるときは、前のサーバーがユーザー名をヘッダーで渡します（次の節）。
- 前にサーバーを置かず、部署の中のネットワークでログインなしに出すなら、`--host 0.0.0.0` で直接待ち受けることもできます（Windows ファイアウォールでそのポートを開けます）。名前で開くなら、その名前を `--allowed-hosts` に書きます。

### ログインした人ごとに見える行を変える

[行レベル制御](reference.md#利用者ごとに見える行を変える行レベル制御)（`api/*.sql` を `:user.region` のように絞る）を `devbi-serve` で使うときは、前のサーバーがログインを確かめ、ユーザー名をヘッダーで `devbi-serve` に渡します。

```sh
npx devbi-serve --dir . --user-header X-DevBI-User --allowed-hosts reports.corp.local
```

- **前のサーバーは、ブラウザから来た `X-DevBI-User` を必ず上書きするか消します。** そうしないと、利用者が自分でヘッダーを付けて、ほかの人になれます。同じヘッダーが 2 つ届いたリクエストと、値に `,` があるリクエスト（上書きせずに足したとき）は、`devbi-serve` が `400` で断ります。nginx の `proxy_set_header` は、`location` の中に 1 つでも書くと外側（`server`）のものを引き継がないので、`devbi-serve` に送る `location` ごとに `X-DevBI-User` を書きます。
- `devbi-serve` が信じるのは、`--trusted-proxy`（既定は `127.0.0.1` と `::1`）からつながってきたリクエストのヘッダーだけです。前のサーバーが別のコンピューターなら、その IP アドレスを書きます（`--trusted-proxy 10.0.0.5`）。`devbi-serve` には、前のサーバーからだけ届くようにします（`--host 127.0.0.1` か、ファイアウォール）。
- 同じコンピューターでほかのプログラムも動く、リモート デスクトップでほかの人もログインするときは、合言葉を足します: `--proxy-secret-file /etc/devbi/proxy-secret.txt` を付け、前のサーバーが同じ文字を `X-DevBI-Proxy-Secret` ヘッダーに入れます（`proxy_set_header X-DevBI-Proxy-Secret "…";`）。合言葉は半角の英数字と記号で書きます。合言葉のファイルと、合言葉を書いた nginx の設定ファイル（`/etc/nginx/conf.d/` のファイルは、ふつうだれでも読めます）は、サービスのアカウントと管理者だけが読めるようにします（`chmod 600` など）。
- 属性（地域など）と役割は、`access/user.sql` で表から引きます（[リファレンス](reference.md#利用者の属性と役割を表から引くaccessusersql)）。`--user-lowercase` で名前を小文字にそろえるときは、表のログイン名も小文字で入れておきます。
- 置いたあと、`pnpm exec devbi-check --url https://reports.corp.local/reports/` で、置いた先の API が行レベル制御を知っているかを確かめられます（サイトのログインの前で止まるときは確かめられません）。

nginx と oauth2-proxy（Entra ID・Okta・Google・Keycloak などの OpenID Connect）の例:

```nginx
location /reports/ {
    auth_request /oauth2/auth;
    auth_request_set $devbi_user $upstream_http_x_auth_request_user;
    proxy_set_header X-DevBI-User $devbi_user;   # ブラウザから来た X-DevBI-User は、ここで上書きされる
    proxy_set_header Host $host;
    proxy_pass http://127.0.0.1:8080/;
}
# /oauth2/ の location と oauth2-proxy の設定（--set-xauthrequest など）は、oauth2-proxy の説明のとおりに書く
```

`X-Auth-Request-User` にどのクレームが入るかは、oauth2-proxy の設定で決まります。メールアドレスではなく、変わらない ID（Entra ID の `oid` など）が入るようにします。

**IIS の Windows 認証で人ごとに行を変えるなら、[ASP.NET のアプリに埋め込む形](#3-社内のアプリに埋め込む)を勧めます**（C# の対応は、このあと足します）。IIS の URL Rewrite でログインした人の名前（`{LOGON_USER}`）をヘッダーに入れると空になるという報告があり、IIS から `devbi-serve` に Windows のユーザー名を渡す方法は、まだ確かめていません。

**[前に IIS や nginx を置く](#前に-iis-や-nginx-を置く) の IIS（ARR）の例のまま、`--user-header` を付けてはいけません。** ARR はブラウザから来た `X-DevBI-User` をそのまま `devbi-serve` に渡し、そのリクエストは `127.0.0.1` から届くので、Windows 認証でログインした人ならだれでも、ヘッダーを足してほかの人になれます。

### 動かし続ける

`devbi-serve` はふつうのコマンドなので、サーバーが起動したときに動き出し、止まったら動かし直すようにします。

- **Windows**: タスクスケジューラで、トリガーを「スタートアップ時」、「プログラム」を `cmd.exe`、「引数」を `/c C:\reports\sales\node_modules\.bin\devbi-serve.cmd --dir C:\reports\sales --port 8080 --allowed-hosts reports.corp.local >> C:\reports\logs\devbi.log 2>&1`、「開始」を `C:\reports\sales` にします（ログをファイルに残すため `cmd.exe` を通す。`C:\reports\logs` は先に作り、タスクのアカウントが書けるようにしておく）。「ユーザーがログオンしているかどうかにかかわらず実行する」にし、「設定」タブの「タスクを停止するまでの時間」のチェックを外します（既定では、動き始めて 3 日たつと止められるため）。Windows のサービスにしたいときは、NSSM や WinSW などのツールで包みます（どちらも出力をファイルに残せます）。
- **Linux**: systemd のユニットの例です。

  ```ini
  # /etc/systemd/system/devbi.service
  [Unit]
  Description=DevBI reports
  After=network.target

  [Service]
  User=devbi
  WorkingDirectory=/srv/reports/sales
  ExecStart=/srv/reports/sales/node_modules/.bin/devbi-serve --dir /srv/reports/sales --port 8080 --allowed-hosts reports.corp.local
  Environment=TZ=Asia/Tokyo
  Restart=always

  [Install]
  WantedBy=multi-user.target
  ```

- **時刻**: `-- snapshot: 06:00` は、`devbi-serve` が動いているコンピューターの時計の時刻です。クラウドのサーバーなど、時計が UTC のところでは、日本の 15:00 になります。サーバーのタイムゾーンを合わせるか、上の `TZ=Asia/Tokyo` のように渡します。
- ログは標準出力に、1 回の API ごとに 1 行（`api/orders.sql: 6,044 行、381 ms`）と、エラーのくわしい内容を書きます。`--debug` なしでは、ブラウザには「サーバーのログを見てください」としか出ないので、ログはファイルなどに残します（systemd なら `journalctl -u devbi`）。
- タスクや systemd では `npx` ではなく `node_modules/.bin` の中のものを直接指します。`npx` は、`node_modules` にないときに npm から同じ名前のものを聞かずに入れようとするためです。

### 新しくする

```bat
cd C:\reports\sales
git pull
npm ci
npm run build
```

- `devbi-serve` は止めなくてかまいません。サイトのファイルも `api/` の SQL も、聞かれるたびに読みます。`-- snapshot:` の時刻を足したときも、1 時間以内に気づきます。
- ビルドで `dist/snapshots/` が消えても、次に開かれたときに作り直します（そのときだけ、開くのに SQL の時間がかかります）。
- 起動し直すのは、`.env.local` の接続先を変えたときと、DevBI を上げたとき（`@devbi/server` が変わったとき）です。
- ビルドしている間は `dist/` が作り直されるので、そのとき開いていたページは、あとから読む部品（グラフや `explore` など）が 404 になることがあります。利用者の少ない時間にするか、別のフォルダにビルドして `--static` で切り替えます。

## 3. 社内のアプリに埋め込む

ダッシュボードを、今ある社内のアプリ（ASP.NET の WebForms や MVC、ASP.NET Core、Next.js、ほかの React のアプリなど）の画面の中に出します。利用者はいつものアプリにログインして、いつものメニューから開きます。

### 共通の手順

1. `vite.config.ts` を `devbi({ embed: true })` にしてビルドすると、`dist/devbi-embed.js` ができます（`base` は `"./"` のまま）。
2. `dist/` を、アプリが静的ファイルとして配る場所（`/Scripts/devbi/`、`wwwroot/reports/`、`public/devbi/` など）に写します。`snapshots/` は写しません。
3. 画面に 2 行を足します。

   ```html
   <div data-devbi="sales" data-devbi-theme="light"></div>
   <script type="module" src="/Scripts/devbi/devbi-embed.js"></script>
   ```

4. `read_api` を使うなら、アプリに読み取り API を足します。ダッシュボードは、`devbi-embed.js` と同じ場所の `api/`（上の例なら `/Scripts/devbi/api/`）を呼びます。違う場所なら `data-devbi-api` で指します。

くわしくは [ほかのアプリの画面に埋め込む](reference.md#ほかのアプリの画面に埋め込む) にあります（JavaScript からの `mount`、UpdatePanel、CSS の打ち消し、CSP）。

### ASP.NET Core

`dotnet/` の `DevBI.Server` と `DevBI.Server.AspNetCore` をアプリに足し、`app.MapDevBIApi("/reports", api).RequireAuthorization()` で `/reports/api/` に API を出し、`dist/` を `wwwroot/reports/` に置きます（[ASP.NET Core](reference.md#aspnet-core)、見本は `dotnet/samples/DevBI.Sample`）。

- データベースは SQL Server だけで、接続文字列の `Integrated Security=true` で Windows 認証でもつなげます（アプリケーション プールのアカウント。[Windows 認証で SQL Server につなぐ](reference.md#windows-認証で-sql-server-につなぐ)）。
- `.arrows`（スナップショット）と、データに使うなら `.parquet` は、ASP.NET Core が型を知らないので、`FileExtensionContentTypeProvider` に足します（見本の `Program.cs`）。
- ASP.NET Core の静的ファイル（`UseStaticFiles`）は、そのままではログインを確かめずに配ります。`wwwroot/reports/data/` の Excel なども守るときは、Microsoft のドキュメントの「静的ファイルの承認」のとおり、`wwwroot` の外に置いて `UseAuthorization` のあとで配り、`builder.Services.AddAuthorization(o => o.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build())` のように、どこにも決まりのないリクエストにもログインを求めます（これがないと、静的ファイルにはログインがかかりません）。IIS の上で動かし、IIS で匿名認証を無効にしているなら、IIS がすべてのリクエストにログインを求めるので、このままでも守られます。
- `UseStaticFiles` は `Cache-Control` を付けないので、ブラウザは `index.html`・`devbi-embed.js`・`data/` を前のまましばらく使うことがあります。`StaticFileOptions` の `OnPrepareResponse` で、`assets/` の下のほかは `Cache-Control: no-cache` を付けます（`devbi-embed.js` が古いままだと、入れ替えで消えた `assets/` のファイルを読みに行って動かなくなります）。

### WebForms・MVC 5（.NET Framework 4.7.2 以降）

`DevBI.Server` と `DevBI.Server.SystemWeb` を足し、`Global.asax` で API を作って、`web.config` で `Scripts/devbi/api` の下を `DevBIHttpHandler` に渡します。`dist/` は `~/Scripts/devbi/`、`api/*.sql` は IIS が配らない `~/App_Data/devbi/api/` に置きます（[WebForms・MVC 5](reference.md#webformsmvc-5net-framework-472-以降)）。

- IIS の「Windows 認証」をサイトにかけていれば、`dist/` の静的なファイルも同じログインで守られます。フォーム認証のアプリでは、静的なファイルにはフォーム認証がかからないことがあるので、`Scripts/devbi/data/` のファイルをログインせずに開けないかを確かめます。開けるときは、`web.config` で、静的なファイルにも ASP.NET の認証を通し（`<system.webServer><modules runAllManagedModulesForAllRequests="true" />`）、`Scripts/devbi` の下はログインしていない人を断る決まりを足して、もう一度確かめます。

  ```xml
  <location path="Scripts/devbi">
    <system.web>
      <authorization>
        <deny users="?" />
      </authorization>
    </system.web>
  </location>
  ```
- `.wasm` と `.arrows` の型を `web.config` に足します（[1 の web.config](#手順の例windows-の-iis) の `staticContent` と同じ）。

### Next.js

API は `app/devbi/[...path]/route.ts` 1 つで、`@devbi/server` の `createApiHandler` の `fetch` が答えます。`dist/` は `public/devbi/` に写します（[Next.js に置く](reference.md#nextjs-に置く)、見本は `examples/nextjs`）。

- `public/devbi/` のファイルは route を通らずに配られます。`data/` のファイルもログインで守るときは、`proxy.ts` の `matcher` に `/devbi/:path*` を入れます。
- `next start` のサーバーが動き続けるなら、`instrumentation.ts` でスナップショットを毎朝作れます。そうでないときは、`devbi-snapshot --dir <プロジェクト> --out <フォルダ>` をタスクスケジューラや cron で動かし、`lib/devbi.ts` の `snapshotDir` を `<フォルダ>/snapshots` にします（`public/devbi/` には作りません。`next start` は動き始めたあとに `public/` に足したファイルを配らず、`public/` の古いファイルが route より先に配られるため）。
- 行が多いときは、前に置く IIS や nginx で、Arrow（`application/vnd.apache.arrow.stream`）も圧縮させます（`route.ts` の答えは gzip になりません）。

### ほかのアプリ（Java、PHP、Python など）

アプリの言語で API を作らなくても、**2 の `devbi-serve` を同じサーバーで動かし、アプリの Web サーバーから同じオリジンの下に転送する**と、そのまま埋め込めます。

```
https://portal.corp.local/devbi/…  ──（/devbi を外して転送）──▶  devbi-serve（127.0.0.1:8080）
```

```html
<div data-devbi="sales"></div>
<script type="module" src="/devbi/devbi-embed.js"></script>   <!-- API は /devbi/api/ -->
```

アプリに API を足したいときは、[API の形](reference.md#api-の形)（`GET …/api/schema`、`POST …/api/query` で Arrow を返す）のとおりに作ります。

### ログイン・CSRF・オリジン

- `dist/` と API は、ページと同じオリジン（スキーム・ホスト・ポートが同じ）から配るのがかんたんです。アプリの Cookie と Windows 認証が、そのまま API に届きます。
- ほかのオリジンから配るときは、そのサーバーがすべてのファイルに CORS のヘッダーを付ける必要があり、API には Cookie が送られません。
- CSRF のトークンなど、API にヘッダーが要るときは、JavaScript の `mount` の `fetch` で足します（[API とログイン](reference.md#4-api-とログイン)）。

### ASP.NET のアプリでのスナップショット

C# の API（ASP.NET Core、WebForms・MVC 5）はスナップショットを作りません。`-- snapshot:` の SQL を使うときは、[1 のスナップショット](#データを新しくする)と同じく、`devbi-snapshot --dir <プロジェクト> --out <dist を写した場所>`（`wwwroot/reports` や `Scripts/devbi`）をタスクスケジューラで毎朝動かします（サーバーに Node と `@devbi/server` が要ります。SQL Server には SQL Server 認証でつなぎます）。ファイルがなければ、ダッシュボードは API から読みます。Next.js は[上](#nextjs)のとおりです。

## 公開する前のチェックリスト

- [ ] `npm run check`（[devbi-check](reference.md#ファイルを確かめるdevbi-check)）が通る
- [ ] `npm run build` のあと、`npm run preview` か `devbi-serve` で開いて、すべてのダッシュボードが出る
- [ ] Web サーバーから `http(s)://` で開いている（`index.html` を直接開いていない）
- [ ] `.wasm` が `application/wasm` で返る。スナップショットを使うなら `.arrows` も 404 にならない
- [ ] サイト全体（`data/`、`snapshots/`、`api/` を含む）にログインがかかっている。見せてよい人だけが入れる
- [ ] 見せる範囲が違う人たちのダッシュボードを、同じサイトに置いていない
- [ ] データベースのユーザーは SELECT の権限だけ。接続先とパスワードは `.env.local`（git に入れない。サーバーでは読める人をしぼる）
- [ ] `devbi-serve` に `--debug` を付けていない。`--host` は前に置いたサーバーからだけ届くもの（既定の `127.0.0.1`）
- [ ] スナップショットを使うなら、一度作ってあり、毎朝作る仕組み（`devbi-serve` か、タスクスケジューラの `devbi-snapshot`）がある。サーバーの時刻（タイムゾーン）が合っている
- [ ] 社外に出られないネットワークなら、Parquet・JSON のファイルと `current_date` などを使っていない（使うなら拡張のファイルを置いて `extensionRepository`）
- [ ] 開発サーバー（`npm run dev`）を社内に見せていない。GUI エディタからだれでもファイルを書き換えられるため。`npm run preview` も確かめる用で、置き場所ではありません
