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
  // `npm run check -- --json` may pass the "--" on (pnpm does): not an argument.
  if (args[i] === "--") continue;
  if (args[i] === "--dir") dir = args[++i] ?? usage("--dir のあとにフォルダを書いてください");
  else if (args[i] === "--json") json = true;
  else usage();
}
const root = path.resolve(dir);
if (!existsSync(path.join(root, "models")))
  usage(`${root} に models/ フォルダがありません。DevBI のプロジェクトのフォルダで実行するか、--dir で指してください`);
let report: Awaited<ReturnType<typeof checkProject>>;
try {
  report = await checkProject(root);
} catch (e) {
  // Not a finding: the check itself could not run (exit 2, as for a wrong folder).
  console.error(`確かめられませんでした: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(2);
}
// Exit once the output is written (a large --json into a pipe is written later).
const code = report.findings.some((f) => f.level === "error") ? 1 : 0;
process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`, () => process.exit(code));
