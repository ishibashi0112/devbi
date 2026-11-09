#!/usr/bin/env node
// devbi-inspect <data file | metrics name> [--dir <project>] [--sheet <name>] [--values <n>] [--json]
// Shows the columns of a data file (or of a metrics file's model): type, range, empty cells, common values.
import { existsSync } from "node:fs";
import path from "node:path";
import "./quiet.js";
import { formatInspect, inspectData } from "./inspect.js";
import { missingExtension } from "./node-engine.js";

const args = process.argv.slice(2);
const usage = (message?: string): never => {
  if (message) console.error(message);
  console.error(
    "使い方: devbi-inspect <データファイル | 指標ファイルの名前> [--dir <プロジェクトのフォルダ>] [--sheet <シート名>] [--values <数>] [--json]",
  );
  process.exit(2);
};
let dir = ".";
let json = false;
let sheet: string | undefined;
let values: number | undefined;
let target: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  // `npm run inspect -- <file> --sheet …` may pass the "--" on (pnpm does): not an argument.
  if (a === "--") continue;
  if (a === "--dir") dir = args[++i] ?? usage("--dir のあとにフォルダを書いてください");
  else if (a === "--sheet") sheet = args[++i] ?? usage("--sheet のあとにシート名を書いてください");
  else if (a === "--values") {
    values = Number(args[++i]);
    if (!Number.isInteger(values) || values < 0) usage("--values のあとに 0 以上の数を書いてください");
  } else if (a === "--json") json = true;
  else if (a.startsWith("-") || target) usage();
  else target = a;
}
if (!target) usage();
const root = path.resolve(dir);
if (!existsSync(root)) usage(`フォルダ ${root} がありません`);
try {
  const report = await inspectData(root, target!, { ...(sheet ? { sheet } : {}), ...(values !== undefined ? { values } : {}) });
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatInspect(report)}\n`, () => process.exit(0));
} catch (e) {
  const ext = missingExtension(e);
  console.error(
    ext
      ? `DuckDB の拡張 ${ext} をインターネットから取ってこられませんでした（extensions.duckdb.org）。外に出られないときは xlsx か CSV で試してください`
      : e instanceof Error
        ? e.message
        : String(e),
  );
  process.exit(1);
}
