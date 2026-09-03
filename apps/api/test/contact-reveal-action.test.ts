import { describe, expect, it, vi } from "vitest";

import { createContactRevealAction } from "../src/contact-reveal-action";
import type { ApiKeyIdentity } from "../src/clerk";

describe("ContactRevealAction", () => {
  it("orchestrates an API-key Contact Reveal behind one interface", async () => {
    const events: string[] = [];
    const actor: ApiKeyIdentity = {
      keyId: "key-a",
      memberId: "member-a",
      organizationId: "organization-a",
      scopes: ["profiles:read", "contacts:reveal"],
    };
    const purchase = vi.fn(async () => {
      events.push("purchase");
      return {
        observationId: "observation-a",
        type: "professional-email" as const,
        value: "person@example.com",
        price: 5 as const,
        previouslyPurchased: false,
      };
    });
    const action = createContactRevealAction({
      authenticateSession: vi.fn(async () => null),
      authenticateApiKey: vi.fn(async () => {
        events.push("authenticate");
        return actor;
      }),
      requireWorkspace: vi.fn(async () => {
        events.push("access");
      }),
      enforcePrincipalRateLimits: vi.fn(async () => {
        events.push("limits");
        return null;
      }),
      recordActivity: vi.fn(async (_actor, kind, source) => {
        events.push(`audit:${kind}:${source}`);
      }),
      purchase,
      log: vi.fn(() => events.push("log")),
    });

    const result = await action.execute({
      authentication: { kind: "api-key", request: new Request("https://api") },
      environment: {},
      profileId: "profile-a",
      type: "professional-email",
      observation: { valid: true, observationId: "observation-a" },
      idempotencyKey: "reveal-a",
      source: "api",
      correlationId: "correlation-a",
    });

    expect(result).toEqual({
      ok: true,
      reveal: {
        observationId: "observation-a",
        type: "professional-email",
        value: "person@example.com",
        price: 5,
        previouslyPurchased: false,
      },
    });
    expect(events).toEqual([
      "authenticate",
      "access",
      "limits",
      "audit:organization_access:api",
      "audit:reveal:api",
      "purchase",
      "log",
    ]);
    expect(purchase).toHaveBeenCalledWith({
      memberId: "member-a",
      organizationId: "organization-a",
      profileId: "profile-a",
      type: "professional-email",
      observationId: "observation-a",
      idempotencyKey: "reveal-a",
      apiKeyId: "key-a",
      source: "api",
      correlationId: "correlation-a",
    });
  });

  it("applies access controls before rejecting malformed input", async () => {
    const events: string[] = [];
    const purchase = vi.fn();
    const action = createContactRevealAction({
      authenticateSession: vi.fn(async () => null),
      authenticateApiKey: vi.fn(async () => {
        events.push("authenticate");
        return {
          keyId: "key-a",
          memberId: "member-a",
          organizationId: "organization-a",
          scopes: ["profiles:read", "contacts:reveal"],
        } satisfies ApiKeyIdentity;
      }),
      requireWorkspace: vi.fn(async () => {
        events.push("access");
      }),
      enforcePrincipalRateLimits: vi.fn(async () => {
        events.push("limits");
        return null;
      }),
      recordActivity: vi.fn(async (_actor, kind, source) => {
        events.push(`audit:${kind}:${source}`);
      }),
      purchase,
    });

    const result = await action.execute({
      authentication: { kind: "api-key", request: new Request("https://api") },
      environment: {},
      profileId: "profile-a",
      type: "professional-email",
      observation: { valid: false },
      idempotencyKey: "reveal-a",
      source: "api",
      correlationId: "correlation-a",
    });

    expect(result).toEqual({
      ok: false,
      status: 422,
      error: {
        code: "invalid_reveal",
        message: "Request validation failed",
      },
    });
    expect(events).toEqual([
      "authenticate",
      "access",
      "limits",
      "audit:organization_access:api",
      "audit:reveal:api",
    ]);
    expect(purchase).not.toHaveBeenCalled();
  });

  it("uses a pre-authenticated MCP actor and preserves MCP audit attribution", async () => {
    const authenticateApiKey = vi.fn(async () => null);
    const recordActivity = vi.fn(async () => undefined);
    const actor: ApiKeyIdentity = {
      keyId: "key-a",
      memberId: "member-a",
      organizationId: "organization-a",
      scopes: ["profiles:read", "contacts:reveal"],
    };
    const action = createContactRevealAction({
      authenticateSession: vi.fn(async () => null),
      authenticateApiKey,
      requireWorkspace: vi.fn(async () => undefined),
      enforcePrincipalRateLimits: vi.fn(async () => null),
      recordActivity,
      purchase: vi.fn(async () => ({
        observationId: "observation-a",
        type: "professional-email" as const,
        value: "person@example.com",
        price: 0,
        previouslyPurchased: true,
      })),
    });

    await action.execute({
      authentication: {
        kind: "api-key",
        request: new Request("https://api/mcp"),
        actor,
      },
      environment: {},
      profileId: "profile-a",
      type: "professional-email",
      observation: { valid: true },
      idempotencyKey: "reveal-a",
      source: "mcp",
      correlationId: "correlation-a",
    });

    expect(authenticateApiKey).not.toHaveBeenCalled();
    expect(recordActivity).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ keyId: "key-a" }),
      "organization_access",
      "mcp",
    );
    expect(recordActivity).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ keyId: "key-a" }),
      "reveal",
      "mcp",
      { profileId: "profile-a" },
    );
  });

  it("rejects an API key without Contact Reveal scope before access", async () => {
    const requireWorkspace = vi.fn(async () => undefined);
    const action = createContactRevealAction({
      authenticateSession: vi.fn(async () => null),
      authenticateApiKey: vi.fn(
        async () =>
          ({
            keyId: "key-a",
            memberId: "member-a",
            organizationId: "organization-a",
            scopes: ["profiles:read"],
          }) satisfies ApiKeyIdentity,
      ),
      requireWorkspace,
      enforcePrincipalRateLimits: vi.fn(async () => null),
      recordActivity: vi.fn(async () => undefined),
      purchase: vi.fn(),
    });

    const result = await action.execute({
      authentication: { kind: "api-key", request: new Request("https://api") },
      environment: {},
      profileId: "profile-a",
      type: "professional-email",
      observation: { valid: true },
      idempotencyKey: "reveal-a",
      source: "api",
      correlationId: "correlation-a",
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: {
        code: "forbidden",
        message: "API key requires profiles:read and contacts:reveal",
      },
    });
    expect(requireWorkspace).not.toHaveBeenCalled();
  });

  it("maps purchase failures through the Contact Reveal interface", async () => {
    const action = createContactRevealAction({
      authenticateSession: vi.fn(async () => ({
        memberId: "member-a",
        organizationId: "organization-a",
      })),
      authenticateApiKey: vi.fn(async () => null),
      requireWorkspace: vi.fn(async () => undefined),
      enforcePrincipalRateLimits: vi.fn(async () => null),
      recordActivity: vi.fn(async () => undefined),
      purchase: vi.fn(async () => {
        throw {
          _tag: "ContactRevealRejected",
          reason: "insufficient_credits",
        };
      }),
    });

    const result = await action.execute({
      authentication: { kind: "session", request: new Request("https://web") },
      environment: {},
      profileId: "profile-a",
      type: "professional-email",
      observation: { valid: true },
      idempotencyKey: "reveal-a",
      source: "web",
      correlationId: "correlation-a",
    });

    expect(result).toEqual({
      ok: false,
      status: 402,
      error: {
        code: "insufficient_credits",
        message: "The Organization has insufficient Credits",
      },
    });
  });
});
