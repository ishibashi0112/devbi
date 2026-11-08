import { defineConfig, devices } from "@playwright/test";

const executablePath = process.env.E2E_BROWSER_EXECUTABLE;
// A server started some other way (the ASP.NET Core sample in dotnet/): its URL, and no devbi-serve.
const baseURL = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: baseURL ?? "http://127.0.0.1:4179",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 1000 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  // devbi-serve: the built site (dist/) and the read-only API (api/*.sql → db/sales.sqlite, from .env).
  webServer: baseURL
    ? undefined
    : {
        command: "pnpm exec devbi-serve --port 4179 --host 127.0.0.1",
        url: "http://127.0.0.1:4179",
        reuseExistingServer: !process.env.CI,
      },
});
