import { open as openFile, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { toArrowStream } from "./arrow.js";
import { connect, dialectOf, type Connection } from "./connect.js";
import { DatasetError, bindParameters, connectionOf, connectionVariable, listDatasets, parseDataset, readDatasetText } from "./datasets.js";
import { createSnapshots, type Snapshots } from "./snapshot.js";
import { promisify } from "node:util";
import { createGzip, gzip } from "node:zlib";

const gzipAsync = promisify(gzip);

export interface ApiOptions {
  /** The project folder: SQL files are read from `<dir>/api`, and a relative `sqlite:` path from `<dir>`. */
  dir: string;
  /** Where DEVBI_DB and DEVBI_DB_<NAME> are read from. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Most rows one request may return. Default 1,000,000. */
  maxRows?: number;
  /** How long one query may run, in milliseconds (all but SQLite). Default 60,000. */
  timeoutMs?: number;
  /**
   * Send database errors to the browser as they are (they can name tables and columns). Off: the browser gets
   * a short message and `log` gets the details. Default off.
   */
  exposeErrors?: boolean;
  /** Where to write one line per request and the details of errors. Default: nothing. */
  log?: (line: string) => void;
  /**
   * The folder snapshots are kept in (`<site>/snapshots`): `GET …/snapshots/<file>` sends the file, made first
   * when it is not there yet. Without it (the dev server), each request runs the SQL.
   */
  snapshotDir?: string;
}

export interface ApiHandler {
  /**
   * Answer the request when its path ends in `/api/schema`, `/api/query` or `/snapshots/<file>.arrows` (whatever
   * comes before, so the API sits next to the dashboards under any base path). Resolves false for other requests.
   */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /**
   * The same with the web's `Request` and `Response` (Next.js route handlers and other servers built on them): the
   * answer, or undefined for other paths. Not gzipped (Next.js drops a Response's Content-Encoding): the server or
   * the proxy in front compresses.
   */
  fetch(request: Request): Promise<Response | undefined>;
  /** Run `api/<name>.sql` with the parameters: the Arrow IPC stream `POST …/api/query` answers, and its row count. */
  run(name: string, params?: Record<string, unknown>): Promise<{ bytes: Uint8Array; rows: number }>;
  /** The snapshots of the `read_api` calls in models/ whose SQL file has a `-- snapshot:` line. */
  snapshots: Snapshots;
  /** Close the database connections. */
  close(): Promise<void>;
}

export const ARROW_STREAM = "application/vnd.apache.arrow.stream";
const MAX_BODY = 64 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A request, from Node's http or the web's fetch. */
interface Asked {
  method: string;
  pathname: string;
  /** A header's value (the name in lower case). */
  header(name: string): string | undefined;
  body(): AsyncIterable<Uint8Array>;
}

/** An answer: bytes, a stream (a snapshot file, closed when it ends or is dropped), or nothing (HEAD, 304). */
interface Answer {
  status: number;
  headers: Record<string, string>;
  body?: Uint8Array | Readable;
}

function json(status: number, body: unknown): Answer {
  const bytes = Buffer.from(JSON.stringify(body));
  return { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": String(bytes.byteLength) }, body: bytes };
}

async function readBody(asked: Asked): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of asked.body()) {
    size += chunk.byteLength;
    if (size > MAX_BODY) throw new HttpError(413, "リクエストが大きすぎます");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function fromNode(req: IncomingMessage): Asked {
  return {
    method: req.method ?? "GET",
    pathname: new URL(req.url ?? "/", "http://localhost").pathname,
    header: (name) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v.join(", ") : v;
    },
    body: () => req,
  };
}

function fromFetch(request: Request): Asked {
  return {
    method: request.method,
    pathname: new URL(request.url).pathname,
    // Never gzipped here: Next.js drops a Response's Content-Encoding, and the browser would read gzip as Arrow.
    // The server or the proxy in front compresses instead.
    header: (name) => (name === "accept-encoding" ? undefined : (request.headers.get(name) ?? undefined)),
    body: () => chunksOf(request.body),
  };
}

async function* chunksOf(stream: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!stream) return;
  const reader = stream.getReader();
  let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      yield next.value;
    }
    done = true;
  } finally {
    // Stopped early (too large): the rest is not read.
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** The read-only API: `GET …/api/schema` lists the SQL files, `POST …/api/query` runs one and returns Arrow. */
export function createApiHandler(options: ApiOptions): ApiHandler {
  const env = options.env ?? process.env;
  const maxRows = options.maxRows ?? 1_000_000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const log = options.log ?? (() => undefined);
  const connections = new Map<string, Promise<Connection>>();

  const urlOf = (connection?: string) => {
    const variable = connectionVariable(connection);
    const url = env[variable]?.trim();
    if (!url) throw new HttpError(500, `接続先がありません。環境変数 ${variable} に接続先の URL を書いてください`);
    return url;
  };
  const open = (url: string) => {
    let c = connections.get(url);
    if (!c) {
      c = connect(url, options.dir);
      connections.set(url, c);
      c.catch(() => connections.delete(url));
    }
    return c;
  };

  const schema = async () => {
    const datasets = [];
    for (const name of await listDatasets(options.dir)) {
      try {
        const text = await readDatasetText(options.dir, name);
        // Checked with the quoting rules of its database ([brackets], $$ … $$), or all of them when that is unknown.
        const d = parseDataset(name, text, dialectOf(env[connectionVariable(connectionOf(text))] ?? ""));
        datasets.push({
          name,
          description: d.description,
          params: d.params,
          connection: connectionVariable(d.connection),
          ...(d.snapshot ? { snapshot: d.snapshot } : {}),
        });
      } catch (e) {
        datasets.push({ name, error: (e as Error).message });
      }
    }
    return { datasets, snapshots: await snapshots.status() };
  };

  /** api/<name>.sql with the parameters: the Arrow IPC stream and the row count. */
  const run = async (name: string, params: Record<string, unknown> = {}) => {
    const text = await readDatasetText(options.dir, name);
    const connection = connectionOf(text);
    const url = urlOf(connection);
    let conn: Connection;
    try {
      conn = await open(url);
    } catch (e) {
      const detail = (e as Error).message;
      log(`${connectionVariable(connection)}: ${detail}`);
      throw new HttpError(500, options.exposeErrors ? `データベースにつなげません: ${detail}` : "データベースにつなげません（くわしくはサーバーのログにあります）");
    }
    // Checked with the database's quoting rules ([brackets], $$ … $$), which the read-only check depends on.
    const dataset = parseDataset(name, text, conn.dialect);
    const bound = bindParameters(dataset, conn.dialect, params as Record<string, unknown>);
    let result;
    try {
      // One row past the limit tells whether there were more.
      result = await conn.query(bound.sql, bound.params, { timeoutMs, maxRows: maxRows + 1 });
    } catch (e) {
      const detail = (e as Error).message;
      log(`api/${name}.sql: ${detail}`);
      throw new HttpError(500, options.exposeErrors ? `api/${name}.sql: ${detail}` : `api/${name}.sql を実行できませんでした（くわしくはサーバーのログにあります）`);
    }
    if (result.rows.length > maxRows) {
      throw new HttpError(422, `api/${name}.sql の結果が ${maxRows.toLocaleString("en-US")} 行を超えました。SQL の WHERE で絞ってください`);
    }
    return { bytes: toArrowStream(result), rows: result.rows.length };
  };

  const query = async (asked: Asked): Promise<Answer> => {
    if (!/^application\/json\b/i.test(asked.header("content-type") ?? "")) {
      // JSON only: a page on another site cannot send it without the browser asking this server first (CORS).
      throw new HttpError(415, "Content-Type: application/json で送ってください");
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(asked));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "リクエストの JSON を読めません");
    }
    const { name, params = {} } = (body ?? {}) as { name?: unknown; params?: unknown };
    if (typeof name !== "string" || !name) throw new HttpError(400, "name（api/ の SQL ファイルの名前）がありません");
    if (typeof params !== "object" || params === null || Array.isArray(params)) throw new HttpError(400, "params はオブジェクトで送ってください");

    const started = Date.now();
    const result = await run(name, params as Record<string, unknown>);
    let bytes = result.bytes;
    const headers: Record<string, string> = { "Content-Type": ARROW_STREAM, "Cache-Control": "no-store", "X-DevBI-Rows": String(result.rows), Vary: "Accept-Encoding" };
    // Arrow keeps text as it is: gzip makes it several times smaller on the way.
    if (bytes.byteLength > 8192 && /\bgzip\b/.test(asked.header("accept-encoding") ?? "")) {
      bytes = await gzipAsync(bytes, { level: 4 });
      headers["Content-Encoding"] = "gzip";
    }
    headers["Content-Length"] = String(bytes.byteLength);
    log(`api/${name}.sql: ${result.rows.toLocaleString("en-US")} 行、${Date.now() - started} ms`);
    return { status: 200, headers, body: bytes };
  };

  const snapshots = createSnapshots({
    dir: options.dir,
    run,
    log,
    exposeErrors: options.exposeErrors ?? false,
    ...(options.snapshotDir ? { outDir: options.snapshotDir } : {}),
  });

  // GET …/snapshots/<file>: the saved file (made first when missing), or in the dev server the rows as they are now.
  const snapshot = async (asked: Asked, file: string): Promise<Answer> => {
    const found = await snapshots.get(file);
    let handle: FileHandle | undefined;
    try {
      let at: Date;
      let size: number | undefined;
      if ("path" in found) {
        // Opened first, then its time and size: tomorrow's file renamed over it meanwhile does not mix with it.
        handle = await openFile(found.path, "r");
        const info = await handle.stat();
        at = info.mtime;
        size = info.size;
      } else {
        at = found.at;
      }
      const gz = /\bgzip\b/.test(asked.header("accept-encoding") ?? "");
      const headers: Record<string, string> = {
        "Content-Type": ARROW_STREAM,
        // Checked each time: the file changes every morning under the same name.
        "Cache-Control": "no-cache",
        "Last-Modified": at.toUTCString(),
        ...(found.rows !== undefined ? { "X-DevBI-Rows": String(found.rows) } : {}),
        Vary: "Accept-Encoding",
      };
      const since = Date.parse(asked.header("if-modified-since") ?? "");
      if (Number.isFinite(since) && Math.floor(at.getTime() / 1000) <= Math.floor(since / 1000)) return { status: 304, headers };
      if ("bytes" in found) {
        let bytes = found.bytes;
        if (gz && bytes.byteLength > 8192) {
          bytes = await gzipAsync(bytes, { level: 4 });
          headers["Content-Encoding"] = "gzip";
        }
        headers["Content-Length"] = String(bytes.byteLength);
        return { status: 200, headers, body: bytes };
      }
      const zip = gz && size! > 8192;
      if (zip) headers["Content-Encoding"] = "gzip";
      else headers["Content-Length"] = String(size!);
      if (asked.method === "HEAD") return { status: 200, headers };
      // The stream closes the file when it ends or the browser goes away (on Windows an open file cannot be replaced).
      const stream = handle!.createReadStream();
      handle = undefined;
      if (!zip) return { status: 200, headers, body: stream };
      const zipped = createGzip({ level: 4 });
      stream.on("error", (e) => zipped.destroy(e));
      zipped.on("close", () => stream.destroy());
      return { status: 200, headers, body: stream.pipe(zipped) };
    } finally {
      await handle?.close();
    }
  };

  /** The answer for an API path, or undefined for others. */
  const answer = async (asked: Asked): Promise<Answer | undefined> => {
    const m = /\/api\/(schema|query)$|\/snapshots\/([^/]+\.arrows)$/.exec(asked.pathname);
    if (!m) return undefined;
    const { method } = asked;
    let a: Answer;
    try {
      if (m[2]) {
        if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "GET で呼んでください");
        let file: string;
        try {
          file = decodeURIComponent(m[2]);
        } catch {
          throw new HttpError(404, "スナップショットの名前を読めません");
        }
        a = await snapshot(asked, file);
      } else if (m[1] === "schema") {
        if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "GET で呼んでください");
        a = json(200, await schema());
      } else {
        if (method !== "POST") throw new HttpError(405, "POST で呼んでください");
        a = await query(asked);
      }
    } catch (e) {
      const status = e instanceof HttpError || e instanceof DatasetError ? e.status : 500;
      const message = (e as Error).message;
      if (status >= 500) log(message);
      a = json(status, { error: message });
    }
    if (method === "HEAD" && a.body) {
      if (a.body instanceof Readable) a.body.destroy();
      a = { status: a.status, headers: a.headers };
    }
    return a;
  };

  return {
    async handle(req, res) {
      const a = await answer(fromNode(req));
      if (!a) return false;
      res.writeHead(a.status, a.headers);
      if (a.body instanceof Readable) await pipeline(a.body, res).catch(() => undefined);
      else res.end(a.body);
      return true;
    },
    async fetch(request) {
      const a = await answer(fromFetch(request));
      if (!a) return undefined;
      if (!(a.body instanceof Readable)) return new Response((a.body as Uint8Array<ArrayBuffer> | undefined) ?? null, { status: a.status, headers: a.headers });
      // A snapshot file: closed when the browser goes away, also before the server starts sending (Next.js then
      // never reads or cancels the body, and an open file cannot be replaced on Windows).
      const stream = a.body;
      const stop = () => stream.destroy();
      if (request.signal.aborted) {
        stop();
        return new Response(null, { status: a.status, headers: a.headers });
      }
      request.signal.addEventListener("abort", stop, { once: true });
      stream.once("close", () => request.signal.removeEventListener("abort", stop));
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array<ArrayBuffer>>, { status: a.status, headers: a.headers });
    },
    run,
    snapshots,
    async close() {
      snapshots.stop();
      await snapshots.idle();
      const all = [...connections.values()];
      connections.clear();
      await Promise.all(all.map((c) => c.then((x) => x.close()).catch(() => undefined)));
    },
  };
}
