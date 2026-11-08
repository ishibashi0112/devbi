// 「顧客」のタイル。GUI エディタの「コードにする」で、組み込みの選択リストから書き出したもの。
// このタイルのデータと描き方は、このファイルで変える（GUI で変えられるのは、位置・大きさ・見出し・名前）。
// 自作タイルの書き方: https://github.com/ishibashi0112/devbi/blob/main/docs/reference.md#自作タイルjsx
import { builtinTiles } from "@devbi/react";
import { defineQuery, type RowOf, type TileProps } from "devbi";

// 何を出すか（SQL は書かない）。指標と軸の名前は models/sales.metrics.yaml のもの
export const query = defineQuery({ dimensions: ["customer"] });

// 選択リストの設定（dash.json の "options" に書いていたもの）
const options = { multiple: false };

// いまは組み込みの選択リストで描いている
const Builtin = builtinTiles.select.component;

export default function Customer(props: TileProps<RowOf<typeof query>>) {
  // 自分で描くときは、下の return を書き換える。props.rows が集計済みの行（ほかのタイルの選択で絞ったもの）で、
  // 列は customer（顧客）。例:
  //   return (
  //     <ul>
  //       {props.rows.map((r, i) => (
  //         <li key={i}>{props.format(r.customer, "customer")}</li>
  //       ))}
  //     </ul>
  //   );
  // 値の書式は props.format、クリックでほかのタイルを絞るのは props.select。
  return <Builtin {...props} tile={{ ...props.tile, options }} />;
}
