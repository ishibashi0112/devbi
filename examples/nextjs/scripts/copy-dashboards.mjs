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
// Snapshots are not static files here: app/devbi/[...path]/route.ts sends them from snapshots/, made by the server.
cpSync(from, to, { recursive: true, filter: (src) => !/[\\/]snapshots$/.test(src) && !src.endsWith("embed-demo.html") });
console.log(`${path.relative(process.cwd(), from)} を ${path.relative(process.cwd(), to)} に写しました`);
