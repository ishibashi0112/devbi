import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readProject } from "@devbi/vite";
import { describe, expect, it } from "vitest";
import {
  DEPENDENCIES,
  DEV_DEPENDENCIES,
  commandsOf,
  createProject,
  packageManagerOf,
  packageNameOf,
  templateDir,
  version,
} from "../src/index.js";
import { main } from "../src/main.js";

const repo = path.resolve(import.meta.dirname, "../../..");
const example = path.join(repo, "examples/sales");
const tmp = () => mkdtempSync(path.join(tmpdir(), "create-devbi-"));
const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();

describe("create-devbi", () => {
  it("makes a project: the sample dashboard, Vite, React and the editor, at this version", () => {
    const dir = path.join(tmp(), "My Reports");
    const created = createProject(dir, { packageManager: "pnpm", git: false });
    expect(created).toEqual({ dir, name: "my-reports", git: false });
    expect(files(dir)).toEqual([
      ".gitignore",
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      "dashboards/sales.dash.json",
      "dashboards/sales/TopCustomers.tsx",
      "data/sales.xlsx",
      "index.html",
      "models/sales.metrics.yaml",
      "package.json",
      "src/app.css",
      "src/main.tsx",
      "tsconfig.json",
      "vite.config.ts",
    ]);
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-reports");
    expect(pkg.dependencies).toEqual({ "@devbi/react": `^${version}`, devbi: `^${version}`, react: "^19.3.1", "react-dom": "^19.3.1" });
    expect(pkg.devDependencies["@devbi/vite"]).toBe(`^${version}`);
    expect(pkg.devDependencies["@devbi/editor"]).toBe(`^${version}`);
    expect(pkg.scripts.dev).toBe("vite");
    expect(pkg.scripts.check).toBe("devbi-check");
    const readme = readFileSync(path.join(dir, "README.md"), "utf8");
    expect(readme).toMatch(/^# my-reports\n/);
    expect(readme).toContain("pnpm install\npnpm dev ");
    expect(readme).not.toContain("{{");
    // The procedure for AI, with the package manager's commands; Claude Code reads it through CLAUDE.md.
    const agents = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("`pnpm check`");
    expect(agents).not.toContain("{{");
    expect(readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toContain("\n@AGENTS.md\n");
    expect(readFileSync(path.join(dir, "index.html"), "utf8")).toContain("<title>my-reports</title>");
  });

  it("copies the sample as examples/sales has it, and the dashboard loads", async () => {
    for (const f of [
      "dashboards/sales.dash.json",
      "dashboards/sales/TopCustomers.tsx",
      "data/sales.xlsx",
      "models/sales.metrics.yaml",
      "src/main.tsx",
      "src/app.css",
      "CLAUDE.md",
    ]) {
      expect(readFileSync(path.join(templateDir, f)), f).toEqual(readFileSync(path.join(example, f)));
    }
    // The sample's AGENTS.md is the template's with pnpm (edit the template and copy it over).
    expect(readFileSync(path.join(templateDir, "AGENTS.md"), "utf8").replaceAll("{{run}}", "pnpm")).toBe(
      readFileSync(path.join(example, "AGENTS.md"), "utf8"),
    );
    const dir = path.join(tmp(), "p");
    createProject(dir, { git: false });
    // As the dev server and the build read it: every file checked, and the files it points at there.
    const project = await readProject(dir);
    expect(Object.keys(project.dashboards)).toEqual(["sales"]);
    expect(project.data).toEqual(["data/sales.xlsx"]);
  });

  it("uses the versions of React, Vite and TypeScript that this repository tests with", () => {
    const sales = JSON.parse(readFileSync(path.join(example, "package.json"), "utf8"));
    const root = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
    const tested = { ...root.devDependencies, ...sales.dependencies, ...sales.devDependencies };
    for (const [name, range] of Object.entries({ ...DEPENDENCIES, ...DEV_DEPENDENCIES })) expect(range, name).toBe(tested[name]);
  });

  it("writes only into a missing or empty folder", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "notes.txt"), "mine");
    expect(() => createProject(dir, { git: false })).toThrow(/空ではありません/);
    expect(readdirSync(dir)).toEqual(["notes.txt"]);
    const withGit = path.join(tmp(), "g");
    mkdirSync(path.join(withGit, ".git"), { recursive: true });
    expect(createProject(withGit, { git: false }).name).toBe("g");
  });

  it("runs git init, except inside a repository", () => {
    if (spawnSync("git", ["--version"]).status !== 0) return;
    const dir = path.join(tmp(), "reports");
    expect(createProject(dir).git).toBe(true);
    expect(existsSync(path.join(dir, ".git"))).toBe(true);
    const nested = path.join(dir, "inner");
    expect(createProject(nested).git).toBe(false);
    expect(existsSync(path.join(nested, ".git"))).toBe(false);
  });

  it("names the package, and shows the commands of the package manager that ran it", () => {
    expect(packageNameOf("My Reports")).toBe("my-reports");
    expect(packageNameOf("売上レポート")).toBe("devbi-reports");
    expect(packageNameOf("_x_")).toBe("x");
    expect(packageManagerOf("pnpm/10.28.0 npm/? node/v22.23.4 linux x64")).toBe("pnpm");
    expect(packageManagerOf("yarn/1.22.22 npm/? node/v22")).toBe("yarn");
    expect(packageManagerOf(undefined)).toBe("npm");
    expect(commandsOf("npm")).toEqual({ install: "npm install", run: "npm run" });
    expect(commandsOf("yarn")).toEqual({ install: "yarn", run: "yarn run" });
    expect(commandsOf("bun")).toEqual({ install: "bun install", run: "bun run" });
  });

  it("works from the command line", async () => {
    const cwd = tmp();
    const run = async (args: string[], ask?: string | Error, more: { userAgent?: string; npmGit?: string } = {}) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(args, {
        cwd,
        userAgent: more.userAgent ?? "pnpm/10.28.0 npm/? node/v22",
        npmGit: more.npmGit,
        out: (t) => out.push(t),
        err: (t) => err.push(t),
        ...(ask === undefined ? {} : { ask: async () => (ask instanceof Error ? Promise.reject(ask) : ask) }),
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const made = await run(["reports", "--no-git"]);
    expect(made.code, made.err).toBe(0);
    expect(made.out).toContain("reports に DevBI のプロジェクトを作りました。");
    expect(made.out).toContain("  cd reports\n  pnpm install\n  pnpm dev\n");
    expect(existsSync(path.join(cwd, "reports", "package.json"))).toBe(true);
    const again = await run(["reports"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("reports は空ではありません");
    expect((await run(["a", "b"])).code).toBe(2);
    expect((await run(["--nope"])).code).toBe(2);
    // No folder given: asked in a terminal, else my-reports.
    expect((await run(["--no-git"], "月次 売上")).out).toContain(`  cd "月次 売上"\n`);
    expect(JSON.parse(readFileSync(path.join(cwd, "月次 売上", "package.json"), "utf8")).name).toBe("devbi-reports");
    expect((await run(["--no-git"])).out).toContain("  cd my-reports\n");
    // Ctrl+C at the question: nothing made.
    const quit = await run([], new Error("Aborted with Ctrl+C"));
    expect(quit).toEqual({ code: 130, out: "", err: "\nやめました" });
    // A file of that name.
    writeFileSync(path.join(cwd, "notes"), "mine");
    expect((await run(["notes"])).err).toContain("notes はファイルです");
    // `npm create devbi x --no-git`: npm keeps --no-git for itself and says so in npm_config_git.
    if (spawnSync("git", ["--version"]).status === 0) {
      expect((await run(["by-npm"], undefined, { userAgent: "npm/10.9.0 node/v22", npmGit: "false" })).out).not.toContain("git init 済み");
      expect(existsSync(path.join(cwd, "by-npm", ".git"))).toBe(false);
    }
    // Yarn 2 or later: node_modules, where @devbi/vite finds the GUI editor (Plug'n'Play has none).
    await run(["berry", "--no-git"], undefined, { userAgent: "yarn/4.9.2 npm/? node/v22" });
    expect(readFileSync(path.join(cwd, "berry", ".yarnrc.yml"), "utf8")).toBe("nodeLinker: node-modules\n");
    await run(["classic", "--no-git"], undefined, { userAgent: "yarn/1.22.22 npm/? node/v22" });
    expect(existsSync(path.join(cwd, "classic", ".yarnrc.yml"))).toBe(false);
    // Outside the folder it ran in: the whole path.
    const away = path.join(tmp(), "away");
    expect((await run([path.relative(cwd, away), "--no-git"])).out).toContain(`${away} に DevBI のプロジェクトを作りました。\n\n  cd ${away}\n`);
  });
});
