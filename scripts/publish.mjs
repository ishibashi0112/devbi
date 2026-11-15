#!/usr/bin/env node
// pnpm release [--dry-run] [--yes]   — publishes the packages to npm from your own computer (docs/releasing.md)
//
// 1. Checks before anything goes out: the checkout is origin/main with nothing changed, GitHub's CI passed on that
//    commit, every package has one version, you are logged in to npm (npm whoami), and the npm organization of each
//    scope (@devbi) exists with you in it.
// 2. pnpm install --frozen-lockfile, pnpm build, then pnpm pack for each package (workspace:^ becomes ^<version>,
//    only the "files" go in). Every file in a tarball must be in git or built (dist/): pnpm pack also takes files git
//    ignores (.env.local, node_modules/ …), so nothing that is only on this computer goes out. All are packed before
//    the first one is published.
// 3. Shows what it will publish and asks once, then npm publish for each tarball: dependencies before what depends on
//    them, create-devbi last. npm asks for your passkey in the browser (for each package, or once, as npm decides).
//    A version already on npm is skipped, so running it again after a stop carries on where it stopped.
// 4. Reads the versions back from npm.
//
// --dry-run: everything except the upload (npm publish --dry-run), from any checkout and without logging in.
// --yes:     no question before publishing.
// Always the public registry (registry.npmjs.org), also for the scopes, whatever this computer's npm is set to use.
// A prerelease (0.2.0-beta.1) gets the dist-tag "next", so `npm create devbi@latest` keeps the last release.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
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
// npm and pnpm are started without a shell (npm.cmd on Windows would need one).
if (process.platform === "win32") stop("Windows では動きません。Mac か Linux で（WSL でも）");

// The packages: every one in packages/ that is not private, in ORDER.
const packages = readdirSync(path.join(repo, "packages"))
  .map((dir) => ({ dir: path.join(repo, "packages", dir), pkg: JSON.parse(readFileSync(path.join(repo, "packages", dir, "package.json"), "utf8")) }))
  .filter(({ pkg }) => !pkg.private);
const unknown = packages.filter(({ pkg }) => !ORDER.includes(pkg.name)).map(({ pkg }) => pkg.name);
if (unknown.length) stop(`scripts/publish.mjs の ORDER にないパッケージがあります: ${unknown.join(", ")}`);
packages.sort((a, b) => ORDER.indexOf(a.pkg.name) - ORDER.indexOf(b.pkg.name));
const scopeOf = (name) => name.match(/^@([^/]+)\//)?.[1];
const scopes = [...new Set(packages.map(({ pkg }) => scopeOf(pkg.name)).filter(Boolean))];

// npm, always against the public registry: --registry, and --@devbi:registry, which an npmrc's "@devbi:registry="
// would otherwise win over. pnpm's user agent is left out (pnpm release runs this from pnpm).
const npmFlags = ["--registry", REGISTRY, ...scopes.map((s) => `--@${s}:registry=${REGISTRY}`)];
const npmEnv = { ...process.env };
delete npmEnv.npm_config_user_agent;
const run = (cmd, cmdArgs, cwd = repo, env = process.env) => {
  console.log(`\n$ ${[cmd, ...cmdArgs].join(" ")}`);
  execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit", env });
};
const output = (cmd, cmdArgs, env = process.env) => spawnSync(cmd, cmdArgs, { cwd: repo, encoding: "utf8", env });
const npm = (cmdArgs) => output("npm", [...cmdArgs, ...npmFlags], npmEnv);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Checks.
const versions = [...new Set(packages.map(({ pkg }) => pkg.version))];
if (versions.length !== 1) stop(`パッケージの版がそろっていません（${packages.map(({ pkg }) => `${pkg.name} ${pkg.version}`).join("、")}）。node scripts/version.mjs <版> でそろえます`);
const [version] = versions;
const notice = (message) => {
  if (!dryRun) stop(message);
  console.log(`（--dry-run なので続けます: ${message}）`);
};

const checkout = () => {
  // Changed files anywhere, or new files in packages/ (they could end up in a package). -z: names as they are.
  const entries = output("git", ["status", "--porcelain", "-z"]).stdout.split("\0");
  const changed = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (/^[RC]/.test(entry)) i++; // a rename or copy: the next entry is where it came from
    if (!entry.startsWith("??") || entry.slice(3).startsWith("packages/")) changed.push(entry);
  }
  if (changed.length) return `コミットしていない変更があります:\n${changed.join("\n")}`;
  if (output("git", ["fetch", "--quiet", "origin", "main"]).status !== 0) return "git fetch origin main ができませんでした";
  const head = output("git", ["rev-parse", "HEAD"]).stdout.trim();
  const main = output("git", ["rev-parse", "origin/main"]).stdout.trim();
  if (head !== main) return `いまのコミット（${head.slice(0, 7)}）が GitHub の main（${main.slice(0, 7)}）ではありません。git switch main && git pull で main にします`;
  return null;
};
const problem = checkout();
if (problem) notice(problem);
const sha = output("git", ["rev-parse", "HEAD"]).stdout.trim();
const commit = sha.slice(0, 7);

