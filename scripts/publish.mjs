#!/usr/bin/env node
// pnpm release [--dry-run] [--yes]   — publishes the packages to npm from your own computer (docs/releasing.md)
//
// 1. Checks before anything goes out: the checkout is origin/main with nothing changed, every package has one
//    version, you are logged in to npm (npm whoami), and the npm organization of each scope (@devbi) exists.
// 2. pnpm install --frozen-lockfile, pnpm build, then pnpm pack for each package (workspace:^ becomes ^<version>,
//    only the "files" go in). All are packed before the first one is published.
// 3. Shows what it will publish and asks once, then npm publish for each tarball: dependencies before what depends on
//    them, create-devbi last. npm asks for your passkey in the browser (for each package, or once, as npm decides).
//    A version already on npm is skipped, so running it again after a stop carries on where it stopped.
// 4. Reads the versions back from npm.
//
// --dry-run: everything except the upload (npm publish --dry-run), from any checkout and without logging in.
// --yes:     no question before publishing.
// Always the public registry (registry.npmjs.org), whatever registry npm is set to use on this computer.
// A prerelease (0.2.0-beta.1) gets the dist-tag "next", so `npm create devbi@latest` keeps the last release.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

const ORDER = ["devbi", "@devbi/server", "@devbi/react", "@devbi/vite", "@devbi/editor", "create-devbi"];
const REGISTRY = "https://registry.npmjs.org/";
const repo = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const yes = args.includes("--yes");
const unknownArgs = args.filter((a) => a !== "--dry-run" && a !== "--yes");
if (unknownArgs.length) {
  console.error(`知らない指定です: ${unknownArgs.join(" ")}\n使い方: pnpm release [--dry-run] [--yes]`);
  process.exit(2);
}

const stop = (message) => {
  console.error(`\n止めました: ${message}`);
  process.exit(1);
};
const run = (cmd, cmdArgs, cwd = repo) => {
  console.log(`\n$ ${[cmd, ...cmdArgs].join(" ")}`);
  execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
};
const output = (cmd, cmdArgs) => spawnSync(cmd, cmdArgs, { cwd: repo, encoding: "utf8" });
const npm = (cmdArgs) => output("npm", [...cmdArgs, "--registry", REGISTRY]);

// The packages: every one in packages/ that is not private, in ORDER.
const packages = readdirSync(path.join(repo, "packages"))
  .map((dir) => ({ dir: path.join(repo, "packages", dir), pkg: JSON.parse(readFileSync(path.join(repo, "packages", dir, "package.json"), "utf8")) }))
  .filter(({ pkg }) => !pkg.private);
const unknown = packages.filter(({ pkg }) => !ORDER.includes(pkg.name)).map(({ pkg }) => pkg.name);
if (unknown.length) stop(`scripts/publish.mjs の ORDER にないパッケージがあります: ${unknown.join(", ")}`);
packages.sort((a, b) => ORDER.indexOf(a.pkg.name) - ORDER.indexOf(b.pkg.name));

// 1. Checks.
const versions = [...new Set(packages.map(({ pkg }) => pkg.version))];
if (versions.length !== 1) stop(`パッケージの版がそろっていません（${packages.map(({ pkg }) => `${pkg.name} ${pkg.version}`).join("、")}）。node scripts/version.mjs <版> でそろえます`);
const [version] = versions;

const checkout = () => {
  // Changed files anywhere, or new files in packages/ (they could end up in a package).
  const changed = output("git", ["status", "--porcelain"]).stdout.split("\n").filter((l) => l && (!l.startsWith("??") || l.slice(3).startsWith("packages/")));
  if (changed.length) return `コミットしていない変更があります:\n${changed.join("\n")}`;
  if (output("git", ["fetch", "--quiet", "origin", "main"]).status !== 0) return "git fetch origin main ができませんでした";
  const head = output("git", ["rev-parse", "HEAD"]).stdout.trim();
  const main = output("git", ["rev-parse", "origin/main"]).stdout.trim();
  if (head !== main) return `いまのコミット（${head.slice(0, 7)}）が GitHub の main（${main.slice(0, 7)}）ではありません。git switch main && git pull で main にします`;
  return null;
};
const problem = checkout();
if (problem && !dryRun) stop(problem);
if (problem) console.log(`（--dry-run なので続けます: ${problem}）`);
const commit = output("git", ["rev-parse", "--short", "HEAD"]).stdout.trim();

