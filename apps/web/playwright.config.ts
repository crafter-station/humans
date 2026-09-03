import { defineConfig, devices } from "@playwright/test";

const previewURL = process.env.PLAYWRIGHT_PREVIEW_URL?.trim();
const productionURL = process.env.PLAYWRIGHT_PRODUCTION_URL?.trim();
const previewStorageState = "./playwright/.clerk/preview.json";
const sensitiveImpersonationRun = Boolean(
  process.env.E2E_PROFILE_OWNER_IMPERSONATION_URL?.trim(),
);
if (!previewURL || !productionURL) {
  throw new Error(
    "PLAYWRIGHT_PREVIEW_URL and PLAYWRIGHT_PRODUCTION_URL are required for browser acceptance",
  );
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: sensitiveImpersonationRun
    ? [["dot"]]
    : [["line"], ["html", { open: "never" }]],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /global\.setup\.ts/,
      teardown: "cleanup",
      use: {
        screenshot: "off",
        trace: "off",
        video: "off",
      },
    },
    {
      name: "cleanup",
      testMatch: /global\.teardown\.ts/,
    },
    {
      name: "preview-chromium",
      dependencies: ["setup"],
      testMatch: /v1-preview\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: previewURL,
        storageState: previewStorageState,
        screenshot: "off",
        trace: "off",
        video: "off",
      },
    },
    {
      name: "production-profile-control",
      testMatch: /profile-control\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: productionURL,
        screenshot: "off",
        trace: "off",
        video: "off",
      },
    },
  ],
});
