import type { Page } from "@playwright/test";

import type { ProfileControlContract } from "./profile-control-state";
import {
  profileIdentityFingerprint,
  readProfileControlState,
  removeProfileControlState,
} from "./profile-control-state";

export type ControlledProfile = {
  memberId: string;
  profileIdentityFingerprint: string;
  searchable: boolean;
};

export type ExpectedProfileSearch =
  | "absent"
  | "expected-only"
  | "invalid-response"
  | "request-failed"
  | "unexpected-results";

export const readControlledProfile = async (
  page: Page,
  expectedProfileId: string,
): Promise<ControlledProfile | null> => {
  const response = await page.evaluate(async () => {
    try {
      const result = await fetch("/api/profile", { cache: "no-store" });
      const body = (await result.json()) as unknown;
      if (
        result.status !== 200 ||
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        !("profile" in body)
      ) {
        return { kind: "invalid" as const };
      }
      if (body.profile === null) return { kind: "missing" as const };
      const profile = body.profile;
      if (
        typeof profile !== "object" ||
        profile === null ||
        Array.isArray(profile) ||
        !("memberId" in profile) ||
        typeof profile.memberId !== "string" ||
        !("githubAccountId" in profile) ||
        typeof profile.githubAccountId !== "string" ||
        !("searchable" in profile) ||
        typeof profile.searchable !== "boolean"
      ) {
        return { kind: "invalid" as const };
      }
      return {
        githubAccountId: profile.githubAccountId,
        kind: "profile" as const,
        memberId: profile.memberId,
        searchable: profile.searchable,
      };
    } catch {
      return { kind: "invalid" as const };
    }
  });
  if (response.kind === "missing") return null;
  if (response.kind !== "profile") {
    throw new Error("The represented Profile response is invalid");
  }
  return {
    memberId: response.memberId,
    profileIdentityFingerprint: profileIdentityFingerprint(
      expectedProfileId,
      response.githubAccountId,
    ),
    searchable: response.searchable,
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
  const current = await readControlledProfile(page, state.profileId);
  if (
    current?.memberId !== state.memberId ||
    current.profileIdentityFingerprint !== state.profileIdentityFingerprint
  ) {
    throw new Error("Profile control rollback target does not match");
  }
  if (current.searchable !== state.originalSearchability) {
    const status = await page.evaluate(async (searchable) => {
      try {
        const response = await fetch("/api/profile", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ searchable }),
        });
        return response.status;
      } catch {
        return 0;
      }
    }, state.originalSearchability);
    if (status !== 200) {
      throw new Error("Profile Searchability restoration failed");
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const restored = await readControlledProfile(page, state.profileId);
    if (
      restored?.memberId === state.memberId &&
      restored.profileIdentityFingerprint ===
        state.profileIdentityFingerprint &&
      restored.searchable === state.originalSearchability
    ) {
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
  if ((await readControlledProfile(page, contract.profileId)) !== null) {
    throw new Error(
      "Profile claim certification requires a fresh Member without a Profile",
    );
  }
  const outcome = await page.evaluate(
    async ({ observationId, profileId }) => {
      try {
        const [candidateResponse, detailResponse] = await Promise.all([
          fetch("/api/profile/claim-candidates", { cache: "no-store" }),
          fetch(`/api/search/${encodeURIComponent(profileId)}`, {
            cache: "no-store",
          }),
        ]);
        const candidateBody = (await candidateResponse.json()) as {
          candidates?: unknown[];
          claim?: unknown;
        };
        const detailBody = (await detailResponse.json()) as {
          profile?: { contactDetails?: unknown[]; profileId?: unknown };
        };
        const candidate = candidateBody.candidates?.[0] as
          | { profileId?: unknown }
          | undefined;
        const expectedCandidate =
          candidateResponse.status === 200 &&
          candidateBody.claim === null &&
          candidateBody.candidates?.length === 1 &&
          candidate?.profileId === profileId;
        const expectedDetail =
          detailResponse.status === 200 &&
          detailBody.profile?.profileId === profileId &&
          Array.isArray(detailBody.profile.contactDetails) &&
          detailBody.profile.contactDetails.some(
            (detail) =>
              typeof detail === "object" &&
              detail !== null &&
              !Array.isArray(detail) &&
              "observationId" in detail &&
              detail.observationId === observationId,
          );
        return expectedCandidate && expectedDetail ? "ready" : "invalid";
      } catch {
        return "invalid";
      }
    },
    { observationId: contract.observationId, profileId: contract.profileId },
  );
  if (outcome !== "ready") {
    throw new Error(
      "Profile claim certification requires the expected fresh fixture",
    );
  }
};

export const searchForExpectedProfile = (
  page: Page,
  query: string,
  expectedProfileId: string,
  idempotencyKey: string,
): Promise<ExpectedProfileSearch> =>
  page.evaluate(
    async ({ expectedProfileId, idempotencyKey, query }) => {
      try {
        const parameters = new URLSearchParams({ q: query });
        const response = await fetch(`/api/search?${parameters}`, {
          cache: "no-store",
          headers: { "Idempotency-Key": idempotencyKey },
        });
        if (response.status !== 200) return "request-failed";
        const body = (await response.json()) as unknown;
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          !("results" in body) ||
          !Array.isArray(body.results) ||
          body.results.some(
            (result) =>
              typeof result !== "object" ||
              result === null ||
              Array.isArray(result) ||
              !("profileId" in result) ||
              typeof result.profileId !== "string",
          )
        ) {
          return "invalid-response";
        }
        if (body.results.length === 0) return "absent";
        if (
          body.results.length === 1 &&
          body.results[0]?.profileId === expectedProfileId
        ) {
          return "expected-only";
        }
        return "unexpected-results";
      } catch {
        return "request-failed";
      }
    },
    { expectedProfileId, idempotencyKey, query },
  );

export const readOrganizationCredits = (page: Page): Promise<number | null> =>
  page.evaluate(async () => {
    try {
      const response = await fetch("/api/billing", { cache: "no-store" });
      const body = (await response.json()) as unknown;
      if (
        response.status !== 200 ||
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        !("availableCredits" in body) ||
        !Number.isSafeInteger(body.availableCredits)
      ) {
        return null;
      }
      return body.availableCredits as number;
    } catch {
      return null;
    }
  });
