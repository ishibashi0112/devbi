# @devbi/server

[DevBI](https://github.com/ishibashi0112/devbi) の読み取り API。サーバーに置いた `api/*.sql` を読み取り専用で実行し、結果を Arrow でブラウザに返します（ブラウザは SQL を送らず、名前とパラメーターだけ）。SQLite・PostgreSQL・SQL Server・Oracle・MySQL / MariaDB。

- `devbi-serve`: ビルドしたサイトと API を 1 つのプロセスで出し、毎朝のスナップショットを作る
- `devbi-snapshot`: スナップショットをいま作る（タスクスケジューラ用）
- `createApiHandler`: 自分のサーバーに組み込む（Node の `http` のハンドラーと、Next.js の `route.ts` などで使う `fetch(request)`）

データベースのドライバー（`pg`、`mssql`、`oracledb`、`mysql2`）は、使うものを自分で入れます。使い方は [リファレンス](https://github.com/ishibashi0112/devbi/blob/main/docs/reference.md)。

MIT
