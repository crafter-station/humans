import type { Page } from "@playwright/test";

import type { ProfileControlContract } from "./profile-control-state";
import {
  readProfileControlState,
  removeProfileControlState,
} from "./profile-control-state";

export type ControlledProfile = {
  memberId: string;
  searchable: boolean;
};

export const authenticateImpersonatedMember = async (
  page: Page,
  deploymentUrl: string,
  impersonationUrl: string,
  expectedMemberId: string,
) => {
  await page.goto(deploymentUrl);
  await page.evaluate((url) => window.location.assign(url), impersonationUrl);
  await page.waitForFunction(() => Boolean(window.Clerk?.user?.id));
  await page.goto(deploymentUrl);
  await page.waitForFunction(() => Boolean(window.Clerk?.user?.id));
  if (
    (await page.evaluate(() => window.Clerk?.user?.id)) !== expectedMemberId
  ) {
    throw new Error("The impersonation belongs to a different Member");
  }
};

export const readControlledProfile = async (
  page: Page,
): Promise<ControlledProfile | null> => {
  const response = await page.evaluate(async () => {
    const result = await fetch("/api/profile", { cache: "no-store" });
    return { body: (await result.json()) as unknown, status: result.status };
  });
  if (response.status !== 200 || !isRecord(response.body)) {
    throw new Error("The represented Profile could not be read");
  }
  if (response.body.profile === null) return null;
  if (
    !isRecord(response.body.profile) ||
    typeof response.body.profile.memberId !== "string" ||
    typeof response.body.profile.searchable !== "boolean"
  ) {
    throw new Error("The represented Profile response is invalid");
  }
  return {
    memberId: response.body.profile.memberId,
    searchable: response.body.profile.searchable,
  };
};

export const restoreRecordedSearchability = async (
  page: Page,
  contract: ProfileControlContract,
) => {
  const state = readProfileControlState(contract);
  if (state === null) return false;
  if (page.isClosed()) {
    throw new Error("Profile control rollback requires an authenticated page");
  }
  await page.goto(contract.deploymentUrl);
  await page.waitForFunction(() => Boolean(window.Clerk?.user?.id));
  if ((await page.evaluate(() => window.Clerk?.user?.id)) !== state.memberId) {
    throw new Error("Profile control rollback Member does not match");
  }
  const current = await readControlledProfile(page);
  if (current?.memberId !== state.memberId) {
    throw new Error("Profile control rollback target does not match");
  }
  if (current.searchable !== state.originalSearchability) {
    const status = await page.evaluate(async (searchable) => {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ searchable }),
      });
      return response.status;
    }, state.originalSearchability);
    if (status !== 200) {
      throw new Error("Profile Searchability restoration failed");
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const restored = await readControlledProfile(page);
    if (restored?.searchable === state.originalSearchability) {
      removeProfileControlState();
      return true;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Profile Searchability restoration could not be verified");
};

export const assertFreshExpectedClaimFixture = async (
  page: Page,
  contract: ProfileControlContract,
) => {
  if ((await readControlledProfile(page)) !== null) {
    throw new Error(
      "Profile claim certification requires a fresh Member without a Profile",
    );
  }
  const fixture = await page.evaluate(async ({ observationId, profileId }) => {
    const [candidateResponse, detailResponse] = await Promise.all([
      fetch("/api/profile/claim-candidates", { cache: "no-store" }),
      fetch(`/api/search/${encodeURIComponent(profileId)}`, {
        cache: "no-store",
      }),
    ]);
    return {
      candidateBody: (await candidateResponse.json()) as unknown,
      candidateStatus: candidateResponse.status,
      detailBody: (await detailResponse.json()) as unknown,
      detailStatus: detailResponse.status,
      observationId,
      profileId,
    };
  }, contract);
  if (
    fixture.candidateStatus !== 200 ||
    !isRecord(fixture.candidateBody) ||
    fixture.candidateBody.claim !== null ||
    !Array.isArray(fixture.candidateBody.candidates) ||
    fixture.candidateBody.candidates.length !== 1 ||
    !isRecord(fixture.candidateBody.candidates[0]) ||
    fixture.candidateBody.candidates[0].profileId !== contract.profileId
  ) {
    throw new Error(
      "Profile claim certification requires the expected fresh unclaimed Profile",
    );
  }
  if (
    fixture.detailStatus !== 200 ||
    !isRecord(fixture.detailBody) ||
    !isRecord(fixture.detailBody.profile) ||
    fixture.detailBody.profile.profileId !== contract.profileId ||
    !Array.isArray(fixture.detailBody.profile.contactDetails) ||
    !fixture.detailBody.profile.contactDetails.some(
      (detail) =>
        isRecord(detail) && detail.observationId === contract.observationId,
    )
  ) {
    throw new Error(
      "The expected Observation does not belong to the claim fixture",
    );
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
