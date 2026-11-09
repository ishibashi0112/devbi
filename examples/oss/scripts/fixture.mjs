// Made-up numbers in data/, in the shape fetch-stats.mjs writes: for trying the dashboard without the network, and
// for CI's devbi-check. Not the demo's data (the packages and repositories do not exist).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { day, toCsv } from "./stats.mjs";

let seed = 20261109;
function rand() {
  // mulberry32
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const end = Date.parse("2026-11-08T00:00:00Z");
const packages = [
  { name: "example-grid", repo: "example/grid", days: 200, base: 120 },
  { name: "@example/grid-core", repo: "example/grid", days: 200, base: 110 },
  { name: "example-cli", repo: "example/cli", days: 90, base: 30 },
];
const downloads = [];
for (const p of packages) {
  for (let i = p.days - 1; i >= 0; i--) {
    const d = new Date(end - i * 86_400_000);
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 0.4 : 1;
    const growth = 1 + (p.days - i) / p.days;
    downloads.push({
      date: day(d),
      package: p.name,
      repo: p.repo,
      downloads: Math.round(p.base * growth * weekend * (0.6 + rand() * 0.8)),
    });
  }
}
const repos = [
  {
    repo: "example/cli",
    description: "作りもののデータ（fixture）",
    language: "TypeScript",
    stars: 7,
    forks: 1,
    open_issues: 2,
    created: "2026-08-10",
    pushed: "2026-11-01",
  },
  {
    repo: "example/docs",
    description: "スターのないリポジトリ",
    language: "",
    stars: 0,
    forks: 0,
    open_issues: 0,
    created: "2026-10-01",
    pushed: "2026-10-02",
  },
  {
    repo: "example/grid",
    description: "作りもののデータ（fixture）",
    language: "TypeScript",
    stars: 42,
    forks: 3,
    open_issues: 5,
    created: "2026-04-22",
    pushed: "2026-11-08",
  },
];

const out = path.join(import.meta.dirname, "..", "data");
await mkdir(out, { recursive: true });
await writeFile(path.join(out, "downloads.csv"), toCsv(["date", "package", "repo", "downloads"], downloads));
await writeFile(
  path.join(out, "repos.csv"),
  toCsv(["repo", "description", "language", "stars", "forks", "open_issues", "created", "pushed"], repos),
);
console.log("data/ に作りもののデータを書きました（fixture）");
