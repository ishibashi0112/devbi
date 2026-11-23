import { createReadStream, existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { apiPathPattern, createApiHandler, type ApiOptions, type RequestOptions } from "./handler.js";
import { logGate, proxyUser } from "./proxy-user.js";

export interface ServeOptions extends ApiOptions {
  /** The built site (`vite build` output) to serve. Default `<dir>/dist`. */
  staticDir?: string;
  /** Default 8080. 0 picks a free port. */
  port?: number;
  /** Default 127.0.0.1 (this computer only; put IIS or another reverse proxy in front for others). */
  host?: string;
  /**
   * Host names the browser may use to reach this server, besides IP addresses and localhost: the name of the
   * reverse proxy or the computer (`reports.example.local`; `.example.local` for it and all names under it).
   * `true` allows any. Any other name is refused, so a web page cannot read the API through a name it points
   * at this computer (DNS rebinding).
   */
  allowedHosts?: string[] | true;
  /**
   * Make the snapshots at their times of day (`-- snapshot: 06:00` in api/*.sql), and when starting those that are
   * missing or out of date. Default true. They are saved in `snapshotDir` (default `<staticDir>/snapshots`).
   */
  schedule?: boolean;
  /**
   * The header in which the server in front (nginx with oauth2-proxy, …) puts the signed-in user's name
   * (`X-DevBI-User`). It becomes `:user.id`; roles and attributes come from `access/user.sql`. Setting it also sets
   * `requireUser`. Believed only from `trustedProxies` (and with `proxySecret`). Default: no user from headers.
   */
  userHeader?: string;
  /** The servers in front whose `userHeader` is believed: IP addresses or ranges (`10.0.0.0/24`). Default `127.0.0.1`, `::1`. */
  trustedProxies?: string[];
  /** When set, only requests with this in `X-DevBI-Proxy-Secret` are believed (other programs on the same computer). */
  proxySecret?: string;
  /** The user name in lower case (`CORP\Yamada` and `corp\yamada` as one user). */
  userLowercase?: boolean;
}

export interface RunningServer {
  server: Server;
  /** `http://host:port/` */
  url: string;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".parquet": "application/vnd.apache.parquet",
  ".arrow": "application/vnd.apache.arrow.file",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** The file a URL path names inside `root`, or undefined when it would leave `root`. */
function fileFor(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const file = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  return file === root || file.startsWith(root + path.sep) ? file : undefined;
}

/** The host name in a Host header, without the port and brackets, in lower case. */
function hostname(header: string): string {
  const h = header.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]") < 0 ? undefined : h.indexOf("]"));
  return h.replace(/:\d*$/, "").replace(/\.$/, "");
}

/** Whether a request's Host may reach the server: IP addresses, localhost, the listening host and the allowed names. */
export function isHostAllowed(header: string | undefined, allowed: string[] | true = [], listening?: string): boolean {
  if (allowed === true || header === undefined) return true;
  const name = hostname(header);
  if (isIP(name) || name === "localhost" || name.endsWith(".localhost")) return true;
  if (listening && name === hostname(listening)) return true;
  return allowed.some((a) => {
    const n = a.trim().toLowerCase();
    return n.startsWith(".") ? name === n.slice(1) || name.endsWith(n) : name === n;
  });
}

/** Windows and macOS find `Snapshots\\X.ARROWS` for `snapshots/x.arrows`: compare paths there without regard to case. */
const FOLDS_CASE = process.platform === "win32" || process.platform === "darwin";

/** Whether `file` is `dir` or inside it, both as real paths (links, short names, `.` and spaces Windows drops). */
async function isInside(file: string, dir: string): Promise<boolean> {
  const real = await realpath(dir).catch(() => path.resolve(dir));
  const norm = (p: string) => (FOLDS_CASE ? p.toLowerCase() : p);
  const f = norm(file);
  const d = norm(real);
  return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/**
 * Serve one file, with HEAD and single byte ranges (DuckDB reads Parquet and CSV in ranges). Never one in `hidden`
 * (the snapshots folders: those go through the API, which checks who asks).
 */
async function sendFile(req: IncomingMessage, res: ServerResponse, root: string, pathname: string, hidden: string[] = []): Promise<void> {
  let file = fileFor(root, pathname);
  let info = file ? await stat(file).catch(() => undefined) : undefined;
  if (file && info?.isDirectory()) {
    file = path.join(file, "index.html");
    info = await stat(file).catch(() => undefined);
  }
  // The file's real path: `/snapshots//x.arrows`, `/Snapshots/x.arrows`, `/snapshots./x.arrows` (Windows) and links
  // all find the same file as the API's `/snapshots/x.arrows`.
  const real = file && info?.isFile() ? await realpath(file).catch(() => undefined) : undefined;
  let refused = !real;
  for (const dir of hidden) if (!refused && (await isInside(real!, dir))) refused = true;
  if (!file || !info?.isFile() || refused) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("見つかりません");
    return;
  }
  const headers: Record<string, string | number> = {
    "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Last-Modified": info.mtime.toUTCString(),
    "X-Content-Type-Options": "nosniff",
    // Vite names the files in assets/ by their content, so they never change; everything else is checked each time.
    "Cache-Control": /\/assets\/[^/]+-[\w-]{8,}\.\w+$/.test(pathname) ? "public, max-age=31536000, immutable" : "no-cache",
  };
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    // A range that ends before it starts is not a range: the whole file, as HTTP says.
    if (m && (m[1] || m[2]) && !(m[1] && m[2] && Number(m[2]) < Number(m[1]))) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), info.size - 1);
      } else {
        start = Math.max(0, info.size - Number(m[2]));
      }
      if (start > end || start >= info.size) {
        res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
        res.end();
        return;
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
    }
  }
  headers["Content-Length"] = Math.max(0, end - start + 1);
  res.writeHead(status, headers);
  if (req.method === "HEAD" || info.size === 0) {
    res.end();
    return;
  }
  // pipeline closes the file when the browser goes away, too.
  await pipeline(createReadStream(file, { start, end }), res).catch(() => undefined);
}

