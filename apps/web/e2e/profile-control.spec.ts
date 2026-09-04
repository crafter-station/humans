import { expect, test } from "@playwright/test";

import {
  prepareDeploymentContext,
  requiredClerkId,
  requiredHttpsUrl,
} from "./deployment";
import {
  assertFreshExpectedClaimFixture,
  authenticateImpersonatedMember,
  readControlledProfile,
  restoreRecordedSearchability,
} from "./profile-control-helpers";
import {
  profileControlContractFromEnvironment,
  writeProfileControlState,
} from "./profile-control-state";

test.afterEach(async ({ page }) => {
  const contract = profileControlContractFromEnvironment();
  try {
    await restoreRecordedSearchability(page, contract);
  } finally {
    await page.evaluate(() => window.Clerk?.signOut()).catch(() => undefined);
  }
});

test("a represented Member claims the expected Profile and controls Searchability", async ({
  page,
}) => {
  const contract = profileControlContractFromEnvironment();
  if (
    requiredClerkId("E2E_PRODUCTION_MEMBER_ID", "user") === contract.memberId
  ) {
    throw new Error(
      "Production core and Profile-owner fixtures must be distinct Members",
    );
  }
  const impersonationUrl = requiredHttpsUrl(
    "E2E_PROFILE_OWNER_IMPERSONATION_URL",
  );
  const cleanupImpersonationUrl = requiredHttpsUrl(
    "E2E_PROFILE_OWNER_CLEANUP_IMPERSONATION_URL",
  );
  const coreImpersonationUrl = requiredHttpsUrl(
    "E2E_PRODUCTION_MEMBER_IMPERSONATION_URL",
  );
  if (
    new Set([cleanupImpersonationUrl, coreImpersonationUrl, impersonationUrl])
      .size !== 3
  ) {
    throw new Error(
      "Production browser acceptance requires separate impersonation URLs",
    );
  }
  const deployment = await prepareDeploymentContext(
    page.context(),
    "production",
  );
  if (deployment.url.href !== contract.deploymentUrl) {
    throw new Error("Profile control deployment identity changed");
  }
  await authenticateImpersonatedMember(
    page,
    contract.deploymentUrl,
    impersonationUrl,
    contract.memberId,
  );

  // A surviving record from an interrupted run is restored before freshness is checked.
  await restoreRecordedSearchability(page, contract);
  await page.goto(new URL("/workspace?view=profile", deployment.url).href);
  await assertFreshExpectedClaimFixture(page, contract);

  const claim = page.getByRole("button", {
    name: "Verify and claim this Profile",
  });
  await expect(claim).toBeVisible();
  await claim.click();
  await expect(
    page.getByText(
      "Your claim is verified. Review the Imported Profile before opting in.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /^Profile for / }),
  ).toBeVisible();

  const controlled = await readControlledProfile(page);
  if (controlled?.memberId !== contract.memberId) {
    throw new Error("The expected Member did not control the claimed Profile");
  }
  if (controlled.searchable) {
    throw new Error(
      "A freshly claimed Profile must begin opted out of searches",
    );
  }
  writeProfileControlState(contract, controlled.searchable);

  await page.getByRole("button", { name: "Appear in searches" }).click();
  await expect(
    page.getByText(
      "Your Profile now appears in authenticated Humans searches.",
    ),
  ).toBeVisible();
  await expect.poll(() => readSearchability(page)).toBe(true);

  await page
    .getByRole("button", { name: "Stop appearing in searches" })
    .click();
  await expect(
    page.getByText("Your Profile was removed from searches immediately."),
  ).toBeVisible();
  await expect.poll(() => readSearchability(page)).toBe(false);
});

const readSearchability = async (page: import("@playwright/test").Page) => {
  const profile = await readControlledProfile(page);
  if (profile === null)
    throw new Error("The controlled Profile is unavailable");
  return profile.searchable;
};
