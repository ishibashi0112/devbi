#!/usr/bin/env node
// devbi-serve [--dir <project>] [--static <dir>] [--port 8080] [--host 127.0.0.1] [--max-rows N] [--timeout <seconds>] [--debug]
// Serves the built site (dist/) and the read-only API (api/*.sql) from one process.
import path from "node:path";
import { parseArgs } from "node:util";
import { loadEnv } from "./env.js";
import { serve } from "./serve.js";

const usage = (message?: string): never => {
  if (message) console.error(message);
  console.error(
    [
      "使い方: devbi-serve [--dir <プロジェクトのフォルダ>] [--static <ビルドしたフォルダ>] [--port 8080] [--host 127.0.0.1]",
      "                    [--max-rows 1000000] [--timeout 60] [--debug]",
      "接続先は環境変数 DEVBI_DB（名前つきは DEVBI_DB_<名前>）か、プロジェクトの .env / .env.local に書きます。",
    ].join("\n"),
  );
  process.exit(2);
};

let values;
try {
  ({ values } = parseArgs({
    options: {
      dir: { type: "string", default: "." },
      static: { type: "string" },
      port: { type: "string", default: "8080" },
      host: { type: "string", default: "127.0.0.1" },
      "max-rows": { type: "string" },
      timeout: { type: "string" },
      debug: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  }));
} catch (e) {
  usage((e as Error).message);
}
if (values!.help) usage();
const number = (text: string | undefined, name: string) => {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) usage(`--${name} には数を書いてください`);
  return n;
};
const dir = path.resolve(values!.dir!);
const timeout = number(values!.timeout, "timeout");
const maxRows = number(values!["max-rows"], "max-rows");
try {
  const running = await serve({
    dir,
    ...(values!.static ? { staticDir: path.resolve(values!.static) } : {}),
    port: number(values!.port, "port")!,
    host: values!.host!,
    env: loadEnv(dir),
    ...(maxRows !== undefined ? { maxRows } : {}),
    ...(timeout !== undefined ? { timeoutMs: timeout * 1000 } : {}),
    exposeErrors: values!.debug,
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
  console.log(`DevBI: ${running.url} で開いています（止めるときは Ctrl+C）`);
  const stop = () => {
    void running.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
