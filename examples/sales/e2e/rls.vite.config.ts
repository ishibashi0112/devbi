// The dev server for e2e/rls.spec.ts: row-level security (api/*.sql with :user.region) and 「表示する利用者」, on the
// small project in e2e/rls/ (its own api/, models/, dashboards/; the sample's SQLite through e2e/rls/.env). Its build
// (pnpm build, into e2e/rls/dist with devbi-embed.js) is the Next.js example's 「担当の売上」 (examples/nextjs).
import path from "node:path";
import devbi from "@devbi/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(import.meta.dirname, ".."),
  base: "./",
  envDir: "e2e/rls",
  plugins: [
    react(),
    devbi({
      dir: "e2e/rls",
      embed: true,
      // Who the dev server's API can answer as (only for pages opened on this computer). The host app passes the
      // same shape in production: { id, roles, attrs }.
      devUsers: {
        yamada: { id: "CORP\\yamada", roles: ["営業"], attrs: { region: "関東" } },
        suzuki: { id: "CORP\\suzuki", roles: ["営業"], attrs: { region: "近畿" } },
        sato: { roles: ["営業"] },
      },
    }),
  ],
  resolve: { conditions: ["source", ...defaultClientConditions] },
  build: { outDir: "e2e/rls/dist", emptyOutDir: true },
  // public/embed-demo.html shows the sales example's dashboards, not these.
  publicDir: false,
  // The API's log lines (who read what) show in the terminal.
  server: { host: "127.0.0.1", port: 5180, strictPort: true },
});
