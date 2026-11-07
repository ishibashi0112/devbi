import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
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
  /** How long one query may run, in milliseconds (PostgreSQL). Default 60,000. */
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

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "リクエストが大きすぎます");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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
    // One row past the limit tells whether there were more.
    const limited = `SELECT * FROM (\n${bound.sql}\n) AS devbi_rows LIMIT ${maxRows + 1}`;
    let result;
    try {
      result = await conn.query(limited, bound.params, { timeoutMs });
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

  const query = async (req: IncomingMessage, res: ServerResponse) => {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      // JSON only: a page on another site cannot send it without the browser asking this server first (CORS).
      throw new HttpError(415, "Content-Type: application/json で送ってください");
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
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
    const headers: Record<string, string | number> = { "Content-Type": ARROW_STREAM, "Cache-Control": "no-store", "X-DevBI-Rows": String(result.rows), Vary: "Accept-Encoding" };
    // Arrow keeps text as it is: gzip makes it several times smaller on the way.
    if (bytes.byteLength > 8192 && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
      bytes = await gzipAsync(bytes, { level: 4 });
      headers["Content-Encoding"] = "gzip";
    }
    headers["Content-Length"] = bytes.byteLength;
    res.writeHead(200, headers);
    res.end(bytes);
    log(`api/${name}.sql: ${result.rows.toLocaleString("en-US")} 行、${Date.now() - started} ms`);
  };

  const snapshots = createSnapshots({ dir: options.dir, run, log, ...(options.snapshotDir ? { outDir: options.snapshotDir } : {}) });

  // GET …/snapshots/<file>: the saved file (made first when missing), or in the dev server the rows as they are now.
  const snapshot = async (req: IncomingMessage, res: ServerResponse, file: string) => {
    const found = await snapshots.get(file);
    const head = req.method === "HEAD";
    const gz = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    const headers: Record<string, string | number> = {
      "Content-Type": ARROW_STREAM,
      // Checked each time: the file changes every morning under the same name.
      "Cache-Control": "no-cache",
      "Last-Modified": found.at.toUTCString(),
      ...(found.rows !== undefined ? { "X-DevBI-Rows": String(found.rows) } : {}),
      Vary: "Accept-Encoding",
    };
    const since = Date.parse(String(req.headers["if-modified-since"] ?? ""));
    if (Number.isFinite(since) && Math.floor(found.at.getTime() / 1000) <= Math.floor(since / 1000)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    if ("bytes" in found) {
      let bytes = found.bytes;
      if (gz && bytes.byteLength > 8192) {
        bytes = await gzipAsync(bytes, { level: 4 });
        headers["Content-Encoding"] = "gzip";
      }
      headers["Content-Length"] = bytes.byteLength;
      res.writeHead(200, headers);
      res.end(head ? undefined : bytes);
      return;
    }
    if (gz && found.size > 8192) headers["Content-Encoding"] = "gzip";
    else headers["Content-Length"] = found.size;
    res.writeHead(200, headers);
    if (head) {
      res.end();
      return;
    }
    const stream = createReadStream(found.path).on("error", () => res.destroy());
    (gz && found.size > 8192 ? stream.pipe(createGzip({ level: 4 })) : stream).pipe(res);
  };

  return {
    async handle(req, res) {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const m = /\/api\/(schema|query)$|\/snapshots\/([^/]+\.arrows)$/.exec(pathname);
      if (!m) return false;
      try {
        if (m[2]) {
          if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "GET で呼んでください");
          let file: string;
          try {
            file = decodeURIComponent(m[2]);
          } catch {
            throw new HttpError(404, "スナップショットの名前を読めません");
          }
          await snapshot(req, res, file);
        } else if (m[1] === "schema") {
          if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "GET で呼んでください");
          sendJson(res, 200, await schema());
        } else {
          if (req.method !== "POST") throw new HttpError(405, "POST で呼んでください");
          await query(req, res);
        }
      } catch (e) {
        const status = e instanceof HttpError || e instanceof DatasetError ? e.status : 500;
        const message = (e as Error).message;
        if (status >= 500) log(message);
        if (!res.headersSent) sendJson(res, status, { error: message });
        else res.end();
      }
      return true;
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
