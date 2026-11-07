import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["source"] },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    // Run in a non-UTC zone (the users are in Japan) so local-time mistakes in date handling show up.
    env: { TZ: "Asia/Tokyo" },
  },
});
