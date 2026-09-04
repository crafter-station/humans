import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupProductionMember,
  productionClerkInstanceId,
  productionMemberCleanupConfirmation,
  productionMemberCleanupInputFromEnvironment,
} from "./production-member-cleanup";

const memberId = "user_production_core";
const organizationId = "org_production_core";
const profileOwnerMemberId = "user_profile_owner";
const release = "a".repeat(40);
const runId = "32ef4a5e-4f3d-4fd8-a223-356506cfd5ad";
const now = Date.UTC(2026, 8, 4, 12);
const runStartedAt = now - 60_000;
const email = `humans-release-${runStartedAt}-${runId}@release.crafter.run`;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Production Member cleanup", () => {
  it("pins the key to the documented Production Clerk instance before accepting 404", async () => {
    const stateFile = temporaryFile();
    const clerk = fakeClerk({
      instanceId: "ins_another_live_instance",
      memberExists: false,
      organizationExists: false,
    });

    await expect(
      cleanupProductionMember(validInput(), {
        fetcher: clerk.fetcher,
        now: () => now,
        stateFile,
        verifyProjection: projectionVerifier(),
      }),
    ).rejects.toThrow("Clerk instance verification failed");
    expect(clerk.paths()).toEqual(["/v1/instance"]);
    expect(clerk.deleteRequests()).toEqual([]);
  });

  it("does not expose Clerk credentials or fixture identities in transport errors", async () => {
    const input = validInput();
    const fetcher = vi.fn(async () => {
      throw new Error(
        `${input.secretKey}:${memberId}:${organizationId}:${email}`,
      );
    }) as unknown as typeof fetch;

    const error = await cleanupProductionMember(input, {
      fetcher,
      now: () => now,
      stateFile: temporaryFile(),
      verifyProjection: projectionVerifier(),
    }).catch((caught: unknown) => caught);

    expect(error).toEqual(new Error("Clerk instance verification failed"));
    for (const sensitive of [
      input.secretKey,
      memberId,
      organizationId,
      email,
    ]) {
      expect(String(error)).not.toContain(sensitive);
    }
  });

  it("requires a fresh run-stamped disposable email", () => {
    expect(() =>
      productionMemberCleanupInputFromEnvironment(
        {
          ...validEnvironment(),
          E2E_PRODUCTION_MEMBER_EMAIL: "member@release.crafter.run",
        },
        now,
      ),
    ).toThrow("run-bound disposable email");
    expect(() =>
      productionMemberCleanupInputFromEnvironment(
        validEnvironment(now - 25 * 60 * 60 * 1000),
        now,
      ),
    ).toThrow("creation state has expired");
  });

  it("binds confirmation to the complete immutable fixture", () => {
    expect(() =>
      productionMemberCleanupInputFromEnvironment(
        {
          ...validEnvironment(),
          E2E_PRODUCTION_CLEANUP_CONFIRMATION: "production-cleanup:wrong",
        },
        now,
      ),
    ).toThrow("cleanup confirmation is invalid");
  });

  it("refuses a Member whose stored ID does not own the expected email", async () => {
    const clerk = fakeClerk({ memberEmail: "another@release.crafter.run" });

    await expectCleanupRefusal(clerk, "Member email validation failed");
  });

  it("refuses stale Clerk resources that predate the run", async () => {
    const clerk = fakeClerk({ memberCreatedAt: runStartedAt - 120_000 });

    await expectCleanupRefusal(clerk, "creation state validation failed");
  });

  it("refuses an Organization created by another Member", async () => {
    const clerk = fakeClerk({ creatorId: "user_another_member" });

    await expectCleanupRefusal(
      clerk,
      "ownership or membership validation failed",
    );
  });

  it("refuses an Organization with any other Member", async () => {
    const clerk = fakeClerk({
      organizationMemberIds: [memberId, "user_another_member"],
    });

    await expectCleanupRefusal(
      clerk,
      "ownership or membership validation failed",
    );
  });

  it("refuses a Member with another Organization membership", async () => {
    const clerk = fakeClerk({
      memberOrganizationIds: [organizationId, "org_unrelated"],
    });

    await expectCleanupRefusal(
      clerk,
      "ownership or membership validation failed",
    );
  });

  it("refuses an unvalidated partial deletion", async () => {
    const clerk = fakeClerk({ organizationExists: false });

    await expectCleanupRefusal(clerk, "already partially deleted");
  });

  it("expires the validation checkpoint before it can authorize a resumed deletion", async () => {
    const stateFile = temporaryFile();
    const clerk = fakeClerk({ failMemberDeletionOnce: true });

    await expect(
      cleanupProductionMember(validInput(), {
        fetcher: clerk.fetcher,
        now: () => now,
        stateFile,
        verifyProjection: projectionVerifier(),
      }),
    ).rejects.toThrow("users cleanup failed");
    clerk.clearRequests();

    await expect(
      cleanupProductionMember(validInput(), {
        fetcher: clerk.fetcher,
        now: () => now + 5 * 60 * 1000 + 1,
        stateFile,
        verifyProjection: projectionVerifier(),
      }),
    ).rejects.toThrow("validation has expired");
    expect(clerk.paths()).toEqual([]);
    expect(clerk.memberExists()).toBe(true);
  });

  it("resumes with a rotated key from the same exact Clerk instance", async () => {
    const stateFile = temporaryFile();
    const clerk = fakeClerk({ failMemberDeletionOnce: true });

    await expect(
      cleanupProductionMember(validInput("sk_live_first_key"), {
        fetcher: clerk.fetcher,
        now: () => now,
        stateFile,
        verifyProjection: projectionVerifier(),
      }),
    ).rejects.toThrow("users cleanup failed");

    await cleanupProductionMember(validInput("sk_live_rotated_key"), {
      fetcher: clerk.fetcher,
      now: () => now + 1_000,
      stateFile,
      verifyProjection: projectionVerifier(),
    });

    expect(clerk.memberExists()).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });

  it("retains private validation state until Humans projections are inactive", async () => {
    const stateFile = temporaryFile();
    const clerk = fakeClerk();
    const verifyProjection = projectionVerifier(
      new Error("Humans projection deletion could not be verified"),
    );

    await expect(
      cleanupProductionMember(validInput(), {
        fetcher: clerk.fetcher,
        now: () => now,
        stateFile,
        verifyProjection,
      }),
    ).rejects.toThrow("projection deletion could not be verified");

    expect(clerk.memberExists()).toBe(false);
    expect(clerk.organizationExists()).toBe(false);
    expect(existsSync(stateFile)).toBe(true);
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
  });

  it("polls the pinned deployment API until every local projection is inactive", async () => {
    const stateFile = temporaryFile();
    const clerk = fakeClerk({
      projectionValues: [
        { member: "active", membership: "active", organization: "active" },
        {
          member: "inactive",
          membership: "absent",
          organization: "inactive",
        },
      ],
    });

    await cleanupProductionMember(validInput(), {
      environment: {
        HUMANS_ACCEPTANCE_API_URL:
          "https://humans-api-production.hi-541.workers.dev/",
        HUMANS_PROXY_SECRET: "unit-proxy-secret",
      },
      fetcher: clerk.fetcher,
      now: () => now,
      sleep: async () => undefined,
      stateFile,
    });

    expect(
      clerk.paths().filter((path) => path === "/v1/internal/clerk-projections"),
    ).toHaveLength(2);
    expect(existsSync(stateFile)).toBe(false);
  });

  it("deletes only the validated Organization and Member, then verifies Humans", async () => {
    const stateFile = temporaryFile();
    const clerk = fakeClerk();
    const verifyProjection = projectionVerifier();

    await cleanupProductionMember(validInput(), {
      fetcher: clerk.fetcher,
      now: () => now,
      stateFile,
      verifyProjection,
    });

    expect(clerk.deleteRequests()).toEqual([
      `/v1/organizations/${organizationId}`,
      `/v1/users/${memberId}`,
    ]);
    expect(verifyProjection).toHaveBeenCalledWith({
      environment: "production",
      memberId,
      organizationId,
      release,
    });
    expect(existsSync(stateFile)).toBe(false);
  });
});

