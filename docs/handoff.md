# DevBI（開発者向け MIT BI）引き継ぎ

作成: 2026-11-07（プロジェクト「作るもの探し」、スレッド「Power BIを超えるOSS BIを構想する」）
名前は **DevBI** に決定（2026-11-07）。npm `devbi` は空き、GitHub に同名リポジトリ 2 件（★0）、ユーザー名 `devbi` は取得済みなのでリポジトリは `ishibashi0112/devbi`。製品名としての先客は無し（Web 検索）。表記は DevBI / パッケージは `devbi`（または `@ishibashi0112/devbi`）。

参照:
- 構想メモ（Claude Doc）: https://claude.ai/artifact/XoRgLccXMWqhz1nZQYLBRr
- UI プレビュー（4 画面、サンプル数値）: https://claude.ai/artifact/1U358moC3SjXdveAYWjLQz

## 1. 何を作るか（一文）

開発者がいる会社が自社アプリの中に置く BI。ダッシュボードは git のファイル、GUI は開発時だけ、タイルはどれでも JSX に「昇格」できる、集計はブラウザ内の DuckDB-wasm、配り方は静的サイトか自社アプリへの埋め込みで閲覧者課金ゼロ。MIT。

Power BI を丸ごと置き換えない。配布力（M365 E5 同梱）、Fabric、Copilot、全社ガバナンス、セマンティックモデル + DAX の全機能、Power Query 相当の ETL GUI、認証・行レベル権限・定期更新（ホストに任せる）、帳票（ページ切り・印刷レイアウト）、PDF のメール配信は範囲外。

注意: Power BI は 2026-09 に developer mode（PBIP / PBIR / TMDL）が一般提供になり「git で扱えない」弱点は縮んだ。差別化は「React 部品として自社アプリに入る」「タイルを JSX で書ける」「エンジンがブラウザ内」に置く。

## 2. 利用者の決定事項（2026-11-07）

- 最初に置き換える画面は **A: 自分が Excel で作っている定期の集計** を、xlsx を置くだけで見られる静的ダッシュボードにする。次に B: 自社アプリの集計画面へ React 部品として埋め込む。C: 自作 OSS の npm / GitHub 統計は README のライブデモ用。
- 会社のサーバーにはまだ置けない。開発と動作確認は Claude がクラウド環境でサンプルデータ（SQLite / PostgreSQL）相手に全部行う。会社の実データ・実 Excel は渡せないので、形（列名、行数、更新頻度）だけ聞いてサンプルで作る。
- UI の細部はこれから詰める（まず先に進める）。
- 既存 DB への繋ぎ込みは必須要件。読み取り専用の薄い API 経由（下記）。Report Server / SSRS 風の「サーバーを立ててレポートを並べる」使い方もできる形にする（`serve` コマンド）。
- 新しい技術を使いたい。VB / VB.NET は書かない。

## 3. ファイル形式（製品の正体）

```
dashboards/
  sales.dash.json          # レイアウトとタイルの並び（GUI が書く。人も書ける）
  sales/
    TopCustomers.tsx       # 昇格したタイル（開発者 / AI が書く）
models/
  sales.metrics.yaml       # 指標と軸の定義（人と AI が書く）
data/
  sales-2026.parquet       # または xlsx / csv
```

### 3.1 指標 YAML（Rill の metrics_view 型。自前 TS で SQL に変換）

```yaml
model: SELECT * FROM read_parquet('data/sales-2026.parquet')
time: order_date
dimensions:
  customer: { column: customer_name, label: 顧客 }
  region:   { column: region,        label: 地域 }
measures:
  total_revenue: { sql: SUM(amount),             label: 売上, format: "¥#,##0" }
  orders:        { sql: COUNT(DISTINCT order_id), label: 受注件数 }
  avg_order:     { sql: total_revenue / orders,   label: 平均単価 }   # 指標から指標
  revenue_yoy:   { of: total_revenue, compare: previous_year, as: ratio }  # 時間比較は語彙で
```

