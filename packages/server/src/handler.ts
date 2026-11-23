import { existsSync } from "node:fs";
import { open as openFile, readFile, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AccessLineError, accessLines, isBareUser, logSafe, mergeViewer, rowLevelSignal, tableUserOf, viewerOf, type DevBIUser, type TableUser, type Viewer } from "./access.js";
import { toArrowStream } from "./arrow.js";
import { connect, dialectOf, type Connection, type DescribedColumn } from "./connect.js";
import {
  DatasetError,
  bindParameters,
  connectionOf,
  connectionVariable,
  describeUser,
  describeValues,
  listDatasets,
  parseDataset,
  readDatasetText,
  type BindUser,
  type Dataset,
} from "./datasets.js";
import { errorText } from "./result.js";
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
  /**
   * Also answer `POST …/api/describe` (`{ name }` → the SQL file's columns as the database describes them): for
   * the dev server, where the GUI editor lists a dataset's columns. Off (devbi-serve, apps): that path is 404.
   */
  describe?: boolean;
  /**
   * Row-level mode whatever the files say (docs/design/row-level-security.md 6.4; set it in production when the SQL
   * filters by user): every request needs a signed-in user (401), and every `api/*.sql` must say who sees which rows
   * (`:user.…` or `-- access: all`). Without it, the mode is on when the files use row-level security (`:user.`,
   * `-- roles`, `-- access` in an `api/*.sql`, or an `access/` folder).
   */
  requireUser?: boolean;
  /** How long what `access/user.sql` says of a user is kept, in milliseconds. Default 60,000; 0 reads it each time. */
  userCacheMs?: number;
}

/** Who is asking, as the host found out: `handle(req, res, { user })`, `fetch(request, { user })`, `run(name, params, { user })`. */
export interface RequestOptions {
  /** The signed-in user. `undefined` or `null`: nobody signed in. */
  user?: DevBIUser | null;
}

/** `api/describe`'s answer: the columns of a dataset's result, without running it for rows. */
export interface DatasetColumns {
  name: string;
  columns: DescribedColumn[];
}

export interface ApiHandler {
  /**
   * Answer the request when its path ends in `/api/schema`, `/api/query` or `/snapshots/<file>.arrows` (whatever
   * comes before, so the API sits next to the dashboards under any base path). Resolves false for other requests.
   */
  handle(req: IncomingMessage, res: ServerResponse, options?: RequestOptions): Promise<boolean>;
  /**
   * The same with the web's `Request` and `Response` (Next.js route handlers and other servers built on them): the
   * answer, or undefined for other paths. Not gzipped (Next.js drops a Response's Content-Encoding): the server or
   * the proxy in front compresses.
   */
  fetch(request: Request, options?: RequestOptions): Promise<Response | undefined>;
  /**
   * Run `api/<name>.sql` with the parameters: the Arrow IPC stream `POST …/api/query` answers, and its row count.
   * The same checks as `api/query` (with `options.user` as the signed-in user); errors carry their HTTP `status`.
   */
  run(name: string, params?: Record<string, unknown>, options?: RequestOptions): Promise<{ bytes: Uint8Array; rows: number }>;
  /**
   * The columns `api/<name>.sql` returns, asking its database without its rows (any parameter values that pass the
   * checks, `"1"` for the user's). For tools (devbi-check, pnpm gen) whatever `describe` says, and without a user
   * (no rows are read); `POST …/api/describe` only with it.
   */
  describe(name: string): Promise<DatasetColumns>;
  /** The snapshots of the `read_api` calls in models/ whose SQL file has a `-- snapshot:` line. */
  snapshots: Snapshots;
  /** Close the database connections. */
  close(): Promise<void>;
}

export const ARROW_STREAM = "application/vnd.apache.arrow.stream";
/** Room for a multiple-value parameter: up to 1,000 values. */
const MAX_BODY = 256 * 1024;
/** How long a database may take to describe a dataset's columns (api/describe). */
const DESCRIBE_TIMEOUT_MS = 20_000;

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
/** Row-level mode, and why it is on (for the messages). */
interface Mode {
  on: boolean;
  why?: string;
}

/**
 * Who asks: a snapshot job inside DevBI (it runs only `-- access: all` SQL in row-level mode), or a request with the
 * signed-in user the host handed over (none: not signed in), read with `access/user.sql` only when a check needs it.
 */
