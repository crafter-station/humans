import { test as teardown } from "@playwright/test";

import {
  cleanupProductionMember,
  productionMemberCleanupInputFromEnvironment,
} from "./production-member-cleanup";

teardown(
  "delete the disposable Production Member and Organization",
  async () => {
    await cleanupProductionMember(
      productionMemberCleanupInputFromEnvironment(),
    );
  },
);