- 1 つの metrics_view = 1 つのモデル SQL。複数ファクト表はモデル SQL で結合して 1 表にする（スタースキーマ + DAX のコンテキスト遷移は対象外と割り切る）。
- 前年比・累計は `compare` / `running` の語彙で持ち、式は書かせない。語彙に無いものはモデル SQL か `sql:` タイル。
- Malloy（MIT）は後から `malloy:` タイルとして足せる逃げ道。Cube は使わない（サーバー必須）。

### 3.2 dash.json のタイル

```json
{ "id": "top-customers", "x": 8, "y": 2, "w": 4, "h": 4,
  "type": "barlist",
  "query": { "measures": ["total_revenue"], "dimensions": ["customer"], "limit": 10 } }
```
昇格後:
```json
{ "id": "top-customers", "x": 8, "y": 2, "w": 4, "h": 4,
  "component": "./sales/TopCustomers.tsx" }
```

### 3.3 タイルの契約（組み込みも昇格後も同じ）

```tsx
import type { TileProps } from "devbi";
export const query = { measures: ["total_revenue"], dimensions: ["customer"], limit: 10 };
export default function TopCustomers({ rows, selection, select, format }: TileProps) { ... }
```
- タイルは SQL を書かない。「どの指標をどの軸で」を宣言し、ランタイムが SQL を組む。
- `selection` / `select` は Mosaic の選択（クロスフィルタ）。
- 昇格は一方通行。GUI は位置と大きさだけ引き続き動かせ、中身はコードでしか変えない。

### 3.4 組み込みタイル（v0）

数字（KPI）、棒 / 線 / 帯、表（spreadsheet-grid）、ピボット（Perspective、後回し可）、フィルタ入力（期間、選択）、Markdown。

## 4. 技術セット（決定）

| 層 | 選ぶもの | 理由 |
| --- | --- | --- |
| 土台 | TypeScript, pnpm モノレポ, Vite, tsup, Vitest, Playwright | ashiato と同じ。CI も流用 |
| パッケージ | core / react / editor / vite / server / cli / create | 埋め込み先が要るものだけ入れられる |
| UI | React 19。React 部品 + tsup の IIFE で script 1 本の島 | タイルが JSX。島は ashiato の client.global.js と同じ作り。WebForms のページにも VB を書かずに置ける |
| エンジン | DuckDB-wasm 2.0 + Apache Arrow JS | 受け渡しは全部 Arrow。4 GB 上限、既定シングルスレッド。wasm は遅延読み込みとキャッシュ |
| クロスフィルタ / SQL 組み立て | @uwdata/mosaic-core, mosaic-sql（BSD） | vgplot は使わない。React と合わなければ自前の小さな coordinator |
| グラフ / 表 / ピボット | Observable Plot（ISC）/ spreadsheet-grid（自作）/ Perspective（後で） | |
| エディタ | react-grid-layout（MIT）+ 自前のプロパティパネル | Puck は縦積みページ向けで 12 列グリッドに合わない。止まっていれば dnd-kit で自作 |
| 設定 | yaml, zod | |
| サーバー | Node 22, node:http（依存なし）, ドライバは optional peer + loadDriver, 応答は Arrow IPC | ashiato の方式そのまま。SQL Server / Oracle / PostgreSQL / MySQL / SQLite |
| 読み取り API | GET /api/schema, POST /api/query {model, params} | SQL はサーバー側のファイル。ブラウザから SQL は渡さない。SELECT 権限だけのユーザー。ブラウザから DB への直接接続はしない。API は (1) 同梱の `devbi serve`（Node）、(2) 既存アプリの API（ASP.NET WebMethod / Web API）に同じ形で 2 本足す（C# のリファレンス実装を用意。マスタ一括更新ツールと同じ「形だけ決めて言語は問わない」方針）、(3) API なしでスナップショット Parquet を静的配信、のどれでもよい |
| snapshot | DuckDB Node 版で COPY ... TO parquet。タスクスケジューラから実行 | |
| xlsx | 依存なしの自前（ashiato の書き出しの逆）。無理なら exceljs（MIT） | DuckDB の excel 拡張が wasm で動くかは未確認 |
| AI 向け | tazuna 形式の手順書 + 依存なし stdio MCP（list_metrics / preview_query / validate_dashboard） | チャットが書いたファイルを自分で検証できる |
| テスト | 指標→SQL は DuckDB Node 版でゴールデン、UI は Playwright、API は SQLite / PostgreSQL | 全部クラウドの開発環境で回る |

