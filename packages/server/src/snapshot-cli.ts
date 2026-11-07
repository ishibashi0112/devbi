#!/usr/bin/env node
// devbi-snapshot [--dir <project>] [--out <site>] [--max-rows N] [--timeout <seconds>] [--debug] [<name>...]
// Makes the snapshots now (for Windows Task Scheduler or cron, when no devbi-serve runs): each read_api(...) in
// models/ whose api/<name>.sql has a "-- snapshot:" line, saved as <site>/snapshots/<file>.arrows.
import path from "node:path";
import { parseArgs } from "node:util";
import { loadEnv } from "./env.js";
import { createApiHandler } from "./handler.js";

const usage = (message?: string): never => {
  if (message) console.error(message);
  console.error(
    [
      "使い方: devbi-snapshot [--dir <プロジェクトのフォルダ>] [--out <サイトのフォルダ>] [--max-rows 1000000] [--timeout 60] [--debug] [<SQL の名前>...]",
      "api/<名前>.sql に「-- snapshot: 06:00」の行があり、models/ の read_api で使っているものを、いま作ります。",
      "置き場所は <サイトのフォルダ>/snapshots/（既定は <プロジェクト>/dist/snapshots/）。接続先は devbi-serve と同じです。",
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
  ...(maxRows !== undefined ? { maxRows } : {}),
  ...(timeout !== undefined ? { timeoutMs: timeout * 1000 } : {}),
});
try {
  const results = await api.snapshots.make(positionals);
  if (results.length === 0) {
    console.error(
      positionals.length
        ? `${positionals.join(", ")} のスナップショットはありません（api/ の SQL に -- snapshot: の行があり、models/ の read_api で使っているものだけ作ります）`
        : "作るスナップショットがありません（api/ の SQL に -- snapshot: 06:00 のような行を書き、models/ の read_api で使います）",
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
