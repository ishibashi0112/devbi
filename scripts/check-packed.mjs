#!/usr/bin/env node
// pnpm check:packed — the packages as users get them from npm, before publishing:
//   1. pnpm pack each package (workspace:^ becomes ^<version>, only the "files" go in)
//   2. create-devbi from its tarball makes a project, as `npm create devbi` would
//   3. npm, and then pnpm, install the other tarballs into a copy of it (no links; pnpm's strict node_modules)
//   4. the project's typecheck, devbi-check (DuckDB-wasm's Node build from the installed packages) and build
//   5. its dev server with the GUI editor (Playwright, packages/create-devbi/e2e): the dashboard draws, and
//      "コードにする" writes a tile out without a page reload.
// Run `pnpm build` first (pnpm check:packed does). The projects are left in the folder it prints, for a look.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const out = process.env.DEVBI_PACKED_DIR ? path.resolve(process.env.DEVBI_PACKED_DIR) : mkdtempSync(path.join(tmpdir(), "devbi-packed-"));
const tarballs = path.join(out, "tarballs");
// (Again into the same DEVBI_PACKED_DIR: only what this made there goes.)
for (const d of ["tarballs", "made", "app-npm", "app-pnpm"]) rmSync(path.join(out, d), { recursive: true, force: true });
mkdirSync(tarballs, { recursive: true });

const run = (cmd, args, cwd, env = {}) => {
  console.log(`\n$ ${[cmd, ...args].join(" ")}   (${cwd})`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
};
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

// 1. The packages that are published: every package in packages/ that is not private.
const packed = {};
for (const dir of readdirSync(path.join(repo, "packages")).sort()) {
  const cwd = path.join(repo, "packages", dir);
  const pkg = readJson(path.join(cwd, "package.json"));
  if (pkg.private) continue;
  const before = new Set(readdirSync(tarballs));
  run("pnpm", ["pack", "--pack-destination", tarballs], cwd);
  const made = readdirSync(tarballs).filter((f) => !before.has(f));
  if (made.length !== 1) throw new Error(`${pkg.name}: pnpm pack made ${made.join(", ") || "nothing"}`);
  packed[pkg.name] = path.join(tarballs, made[0]);
}

// 2. A project from create-devbi's tarball.
const made = path.join(out, "made");
run("npm", ["exec", "--yes", `--package=${packed["create-devbi"]}`, "--", "create-devbi", "made", "--no-git"], out, {
  npm_config_user_agent: "npm/10 node/v22",
});

for (const manager of ["npm", "pnpm"]) {
  // 3. The tarballs in place of the versions on npm, for the packages' own dependencies too (@devbi/vite →
  // @devbi/server, devbi): they are not on npm yet.
  const app = path.join(out, `app-${manager}`);
  cpSync(made, app, { recursive: true });
  const file = path.join(app, "package.json");
  const project = readJson(file);
  const tarball = Object.fromEntries(Object.entries(packed).filter(([name]) => name !== "create-devbi").map(([n, t]) => [n, `file:${t}`]));
  for (const deps of [project.dependencies, project.devDependencies]) for (const name of Object.keys(deps)) if (tarball[name]) deps[name] = tarball[name];
  if (manager === "npm") project.overrides = tarball;
  else project.pnpm = { overrides: tarball };
  writeJson(file, project);
  // No install scripts: none of these packages needs one (pnpm runs none by default either).
  if (manager === "npm") run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], app);
  else run("pnpm", ["install", "--ignore-workspace"], app);

  // 4. What a user runs first.
  run(manager, ["run", "typecheck"], app);
  run(manager, ["run", "check"], app);
  run(manager, ["run", "build"], app);

  // 5. The dev server, on the project without its self-written tile: then the tile "コードにする" writes is the first
  // .tsx, and what it imports (devbi, @devbi/react) has to be bundled ahead already, or Vite reloads the page.
  const dash = path.join(app, "dashboards/sales.dash.json");
  const spec = readJson(dash);
  spec.tiles = spec.tiles.filter((t) => !t.component);
  writeJson(dash, spec);
  rmSync(path.join(app, "dashboards/sales"), { recursive: true });
  run("pnpm", ["exec", "playwright", "test", "--trace", "off"], path.join(repo, "packages/create-devbi"), {
    DEVBI_PACKED_APP: app,
  });
}
console.log(`\nパックしたものから入れたプロジェクト: ${path.join(out, "app-npm")}、${path.join(out, "app-pnpm")}`);