VS Code 拡張機能は v0 では作らない。代わりに `dash.json` / `metrics.yaml` の JSON Schema を同梱（VS Code 標準の補完と検証）、`metrics.yaml` から指標名の d.ts を `pnpm gen` で生成して TSX の補完に効かせる。プレビューはブラウザ（Vite HMR）。エディタとブラウザをまたぐ連携（ホバーで集計例、タイルのハイライト）が欲しくなったら拡張機能を検討。

GUI エディタは Vite プラグインとして開発時だけ動き、ブラウザから dev server 経由で JSON をディスクに書く（ashiato の Vite プラグインと同じ仕組み）。本番ビルドにはエディタが入らない。

## 5. v0 の範囲と順序

1. ランタイム（チャットだけで作れる最小）: dash.json と metrics.yaml を読む、DuckDB-wasm に Parquet / CSV / xlsx を載せる、指標 YAML → SQL、組み込みタイル 6 種、Mosaic の選択でクロスフィルタ、JSX タイルの読み込み。出口は Vite の静的ビルド。完了の目安: 自分の Excel 集計をこれで置き換えて 2 週間使い続けられる。GUI エディタは v0 に入れない（ファイル形式とタイルの契約が固まってから）。
2. 埋め込みと読み取り API: React 部品と script 1 本の島。ashiato のアダプタで読み取り専用 API。`serve`（静的 + API + snapshot を 1 プロセス）。完了の目安: 社内の利用者が Excel 出力の代わりにその画面を使う。
3. GUI エディタ: react-grid-layout でタイル配置と指標・軸の選択。Vite プラグインとして JSON をディスクに書く。昇格ボタン。完了の目安: 新しいダッシュボードをコードを書かずに 10 分で作れ、git の差分が読める。
4. 広げる: AI 向け手順書、xlsx / PDF 書き出し（ashiato の証跡出力を流用）、時間比較の語彙、Perspective、`malloy:` タイル、候補 C のライブデモ。

## 6. 既存 OSS の地図（2026-11-07、再調査不要）

「GUI で大枠 + タイル JSX + git ファイル + ブラウザ内エンジン + 埋め込み」を揃えた BI は無い。最も近いのは Bruin DaC（AGPL、YAML / TSX、セマンティック層あり、Go サーバー必須、GUI と埋め込み無し、★801）。他: Evidence（MIT、Svelte）、Observable Framework（ISC、JSX、静的）、Rill（Apache-2.0、metrics_view YAML）、Lightdash（MIT + ee）、Metabase / Superset / Grafana、yamchart（YAML + SQL、新しく小さい）、Malloy + Composer（MIT、Composer はデモ扱い、wasm モードあり）、Mosaic / vgplot（BSD）、Perspective（OpenJS incubating 2025-10）、Puck（MIT）。

## 7. 流用できる自作コード

- ashiato: `src/vite`（dev server 経由でディスクに書くプラグイン）、`src/client`（tsup の IIFE バンドル）、`src/adapters` + `loadDriver` + `readOnlyProblem`（読み取り専用の DB アクセス）、`src/export`（依存なし xlsx 書き出し、headless Chrome で PDF）、`src/agent`（依存なし stdio MCP）、`docs/security-review.ja.md`（IT 部門向けレビュー文書の型）。
- tazuna: `src/pack/assets/procedure.ts`（チャット向け手順書の型）。
- spreadsheet-grid: 表タイル。
- ashiato は「全部ローカル、127.0.0.1 に bind、SELECT のみ」が約束なので、社内に置く読み取り API は ashiato の外に作る。アダプタを共有するなら ashiato 側で切り出す。

