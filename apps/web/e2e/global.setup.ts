import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";
import { deploymentUrl, requiredEnvironment } from "./deployment";
import {
  cleanupReleaseUser,
  releaseUserCredentialsFromEnvironment,
  removeLegacyPreviewStorageState,
} from "./release-user";

setup.describe.configure({ mode: "serial" });

setup("configure Preview Clerk browser acceptance", async () => {
  for (const name of [
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "E2E_PROFILE_QUERY",
    "E2E_RELEASE_SHA",
    "PLAYWRIGHT_PREVIEW_URL",
    "VERCEL_AUTOMATION_BYPASS_SECRET",
  ]) {
    requiredEnvironment(name);
  }
  deploymentUrl("preview");
  const credentials = releaseUserCredentialsFromEnvironment();
  removeLegacyPreviewStorageState();
  await cleanupReleaseUser(credentials);

  await clerkSetup({ dotenv: false });
});
