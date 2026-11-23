# 設計: 利用者ごとに見える行を変える（行レベル制御）

- 状態: **作っています**。2026-11-23 に設計。下の [作る順番](#10-作る順番pr-の分け方) で PR に分けて作り、決まった形を [reference.md](../reference.md#利用者ごとに見える行を変える行レベル制御) と [deploying.md](../deploying.md) に書きます。1（サーバーの中心）を作りました。11 章の決めることは、この設計書の勧めのとおりにしています。
- このフォルダ（`docs/design/`）のファイルは、ドキュメントのサイトのページになりません。
- 関係する設計: [SQL のデータセットを表に繋ぐ（SSRS 風）](sql-datasets.md)（別のスレッドで設計中）。

## 1. 何をするか

ホストのアプリ（ASP.NET、Next.js、IIS の前に置いた `devbi-serve` など）がログインを確かめ、だれが見ているか（利用者）を DevBI の API に渡します。DevBI は `api/*.sql` の中の `:user.region` のような名前に利用者の値を入れて SQL を実行し、**その人に見せてよい行だけ**をブラウザに返します。

```sql
-- api/orders.sql。受注の明細。利用者の地域の行だけ。
SELECT o.order_date AS 受注日, c.name AS 顧客, c.region AS 地域, l.qty * l.unit_price AS 金額
  FROM orders o
  JOIN order_lines l ON l.order_no = o.order_no
  JOIN customers c ON c.id = o.customer_id
 WHERE o.order_date >= :from
   AND c.region = :user.region
```

- **ログインの仕組み（SSO）は DevBI では作りません。** Windows 認証、Entra ID・Okta・Google などの OpenID Connect、SAML は、ホストのアプリか前に置いたサーバーがします。DevBI は、ログインが済んだ人の情報を受け取るだけです。
- `metrics.yaml` と `dash.json` の書き方は変わりません。今あるダッシュボードは、そのまま人ごとに違う行で動きます。

[handoff.md](../handoff.md) の「範囲外」の「認証・行レベル権限（ホストに任せる）」のうち、認証は範囲外のままです。行レベル制御は、ホストが渡した利用者で SQL を絞る口だけを DevBI に足します。

## 2. 前提: 守れるのはサーバーだけ

DevBI は、集計をブラウザの中の DuckDB-wasm でします。ダッシュボードを開いた人のブラウザには、**`read_api` が受け取った行がすべて届いています**（[ログインと、データが見える範囲](../deploying.md#ログインとデータが見える範囲)）。そのため、次のものは見せる行を決める守りになりません。

| ブラウザの中にあるもの | 守りにならない理由 |
| --- | --- |
| `metrics.yaml` の `model` の `WHERE`、`row_filter` のような項目 | `metrics.yaml` の SQL はブラウザの DuckDB-wasm が実行する。絞る前の行がすでにブラウザにある |
| `dash.json` の `filters`、期間、クロスフィルタ | 同じ。開発者ツールから、読み込んだ表をそのまま SQL で読める |
| `read_api('orders', region = '関東')` のパラメーター | ブラウザが送る値なので、`POST api/query` を自分で送れば変えられる |
| Malloy・SQL・探索のタイル、自作タイル（JSX）、Excel・PDF への書き出し | どれもブラウザにある行から作る（ブラウザにない行は出ないので、こちらは心配ない） |

「`metrics.yaml` に `row_filter: region = {{user.region}}` を書き、サーバーで SQL に差し込む」形も考えましたが、`metrics.yaml` の SQL はサーバーを通らないので、この形にはしません。**絞り込みは、サーバーが実行する `api/*.sql` の中に書きます。** サーバーから出ていかない行は、ブラウザでどうやっても見えません。

同じ理由で、`data/` に置いた Excel・CSV と、スナップショットのファイル（`snapshots/*.arrows`）は、行レベル制御の外です（[8.4](#84-静的なデータdata)、[8.3](#83-スナップショット)）。

## 3. 範囲

v1 で作るもの:

- 利用者（`id`、`roles`、`attrs`）を API に渡す口（Node、Next.js、ASP.NET、`devbi-serve`）
- `api/*.sql` の `:user.<属性>`、`-- roles:`、`-- access: all`
- 絞り忘れを止める決まり（[6.4 行レベルのモード](#64-行レベルのモード絞り忘れを止める)）と、`devbi-check` の検査
- 利用者の属性と役割をデータベースの表から引く `access/user.sql`
- 開発サーバーで「この人として見る」

v1 で作らないもの（あとで考える）:

- 人ごとのスナップショット（[8.3](#83-スナップショット)）
- 複数の値を持つ属性（`IN (:user.regions)`）。v1 は権限の表を JOIN する書き方で足ります（[6.5](#65-よくある書き方)）
- データベースの行レベルセキュリティ（SQL Server のセキュリティ ポリシー、PostgreSQL の RLS）に利用者を渡す口
- ほかのオリジンのページに、署名したトークンで埋め込む形（Metabase の signed embedding のようなもの）
- 列ごとの制御（役割によって列を隠す）。v1 は、列の違うデータセットを分けて `-- roles:` をかけます

## 4. 全体の形

```
ブラウザ ──（Cookie・Windows 認証・SSO のセッション）──▶ ホスト（ASP.NET / Next.js / IIS・nginx + devbi-serve）
                                                          │ ログインを確かめる（DevBI はしない）
                                                          │ 利用者 { id, roles, attrs } を作る
                                                          ▼
                                                    DevBI の API（api/query、api/schema …）
                                                          │ 1. ログインしているか（行レベルのモードなら必須）
                                                          │ 2. この SQL を読んでよい役割か（-- roles:）
                                                          │ 3. :user.id、:user.region を利用者の値で埋める
                                                          │    （文字をつなげず、データベースのパラメーターで渡す）
                                                          ▼
                                                    データベース ── その人の行だけ ──▶ Arrow ──▶ ブラウザの DuckDB-wasm
```

ブラウザ側（`@devbi/react`、`devbi-embed.js`）は、エラーの出し方のほかは変わりません。API に送るものも、今と同じ名前とパラメーターだけです。

## 5. 利用者の形

```ts
interface DevBIUser {
  /** 利用者を表す変わらない ID。SQL では :user.id（Windows 認証なら CORP\yamada、OpenID Connect なら oid や sub） */
  id: string;
  /** 役割。-- roles: の行と比べる（Windows のグループ名、アプリのロール名など） */
  roles?: string[];
  /** 属性（1 つの値）。SQL では :user.<名前>。値は文字・数値・真偽 */
  attrs?: Record<string, string | number | boolean>;
}
```

- `id` は、前後の空白を除いて空でない文字です。空なら、ログインしていない人として扱います（`401`）。
- `id` には、**あとから変わらない、ほかの人が名乗れない値**を使います。メールアドレスは、Entra ID などで本人が変えられたり、確かめられていなかったりすることがあるので、勧めません。Entra ID なら `oid`、ほかの OpenID Connect なら `sub`（発行元ごと）、Windows 認証ならアカウント名です。
- 属性の名前は、パラメーターと同じ決まり（文字・数字・`_`、先頭は数字以外、日本語も可）で、大文字と小文字を区別しません。`id` は属性の名前に使えません。
- 値が `null`、空の文字、空白だけの文字の属性は、ないものとして扱います（[6.1](#61-user属性)）。Oracle は空の文字を `NULL` として扱うので、空の文字を通すと `NULL` を入れたのと同じになるためです。
- 属性は 1 つの値だけです。Windows や Entra ID の**グループは属性ではなく役割**として渡し、`-- roles:` で使います。地域が複数ある、のような値は、権限の表で書きます（[6.5](#65-よくある書き方)）。`',' || :user.regions || ',' LIKE …` のように文字でつないだ一覧を属性にするのは、`%` や `_` を含む値や空の一覧で壊れるのでやめます。
- C# では `DevBIUser { Id, IsInRole, Attributes }` です。Windows 認証のグループは数が多く、全部を並べると遅いので、役割は一覧ではなく `IsInRole(名前)` で確かめます（ASP.NET の `ClaimsPrincipal.IsInRole` をそのまま渡せます）。

属性と役割のもとは 2 つあり、どちらか、または両方を使います。

1. **ホストが渡す**: OpenID Connect のクレームや、アプリのセッションにある値。
2. **データベースの表から引く**: `access/user.sql`（[7.5](#75-利用者の属性と役割を表から引くaccessusersql)）。ホストが `id` だけを渡すとき（`devbi-serve` など）に使います。

両方あるときは、項目ごとに次のように決めます。

| 項目 | 決め方 |
| --- | --- |
| `id` | ホストが渡したものだけ。`access/user.sql` は変えない |
| 役割 | ホストの役割（C# は `IsInRole`）と、`access/user.sql` の `roles` の、どちらかにあれば持っている |
| 属性 | `access/user.sql` の値に、ホストが渡した値を上書きする。ホストが同じ名前で `null` や空を渡したら、その属性はない（表の値も使わない。安全側に倒す） |

## 6. `api/*.sql` の書き方

### 6.1 `:user.<属性>`

```sql
 WHERE c.region = :user.region
   AND o.sales_rep = :user.id
```

- `:user.id` は利用者の ID、`:user.<名前>` は属性です。ふつうのパラメーター（`:from`）と同じく、データベースのパラメーター（`$1`、`@p1`、`:p1`、`?`）にして渡します。SQL の文字に値をつなげることはないので、属性に `'` が入っていても SQL は変わりません。
- 値は**サーバーだけが入れます**。SQL を実行する関数（Node の `bindParameters`、C# の `Dataset.Bind`）は、ブラウザから来たパラメーターと利用者を**別々に**受け取り、`:user.` の値は利用者からだけ取ります。そのうえで、ブラウザから名前が `user.` で始まるパラメーターが来たら、`400` で断ります。名前が `user` そのもののパラメーターも、行レベルのモードでは断ります（モードでないプロジェクトでは、下のとおり今までどおりのパラメーター）。`user_id` や `username` のような名前は、今までどおり使えます。名前の比べ方は、先頭の `user` を ASCII の範囲だけで小文字にそろえて比べます（Node と C# で、Unicode の大文字と小文字の変え方が少し違うため）。どの口（`api/query`、[SQL のデータセット](sql-datasets.md) の `api/rows` など、ホストが呼ぶ `run`）でも、この関数を通るので、確かめ忘れが起きません。
- ログインしていない人には `401`、その属性がない人には `403`（「利用者 CORP\yamada に属性 region がありません」）を返し、SQL は実行しません。`NULL` や空の文字を入れて実行することはしません。`(:user.region IS NULL OR c.region = :user.region)` のような書き方で、属性のない人に全部の行が出てしまうのを防ぐためです。
- 行レベルのモード（[6.4](#64-行レベルのモード絞り忘れを止める)）では、`:user`（点なし）をエラーにします（`:user.id` の書き間違いのことが多いので）。モードでないプロジェクトでは、今あるプロジェクトを壊さないよう、今までどおりのパラメーターです。`:user_id` のような名前は、どちらでもふつうのパラメーター（ブラウザが値を変えられる）なので、`devbi-check` が注意を出します（[8.6](#86-devbi-check)）。
- `api/schema` の `params` には、`user.` のものを出しません（ブラウザが値を渡すものではないので）。

今の SQL の読み方（`parameters()`）は `:user.region` を `:user` と `.region` に分けて読むので、点を含む名前を読めるようにします。C# の `SqlText.Parameters` も同じに直し、両方の結果が同じことをパリティのテスト（`sqlserver-cases.json`）で確かめます。

### 6.2 `-- roles:`

```sql
-- 給与の明細。経理と管理者だけ。
-- roles: 経理, CORP\Managers
-- access: all
SELECT …
```

- 書いた役割のどれかを持つ人だけが、この SQL を読めます。ほかの人には `403` を返し、`api/schema` の一覧にも出しません。
- 区切りは `,`（`、` も可）です。Windows のグループは `CORP\Managers` のように書きます。
- Node では、名前が完全に一致したときだけ通します。Windows のグループのように大文字と小文字を区別しない名前は、ホストがそろえて渡すか、C# の `IsInRole` を使います。
- `-- connection:`、`-- snapshot:` と同じく、ファイルの先頭の `--` のコメントに書きます。説明（`description`）には入れません。

書き間違いで、守ったつもりの決まりが黙って効かなくなるのを防ぐため、次はすべてエラーにして実行しません。

- 先頭のコメントの、`role:`、`roles`（`:` なし）、`acess:` のような、決まった言葉に近い書き間違い
- 中身のない `-- roles:`
- SELECT より後ろや、`/* … */` の中にある `roles:` と `access:` の行

**古いサーバーに気をつけます。** `-- roles:` と `-- access:` を知らない古いサーバー（アプリにコピーしたままの C#、古い `devbi-serve`）は、この行をただのコメントとして読み、だれにでも読ませます。`:user.` を使う SQL は、古いサーバーでは「パラメーター :user の値がありません」で止まる（安全側）のと違うところです。そこで:

- 新しいサーバーは `api/schema` に `"access": 1` を出し、`devbi-check --url <置いた場所>` で、置いた先のサーバーが行レベル制御を知っているかを確かめられるようにします。
- C# のファイルをコピーして使っているアプリには、コピーを新しくするよう reference に書きます。
- 特に見せたくない SQL は、役割の確かめを SQL にも書いておくと、古いサーバーでも止まります（`AND EXISTS (SELECT 1 FROM devbi_user_roles r WHERE r.login = :user.id AND r.role = '経理')`）。

### 6.3 `-- access: all`

```sql
-- 商品のマスタ。ログインした人は全員、全部の行を見てよい。
-- access: all
SELECT code AS 商品コード, name AS 商品名, category AS 分類 FROM products
```

- 「この SQL は人で絞らない（ログインした人には全部の行を返す）」と、わざと決めたしるしです。役割で絞るときは `-- roles:` と一緒に書きます。
- `-- access:` に書けるのは `all` だけです。ほかの値はエラーです。
- `-- access: all` と `:user.` を同じファイルに書くと、どちらのつもりかわからないので、エラーにします。

### 6.4 行レベルのモード（絞り忘れを止める）

いちばん起こりやすい事故は、「あとから足した `api/*.sql` で絞り忘れる」ことです。そこで、プロジェクトを**行レベルのモード**にすると、次の決まりにします。

1. **すべての** `api/*.sql` は、`:user.` を使うか `-- access: all` を書きます。どちらもないファイルは実行せず、「api/x.sql は、だれにどの行を見せるかが書いてありません。`:user.…` で絞るか、`-- access: all` を書いてください」と返します（`400`）。`devbi-check` と `pnpm build` も同じことを確かめて止めます。
2. **すべての**リクエスト（`api/schema`、`api/query`、`devbi-serve` の `snapshots/`）に、ログインが要ります。利用者がなければ `401` です。ホストが利用者を渡し忘れても、行が出ていくことはありません。ホストが自分で呼ぶ `run()` も、利用者がなければ同じく断ります。

行レベルのモードになるのは、次のどれかのときです。

- **ホストの設定で決めたとき**（勧める形）: Node の `createApiHandler({ requireUser: true })`、C# の `DevBIOptions.RequireUser = true`、`devbi-serve --require-user`（`--user-header` を付けたときも）。ファイルを消したり書き間違えたりしても、モードは外れません。本番では必ずこちらも設定します。
- **プロジェクトのファイルが行レベル制御を使っているとき**: `api/*.sql` のどれかの文字に `:user.`、`-- roles`、`-- access` があるか、`access/` フォルダがあるとき。SQL として読んだ結果ではなく、ただの文字の検索で決めます（引用符の中の `:user.` でもモードにする）。データベースの種類によって引用符の読み方が違い、`devbi-check`・Node・C# で読み方がずれることがあるので、ずれても「モードにする」側に倒れるようにするためです。

ホストが利用者を渡しているのに、どちらの条件にも当たらないときは、サーバーのログに 1 回だけ注意を書きます（「利用者を受け取っていますが、行レベルのモードになっていません」）。

**この決まりで止められるのは「書き忘れ」だけです。** `SELECT :user.id AS 見ている人, …` のように、`:user.` を使っていても絞っていない SQL は止められません。SQL のレビューのほかに、`devbi-check` で 2 人以上の開発用の利用者を比べ、`:user.` を使う SQL が全員に同じ行を返していたら注意を出します（[8.6](#86-devbi-check)）。

### 6.5 よくある書き方

担当の地域が 1 つ:

```sql
 WHERE c.region = :user.region
```

担当の地域が複数（権限の表を作って JOIN する。v1 ではこれを勧めます）:

```sql
 WHERE c.region IN (SELECT r.region FROM devbi_user_regions r WHERE r.login = :user.id)
```

管理者は全部（全部を見てよい人も、SQL に書いて決めます）:

```sql
 WHERE c.region IN (SELECT r.region FROM devbi_user_regions r WHERE r.login = :user.id)
    OR EXISTS (SELECT 1 FROM devbi_admins a WHERE a.login = :user.id)
```

自分の担当の受注だけ:

```sql
 WHERE o.sales_rep = :user.id
```

集計だけ見せて、明細は見せない:

```sql
-- 地域ごとの月の売上（明細はブラウザに送らない）。
-- access: all
SELECT DATE_TRUNC('month', o.order_date) AS 月, c.region AS 地域, SUM(l.qty * l.unit_price) AS 金額
  FROM … GROUP BY DATE_TRUNC('month', o.order_date), c.region
```

ブラウザに届いた行は、探索のタイルや開発者ツールでそのまま見えるので、「集計は見せるが明細は見せない」は、サーバーの SQL で `GROUP BY` して明細を送らないことでしか守れません。

権限の表と比べる列（`login` など）は、大文字と小文字・全角と半角・アクセントを区別しない照合順序（SQL Server の `Japanese_CI_AS`、MySQL の `utf8mb4_0900_ai_ci` など）だと、`ｙａｍａｄａ` や `yamadá` が `yamada` と一致します。利用者が自分で名前を決められる ID（メールアドレスなど）を使うときは、区別する照合順序の列にするか、変わらない ID（`oid`、Windows のアカウント）を使います。

## 7. ホストごとの渡し方

### 7.1 Node（`@devbi/server`）

`handle` と `fetch` に、そのリクエストの利用者を渡します。

```ts
const api = createApiHandler({ dir, requireUser: true });

// node:http や Express
await api.handle(req, res, { user: { id: req.user.id, roles: req.user.roles, attrs: { region: req.user.region } } });

// Web 標準の Request（Next.js の route.ts など）
const response = await api.fetch(request, { user });

// SQL を 1 つ実行する（テストや自分のジョブ）
await api.run("orders", { from: "2024-04-01" }, { user });
```

- `user` を渡さない（`undefined` か `null`）のは、ログインしていない人です。
- 新しく足す口（[SQL のデータセット](sql-datasets.md) の `api/rows` など）も、同じ `run` の入口を通るので、同じ確かめがかかります。あちらの包み方（絞り込み・ページ・集計）は、`run(name, params, { user, wrap })` のように、同じ 3 つめの引数に並べます（あとから作る側が合わせる）。

### 7.2 Next.js

```ts
// app/devbi/[...path]/route.ts
import { auth } from "@/auth"; // Auth.js など、アプリのログイン
import { devbi } from "@/lib/devbi";

async function answer(request: Request) {
  // （今の route.ts の、ホスト名の確かめはそのまま）
  const session = await auth();
  // id は変わらない ID（OpenID Connect の sub など）。メールアドレスは勧めない
  const user = session?.user?.id ? { id: session.user.id, roles: session.user.roles, attrs: { region: session.user.region } } : null;
  return (await devbi.fetch(request, { user })) ?? Response.json({ error: "見つかりません" }, { status: 404 });
}
export { answer as GET, answer as HEAD, answer as POST };
```

`public/devbi/` のファイルは `route.ts` を通らずに配られるので、`data/` をログインで守るには、今と同じく `proxy.ts` の `matcher` に入れます（[Next.js](../deploying.md#nextjs)）。

### 7.3 ASP.NET（C#）

```csharp
var api = new DevBIApi(new DevBIOptions { Directory = ..., Connect = ..., RequireUser = true });

// ASP.NET Core。ログインした人（HttpContext.User）を、そのまま利用者にする
app.MapDevBIApi("/reports", api, user: context => new DevBIUser
{
    Id = context.User.FindFirst("http://schemas.microsoft.com/identity/claims/objectidentifier")?.Value, // Entra ID の oid
    IsInRole = context.User.IsInRole,
    Attributes = { ["region"] = context.User.FindFirst("region")?.Value },
}).RequireAuthorization();
```

- `user` を書かなければ、`MapDevBIApi` は `HttpContext.User` から `Id = User.Identity.Name`、`IsInRole = User.IsInRole` を作って渡します。Windows 認証なら `CORP\yamada` と AD のグループです。OpenID Connect では、`Identity.Name` にどのクレームが入るかがアプリの設定（`NameClaimType`）で変わるので、上のように `user` で ID のクレームを決めます。
- `DevBI.Server`（API の本体）は Web の仕組みに依存しない（netstandard2.0）ので、`HttpContext` から利用者を作るのは `MapDevBIApi` と `DevBIHttpHandler` の役目です。本体は `ApiRequest.User` を受け取るだけです。
- WebForms・MVC 5 の `DevBIHttpHandler` も、`HttpContext.Current.User` から同じように作ります（作り方を変えるときは、`DevBIHttpHandler` を継承して `UserOf(HttpContext)` を書き換える）。

**IIS の Windows 認証で、人ごとに行を変えたいなら、この C# の形を勧めます。** ログインした人を、何も足さずにそのまま受け取れるからです（次の 7.4 のとおり、`devbi-serve` に Windows のユーザー名を渡すには、IIS に一手間が要ります）。

### 7.4 `devbi-serve`（前に置いたサーバーから受け取る）

`devbi-serve` はログインの仕組みを持たないので、前に置いた IIS・nginx・oauth2-proxy などが確かめたユーザー名を、ヘッダーで受け取ります。

```sh
npx devbi-serve --dir . --user-header X-DevBI-User
```

| オプション | 中身 |
| --- | --- |
| `--user-header <名前>` | ユーザー名を入れるヘッダー。書かなければ、ヘッダーからは受け取らない。書くと `--require-user` も付く |
| `--trusted-proxy <IP,…>` | このヘッダーを信じる、前のサーバーの IP アドレス。既定は `127.0.0.1` と `::1`（同じコンピューターの IIS・nginx） |
| `--proxy-secret-file <ファイル>` | 前のサーバーが `X-DevBI-Proxy-Secret` ヘッダーに入れる合言葉。あれば、合言葉が合うリクエストのヘッダーだけを信じる |
| `--user-lowercase` | 受け取ったユーザー名を小文字にそろえる（`CORP\Yamada` と `corp\yamada` を同じ人にする） |
| `--user-cache <秒>` | `access/user.sql` の結果を覚えておく時間。既定は 60 秒 |
| `--require-user` | 行レベルのモードにする（[6.4](#64-行レベルのモード絞り忘れを止める)） |

- 信じるかどうかは、**つながってきた相手の IP アドレス**だけで決めます（`X-Forwarded-For` は見ません。`::ffff:127.0.0.1` は `127.0.0.1` として扱います）。ほかの IP アドレスからつながったリクエストのヘッダーは使わず、ログインしていない人として扱って、ログに書きます。社内の別のパソコンから `devbi-serve` に直接つないで、ヘッダーで別の人になりすますことを防ぐためです。
- `127.0.0.1` を信じると、**そのコンピューターで動くほかのプログラムや、リモート デスクトップでログインした人も信じる**ことになります。サーバーをほかの用途と分けられないときは、`--proxy-secret-file` で合言葉を足します（合言葉のファイルは、サービスのアカウントと管理者だけが読めるようにする）。
- 同じヘッダーが 2 つあるリクエストは `400` で断ります（今の作りは、2 つの値を `a, b` とつないで読むため）。値が空や空白だけなら、ログインしていない人です（`401`）。
- 役割と属性は、`access/user.sql` から引きます（[7.5](#75-利用者の属性と役割を表から引くaccessusersql)）。
- **前のサーバーは、ブラウザから来た同じ名前のヘッダーを、必ず消すか上書きします。** そうしないと、利用者が自分でヘッダーを付けて、ほかの人になれます。

nginx と oauth2-proxy（Entra ID・Okta・Google・Keycloak などの OpenID Connect）の例:

```nginx
location /reports/ {
    auth_request /oauth2/auth;
    auth_request_set $devbi_user $upstream_http_x_auth_request_user;
    proxy_set_header X-DevBI-User $devbi_user;   # ブラウザから来た X-DevBI-User は、ここで上書きされる
    proxy_pass http://127.0.0.1:8080/;
}
# /oauth2/ の location と oauth2-proxy の設定（--set-xauthrequest など）は別に書く
```

`X-Auth-Request-User` にどのクレームが入るかは、oauth2-proxy の設定で決まります。メールアドレスではなく、変わらない ID が入るようにします。

IIS（URL Rewrite + ARR）で Windows 認証のユーザー名を渡すとき:

- URL Rewrite の規則で `{LOGON_USER}` や `{AUTH_USER}` をヘッダーに入れても、**空になる**という報告が複数あります。規則が認証より前に動くためと説明されています（[Stack Overflow](https://stackoverflow.com/questions/24032014/forwarding-ntlm-credentials-from-iis-with-arr-and-url-rewrite)、[Microsoft のブログ（2018）](https://learn.microsoft.com/en-us/archive/blogs/surajdixit/custom-module-for-arr-reverse-proxy-to-pass-the-logged-in-user-to-back-end-servers)）。Microsoft のブログは、認証のあと（`PostAuthenticateRequest`）にヘッダーを入れる小さなモジュールで解いています。
- そこで、`DevBI.Server.SystemWeb` に、ログインした人の名前を `X-DevBI-User` に入れる（ログインしていなければ消す）モジュールを足す案にします。あわせて、URL Rewrite の規則で、ブラウザから来た `X-DevBI-User` を最初に空にします（モジュールを外してしまったときに、ブラウザの値がそのまま届かないように）。空のヘッダーは、上のとおり `401` になります。
- **これはまだ IIS で確かめていません**（クラウドの環境には IIS がありません）。作るときに、利用者の IIS で確かめるか、確かめられなければ「IIS の Windows 認証で人ごとに行を変えるなら C# の形」とだけ書きます。

### 7.5 利用者の属性と役割を表から引く（`access/user.sql`）

```sql
-- 利用者の属性。:user.id はログイン名（CORP\yamada）。
-- connection: hr
SELECT u.region AS region, u.dept AS dept, u.roles AS roles
  FROM devbi_users u
 WHERE u.login = :user.id
```

- プロジェクトの `access/user.sql` に置きます。`api/` の外なので、ブラウザから名前で呼ばれることはありません（今の DevBI や、古い C# のコピーでも）。
- 結果が 1 行なら、列が属性になります（列名は大文字と小文字を区別しない）。`roles` という列は、`,` で区切って役割にします。
- 0 行なら、表には属性も役割もない人です（ホストが渡した役割と属性だけになる。[5](#5-利用者の形) の表）。2 行以上ならエラー（`500`）にします。どちらの行の人か決められないからです。
- `api/*.sql` と同じ決まり（SELECT か WITH の文 1 つ、読み取り専用、`-- connection:`）で実行します。
- 結果は `--user-cache` の秒数だけ覚えます。表で役割を外しても、その時間は前の役割のままです。
- ユーザー名の大文字と小文字は、SQL ごとに `LOWER()` を書くのではなく、受け取るところで 1 回そろえます（`devbi-serve --user-lowercase`、Node と C# はホストが `id` をそろえて渡す）。
- 開発サーバーは `access/` をブラウザに配りません（今の `api/**/*.sql` と同じく `server.fs.deny` に入れます）。`pnpm build` も `dist/` に入れません。

### 7.6 開発サーバー（この人として見る）

```ts
// vite.config.ts
devbi({
  devUsers: {
    yamada: { roles: ["営業"], attrs: { region: "関東" } },
    suzuki: { roles: ["営業"], attrs: { region: "関西" } },
    admin: { roles: ["管理"] },
  },
});
```

- `devUsers` があると、開発サーバー（`vite`）の画面の上に「表示する利用者: （ログインなし）▾」が出ます。選ぶと、その人として API が答えます（Power BI の「ロールとして表示」と同じ使い方）。最初は「（ログインなし）」で、選ぶまでタイルには「ログインしていません（上の『表示する利用者』で選びます）」と出ます。
- 選んだ人は Cookie（`devbi-dev-user`）で開発サーバーに伝えます。この Cookie は、**開発サーバーを動かしているパソコンからのリクエストでだけ**使います（GUI エディタの書き込みと同じ確かめ方）。`vite --host` でほかのパソコンから開いた人が、Cookie を自分で付けて `admin` になり、`.env` の本物のデータベースを読むことを防ぐためです。
- `vite preview`、ビルドしたサイト、`devbi-serve`、C# は、この Cookie を読みません（`vite preview` はビルドしたものを出すので、選ぶ画面も入りません）。
- `attrs` を書かない人は、`access/user.sql` で引きます（開発用のデータベースに表があれば）。
- `devbi-check --as yamada` と `devbi-inspect --as yamada` で、その人として確かめられます（タイルの行数と値）。

## 8. 今ある仕組みへの影響

### 8.1 API の形

- `GET api/schema`: 行レベルのモードでは、ログインが要ります。その人が読める SQL だけを並べ、`params` から `user.` を除きます。`"user": { "id": "CORP\\yamada" }` を足します（画面に「CORP\yamada さんに見える範囲」と出すため。役割と属性は返しません）。
- `api/schema` に `"access": 1` を足します。行レベル制御を知っているサーバーかどうかを、`devbi-check --url` やテストが見分けられるようにするためです（[6.2](#62----roles)）。
- `POST api/query`: 送るものは今と同じです。状態コードに `401`（ログインしていない）と `403`（役割がない、属性がない）が増えます。メッセージは今と同じく日本語の `{ "error": … }` で、ブラウザはタイルに出します。
- 答えのヘッダーは今と同じ `Cache-Control: no-store` です（人によって中身が違うので、共有のキャッシュにも、ブラウザのキャッシュにも残さない）。
- ログの 1 行に、利用者を足します（`CORP\yamada api/orders.sql: 1,234 行、85 ms`）。だれが何を読んだかの記録になります。

### 8.2 埋め込み（`devbi-embed.js`、`@devbi/react`）

- 変えるものはありません。同じオリジンなら、アプリの Cookie や Windows 認証がそのまま API に届き、ホストがそこから利用者を作ります。
- ほかのオリジンの API には Cookie が送られないので（今と同じ）、行レベル制御は同じオリジンの API でだけ使えます。ほかのオリジンのページに埋め込む形は、署名したトークンの形としてあとで考えます。
- **ページを読み込み直さずに利用者が変わるアプリ**（SPA でログアウトして別の人でログイン）では、ページの中の DuckDB-wasm に、前の人の表が残ります。ログアウトしたらページを読み込み直すよう、[埋め込み](../reference.md#ほかのアプリの画面に埋め込む)に書きます。読み込み直せないアプリ向けに、エンジンを閉じて表を捨てる `DevBI.reset()` を足します。

### 8.3 スナップショット

スナップショットは、だれが読んでも同じファイル（`snapshots/<名前>.arrows`）で、IIS などから静的なファイルとして配れます。人ごとに中身を変えられないので、v1 では次のようにします。

| `api/*.sql` | `-- snapshot:` |
| --- | --- |
| `:user.` を使う | 書けない（読み込みのエラー、`devbi-check` もエラー） |
| `-- roles:` がある | 書けない（静的なファイルでは役割を確かめられない） |
| `-- access: all` だけ | 書ける。ファイルはサイトのログインで守る（今の `data/` と同じ） |

- スナップショットを作るジョブ（`devbi-snapshot`、`devbi-serve` の決まった時刻のもの）は、DevBI の中だけの「ジョブ」として実行します。ジョブで実行できるのは `-- access: all` の SQL だけで、外から呼べる `run()` や HTTP からは、この形で実行できません。
- `devbi-serve` は、まだないスナップショットを、ブラウザに聞かれたときにその場で作ります。行レベルのモードでは、**作る前に**ログインを確かめます（ログインしていない人のリクエストで作ることはしない）。開発サーバーは聞かれるたびに SQL を実行するので、`api/query` と同じ確かめをします。
- **`devbi-serve` の静的なファイルとして `snapshots/` を配らない。** 今の `devbi-serve` は、パスの最後が `/snapshots/<ファイル>.arrows` のときだけ API が答え、それ以外は `dist/` の静的なファイルとして配ります。`/snapshots//x.arrows`、`/snapshots/x.arrows/`、`/snapshots/x%2Earrows` のような書き方は API に当たらず、`dist/snapshots/` のファイルがそのまま配られます。行レベルのモードでは、静的なファイルの側で、パスを読み直したあとの場所が `snapshots/` の下なら配らないようにします。
- **古いファイルを残さない。** 今は、作らなくなったスナップショットのファイルを消す仕組みがありません。`orders.sql` から `-- snapshot:` を消して `:user.region` を足しても、前に作った全員分の `orders.arrows` が `snapshots/` に残り、前のビルドのダッシュボードや、そのフォルダを配る IIS からは読めてしまいます。`devbi-serve` と `devbi-snapshot` は、今のジョブが作らないファイルを `snapshots/` から消し、`devbi-check` は残っているファイルをエラーにします。IIS に写すときは、今と同じく `robocopy /MIR`（写し先にしかないファイルを消す）を使います。

人ごとのスナップショット（あとで）は、次の形を考えています。メモとして残します。

- 属性の値の組（地域が関東、関西…）ごとにファイルを作り、`dist/` の外（静的に配られない場所）に置く。値の組は、全員の属性を返す `access/users.sql` から作る。
- ブラウザは今と同じ `snapshots/<名前>~<16 桁>.arrows` を聞き、サーバーがその人の値の組のファイルを返す（ブラウザは変えない）。`devbi-serve` と Node の handler だけが配れ、IIS の静的なファイルでは配れない。
- 答えは `Cache-Control: private, no-cache` にする。`private` がないと、社内のプロキシのキャッシュが、同じ URL のほかの人のファイルを返すことがある。
- `ETag` に値の組を入れる。毎朝 6:00 に全部のファイルを作ると更新時刻（`Last-Modified`）がほとんど同じになり、共用のパソコンで別の人が開いたときに、`If-Modified-Since` だけでは `304` が返って、前の人のファイルがブラウザのキャッシュから出てしまうため。

### 8.4 静的なデータ（`data/`）

`data/` の Excel・CSV・Parquet・Arrow は、URL を知っていればだれでもダウンロードでき、全員に同じ行が届きます。行レベルのモードで、`metrics.yaml` の `model` が `data/` のファイルや `https://` の URL を読んでいると、`devbi-check` が注意を出します（「data/x.xlsx は全員に同じ行が届きます。マスタなら問題ありません」）。人ごとに変えたいデータは、データベースに入れて `api/*.sql` から読みます。

### 8.5 タイル、書き出し、エディタ

- Malloy・SQL・探索・ピボットのタイル、自作タイル（JSX）、Excel・PDF への書き出しは、ブラウザにある行から作るので、そのままで人ごとの行になります。
- GUI エディタは開発サーバーだけのものなので、[7.6](#76-開発サーバーこの人として見る) の「この人として見る」で確かめます。

### 8.6 `devbi-check`

足す検査:

- 行レベルのモードで、`:user.` も `-- access: all` もない `api/*.sql`（エラー）
- `-- roles:` と `-- access:` の書き間違い、中身のない `-- roles:`、先頭のコメントの外にある `roles:` と `access:`、`-- access: all` と `:user.` の組み合わせ、行レベルのモードでの `:user`（点なし）（エラー）
- `:user.` か `-- roles:` と、`-- snapshot:` の組み合わせ（エラー）。`snapshots/` に残った、今は作らないファイル（エラー）
- 行レベルのモードで、`user_id`、`login`、`user` のような、利用者の値のつもりに見えるふつうのパラメーター（注意。ブラウザが値を変えられる）
- 行レベルのモードで、`data/` や URL を読む `model`（注意）
- `--as <devUsers の名前>` で、その人としてタイルを確かめる。`--as` がなければ、`devUsers` の全員で順に確かめ、`:user.` を使う SQL が全員に同じ行を返したら注意を出す。`devUsers` もなければ、ファイルの検査だけをして、データは読まない（「行レベルのモードです。データも確かめるには devUsers を書くか --as を付けます」）
- `--url <置いた場所>` で、置いた先のサーバーの `api/schema` に `"access": 1` があるかを確かめる

### 8.7 SQL のデータセットを表に繋ぐ（SSRS 風）との関係

別のスレッドで、`api/*.sql` を表（spreadsheet-grid）に直接繋ぎ、絞り込み・並べ替え・ページ送りをサーバーでする仕組みを設計しています（[sql-datasets.md](sql-datasets.md)）。この仕組みでは、サーバーがデータセットの SQL を `SELECT * FROM (<データセットの SQL>) d WHERE <表の絞り込み> …` と包みます。

行レベルの絞り込みはデータセットの SQL の中（`:user.`）にあるので、包みの内側に入ります。新しい口（`api/rows`、`api/values`、`api/aggregate`）も同じ `run` の入口と束縛の関数を通るので、ログイン・役割・属性の確かめが同じようにかかり、候補の一覧（`DISTINCT`）にも見えない行の値は出ません。ブラウザから `user.` の名前のパラメーターを送れないことも、同じ関数の中で確かめます（あちらのスレッドと合わせ済み）。

## 9. 落とし穴と対策（まとめ）

| 落とし穴 | 対策 |
| --- | --- |
| ブラウザ側（`metrics.yaml`、`dash.json`、パラメーター）で絞って安心する | 絞り込みは `api/*.sql` だけに書く。設計書と reference にはっきり書く |
| ブラウザが `user.region` のパラメーターを送ってほかの人になる | 束縛の関数が、`:user.` の値を利用者からだけ取る。そのうえで `user.` で始まる名前（行レベルのモードでは `user` そのものも）は `400` |
| 属性のない人に `NULL` や空の文字が入り、`IS NULL OR …` で全部の行が出る（Oracle は空の文字も `NULL`） | 属性が `null`・空・空白だけなら `403` で実行しない。ID が空なら `401` |
| あとから足した SQL で絞り忘れる | 行レベルのモードでは、`:user.` か `-- access: all` がない SQL を実行しない。`devbi-check` とビルドでも止める |
| ファイルを消したり読み間違えたりして、行レベルのモードが外れる | 本番はホストの設定（`requireUser`）でモードにする。ファイルからは文字の検索で決め、迷ったらモードにする |
| `:user.` を使っているが、絞っていない | レビュー。`devbi-check` が開発用の利用者を比べて、全員に同じ行なら注意 |
| `-- roles:` の書き間違いで、黙ってだれにでも読ませる | 近い書き間違い・空の一覧・置き場所の違いをエラーにする |
| 古いサーバー（アプリにコピーした C#）が `-- roles:` を知らずに読ませる | `"access": 1` と `devbi-check --url`。コピーを新しくするよう reference に書く。特に見せたくない SQL は役割の確かめを SQL にも書く |
| 属性の値に `'` が入って SQL が変わる（SQL インジェクション） | 値はいつもデータベースのパラメーターで渡す。`' OR 1=1 --` の値で 0 行になるテストを置く |
| ホストが利用者を渡し忘れる | 行レベルのモードでは、利用者がなければ全部 `401` |
| メールアドレスなど、本人が変えられる値を ID にして、ほかの人の行が見える | 変わらない ID（`oid`、`sub`、Windows のアカウント）を使うよう reference に書く |
| 照合順序が大文字・全角・アクセントを区別せず、似た名前の人の行が見える | ID は受け取るところで 1 回そろえる。権限の表の列は区別する照合順序にするか、変わらない ID にする |
| `devbi-serve` のヘッダーをなりすます | つながってきた相手の IP だけで信じる（`X-Forwarded-For` は見ない）。同じヘッダー 2 つは `400`。必要なら合言葉。前のサーバーはブラウザの同じヘッダーを消すか上書きする。IIS は先に空にする規則も置く |
| 同じコンピューターのほかのプログラムが、ヘッダーを付けて `devbi-serve` を呼ぶ | `--proxy-secret-file` の合言葉。サーバーをほかの用途と分ける |
| `devbi-serve` が、パスの書き方によって `snapshots/` を静的なファイルとして配る | 行レベルのモードでは、読み直したあとの場所が `snapshots/` の下なら静的には配らない |
| 作らなくなった全員分のスナップショットが残る | 今のジョブが作らないファイルを消す。`devbi-check` で残りをエラーにする |
| 社内のプロキシやブラウザのキャッシュが、ほかの人の答えを返す | API は `no-store`。人ごとのスナップショット（あとで）は `private` と、値の組を入れた `ETag` |
| 開発サーバーの「この人として見る」で、ほかのパソコンから `admin` になる | Cookie は開発サーバーを動かしているパソコンからのリクエストでだけ使う。最初は「ログインなし」 |
| 「集計だけ見せたい」のに明細が届く | サーバーの SQL で `GROUP BY` する（[6.5](#65-よくある書き方)）。少ない人数の集計から個人がわかる問題は、DevBI では防がない |
| `data/` とスナップショットが行レベル制御の外にある | サイト全体のログイン。`devbi-check` の注意。v1 は人で絞る SQL のスナップショットを作らない |
| SPA で利用者が変わっても、前の人の表がページに残る | ログアウトで読み込み直す。`DevBI.reset()` |
| データベースのエラーに、ほかの人の値が入って返る | 今と同じく、エラーの中身はログだけ（`--debug` / `exposeErrors` は本番で使わない） |

いちばん確かな守りは、今と同じくデータベースの権限です（DevBI のユーザーは SELECT だけ）。あとで、データベースの行レベルセキュリティ（SQL Server の `SESSION_CONTEXT` とセキュリティ ポリシー、PostgreSQL の `set_config` と RLS）に利用者を渡す口を足せば、DevBI の SQL を書き間違えても、データベースが行を止めるようにできます。

## 10. 作る順番（PR の分け方）

1. **サーバーの中心（Node）**: 利用者の形、`:user.` の読み方と束縛（ブラウザのパラメーターと利用者を分けて受け取る）、`-- roles:`、`-- access: all` と書き間違いのエラー、行レベルのモード（`requireUser` とファイルの文字の検索）、`401` / `403`、`api/schema` の絞り込みと `"access": 1`、`handle` / `fetch` / `run` の `{ user }`、`access/user.sql`、スナップショットのジョブとログインの順番、古いスナップショットの片付け、`devbi-serve` の静的なファイルで `snapshots/` を配らないこと、ログ。reference の「データベースから読む」に節を足す。**作りました。** 作るときに変えたこと: `snapshots/` の下は、行レベルのモードでなくても静的には配らない（API の口だけ。ずっと安全側で、困ることがないため）。2 の `server.fs.deny` の `access/**` も、`access/user.sql` と一緒にここで足した。`describe`（列を聞くだけで行は読まない）は、ツールからは利用者なしで呼べる（`:user.` には `"1"` を入れる）。`DevBI.reset()` はまだ。
2. **開発サーバーと検査**: `devUsers` と「この人として見る」（このパソコンからだけ）、`server.fs.deny` に `access/**`、`devbi-check` の検査と `--as`・`--url`、`devbi-inspect --as`。サンプル（`examples/sales`）に、地域で絞る SQL と 2 人の開発用の利用者を足し、e2e で 2 人の合計が違うことを確かめる（ダッシュボードの数を数えている e2e と manual-check の項目に気をつける）。
3. **`devbi-serve`**: `--user-header`、`--trusted-proxy`、`--proxy-secret-file`、`--user-lowercase`、`--user-cache`、`--require-user`。deploying.md に nginx・oauth2-proxy の例。
4. **C#**: `DevBIUser`、`ApiRequest.User`、`DevBIOptions.RequireUser`、`MapDevBIApi` と `DevBIHttpHandler` が `HttpContext.User` から作る形、`access/user.sql`、パリティのテスト（`:user.` の読み方、`user` の名前の断り方、空の値）。IIS 用のヘッダーのモジュールは、IIS で確かめられたら足す。
5. **Next.js の例**: セッションから利用者を作る `route.ts`（ログインは見本の簡単なもの）。
6. あとで: 人ごとのスナップショット、複数の値の属性（`IN (:user.regions)`。空の一覧は `403`、SQL Server のパラメーター 2,100 個と Oracle の `IN` の 1,000 個の上限に気をつける）、データベースの行レベルセキュリティとの組み合わせ、署名したトークンでの埋め込み。

## 11. 決めること・確かめること

利用者に決めてもらいたいこと:

1. SQL の中の名前は `:user.region`（`:user.id`）でよいか。
2. 属性は「データベースの表（`access/user.sql`）から引く」を基本にし、ホストが渡すのは足りないときだけ、でよいか。会社では、地域や部署をどこに持っているか（AD のグループ、人事のデータベース、アプリの表）。
3. v1 では、人で絞る SQL はスナップショットにできない、でよいか。
4. IIS の Windows 認証で人ごとに行を変えるときは、C# の形（アプリに API を足す）を勧め、`devbi-serve` 用の IIS のモジュールは IIS で確かめられてから、でよいか。

作るときに確かめること:

- IIS の URL Rewrite で、Windows 認証のユーザー名がヘッダーに入らないこと（入るなら 7.4 はもっと簡単になる）と、モジュールで入れられること。
- oauth2-proxy の例の、ヘッダーの名前（`X-Auth-Request-User`）と、そこにどのクレームが入るか。
- C# の `IsInRole` が、Windows 認証と OpenID Connect の両方で期待どおりに動くこと。Entra ID でグループが多い人は、トークンにグループが入らない（数の上限を超えると別の印に変わる）ので、グループより「アプリのロール」を勧めるか。

## 付録: ほかの BI との違い

- **Power BI**: 行レベルのセキュリティは、モデルの「ロール」に DAX の式（`USERPRINCIPALNAME()` など）で書きます。Power BI Embedded で自社アプリに埋め込むときは、アプリが埋め込みのトークンに「実際のユーザー」を入れて渡します。DevBI では、ホストが API に利用者を渡し、絞り込みは SQL に書きます。考え方は同じで、書く場所がモデルではなくサーバーの SQL ファイルです。
- **Metabase**: 利用者の属性で行を絞る仕組み（data sandboxing）や SAML・JWT の SSO は、有料版の機能です（2026-11 時点の理解。作るときに確かめます）。
- DevBI では、行レベル制御を MIT のまま、追加の費用なしで使えるようにします。閉じた社内のネットワークでも、ホストのログインの仕組みをそのまま使えます。
