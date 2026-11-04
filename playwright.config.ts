import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  timeout: 30_000,
  reporter: "list",
  use: {
    baseURL: process.env.FILEWORKER_PREVIEW_URL ?? "http://127.0.0.1:1420",
    browserName: "chromium",
    viewport: { width: 1280, height: 820 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bash scripts/run.sh dev --port 1420 --strictPort",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
  },
});
