# DevBI

開発者がいる会社が自社アプリの中に置く BI。ダッシュボードは git のファイル、タイルは JSX に「昇格」でき、集計はブラウザ内の DuckDB-wasm。MIT。

構想と決定事項は [docs/handoff.md](docs/handoff.md)。§5 の 1（ランタイム）と §5 の 2（埋め込みと読み取り API）ができました。§5 の 3（GUI エディタ）は作っている途中で、いまはタイルの配置（動かす・大きさ・足す・消す）と新しいダッシュボードの作成までできます。

## 動かす

```sh
pnpm install
pnpm example:dev      # packages/* をビルドして、examples/sales を Vite の dev server で開く（http://localhost:5173）
                      # 見出しの右の「編集」で GUI エディタ（タイルをドラッグで並べて dash.json に保存。ビルドには入らない）
pnpm example:preview  # 静的ビルドしたものを開く（http://localhost:4173）
pnpm example:serve    # ビルドして devbi-serve で開く（http://localhost:8080）。DB 版のダッシュボードはサンプルの SQLite を API から読む。
                      # 「売上の日次集計」は、devbi-serve が毎朝 6:00（と起動したとき）に作るスナップショットを読む
                      # /embed-demo.html は、ほかのアプリの画面に script 1 本で埋め込んだ例
pnpm example:nextjs   # 同じダッシュボードを Next.js のアプリに置いた例（http://127.0.0.1:3000）。API は route.ts 1 つ
pnpm try-xlsx <file>  # 自分の Excel から下書きのダッシュボードを作る（ファイルは git に入らない）
pnpm gen              # .devbi/ を作る（dash.json・metrics.yaml の補完と、自作タイルの型。dev server を動かしていれば自動）
pnpm test             # 指標 → SQL のゴールデン、xlsx、書式（DuckDB Node 2.0）、読み取り API（SQLite。DEVBI_TEST_PG・_MSSQL・_MYSQL・_MARIADB・_ORACLE があればそのデータベースも）
pnpm e2e              # パッケージと examples/sales をビルドして devbi-serve で開き、Playwright で確認
```

画面を触って確かめる手順と、期待する結果の一覧は [docs/manual-check.md](docs/manual-check.md)。ファイル形式と API の一覧は [docs/reference.md](docs/reference.md)。

e2e の `@playwright/test` は 1.63.0 に固定しています（Claude Code on the web に入っている Chromium と同じ版）。別のブラウザで動かすときは `E2E_BROWSER_EXECUTABLE` に実行ファイルのパスを渡します。

## リポジトリの中身

| パス | npm 名 | 中身 |
| --- | --- | --- |
| `packages/devbi` | `devbi` | ファイル形式（metrics.yaml / dash.json の検証）、指標 → DuckDB SQL のコンパイラ、xlsx の読み書き（依存なし）、書式、`TileProps` などの型。ブラウザでも Node でも動く |
| `packages/react` | `@devbi/react` | DuckDB-wasm のエンジン、Mosaic の Selection でのクロスフィルタ、組み込みタイル、`<Dashboard>` / `<DevbiApp>`、ほかのページへの埋め込み（`mountDashboard`、`startEmbed`） |
| `packages/vite` | `@devbi/vite` | Vite プラグイン。`virtual:devbi` で dashboards/ と models/ と昇格タイルを渡し、ビルドで data/ をコピー。`embed: true` で埋め込み用の `devbi-embed.js` も作る |
| `packages/editor` | `@devbi/editor` | GUI エディタ。Vite の開発サーバーでだけ動き、react-grid-layout でタイルを並べて、dash.json を手書きと同じ形で保存する（書き込み口は `@devbi/vite`）。ビルドには入らない |
| `packages/server` | `@devbi/server` | 読み取り API（サーバーの `api/*.sql` を読み取り専用で実行し、Arrow で返す。SQLite・PostgreSQL・SQL Server・Oracle・MySQL）、`devbi-serve`（ビルドしたサイトと API を 1 つのプロセスで出し、毎朝のスナップショットを作る）、`devbi-snapshot`（スナップショットをいま作る。タスクスケジューラ用）。DB への接続は ashiato のアダプタの作りを流用 |
| `dotnet/` | （C#） | 読み取り API の ASP.NET の見本（SQL Server）。ASP.NET Core（.NET 10）の `MapDevBIApi` と、WebForms・MVC 5（.NET Framework 4.7.2 以降）の `DevBIHttpHandler`。SQL ファイルの読み方は `packages/server` と同じものをテストで確かめる。NuGet には未公開 |
| `examples/nextjs` | （非公開） | `examples/sales` のダッシュボードを Next.js 16（App Router）のアプリに置いた見本。API とスナップショットは `app/devbi/[...path]/route.ts`（`@devbi/server` の `fetch`）、画面は `devbi-embed.js` |
| `examples/sales` | （非公開） | 売上のサンプル。`data/sales.xlsx` は `pnpm gen:data` で作った架空データ。`db/sales.sqlite` は同じ受注を表に分けて入れたもの（`pnpm gen:db`） |

