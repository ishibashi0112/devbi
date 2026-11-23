#!/usr/bin/env node
// devbi-serve [--dir <project>] [--static <dir>] [--port 8080] [--host 127.0.0.1] [--allowed-hosts a,b] [--max-rows N] [--timeout <seconds>] [--debug]
//             [--user-header X-DevBI-User] [--trusted-proxy 127.0.0.1,::1] [--proxy-secret-file <file>] [--user-lowercase] [--user-cache <seconds>] [--require-user]
// Serves the built site (dist/) and the read-only API (api/*.sql) from one process.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadEnv } from "./env.js";
import { serve } from "./serve.js";

const usage = (message?: string): never => {
  if (message) console.error(message);
  console.error(
    [
      "使い方: devbi-serve [--dir <プロジェクトのフォルダ>] [--static <ビルドしたフォルダ>] [--port 8080] [--host 127.0.0.1]",
      "                    [--allowed-hosts reports.example.local] [--max-rows 1000000] [--timeout 60] [--debug]",
      "                    [--user-header X-DevBI-User] [--trusted-proxy 127.0.0.1,::1] [--proxy-secret-file <ファイル>]",
      "                    [--user-lowercase] [--user-cache 60] [--require-user]",
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
      "allowed-hosts": { type: "string" },
      "max-rows": { type: "string" },
      timeout: { type: "string" },
      debug: { type: "boolean", default: false },
      "user-header": { type: "string" },
      "trusted-proxy": { type: "string" },
      "proxy-secret-file": { type: "string" },
      "user-lowercase": { type: "boolean", default: false },
      "user-cache": { type: "string" },
      "require-user": { type: "boolean", default: false },
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
const hosts = values!["allowed-hosts"];
const allowedHosts = hosts === undefined ? undefined : hosts.trim() === "all" ? true : hosts.split(",").map((h) => h.trim()).filter(Boolean);
// Row-level security: the signed-in user from the server in front (IIS, nginx with oauth2-proxy).
const userHeader = values!["user-header"]?.trim();
if (values!["user-header"] !== undefined && !userHeader) usage("--user-header のあとにヘッダーの名前を書いてください（X-DevBI-User）");
for (const o of ["trusted-proxy", "proxy-secret-file", "user-lowercase"] as const) {
  if (values![o] !== undefined && values![o] !== false && !userHeader) usage(`--${o} は --user-header と一緒に使います`);
}
const trustedProxies = values!["trusted-proxy"]?.split(",").map((a) => a.trim()).filter(Boolean);
if (trustedProxies && !trustedProxies.length) usage("--trusted-proxy のあとに IP アドレスを書いてください（127.0.0.1,::1）");
let proxySecret: string | undefined;
if (values!["proxy-secret-file"] !== undefined) {
  try {
    proxySecret = readFileSync(path.resolve(values!["proxy-secret-file"]), "utf8").trim();
  } catch (e) {
    usage(`--proxy-secret-file の ${values!["proxy-secret-file"]} を読めません: ${(e as Error).message}`);
  }
  if (!proxySecret) usage(`--proxy-secret-file の ${values!["proxy-secret-file"]} が空です`);
}
const userCache = number(values!["user-cache"], "user-cache");
try {
  const running = await serve({
    dir,
    ...(values!.static ? { staticDir: path.resolve(values!.static) } : {}),
    port: number(values!.port, "port")!,
    host: values!.host!,
    ...(allowedHosts !== undefined ? { allowedHosts } : {}),
    env: loadEnv(dir),
    ...(maxRows !== undefined ? { maxRows } : {}),
    ...(timeout !== undefined ? { timeoutMs: timeout * 1000 } : {}),
    exposeErrors: values!.debug,
    ...(userHeader ? { userHeader } : {}),
    ...(trustedProxies ? { trustedProxies } : {}),
    ...(proxySecret !== undefined ? { proxySecret } : {}),
    ...(values!["user-lowercase"] ? { userLowercase: true } : {}),
    ...(userCache !== undefined ? { userCacheMs: userCache * 1000 } : {}),
    ...(values!["require-user"] ? { requireUser: true } : {}),
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
  console.log(`DevBI: ${running.url} で開いています（止めるときは Ctrl+C）`);
  if (userHeader) {
    const from = (trustedProxies ?? ["127.0.0.1", "::1"]).join("・");
    console.log(`ログインした人: ${from} からのリクエストの ${userHeader}${proxySecret !== undefined ? "（合言葉つき）" : ""}${values!["user-lowercase"] ? "、小文字にそろえる" : ""}。行レベルのモードです`);
  } else if (values!["require-user"]) {
    console.log("行レベルのモードです（--require-user）。--user-header がないので、どのリクエストもログインしていない人です");
  }
  const stop = () => {
    void running.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
