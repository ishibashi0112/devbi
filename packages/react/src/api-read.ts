// Reading the read-only API (POST <api>/query) and its morning snapshots (GET snapshots/<file>), as Arrow tables: for
// the engine's read_api (metrics files) and for the dataset tiles, which do not need DuckDB.
import * as arrow from "apache-arrow";
import type { ParamValue } from "devbi";

export interface ApiReadOptions {
  /** The SQL file: `api/<name>.sql`. */
  name: string;
  params: Record<string, ParamValue>;
  /** The API's folder, absolute (`https://…/api/`): the query is posted to `<apiUrl>query`. */
  apiUrl: string;
  /** The data's folder, absolute: snapshots are `<baseUrl>snapshots/<file>`. */
  baseUrl: string;
  fetch: typeof fetch;
  /** Read this snapshot file instead of the API (the API when it is not there). */
  snapshot?: string;
  signal?: AbortSignal;
}

export interface ApiRead {
  table: arrow.Table;
  /** The snapshot it read, and when that was made (its Last-Modified). None when it asked the API. */
  snapshot?: { file: string; at: Date };
}

/** A page (index.html) where a file was asked for: a site that answers every path with its page. */
const isPage = (r: Response) => /^text\/html\b/i.test(r.headers.get("Content-Type") ?? "");

/** The rows of `api/<name>.sql` with these parameters: from the API, or from a snapshot file next to the data. */
export async function readApi(o: ApiReadOptions): Promise<ApiRead> {
  let snapshot = o.snapshot;
  const query = () =>
    o.fetch(new URL("query", o.apiUrl).href, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/vnd.apache.arrow.stream" },
      body: JSON.stringify({ name: o.name, params: o.params }),
      ...(o.signal ? { signal: o.signal } : {}),
    });
  let res: Response;
  if (snapshot) {
    // no-cache: asked again each time (a 304 when unchanged), or a browser keeps yesterday's file for hours
    // when the server (IIS) sends no Cache-Control.
    res = await o.fetch(new URL(`snapshots/${encodeURIComponent(snapshot)}`, o.baseUrl).href, {
      cache: "no-cache",
      headers: { Accept: "application/vnd.apache.arrow.stream" },
      ...(o.signal ? { signal: o.signal } : {}),
    });
    if (res.status === 404 || (res.ok && isPage(res))) {
      // Not made yet on a static site, or no longer a snapshot on the server (its SQL or models/ changed after
      // this page was built): read the API as it is now, when there is one.
      const live = await query().catch((e: unknown) => {
        if (o.signal?.aborted) throw e;
        return undefined;
      });
      if (!live || live.status === 404 || live.status === 405 || (live.ok && isPage(live))) {
        throw new Error(
          `${o.name} のスナップショット（snapshots/${snapshot}）がありません。サーバーで devbi-snapshot を実行するか、devbi-serve が作るのを待ってください`,
        );
      }
      res = live;
      snapshot = undefined;
    }
  } else {
    res = await query();
  }
  if (!res.ok) {
    const error = await res
      .json()
      .then((b: { error?: string }) => b.error)
      .catch(() => undefined);
    if (snapshot) throw new Error(`${o.name} のスナップショットを読めません（${res.status}）${error ? `: ${error}` : ""}`);
    throw new Error(`API の ${o.name} を読めません（${res.status}）${error ? `: ${error}` : ""}`);
  }
  let made: ApiRead["snapshot"];
  if (snapshot) {
    const modified = Date.parse(res.headers.get("Last-Modified") ?? "");
    made = { file: snapshot, at: Number.isFinite(modified) ? new Date(modified) : new Date() };
  }
  const table = arrow.tableFromIPC(new Uint8Array(await res.arrayBuffer()));
  return { table, ...(made ? { snapshot: made } : {}) };
}
