import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.integration.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5174",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `${process.env.TEST_PYTHON || "backend/.venv/bin/python"} scripts/serve_audit_backend.py`,
      url: "http://127.0.0.1:8001/api/mirrors/version/",
      reuseExistingServer: false,
    },
    {
      command:
        "npm run dev:frontend -- --host 127.0.0.1 --port 5174 --strictPort",
      url: "http://127.0.0.1:5174",
      env: {
        VITE_API_URL: "http://127.0.0.1:8001",
        VITE_CACHE_DIR: "node_modules/.vite-integration-tests",
      },
      reuseExistingServer: false,
    },
  ],
});
