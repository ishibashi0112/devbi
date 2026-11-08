import type { NextConfig } from "next";

const config: NextConfig = {
  // @devbi/server from node_modules runs as it is in Node, not bundled. (Here it is the workspace's packages/server,
  // which Next.js bundles all the same; it loads the database drivers with import() left to Node, so both work.)
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
