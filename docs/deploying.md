# 社内に公開する

DevBI のダッシュボードを、社内の人がブラウザで見られるようにする方法をまとめたページです。置き方は 3 つあり、どれも同じプロジェクト（`dashboards/`、`models/`、`data/`、`api/`）をビルドしたものを、別の場所に置くだけです。

ファイル形式とコマンドのくわしい一覧は [reference.md](reference.md) にあります。このページは、どれを選ぶかと、置くときの手順・設定・気をつけることを扱います。

> このページのコマンドは、DevBI を npm に公開したあとの形（`npm create devbi@latest`、`npm install -D @devbi/server`）で書いています。公開の前に試すときは、このリポジトリの `examples/sales` で、`pnpm example:build`（`examples/sales/dist/` を作る）と `pnpm example:serve`（`devbi-serve` で開く）が同じものです。

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
| ログイン | Web サーバーの認証（IIS の Windows 認証など） | 前に置いた IIS や nginx の認証 | アプリのログインがそのまま API にもかかる |
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

### ログインと、データが見える範囲

集計はブラウザの中でします。そのため、**ダッシュボードを開ける人は、そのダッシュボードの元の行をすべて受け取っています**。

- `data/` の Excel や CSV、スナップショット（`snapshots/*.arrows`）は、URL を知っていれば直接ダウンロードできます。
- 読み取り API（`api/query`）に届く人は、`api/` の**どの SQL でも**、名前とパラメーターを自分で送って読めます（`api/schema` が一覧を返します）。ダッシュボードに出していない SQL も同じです。
- パラメーター（`read_api('orders', from = '…')` の値）はブラウザが送るので、利用者が書き換えられます。見せてはいけない行を、パラメーターや絞り込みで隠さないでください。
- 人によって見せる行を変える仕組み（行レベルのセキュリティ）は、今の DevBI にはありません。API は、だれが開いても同じ行を返します。

なので、守るのは「サイト（と API）に入れる人」です。

