#!/usr/bin/env node
// devbi-check [--dir <project>] [--json]
// Runs the project's model SQL, measures, dimensions and every tile's query on the data; lists what to fix.
import { existsSync } from "node:fs";
import path from "node:path";
import "./quiet.js";
import { checkProject, formatReport } from "./check.js";

const args = process.argv.slice(2);
const usage = (message?: string): never => {
  if (message) console.error(message);
  console.error("使い方: devbi-check [--dir <プロジェクトのフォルダ>] [--json]");
  process.exit(2);
};
let dir = ".";
let json = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir") dir = args[++i] ?? usage("--dir のあとにフォルダを書いてください");
  else if (args[i] === "--json") json = true;
  else usage();
}
const root = path.resolve(dir);
if (!existsSync(path.join(root, "models")))
  usage(`${root} に models/ フォルダがありません。DevBI のプロジェクトのフォルダで実行するか、--dir で指してください`);
const report = await checkProject(root);
console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
process.exit(report.findings.some((f) => f.level === "error") ? 1 : 0);
