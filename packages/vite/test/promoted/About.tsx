// 「説明 export const leaked = 1;」のタイル。GUI エディタの「コードにする」で、組み込みの文章から書き出したもの。
// このタイルのデータと描き方は、このファイルで変える（GUI で変えられるのは、位置・大きさ・見出し・名前）。
// 自作タイルの書き方: https://github.com/ishibashi0112/devbi/blob/main/docs/reference.md#自作タイルjsx
import { builtinTiles } from "@devbi/react";
import type { TileProps } from "devbi";

// 文章の設定（dash.json の "options" に書いていたもの）
const options = { text: "**太字** と\n改行" };

// いまは組み込みの文章で描いている
const Builtin = builtinTiles.markdown.component;

export default function About(props: TileProps) {
  // 自分で描くときは、下の return を書き換える。データが要るときは @devbi/react の useDevbiQuery で集計する。
  return <Builtin {...props} tile={{ ...props.tile, options }} />;
}
