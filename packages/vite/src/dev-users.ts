// devUsers (row-level security) as the tools read them: from the project's Vite config, the devbi() plugin's options.
import { existsSync } from "node:fs";
import path from "node:path";
import type { DevBIUser } from "@devbi/server";
import type { DevUser } from "./index.js";

/** What the devbi() plugin tells tools about itself (`plugin.api`). */
export interface DevbiPluginApi {
  /** The project folder (dashboards/, models/, api/), absolute. Set once Vite has resolved the config. */
  dir?: string;
  /** `dir` as written in the options (relative to the Vite root). */
  dirOption?: string;
  devUsers?: Record<string, DevUser>;
}

/** One of devUsers, as the API takes it: `{ id, roles, attrs }` (the id defaults to the name). */
export function devUserOf(name: string, u: DevUser): DevBIUser {
  return { id: u.id ?? name, ...(u.roles ? { roles: u.roles } : {}), ...(u.attrs ? { attrs: u.attrs } : {}) };
}

const CONFIG_FILES = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cts", "vite.config.cjs"];

async function flatten(plugins: unknown): Promise<unknown[]> {
  const out: unknown[] = [];
  const walk = async (p: unknown): Promise<void> => {
    const v = await p;
    if (Array.isArray(v)) for (const x of v) await walk(x);
    else if (v) out.push(v);
  };
  await walk(plugins);
  return out;
}

/**
 * The devUsers of the project in `dir`, from a Vite config: `config` when given, else `vite.config.*` in the current
 * folder or in `dir`. The devbi() plugin whose project folder is `dir` (`devbi({ dir })` from the config's root).
 * Undefined when there is no config, no such plugin, or it has no devUsers. Throws when the given config cannot be read.
 */
export async function loadDevUsers(dir: string, options: { config?: string; cwd?: string } = {}): Promise<{ users: Record<string, DevUser>; config: string } | undefined> {
  const root = path.resolve(dir);
  const cwd = options.cwd ?? process.cwd();
  const candidates = options.config
    ? [path.resolve(cwd, options.config)]
    : [...new Set([cwd, root])].flatMap((base) => CONFIG_FILES.map((f) => path.join(base, f))).filter((f) => existsSync(f));
  const { loadConfigFromFile } = await import("vite");
  for (const file of candidates) {
    let loaded: Awaited<ReturnType<typeof loadConfigFromFile>>;
    try {
      loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, file, path.dirname(file), "silent");
    } catch (e) {
      if (options.config) throw new Error(`${options.config} を読めません: ${(e as Error).message}`);
      continue;
    }
    if (!loaded) {
      if (options.config) throw new Error(`${options.config} を読めません`);
      continue;
    }
    const viteRoot = path.resolve(path.dirname(file), loaded.config.root ?? ".");
    for (const p of await flatten(loaded.config.plugins)) {
      const plugin = p as { name?: string; api?: { devbi?: DevbiPluginApi } };
      const api = plugin.name === "devbi" ? plugin.api?.devbi : undefined;
      if (!api) continue;
      if (path.resolve(viteRoot, api.dirOption ?? ".") !== root) continue;
      if (!api.devUsers || !Object.keys(api.devUsers).length) return undefined;
      return { users: api.devUsers, config: path.relative(cwd, file) || file };
    }
  }
  return undefined;
}
