// Fetch the numbers of the live demo into data/: each npm package's downloads per day (npm's downloads API), and its
// GitHub repository's stars, forks and open issues as of today (GitHub's API). Not the day of each star: GitHub lists
// stargazers only to a signed-in user, which GitHub Actions' token is not for other repositories.
//
//   node scripts/fetch-stats.mjs --npm-user ishibashi0112 [--repo owner/name …]
//
// The packages are the ones the npm user maintains; --repo adds a repository without one. GITHUB_TOKEN (optional, as
// in GitHub Actions) raises GitHub's limit from 60 requests an hour.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { day, downloadRanges, githubRepo, toCsv } from "./stats.mjs";

const { values } = parseArgs({ options: { "npm-user": { type: "string" }, repo: { type: "string", multiple: true } } });
const user = values["npm-user"];
if (!user) throw new Error("--npm-user <npm のユーザー名> を指定してください");
const out = path.join(import.meta.dirname, "..", "data");
const token = process.env.GITHUB_TOKEN;

/** The answer to a GET, asked again after a network error, a limit (429) or a server error (after 2, 4, 8, 16 seconds). */
async function request(url, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    const wait = () => new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    let res;
    try {
      res = await fetch(url, { headers: { "user-agent": "devbi-demo", ...headers } });
    } catch (e) {
      if (attempt < 4) {
        await wait();
        continue;
      }
      throw new Error(`${url}: ${e.cause?.message ?? e.message}`);
    }
    if (attempt < 4 && (res.status === 429 || res.status >= 500)) {
      await wait();
      continue;
    }
    return res;
  }
}

/** The JSON of an answer; undefined for 404. */
async function json(url, res) {
  if (res.ok) return res.json();
  if (res.status === 404) return undefined;
  throw new Error(`${url}: ${res.status} ${await res.text()}`);
}

const get = async (url) => json(url, await request(url));

async function github(p) {
  const url = `https://api.github.com/${p}`;
  return json(url, await request(url, { accept: "application/vnd.github+json", ...(token && { authorization: `Bearer ${token}` }) }));
}

// Yesterday (UTC): npm's last full day.
const end = day(new Date(Date.now() - 86_400_000));

const search = await get(`https://registry.npmjs.org/-/v1/search?text=maintainer:${encodeURIComponent(user)}&size=250`);
const names = search.objects.map((o) => o.package.name).sort();
if (!names.length) throw new Error(`npm のユーザー ${user} のパッケージがありません`);

const downloads = [];
const repos = new Set(values.repo ?? []);
for (const name of names) {
  const doc = await get(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
  const repo = githubRepo(doc?.repository?.url ?? doc?.repository) ?? "";
  if (repo) repos.add(repo);
  let n = 0;
  for (const [from, to] of downloadRanges(doc?.time?.created ?? end, end)) {
    const range = await get(`https://api.npmjs.org/downloads/range/${from}:${to}/${name}`);
    for (const d of range?.downloads ?? []) {
      downloads.push({ date: d.day, package: name, repo, downloads: d.downloads });
      n += d.downloads;
    }
  }
  console.log(`${name}: ${n.toLocaleString("en-US")} downloads`);
}

// A repository by GitHub's own name (owner/Repo, and the new name of a renamed one), once: npm's spelling may differ.
const repoRows = [];
const fullName = new Map();
for (const repo of [...repos].sort()) {
  const r = await github(`repos/${repo}`);
  if (!r) {
    console.warn(`${repo}: GitHub にありません（非公開か、名前が違います）`);
    continue;
  }
  fullName.set(repo, r.full_name);
  if (repoRows.some((row) => row.repo === r.full_name)) continue;
  repoRows.push({
    repo: r.full_name,
    description: r.description ?? "",
    language: r.language ?? "",
    stars: r.stargazers_count,
    forks: r.forks_count,
    open_issues: r.open_issues_count,
    created: r.created_at.slice(0, 10),
    pushed: r.pushed_at.slice(0, 10),
  });
  console.log(`${r.full_name}: ${r.stargazers_count} stars`);
}
for (const d of downloads) d.repo = fullName.get(d.repo) ?? d.repo;
// A demo of nothing is not published: devbi-check only warns about an empty file.
if (!downloads.length) throw new Error("npm のダウンロード数が 1 日分もありません");
if (!repoRows.length) throw new Error("GitHub のリポジトリが 1 つもありません");

await mkdir(out, { recursive: true });
await writeFile(path.join(out, "downloads.csv"), toCsv(["date", "package", "repo", "downloads"], downloads));
await writeFile(
  path.join(out, "repos.csv"),
  toCsv(["repo", "description", "language", "stars", "forks", "open_issues", "created", "pushed"], repoRows),
);
console.log(`data/ に書きました（${names.length} パッケージ、${repoRows.length} リポジトリ、${end} まで）`);