/**
 * Serve a built DevBI site and its read-only API from one process: the files in `staticDir`, and the API
 * (`api/schema`, `api/query`) under any path.
 */
export async function serve(options: ServeOptions): Promise<RunningServer> {
  const root = path.resolve(options.staticDir ?? path.join(options.dir, "dist"));
  if (!existsSync(path.join(root, "index.html"))) {
    throw new Error(`${root} に index.html がありません。先にビルドしてください（pnpm build）`);
  }
  const snapshotDir = options.snapshotDir ?? path.join(root, "snapshots");
  if (options.userHeader === undefined) {
    const without = (["trustedProxies", "proxySecret", "userLowercase"] as const).filter((k) => options[k] !== undefined && options[k] !== false);
    if (without.length) throw new Error(`${without.join("・")} は userHeader と一緒に使います`);
  }
  const fromHeader =
    options.userHeader === undefined
      ? undefined
      : proxyUser({
          header: options.userHeader,
          ...(options.trustedProxies ? { trustedProxies: options.trustedProxies } : {}),
          ...(options.proxySecret !== undefined ? { secret: options.proxySecret } : {}),
          ...(options.userLowercase ? { lowercase: true } : {}),
        });
  const api = createApiHandler({ ...options, snapshotDir, ...(fromHeader ? { requireUser: true } : {}) });
  // A header not believed goes in the log once a minute for each address, and 10 lines a minute in all (a client
  // cannot fill the log with it, from one address or from many).
  const mayLog = logGate(10);
  const apiPath = apiPathPattern(options.describe);
  // Snapshots are sent by the API only (`…/snapshots/<file>.arrows`), which checks who asks: never as plain files.
  const hidden = [...new Set([path.join(root, "snapshots"), path.resolve(snapshotDir)])];
  const host = options.host ?? "127.0.0.1";
  const listening = host === "0.0.0.0" || host === "::" ? undefined : host;
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!isHostAllowed(req.headers.host, options.allowedHosts, listening)) {
          const name = hostname(req.headers.host ?? "");
          options.log?.(`Host ${name} からのリクエストを断りました（--allowed-hosts ${name} で許可できます）`);
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`この名前 (${name}) では開けません。devbi-serve を --allowed-hosts ${name} を付けて起動してください`);
          return;
        }
        // Who asks, from the header of the server in front (API paths only: the site's files are the same for all).
        let asked: RequestOptions = {};
        if (fromHeader && apiPath.test(new URL(req.url ?? "/", "http://localhost").pathname)) {
          const got = fromHeader(req);
          if ("refuse" in got) {
            options.log?.(`リクエストを断りました: ${got.refuse}`);
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ error: got.refuse }));
            return;
          }
          const write = got.ignored ? mayLog(req.socket.remoteAddress ?? "") : false;
          if (write) {
            const limit = write === "last" ? "。ほかの相手のものも合わせて 1 分に 10 件までにするので、このあとしばらくは書きません" : "";
            options.log?.(`${options.userHeader} を使いませんでした（${got.ignored}）。ログインしていない人として答えます（同じ相手は 1 分に 1 回だけ書きます${limit}）`);
          }
          asked = got.options;
        }
        if (await api.handle(req, res, asked)) return;
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { Allow: "GET, HEAD" });
          res.end();
          return;
        }
        await sendFile(req, res, root, new URL(req.url ?? "/", "http://localhost").pathname, hidden);
      } catch (e) {
        options.log?.((e as Error).message);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8080, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  // Also without a schedule: the first look at the jobs tidies the folder (files no job makes any more go).
  const jobs = await api.snapshots.jobs().catch(() => []);
  if (options.schedule !== false) {
    if (jobs.length) {
      const names = [...new Map(jobs.map((j) => [j.name, `${j.name}（${j.times.join("、")}）`])).values()];
      options.log?.(`スナップショット: ${names.join("、")}`);
    }
    api.snapshots.schedule();
    void api.snapshots.catchUp().catch((e: Error) => options.log?.(`スナップショット: ${e.message}`));
  }
  return {
    server,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}/`,
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await api.close();
    },
  };
}
