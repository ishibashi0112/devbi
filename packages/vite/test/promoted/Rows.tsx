// 「明細」のタイル。GUI エディタの「コードにする」で、組み込みの探索（自由に集計）から書き出したもの。
// このタイルのデータと描き方は、このファイルで変える（GUI で変えられるのは、位置・大きさ・見出し・名前）。
// 自作タイルの書き方: https://github.com/ishibashi0112/devbi/blob/main/docs/reference.md#自作タイルjsx
import { builtinTiles } from "@devbi/react";
import type { Query, TileProps } from "devbi";

// どの明細を読むか（metrics・filters・limit・period だけ）。models/sales.metrics.yaml の model の行
// 集計はしないため export しない（export すると、集計の query として読まれる）
const query: Query = { filters: [{ field: "customer", in: ["A社"] }], limit: 5000 };

// 探索（自由に集計）の設定（dash.json の "options" に書いていたもの）
const options = { layout: { group_by: ["customer"], aggregates: { a: "sum" } } };

// いまは組み込みの探索（自由に集計）で描いている
const Builtin = builtinTiles.explore.component;

export default function Rows(props: TileProps) {
  // 自分で描くときは、下の return を書き換える。明細の行は @devbi/react の useDevbiRows(query, { tileId: props.tile.id }) で
  // 読める（Arrow の表。期間とほかのタイルの選択で絞ったもの）。
  return <Builtin {...props} tile={{ ...props.tile, query, options }} />;
}