const expectCleanupRefusal = async (
  clerk: ReturnType<typeof fakeClerk>,
  message: string,
) => {
  await expect(
    cleanupProductionMember(validInput(), {
      fetcher: clerk.fetcher,
      now: () => now,
      stateFile: temporaryFile(),
      verifyProjection: projectionVerifier(),
    }),
  ).rejects.toThrow(message);
  expect(clerk.deleteRequests()).toEqual([]);
};

const validEnvironment = (
  startedAt = runStartedAt,
  key = "sk_live_unit_secret",
) => {
  const target = {
    clerkInstanceId: productionClerkInstanceId,
    email: `humans-release-${startedAt}-${runId}@release.crafter.run`,
    memberId,
    organizationId,
    profileOwnerMemberId,
    release,
    runId,
    runStartedAt: new Date(startedAt).toISOString(),
  };
  return {
    CLERK_SECRET_KEY: key,
    E2E_PRODUCTION_CLEANUP_CONFIRMATION:
      productionMemberCleanupConfirmation(target),
    E2E_PRODUCTION_MEMBER_EMAIL: target.email,
    E2E_PRODUCTION_MEMBER_ID: memberId,
    E2E_PRODUCTION_ORGANIZATION_ID: organizationId,
    E2E_PRODUCTION_RUN_ID: runId,
    E2E_PROFILE_OWNER_MEMBER_ID: profileOwnerMemberId,
    E2E_RELEASE_SHA: release,
  };
};

