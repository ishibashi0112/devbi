import type { DevServer } from "@devbi/react";
import type { RawDashboard, RawTile } from "./layout.js";

/** A dash.json as the dev server read or wrote it. */
export interface DashboardFile {
  name: string;
  /** `/dashboards/<name>.dash.json` */
  path: string;
  spec: RawDashboard;
  /** The content's version: a save names it, and is refused when the file changed since. */
  version: string;
}

export class EditorError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** On a conflict (409): the file's version now (null: there is no file). */
    readonly version?: string | null,
  ) {
    super(message);
    this.name = "EditorError";
  }
}

/** A built-in tile written out as code ("コードにする"). */
export interface TileFile {
  /** From the project folder: `/dashboards/<name>/<Name>.tsx` */
  path: string;
  /** What the tile names in dash.json: `./<name>/<Name>.tsx` */
  component: string;
  /** false: the same file was there already (written before, then undone in the editor). */
  created: boolean;
}

async function call(dev: DevServer, method: "GET" | "PUT" | "POST", name: string, body?: unknown, under = ""): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${dev.endpoint}dashboards/${encodeURIComponent(name)}${under}`, {
      method,
      cache: "no-store",
      headers: {
        "X-DevBI-Editor": "1",
        "X-DevBI-Client": dev.client,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new EditorError(`dev server につながりません（止まっていませんか）: ${(e as Error).message}`, 0);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof data.error === "string" ? data.error : `${res.status} ${res.statusText}`;
    throw new EditorError(message, res.status, data.version as string | null | undefined);
  }
  return data;
}

/** Read `dashboards/<name>.dash.json` as it is on disk now. */
export async function readDashboard(dev: DevServer, name: string): Promise<DashboardFile> {
  const data = await call(dev, "GET", name);
  return data as unknown as DashboardFile;
}

/** Write it, if it is still at `version` (null: create a new file). Returns the new version. */
export async function writeDashboard(dev: DevServer, name: string, spec: RawDashboard, version: string | null): Promise<DashboardFile> {
  const data = await call(dev, "PUT", name, { spec, version });
  return { name, path: data.path as string, spec, version: data.version as string };
}

/**
 * Write the tile out as `dashboards/<name>/<Name>.tsx` (drawn by the same built-in tile, with its query and options
 * in the file). `metrics` is the metrics file it reads, for the labels in the file's notes.
 */
export async function writeTileFile(dev: DevServer, name: string, tile: RawTile, metrics: string | undefined): Promise<TileFile> {
  const data = await call(dev, "POST", name, { tile, ...(metrics ? { metrics } : {}) }, "/tiles");
  return data as unknown as TileFile;
}
