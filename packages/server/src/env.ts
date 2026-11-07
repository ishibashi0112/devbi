import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * The environment with `<dir>/.env` and `<dir>/.env.local` under it, as Vite reads them: `.env.local` wins over
 * `.env`, and variables already set in the environment win over both. Keep `.env.local` out of git.
 */
export function loadEnv(dir: string, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const files: Record<string, string> = {};
  for (const name of [".env", ".env.local"]) {
    const file = path.join(dir, name);
    if (existsSync(file)) Object.assign(files, parseEnv(readFileSync(file, "utf8")));
  }
  return { ...files, ...env };
}
