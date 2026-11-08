# create-devbi

[DevBI](https://github.com/ishibashi0112/devbi) のプロジェクトを作ります。

```sh
npm create devbi@latest my-reports
# pnpm create devbi my-reports / yarn create devbi my-reports / bun create devbi my-reports
cd my-reports
npm install
npm run dev
```

サンプルの売上ダッシュボード（架空の受注明細の Excel）、Vite、React、GUI エディタが入ったフォルダができます（`git init` も。しないときは `npm create devbi@latest my-reports -- --no-git`）。フォルダは、ないか空のものにしてください。

使い方は [リファレンス](https://github.com/ishibashi0112/devbi/blob/main/docs/reference.md)。

MIT
