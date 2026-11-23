#!/usr/bin/env node
// devbi-gen [--dir <project>] [--check] [--no-db]
// Writes .devbi/ (names for TypeScript, JSON Schema for dash.json / metrics.yaml) from models/*.metrics.yaml, and the
// datasets' row types from api/*.sql, asking their databases for the columns (not with --no-db).
import { existsSync } from "node:fs";
import path from "node:path";
import { generate } from "./gen.js";

const args = process.argv.slice(2);
const usage = (message?: string): never => {
  if (message) console.error(message);
  console.error("使い方: devbi-gen [--dir <プロジェクトのフォルダ>] [--check] [--no-db]");
  process.exit(2);
};
let dir = ".";
let check = false;
let db = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir") dir = args[++i] ?? usage("--dir のあとにフォルダを書いてください");
  else if (args[i] === "--check") check = true;
  else if (args[i] === "--no-db") db = false;
  else usage();
}
const root = path.resolve(dir);
if (!existsSync(path.join(root, "models")) && !existsSync(path.join(root, "api")))
  usage(`${root} に models/ フォルダも api/ フォルダもありません。DevBI のプロジェクトのフォルダで実行するか、--dir で指してください`);
const { changed, problems, unasked } = await generate(root, { check, describe: db ? "all" : false });
for (const p of problems) console.error(`読めない指標ファイルがあります（この分の名前は入りません）:\n${p}`);
// Not a failure: without a database the row types stay as last asked (or are plain rows).
if (unasked.length) {
  console.log(
    `データセットの列を聞けませんでした（行の型は前に聞いたまま。まだのものは列の名前を決めない行になります）:\n${unasked
      .map((u) => `  api/${u.name}.sql: ${u.why.replace(`api/${u.name}.sql: `, "")}`)
      .join("\n")}`,
  );
}
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
