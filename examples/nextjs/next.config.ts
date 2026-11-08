import type { NextConfig } from "next";

const config: NextConfig = {
  // @devbi/server runs as it is in Node (database drivers, node:sqlite), not bundled.
  serverExternalPackages: ["@devbi/server"],
  // `next dev` would write AGENTS.md here; this example keeps only its own files.
  agentRules: false,
  turbopack: {
    // Only in this repository: @devbi/server is the workspace's packages/server, not in node_modules, so the build
    // would warn about its file reads as about the app's own. (Installed from npm, it is in node_modules.)
    ignoreIssue: [{ path: /packages[\\/]server[\\/]dist[\\/]/, title: /Dynamic filesystem access/ }],
  },
};

export default config;
