import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bindings } from "../src/app";

const { createClerkClient } = vi.hoisted(() => ({
  createClerkClient: vi.fn(),
}));

vi.mock("@clerk/backend", () => ({ createClerkClient }));

import { clerkIdentityBoundary } from "../src/clerk";

const bindings = {
  CLERK_PUBLISHABLE_KEY: "pk_test_example",
  CLERK_SECRET_KEY: "sk_test_example",
  CLERK_WEBHOOK_SIGNING_SECRET: "whsec_example",
  DATABASE_URL: "postgresql://example",
} satisfies Bindings;

const apiKey = (id: string) => ({
  id,
  name: id,
  description: null,
  scopes: ["profiles:read"],
  revoked: false,
  expired: false,
  expiration: null,
  createdAt: 0,
});

describe("Clerk API keys", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists Organization API keys across every Clerk page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      apiKey(`key-${index}`),
    );
    const finalKey = apiKey("key-100");
    const list = vi.fn(async ({ offset = 0 }: { offset?: number }) => ({
      data: offset === 0 ? firstPage : [finalKey],
      totalCount: 101,
    }));
    createClerkClient.mockReturnValue({ apiKeys: { list } });

    const result = await clerkIdentityBoundary.listOrganizationApiKeys(
      "organization-a",
      bindings,
    );

    expect(result).toHaveLength(101);
    expect(result.at(-1)?.id).toBe("key-100");
    expect(list).toHaveBeenNthCalledWith(1, {
      subject: "organization-a",
      includeInvalid: true,
      limit: 100,
      offset: 0,
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      subject: "organization-a",
      includeInvalid: true,
      limit: 100,
      offset: 100,
    });
  });

  it("finds an Organization API key on a later Clerk page before revoking it", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      apiKey(`key-${index}`),
    );
    const targetKey = { ...apiKey("key-100"), revoked: true };
    const list = vi.fn(async ({ offset = 0 }: { offset?: number }) => ({
      data: offset === 0 ? firstPage : [targetKey],
      totalCount: 101,
    }));
    const revoke = vi.fn(async () => targetKey);
    createClerkClient.mockReturnValue({ apiKeys: { list, revoke } });

    const result = await clerkIdentityBoundary.revokeOrganizationApiKey(
      "organization-a",
      "key-100",
      bindings,
    );

    expect(result?.id).toBe("key-100");
    expect(list).toHaveBeenNthCalledWith(1, {
      subject: "organization-a",
      includeInvalid: true,
      limit: 100,
      offset: 0,
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      subject: "organization-a",
      includeInvalid: true,
      limit: 100,
      offset: 100,
    });
    expect(revoke).toHaveBeenCalledWith({
      apiKeyId: "key-100",
      revocationReason: "Revoked by an Organization admin",
    });
  });

  it("revokes active Organization API keys across every Clerk page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      apiKey(`key-${index}`),
    );
    const finalKey = apiKey("key-100");
    const list = vi.fn(async ({ offset = 0 }: { offset?: number }) => ({
      data: offset === 0 ? firstPage : [finalKey],
      totalCount: 101,
    }));
    const revoke = vi.fn(async ({ apiKeyId }: { apiKeyId: string }) => {
      expect(list).toHaveBeenCalledTimes(2);
      return apiKey(apiKeyId);
    });
    createClerkClient.mockReturnValue({ apiKeys: { list, revoke } });

    await clerkIdentityBoundary.revokeAllOrganizationApiKeys?.(
      "organization-a",
      bindings,
    );

    expect(list).toHaveBeenNthCalledWith(1, {
      subject: "organization-a",
      includeInvalid: false,
      limit: 100,
      offset: 0,
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      subject: "organization-a",
      includeInvalid: false,
      limit: 100,
      offset: 100,
    });
    expect(revoke).toHaveBeenCalledTimes(101);
    expect(revoke).toHaveBeenCalledWith({
      apiKeyId: "key-100",
      revocationReason: "Revoked by a Humans Operator",
    });
  });
});

describe("Clerk sessions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("revokes Member sessions across every Clerk page", async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      id: `session-${index}`,
    }));
    const finalSession = { id: "session-500" };
    const getSessionList = vi.fn(
      async ({ offset = 0 }: { offset?: number }) => ({
        data: offset === 0 ? firstPage : [finalSession],
        totalCount: 501,
      }),
    );
    const revokeSession = vi.fn(async (id: string) => {
      expect(getSessionList).toHaveBeenCalledTimes(2);
      return { id };
    });
    createClerkClient.mockReturnValue({
      sessions: { getSessionList, revokeSession },
    });

    await clerkIdentityBoundary.revokeMemberSessions?.("member-a", bindings);

    expect(getSessionList).toHaveBeenNthCalledWith(1, {
      userId: "member-a",
      limit: 500,
      offset: 0,
    });
    expect(getSessionList).toHaveBeenNthCalledWith(2, {
      userId: "member-a",
      limit: 500,
      offset: 500,
    });
    expect(revokeSession).toHaveBeenCalledTimes(501);
    expect(revokeSession).toHaveBeenCalledWith("session-500");
  });
});
