import devbi from "@devbi/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so dist/ works from any folder (IIS, a file share, GitHub Pages).
  base: "./",
  plugins: [react(), devbi()],
  // Inside this monorepo, use the packages' TypeScript sources directly.
  resolve: { conditions: ["source", ...defaultClientConditions] },
});
