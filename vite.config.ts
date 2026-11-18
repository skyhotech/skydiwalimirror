/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  base: "./",
  // Integration and browser suites may use different API origins. Sharing
  // their optimizer directory lets one server invalidate another's modules.
  cacheDir: process.env.VITE_CACHE_DIR || "node_modules/.vite",
  // Unit tests only; tests/ holds the Playwright browser tests.
  test: { exclude: ["**/node_modules/**", "**/dist/**", "tests/**"] },
  plugins: [react(), tailwindcss()],
  server: {
    // The Django backend (database, uploaded photos) and build/test output
    // live in this folder too; changes there must never reload the studio.
    watch: {
      ignored: [
        "**/backend/**",
        "**/dist/**",
        "**/test-results/**",
        "**/playwright-report/**",
        "**/graphify-out/**",
        "**/docs/**",
        "**/deploy/**",
        "**/tests/**",
        "**/scripts/**",
        "**/*.test.ts",
        "**/*.md",
      ],
    },
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/media": "http://127.0.0.1:8000",
      // Staff dashboard and Django admin, so they also work on the Vite port.
      "/sky": "http://127.0.0.1:8000",
      "/django-admin": "http://127.0.0.1:8000",
      "/static": "http://127.0.0.1:8000",
    },
  },
  worker: { format: "es" },
  build: { target: "es2022" },
});
