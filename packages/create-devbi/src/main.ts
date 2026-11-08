import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { commandsOf, createProject, isEmptyFolder, isYarnBerry, packageManagerOf, version } from "./index.js";

const USAGE = `使い方: create-devbi [フォルダ] [--no-git]
  npm create devbi@latest my-reports のように使います。フォルダは、ないか空のものにしてください。
  --no-git  git init をしない（git のリポジトリの中では、もともとしません）。
            npm create では npm create devbi@latest my-reports -- --no-git のように -- のあとに書きます`;

export interface Io {
  cwd: string;
  /** npm_config_user_agent: which package manager ran this. */
  userAgent: string | undefined;
  /** npm_config_git: "false" when `npm create devbi x --no-git` (npm takes --no-git as its own setting). */
  npmGit?: string | undefined;
  out(text: string): void;
  err(text: string): void;
  /** Asks for the folder's name (a terminal only); undefined: take the default. */
  ask?(question: string): Promise<string>;
}

/** create-devbi's command line. Returns the exit code. */
export async function main(args: string[], io: Io): Promise<number> {
  let dir: string | undefined;
  let git = io.npmGit !== "false";
  for (const a of args) {
    if (a === "--no-git") git = false;
    else if (a === "-h" || a === "--help") {
      io.out(USAGE);
      return 0;
    } else if (a === "-v" || a === "--version") {
      io.out(version);
      return 0;
    } else if (a.startsWith("-") || dir !== undefined) {
      io.err(USAGE);
      return 2;
    } else dir = a;
  }
  if (dir === undefined) {
    dir = "my-reports";
    if (io.ask) {
      try {
        dir = (await io.ask(`フォルダの名前（${dir}）: `)).trim() || dir;
      } catch {
        // Ctrl+C or Ctrl+D at the question.
        io.err("\nやめました");
        return 130;
      }
    }
  }
  const target = path.resolve(io.cwd, dir);
  if (existsSync(target) && !statSync(target).isDirectory()) {
    io.err(`${dir} はファイルです。新しいフォルダの名前を指定してください`);
    return 1;
  }
  if (!isEmptyFolder(target)) {
    io.err(`${dir} は空ではありません。新しいフォルダの名前を指定してください`);
    return 1;
  }
  const pm = packageManagerOf(io.userAgent);
  const created = createProject(target, { packageManager: pm, git, yarnNodeModules: isYarnBerry(io.userAgent) });
  const { install, run } = commandsOf(pm);
  // As typed when it is under here, else the whole path.
  const relative = path.relative(io.cwd, created.dir);
  const rel = relative === "" ? "." : relative.startsWith("..") || path.isAbsolute(relative) ? created.dir : relative;
  const cd = rel === "." ? "" : `  cd ${/\s/.test(rel) ? JSON.stringify(rel) : rel}\n`;
  io.out(`
${rel} に DevBI のプロジェクトを作りました${created.git ? "（git init 済み）" : ""}。

${cd}  ${install}
  ${run} dev

開いたページの見出しの右の「編集」で、タイルを並べられます。ファイルの説明は README.md に。`);
  return 0;
}
