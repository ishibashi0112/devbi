import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createApiHandler, type ApiOptions } from "./handler.js";

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

/** Serve one file, with HEAD and single byte ranges (DuckDB reads Parquet and CSV in ranges). */
async function sendFile(req: IncomingMessage, res: ServerResponse, root: string, pathname: string): Promise<void> {
  let file = fileFor(root, pathname);
  let info = file ? await stat(file).catch(() => undefined) : undefined;
  if (file && info?.isDirectory()) {
    file = path.join(file, "index.html");
    info = await stat(file).catch(() => undefined);
  }
  if (!file || !info?.isFile()) {
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
  const api = createApiHandler({ ...options, snapshotDir: options.snapshotDir ?? path.join(root, "snapshots") });
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
        if (await api.handle(req, res)) return;
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { Allow: "GET, HEAD" });
          res.end();
          return;
        }
        await sendFile(req, res, root, new URL(req.url ?? "/", "http://localhost").pathname);
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
  if (options.schedule !== false) {
    const jobs = await api.snapshots.jobs().catch(() => []);
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
