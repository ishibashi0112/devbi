#!/usr/bin/env node
// devbi-check [--dir <project>] [--values [n]] [--as <devUsers name>] [--config <vite config>] [--url <site>] [--json]
// Runs the project's model SQL, measures, dimensions and every tile's query on the data; lists what to fix. In row-level
// mode, as each of devUsers (vite.config.ts), or the one `--as` names.
import { existsSync } from "node:fs";
import path from "node:path";
import "./quiet.js";
import { checkProject, formatReport, type CheckOptions } from "./check.js";
import { devUserOf, loadDevUsers } from "./dev-users.js";

const args = process.argv.slice(2);
const usage = (message?: string): never => {
  if (message) console.error(message);
  console.error("使い方: devbi-check [--dir <プロジェクトのフォルダ>] [--values [行数]] [--as <devUsers の名前>] [--config <vite.config.ts>] [--url <置いた場所>] [--json]");
  process.exit(2);
};
let dir = ".";
let json = false;
let values = 0;
let as: string | undefined;
let config: string | undefined;
let url: string | undefined;
for (let i = 0; i < args.length; i++) {
  // `npm run check -- --json` may pass the "--" on (pnpm does): not an argument.
  if (args[i] === "--") continue;
  if (args[i] === "--dir") dir = args[++i] ?? usage("--dir のあとにフォルダを書いてください");
  else if (args[i] === "--json") json = true;
  else if (args[i] === "--as") as = args[++i] ?? usage("--as のあとに devUsers の名前を書いてください");
  else if (args[i] === "--config") config = args[++i] ?? usage("--config のあとに Vite の設定ファイルを書いてください");
  else if (args[i] === "--url") {
    url = args[++i] ?? usage("--url のあとに、置いた場所の URL を書いてください（https://intra.example.com/devbi/）");
    if (!/^https?:\/\//i.test(url)) usage(`--url には http:// か https:// で始まる URL を書いてください（${url}）`);
  }
  else if (args[i] === "--values") {
    // Each tile's first rows as the screen shows them: 5, or the number after it.
    values = /^[1-9]\d*$/.test(args[i + 1] ?? "") ? Number(args[++i]) : 5;
  } else usage();
}
const root = path.resolve(dir);
// A project of reports only has api/ (the SQL files) and dashboards/, without models/.
if (!existsSync(path.join(root, "models")) && !(existsSync(path.join(root, "api")) && existsSync(path.join(root, "dashboards"))))
  usage(`${root} に models/ フォルダがありません。DevBI のプロジェクトのフォルダで実行するか、--dir で指してください`);
// Row-level security: the data as one of devUsers (--as), or, in row-level mode, as each of them.
const options: CheckOptions = { ...(values ? { values } : {}), ...(url ? { url } : {}) };
try {
  const rowLevel = existsSync(path.join(root, "api")) ? await (await import("@devbi/server")).rowLevelMode(root) : { on: false };
  if (as || config || rowLevel.on) {
    const dev = await loadDevUsers(root, config ? { config } : {});
    if (as) {
      if (!dev || !Object.hasOwn(dev.users, as)) {
        usage(
          dev
            ? `devUsers に ${as} がありません（${dev.config} にあるのは ${Object.keys(dev.users).join("・")}）`
            : `devUsers がありません。vite.config.ts の devbi({ devUsers: { ${as}: { attrs: { … } } } }) に書きます（ほかの設定ファイルなら --config で指します）`,
        );
      }
      options.users = [{ name: as, user: devUserOf(as, dev!.users[as]!) }];
    } else if (dev && rowLevel.on) {
      options.users = Object.entries(dev.users).map(([name, u]) => ({ name, user: devUserOf(name, u) }));
    }
  }
} catch (e) {
  console.error(`確かめられませんでした: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
let report: Awaited<ReturnType<typeof checkProject>>;
try {
  report = await checkProject(root, options);
} catch (e) {
  // Not a finding: the check itself could not run (exit 2, as for a wrong folder).
  console.error(`確かめられませんでした: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(2);
}
// Exit once the output is written (a large --json into a pipe is written later).
const code = report.findings.some((f) => f.level === "error") ? 1 : 0;
process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`, () => process.exit(code));
