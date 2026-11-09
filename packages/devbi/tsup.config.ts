import { copyFile, mkdir } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2023",
  // The reference goes in the package (docs/reference.md), for the AGENTS.md of a project to point an AI at the
  // version that is installed. The copy is not in git: docs/reference.md is the one to edit.
  async onSuccess() {
    await mkdir("docs", { recursive: true });
    await copyFile("../../docs/reference.md", "docs/reference.md");
  },
});
