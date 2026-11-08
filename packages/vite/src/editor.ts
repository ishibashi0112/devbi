import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { DashboardError, defineDashboard, formatDashboardJson, type Dashboard } from "devbi";

/** Where the GUI editor reads and writes dash.json files on the dev server (after Vite's base). */
export const EDITOR_PATH = "__devbi/editor/";

/** A new dashboard's file name: letters, digits, - and _ (it is also the page's address, #/<name>). */
export const NEW_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const MAX_BODY = 1024 * 1024;

export interface EditorOptions {
  /** The project folder (dashboards/, models/). */
  dir: string;
  /** Whether a Host header names this dev server (Vite's allowedHosts): no DNS rebinding. */
  allowedHost(host: string): boolean | Promise<boolean>;
  /** Problems with the files a dashboard points at (metrics files, promoted tiles), as in the build. */
  problems(rel: string, dashboard: Dashboard): string[];
  /** After a save: the file, its content's version, and the page that saved it (from `X-DevBI-Client`). */
  onWrite?(file: string, version: string, client: string | undefined): void;
}

/** The version of a file's content that the editor read: a save is refused when the file changed since. */
export function versionOf(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Loopback, or the machine's own address (the dev server opened by its LAN address on the same computer). */
function sameMachine(req: IncomingMessage): boolean {
  const remote = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const local = (req.socket.localAddress ?? "").replace(/^::ffff:/, "");
  if (remote === "::1" || (isIP(remote) === 4 && remote.startsWith("127."))) return true;
  return remote !== "" && remote === local;
}

/** An existing dashboard's name as it appears in a URL: any file name, but not a path. */
function plainName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\\0-\x1f]/.test(name) && name.length <= 200;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "送られた内容が大きすぎます（1 MB まで）");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON として読めません");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/**
 * The dev server's side of the GUI editor: `GET …/__devbi/editor/dashboards/<name>` returns the file as written
 * (`{ spec, version }`), `PUT` with `{ spec, version }` checks it like the build does and writes it in the
 * hand-written style. `version: null` creates a new file. Only from this computer, only from the dev server's own
 * pages, and only `dashboards/<name>.dash.json`.
 */
export function createEditorHandler(options: EditorOptions) {
  const dashDir = path.join(options.dir, "dashboards");
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const at = url.pathname.indexOf(`/${EDITOR_PATH}`);
    if (at < 0) return false;
    const route = url.pathname.slice(at + EDITOR_PATH.length + 1);
    try {
      const host = req.headers.host;
      if (!host || !(await options.allowedHost(host))) throw new HttpError(403, `${host ?? "(Host なし)"} からは使えません（Vite の server.allowedHosts）`);
      if (!sameMachine(req)) throw new HttpError(403, "GUI エディタは、dev server を動かしているパソコンで開いたページからだけ使えます");
      // Another site open in the same browser cannot write: a custom header needs CORS, and the Origin must be this server.
      if (req.headers["x-devbi-editor"] !== "1") throw new HttpError(403, "GUI エディタからの要求ではありません");
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== "null") {
        let host = "";
        try {
          host = new URL(origin).host;
        } catch {
          // left empty: refused below
        }
        if (host !== req.headers.host) throw new HttpError(403, `ほかのサイト（${origin}）からは書き込めません`);
      } else if (origin === "null") {
        throw new HttpError(403, "ほかのサイトからは書き込めません");
      }
      const match = /^dashboards\/([^/]+)$/.exec(route);
      if (!match) throw new HttpError(404, "ありません");
      let name: string;
      try {
        name = decodeURIComponent(match[1]!);
      } catch {
        throw new HttpError(400, "ダッシュボードの名前が読めません");
      }
      if (!plainName(name)) throw new HttpError(400, `ダッシュボードの名前に使えない文字があります: ${name}`);
      const rel = `dashboards/${name}.dash.json`;
      const file = path.join(dashDir, `${name}.dash.json`);
      if (req.method === "GET") {
        if (!existsSync(file)) throw new HttpError(404, `${rel} がありません`);
        const text = await readFile(file);
        let spec: unknown;
        try {
          spec = JSON.parse(text.toString("utf8"));
        } catch (e) {
          throw new HttpError(422, `${rel}: JSON として読めません: ${(e as Error).message}`, { version: versionOf(text) });
        }
        send(res, 200, { name, path: `/${rel}`, spec, version: versionOf(text) });
        return true;
      }
      if (req.method === "PUT") {
        if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Content-Type は application/json にしてください");
        const body = (await readBody(req)) as { spec?: unknown; version?: unknown };
        if (typeof body !== "object" || body === null || !("spec" in body)) throw new HttpError(400, "spec がありません");
        const expected = body.version;
        if (expected !== null && typeof expected !== "string") throw new HttpError(400, "version がありません");
        const current = existsSync(file) ? versionOf(await readFile(file)) : null;
        if (expected === null && current !== null) {
          throw new HttpError(409, `${rel} はもうあります。別の名前にしてください`, { version: current });
        }
        if (expected === null && !NEW_NAME.test(name)) {
          throw new HttpError(400, "新しいダッシュボードの名前は、半角の英数字と - _ で書いてください（64 文字まで）");
        }
        if (expected !== null && current === null) throw new HttpError(409, `${rel} がなくなっています`, { version: null });
        if (expected !== null && expected !== current) {
          throw new HttpError(409, `${rel} は、エディタで開いたあとに書き換えられています`, { version: current });
        }
        let dashboard: Dashboard;
        try {
          dashboard = defineDashboard(body.spec, name, rel);
        } catch (e) {
          if (e instanceof DashboardError) throw new HttpError(422, e.message, { issues: e.issues });
          throw e;
        }
        const problems = options.problems(rel, dashboard);
        if (problems.length) throw new HttpError(422, problems.join("\n"));
        const text = formatDashboardJson(body.spec);
        // Write next to it and rename: the dev server (and VS Code) never read half a file.
        const tmp = path.join(dashDir, `.${name}.dash.json.${process.pid}-${Date.now()}.tmp`);
        try {
          await mkdir(dashDir, { recursive: true });
          await writeFile(tmp, text);
          const version = versionOf(text);
          options.onWrite?.(file, version, typeof req.headers["x-devbi-client"] === "string" ? req.headers["x-devbi-client"] : undefined);
          await rename(tmp, file);
          send(res, 200, { name, path: `/${rel}`, version });
        } finally {
          await rm(tmp, { force: true });
        }
        return true;
      }
      res.setHeader("Allow", "GET, PUT");
      throw new HttpError(405, `${req.method} は使えません`);
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.message, ...e.extra });
      else send(res, 500, { error: (e as Error).message });
      return true;
    }
  };
}