// GitHub's CI on this commit (.github/workflows/ci.yml: typecheck, tests, check:packed): each of its jobs passed,
// in its latest run. Other workflows on the same commit (the live demo's daily build) do not count.
const githubRepo = packages[0].pkg.repository?.url?.match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
const ciJobs = [...(readFileSync(path.join(repo, ".github/workflows/ci.yml"), "utf8").split(/^jobs:\s*$/m)[1] ?? "").matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]);
try {
  const res = await fetch(`https://api.github.com/repos/${githubRepo}/commits/${sha}/check-runs?per_page=100`, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const runs = (await res.json()).check_runs;
  const latest = (job) => runs.filter((r) => r.name === job).sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0];
  const failed = ciJobs.filter((job) => latest(job)?.status === "completed" && !["success", "skipped", "neutral"].includes(latest(job).conclusion));
  const pending = ciJobs.filter((job) => latest(job)?.status !== "completed");
  if (!ciJobs.length) throw new Error(".github/workflows/ci.yml にジョブが見つかりません");
  if (failed.length) notice(`このコミットの CI が通っていません（${failed.join("、")}）: https://github.com/${githubRepo}/commit/${sha}`);
  else if (pending.length) notice(`このコミットの CI がまだ終わっていません（${pending.join("、")}）。数分待ってから、もう一度`);
  else console.log(`このコミット（${commit}）の CI は通っています（${ciJobs.join("、")}）`);
} catch (error) {
  console.log(`（このコミットの CI を確かめられませんでした: ${error.message}。GitHub で main に緑のチェックが付いているのを見てから進めてください）`);
}

const published = (name) => {
  const seen = npm(["view", `${name}@${version}`, "version"]);
  return seen.status === 0 && seen.stdout.trim() === version;
};
const todo = packages.filter(({ pkg }) => !published(pkg.name));
for (const item of packages) if (!todo.includes(item)) console.log(`${item.pkg.name}@${version} はもう npm にあるので飛ばします`);
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
// A scope (@devbi) is an npm organization, and you have to be in it: otherwise npm refuses the first @devbi/〜, after
// devbi is already out.
for (const scope of new Set(todo.map(({ pkg }) => scopeOf(pkg.name)).filter(Boolean))) {
  const seen = npm(["access", "list", "packages", scope, "--json"]);
  if (seen.status !== 0) {
    if (/Scope not found/i.test(seen.stderr)) notice(`npm に Organization「${scope}」がありません（@${scope}/〜 を出すのに要ります）。https://www.npmjs.com/org/create で作ります`);
    else console.log(`（Organization「${scope}」があるかを確かめられませんでした。続けます）`);
    continue;
  }
  if (!user) continue;
  const members = npm(["org", "ls", scope, user, "--json"]);
  let role;
  try {
    role = JSON.parse(members.stdout)[user];
  } catch {}
  if (role) console.log(`Organization「${scope}」: ${user} は ${role}`);
  else if (members.status === 0 || /E40[34]|not found/i.test(members.stderr)) stop(`npm のユーザー ${user} は Organization「${scope}」のメンバーではありません（https://www.npmjs.com/org/${scope}/members）`);
  else console.log(`（${user} が Organization「${scope}」のメンバーかを確かめられませんでした。続けます）`);
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
  // Only files from git, and what the build makes (dist/, and devbi's copy of docs/reference.md).
  const rel = path.relative(repo, item.dir);
  const tracked = new Set(output("git", ["ls-files", "-z", "--", rel]).stdout.split("\0").filter(Boolean).map((f) => path.posix.relative(rel, f)));
  item.files = output("tar", ["-tzf", item.tarball]).stdout.split("\n").filter((f) => f && !f.endsWith("/")).map((f) => f.replace(/^package\//, ""));
  const strays = item.files.filter((f) => !tracked.has(f) && !f.startsWith("dist/") && !(item.pkg.name === "devbi" && f === "docs/reference.md"));
  if (strays.length) stop(`${item.pkg.name}: git にないファイルが入っています（このパソコンにだけあるもの）:\n  ${strays.join("\n  ")}\n消すか、別の場所に移してから、もう一度`);
}

// 3. One question, then the uploads.
const tag = version.includes("-") ? "next" : "latest";
const kb = (file) => `${Math.round(statSync(file).size / 1024)} KB`;
console.log(`\n${dryRun ? "（--dry-run）" : ""}npm に出すもの（コミット ${commit}、dist-tag ${tag}${user ? `、npm のユーザー ${user}` : ""}）:`);
for (const { pkg, tarball, files } of todo) console.log(`  ${pkg.name}@${version}   ${files.length} ファイル、${kb(tarball)}`);
if (!dryRun && !yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("\n出したら同じ版はもう使えません。公開してよければ y を入力: ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") stop("公開しませんでした");
}
const appeared = async (name, tries) => {
  for (let i = 0; i < tries; i++) {
    if (published(name)) return true;
    if (i < tries - 1) await sleep(3000);
  }
  return false;
};
for (const { pkg, tarball } of todo) {
  const publishArgs = ["publish", tarball, "--access", "public", ...npmFlags];
  if (tag === "next") publishArgs.push("--tag", "next");
  if (dryRun) publishArgs.push("--dry-run");
  try {
    run("npm", publishArgs, repo, npmEnv);
  } catch {
    // npm can fail after the registry took it (a dropped connection): then it is out, and the rest can follow.
    if (!dryRun && (await appeared(pkg.name, 3))) {
      console.log(`（${pkg.name}@${version} は npm にできていました。続けます）`);
      continue;
    }
    stop(`${pkg.name} の公開でエラーになりました（上の npm の表示を見てください）。直したら、もう一度 pnpm release で続きから出せます（コードは変えずに）`);
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
  const ok = await appeared(pkg.name, 10);
  console.log(`  ${ok ? "OK" : "まだ見えません"}  ${pkg.name}@${version}`);
  if (!ok) missing.push(pkg.name);
}
if (missing.length) console.log(`\n${missing.join("、")} がまだ npm に見えません。少し待って npm view <名前> version で確かめます`);
else console.log(`\n出せました。コミット ${commit} に印を付けるなら:\n  git tag v${version} && git push origin v${version}`);
