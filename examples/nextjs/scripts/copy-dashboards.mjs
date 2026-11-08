// Copy the dashboards' build (examples/sales/dist: devbi-embed.js, the engine, the data files) to public/devbi/,
// where the page loads devbi-embed.js from. Runs before `next dev` and `next build`; build the dashboards first
// (pnpm example:build at the top). In your own app, copy your DevBI project's dist/ the same way.
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.resolve(here, "../../sales/dist");
const to = path.resolve(here, "../public/devbi");
if (!existsSync(path.join(from, "devbi-embed.js"))) {
  console.error(`${from} に devbi-embed.js がありません。先にダッシュボードをビルドしてください（いちばん上で pnpm example:build）`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
// Left out: snapshots/ (app/devbi/[...path]/route.ts sends them from the server's folder, made each morning; a copy
// in public/ would be served before the route, and stay as it was when the server started), and the pages of the
// dashboards' own site (index.html, embed-demo.html): this app's pages show the dashboards.
const skip = new Set(["snapshots", "index.html", "embed-demo.html"].map((name) => path.join(from, name)));
cpSync(from, to, { recursive: true, filter: (src) => !skip.has(src) });
console.log(`${path.relative(process.cwd(), from)} を ${path.relative(process.cwd(), to)} に写しました`);
