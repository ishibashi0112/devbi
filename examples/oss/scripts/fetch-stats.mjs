// Fetch the numbers of the live demo into data/: each npm package's downloads per day (npm's downloads API), and its
// GitHub repository's stars, forks and open issues, with the day of each star (GitHub's API).
//
//   node scripts/fetch-stats.mjs --npm-user ishibashi0112 [--repo owner/name …]
//
// The packages are the ones the npm user maintains; --repo adds a repository without one. GITHUB_TOKEN (optional, as
// in GitHub Actions) raises GitHub's limit from 60 requests an hour. The GitHub users who starred are not kept.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { day, downloadRanges, githubRepo, toCsv } from "./stats.mjs";

const { values } = parseArgs({ options: { "npm-user": { type: "string" }, repo: { type: "string", multiple: true } } });
const user = values["npm-user"];
if (!user) throw new Error("--npm-user <npm のユーザー名> を指定してください");
const out = path.join(import.meta.dirname, "..", "data");
const token = process.env.GITHUB_TOKEN;

async function get(url, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": "devbi-demo", ...headers } });
    if (res.ok) return res.json();
    if (res.status === 404) return undefined;
    if (attempt < 4 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    throw new Error(`${url}: ${res.status} ${await res.text()}`);
  }
}
const github = (p, accept = "application/vnd.github+json") =>
  get(`https://api.github.com/${p}`, { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) });

// Yesterday (UTC): npm's last full day.
const end = day(new Date(Date.now() - 86_400_000));

const search = await get(`https://registry.npmjs.org/-/v1/search?text=maintainer:${encodeURIComponent(user)}&size=250`);
const names = search.objects.map((o) => o.package.name).sort();
if (!names.length) throw new Error(`npm のユーザー ${user} のパッケージがありません`);

const downloads = [];
const repos = new Set(values.repo ?? []);
for (const name of names) {
  const doc = await get(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
  const repo = githubRepo(doc?.repository?.url) ?? "";
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

const repoRows = [];
const stars = [];
for (const repo of [...repos].sort()) {
  const r = await github(`repos/${repo}`);
  if (!r) {
    console.warn(`${repo}: GitHub にありません（非公開か、名前が違います）`);
    continue;
  }
  repoRows.push({
    repo,
    description: r.description ?? "",
    language: r.language ?? "",
    stars: r.stargazers_count,
    forks: r.forks_count,
    open_issues: r.open_issues_count,
    created: r.created_at.slice(0, 10),
    pushed: r.pushed_at.slice(0, 10),
  });
  for (let page = 1; page <= 100; page++) {
    const list = await github(`repos/${repo}/stargazers?per_page=100&page=${page}`, "application/vnd.github.star+json");
    for (const s of list ?? []) stars.push({ date: s.starred_at.slice(0, 10), repo });
    if (!list || list.length < 100) break;
  }
  console.log(`${repo}: ${r.stargazers_count} stars`);
}

await mkdir(out, { recursive: true });
await writeFile(path.join(out, "downloads.csv"), toCsv(["date", "package", "repo", "downloads"], downloads));
await writeFile(
  path.join(out, "stars.csv"),
  toCsv(
    ["date", "repo"],
    stars.sort((a, b) => a.date.localeCompare(b.date)),
  ),
);
await writeFile(
  path.join(out, "repos.csv"),
  toCsv(["repo", "description", "language", "stars", "forks", "open_issues", "created", "pushed"], repoRows),
);
console.log(`data/ に書きました（${names.length} パッケージ、${repoRows.length} リポジトリ、${end} まで）`);
