#!/usr/bin/env node
// node scripts/version.mjs <version>           sets every published package (packages/*, not private) to <version>
// node scripts/version.mjs --check <version>   fails unless they all are <version> (the release workflow, from its tag)
// The packages are released together, at one version: create-devbi makes projects that depend on ^<its version>.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const check = args[0] === "--check";
const version = check ? args[1] : args[0];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) || args.length !== (check ? 2 : 1)) {
  console.error("使い方: node scripts/version.mjs [--check] <版（0.1.0 など）>");
  process.exit(2);
}
const wrong = [];
for (const dir of readdirSync(path.join(repo, "packages")).sort()) {
  const file = path.join(repo, "packages", dir, "package.json");
  const text = readFileSync(file, "utf8");
  const pkg = JSON.parse(text);
  if (pkg.private) continue;
  if (pkg.version === version) continue;
  if (check) wrong.push(`${pkg.name} は ${pkg.version}`);
  else {
    // Only the "version" line changes, so the rest of the file stays as written.
    writeFileSync(file, text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`));
    console.log(`${pkg.name}: ${pkg.version} → ${version}`);
  }
}
if (wrong.length) {
  console.error(`版が ${version} ではないパッケージがあります: ${wrong.join("、")}`);
  process.exit(1);
}
if (check) console.log(`どのパッケージも ${version} です`);
