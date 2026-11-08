# @devbi/editor

[DevBI](https://github.com/ishibashi0112/devbi) の GUI エディタ。Vite の開発サーバーで開いたページの「編集」から、タイルをドラッグで並べ、設定欄で種類・指標・軸・絞り込みを選び、`dashboards/*.dash.json` に手で書いたのと同じ形で保存します。組み込みのタイルで足りない表示は「コードにする」で `.tsx` に書き出せます。

開発用の依存（devDependencies）に入れるだけで使えます。`@devbi/vite` が見つけて開発サーバーにだけ出し、ビルドには入りません。

```sh
npm install -D @devbi/editor
```

新しく始めるときは `npm create devbi@latest my-reports`（最初から入っています）。使い方は [リファレンス](https://github.com/ishibashi0112/devbi/blob/main/docs/reference.md)。

MIT
