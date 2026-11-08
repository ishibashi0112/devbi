# npm への公開

公開するのは `packages/` の 6 つで、いつも同じ版にそろえて出します（`create-devbi` が作るプロジェクトは、DevBI のパッケージを `^<create-devbi の版>` で使うため）。

| npm 名 | フォルダ |
| --- | --- |
| `devbi` | `packages/devbi` |
| `@devbi/react` | `packages/react` |
| `@devbi/vite` | `packages/vite` |
| `@devbi/editor` | `packages/editor` |
| `@devbi/server` | `packages/server` |
| `create-devbi` | `packages/create-devbi`（`npm create devbi@latest my-reports` で動くもの） |

公開は GitHub Actions（`.github/workflows/release.yml`）がします。`v0.1.0` のようなタグを push すると、型チェック・テスト・パックしたものの確かめ（下）を通してから、npm に出します。

## 最初の 1 回だけ

1. **npm の Organization `devbi` を作る。** <https://www.npmjs.com/org/create> で名前を `devbi` にし、無料のプラン（公開パッケージだけ）を選びます。`@devbi/〜` はこの Organization の下に出ます。`devbi` と `create-devbi` はスコープのない名前なので、Organization は要りません（2026-11-08 の時点で、どちらも空いています）。
2. **npm のアクセストークンを作る。** npm の「Access Tokens」→「Generate New Token」→「Granular Access Token」。
   - Permissions: Packages and scopes を **Read and write**、対象は「All packages」（まだないパッケージを作るため）と Organization `devbi`
   - 有効期限は短めに（公開したら消してかまいません。次は作り直すか、下の「トークンなしで出す」に）
3. **GitHub に入れる。** リポジトリの Settings → Secrets and variables → Actions → New repository secret で、名前 `NPM_TOKEN`、値に 2 のトークン。
4. （任意）Settings → Environments に `npm` ができたら（最初の公開で自動でできます）、「Required reviewers」に自分を入れると、公開の前に GitHub で承認を求められます。

## 毎回

```sh
node scripts/version.mjs 0.1.1      # 6 つの package.json の version をそろえて変える
pnpm build && pnpm check:packed     # 手元でも確かめるなら（CI でも同じものが流れます）
git commit -am "0.1.1"              # PR を出してマージ
git tag v0.1.1 origin/main          # マージしたあとの main に
git push origin v0.1.1              # これで Release が動く
```

- Release は、タグの版とパッケージの版が違うと止まります（`node scripts/version.mjs --check 0.1.1`）。
- npm にもうある版は飛ばすので、途中で止まったときは同じタグのまま Actions の「Re-run」でやり直せます。
- 出たかどうかは `npm view devbi version`、`npm view create-devbi version` で。各パッケージの npm のページに「Provenance」（どのコミットから、どのワークフローで作ったか）が出ます。

## 公開の前に確かめること（pnpm check:packed）

`pnpm check:packed` は、npm に出すのと同じ形（`pnpm pack`）でパッケージを固め、`create-devbi` でプロジェクトを作り、そこへ npm と pnpm でそれぞれ入れて、次を確かめます。CI の `packed` でも毎回流れます。

- 型チェック（`devbi-gen` と `tsc`）とビルド（`vite build`）が通る
- 開発サーバーでサンプルのダッシュボードが出る
- GUI エディタで「コードにする」をして、ページが読み込み直されない（npm から入れたときは、Vite が依存を先にまとめておかないと読み込み直しが起きるため）

作ったプロジェクトはフォルダに残るので（最後に場所が出ます）、`npm run dev` で開いて触ってみることもできます。

## トークンなしで出す（2 回目から）

npm の Trusted Publishing を使うと、トークンを置かずに GitHub Actions から出せます。パッケージが npm にできたあと、各パッケージの npm の Settings → Trusted Publisher で、GitHub Actions・リポジトリ `ishibashi0112/devbi`・ワークフロー `release.yml`・環境 `npm` を登録し、`NPM_TOKEN` を消します（ワークフローは npm 11 を入れているので、そのままで動きます）。
