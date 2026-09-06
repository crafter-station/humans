import { test as teardown } from "@playwright/test";

import {
  authenticateImpersonatedMember,
  signOutAndVerify,
} from "./browser-auth";
import { prepareDeploymentContext, requiredHttpsUrl } from "./deployment";
import { restoreRecordedSearchability } from "./profile-control-helpers";
import { profileControlContractFromEnvironment } from "./profile-control-state";

teardown(
  "restore the represented Profile's Searchability",
  async ({ browser }) => {
    const contract = profileControlContractFromEnvironment();
    const impersonationUrl = requiredHttpsUrl(
      "E2E_PROFILE_OWNER_IMPERSONATION_URL",
    );
    const cleanupImpersonationUrl = requiredHttpsUrl(
      "E2E_PROFILE_OWNER_CLEANUP_IMPERSONATION_URL",
    );
    if (impersonationUrl === cleanupImpersonationUrl) {
      throw new Error("Profile cleanup requires a distinct impersonation URL");
    }

    const context = await browser.newContext();
    const page = await context.newPage();
    let authenticated = false;
    try {
      await prepareDeploymentContext(context, "production");
      await authenticateImpersonatedMember(
        page,
        contract.deploymentUrl,
        cleanupImpersonationUrl,
        contract.memberId,
        contract.organizationId,
      );
      authenticated = true;
      await restoreRecordedSearchability(page, contract);
    } finally {
      if (authenticated && !page.isClosed()) {
        await signOutAndVerify(page, new URL(contract.deploymentUrl));
      }
      await context.close();
    }
  },
);
