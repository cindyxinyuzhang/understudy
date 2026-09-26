import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is proxied rather than called cross-origin in dev, so the browser sees
    // one origin and we never debug CORS or cookie-SameSite problems that will not
    // exist in production (where both sit behind one domain).
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
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