const validInput = (key = "sk_live_unit_secret") =>
  productionMemberCleanupInputFromEnvironment(
    validEnvironment(runStartedAt, key),
    now,
  );

const temporaryFile = () => {
  const directory = mkdtempSync(join(tmpdir(), "humans-production-cleanup-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.json");
};

const projectionVerifier = (failure?: Error) =>
  vi.fn(async () => {
    if (failure !== undefined) throw failure;
  });

const fakeClerk = (
  options: {
    creatorId?: string;
    failMemberDeletionOnce?: boolean;
    instanceId?: string;
    memberCreatedAt?: number;
    memberEmail?: string;
    memberExists?: boolean;
    memberOrganizationIds?: string[];
    organizationCreatedAt?: number;
    organizationExists?: boolean;
    organizationMemberIds?: string[];
    projectionValues?: unknown[];
  } = {},
) => {
  let memberExists = options.memberExists ?? true;
  let organizationExists = options.organizationExists ?? true;
  let memberDeletionFailures = options.failMemberDeletionOnce ? 1 : 0;
  const requests: Array<{ method: string; path: string }> = [];
  const memberOrganizations = new Set(
    options.memberOrganizationIds ?? [organizationId],
  );
  const organizationMembers = new Set(
    options.organizationMemberIds ?? [memberId],
  );
  const projectionValues = [...(options.projectionValues ?? [])];
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      const method = init?.method ?? "GET";
      requests.push({ method, path: url.pathname });

      if (
        url.pathname === "/v1/internal/clerk-projections" &&
        method === "POST"
      ) {
        return jsonResponse(
          projectionValues.shift() ?? {
            member: "inactive",
            membership: "inactive",
            organization: "inactive",
          },
          200,
          {
            "x-humans-environment": "production",
            "x-humans-release": release,
          },
        );
      }

      if (url.pathname === "/v1/instance" && method === "GET") {
        return jsonResponse({
          environment_type: "production",
          id: options.instanceId ?? productionClerkInstanceId,
        });
      }
      if (url.pathname === "/v1/users" && method === "GET") {
        return jsonResponse(memberExists ? [{ id: memberId }] : []);
      }
      if (url.pathname === `/v1/users/${memberId}` && method === "GET") {
        return memberExists
          ? jsonResponse({
              created_at: options.memberCreatedAt ?? runStartedAt + 1_000,
              email_addresses: [
                {
                  email_address: options.memberEmail ?? email,
                  id: "idn_primary",
                },
              ],
              id: memberId,
              primary_email_address_id: "idn_primary",
            })
          : new Response(null, { status: 404 });
      }
      if (
        url.pathname === `/v1/organizations/${organizationId}` &&
        method === "GET"
      ) {
        return organizationExists
          ? jsonResponse({
              created_at: options.organizationCreatedAt ?? runStartedAt + 2_000,
              created_by: options.creatorId ?? memberId,
              id: organizationId,
            })
          : new Response(null, { status: 404 });
      }
      if (
        url.pathname === `/v1/users/${memberId}/organization_memberships` &&
        method === "GET"
      ) {
        if (!memberExists) return new Response(null, { status: 404 });
        return membershipPage(
          [...memberOrganizations].map((id) => ({ organization: { id } })),
        );
      }
      if (
        url.pathname === `/v1/organizations/${organizationId}/memberships` &&
        method === "GET"
      ) {
        if (!organizationExists) return new Response(null, { status: 404 });
        return membershipPage(
          [...organizationMembers].map((id, index) => ({
            id: `orgmem_${index}_unit`,
            organization: { id: organizationId },
            public_user_data: { user_id: id },
          })),
        );
      }
      if (
        url.pathname === `/v1/organizations/${organizationId}` &&
        method === "DELETE"
      ) {
        organizationExists = false;
        memberOrganizations.delete(organizationId);
        return jsonResponse({ id: organizationId });
      }
      if (url.pathname === `/v1/users/${memberId}` && method === "DELETE") {
        if (memberDeletionFailures > 0) {
          memberDeletionFailures -= 1;
          return jsonResponse({ error: "temporary" }, 503);
        }
        memberExists = false;
        organizationMembers.delete(memberId);
        return jsonResponse({ id: memberId });
      }
      throw new Error("Unexpected mocked Clerk request");
    },
  );
  return {
    clearRequests: () => requests.splice(0),
    deleteRequests: () =>
      requests
        .filter(({ method }) => method === "DELETE")
        .map(({ path }) => path),
    fetcher: fetchMock as unknown as typeof fetch,
    memberExists: () => memberExists,
    organizationExists: () => organizationExists,
    paths: () => requests.map(({ path }) => path),
  };
};

const membershipPage = (data: unknown[]) =>
  jsonResponse({ data: data.slice(0, 2), total_count: data.length });

const jsonResponse = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
