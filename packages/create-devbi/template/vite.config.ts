import devbi from "@devbi/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // 相対パス: ビルドした dist/ を、Web サーバーのどのフォルダに置いても開ける（IIS、nginx、GitHub Pages など。index.html を直接開くのは不可）
  base: "./",
  // devbi(): dashboards/ と models/ を読み、ビルドで data/ をコピーする。開発サーバーでは GUI エディタも出す。
  // ほかのアプリの画面に埋め込むときは devbi({ embed: true })（devbi-embed.js も作る）
  plugins: [react(), devbi()],
});
