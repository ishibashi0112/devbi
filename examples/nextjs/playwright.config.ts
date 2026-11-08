import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.E2E_BROWSER_EXECUTABLE;
const port = 4180;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 1000 } } }],
  // next start: the build of `pnpm build` (next build), with the API in app/devbi/[...path]/route.ts.
  webServer: {
    command: `pnpm exec next start --port ${port} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