- サイト全体にログインをかけます（IIS の Windows 認証、前に置いた nginx の認証、アプリのログインなど）。`dist/` の中の静的なファイル（`data/`、`snapshots/`）にもかかっているかを確かめます。
- 見せる範囲の違う人たちには、プロジェクト（ダッシュボードとデータと `api/`）を分けて、置き場所ごとにログインと権限を分けます。
- データベースのユーザーは、読ませる表の SELECT の権限だけにします（[接続先](reference.md#接続先)）。

### 社外に出られないネットワーク

DuckDB のエンジン、グラフ、表、`explore` の Perspective、Malloy は、どれも `dist/` に入っていて、社外のサーバーへは取りに行きません。Excel・CSV・スナップショット・読み取り API のダッシュボードは、社外への通信がなくても動きます。

例外は Parquet だけです。DuckDB-wasm は Parquet を読む拡張を `https://extensions.duckdb.org/v2.0.0/wasm_eh/parquet.duckdb_extension.wasm` から取りに行くので、外に出られないとタイルに「Extension Autoloading Error … could not be fetched from …」と出ます。どちらかにします。

- データを Excel か CSV にする（DevBI は xlsx を自分で読むので、拡張は要りません）。
- 拡張のファイルを社内に置く。外に出られるコンピューターで上の URL のファイルを取り、社内の Web サーバーの `<場所>/v2.0.0/wasm_eh/parquet.duckdb_extension.wasm` に置いて、`vite.config.ts` で `devbi({ extensionRepository: "https://reports.corp.local/duckdb-ext" })` のように `<場所>` を URL で指します。`v2.0.0` は DevBI が使っている DuckDB の版なので、DevBI を上げたときに変わることがあります（取りに行く URL は、タイルのエラーにそのまま出ます）。

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

3. **ログインをかける。** IIS マネージャーでそのフォルダ（かサイト）の「認証」を開き、「Windows 認証」を有効、「匿名認証」を無効にします（「Windows 認証」は、IIS の役割サービスの「Windows 認証」を入れると出ます）。見せる人をしぼるときは、フォルダの NTFS のアクセス権か、「承認規則」で決めます。

4. **開いて確かめる。** `http://reports.corp.local/sales/` を開き、[置いたあとに確かめる](#置いたあとに確かめる)を見ます。URL は最後の `/` まで書きます（IIS はフォルダの URL に `/` がないと付けて開き直します）。

- `.wasm` の圧縮: IIS の静的圧縮は、そのままでは `application/wasm` を圧縮しません。サーバーの「構成エディター」で `system.webServer/httpCompression` の `staticTypes` に `application/wasm` を足します（サイトの `web.config` には書けない設定です）。
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

- `mime.types` に `application/wasm  wasm;` がなければ足します。`.arrows` は型を知らなくても読めます（`application/octet-stream` で届けば足ります）。
- 写すときは `rsync -a --delete --exclude snapshots/ dist/ /srv/www/reports/sales/` のように、スナップショットを消さないようにします。
- Apache や、ほかの Web サーバーでも同じです。要るのは、`.wasm` を `application/wasm` で返すことと、`assets/` 以外を長くキャッシュさせないことです。

### データを新しくする

**Excel や CSV を差し替える。** データのファイルは同じ名前で `dist/data/` に入っていて、ビルドの中には入っていません。シートの名前と列が同じなら、サイトの `data/sales.xlsx` を新しいものに置き換えるだけで、ビルドし直さずに新しい数字になります（期間の「最新」も、データの最終日から決まります）。

- 共有フォルダの Excel を毎朝写すなら、タスクスケジューラで `robocopy \\fileserver\営業\集計 C:\inetpub\wwwroot\sales\data 売上明細.xlsx` のように動かします（`models/` の `read_xlsx('data/売上明細.xlsx', …)` と同じ名前で）。
- `data/` を「開くたびに確かめる」設定（上の `web.config` の `DisableCache`、nginx の `no-cache`）にしておきます。Web サーバーが `Cache-Control` を送らないと、ブラウザは前のファイルをしばらく使い続けることがあります。
- プロジェクトの `data/` のファイルも同じものにしておきます。次にビルドして写すと、プロジェクトの `data/` のファイルに戻るためです。

**データベースを、毎朝のスナップショットで読む。** Web サーバーは静的なままで、データベースの数字を出せます。

1. `api/<名前>.sql` の先頭に `-- snapshot: 06:00` と書き、`models/` で `read_api('<名前>', …)` から読みます（[毎朝のスナップショット](reference.md#毎朝のスナップショット)）。
2. サイトを置くサーバー（か、データベースとサイトのフォルダの両方に届くサーバー）に、Node 22.16 以上と、プロジェクトのフォルダ（`api/`、`models/`、`.env.local`、`npm install -D @devbi/server` とドライバー）を置きます。接続先は `.env.local` の `DEVBI_DB=mssql://…` などです（[接続先](reference.md#接続先)）。
3. 毎朝、タスクスケジューラ（Linux なら cron）で動かします。

   ```bat
   npx devbi-snapshot --dir C:\reports\sales --out C:\inetpub\wwwroot\sales
   ```

   タスクスケジューラでは、「プログラム」に `C:\Program Files\nodejs\npx.cmd`、「引数」に `devbi-snapshot --dir … --out …`、「開始」にプロジェクトのフォルダ（`C:\reports\sales`）を書き、「ユーザーがログオンしているかどうかにかかわらず実行する」にします。時刻は `-- snapshot:` に書いた時刻に合わせます（画面に「毎日 6:00 に更新」と出るのは、`-- snapshot:` の時刻です）。

- 作れなかったものがあると終了コードが 1 になり、前のファイルが残ります。タスクスケジューラの「前回の実行結果」で分かります。
- まだ一度も作っていないと、タイルに「スナップショット（snapshots/…）がありません。サーバーで devbi-snapshot を実行するか…」と出ます。ビルドして写したあとに、一度手で動かします。
- `devbi-snapshot` は SQL Server の Windows 認証でつなげません。SELECT の権限だけの SQL Server 認証のユーザーを使います。

**毎朝ビルドし直して置く。** データを取るスクリプトとビルドを、CI（社内のネットワークの中で動く GitHub Actions のセルフホストランナー、Azure Pipelines のエージェントなど）で毎朝動かし、`dist/` を写します。ライブデモの [`.github/workflows/demo.yml`](../.github/workflows/demo.yml) がこの形です（毎朝 npm と GitHub から数字を取り、`devbi-check` で確かめてからビルドして、GitHub Pages に置く）。ビルドの前に `devbi-check` を通すと、データの形が変わったときに、壊れたダッシュボードを出さずに止まります。

### GitHub Pages

リポジトリの Settings → Pages で Source を「GitHub Actions」にし、`dist/` を `actions/upload-pages-artifact` と `actions/deploy-pages` で出します（[demo.yml](../.github/workflows/demo.yml)）。`https://<ユーザー>.github.io/<リポジトリ>/` の下に出るので、`base: "./"` のままにします。

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

```bat
git clone https://…/reports.git C:\reports\sales
cd C:\reports\sales
npm install
REM @devbi/server と、データベースのドライバー（SQL Server は mssql、Oracle は oracledb、MySQL は mysql2、PostgreSQL は pg）
npm install -D @devbi/server mssql
npm run build
REM http://127.0.0.1:8080/ で開く（このコンピューターからだけ）
npx devbi-serve --dir . --port 8080
```

- Node は 22.16 以上です。
- `.env.local` には、データベースのパスワードが入ります。サービスを動かすアカウントと管理者だけが読めるように、ファイルのアクセス権をしぼります。
- データベースのユーザーは SELECT の権限だけにします。`devbi-serve` も SELECT か WITH で始まる文しか通さず、読み取り専用のトランザクションで実行しますが、いちばん確かな守りはデータベースの権限です。
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

- **ホスト名**: `devbi-serve` は、IP アドレスと `localhost` のほかの名前で来たリクエストを断ります（DNS リバインディングの対策）。前のサーバーが利用者の開いた名前（`reports.corp.local`）を Host のまま渡すときは、`--allowed-hosts reports.corp.local` を付けて起動します。ブラウザに「この名前 (reports.corp.local) では開けません。devbi-serve を --allowed-hosts reports.corp.local を付けて起動してください」と出たら、その名前を足します。
- **待ち時間**: 前のサーバーの待ち時間の上限は、`devbi-serve` の `--timeout`（既定 60 秒）より長くします（nginx の `proxy_read_timeout` は既定 60 秒、IIS は ARR の「Server Proxy Settings」の「Time-out」）。短いと、重い SQL が終わる前に 502 や 504 になります。
- **圧縮**: API の答えは `devbi-serve` が gzip にします。サイトのファイルは圧縮しないので、`.wasm`（約 34 MB）などは前のサーバーで圧縮させます。
- **ログイン**: IIS ならそのサイトで「Windows 認証」を有効、「匿名認証」を無効にします。ログインは前のサーバーだけで決まり、`devbi-serve` は利用者がだれかを知りません（だれが開いても同じ行を返します。[ログインと、データが見える範囲](#ログインとデータが見える範囲)）。
- 前にサーバーを置かず、部署の中のネットワークでログインなしに出すなら、`--host 0.0.0.0` で直接待ち受けることもできます（Windows ファイアウォールでそのポートを開けます）。名前で開くなら、その名前を `--allowed-hosts` に書きます。

### 動かし続ける

`devbi-serve` はふつうのコマンドなので、サーバーが起動したときに動き出し、止まったら動かし直すようにします。

- **Windows**: タスクスケジューラで、トリガーを「スタートアップ時」、「プログラム」を `C:\Program Files\nodejs\npx.cmd`、「引数」を `devbi-serve --dir C:\reports\sales --port 8080 --allowed-hosts reports.corp.local`、「開始」を `C:\reports\sales` にします。「ユーザーがログオンしているかどうかにかかわらず実行する」にし、「設定」タブの「タスクを停止するまでの時間」のチェックを外します（既定では、動き始めて 3 日たつと止められるため）。Windows のサービスにしたいときは、NSSM や WinSW などのツールで包みます。
- **Linux**: systemd のユニットの例です。

  ```ini
  # /etc/systemd/system/devbi.service
  [Unit]
  Description=DevBI reports
  After=network.target

  [Service]
  User=devbi
  WorkingDirectory=/srv/reports/sales
  ExecStart=/usr/bin/npx devbi-serve --dir /srv/reports/sales --port 8080 --allowed-hosts reports.corp.local
  Environment=TZ=Asia/Tokyo
  Restart=always

  [Install]
  WantedBy=multi-user.target
  ```

- **時刻**: `-- snapshot: 06:00` は、`devbi-serve` が動いているコンピューターの時計の時刻です。クラウドのサーバーなど、時計が UTC のところでは、日本の 15:00 になります。サーバーのタイムゾーンを合わせるか、上の `TZ=Asia/Tokyo` のように渡します。
- ログは標準出力に、1 回の API ごとに 1 行（`api/orders.sql: 6,044 行、381 ms`）と、エラーのくわしい内容を書きます。

### 新しくする

```bat
cd C:\reports\sales
git pull
npm install
npm run build
```

- `devbi-serve` は止めなくてかまいません。サイトのファイルも `api/` の SQL も、聞かれるたびに読みます。`-- snapshot:` の時刻を足したときも、1 時間以内に気づきます。
- ビルドで `dist/snapshots/` が消えても、次に開かれたときに作り直します（そのときだけ、開くのに SQL の時間がかかります）。
- 起動し直すのは、`.env.local` の接続先を変えたときと、DevBI を上げたとき（`npm install` で `@devbi/server` が変わったとき）です。

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
- ASP.NET Core の静的ファイル（`UseStaticFiles`）は、そのままではログインを確かめずに配ります。`wwwroot/reports/data/` の Excel なども守るときは、Microsoft のドキュメントの「静的ファイルの承認」のとおり、`wwwroot` の外に置いて、`UseAuthorization` のあとで配るようにします。

### WebForms・MVC 5（.NET Framework 4.7.2 以降）

`DevBI.Server` と `DevBI.Server.SystemWeb` を足し、`Global.asax` で API を作って、`web.config` で `Scripts/devbi/api` の下を `DevBIHttpHandler` に渡します。`dist/` は `~/Scripts/devbi/`、`api/*.sql` は IIS が配らない `~/App_Data/devbi/api/` に置きます（[WebForms・MVC 5](reference.md#webformsmvc-5net-framework-472-以降)）。

- IIS の「Windows 認証」をサイトにかけていれば、`dist/` の静的なファイルも同じログインで守られます。フォーム認証のアプリでは、`Scripts/devbi/data/` のファイルをログインせずに開けないかを確かめます。
- `.wasm` と `.arrows` の型を `web.config` に足します（[1 の web.config](#手順の例windows-の-iis) の `staticContent` と同じ）。

### Next.js

API は `app/devbi/[...path]/route.ts` 1 つで、`@devbi/server` の `createApiHandler` の `fetch` が答えます。`dist/` は `public/devbi/` に写します（[Next.js に置く](reference.md#nextjs-に置く)、見本は `examples/nextjs`）。

- `public/devbi/` のファイルは route を通らずに配られます。`data/` のファイルもログインで守るときは、`proxy.ts` の `matcher` に `/devbi/:path*` を入れます。
- `next start` のサーバーが動き続けるなら、`instrumentation.ts` でスナップショットを毎朝作れます。サーバーレスなど、動き続けるサーバーがない置き方では、`devbi-snapshot` を別に毎朝動かします。
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

### スナップショット

C# の API はスナップショットを作りません。`-- snapshot:` の SQL を使うときは、[1 のスナップショット](#データを新しくする)と同じく、`devbi-snapshot --dir <プロジェクト> --out <dist を写した場所>` をタスクスケジューラで毎朝動かします（サーバーに Node と `@devbi/server` が要ります。SQL Server には SQL Server 認証でつなぎます）。ファイルがなければ、ダッシュボードは API から読みます。

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
- [ ] 社外に出られないネットワークなら、Parquet を使っていない（使うなら `extensionRepository`）
- [ ] 開発サーバー（`npm run dev`）を社内に見せていない。GUI エディタからだれでもファイルを書き換えられるため。`npm run preview` も確かめる用で、置き場所ではありません
