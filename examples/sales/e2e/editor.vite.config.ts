// The dev server for e2e/editor.spec.ts: the sales example's dashboard, models and data copied into e2e-work/ (the
// editor writes there, never to the example's own files).
import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import devbi from "@devbi/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

const root = path.resolve(import.meta.dirname, "..");
export const work = path.join(root, "e2e-work");
export const copied = ["dashboards/sales.dash.json", "dashboards/sales", "models/sales.metrics.yaml", "data/sales.xlsx"];

rmSync(work, { recursive: true, force: true });
for (const p of copied) cpSync(path.join(root, p), path.join(work, p), { recursive: true });

export default defineConfig({
  root,
  base: "./",
  plugins: [react(), devbi({ dir: "e2e-work" })],
  resolve: { conditions: ["source", ...defaultClientConditions] },
  server: { host: "127.0.0.1", port: 5179, strictPort: true },
  logLevel: "warn",
});
