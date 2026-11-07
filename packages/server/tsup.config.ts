import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
  platform: "node",
  external: ["pg"],
  // node:sqlite exists only with the node: prefix.
  removeNodeProtocol: false,
});
