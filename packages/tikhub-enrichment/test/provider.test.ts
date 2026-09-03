import { describe, expect, it, vi } from "vitest";
import {
  classifyTikHubError,
  InvalidTikHubPayloadError,
  retryOptionsForTikHubError,
  TikHubLinkedInProvider,
  TikHubProviderError,
} from "../src/index.js";
import providerFixture from "./fixtures/tikhub-linkedin-response.json" with {
  type: "json",
};

const endpoint = "https://tikhub.example.test/linkedin/profile?region=latam";
const fixedNow = () => new Date("2026-09-02T00:00:00.000Z");

const responseFor = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const rejectionOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
};

describe("TikHubLinkedInProvider", () => {
  it("requests the configured endpoint with bearer authentication and maps the native provider response", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        responseFor(providerFixture),
    );
    const provider = new TikHubLinkedInProvider({
      apiKey: "test-api-key",
      endpoint,
      fetch,
      now: fixedNow,
    });

    const result = await provider.getLinkedInProfile(
      "https://www.linkedin.com/in/ada-lovelace?trk=public_profile",
    );

    const firstCall = fetch.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall === undefined) throw new Error("Fetch was not called");
    const [requestedUrl, request] = firstCall;
    const url = new URL(String(requestedUrl));
    expect(url.origin + url.pathname).toBe(
      "https://tikhub.example.test/linkedin/profile",
    );
    expect(url.searchParams.get("region")).toBe("latam");
    expect(url.searchParams.get("url")).toBe(
      "https://www.linkedin.com/in/ada-lovelace?trk=public_profile",
    );
    expect(url.toString()).not.toContain("test-api-key");
    expect(request?.method).toBe("GET");
    expect(request?.redirect).toBe("error");
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(request?.headers).get("authorization")).toBe(
      "Bearer test-api-key",
    );
    expect(result).toMatchObject({
      sourceRecordId: "linkedin:123456789",
      headline: "Staff Software Engineer",
      currentCompany: "Analytical Engines",
      currentCompanyId: "analytical-engines",
      skills: [],
    });
    expect(result.experience).toEqual([
      {
        sourceRecordId: "linkedin:123456789:experience:1",
        organization: "Analytical Engines",
        companyId: "analytical-engines",
        title: "Staff Software Engineer",
        startedAt: "Jan 2022",
        endedAt: "Present",
      },
    ]);
    expect(result.education).toEqual([
      {
        sourceRecordId: "linkedin:123456789:education:1",
        organization: "Universidad Nacional",
        field: "Computer Science",
        startedAt: "2017",
        endedAt: "2021",
      },
    ]);
    expect(result.contacts).toEqual([]);
    expect(result.providerEnvelope).toEqual(providerFixture);
  });

  it("accepts the object and JSON-string data forms published by TikHub", async () => {
    const encodedEnvelope = {
      ...providerFixture,
      params: JSON.stringify(providerFixture.params),
      data: JSON.stringify(providerFixture.data),
    };
    const fetch = vi.fn(async () => responseFor(encodedEnvelope));
    const provider = new TikHubLinkedInProvider({
      apiKey: "test-api-key",
      endpoint,
      fetch,
    });

    const result = await provider.getLinkedInProfile(
      "https://www.linkedin.com/in/ada-lovelace",
    );

    expect(result.sourceRecordId).toBe("linkedin:123456789");
    expect(result.providerEnvelope.data).toBe(encodedEnvelope.data);
  });

  it.each([
    ["missing", { linkedin_num_id: "234567890" }],
    [
      "null",
      {
        linkedin_num_id: "234567890",
        position: null,
        current_company_name: null,
        experience: null,
        education: null,
      },
    ],
    [
      "nested null",
      {
        linkedin_num_id: "234567890",
        experience: [
          {
            company: "Analytical Engines",
            title: null,
            start_date: null,
            end_date: null,
          },
        ],
        education: null,
      },
    ],
  ])(
    "maps %s optional fields without inventing evidence",
    async (_name, data) => {
      const fetch = vi.fn(async () => responseFor({ code: 200, data }));
      const provider = new TikHubLinkedInProvider({
        apiKey: "test-api-key",
        endpoint,
        fetch,
      });

      await expect(
        provider.getLinkedInProfile("https://www.linkedin.com/in/minimal"),
      ).resolves.toMatchObject({
        sourceRecordId: "linkedin:234567890",
        headline: null,
        currentCompany: null,
        experience:
          _name === "nested null"
            ? [
                {
                  sourceRecordId: "linkedin:234567890:experience:1",
                  organization: "Analytical Engines",
                },
              ]
            : [],
        education: [],
        skills: [],
        contacts: [],
      });
    },
  );

  it.each([
    ["non-object envelope", null],
    ["non-integer code", { code: "200", data: providerFixture.data }],
    ["missing data", { code: 200 }],
    ["null data", { code: 200, data: null }],
    [
      "invalid request ID",
      { code: 200, request_id: 42, data: providerFixture.data },
    ],
    [
      "invalid message",
      { code: 200, message: null, data: providerFixture.data },
    ],
    [
      "invalid timestamp",
      { code: 200, time_stamp: "now", data: providerFixture.data },
    ],
    ["invalid encoded data", { code: 200, data: "not-json" }],
    [
      "invalid profile contract",
      { code: 200, data: { ...providerFixture.data, linkedin_num_id: 42 } },
    ],
  ])("rejects %s", async (_name, body) => {
    const fetch = vi.fn(async () => responseFor(body));
    const provider = new TikHubLinkedInProvider({
      apiKey: "test-api-key",
      endpoint,
      fetch,
    });

    await expect(
      provider.getLinkedInProfile("https://www.linkedin.com/in/ada-lovelace"),
    ).rejects.toBeInstanceOf(InvalidTikHubPayloadError);
  });

  it("rejects a non-JSON success body without exposing it", async () => {
    const fetch = vi.fn(
      async () => new Response("raw-private-provider-payload", { status: 200 }),
    );
    const provider = new TikHubLinkedInProvider({
      apiKey: "test-api-key",
      endpoint,
      fetch,
    });

    const error = await rejectionOf(
      provider.getLinkedInProfile("https://www.linkedin.com/in/ada-lovelace"),
    );
    expect(error).toBeInstanceOf(InvalidTikHubPayloadError);
    expect(String(error)).not.toContain("raw-private-provider-payload");
  });

  it.each([401, 403, 404])(
    "classifies HTTP %i as a permanent provider failure",
    async (status) => {
      const fetch = vi.fn(async () =>
        responseFor(
          {
            detail: {
              code: status,
              message: "raw-private-provider-payload",
              headers: { Authorization: "Bearer test-api-key" },
            },
          },
          status,
          { "retry-after": "120" },
        ),
      );
      const provider = new TikHubLinkedInProvider({
        apiKey: "test-api-key",
        endpoint,
        fetch,
        now: fixedNow,
      });

      const error = await rejectionOf(
        provider.getLinkedInProfile("https://www.linkedin.com/in/ada-lovelace"),
      );
      expect(error).toBeInstanceOf(TikHubProviderError);
      if (!(error instanceof TikHubProviderError)) throw error;
      expect(error.status).toBe(status);
      expect(classifyTikHubError(error)).toBe("fatal");
      expect(retryOptionsForTikHubError(error)).toEqual({
        skipRetrying: true,
      });
      expect(String(error)).not.toContain("test-api-key");
      expect(String(error)).not.toContain("raw-private-provider-payload");
    },
  );

  it.each([
    ["delta seconds", "120", "2026-09-02T00:02:00.000Z"],
    ["HTTP date", "Wed, 02 Sep 2026 00:03:00 GMT", "2026-09-02T00:03:00.000Z"],
  ])("honors Retry-After in %s form", async (_name, header, expected) => {
    const fetch = vi.fn(async () =>
      responseFor({ detail: { code: 429 } }, 429, {
        "retry-after": header,
      }),
    );
    const provider = new TikHubLinkedInProvider({
      apiKey: "test-api-key",
      endpoint,
      fetch,
      now: fixedNow,
    });

    const error = await rejectionOf(
      provider.getLinkedInProfile("https://www.linkedin.com/in/ada-lovelace"),
    );
    expect(error).toBeInstanceOf(TikHubProviderError);
    if (!(error instanceof TikHubProviderError)) throw error;
    expect(error.status).toBe(429);
    expect(error.retryAfter?.toISOString()).toBe(expected);
    expect(classifyTikHubError(error)).toBe("rate-limit");
    expect(retryOptionsForTikHubError(error)).toEqual({
      retryAt: new Date(expected),
    });
  });

  it("classifies a 429 without valid retry guidance as retryable", async () => {
    const fetch = vi.fn(async () =>
      responseFor({ detail: { code: 429 } }, 429, {
        "retry-after": "not-a-date",
      }),
    );
    const provider = new TikHubLinkedInProvider({
      apiKey: "test-api-key",
      endpoint,
      fetch,
    });

    const error = await rejectionOf(
      provider.getLinkedInProfile("https://www.linkedin.com/in/ada-lovelace"),
    );
    expect(error).toBeInstanceOf(TikHubProviderError);
    if (!(error instanceof TikHubProviderError)) throw error;
    expect(error.retryAfter).toBeUndefined();
    expect(classifyTikHubError(error)).toBe("retry");
    expect(retryOptionsForTikHubError(error)).toBeUndefined();
  });

  it.each([500, 502, 503])(
    "classifies HTTP %i as a retryable provider failure",
    async (status) => {
      const fetch = vi.fn(async () => responseFor({ code: status }, status));
      const provider = new TikHubLinkedInProvider({
        apiKey: "test-api-key",
        endpoint,
        fetch,
      });

      const error = await rejectionOf(
        provider.getLinkedInProfile("https://www.linkedin.com/in/ada-lovelace"),
      );
      expect(error).toBeInstanceOf(TikHubProviderError);
      if (!(error instanceof TikHubProviderError)) throw error;
      expect(error.status).toBe(status);
      expect(classifyTikHubError(error)).toBe("retry");
      expect(retryOptionsForTikHubError(error)).toBeUndefined();
    },
  );

  it("honors Retry-After on a retryable server failure", async () => {
    const fetch = vi.fn(async () =>
      responseFor({ code: 503 }, 503, { "retry-after": "30" }),
    );
    const provider = new TikHubLinkedInProvider({
      apiKey: "test-api-key",
      endpoint,
      fetch,
      now: fixedNow,
    });

    const error = await rejectionOf(
      provider.getLinkedInProfile("https://www.linkedin.com/in/ada-lovelace"),
    );
    expect(error).toBeInstanceOf(TikHubProviderError);
    if (!(error instanceof TikHubProviderError)) throw error;
    expect(classifyTikHubError(error)).toBe("rate-limit");
    expect(error.retryAfter?.toISOString()).toBe("2026-09-02T00:00:30.000Z");
  });

  it("classifies an envelope-level error returned with HTTP 200", async () => {
    const fetch = vi.fn(async () =>
      responseFor({ code: 404, data: null, message: "not found" }),
    );
    const provider = new TikHubLinkedInProvider({
      apiKey: "test-api-key",
      endpoint,
      fetch,
    });

    const error = await rejectionOf(
      provider.getLinkedInProfile("https://www.linkedin.com/in/missing"),
    );
    expect(error).toBeInstanceOf(TikHubProviderError);
    if (!(error instanceof TikHubProviderError)) throw error;
    expect(error.status).toBe(404);
    expect(classifyTikHubError(error)).toBe("fatal");
  });

  it("turns network failures into sanitized retryable provider errors", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("socket failed with raw-private-provider-payload");
    });
    const provider = new TikHubLinkedInProvider({
      apiKey: "test-api-key",
      endpoint,
      fetch,
    });

    const error = await rejectionOf(
      provider.getLinkedInProfile("https://www.linkedin.com/in/ada-lovelace"),
    );
    expect(error).toBeInstanceOf(TikHubProviderError);
    if (!(error instanceof TikHubProviderError)) throw error;
    expect(error.status).toBe(0);
    expect(error.message).toBe("TikHub network request failed");
    expect(classifyTikHubError(error)).toBe("retry");
    expect(retryOptionsForTikHubError(error)).toBeUndefined();
    expect(String(error)).not.toContain("test-api-key");
    expect(String(error)).not.toContain("raw-private-provider-payload");
  });

  it("rejects invalid constructor configuration", () => {
    expect(
      () =>
        new TikHubLinkedInProvider({
          apiKey: " ",
          endpoint,
          fetch: vi.fn(),
        }),
    ).toThrow("apiKey must not be empty");
    expect(
      () =>
        new TikHubLinkedInProvider({
          apiKey: "test-api-key",
          endpoint: "file:///private/provider.json",
          fetch: vi.fn(),
        }),
    ).toThrow("endpoint must use HTTPS");
    expect(
      () =>
        new TikHubLinkedInProvider({
          apiKey: "test-api-key",
          endpoint: "http://tikhub.example.test/profile",
          fetch: vi.fn(),
        }),
    ).toThrow("endpoint must use HTTPS");
    expect(
      () =>
        new TikHubLinkedInProvider({
          apiKey: "test-api-key",
          endpoint: "https://secret@example.test/profile",
          fetch: vi.fn(),
        }),
    ).toThrow("endpoint must not contain credentials");
  });

  it.each([
    "not-a-url",
    "http://www.linkedin.com/in/ada-lovelace",
    "https://example.test/in/ada-lovelace",
    "https://secret@www.linkedin.com/in/ada-lovelace",
  ])("rejects invalid LinkedIn Profile URL %s before fetching", async (url) => {
    const fetch = vi.fn(async () => responseFor(providerFixture));
    const provider = new TikHubLinkedInProvider({
      apiKey: "test-api-key",
      endpoint,
      fetch,
    });

    await expect(provider.getLinkedInProfile(url)).rejects.toThrow(
      "Profile URL must be a valid LinkedIn URL",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
