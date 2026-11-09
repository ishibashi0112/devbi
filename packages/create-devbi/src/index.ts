import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The sample project this package copies (dashboards/, models/, data/ as in examples/sales). */
export const templateDir = fileURLToPath(new URL("../template/", import.meta.url));

/** This package's version: the DevBI packages the new project depends on are the same version. */
export const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** The DevBI packages a project uses (at `^<version>`). */
export const DEVBI_DEPENDENCIES = ["@devbi/react", "devbi"] as const;
export const DEVBI_DEV_DEPENDENCIES = ["@devbi/editor", "@devbi/vite"] as const;

/** The other packages, at the versions examples/sales is tested with (a test keeps them the same). */
export const DEPENDENCIES: Record<string, string> = { react: "^19.3.1", "react-dom": "^19.3.1" };
export const DEV_DEPENDENCIES: Record<string, string> = {
  "@types/node": "^22.19.0",
  "@types/react": "^19.2.0",
  "@types/react-dom": "^19.2.0",
  "@vitejs/plugin-react": "^6.2.1",
  typescript: "~6.0.3",
  vite: "^8.3.6",
};

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** The package manager that ran this (`npm create`, `pnpm create`…), from the user agent it sets. */
export function packageManagerOf(userAgent: string | undefined): PackageManager {
  const name = userAgent?.split("/")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}

/** Yarn 2 or later (Plug'n'Play by default: no node_modules, where @devbi/vite looks for the GUI editor). */
export function isYarnBerry(userAgent: string | undefined): boolean {
  const m = /^yarn\/(\d+)/.exec(userAgent ?? "");
  return !!m && Number(m[1]) >= 2;
}

/** The commands to install and to run a script, as the README and the last message show them. */
export function commandsOf(pm: PackageManager): { install: string; run: string } {
  // `yarn check` is Yarn 1's own command, not the script: `yarn run` for Yarn.
  return { install: pm === "yarn" ? "yarn" : `${pm} install`, run: pm === "pnpm" ? pm : `${pm} run` };
}

/** A package name (package.json "name") from the folder's name: `My Reports` → `my-reports`. */
export function packageNameOf(folder: string): string {
  const name = folder
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[-._~]+|[-._~]+$/g, "")
    .slice(0, 214);
  return name || "devbi-reports";
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface CreateOptions {
  /** The package manager whose commands the README shows. */
  packageManager?: PackageManager;
  /** Run `git init` (unless the folder is in a git repository already). Default true. */
  git?: boolean;
  /** Yarn 2 or later: a .yarnrc.yml that makes node_modules (Vite and @devbi/vite look for packages there). */
  yarnNodeModules?: boolean;
}

export interface Created {
  dir: string;
  name: string;
  /** Whether `git init` made a repository. */
  git: boolean;
}

/** Whether a folder can take the project: missing, or empty (a `.git` alone is fine). Not a file. */
export function isEmptyFolder(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return statSync(dir).isDirectory() && readdirSync(dir).every((f) => f === ".git");
}

/** Makes a DevBI project in `dir` (missing or empty): the sample dashboard, Vite, React and the GUI editor. */
export function createProject(dir: string, options: CreateOptions = {}): Created {
  const target = path.resolve(dir);
  if (!isEmptyFolder(target)) throw new Error(`${dir} は空ではありません。新しいフォルダの名前を指定してください`);
  const name = packageNameOf(path.basename(target));
  const { install, run } = commandsOf(options.packageManager ?? "npm");
  cpSync(templateDir, target, { recursive: true });
  // npm leaves .gitignore out of a package, so the template has it as _gitignore.
  renameSync(path.join(target, "_gitignore"), path.join(target, ".gitignore"));
  const fill = (file: string, values: Record<string, string>) => {
    const p = path.join(target, file);
    writeFileSync(p, readFileSync(p, "utf8").replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m));
  };
  fill("README.md", { name, install, run });
  fill("AGENTS.md", { run });
  fill("index.html", { name: escapeHtml(name) });
  const range = `^${version}`;
  const pkg = {
    name,
    private: true,
    type: "module",
    scripts: {
      dev: "vite",
      build: "vite build",
      preview: "vite preview",
      gen: "devbi-gen",
      check: "devbi-check",
      inspect: "devbi-inspect",
      typecheck: "devbi-gen && tsc -p tsconfig.json",
    },
    dependencies: sorted({ ...Object.fromEntries(DEVBI_DEPENDENCIES.map((d) => [d, range])), ...DEPENDENCIES }),
    devDependencies: sorted({ ...Object.fromEntries(DEVBI_DEV_DEPENDENCIES.map((d) => [d, range])), ...DEV_DEPENDENCIES }),
  };
  writeFileSync(path.join(target, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  if (options.yarnNodeModules) writeFileSync(path.join(target, ".yarnrc.yml"), "nodeLinker: node-modules\n");
  return { dir: target, name, git: options.git !== false && gitInit(target) };
}

const sorted = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/** `git init`, unless git is missing or the folder is in a repository already (a monorepo). */
function gitInit(dir: string): boolean {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, encoding: "utf8" });
  if (inside.error || inside.stdout.trim() === "true") return false;
  return spawnSync("git", ["init", "-q"], { cwd: dir }).status === 0;
}