## 8. 未決事項

- 候補 A の Excel を一つ決める（何の集計か、列、行数、更新頻度、渡す相手）。
- 候補 B の画面を一つ決める（今の作り、誰が毎日見るか）。
- リポジトリ `ishibashi0112/devbi` を作る（利用者）。npm のスコープ有無を決める。
- 未確認: DuckDB の excel 拡張が wasm で読めるか / mosaic-core を vgplot 抜きで React から使う形 / react-grid-layout の保守状況 / Perspective のライセンス（Apache-2.0 のはず）とバンドルサイズ / Bruin DaC を一度動かして差を言葉にする。
- JSX タイルはビルド時バンドル前提（実行時 eval しない）。AI が書いたタイルをすぐ見るには dev server が要る。

## 9. 開発環境のメモ

- Claude Code on the web では Chromium のダウンロード不可。Playwright は `E2E_BROWSER_EXECUTABLE=/opt/pw-browsers/chromium`（webview2-bridge と同じ）か、ashiato のやり方で同梱 Chromium を使う。
- DB は SQLite をローカル、PostgreSQL / SQL Server は CI のサービスコンテナ（ashiato の CI を参照）。

## 10. 開発から利用者が見るまでの流れ（2026-11-07 に利用者へ説明した内容）

### 共通: 開発（どのパターンでも同じ）
1. `pnpm create devbi my-reports` で雛形（Vite + React + DevBI、git 管理）。
2. データを決める。`data/` に xlsx / CSV / Parquet を置くか、`models/*.metrics.yaml` の model に API の名前を書く。
3. `models/*.metrics.yaml` に指標と軸を書く（チャットに書かせてもよい）。
4. `pnpm dev` → ブラウザに GUI エディタ。組み込みタイルをグリッドに置き、指標と軸を選ぶ。保存で `dashboards/*.dash.json` に書かれる。
5. 足りない表示は「コードにする」で TSX 生成、または `dashboards/<name>/*.tsx` を VS Code / Claude Code で書く。HMR で即反映。
6. git にコミットしてレビュー。
7. `pnpm build` → `dist/`（HTML、JS、dash.json、metrics.yaml、data/）。ここまでが成果物。

### パターン 1: 静的サイト（候補 A）
`dist/` を IIS / GitHub Pages にコピー。データは `dist/data/*.parquet`（手で置換か朝のタスク）。利用者はブラウザで開き、静的ファイルと Parquet を fetch、DuckDB-wasm がブラウザ内で集計。サーバーは計算しない。権限は IIS Windows 認証 + フォルダ ACL。日次更新で足りる集計、自分用、小さな部署向け。

### パターン 2: 自社アプリに埋め込む（候補 B）
`dist/` の JS を既存アプリに同梱し、`<Dashboard src="sales.dash.json" />`（React）か `<div data-devbi="sales">` + script 1 本（WebForms 等）を画面に置く。既存アプリの API に `schema` と `query {model, params}` の 2 本を足す（ASP.NET なら WebMethod / Web API。C# のリファレンス実装を用意）。利用者はいつものアプリにログインして集計メニューを開く。権限はアプリのログインとロール。閲覧者が多い、開くたびに最新が要る画面向け。

### パターン 3: Report Server 風（`devbi serve`）
社内サーバーで `devbi serve --dir ./reports` を 1 プロセス（Windows サービス可）。中身は `dist/` の配信 + 読み取り専用 API + 朝のスナップショット。接続情報はサーバーの設定ファイル、DB ユーザーは SELECT のみ。レポートを増やす = リポジトリに dash.json を足して `git pull`。利用者はポータルからレポートを選ぶ。データは API（最新）かスナップショット（日次）をレポートごとに選ぶ。権限は IIS をリバースプロキシにして Windows 認証 + ACL。複数部署に配る、SSRS の置き換え、既存アプリに手を入れたくない場合向け。

3 パターンは排他ではなく、同じリポジトリの同じファイルを別の置き場所に出すだけ。A はパターン 1 から始め、社内に出すときに 2 か 3 を足す。
