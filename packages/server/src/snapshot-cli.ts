#!/usr/bin/env node
// devbi-snapshot [--dir <project>] [--out <site>] [--max-rows N] [--timeout <seconds>] [--require-user] [--debug] [<name>...]
// Makes the snapshots now (for Windows Task Scheduler or cron, when no devbi-serve runs): each read_api(...) in
// models/, and each dataset table of dashboards/ with its default parameters, whose api/<name>.sql has a
// "-- snapshot:" line, saved as <site>/snapshots/<file>.arrows. --require-user: row-level mode as the host that serves the
// files has it (C#'s DevBIOptions.RequireUser): only SQL with "-- access: all".
import path from "node:path";
import { parseArgs } from "node:util";
import { loadEnv } from "./env.js";
import { createApiHandler, rowLevelMode } from "./handler.js";

const usage = (message?: string): never => {
  if (message) console.error(message);
  console.error(
    [
      "使い方: devbi-snapshot [--dir <プロジェクトのフォルダ>] [--out <サイトのフォルダ>] [--max-rows 1000000] [--timeout 60] [--require-user] [--debug] [<SQL の名前>...]",
      "api/<名前>.sql に「-- snapshot: 06:00」の行があり、models/ の read_api か dashboards/ のデータセットの表（既定のパラメーター）で使っているものを、いま作ります。",
      "置き場所は <サイトのフォルダ>/snapshots/（既定は <プロジェクト>/dist/snapshots/）。接続先は devbi-serve と同じです。",
      "--require-user: 行レベルのモードで作ります（-- access: all の SQL だけ）。ホストを RequireUser（requireUser）で行レベルのモードにしているときに付けます。",
    ].join("\n"),
  );
  process.exit(2);
};

let parsed;
try {
  parsed = parseArgs({
    options: {
      dir: { type: "string", default: "." },
      out: { type: "string" },
      "max-rows": { type: "string" },
      timeout: { type: "string" },
      "require-user": { type: "boolean", default: false },
      debug: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
} catch (e) {
  usage((e as Error).message);
}
const { values, positionals } = parsed!;
if (values.help) usage();
const number = (text: string | undefined, name: string) => {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) usage(`--${name} には数を書いてください`);
  return n;
};
const dir = path.resolve(values.dir!);
const out = path.resolve(values.out ?? path.join(dir, "dist"));
const maxRows = number(values["max-rows"], "max-rows");
const timeout = number(values.timeout, "timeout");
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const api = createApiHandler({
  dir,
  env: loadEnv(dir),
  snapshotDir: path.join(out, "snapshots"),
  exposeErrors: values.debug,
  log,
  ...(values["require-user"] ? { requireUser: true } : {}),
  ...(maxRows !== undefined ? { maxRows } : {}),
  ...(timeout !== undefined ? { timeoutMs: timeout * 1000 } : {}),
});
try {
  const results = await api.snapshots.make(positionals);
  if (results.length === 0) {
    const mode = await rowLevelMode(dir, { requireUser: values["require-user"]! }).catch(() => ({ on: true }));
    const rowLevel = mode.on ? "。行レベルのモードでは、-- access: all の SQL のものだけ作ります" : "";
    console.error(
      positionals.length
        ? `${positionals.join(", ")} のスナップショットはありません（api/ の SQL に -- snapshot: の行があり、models/ の read_api か dashboards/ のデータセットの表が既定のパラメーターで読むものだけ作ります${rowLevel}）`
        : `作るスナップショットがありません（api/ の SQL に -- snapshot: 06:00 のような行を書き、models/ の read_api か dashboards/ のデータセットの表で使います${rowLevel}）`,
    );
    process.exitCode = 1;
  } else {
    const failed = results.filter((r) => !r.ok);
    console.log(`${results.length - failed.length} 個を ${path.join(out, "snapshots")} に作りました${failed.length ? `。${failed.length} 個は作れませんでした` : ""}`);
    if (failed.length) process.exitCode = 1;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await api.close();
}
