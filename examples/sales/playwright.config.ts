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
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 1000 } }, testIgnore: /(mobile|editor)\.spec\.ts/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
    // The GUI editor on Vite's dev server (only there; another server given by E2E_BASE_URL has no editor).
    ...(baseURL
      ? []
      : [
          {
            name: "editor",
            use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 1000 }, baseURL: "http://127.0.0.1:5179" },
            testMatch: /editor\.spec\.ts/,
          },
        ]),
  ],
  webServer: baseURL
    ? undefined
    : [
        // devbi-serve: the built site (dist/) and the read-only API (api/*.sql → db/sales.sqlite, from .env).
        {
          command: "pnpm exec devbi-serve --port 4179 --host 127.0.0.1",
          url: "http://127.0.0.1:4179",
          reuseExistingServer: !process.env.CI,
        },
        // Vite's dev server on a copy of the sales dashboard in e2e-work/, for the editor to write to.
        {
          command: "pnpm exec vite --config e2e/editor.vite.config.ts",
          url: "http://127.0.0.1:5179",
          reuseExistingServer: !process.env.CI,
        },
      ],
});
