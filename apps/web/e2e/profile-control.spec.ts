import { expect, type Page, test } from "@playwright/test";

import {
  authenticateImpersonatedMember,
  signOutAndVerify,
} from "./browser-auth";
import { prepareDeploymentContext, requiredHttpsUrl } from "./deployment";
import {
  assertFreshExpectedClaimFixture,
  readControlledProfile,
  readOrganizationCredits,
  restoreRecordedSearchability,
  searchForExpectedProfile,
} from "./profile-control-helpers";
import {
  profileControlContractFromEnvironment,
  profileControlQueryFromEnvironment,
  readProfileControlClaimReceipt,
  writeProfileControlClaimReceipt,
  writeProfileControlState,
} from "./profile-control-state";

test.afterEach(async ({ page }) => {
  const contract = profileControlContractFromEnvironment();
  try {
    await restoreRecordedSearchability(page, contract);
  } finally {
    if (!page.isClosed()) {
      await signOutAndVerify(page, new URL(contract.deploymentUrl));
    }
  }
});

test("a represented Member controls the exact Profile's Searchability", async ({
  browser,
  page,
}) => {
  const contract = profileControlContractFromEnvironment();
  const query = profileControlQueryFromEnvironment();
  const impersonationUrl = requiredHttpsUrl(
    "E2E_PROFILE_OWNER_IMPERSONATION_URL",
  );
  const cleanupImpersonationUrl = requiredHttpsUrl(
    "E2E_PROFILE_OWNER_CLEANUP_IMPERSONATION_URL",
  );
  const searcherImpersonationUrl = requiredHttpsUrl(
    "E2E_PROFILE_SEARCHER_IMPERSONATION_URL",
  );
  if (
    new Set([
      cleanupImpersonationUrl,
      impersonationUrl,
      searcherImpersonationUrl,
    ]).size !== 3
  ) {
    throw new Error(
      "Profile control requires separate one-use impersonation URLs",
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
    contract.organizationId,
  );

  // Restore an interrupted run before checking either accepted run state.
  await restoreRecordedSearchability(page, contract);

  const searcherContext = await browser.newContext();
  const searcherPage = await searcherContext.newPage();
  let searcherAuthenticated = false;
  try {
    await prepareDeploymentContext(searcherContext, "production");
    await authenticateImpersonatedMember(
      searcherPage,
      contract.deploymentUrl,
      searcherImpersonationUrl,
      contract.searcherMemberId,
      contract.searcherOrganizationId,
    );
    searcherAuthenticated = true;

    await page.goto(new URL("/workspace?view=profile", deployment.url).href);
    const controlled = await establishExpectedControl(page, contract);

    // This record precedes every assertion or mutation of Searchability.
    writeProfileControlState(
      contract,
      controlled.searchable,
      controlled.profileIdentityFingerprint,
    );
    if (contract.runPhase === "staged-claim") {
      writeProfileControlClaimReceipt(
        contract,
        controlled.profileIdentityFingerprint,
      );
    }
    if (controlled.searchable) {
      throw new Error("The accepted Profile must begin opted out of searches");
    }

    const creditsBeforeSearch = await readOrganizationCredits(searcherPage);
    if (creditsBeforeSearch === null || creditsBeforeSearch < 1) {
      throw new Error(
        "The searcher Organization has no Credit for verification",
      );
    }
    const idempotencyKey = crypto.randomUUID();
    await expect
      .poll(() =>
        searchForExpectedProfile(
          searcherPage,
          query,
          contract.profileId,
          idempotencyKey,
        ),
      )
      .toBe("absent");
    await expect
      .poll(() => readOrganizationCredits(searcherPage))
      .toBe(creditsBeforeSearch - 1);

    await page.getByRole("button", { name: "Appear in searches" }).click();
    await expect(
      page.getByText(
        "Your Profile now appears in authenticated Humans searches.",
      ),
    ).toBeVisible();
    await expect
      .poll(() => readExpectedSearchability(page, contract))
      .toBe("searchable");
    await expect
      .poll(() =>
        searchForExpectedProfile(
          searcherPage,
          query,
          contract.profileId,
          idempotencyKey,
        ),
      )
      .toBe("expected-only");

    await page
      .getByRole("button", { name: "Stop appearing in searches" })
      .click();
    await expect(
      page.getByText("Your Profile was removed from searches immediately."),
    ).toBeVisible();
    await expect
      .poll(() => readExpectedSearchability(page, contract))
      .toBe("not-searchable");
    await expect
      .poll(() =>
        searchForExpectedProfile(
          searcherPage,
          query,
          contract.profileId,
          idempotencyKey,
        ),
      )
      .toBe("absent");
    await expect
      .poll(() => readOrganizationCredits(searcherPage))
      .toBe(creditsBeforeSearch - 1);
  } finally {
    if (searcherAuthenticated && !searcherPage.isClosed()) {
      await signOutAndVerify(searcherPage, deployment.url);
    }
    await searcherContext.close();
  }
});

const establishExpectedControl = async (
  page: Page,
  contract: ReturnType<typeof profileControlContractFromEnvironment>,
) => {
  if (contract.runPhase === "post-promotion") {
    const receipt = readProfileControlClaimReceipt(contract);
    if (receipt === null) {
      throw new Error(
        "Post-promotion Profile control has no staged claim receipt",
      );
    }
    const controlled = await readControlledProfile(page, contract.profileId);
    if (
      controlled?.memberId !== contract.memberId ||
      controlled.profileIdentityFingerprint !==
        receipt.profileIdentityFingerprint
    ) {
      throw new Error("Post-promotion Profile control identity does not match");
    }
    return controlled;
  }

  if (readProfileControlClaimReceipt(contract) !== null) {
    throw new Error("Staged Profile claim fixture was already consumed");
  }
  await assertFreshExpectedClaimFixture(page, contract);
  const claimRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/profile/claims",
  );
  const claimResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/profile/claims",
  );
  const claim = page.getByRole("button", {
    name: "Verify and claim this Profile",
  });
  await expect(claim).toBeVisible();
  await claim.click();

  const request = await claimRequest;
  let exactRequest = false;
  try {
    const body = request.postDataJSON() as unknown;
    exactRequest =
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      "profileReference" in body &&
      body.profileReference === contract.profileId;
  } catch {
    exactRequest = false;
  }
  const response = await claimResponse;
  let verifiedResponse = false;
  try {
    const body = (await response.json()) as unknown;
    verifiedResponse =
      response.status() === 200 &&
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      "claim" in body &&
      typeof body.claim === "object" &&
      body.claim !== null &&
      !Array.isArray(body.claim) &&
      "status" in body.claim &&
      body.claim.status === "verified";
  } catch {
    verifiedResponse = false;
  }
  if (!exactRequest || !verifiedResponse) {
    throw new Error("The exact expected Profile was not verified and claimed");
  }
  await expect(
    page.getByText(
      "Your claim is verified. Review the Imported Profile before opting in.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /^Profile for / }),
  ).toBeVisible();

  const controlled = await readControlledProfile(page, contract.profileId);
  if (controlled?.memberId !== contract.memberId) {
    throw new Error("The expected Member did not control the claimed Profile");
  }
  return controlled;
};

const readExpectedSearchability = async (
  page: Page,
  contract: ReturnType<typeof profileControlContractFromEnvironment>,
) => {
  const state = readProfileControlClaimReceipt(contract);
  const profile = await readControlledProfile(page, contract.profileId);
  if (
    profile === null ||
    profile.memberId !== contract.memberId ||
    (state !== null &&
      profile.profileIdentityFingerprint !== state.profileIdentityFingerprint)
  ) {
    return "identity-mismatch" as const;
  }
  return profile.searchable
    ? ("searchable" as const)
    : ("not-searchable" as const);
};
