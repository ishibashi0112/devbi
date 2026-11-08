# @devbi/vite

[DevBI](https://github.com/ishibashi0112/devbi) の Vite プラグイン。`dashboards/` と `models/` を読んで `virtual:devbi` で画面に渡し、自作タイル（`dashboards/**/*.tsx`）をまとめ、ビルドで `data/` をコピーします。開発サーバーでは、`@devbi/editor` が入っていれば GUI エディタも出します。

```ts
// vite.config.ts
import devbi from "@devbi/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({ base: "./", plugins: [react(), devbi()] });
```

- `devbi({ embed: true })`: ほかのアプリの画面に script 1 本で埋め込む `devbi-embed.js` も作る
- `devbi-gen`: `.devbi/` に、dash.json・metrics.yaml の補完（JSON Schema）と自作タイルの型を書く
- `devbi-check`: 指標とすべてのタイルのクエリをデータに流して、表示できるかを確かめる（DuckDB-wasm を Node で動かす）
- `devbi-inspect <ファイル>`: データのファイルの列、型、範囲、多い値を見る

新しく始めるときは `npm create devbi@latest my-reports`。使い方は [リファレンス](https://github.com/ishibashi0112/devbi/blob/main/docs/reference.md)。

MIT
