import { test as teardown } from "@playwright/test";

import {
  cleanupReleaseUser,
  releaseUserCredentialsFromEnvironment,
  removeLegacyPreviewStorageState,
} from "./release-user";

teardown("delete the disposable Member and Organizations", async () => {
  try {
    await cleanupReleaseUser(releaseUserCredentialsFromEnvironment());
  } finally {
    removeLegacyPreviewStorageState();
  }
});
