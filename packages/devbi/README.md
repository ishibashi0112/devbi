# devbi

[DevBI](https://github.com/ishibashi0112/devbi) の土台。開発者がいる会社が自社アプリの中に置く BI で、ダッシュボードは git のファイル、タイルは JSX に「昇格」でき、集計はブラウザの中の DuckDB がします。

このパッケージは、ファイル形式（`*.metrics.yaml`・`*.dash.json`）の検証、指標から DuckDB の SQL を作るコンパイラ、xlsx の読み書き、書式、自作タイルの型（`defineQuery`、`TileProps`、`RowOf`）です。ブラウザでも Node でも動きます。

新しく始めるときは、雛形から作るのがかんたんです。

```sh
npm create devbi@latest my-reports
```

ファイルの書き方と API: [リファレンス](https://github.com/ishibashi0112/devbi/blob/main/docs/reference.md)

ほかのパッケージ: [`@devbi/react`](https://www.npmjs.com/package/@devbi/react)（画面）、[`@devbi/vite`](https://www.npmjs.com/package/@devbi/vite)（Vite プラグイン）、[`@devbi/editor`](https://www.npmjs.com/package/@devbi/editor)（GUI エディタ）、[`@devbi/server`](https://www.npmjs.com/package/@devbi/server)（読み取り API）、[`create-devbi`](https://www.npmjs.com/package/create-devbi)（雛形）

MIT
