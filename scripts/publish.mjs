#!/usr/bin/env node
// node scripts/publish.mjs [--dry-run]   (the release workflow runs this; run `pnpm build` first)
// Packs each published package with pnpm (workspace:^ becomes ^<version>) and publishes the tarball with npm, the
// dependencies before what depends on them, create-devbi last. A version already on npm is skipped, so a release that
// stopped halfway can run again. In GitHub Actions, with provenance (where and from which commit it was built).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ORDER = ["devbi", "@devbi/server", "@devbi/react", "@devbi/vite", "@devbi/editor", "create-devbi"];
const repo = path.resolve(import.meta.dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const out = mkdtempSync(path.join(tmpdir(), "devbi-publish-"));

const packages = readdirSync(path.join(repo, "packages"))
  .map((dir) => ({ dir: path.join(repo, "packages", dir), pkg: JSON.parse(readFileSync(path.join(repo, "packages", dir, "package.json"), "utf8")) }))
  .filter(({ pkg }) => !pkg.private);
const unknown = packages.filter(({ pkg }) => !ORDER.includes(pkg.name)).map(({ pkg }) => pkg.name);
if (unknown.length) throw new Error(`scripts/publish.mjs の ORDER にないパッケージがあります: ${unknown.join(", ")}`);
packages.sort((a, b) => ORDER.indexOf(a.pkg.name) - ORDER.indexOf(b.pkg.name));

for (const { dir, pkg } of packages) {
  const id = `${pkg.name}@${pkg.version}`;
  const seen = spawnSync("npm", ["view", id, "version"], { encoding: "utf8" });
  if (seen.status === 0 && seen.stdout.trim() === pkg.version) {
    console.log(`${id} は npm にあるので飛ばします`);
    continue;
  }
  const before = new Set(readdirSync(out));
  execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: dir, stdio: "inherit" });
  const tarball = readdirSync(out).find((f) => !before.has(f));
  const args = ["publish", path.join(out, tarball), "--access", "public"];
  if (process.env.GITHUB_ACTIONS) args.push("--provenance");
  if (dryRun) args.push("--dry-run");
  console.log(`\n$ npm ${args.join(" ")}`);
  execFileSync("npm", args, { stdio: "inherit" });
}
