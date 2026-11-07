import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.E2E_BROWSER_EXECUTABLE;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4179",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 1000 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  // devbi-serve: the built site (dist/) and the read-only API (api/*.sql → db/sales.sqlite, from .env).
  webServer: {
    command: "pnpm exec devbi-serve --port 4179 --host 127.0.0.1",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: !process.env.CI,
  },
});
