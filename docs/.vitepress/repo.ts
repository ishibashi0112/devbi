// The documentation site is built from the repository's own Markdown (README.md and docs/*.md), unchanged, so that
// the same files read well on GitHub and on the site. This file holds what makes that work:
// - which files become pages, and at what path (docs/x.md → /x, README.md → /repository)
// - GitHub's heading anchors (the files link to #見出し the way GitHub makes them)
// - links to files that are not pages (../examples/oss, ../.github/workflows/…) go to the file on GitHub
// - the build stops on a link to a file, page or heading that is not there
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slug } from "github-slugger";
import { createMarkdownRenderer, disposeMdItInstance, type MarkdownRenderer, type SiteConfig } from "vitepress";

export const repoUrl = "https://github.com/ishibashi0112/devbi";
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Notes for whoever develops DevBI with Claude, not for users: left out of the site (links to it go to GitHub). */
const internal = new Set(["docs/handoff.md"]);

/** Source path (from the repository root) → page path on the site. */
export const pages: Record<string, string> = { "README.md": "repository.md" };
for (const name of fs.readdirSync(path.join(repoRoot, "docs")).sort()) {
  if (name.endsWith(".md") && !internal.has(`docs/${name}`)) pages[`docs/${name}`] = name;
}

/** Everything else, so that only the files above become pages (VitePress takes every Markdown file under srcDir). */
export const notPages = [
  "**/node_modules/**",
  ...[...internal],
  "docs/*/**",
  ...fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((e) => (e.isDirectory() ? e.name !== "docs" : e.name.endsWith(".md") && !pages[e.name]))
    .map((e) => (e.isDirectory() ? `${e.name}/**` : e.name)),
];

/** GitHub's anchor for a heading (VitePress numbers repeated headings -1, -2, … the same way GitHub does). */
export function githubSlug(text: string) {
  return slug(text);
}

/** The level-2 headings of each page, with the ids VitePress gives them: read with VitePress's own Markdown parser
 *  (set up like the site's), then put away so that the build makes its own. */
export async function sections(): Promise<Record<string, { text: string; link: string }[]>> {
  const md = await createMarkdownRenderer(repoRoot, { anchor: { slugify: githubSlug }, highlight: () => "" });
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  try {
    const out: Record<string, { text: string; link: string }[]> = {};
    for (const [source, page] of Object.entries(pages)) {
      const file = path.join(repoRoot, source);
      const tokens = md.parse(fs.readFileSync(file, "utf8"), { path: file, relativePath: page, cleanUrls: true });
      out[source] = tokens.flatMap((t, i) => {
        const id = t.attrGet("id");
        if (t.type !== "heading_open" || t.tag !== "h2" || t.level !== 0 || !id) return [];
        // The text the anchor was made from (markdown-it-anchor's): the words and the `code`, without the marks.
        const text = (tokens[i + 1]?.children ?? [])
          .filter((c) => c.type === "text" || c.type === "code_inline")
          .map((c) => c.content)
          .join("");
        // Encoded like the browser's location.hash, so that the sidebar marks the heading you are at.
        return [{ text: escape(text), link: `/${page.replace(/\.md$/, "")}#${encodeURIComponent(id)}` }];
      });
    }
    return out;
  } finally {
    disposeMdItInstance();
  }
}

/** The files git has (not what a build or an editor left in the working tree): what GitHub will show. */
const tracked: Set<string> | null = (() => {
  try {
    return new Set(execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" }).split("\0"));
  } catch {
    return null;
  }
})();
function onGitHub(target: string): "blob" | "tree" | null {
  if (tracked) {
    if (tracked.has(target)) return "blob";
    for (const f of tracked) if (f.startsWith(`${target}/`)) return "tree";
    return null;
  }
  const onDisk = path.join(repoRoot, target);
  if (!fs.existsSync(onDisk)) return null;
  return fs.statSync(onDisk).isDirectory() ? "tree" : "blob";
}

/** Links to files that are not there, found while the pages were made: the build stops on them at the end. */
const brokenLinks = new Set<string>();

/** Rewrites relative links by what they point at: a page → its path on the site; another file in the repository →
 *  that file on GitHub; nothing → noted as broken (VitePress itself does not look at links to .yml, .json, …). */
export function repoLinks(md: MarkdownRenderer) {
  md.core.ruler.push("devbi_repo_links", (state) => {
    const file: string | undefined = state.env.realPath ?? state.env.path;
    if (!file) return;
    const source = path.relative(repoRoot, file).split(path.sep).join("/");
    for (const block of state.tokens) {
      for (const token of block.children ?? []) {
        if (token.type !== "link_open") continue;
        const href = token.attrGet("href");
        if (!href || /^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) continue;
        const [rawPath, ...rest] = href.split("#");
        const hash = rest.length ? `#${rest.join("#")}` : "";
        const target = path.posix
          .normalize(path.posix.join(path.posix.dirname(source), decodeURI(rawPath ?? "")))
          .replace(/\/$/, "");
        const page = pages[target];
        const kind = page ? null : onGitHub(target);
        if (page) token.attrSet("href", `/${page}${hash}`);
        else if (kind) token.attrSet("href", `${repoUrl}/${kind}/main/${target}${hash}`);
        else if (!brokenLinks.has(`${source}: ${href}`)) {
          brokenLinks.add(`${source}: ${href}`);
          console.warn(`\n(!) ${source}: ${href} はリポジトリにありません`);
        }
      }
    }
  });
}

/** After the build: links to files that are not in the repository, and links to a heading (#…) of a page of this
 *  site that the page does not have. Either stops the build. */
export function checkLinks(site: SiteConfig) {
  const problems = [...brokenLinks].map((l) => `${l}（リポジトリにないファイル）`);
  const base = site.site.base;
  const ids = new Map<string, Set<string>>();
  const links: [string, string][] = [];
  const html = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  for (const name of fs.readdirSync(site.outDir)) {
    if (!name.endsWith(".html")) continue;
    const text = fs.readFileSync(path.join(site.outDir, name), "utf8");
    const page = name.replace(/\.html$/, "");
    ids.set(page, new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => decodeURIComponent(html(m[1]!)))));
    for (const m of text.matchAll(/\shref="([^"]+)"/g)) links.push([page, html(m[1]!)]);
  }
  for (const [page, href] of links) {
    const hash = href.indexOf("#");
    if (hash < 0 || !(href.startsWith("#") || href.startsWith(base))) continue;
    const target = href.startsWith("#") ? page : href.slice(base.length, hash).replace(/\.html$/, "") || "index";
    const id = decodeURIComponent(href.slice(hash + 1));
    if (id && ids.has(target) && !ids.get(target)!.has(id)) problems.push(`${page}.html: ${href}（見出しがない）`);
  }
  if (problems.length) {
    throw new Error(`リンク切れが ${problems.length} 個あります:\n${[...new Set(problems)].join("\n")}`);
  }
}
