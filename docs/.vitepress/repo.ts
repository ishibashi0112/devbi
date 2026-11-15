// The documentation site is built from the repository's own Markdown (README.md and docs/*.md), unchanged, so that
// the same files read well on GitHub and on the site. This file holds what makes that work:
// - which files become pages, and at what path (docs/x.md → /x, README.md → /repository)
// - GitHub's heading anchors (the files link to #見出し the way GitHub makes them)
// - links to files that are not pages (../examples/oss, ../.github/workflows/…) go to the file on GitHub
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger, { slug } from "github-slugger";
import type { MarkdownRenderer } from "vitepress";

export const repoUrl = "https://github.com/ishibashi0112/devbi";
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Notes for whoever develops DevBI with Claude, not for users: left out of the site (links to it go to GitHub). */
const internal = new Set(["docs/handoff.md"]);

/** Source path (from the repository root) → page path on the site. */
export const pages: Record<string, string> = { "README.md": "repository.md" };
for (const name of fs.readdirSync(path.join(repoRoot, "docs")).sort()) {
  if (name.endsWith(".md") && !internal.has(`docs/${name}`)) pages[`docs/${name}`] = name;
}

/** Every other Markdown file in the repository (the packages' READMEs, the templates' AGENTS.md, …). */
export const notPages = [
  "**/node_modules/**",
  "**/dist/**",
  ...[...internal],
  ...fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "docs")
    .map((e) => `${e.name}/**`),
];

/** The level-2 headings of a page and their anchors, numbered the way GitHub numbers repeated headings. */
export function sections(source: string): { text: string; link: string }[] {
  const page = pages[source]?.replace(/\.md$/, "");
  if (page === undefined) throw new Error(`${source} is not a page of the site`);
  const slugger = new GithubSlugger();
  const out: { text: string; link: string }[] = [];
  let fence: string | null = null;
  for (const line of fs.readFileSync(path.join(repoRoot, source), "utf8").split("\n")) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark) {
      if (fence === null) fence = mark[0]!;
      else if (mark[0] === fence) fence = null;
      continue;
    }
    const h = fence === null ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (!h) continue;
    const text = h[2]!.replace(/`([^`]*)`/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const anchor = slugger.slug(text);
    if (h[1]!.length === 2) out.push({ text, link: `/${page}#${anchor}` });
  }
  return out;
}

/** Rewrites relative links by what they point at: a page → its path on the site; another file in the repository →
 *  that file on GitHub; nothing → left alone, so the build stops on it as a dead link. */
export function repoLinks(md: MarkdownRenderer) {
  md.core.ruler.push("devbi_repo_links", (state) => {
    const file: string | undefined = state.env.realPath ?? state.env.path;
    if (!file) return;
    const from = path.posix.dirname(path.relative(repoRoot, file).split(path.sep).join("/"));
    for (const block of state.tokens) {
      for (const token of block.children ?? []) {
        if (token.type !== "link_open") continue;
        const href = token.attrGet("href");
        if (!href || /^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) continue;
        const [rawPath, ...rest] = href.split("#");
        const hash = rest.length ? `#${rest.join("#")}` : "";
        const target = path.posix.normalize(path.posix.join(from, decodeURI(rawPath ?? "")));
        if (target.startsWith("..")) continue;
        const page = pages[target];
        if (page) {
          token.attrSet("href", `/${page}${hash}`);
          continue;
        }
        const onDisk = path.join(repoRoot, target);
        if (!fs.existsSync(onDisk)) continue;
        const kind = fs.statSync(onDisk).isDirectory() ? "tree" : "blob";
        token.attrSet("href", `${repoUrl}/${kind}/main/${target.replace(/\/$/, "")}${hash}`);
      }
    }
  });
}

/** GitHub's anchor for a heading (VitePress numbers repeated headings -1, -2, … the same way GitHub does). */
export function githubSlug(text: string) {
  return slug(text);
}
