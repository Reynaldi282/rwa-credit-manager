import { defineConfig, devices } from "@playwright/test";

/**
 * UI smoke + end-to-end demo test against a LOCAL Anvil chain.
 * Prereqs: `npm run anvil`, `npm run deploy:local`, and apps/web/.env.local with the local settings
 * (see .env.example). Uses the "Anvil dev wallet" connector, so no browser extension or key is needed.
 *
 *   PW_CHANNEL=chrome npm run test:e2e -w @rwa/web     # use an installed Chrome / msedge
 *   npx playwright install chromium && npm run test:e2e -w @rwa/web
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 } } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
