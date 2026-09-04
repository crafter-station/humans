import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupReleaseUser,
  parseReleaseUser,
  previewClerkInstanceId,
  type ReleaseUserCredentials,
  readReleaseUser,
  writeReleaseUser,
} from "./release-user";

const credentials: ReleaseUserCredentials = {
  publishableKey: "pk_test_unit-publishable",
  secretKey: "sk_test_unit-secret",
};
const rotatedCredentials: ReleaseUserCredentials = {
  publishableKey: "pk_test_rotated-publishable",
  secretKey: "sk_test_rotated-secret",
};
const release = "b".repeat(40);
const environment = { E2E_RELEASE_SHA: release };
const now = Date.UTC(2026, 8, 4, 12);
const runStartedAt = now - 60_000;
const runId = "690b5b64-f2a1-4ac7-88bd-d63b454f6802";
const email = `humans-release-${runStartedAt}-${runId}+clerk_test@example.com`;
const userId = "user_release_member";
const organizationId = "org_release_owned";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("release Member state", () => {
  it("rejects cleanup without an explicit Clerk instance binding", async () => {
    await expect(cleanupReleaseUser("sk_test_unbound")).rejects.toThrow(
      "requires Clerk instance-bound credentials",
    );
  });

  it("requires the immutable run-stamped Clerk test email", () => {
    expect(() =>
      writeReleaseUser(
        { email: "ordinary@example.com" },
        credentials,
        temporaryFile(),
        environment,
        now,
      ),
    ).toThrow("disposable Clerk test email");
  });

  it("writes exact instance and run state atomically without key fingerprints", () => {
    const file = temporaryFile();
    writeCompleteState(file);

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(
      readReleaseUser(rotatedCredentials, file, environment, now),
    ).toMatchObject({
      clerkInstanceId: previewClerkInstanceId,
      email,
      organizationId,
      release,
      runId,
      userId,
    });
    expect(readFileSync(file, "utf8")).not.toContain("Fingerprint");
  });

  it("rejects unexpected persisted fields and a different release run", () => {
    const file = temporaryFile();
    writeCompleteState(file);
    const state = JSON.parse(readFileSync(file, "utf8")) as unknown;

    expect(() =>
      parseReleaseUser({ ...(state as object), secret: "must-not-persist" }),
    ).toThrow("unexpected fields");
    expect(() =>
      readReleaseUser(
        credentials,
        file,
        { E2E_RELEASE_SHA: "c".repeat(40) },
        now,
      ),
    ).toThrow("different acceptance run");
  });

  it("expires stale creation state", () => {
    const staleStartedAt = now - 25 * 60 * 60 * 1000;
    const staleEmail = `humans-release-${staleStartedAt}-${runId}+clerk_test@example.com`;

    expect(() =>
      writeReleaseUser(
        { email: staleEmail },
        credentials,
        temporaryFile(),
        environment,
        now,
      ),
    ).toThrow("creation state has expired");
  });

  it("pins cleanup to the documented Preview instance before accepting missing resources", async () => {
    const file = temporaryFile();
    writeCompleteState(file);
    const clerk = fakeClerk({
      instanceId: "ins_another_development_instance",
      memberExists: false,
      organizationExists: false,
    });

    await expect(
      cleanupReleaseUser(credentials, cleanupOptions(file, clerk)),
    ).rejects.toThrow("instance verification failed");
    expect(clerk.paths()).toEqual(["/v1/instance"]);
    expect(clerk.deleteRequests()).toEqual([]);
  });

  it("refuses a stored Member ID that does not own the expected email", async () => {
    const clerk = fakeClerk({ memberEmail: "another+clerk_test@example.com" });

    await expectCleanupRefusal(clerk, "Member email validation failed");
  });

  it("refuses an Organization created by another Member", async () => {
    const clerk = fakeClerk({ creatorId: "user_another_member" });

    await expectCleanupRefusal(
      clerk,
      "ownership or membership validation failed",
    );
  });

  it("refuses an Organization with another Member", async () => {
    const clerk = fakeClerk({
      organizationMemberIds: [userId, "user_another_member"],
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

  it("refuses destructive cleanup from incomplete creation state", async () => {
    const file = temporaryFile();
    writeReleaseUser({ email }, credentials, file, environment, now);
    writeReleaseUser({ email, userId }, credentials, file, environment, now);
    const clerk = fakeClerk({ memberOrganizationIds: [] });

    await expect(
      cleanupReleaseUser(credentials, cleanupOptions(file, clerk)),
    ).rejects.toThrow("creation state is incomplete");
    expect(clerk.deleteRequests()).toEqual([]);
  });

  it("expires a pre-delete validation checkpoint", async () => {
    const file = temporaryFile();
    writeCompleteState(file);
    const clerk = fakeClerk({ failMemberDeletionOnce: true });

    await expect(
      cleanupReleaseUser(credentials, cleanupOptions(file, clerk)),
    ).rejects.toThrow("users cleanup failed");
    clerk.clearRequests();

    await expect(
      cleanupReleaseUser(credentials, {
        ...cleanupOptions(file, clerk),
        now: () => now + 5 * 60 * 1000 + 1,
      }),
    ).rejects.toThrow("validation has expired");
    expect(clerk.paths()).toEqual([]);
    expect(clerk.memberExists()).toBe(true);
  });

  it("resumes after key rotation when the replacement key has the same instance ID", async () => {
    const file = temporaryFile();
    writeCompleteState(file);
    const clerk = fakeClerk({ failMemberDeletionOnce: true });

    await expect(
      cleanupReleaseUser(credentials, cleanupOptions(file, clerk)),
    ).rejects.toThrow("users cleanup failed");
    await cleanupReleaseUser(rotatedCredentials, {
      ...cleanupOptions(file, clerk),
      now: () => now + 1_000,
    });

    expect(clerk.memberExists()).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("retains validation state until the Humans projection is inactive", async () => {
    const file = temporaryFile();
    writeCompleteState(file);
    const clerk = fakeClerk();
    const verifyProjection = projectionVerifier(
      new Error("Humans projection deletion could not be verified"),
    );

    await expect(
      cleanupReleaseUser(credentials, {
        ...cleanupOptions(file, clerk),
        verifyProjection,
      }),
    ).rejects.toThrow("projection deletion could not be verified");

    expect(clerk.memberExists()).toBe(false);
    expect(clerk.organizationExists()).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("polls the pinned Preview API until all webhook projections are inactive", async () => {
    const file = temporaryFile();
    writeCompleteState(file);
    const clerk = fakeClerk({
      projectionValues: [
        { member: "active", membership: "active", organization: "active" },
        { member: "absent", membership: "inactive", organization: "absent" },
      ],
    });

    await cleanupReleaseUser(credentials, {
      environment: {
        ...environment,
        HUMANS_ACCEPTANCE_API_URL:
          "https://humans-api-preview.hi-541.workers.dev/",
        HUMANS_PROXY_SECRET: "unit-proxy-secret",
      },
      fetcher: clerk.fetcher,
      file,
      now: () => now,
      sleep: async () => undefined,
    });

    expect(
      clerk.paths().filter((path) => path === "/v1/internal/clerk-projections"),
    ).toHaveLength(2);
    expect(existsSync(file)).toBe(false);
  });

  it("deletes only the validated disposable fixture and verifies Humans", async () => {
    const file = temporaryFile();
    writeCompleteState(file);
    const clerk = fakeClerk();
    const verifyProjection = projectionVerifier();

    await cleanupReleaseUser(credentials, {
      ...cleanupOptions(file, clerk),
      verifyProjection,
    });

    expect(clerk.deleteRequests()).toEqual([
      `/v1/organizations/${organizationId}`,
      `/v1/users/${userId}`,
    ]);
    expect(verifyProjection).toHaveBeenCalledWith({
      environment: "preview",
      memberId: userId,
      organizationId,
      release,
    });
    expect(existsSync(file)).toBe(false);
  });
});

const writeCompleteState = (file: string) => {
  writeReleaseUser({ email }, credentials, file, environment, now);
  writeReleaseUser({ email, userId }, credentials, file, environment, now);
  writeReleaseUser(
    { email, organizationId, userId },
    credentials,
    file,
    environment,
    now,
  );
};

const expectCleanupRefusal = async (
  clerk: ReturnType<typeof fakeClerk>,
  message: string,
) => {
  const file = temporaryFile();
  writeCompleteState(file);
  await expect(
    cleanupReleaseUser(credentials, cleanupOptions(file, clerk)),
  ).rejects.toThrow(message);
  expect(clerk.deleteRequests()).toEqual([]);
};

const cleanupOptions = (file: string, clerk: ReturnType<typeof fakeClerk>) => ({
  environment,
  fetcher: clerk.fetcher,
  file,
  now: () => now,
  verifyProjection: projectionVerifier(),
});

const temporaryFile = () => {
  const directory = mkdtempSync(join(tmpdir(), "humans-release-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "release-user.json");
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
    options.organizationMemberIds ?? [userId],
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
            "x-humans-environment": "preview",
            "x-humans-release": release,
          },
        );
      }

      if (url.pathname === "/v1/instance" && method === "GET") {
        return jsonResponse({
          environment_type: "development",
          id: options.instanceId ?? previewClerkInstanceId,
        });
      }
      if (url.pathname === "/v1/users" && method === "GET") {
        return jsonResponse(memberExists ? [{ id: userId }] : []);
      }
      if (url.pathname === `/v1/users/${userId}` && method === "GET") {
        return memberExists
          ? jsonResponse({
              created_at: options.memberCreatedAt ?? runStartedAt + 1_000,
              email_addresses: [
                {
                  email_address: options.memberEmail ?? email,
                  id: "idn_primary",
                },
              ],
              id: userId,
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
              created_by: options.creatorId ?? userId,
              id: organizationId,
            })
          : new Response(null, { status: 404 });
      }
      if (
        url.pathname === `/v1/users/${userId}/organization_memberships` &&
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
      if (url.pathname === `/v1/users/${userId}` && method === "DELETE") {
        if (memberDeletionFailures > 0) {
          memberDeletionFailures -= 1;
          return jsonResponse({ error: "temporary" }, 503);
        }
        memberExists = false;
        organizationMembers.delete(userId);
        return jsonResponse({ id: userId });
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
