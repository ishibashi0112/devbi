// devUsers (row-level security) as the tools read them: from the project's Vite config, the devbi() plugin's options.
import { existsSync } from "node:fs";
import path from "node:path";
import type { DevBIUser } from "@devbi/server";
import type { DevUser } from "./index.js";

/** What the devbi() plugin tells tools about itself (`plugin.api`). */
export interface DevbiPluginApi {
  /** `dir` as written in the options (relative to the Vite root). */
  dirOption?: string;
  devUsers?: Record<string, DevUser>;
}

/** One of devUsers, as the API takes it: `{ id, roles, attrs }` (the id defaults to the name). */
export function devUserOf(name: string, u: DevUser): DevBIUser {
  return { id: u.id ?? name, ...(u.roles ? { roles: u.roles } : {}), ...(u.attrs ? { attrs: u.attrs } : {}) };
}

/** devUsers as the API takes users: throws `devUsers の yamada: …` for the first one it would not take. */
export async function checkDevUsers(users: Record<string, DevUser>): Promise<void> {
  const { viewerOf } = await import("@devbi/server");
  for (const [name, u] of Object.entries(users)) {
    try {
      if (!name.trim()) throw new TypeError("名前は空でない文字で書いてください");
      if (typeof u !== "object" || u === null || Array.isArray(u)) throw new TypeError("{ roles, attrs } の形で書いてください");
      if (u.id !== undefined && (typeof u.id !== "string" || !u.id.trim())) throw new TypeError("id は空でない文字で書いてください");
      viewerOf(devUserOf(name, u));
    } catch (e) {
      throw new Error(`devUsers の ${name}: ${(e as Error).message}`);
    }
  }
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
 * folder or in `dir`. The devbi() plugin whose project folder is `dir` (`devbi({ dir })` from the config's root, which
 * Vite resolves from the current folder). Undefined when no config found has such a plugin, or it has no devUsers.
 * Throws when a config cannot be read, when the given one has no such plugin, and for devUsers the API would not take.
 */
export async function loadDevUsers(dir: string, options: { config?: string; cwd?: string } = {}): Promise<{ users: Record<string, DevUser>; config: string } | undefined> {
  const root = path.resolve(dir);
  const cwd = options.cwd ?? process.cwd();
  const candidates = options.config
    ? [path.resolve(cwd, options.config)]
    : [...new Set([cwd, root])].flatMap((base) => CONFIG_FILES.map((f) => path.join(base, f))).filter((f) => existsSync(f));
  // Windows and macOS: one folder, whatever the case of its name.
  const same = (a: string, b: string) => (process.platform === "win32" || process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const { loadConfigFromFile } = await import("vite");
  for (const file of candidates) {
    const shown = path.relative(cwd, file) || file;
    let loaded: Awaited<ReturnType<typeof loadConfigFromFile>>;
    try {
      loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, file, cwd, "silent");
    } catch (e) {
      throw new Error(`${shown} を読めません: ${(e as Error).message}`);
    }
    if (!loaded) throw new Error(`${shown} を読めません`);
    // As Vite: root from the current folder (where vite runs), the plugin's dir from root.
    const viteRoot = path.resolve(cwd, loaded.config.root ?? ".");
    for (const p of await flatten(loaded.config.plugins)) {
      const plugin = p as { name?: string; api?: { devbi?: DevbiPluginApi } };
      const api = plugin.name === "devbi" ? plugin.api?.devbi : undefined;
      if (!api || !same(path.resolve(viteRoot, api.dirOption ?? "."), root)) continue;
      if (!api.devUsers || !Object.keys(api.devUsers).length) return undefined;
      await checkDevUsers(api.devUsers).catch((e: Error) => {
        throw new Error(`${shown} の ${e.message}`);
      });
      return { users: api.devUsers, config: shown };
    }
    if (options.config) throw new Error(`${shown} に、${path.relative(cwd, root) || "."} を指す devbi() がありません（devbi({ dir }) は Vite の root から、root は今のフォルダからです）`);
  }
  return undefined;
}
