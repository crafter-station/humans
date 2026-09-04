import type { BrowserContext } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { establishVercelBypass } from "./vercel-bypass";

const deployment = new URL(
  "https://humans-abcdefghi-crafter-station.vercel.app/",
);
const secret = "unit-bypass-secret";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("establishVercelBypass", () => {
  it("retains only a new host-scoped expiring HttpOnly cookie", async () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const cookie = validCookie(expires);
    const response = responseStub();
    const get = vi.fn(async () => response);
    const cookies = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([cookie]);
    const context = { cookies, request: { get } } as unknown as BrowserContext;

    await establishVercelBypass(context, deployment, secret);

    expect(get).toHaveBeenCalledWith(deployment.href, {
      headers: {
        "x-vercel-protection-bypass": secret,
        "x-vercel-set-bypass-cookie": "true",
      },
      maxRedirects: 0,
    });
    expect(cookies).toHaveBeenCalledTimes(2);
    expect(response.dispose).toHaveBeenCalledOnce();
  });

  it("sanitizes a request transport error containing the bypass secret", async () => {
    const context = {
      cookies: vi.fn(async () => []),
      request: {
        get: vi.fn(async () => {
          throw new Error(`request headers: ${secret}`);
        }),
      },
    } as unknown as BrowserContext;

    const error = await establishVercelBypass(
      context,
      deployment,
      secret,
    ).catch((caught: unknown) => caught);

    expect(error).toEqual(
      new Error("Vercel deployment bypass transport failed"),
    );
    expect(String(error)).not.toContain(secret);
  });

  it("sanitizes cookie and response-disposal transport errors", async () => {
    const response = responseStub();
    response.dispose.mockRejectedValueOnce(new Error(`dispose ${secret}`));
    const context = contextStub([], [validCookie()], response);

    const error = await establishVercelBypass(
      context,
      deployment,
      secret,
    ).catch((caught: unknown) => caught);

    expect(error).toEqual(
      new Error("Vercel deployment bypass transport failed"),
    );
    expect(String(error)).not.toContain(secret);
  });

  it("does not accept a pre-existing bypass cookie", async () => {
    const cookie = validCookie();
    const context = contextStub([cookie], [cookie]);

    await expect(
      establishVercelBypass(context, deployment, secret),
    ).rejects.toThrow("was not newly established");
  });

  it.each([
    [{ httpOnly: false }, "must be HttpOnly"],
    [{ secure: false }, "must be Secure"],
    [{ domain: ".crafter-station.vercel.app" }, "scope is invalid"],
    [{ path: "/acceptance" }, "scope is invalid"],
    [{ expires: Math.floor(Date.now() / 1000) - 1 }, "expiry is invalid"],
  ] as const)("rejects an unsafe cookie %#", async (patch, message) => {
    const cookie = validCookie();
    const context = contextStub([], [{ ...cookie, ...patch }]);

    await expect(
      establishVercelBypass(context, deployment, secret),
    ).rejects.toThrow(message);
  });

  it("rejects a cookie whose browser expiry differs from its JWT expiry", async () => {
    const cookie = validCookie();
    const context = contextStub(
      [],
      [{ ...cookie, expires: cookie.expires + 60 }],
    );

    await expect(
      establishVercelBypass(context, deployment, secret),
    ).rejects.toThrow("expiry is invalid");
  });

  it("selects the non-persisting reporter whenever the bypass secret is present", async () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", secret);
    vi.resetModules();

    const { default: config } = await import("../playwright.config");

    expect(config.reporter).toEqual([["dot"]]);
  });
});

const contextStub = (
  before: unknown[],
  after: unknown[],
  response = responseStub(),
) =>
  ({
    cookies: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
    request: { get: vi.fn(async () => response) },
  }) as unknown as BrowserContext;

const responseStub = () => ({
  dispose: vi.fn(async () => undefined),
  status: vi.fn(() => 307),
});

const validCookie = (expires = Math.floor(Date.now() / 1000) + 3600) => ({
  domain: deployment.hostname,
  expires,
  httpOnly: true,
  name: "_vercel_jwt",
  path: "/",
  secure: true,
  value: jwt({ exp: expires }),
});

const jwt = (payload: unknown) =>
  `${encode({ alg: "none" })}.${encode(payload)}.unit-signature`;

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
