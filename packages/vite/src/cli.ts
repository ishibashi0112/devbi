#!/usr/bin/env node
// devbi-gen [--dir <project>] [--check]
// Writes .devbi/ (names for TypeScript, JSON Schema for dash.json / metrics.yaml) from models/*.metrics.yaml.
import { existsSync } from "node:fs";
import path from "node:path";
import { generate } from "./gen.js";

const args = process.argv.slice(2);
const usage = (message?: string): never => {
  if (message) console.error(message);
  console.error("使い方: devbi-gen [--dir <プロジェクトのフォルダ>] [--check]");
  process.exit(2);
};
let dir = ".";
let check = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir") dir = args[++i] ?? usage("--dir のあとにフォルダを書いてください");
  else if (args[i] === "--check") check = true;
  else usage();
}
const root = path.resolve(dir);
if (!existsSync(path.join(root, "models"))) usage(`${root} に models/ フォルダがありません。DevBI のプロジェクトのフォルダで実行するか、--dir で指してください`);
const { changed, problems } = await generate(root, { check });
for (const p of problems) console.error(`読めない指標ファイルがあります（この分の名前は入りません）:\n${p}`);
if (check) {
  if (changed.length) {
    console.error(`.devbi/ が古くなっています。pnpm gen を実行してください:\n${changed.map((f) => `  ${path.relative(root, f)}`).join("\n")}`);
    process.exit(1);
  }
  console.log(".devbi/ は最新です");
} else {
  console.log(changed.length ? `書きました:\n${changed.map((f) => `  ${path.relative(root, f)}`).join("\n")}` : ".devbi/ は最新です");
}
if (problems.length) process.exit(1);
