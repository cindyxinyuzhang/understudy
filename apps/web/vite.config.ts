import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is proxied rather than called cross-origin in dev, so the browser sees
    // one origin and we never debug CORS or cookie-SameSite problems that will not
    // exist in production (where both sit behind one domain).
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      // Page images when the API runs with STORAGE_BACKEND=local. With S3 these URLs
      // are absolute and presigned, and never touch the dev server.
      "/files": { target: apiTarget, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // Playwright specs live in e2e/ and are driven by Playwright, not Vitest.
    exclude: ["e2e/**", "node_modules/**"],
  },
});
