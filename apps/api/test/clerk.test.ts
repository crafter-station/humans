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

describe("Clerk API keys", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses Clerk's supported page size when listing Organization API keys", async () => {
    const list = vi.fn(async () => ({ data: [] }));
    createClerkClient.mockReturnValue({ apiKeys: { list } });

    await clerkIdentityBoundary.listOrganizationApiKeys(
      "organization-a",
      bindings,
    );

    expect(list).toHaveBeenCalledWith({
      subject: "organization-a",
      includeInvalid: true,
      limit: 100,
    });
  });

  it("uses Clerk's supported page size before revoking an Organization API key", async () => {
    const apiKey = {
      id: "key-a",
      name: "Release verification",
      description: null,
      scopes: ["profiles:read"],
      revoked: true,
      expired: false,
      expiration: null,
      createdAt: 0,
    };
    const list = vi.fn(async () => ({ data: [apiKey] }));
    const revoke = vi.fn(async () => apiKey);
    createClerkClient.mockReturnValue({ apiKeys: { list, revoke } });

    await clerkIdentityBoundary.revokeOrganizationApiKey(
      "organization-a",
      "key-a",
      bindings,
    );

    expect(list).toHaveBeenCalledWith({
      subject: "organization-a",
      includeInvalid: true,
      limit: 100,
    });
    expect(revoke).toHaveBeenCalledWith({
      apiKeyId: "key-a",
      revocationReason: "Revoked by an Organization admin",
    });
  });
});
