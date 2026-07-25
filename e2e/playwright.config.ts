import { defineConfig, devices } from "@playwright/test";

/**
 * Everything — UI specs and API specs alike — runs against the nginx origin.
 * The API specs deliberately go through the same `/api` proxy the browser uses
 * rather than talking to Django directly, so the tests exercise the real
 * request path instead of a shortcut around it.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://frontend";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 10_000 },

  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],

  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
