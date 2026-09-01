import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  testMatch: "performance.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 900_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:4175",
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: {
    command:
      "pnpm --filter @er-diagram/web build && pnpm --filter @er-diagram/web preview --host 127.0.0.1 --port 4175",
    reuseExistingServer: false,
    timeout: 180_000,
    url: "http://127.0.0.1:4175",
  },
});
