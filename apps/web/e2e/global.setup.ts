import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  cleanupReleaseUser,
  previewStorageStateFile,
  removePreviewStorageState,
} from "./release-user";

setup.describe.configure({ mode: "serial" });

setup("configure Clerk browser acceptance", async ({ browser }) => {
  for (const name of [
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_SECRET_KEY",
    "E2E_PROFILE_QUERY",
    "PLAYWRIGHT_PREVIEW_URL",
    "PLAYWRIGHT_PRODUCTION_URL",
    "VERCEL_AUTOMATION_BYPASS_SECRET",
  ]) {
    if (!process.env[name]?.trim()) {
      throw new Error(`${name} is required for browser acceptance`);
    }
  }
  if (!process.env.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_")) {
    throw new Error(
      "Browser signup acceptance must use a Preview Clerk instance",
    );
  }

  await removePreviewStorageState();
  await cleanupReleaseUser(process.env.CLERK_SECRET_KEY as string);

  const bypassResponse = await fetch(
    process.env.PLAYWRIGHT_PREVIEW_URL as string,
    {
      redirect: "manual",
      headers: {
        "x-vercel-protection-bypass": process.env
          .VERCEL_AUTOMATION_BYPASS_SECRET as string,
        "x-vercel-set-bypass-cookie": "true",
      },
    },
  );
  if (bypassResponse.status !== 200 && bypassResponse.status !== 307) {
    throw new Error("Vercel Preview bypass could not be established");
  }
  const context = await browser.newContext();
  try {
    if (bypassResponse.status === 307) {
      const cookie = /^([^=;]+)=([^;]*)/.exec(
        bypassResponse.headers.get("set-cookie") ?? "",
      );
      if (cookie?.[1] !== "_vercel_jwt" || cookie[2] === undefined) {
        throw new Error("Vercel Preview bypass cookie was not returned");
      }
      await context.addCookies([
        {
          name: cookie[1],
          value: cookie[2],
          url: process.env.PLAYWRIGHT_PREVIEW_URL as string,
        },
      ]);
    }
    await mkdir(dirname(previewStorageStateFile), { recursive: true });
    await context.storageState({ path: previewStorageStateFile });
  } finally {
    await context.close();
  }

  await clerkSetup({ dotenv: false });
});