npm にはまだ公開していません（どのパッケージも `private: true`）。

## プロジェクトの形

```
dashboards/
  sales.dash.json          # タイルの並び
  sales/TopCustomers.tsx   # 昇格したタイル
models/
  sales.metrics.yaml       # 指標と軸
data/
  sales.xlsx               # または .csv / .arrow / .parquet
api/
  orders.sql               # read_api('orders') でデータベースから読む SELECT（サーバーだけが使う）
  sales_daily.sql          # 先頭に -- snapshot: 06:00 と書くと、毎朝作ったファイルから読む
.devbi/                    # pnpm gen が作る JSON Schema と型（git に入れない）
```

dash.json に `"$schema": "../.devbi/dash.schema.json"`、metrics.yaml の 1 行目に `# yaml-language-server: $schema=../.devbi/metrics.schema.json` と書くと、VS Code でタイルの種類や指標の名前が補完されます（YAML は拡張機能「YAML」が要ります）。詳しくは [docs/reference.md](docs/reference.md#エディタでの補完と型pnpm-gen)。

### metrics.yaml

```yaml
label: 売上
model: SELECT * FROM read_xlsx('data/sales.xlsx', sheet = '明細')
time: { column: 受注日, fiscal_year_start: 4 }   # time: 受注日 だけでもよい
dimensions:
  customer: { column: 顧客, label: 顧客 }
  big: { sql: "金額 >= 100000", label: 大口 }    # 式も書ける
measures:
  revenue: { sql: SUM(金額), label: 売上, format: "¥#,##0" }
  orders: COUNT(DISTINCT 受注番号)                # 文字列だけなら sql
  avg_order: { sql: revenue / orders }          # 指標から指標（展開して 1 本の SQL にする）
  revenue_yoy: { of: revenue, compare: previous_year, as: ratio }   # as: value | delta | ratio | change
  revenue_pp: { of: revenue, compare: previous_period, as: delta }
  revenue_fytd: { of: revenue, running: fiscal_year }               # running: true | year | fiscal_year
```

- `model` は DuckDB の SQL。`read_xlsx` / `read_csv` / `read_parquet` / `read_arrow` / `read_json` のパスはプロジェクトからの相対パスで、ブラウザが `data/` から読みます。
- 前年比などの比較は「期間が決まっているとき」だけ値が出ます（時間の粒度でまとめたとき、または期間フィルタがあるとき）。全期間のままだと空（—）です。
- 書式は Excel の書式の一部（`#,##0`、`0.0%`、`"円"`、末尾の `,` で千単位、`正;負;ゼロ`）と、`compact`（1.2億、3,400万）。
- エラーは日本語で、どのファイルのどの項目かを出します。

### dash.json

```json
{ "title": "売上", "metrics": "sales", "tiles": [
  { "id": "monthly", "x": 0, "y": 0, "w": 8, "h": 4, "type": "bar", "title": "月別売上",
    "query": { "measures": ["revenue"], "time": "month" } },
  { "id": "top", "x": 8, "y": 0, "w": 4, "h": 4, "component": "./sales/TopCustomers.tsx" }
] }
```

`query` は `measures`、`dimensions`、`time`（day / week / month / quarter / year / fiscal_year）、`filters`、`sort`（`"-revenue"` で降順）、`limit`。12 列のグリッド、行の高さは既定 80px。

組み込みタイル: `kpi`、`bar`、`line`、`area`、`barlist`、`table`、`pivot`（`options.columns` で列にする軸）、`date-range`（`options.default` で最初の期間）、`select`、`markdown`（`options.text`）。

### 昇格したタイル

```tsx
import { defineQuery, type RowOf, type TileProps } from "devbi";
export const query = defineQuery({ measures: ["revenue"], dimensions: ["customer"], limit: 10 });  // 名前は pnpm gen のあと型で検査
export default function TopCustomers({ rows, format, select, selection }: TileProps<RowOf<typeof query>>) { ... }
```

組み込みタイルと同じ `TileProps` を受け取ります。`select({ field: "customer", in: ["A社"] })` でほかのタイルを絞り込み、`select(null)` で解除。追加の集計が要るときは `useDevbiQuery(query, { tileId })`。

## 調べてわかったこと（2026-11-07）

- DuckDB-wasm は `1.33.1-dev114.0`（中身は DuckDB 2.0.0）。`@uwdata/mosaic-core` 0.35 がこの版を固定しているので合わせています。テストの DuckDB Node（`@duckdb/node-api` 2.0.0-r.1）も 2.0.0 で、同じ SQL が両方で動きます。
- DuckDB-wasm 2.0 は CSV と Arrow IPC（`read_arrow`）は単体で読めますが、Parquet は拡張を extensions.duckdb.org から取りに行きます。社内ネットワークで外に出られない場合は、拡張ファイルを社内に置いて `devbi({ extensionRepository })` で指します。xlsx は DuckDB の excel 拡張を使わず、DevBI が自前で読むので拡張は要りません。
- DuckDB Node 2.0 は逆に Parquet が組み込みで、Arrow の書き出し（`COPY ... (FORMAT arrow)`）は拡張が要ります。スナップショットは DuckDB を使わず、API の答えと同じ Arrow IPC を `@devbi/server` が書くので、どちらの拡張も要りません。

## handoff.md からの変更点

- 指標 → SQL は mosaic-sql ではなく自前の文字列組み立てにしました。モデルと指標の SQL が利用者の書いた生の SQL で、比較指標では期間をずらした集計を結合するため。mosaic-core は選択（クロスフィルタ）の管理に使っています。
- 表タイルは [spreadsheet-grid](https://github.com/ishibashi0112/datasheet-grid)（`@ishibashi0112/spreadsheet-grid` の `/lite`）で、読み取り専用にしています。並べ替えは列メニューから、行のクリックでほかのタイルを絞り込みます。
- ピボットは Perspective を使わず、合計行・合計列つきの自前の表にしました。
- 読み取り API の名前: handoff の `POST /api/query {model, params}` は `{name, params}` にし、サーバーの SQL は `api/<名前>.sql`、metrics.yaml からは `read_api('<名前>')` で呼びます。`model` は metrics.yaml の `model`（DuckDB の SQL）と紛らわしいため。
- 朝のスナップショットは、handoff の Parquet ではなく Arrow IPC（`snapshots/<名前>.arrows`。API の答えと同じ中身）にしました。DuckDB-wasm が Parquet を読むには拡張をインターネットから取りに行くためです。ブラウザはこれを静的ファイルとして GET するので、IIS などにそのまま置けます。時刻は `api/<名前>.sql` の先頭の `-- snapshot: 06:00` に書きます。
- 読み取り API は、`read_api` 1 つにつき 1 回だけ呼び、行をブラウザに渡して DuckDB-wasm で集計します（データベースは絞り込みのたびには呼ばれない）。応答は Arrow IPC（gzip）。SQLite は Node 組み込みの `node:sqlite`（Node 22.16 以上）、PostgreSQL は `pg`、SQL Server は `mssql`、Oracle は `oracledb`（Thin モード）、MySQL / MariaDB は `mysql2`（どれも optional peer）。SQL Server・Oracle・MySQL の接続は ashiato のアダプタ（読み取り専用のトランザクション、行の上限の取り方、Oracle の Thick モード）を流用しています。
