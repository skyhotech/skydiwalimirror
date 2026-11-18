import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:5175", trace: "retain-on-failure" },
  webServer: {
    // Browser suites mock API writes. Never start a development database or
    // reuse a production backend just to run frontend regression tests.
    command:
      "npm run dev:frontend -- --host 127.0.0.1 --port 5175 --strictPort",
    url: "http://127.0.0.1:5175",
    reuseExistingServer: false,
    env: { VITE_CACHE_DIR: "node_modules/.vite-browser-tests" },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});
