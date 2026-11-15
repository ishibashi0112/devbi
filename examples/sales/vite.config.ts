import devbi from "@devbi/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so dist/ works from any folder of a web server (IIS, nginx, GitHub Pages; not opened as a file).
  base: "./",
  // embed: also build devbi-embed.js, the one script that puts these dashboards into another app's page
  // (see public/embed-demo.html).
  plugins: [react(), devbi({ embed: true })],
  // Inside this monorepo, use the packages' TypeScript sources directly.
  resolve: { conditions: ["source", ...defaultClientConditions] },
});
