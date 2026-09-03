import { test as teardown } from "@playwright/test";

import { cleanupReleaseUser, removePreviewStorageState } from "./release-user";

teardown("delete the disposable Clerk identity", async () => {
  try {
    const secretKey = process.env.CLERK_SECRET_KEY?.trim();
    if (!secretKey) throw new Error("CLERK_SECRET_KEY is required for cleanup");
    await cleanupReleaseUser(secretKey);
  } finally {
    await removePreviewStorageState();
  }
});
