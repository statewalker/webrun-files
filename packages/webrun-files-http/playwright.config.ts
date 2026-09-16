import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests of the client stub. Each test file starts its own server
 * (e2e/server.ts), so it can inspect the served file system directly.
 *
 * Chromium and Firefox always run — Firefox matters most, since it cannot
 * stream request bodies. WebKit is opt-in (`E2E_WEBKIT=1`): besides its browser
 * build (`npx playwright install webkit`) it needs system libraries that only
 * `sudo npx playwright install-deps webkit` provides.
 */
const hasWebkit = process.env.E2E_WEBKIT === "1";

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: { headless: true },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    ...(hasWebkit ? [{ name: "webkit", use: { ...devices["Desktop Safari"] } }] : []),
  ],
});
