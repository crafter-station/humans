import type { BrowserContext, Page, Route } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  setupClerkTestingTokenSafely,
  verifyPersonalOrganization,
} from "./browser-auth";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Clerk browser acceptance authentication", () => {
  it("contains tokenized transport failures inside the route", async () => {
    vi.useFakeTimers();
    const testingToken = "testing-token-that-must-stay-private";
    vi.stubEnv("CLERK_FAPI", "clerk.example.test");
    vi.stubEnv("CLERK_TESTING_TOKEN", testingToken);
    let handler: ((route: Route) => Promise<void>) | undefined;
    const context = {
      route: vi.fn(async (_matcher, registeredHandler) => {
        handler = registeredHandler as (route: Route) => Promise<void>;
      }),
    } as unknown as BrowserContext;
    const page = { context: () => context } as unknown as Page;
    const route = {
      abort: vi.fn(async () => undefined),
      fetch: vi.fn(async () => {
        throw new Error(`transport included ${testingToken}`);
      }),
      request: () => ({ url: () => "https://clerk.example.test/v1/client" }),
    } as unknown as Route;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await setupClerkTestingTokenSafely(page);
    const handled = handler?.(route);
    await vi.runAllTimersAsync();

    await expect(handled).resolves.toBeUndefined();
    expect(route.abort).toHaveBeenCalledWith("failed");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("verifies the exact personal Organization and sole creator membership", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          created_by: "user_member",
          id: "org_personal",
          members_count: 1,
          name: "My Organization",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              organization: { id: "org_personal" },
              public_user_data: { user_id: "user_member" },
            },
          ],
          total_count: 1,
        }),
      );

    await expect(
      verifyPersonalOrganization(
        {
          memberId: "user_member",
          organizationId: "org_personal",
          secretKey: "private-secret",
        },
        fetcher,
      ),
    ).resolves.toBeUndefined();
  });

  it("replaces Clerk transport details with a constant diagnostic", async () => {
    const secret = "private-secret";
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(
      new Error(`request leaked ${secret}`),
    );

    const error = await verifyPersonalOrganization(
      {
        memberId: "user_member",
        organizationId: "org_personal",
        secretKey: secret,
      },
      fetcher,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Clerk identity verification failed");
    expect((error as Error).message).not.toContain(secret);
  });
});
