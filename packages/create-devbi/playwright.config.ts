// The project scripts/check-packed.mjs makes from the packed tarballs (DEVBI_PACKED_APP): its Vite dev server.
import { defineConfig, devices } from "@playwright/test";

const app = process.env.DEVBI_PACKED_APP;
if (!app) throw new Error("DEVBI_PACKED_APP がありません。pnpm check:packed から動かしてください");
const executablePath = process.env.E2E_BROWSER_EXECUTABLE;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1400, height: 1000 },
    baseURL: "http://127.0.0.1:5181",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5181 --strictPort",
    cwd: app,
    url: "http://127.0.0.1:5181",
    reuseExistingServer: false,
  },
});
