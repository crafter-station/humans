import { defineConfig, devices } from "@playwright/test";

const previewURL = process.env.PLAYWRIGHT_PREVIEW_URL?.trim();
const productionURL = process.env.PLAYWRIGHT_PRODUCTION_URL?.trim();
const sensitiveAcceptanceRun = Boolean(
  process.env.E2E_PROFILE_OWNER_IMPERSONATION_URL?.trim() ||
    process.env.E2E_PROFILE_OWNER_CLEANUP_IMPERSONATION_URL?.trim() ||
    process.env.E2E_OPERATOR_IMPERSONATION_URL?.trim() ||
    process.env.E2E_PRODUCTION_MEMBER_IMPERSONATION_URL?.trim() ||
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim(),
);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: sensitiveAcceptanceRun
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
      use: {
        screenshot: "off",
        trace: "off",
        video: "off",
      },
    },
    {
      name: "preview-chromium",
      dependencies: ["setup"],
      testMatch: /workspace-journey\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: previewURL,
        screenshot: "off",
        trace: "off",
        video: "off",
      },
    },
    {
      name: "preview-operator",
      dependencies: ["preview-chromium"],
      testMatch: /operator-control\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: previewURL,
        screenshot: "off",
        trace: "off",
        video: "off",
      },
    },
    {
      name: "production-chromium",
      testMatch: /workspace-journey\.spec\.ts/,
      teardown: "production-member-cleanup",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: productionURL,
        screenshot: "off",
        trace: "off",
        video: "off",
      },
    },
    {
      name: "production-profile-control",
      dependencies: ["production-chromium"],
      testMatch: /profile-control\.spec\.ts/,
      teardown: "production-profile-cleanup",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: productionURL,
        screenshot: "off",
        trace: "off",
        video: "off",
      },
    },
    {
      name: "production-profile-cleanup",
      testMatch: /profile-control\.teardown\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: productionURL,
        screenshot: "off",
        trace: "off",
        video: "off",
      },
    },
    {
      name: "production-member-cleanup",
      testMatch: /production-member\.teardown\.ts/,
      use: {
        screenshot: "off",
        trace: "off",
        video: "off",
      },
    },
  ],
});
