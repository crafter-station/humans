import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/env", () => ({
  env: {
    HUMANS_API_URL: "https://worker.example",
    HUMANS_PROXY_SECRET: "server-owned-proxy-secret",
    TURNSTILE_SECRET_KEY: "server-owned-turnstile-secret",
  },
}));

import { POST as proxyContactReveal } from "../app/api/contact-reveals/[[...path]]/route";
import { POST as proxyBilling } from "../app/api/billing/[[...path]]/route";
import { GET as proxyBillingGet } from "../app/api/billing/[[...path]]/route";
import { POST as proxyPublicProfileRequest } from "../app/api/public/profile-requests/route";
import { PUT as proxySavedList } from "../app/api/saved-lists/[[...path]]/route";
import {
  protectedLocalResponseHeaders,
  protectedProxyHeaders,
  protectedResponseHeaders,
} from "../app/api/proxy-security";

const validPublicProfileRequest = {
  profileReference: "11111111-1111-4111-8111-111111111111",
  kind: "correction",
  requesterEmail: "requester@example.com",
  details: "Please correct this Profile.",
};
const turnstileAction = "profile_request";
const turnstileToken = "verified-widget-token";

const publicProfileRequest = (
  body: unknown,
  headers?: Record<string, string>,
) =>
  new Request("https://web.example/api/public/profile-requests", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("protected web proxies", () => {
  beforeEach(() => {
    mocks.auth.mockResolvedValue({ getToken: async () => "session-token" });
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("overwrites trusted proxy metadata and applies private response headers", () => {
    const request = new Request("https://web.example/api/search", {
      headers: {
        "X-Correlation-ID": "request-correlation",
        "X-Humans-Web-Proxy": "forged-secret",
        "X-Vercel-Forwarded-For": "203.0.113.4, 198.51.100.7",
      },
    });

    expect(protectedProxyHeaders(request, "session-token")).toMatchObject({
      authorization: "Bearer session-token",
      "X-Correlation-ID": "request-correlation",
      "X-Humans-Client-IP": "203.0.113.4",
      "X-Humans-Web-Proxy": "server-owned-proxy-secret",
    });
    expect(protectedLocalResponseHeaders()).toEqual({
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
    });
    expect(
      protectedResponseHeaders(
        Response.json(
          {},
          {
            headers: {
              "RateLimit-Remaining": "9",
              "X-Correlation-ID": "response-correlation",
            },
          },
        ),
      ),
    ).toMatchObject({
      "cache-control": "private, no-store",
      "RateLimit-Remaining": "9",
      "X-Correlation-ID": "response-correlation",
      "x-robots-tag": "noindex, nofollow",
    });
  });

  it("rejects paths outside the Contact Reveal allowlist", async () => {
    const response = await proxyContactReveal(
      new Request("https://web.example/api/contact-reveals/billing/checkout", {
        method: "POST",
      }),
      { params: Promise.resolve({ path: ["billing", "checkout"] }) },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("marks local protected authorization and route errors private", async () => {
    mocks.auth.mockResolvedValueOnce({ getToken: async () => null });
    const unauthorized = await proxyBilling(
      new Request("https://web.example/api/billing/checkout", {
        method: "POST",
      }),
      { params: Promise.resolve({ path: ["checkout"] }) },
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("private, no-store");

    const notFound = await proxyBilling(
      new Request("https://web.example/api/billing/not-a-route", {
        method: "POST",
      }),
      { params: Promise.resolve({ path: ["not-a-route"] }) },
    );
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const unknownBillingRead = await proxyBillingGet(
      new Request("https://web.example/api/billing/not-a-route"),
      { params: Promise.resolve({ path: ["not-a-route"] }) },
    );
    expect(unknownBillingRead.status).toBe(404);
    const unknownSavedList = await proxySavedList(
      new Request("https://web.example/api/saved-lists/list-a/export/all", {
        method: "PUT",
      }),
      { params: Promise.resolve({ path: ["list-a", "export", "all"] }) },
    );
    expect(unknownSavedList.status).toBe(404);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("marks rejected public Profile requests as no-store and no-index", async () => {
    const response = await proxyPublicProfileRequest(
      new Request("https://web.example/api/public/profile-requests", {
        method: "POST",
        headers: { "Content-Length": "8193" },
      }),
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects missing and malformed Turnstile tokens before verification", async () => {
    for (const body of [
      validPublicProfileRequest,
      { ...validPublicProfileRequest, turnstileToken: 42 },
      { ...validPublicProfileRequest, turnstileToken: " " },
      { ...validPublicProfileRequest, turnstileToken: "x".repeat(2_049) },
    ]) {
      const response = await proxyPublicProfileRequest(
        publicProfileRequest(body),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "verification_failed" },
      });
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("fails closed on rejected, malformed, wrong-host, and wrong-action verification", async () => {
    for (const verification of [
      { success: false, "error-codes": ["invalid-input-response"] },
      { success: true },
      {
        success: true,
        hostname: "attacker.example",
        action: turnstileAction,
      },
      {
        success: true,
        hostname: "web.example",
        action: "different_action",
      },
    ]) {
      mocks.fetch.mockResolvedValueOnce(Response.json(verification));

      const response = await proxyPublicProfileRequest(
        publicProfileRequest({
          ...validPublicProfileRequest,
          turnstileToken,
        }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "verification_failed" },
      });
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
  });

  it("fails closed when Siteverify exceeds its timeout", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The request was aborted", "AbortError"));
          });
        }),
    );

    const pendingResponse = proxyPublicProfileRequest(
      publicProfileRequest({
        ...validPublicProfileRequest,
        turnstileToken,
      }),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    const response = await pendingResponse;
    vi.useRealTimers();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "verification_unavailable" },
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("verifies trusted request metadata and strips the token before proxying", async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          hostname: "web.example",
          action: turnstileAction,
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { received: true },
          { status: 202, headers: { "RateLimit-Remaining": "4" } },
        ),
      );

    const response = await proxyPublicProfileRequest(
      publicProfileRequest(
        { ...validPublicProfileRequest, turnstileToken },
        {
          "X-Forwarded-For": "192.0.2.1",
          "X-Humans-Client-IP": "192.0.2.2",
          "X-Humans-Web-Proxy": "forged-secret",
          "X-Vercel-Forwarded-For": "203.0.113.4, 198.51.100.7",
        },
      ),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("RateLimit-Remaining")).toBe("4");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);

    const [siteverifyUrl, siteverifyInit] = mocks.fetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(siteverifyUrl).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    expect(siteverifyInit.redirect).toBe("error");
    const siteverifyBody = new URLSearchParams(String(siteverifyInit.body));
    expect(siteverifyBody.get("secret")).toBe("server-owned-turnstile-secret");
    expect(siteverifyBody.get("response")).toBe(turnstileToken);
    expect(siteverifyBody.get("remoteip")).toBe("203.0.113.4");

    const [workerUrl, workerInit] = mocks.fetch.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(workerUrl).toBe("https://worker.example/v1/public/profile-requests");
    expect(JSON.parse(String(workerInit.body))).toEqual(
      validPublicProfileRequest,
    );
    expect(String(workerInit.body)).not.toContain(turnstileToken);
    const workerHeaders = new Headers(workerInit.headers);
    expect(workerHeaders.get("X-Humans-Client-IP")).toBe("203.0.113.4");
    expect(workerHeaders.get("X-Humans-Web-Proxy")).toBe(
      "server-owned-proxy-secret",
    );
  });

  it("forwards an allowed Contact Reveal with server-owned headers", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json(
        { reveal: { observationId: "detail-a" } },
        { headers: { "RateLimit-Remaining": "8" } },
      ),
    );
    const response = await proxyContactReveal(
      new Request(
        "https://web.example/api/contact-reveals/profiles/profile-a/contact-reveals/email",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "reveal-attempt-a",
            "X-Humans-Web-Proxy": "forged-secret",
          },
          body: JSON.stringify({ observationId: "detail-a" }),
        },
      ),
      {
        params: Promise.resolve({
          path: ["profiles", "profile-a", "contact-reveals", "email"],
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("RateLimit-Remaining")).toBe("8");
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe(
      "https://worker.example/v1/profiles/profile-a/contact-reveals/email",
    );
    expect(headers.get("authorization")).toBe("Bearer session-token");
    expect(headers.get("Idempotency-Key")).toBe("reveal-attempt-a");
    expect(headers.get("X-Humans-Web-Proxy")).toBe("server-owned-proxy-secret");
  });
});
