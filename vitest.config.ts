import { defineConfig } from "vitest/config";

export default defineConfig({
  // The workspace packages' TypeScript sources ("source" in their exports), not dist/: the tests need no build
  // first and never run old code. The tests run on Node, which Vite resolves for as "ssr".
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"], externalConditions: ["source"] } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    // Run in a non-UTC zone (the users are in Japan) so local-time mistakes in date handling show up.
    env: { TZ: "Asia/Tokyo" },
  },
});
