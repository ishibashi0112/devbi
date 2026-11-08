// create-devbi [フォルダ] [--no-git]
// `npm create devbi@latest my-reports` (pnpm create devbi / yarn create devbi / bun create devbi): a new DevBI project.
import { createInterface } from "node:readline/promises";
import { main } from "./main.js";

const terminal = process.stdin.isTTY && process.stdout.isTTY;
process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  userAgent: process.env.npm_config_user_agent,
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  ...(terminal
    ? {
        ask: async (question: string) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return await rl.question(question);
          } finally {
            rl.close();
          }
        },
      }
    : {}),
});
