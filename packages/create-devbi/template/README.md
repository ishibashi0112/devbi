# {{name}}

[DevBI](https://github.com/ishibashi0112/devbi) のダッシュボード。ダッシュボードは git のファイルで、集計はブラウザの中の DuckDB がします。

## 動かす

```sh
{{install}}
{{run}} dev        # http://localhost:5173 。見出しの右の「編集」で GUI エディタ
{{run}} build      # dist/ に静的なサイトを作る（どのフォルダに置いても開ける）
{{run}} preview    # ビルドしたものを開く
{{run}} typecheck  # 自作タイル（.tsx）の型チェック
{{run}} check      # 指標とすべてのタイルのクエリをデータに流して確かめる（ブラウザを開かずに）
{{run}} inspect data/sales.xlsx  # データの列・型・値を見る
```

## ファイル

```
models/sales.metrics.yaml      # 指標と軸（SQL はここだけ）
dashboards/sales.dash.json     # タイルの並び。GUI エディタでも、手でも書ける
dashboards/sales/*.tsx         # 自作タイル。エディタの「コードにする」で、組み込みのタイルから書き出せる
data/sales.xlsx                # データ（架空の受注明細）。CSV・Parquet・Arrow も置ける
```

## 次にすること

- `data/` に自分の Excel や CSV を置き、`{{run}} inspect data/<ファイル>` で列を見て、`models/` の `model:` をそのファイルに向け、指標と軸を書く。書いたら `{{run}} check`
- `{{run}} dev` で開いたページの「編集」で、タイルを足して指標と軸を選ぶ。保存すると dash.json に書かれる
- 組み込みのタイルで足りない表示は、エディタの「コードにする」で .tsx に書き出し、React で描く

ファイルの書き方と API は [リファレンス](https://github.com/ishibashi0112/devbi/blob/main/docs/reference.md)。
