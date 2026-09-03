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

describe("protected web proxies", () => {
  beforeEach(() => {
    mocks.auth.mockResolvedValue({ getToken: async () => "session-token" });
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
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
        headers: { "Content-Length": "4097" },
      }),
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(mocks.fetch).not.toHaveBeenCalled();
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
