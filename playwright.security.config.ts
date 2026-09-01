import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  testMatch: "csp-security.spec.ts",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4174",
    headless: true,
  },
  webServer: {
    command: "pnpm --filter @er-diagram/web build && node scripts/serve-web-security.mjs",
    reuseExistingServer: false,
    timeout: 120_000,
    url: "http://127.0.0.1:4174",
  },
});
