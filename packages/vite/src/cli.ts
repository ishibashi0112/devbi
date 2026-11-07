#!/usr/bin/env node
// devbi-gen [--dir <project>] [--check]
// Writes .devbi/ (names for TypeScript, JSON Schema for dash.json / metrics.yaml) from models/*.metrics.yaml.
import path from "node:path";
import { generate } from "./gen.js";

const args = process.argv.slice(2);
let dir = ".";
let check = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir") dir = args[++i] ?? ".";
  else if (args[i] === "--check") check = true;
  else {
    console.error("使い方: devbi-gen [--dir <プロジェクトのフォルダ>] [--check]");
    process.exit(2);
  }
}
const root = path.resolve(dir);
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