type Asker = { job: true } | RequestAsker;
type RequestAsker = { job?: false; viewer: Viewer | undefined; resolved(): Promise<Viewer> };

const NOT_SIGNED_IN = "ログインしていません";
const USER_FILE = "access/user.sql";
/** Users kept from access/user.sql at most (the oldest go first). */
const MAX_CACHED_USERS = 10_000;

/** The read-only API: `GET …/api/schema` lists the SQL files, `POST …/api/query` runs one and returns Arrow. */
export function createApiHandler(options: ApiOptions): ApiHandler {
  const env = options.env ?? process.env;
  const maxRows = options.maxRows ?? 1_000_000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const userCacheMs = options.userCacheMs ?? 60_000;
  const log = options.log ?? (() => undefined);
  const connections = new Map<string, Promise<Connection>>();
  let warnedNoMode = false;

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
  /** The connection a file's `-- connection:` line names (DEVBI_DB without one). */
  const connectionFor = async (connection: string | undefined): Promise<Connection> => {
    const url = urlOf(connection);
    try {
      return await open(url);
    } catch (e) {
      const detail = errorText(e);
      log(`${connectionVariable(connection)}: ${detail}`);
      throw new HttpError(500, options.exposeErrors ? `データベースにつなげません: ${detail}` : "データベースにつなげません（くわしくはサーバーのログにあります）");
    }
  };

  /**
   * Row-level mode: the host's `requireUser`, or the project's files using row-level security (an `access/` folder,
   * `:user.`, `-- roles` or `-- access` in the text of an `api/*.sql`). Read again for each request, like the SQL.
   */
  const modeOf = async (): Promise<Mode> => {
    if (options.requireUser) return { on: true, why: "ホストの設定 requireUser" };
    if (existsSync(path.join(options.dir, "access"))) return { on: true, why: "access/ フォルダがあるため" };
    for (const name of await listDatasets(options.dir)) {
      let text: string;
      try {
        text = await readDatasetText(options.dir, name);
      } catch {
        // a file that cannot be read now may be one that filters: on, rather than off
        return { on: true, why: `api/${name}.sql を読めないため` };
      }
      const signal = rowLevelSignal(text);
      if (signal) return { on: true, why: `api/${name}.sql に ${signal} があるため` };
    }
    return { on: false };
  };
  const modeFor = async (asker: Asker): Promise<Mode> => {
    const mode = await modeOf();
    if (!mode.on && !asker.job && asker.viewer && !warnedNoMode) {
      warnedNoMode = true;
      log("利用者を受け取っていますが、行レベルのモードになっていません（api/*.sql に :user. も -- access: もありません。本番では requireUser を付けます）");
    }
    return mode;
  };

  // What access/user.sql says of each user, kept userCacheMs (failures are not kept).
  const userCache = new Map<string, { until: number; value: Promise<TableUser | undefined> }>();
  const lookUp = async (id: string): Promise<TableUser | undefined> => {
    let text: string;
    try {
      text = await readFile(path.join(options.dir, "access", "user.sql"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    const conn = await connectionFor(connectionOf(text));
    let d: Dataset;
    try {
      d = parseDataset("user", text, conn.dialect, USER_FILE);
    } catch (e) {
      throw new HttpError(500, (e as Error).message);
    }
    const other = d.params[0] ?? (d.user ?? []).find((a) => a !== "id");
    if (other !== undefined) throw new HttpError(500, `${USER_FILE}: 使えるパラメーターは :user.id だけです（:${d.params[0] ?? `user.${other}`} があります）`);
    if (!d.user?.includes("id")) throw new HttpError(500, `${USER_FILE}: :user.id で、ログインした人の行を選んでください（WHERE u.login = :user.id）`);
    if (d.snapshot || d.roles || d.access || d.key) throw new HttpError(500, `${USER_FILE}: -- snapshot:・-- roles:・-- access:・-- key: は書けません`);
    const bound = bindParameters(d, conn.dialect, {}, { user: { id, attrs: new Map() }, rel: USER_FILE });
    let result;
    try {
      result = await conn.query(bound.sql, bound.params, { timeoutMs, maxRows: 2 });
    } catch (e) {
      const detail = errorText(e);
      log(`${USER_FILE}: ${detail}`);
      throw new HttpError(500, options.exposeErrors ? `${USER_FILE}: ${detail}` : `${USER_FILE} を実行できませんでした（くわしくはサーバーのログにあります）`);
    }
    if (result.rows.length > 1) throw new HttpError(500, `${USER_FILE} が利用者 ${id} の行を 2 行以上返しました。1 人につき 1 行（いなければ 0 行）にしてください`);
    try {
      return tableUserOf(
        result.columns.map((c) => c.name),
        result.rows[0],
      );
    } catch (e) {
      throw new HttpError(500, (e as Error).message);
    }
  };
  const tableUser = (id: string): Promise<TableUser | undefined> => {
    const now = Date.now();
    const kept = userCache.get(id);
    if (kept && kept.until > now) return kept.value;
    const value = lookUp(id);
    if (userCacheMs > 0) {
      userCache.delete(id);
      userCache.set(id, { until: now + userCacheMs, value });
      if (userCache.size > MAX_CACHED_USERS) userCache.delete(userCache.keys().next().value!);
      value.catch(() => {
        if (userCache.get(id)?.value === value) userCache.delete(id);
      });
    }
    return value;
  };

  /** The asker of a request: the host's user, checked (a TypeError for a wrong shape). */
  const askerOf = (user: DevBIUser | null | undefined): RequestAsker => {
    const viewer = viewerOf(user);
    let full: Promise<Viewer> | undefined;
    return {
      viewer,
      resolved: () => {
        if (!viewer) return Promise.reject(new HttpError(401, NOT_SIGNED_IN));
        return (full ??= tableUser(viewer.id).then((t) => mergeViewer(viewer, t)));
      },
    };
  };

  /** Row-level mode's rules for one file: it says who sees which rows, and no bare `:user`. Throws DatasetError (400). */
  const checkRowLevel = (dataset: Dataset, mode: Mode) => {
    if (!mode.on) return;
    const rel = `api/${dataset.name}.sql`;
    const bare = dataset.params.find(isBareUser);
    if (bare !== undefined) {
      throw new DatasetError(`${rel}: 行レベルのモードでは :${bare} は使えません。ログインした人の ID なら :user.id と書きます（行レベルのモード: ${mode.why}）`, 400);
    }
    if (!dataset.user?.length && dataset.access !== "all") {
      throw new DatasetError(
        `${rel} は、だれにどの行を見せるかが書いてありません。:user.… で絞るか、全員に全部の行を見せるなら -- access: all を書いてください（行レベルのモード: ${mode.why}）`,
        400,
      );
    }
  };

  /** Whether the asker may read a file with these `-- roles:` (none: anyone the mode lets in). */
  const mayRead = async (roles: string[] | undefined, asker: Asker): Promise<boolean> => {
    if (!roles) return true;
    if (asker.job || !asker.viewer) return false;
    const v = await asker.resolved();
    return roles.some((r) => v.roles.has(r));
  };

  const schema = async (asker: Asker, mode: Mode) => {
    if (mode.on && !asker.job && !asker.viewer) throw new HttpError(401, NOT_SIGNED_IN);
    const datasets = [];
    for (const name of await listDatasets(options.dir)) {
      try {
        const text = await readDatasetText(options.dir, name);
        // Only those the user may read: the others are not even named.
        let roles: string[] | undefined;
        try {
          roles = accessLines(text, `api/${name}.sql`).roles;
        } catch (e) {
          if (e instanceof AccessLineError) throw new DatasetError(e.message, 400);
          throw e;
        }
        if (!(await mayRead(roles, asker))) continue;
        // Checked with the quoting rules of its database ([brackets], $$ … $$), or all of them when that is unknown.
        const d = parseDataset(name, text, dialectOf(env[connectionVariable(connectionOf(text))] ?? ""));
        checkRowLevel(d, mode);
        datasets.push({
          name,
          description: d.description,
          params: d.params,
          parameters: d.parameters,
          ...(d.key ? { key: d.key } : {}),
          connection: connectionVariable(d.connection),
          ...(d.snapshot ? { snapshot: d.snapshot } : {}),
        });
      } catch (e) {
        if (e instanceof HttpError && e.status >= 500) throw e;
        datasets.push({ name, error: (e as Error).message });
      }
    }
    const viewer = asker.job ? undefined : asker.viewer;
    return { datasets, snapshots: await snapshots.status(), access: 1, ...(viewer ? { user: { id: viewer.id } } : {}) };
  };

  /** api/<name>.sql parsed for its database, and that database's connection. */
  const prepare = async (name: string) => {
    const text = await readDatasetText(options.dir, name);
    const conn = await connectionFor(connectionOf(text));
    // Checked with the database's quoting rules ([brackets], $$ … $$), which the read-only check depends on.
    return { conn, dataset: parseDataset(name, text, conn.dialect) };
  };

  /**
   * api/<name>.sql for this asker, in order: signed in (row-level mode), the file's rules, its roles, and the user
   * with the attributes the SQL uses. Throws HttpError / DatasetError (401, 403, 400, 404, 500).
   */
  const authorize = async (name: string, asker: Asker, mode: Mode): Promise<{ conn: Connection; dataset: Dataset; user?: BindUser }> => {
    if (mode.on && !asker.job && !asker.viewer) throw new HttpError(401, NOT_SIGNED_IN);
    const { conn, dataset } = await prepare(name);
    checkRowLevel(dataset, mode);
    if (asker.job || !asker.viewer) {
      if (dataset.roles) throw new HttpError(asker.job ? 403 : 401, asker.job ? `api/${name}.sql には -- roles: があるので、ジョブでは実行できません` : NOT_SIGNED_IN);
      return { conn, dataset };
    }
    // access/user.sql only when a check needs more than the id
    const needsMore = !!dataset.roles || (dataset.user ?? []).some((a) => a !== "id");
    const viewer = needsMore ? await asker.resolved() : asker.viewer;
    if (dataset.roles && !dataset.roles.some((r) => viewer.roles.has(r))) throw new HttpError(403, `api/${name}.sql を読む役割がありません（利用者 ${viewer.id}）`);
    return { conn, dataset, user: viewer };
  };

  /** api/<name>.sql with the parameters, for this asker: the Arrow IPC stream and the row count. */
  const runAs = async (name: string, params: Record<string, unknown>, asker: Asker, known?: Mode) => {
    const mode = known ?? (await modeFor(asker));
    const { conn, dataset, user } = await authorize(name, asker, mode);
    const bound = bindParameters(dataset, conn.dialect, params, { ...(user ? { user } : {}), rowLevel: mode.on });
    let result;
    try {
      // One row past the limit tells whether there were more.
      result = await conn.query(bound.sql, bound.params, { timeoutMs, maxRows: maxRows + 1 });
    } catch (e) {
      const detail = errorText(e);
      log(`api/${name}.sql: ${detail}`);
      throw new HttpError(500, options.exposeErrors ? `api/${name}.sql: ${detail}` : `api/${name}.sql を実行できませんでした（くわしくはサーバーのログにあります）`);
    }
    if (result.rows.length > maxRows) {
      throw new HttpError(422, `api/${name}.sql の結果が ${maxRows.toLocaleString("en-US")} 行を超えました。SQL の WHERE で絞ってください`);
    }
    return { bytes: toArrowStream(result), rows: result.rows.length };
  };
  const run = (name: string, params: Record<string, unknown> = {}, request: RequestOptions = {}) => runAs(name, params, askerOf(request.user));
  const job: Asker = { job: true };
  const runJob = (name: string, params: Record<string, unknown>) => runAs(name, params, job);

  /** The columns of api/<name>.sql: for tools without a user, or for a request with the same checks as api/query. */
  const describeAs = async (name: string, asker?: Asker): Promise<DatasetColumns> => {
    let conn: Connection;
    let dataset: Dataset;
    if (asker) ({ conn, dataset } = await authorize(name, asker, await modeFor(asker)));
    else ({ conn, dataset } = await prepare(name));
    if (!conn.describe) throw new HttpError(501, `この接続先（${conn.dialect}）では列を聞けません`);
    const bound = bindParameters(dataset, conn.dialect, describeValues(dataset), { user: describeUser(dataset) });
    try {
      // Shorter than a query's limit: it reads no rows, and a wait is for a lock or a database that does not answer.
      return { name, columns: await conn.describe(bound.sql, bound.params, { timeoutMs: Math.min(timeoutMs, DESCRIBE_TIMEOUT_MS) }) };
    } catch (e) {
      const detail = errorText(e);
      log(`api/${name}.sql: ${detail}`);
      throw new HttpError(500, options.exposeErrors ? `api/${name}.sql: ${detail}` : `api/${name}.sql の列を聞けませんでした（くわしくはサーバーのログにあります）`);
    }
  };

  /** The request's JSON body. */
  const jsonBody = async (asked: Asked): Promise<unknown> => {
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
    return body;
  };

  /** `CORP\yamada ` before a log line, when someone signed in asked. */
  const by = (asker: Asker) => (!asker.job && asker.viewer ? `${logSafe(asker.viewer.id)} ` : "");

  const query = async (asked: Asked, asker: Asker, mode: Mode): Promise<Answer> => {
    // Signed in before anything else is read (the body, the file's name).
    if (mode.on && !asker.job && !asker.viewer) throw new HttpError(401, NOT_SIGNED_IN);
    const { name, params = {} } = ((await jsonBody(asked)) ?? {}) as { name?: unknown; params?: unknown };
    if (typeof name !== "string" || !name) throw new HttpError(400, "name（api/ の SQL ファイルの名前）がありません");
    if (typeof params !== "object" || params === null || Array.isArray(params)) throw new HttpError(400, "params はオブジェクトで送ってください");

    const started = Date.now();
    const result = await runAs(name, params as Record<string, unknown>, asker, mode);
    let bytes = result.bytes;
    const headers: Record<string, string> = { "Content-Type": ARROW_STREAM, "Cache-Control": "no-store", "X-DevBI-Rows": String(result.rows), Vary: "Accept-Encoding" };
    // Arrow keeps text as it is: gzip makes it several times smaller on the way.
    if (bytes.byteLength > 8192 && /\bgzip\b/.test(asked.header("accept-encoding") ?? "")) {
      bytes = await gzipAsync(bytes, { level: 4 });
      headers["Content-Encoding"] = "gzip";
    }
    headers["Content-Length"] = String(bytes.byteLength);
    log(`${by(asker)}api/${name}.sql: ${result.rows.toLocaleString("en-US")} 行、${Date.now() - started} ms`);
    return { status: 200, headers, body: bytes };
  };

  const snapshots = createSnapshots({
    dir: options.dir,
    env,
    run: runJob,
    // a project that cannot be read now may be one that filters: on, rather than off
    rowLevel: () => modeOf().then((m) => m.on, () => true),
    log,
    exposeErrors: options.exposeErrors ?? false,
    ...(options.snapshotDir ? { outDir: options.snapshotDir } : {}),
  });

  // GET …/snapshots/<file>: the saved file (made first when missing), or in the dev server the rows as they are now.
  const snapshot = async (asked: Asked, file: string, asker: Asker, mode: Mode): Promise<Answer> => {
    // Signed in before it is made or read (only `-- access: all` SQL has snapshots in row-level mode).
    if (mode.on && !asker.job && !asker.viewer) throw new HttpError(401, NOT_SIGNED_IN);
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
  const answer = async (asked: Asked, request: RequestOptions = {}): Promise<Answer | undefined> => {
    const m = (options.describe ? /\/api\/(schema|query|describe)$|\/snapshots\/([^/]+\.arrows)$/ : /\/api\/(schema|query)$|\/snapshots\/([^/]+\.arrows)$/).exec(asked.pathname);
    if (!m) return undefined;
    const { method } = asked;
    let a: Answer;
    try {
      const asker = askerOf(request.user);
      const mode = await modeFor(asker);
      if (m[2]) {
        if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "GET で呼んでください");
        let file: string;
        try {
          file = decodeURIComponent(m[2]);
        } catch {
          throw new HttpError(404, "スナップショットの名前を読めません");
        }
        a = await snapshot(asked, file, asker, mode);
      } else if (m[1] === "schema") {
        if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "GET で呼んでください");
        a = json(200, await schema(asker, mode));
      } else if (m[1] === "describe") {
        if (method !== "POST") throw new HttpError(405, "POST で呼んでください");
        if (mode.on && !asker.viewer) throw new HttpError(401, NOT_SIGNED_IN);
        const { name } = ((await jsonBody(asked)) ?? {}) as { name?: unknown };
        if (typeof name !== "string" || !name) throw new HttpError(400, "name（api/ の SQL ファイルの名前）がありません");
        a = json(200, await describeAs(name, asker));
      } else {
        if (method !== "POST") throw new HttpError(405, "POST で呼んでください");
        a = await query(asked, asker, mode);
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
    async handle(req, res, request) {
      const a = await answer(fromNode(req), request);
      if (!a) return false;
      res.writeHead(a.status, a.headers);
      if (a.body instanceof Readable) await pipeline(a.body, res).catch(() => undefined);
      else res.end(a.body);
      return true;
    },
    async fetch(request, asked) {
      const a = await answer(fromFetch(request), asked);
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
    describe: (name) => describeAs(name),
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
