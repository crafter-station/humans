import { test as teardown } from "@playwright/test";

import { prepareDeploymentContext, requiredHttpsUrl } from "./deployment";
import {
  authenticateImpersonatedMember,
  restoreRecordedSearchability,
} from "./profile-control-helpers";
import {
  profileControlContractFromEnvironment,
  readProfileControlState,
} from "./profile-control-state";

teardown(
  "restore the represented Profile's Searchability",
  async ({ browser }) => {
    const contract = profileControlContractFromEnvironment();
    if (readProfileControlState(contract) === null) return;

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await prepareDeploymentContext(context, "production");
      await authenticateImpersonatedMember(
        page,
        contract.deploymentUrl,
        requiredHttpsUrl("E2E_PROFILE_OWNER_CLEANUP_IMPERSONATION_URL"),
        contract.memberId,
      );
      await restoreRecordedSearchability(page, contract);
    } finally {
      await page.evaluate(() => window.Clerk?.signOut()).catch(() => undefined);
      await context.close();
    }
  },
);
