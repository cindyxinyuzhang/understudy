import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests.
 *
 * `webServer` starts the API in its dependency-free mode — SQLite, inline jobs, local
 * file storage, the fake OMR engine — so the suite needs no Postgres, no Redis, no
 * MinIO and no GPU. That is the whole reason those backends exist: an e2e suite that
 * needs five services is an e2e suite nobody runs locally and that flakes in CI.
 *
 * Each run gets a fresh database file, so tests never inherit each other's scores.
 */
const API_PORT = 8011;
const WEB_PORT = 5174;
const SCRATCH = ".e2e-scratch";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // one shared API instance; parallel uploads would race on state
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: [
        `rm -rf ${SCRATCH} && mkdir -p ${SCRATCH}`,
        // `scripts/py` rather than the venv binary directly — see the comment in that
        // script for why launching Python from Node needs a wrapper on some Macs.
        `./scripts/py -c "from app.db import Base, engine; import app.models; Base.metadata.create_all(engine)"`,
        `./scripts/py -m uvicorn app.main:app --port ${API_PORT} --log-level warning`,
      ].join(" && "),
      cwd: "../api",
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      env: {
        ENV: "dev",
        DATABASE_URL: `sqlite+pysqlite:///./${SCRATCH}/e2e.db`,
        STORAGE_BACKEND: "local",
        LOCAL_STORAGE_DIR: `./${SCRATCH}/files`,
        JOB_MODE: "inline",
        AUTH_DEV_MODE: "true",
        OMR_ENGINE: "fake",
        LOG_LEVEL: "WARNING",
        CORS_ORIGINS: `["http://localhost:${WEB_PORT}"]`,
      },
    },
    {
      command: `npx vite --port ${WEB_PORT}`,
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      env: { VITE_API_TARGET: `http://localhost:${API_PORT}` },
    },
  ],
});