const published = (name) => {
  const seen = npm(["view", `${name}@${version}`, "version"]);
  return seen.status === 0 && seen.stdout.trim() === version;
};
const todo = packages.filter(({ pkg }) => !published(pkg.name));
for (const { pkg } of packages) if (!todo.some((t) => t.pkg.name === pkg.name)) console.log(`${pkg.name}@${version} はもう npm にあるので飛ばします`);
if (!todo.length) {
  console.log(`\nどのパッケージも ${version} が npm にあります。出すものはありません。`);
  process.exit(0);
}

let user = null;
if (!dryRun) {
  const me = npm(["whoami"]);
  if (me.status !== 0) stop(`npm にログインしていません。先に npm login --registry=${REGISTRY} を`);
  user = me.stdout.trim();
}
// A scope (@devbi) is an npm organization: without it, npm refuses the first @devbi/〜 and the release stops halfway.
for (const scope of new Set(todo.map(({ pkg }) => pkg.name.match(/^@([^/]+)\//)?.[1]).filter(Boolean))) {
  const seen = npm(["access", "list", "packages", scope, "--json"]);
  if (seen.status === 0) continue;
  if (/Scope not found/i.test(seen.stderr)) {
    const message = `npm に Organization「${scope}」がありません（@${scope}/〜 を出すのに要ります）。https://www.npmjs.com/org/create で作ります`;
    if (!dryRun) stop(message);
    console.log(`（--dry-run なので続けます: ${message}）`);
  } else console.log(`（Organization「${scope}」があるかを確かめられませんでした。続けます）`);
}

// 2. A build from the lockfile, and every tarball before the first upload.
run("pnpm", ["install", "--frozen-lockfile"]);
run("pnpm", ["build"]);
const out = mkdtempSync(path.join(tmpdir(), "devbi-publish-"));
for (const item of todo) {
  const before = new Set(readdirSync(out));
  run("pnpm", ["pack", "--pack-destination", out], item.dir);
  const made = readdirSync(out).filter((f) => !before.has(f));
  if (made.length !== 1) stop(`${item.pkg.name}: pnpm pack が ${made.join(", ") || "何も"} 作りました`);
  item.tarball = path.join(out, made[0]);
  const manifest = output("tar", ["-xzOf", item.tarball, "package/package.json"]).stdout;
  if (manifest.includes('"workspace:')) stop(`${item.pkg.name}: パックしたものに workspace: が残っています`);
  if (JSON.parse(manifest).version !== version) stop(`${item.pkg.name}: パックしたものの版が ${version} ではありません`);
}

// 3. One question, then the uploads.
const tag = version.includes("-") ? "next" : "latest";
console.log(`\n${dryRun ? "（--dry-run）" : ""}npm に出すもの（コミット ${commit}、dist-tag ${tag}${user ? `、npm のユーザー ${user}` : ""}）:`);
for (const { pkg, tarball } of todo) console.log(`  ${pkg.name}@${version}   ${path.basename(tarball)}`);
if (!dryRun && !yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("\n出したら同じ版はもう使えません。公開してよければ y を入力: ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") stop("公開しませんでした");
}
for (const { pkg, tarball } of todo) {
  const publishArgs = ["publish", tarball, "--access", "public", "--registry", REGISTRY];
  if (tag === "next") publishArgs.push("--tag", "next");
  if (dryRun) publishArgs.push("--dry-run");
  try {
    run("npm", publishArgs);
  } catch {
    stop(`${pkg.name} の公開でエラーになりました（上の npm の表示を見てください）。直したら、もう一度 pnpm release で続きから出せます`);
  }
}
if (dryRun) {
  console.log(`\n--dry-run でした。npm には何も出していません（パックしたものは ${out}）。`);
  process.exit(0);
}

// 4. Read back from npm (it can take a few seconds to show up).
console.log("\nnpm から読み直します");
const missing = [];
for (const { pkg } of todo) {
  let ok = false;
  for (let i = 0; i < 10 && !ok; i++) {
    ok = published(pkg.name);
    if (!ok) await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`  ${ok ? "OK" : "まだ見えません"}  ${pkg.name}@${version}`);
  if (!ok) missing.push(pkg.name);
}
if (missing.length) console.log(`\n${missing.join("、")} がまだ npm に見えません。少し待って npm view <名前> version で確かめます`);
else console.log(`\n出せました。コミット ${commit} に印を付けるなら:\n  git tag v${version} && git push origin v${version}`);
