#!/usr/bin/env node
// devbi-inspect <data file | metrics file> [--dir <project>] [--sheet <name>] [--range <cells>] [--values <n>] [--rows <n>] [--json]
// devbi-inspect --sql "<SELECT …>" [...]
// Shows the columns of a data file (or of a metrics file's model, or of a SELECT): type, range, empty cells, common
// values, and the first rows.
import { existsSync } from "node:fs";
import path from "node:path";
import "./quiet.js";
import { formatInspect, inspectData } from "./inspect.js";
import { missingExtension } from "./node-engine.js";

const args = process.argv.slice(2);
const usage = (message?: string): never => {
  if (message) console.error(message);
  console.error(
    [
      "使い方: devbi-inspect <データファイル | 指標ファイル> [--sheet <シート名>] [--range <セル範囲>] [--values <数>] [--rows <数>] [--dir <プロジェクトのフォルダ>] [--json]",
      `        devbi-inspect --sql "SELECT … FROM read_xlsx('data/….xlsx', sheet = '…')" [--rows <数>] [--dir …] [--json]`,
    ].join("\n"),
  );
  process.exit(2);
};
const count = (flag: string, v: string | undefined) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : usage(`${flag} のあとに 0 以上の数を書いてください`);
};
let dir = ".";
let json = false;
let sheet: string | undefined;
let range: string | undefined;
let sql: string | undefined;
let values: number | undefined;
let rows: number | undefined;
let target: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  // `npm run inspect -- <file> --sheet …` may pass the "--" on (pnpm does): not an argument.
  if (a === "--") continue;
  if (a === "--dir") dir = args[++i] ?? usage("--dir のあとにフォルダを書いてください");
  else if (a === "--sheet") sheet = args[++i] ?? usage("--sheet のあとにシート名を書いてください");
  else if (a === "--range") range = args[++i] ?? usage("--range のあとにセル範囲（A3:K など）を書いてください");
  else if (a === "--sql") sql = args[++i] ?? usage("--sql のあとに SELECT の文を書いてください");
  else if (a === "--values") values = count(a, args[++i]);
  else if (a === "--rows") rows = count(a, args[++i]);
  else if (a === "--json") json = true;
  else if (a.startsWith("-") || target) usage();
  else target = a;
}
if (!target === !sql) usage(sql ? "ファイルと --sql は、どちらか一つにしてください" : undefined);
const root = path.resolve(dir);
if (!existsSync(root)) usage(`フォルダ ${root} がありません`);
try {
  const report = await inspectData(root, sql ? { sql } : target!, {
    ...(sheet ? { sheet } : {}),
    ...(range ? { range } : {}),
    ...(values !== undefined ? { values } : {}),
    ...(rows !== undefined ? { rows } : {}),
  });
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
