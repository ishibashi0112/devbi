// 「期間」のタイル。GUI エディタの「コードにする」で、組み込みの期間から書き出したもの。
// このタイルのデータと描き方は、このファイルで変える（GUI で変えられるのは、位置・大きさ・見出し・名前）。
// 自作タイルの書き方: https://github.com/ishibashi0112/devbi/blob/main/docs/reference.md#自作タイルjsx
import { builtinTiles } from "@devbi/react";
import type { TileProps } from "devbi";

// 期間の設定（dash.json の "options" に書いていたもの）
const options = { default: "latest_fiscal_year", metrics: "sales" };

// いまは組み込みの期間で描いている
const Builtin = builtinTiles["date-range"].component;

export default function Period(props: TileProps) {
  // 自分で描くときは、下の return を書き換える。データが要るときは @devbi/react の useDevbiQuery で集計する。
  return <Builtin {...props} tile={{ ...props.tile, options }} />;
}
