# npm への公開

公開は、自分のパソコンから `pnpm release` で手で出します。npm へのログインと公開の確認は passkey（ブラウザ）でします。GitHub Actions からは出しません（npm のトークンをどこにも置かないため）。

公開するのは `packages/` の 6 つで、いつも同じ版にそろえて出します（`create-devbi` が作るプロジェクトは、DevBI のパッケージを `^<create-devbi の版>` で使うため）。

| npm 名 | フォルダ |
| --- | --- |
| `devbi` | `packages/devbi` |
| `@devbi/server` | `packages/server` |
| `@devbi/react` | `packages/react` |
| `@devbi/vite` | `packages/vite` |
| `@devbi/editor` | `packages/editor` |
| `create-devbi` | `packages/create-devbi`（`npm create devbi@latest my-reports` で動くもの） |

`pnpm release` は、この上から順に出します（使うほうより、使われるほうが先）。

## 最初の 1 回だけ: npm の Organization `devbi` を作る

`devbi` と `create-devbi` はスコープのない名前なので、Organization は要りません。`@devbi/〜` の 4 つは、`@devbi` というスコープの下に出すので、npm の Organization `devbi`（無料）が要ります。

1. npm にログインした状態で <https://www.npmjs.com/org/create> を開きます。
2. 名前に `devbi` と入れ、無料のプラン（公開パッケージだけ）を選びます。
3. メンバーを招く画面は飛ばしてかまいません（作った人がそのまま持ち主です）。

2026-11-15 の時点で、6 つの名前と Organization の名前 `devbi` は、どれも空いています。

## 毎回

### 1. 準備（Claude がします）

- 版を上げる PR（`node scripts/version.mjs 0.1.2` のように、6 つの `package.json` の版をそろえて変える）をマージします。最初の 0.1.0（2026-11-15）は版を上げずに出しました。
- GitHub の main の最新のコミットに、CI の緑のチェック（型チェック・テスト・`check:packed`）が付いているのを確かめます（`pnpm release` も確かめます）。

### 2. 公開（自分でします）

ターミナルで、DevBI のフォルダで:

```sh
git switch main && git pull                          # GitHub の main と同じにする
npm login --registry=https://registry.npmjs.org/     # Enter を押すとブラウザが開くので、passkey で
pnpm release
```

`pnpm release` は、次の順に進みます。

1. 確かめる: main と同じで変更がないこと、そのコミットの CI が通っていること、6 つの版がそろっていること、npm にログインしていること、Organization `devbi` があってそのメンバーであること。どれかが違うと、何も出さずに止まり、何をすればいいかを出します。
2. `pnpm install --frozen-lockfile` と `pnpm build` をして、6 つをパックします（ここまでで 1〜2 分）。パックしたものに git にないファイル（`.env.local` など、このパソコンにだけあるもの）が入っていたら、止まります。
3. 出すものの一覧を出して、`y` の入力を待ちます。
4. 1 つずつ `npm publish` します。npm が passkey での確認を求めたら（`Authenticate your account at:` と出て、Enter でブラウザが開きます）、ブラウザで passkey を使います。パッケージごとに求められることがあります。
5. npm から版を読み直して、出したものがすべて `OK` と出たら終わりです。

先に、何も出さずに通しで試すこともできます（ログインも Organization も要りません）:

```sh
pnpm release --dry-run
```

### 3. 確かめる

```sh
npm view devbi version            # 出した版が出る
npm view @devbi/react version
npm create devbi@latest my-reports && cd my-reports && npm install && npm run dev
```

npm のページ: <https://www.npmjs.com/package/devbi>、<https://www.npmjs.com/org/devbi>

最後に、出したコミットに印（タグ）を付けておくと、あとでどのコミットから出したかが分かります（任意。`pnpm release` が最後に、出した版でこのコマンドを出します）:

```sh
git tag v0.1.1 && git push origin v0.1.1
```

## うまくいかないとき

- **途中で止まった**: 直して、もう一度 `pnpm release`。npm にもうある版は飛ばすので、続きから出します。その間にコードを変えたときは、続きではなく版を上げて出し直します（同じ版の中で、出したときのコードが混ざらないように）。
- **`ENEEDAUTH` や `E401`**: ログインが切れています。`npm login --registry=https://registry.npmjs.org/` をして、もう一度。
- **`@devbi/〜` で `E403` や `E404`**: Organization `devbi` がないか、そのメンバーになっていないログインで出しています（`npm whoami` で確かめます）。
- **出したものに間違いがあった**: 同じ版は、消しても二度と使えません。直して版を上げ（`0.1.1`）、出し直します。間違った版には、6 つそれぞれに `npm deprecate devbi@0.1.0 "0.1.1 を使ってください"` で印を付けます（それぞれ passkey を求められます）。
- **見せてはいけないものが入っていた**: 出して 72 時間のうちなら `npm unpublish <名前>@<版>` で消せます。ほかが使っている `devbi` を最後にして、`create-devbi` から逆の順に消します。版が 1 つしかないパッケージを消すと、その名前には 24 時間出せません。
- `0.2.0-beta.1` のような版（プレリリース）は、npm の `next` で出ます（`npm create devbi@next` で使えて、`@latest` は前のまま）。
- `pnpm release` は、パソコンの npm がふだん別のレジストリ（会社のミラーなど）を向いていても、`@devbi` の分も含めて、いつも <https://registry.npmjs.org/> に出します。
- 前の手順（GitHub Actions から出す）で npm のトークン（Bypass 2FA）や GitHub の Secret `NPM_TOKEN` を作っていたら、もう使わないので消しておきます。

## 公開の前に確かめること（pnpm check:packed）

`pnpm check:packed` は、npm に出すのと同じ形（`pnpm pack`）でパッケージを固め、`create-devbi` でプロジェクトを作り、そこへ npm と pnpm でそれぞれ入れて、次を確かめます。GitHub の CI（`packed`）で、PR と main のたびに流れます。

- 型チェック（`devbi-gen` と `tsc`）とビルド（`vite build`）が通る
- 開発サーバーでサンプルのダッシュボードが出る
- GUI エディタで「コードにする」をして、ページが読み込み直されない（npm から入れたときは、Vite が依存を先にまとめておかないと読み込み直しが起きるため）

手元で流すときは（Mac・Linux。5 分ほど）、先に `pnpm --filter create-devbi exec playwright install chromium` でブラウザを入れておきます。作ったプロジェクトはフォルダに残るので（最後に場所が出ます）、`npm run dev` で開いて触ってみることもできます。

## あとで自動にするなら

GitHub Actions から出すようにするときは、npm の Trusted Publishing（トークンを置かずに、GitHub Actions のワークフローを npm に登録する）を使います。2FA を飛ばすトークン（「Bypass 2FA」）での公開は、npm が 2027 年初めに終える予定です（[GitHub の告知](https://github.blog/changelog/2026-07-07-npm-install-time-security-and-gat-bypass2fa-deprecation)）。
