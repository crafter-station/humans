import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_HUMANS_API_URL:
      "https://humans-api-production.hi-541.workers.dev",
  },
}));

import { browserApiOrigin, fetchHumansApi } from "../api-client";

describe("browser API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mocks.fetch.mockReset();
  });

  it("uses the public API alias only from the public Production app", () => {
    expect(browserApiOrigin("humns.co")).toBe(
      "https://api.humns.co",
    );
    expect(
      browserApiOrigin("humans-abcdef123-crafter-station.vercel.app"),
    ).toBe("https://humans-api-production.hi-541.workers.dev");
  });

  it("sends the Clerk session token directly to the API", async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", mocks.fetch);

    await fetchHumansApi(
      async () => "session-token",
      "/v1/profiles/search?q=anthony",
      { headers: { "Idempotency-Key": "search-request" } },
      "humns.co",
    );

    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.humns.co/v1/profiles/search?q=anthony",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer session-token");
    expect(headers.get("Idempotency-Key")).toBe("search-request");
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("error");
  });
});
