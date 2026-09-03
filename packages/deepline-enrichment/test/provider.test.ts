import { describe, expect, it, vi } from "vitest";
import {
  classifyDeeplineError,
  createDeeplineProvider,
  DEEPLINE_CAREER_TOOL_ID,
  DEEPLINE_IDENTITY_TOOL_ID,
  DeeplineProviderError,
  InvalidDeeplineContractError,
  InvalidDeeplineResultError,
  retryOptionsForDeeplineError,
} from "../src/index.js";
import contracts from "./fixtures/contracts.json" with { type: "json" };
import executions from "./fixtures/executions.json" with { type: "json" };

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

const apiFetch = (
  contract: unknown,
  execution: unknown,
  describedContract: unknown = contract,
) =>
  vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/v2/tools?"))
      return jsonResponse({ success: true, tools: [contract] });
    if (url.endsWith("/get")) return jsonResponse(describedContract);
    if (url.endsWith("/execute")) return jsonResponse(execution);
    throw new Error(`Unexpected test URL: ${url}`);
  });

describe("Deepline HTTP provider", () => {
  it("discovers and describes the identity tool before executing its typed payload", async () => {
    const fetch = apiFetch(contracts.identity, executions.identity);
    const provider = createDeeplineProvider({
      apiKey: "test-secret-key",
      fetch: fetch as typeof globalThis.fetch,
    });

    const result = await provider.resolveIdentity({
      fullName: "Ada Lovelace",
      companyName: "Analytical Engines",
      companyDomain: "analytical.example",
      email: "ada@analytical.example",
    });

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      `https://code.deepline.com/api/v2/tools?grep=${DEEPLINE_IDENTITY_TOOL_ID}&compact=false`,
      `https://code.deepline.com/api/v2/integrations/${DEEPLINE_IDENTITY_TOOL_ID}/get`,
      `https://code.deepline.com/api/v2/integrations/${DEEPLINE_IDENTITY_TOOL_ID}/execute`,
    ]);
    const executeInit = fetch.mock.calls[2]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(executeInit?.body))).toEqual({
      payload: {
        full_name: "Ada Lovelace",
        company_name: "Analytical Engines",
        company_domain: "analytical.example",
        email: "ada@analytical.example",
      },
    });
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer test-secret-key",
      );
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(result.value).toEqual({
      linkedinUrl: "https://www.linkedin.com/in/ada-lovelace",
      githubUrl: "https://github.com/ada",
      xUrl: "https://x.com/ada",
    });
    expect(result.raw).toMatchObject({
      meta: { requestId: "sanitized-identity-request" },
    });
  });

  it("uses the approved career tool with main=true and never requests email discovery", async () => {
    const fetch = apiFetch(contracts.career, executions.career);
    const provider = createDeeplineProvider({
      apiKey: "test-secret-key",
      fetch: fetch as typeof globalThis.fetch,
    });

    const result = await provider.getLinkedInCareer(
      "https://www.linkedin.com/in/ada-lovelace",
    );

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      `https://code.deepline.com/api/v2/tools?grep=${DEEPLINE_CAREER_TOOL_ID}&compact=false`,
      `https://code.deepline.com/api/v2/integrations/${DEEPLINE_CAREER_TOOL_ID}/get`,
      `https://code.deepline.com/api/v2/integrations/${DEEPLINE_CAREER_TOOL_ID}/execute`,
    ]);
    const executeInit = fetch.mock.calls[2]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(executeInit?.body));
    expect(body).toEqual({
      payload: {
        url: "https://www.linkedin.com/in/ada-lovelace",
        main: "true",
      },
    });
    expect(body.payload).not.toHaveProperty("findEmail");
    expect(result.value).toMatchObject({
      sourceRecordId: "linkedin:ada-lovelace",
      headline: "Staff Software Engineer",
      skills: ["TypeScript", "Distributed Systems"],
    });
  });

  it("fails permanently before execution when the discovered or described contract drifts", async () => {
    const missingRequiredName = {
      ...contracts.identity,
      inputSchema: {
        ...contracts.identity.inputSchema,
        jsonSchema: {
          ...contracts.identity.inputSchema.jsonSchema,
          required: [],
        },
      },
    };
    const fetch = apiFetch(missingRequiredName, executions.identity);
    const provider = createDeeplineProvider({
      apiKey: "test-secret-key",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(
      provider.resolveIdentity({ fullName: "Ada Lovelace" }),
    ).rejects.toBeInstanceOf(InvalidDeeplineContractError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      fetch.mock.calls.some(([url]) => String(url).endsWith("/execute")),
    ).toBe(false);

    const describedFetch = apiFetch(
      contracts.identity,
      executions.identity,
      missingRequiredName,
    );
    await expect(
      createDeeplineProvider({
        apiKey: "test-secret-key",
        fetch: describedFetch as typeof globalThis.fetch,
      }).resolveIdentity({ fullName: "Ada Lovelace" }),
    ).rejects.toBeInstanceOf(InvalidDeeplineContractError);
    expect(describedFetch).toHaveBeenCalledTimes(2);
    expect(
      describedFetch.mock.calls.some(([url]) =>
        String(url).endsWith("/execute"),
      ),
    ).toBe(false);
    expect(
      retryOptionsForDeeplineError(
        new InvalidDeeplineContractError("contract drift"),
      ),
    ).toEqual({ skipRetrying: true });
  });

  it("fails permanently for malformed execution envelopes and tool results", async () => {
    const malformedEnvelope = apiFetch(contracts.identity, {
      status: "completed",
      data: executions.identity.toolResponse.raw,
    });
    await expect(
      createDeeplineProvider({
        apiKey: "test-secret-key",
        fetch: malformedEnvelope as typeof globalThis.fetch,
      }).resolveIdentity({ fullName: "Ada Lovelace" }),
    ).rejects.toBeInstanceOf(InvalidDeeplineResultError);

    const malformedCareer = structuredClone(executions.career);
    malformedCareer.toolResponse.raw.data.element.headline = 42 as never;
    await expect(
      createDeeplineProvider({
        apiKey: "test-secret-key",
        fetch: apiFetch(
          contracts.career,
          malformedCareer,
        ) as typeof globalThis.fetch,
      }).getLinkedInCareer("https://linkedin.com/in/ada-lovelace"),
    ).rejects.toBeInstanceOf(InvalidDeeplineResultError);
    expect(
      retryOptionsForDeeplineError(
        new InvalidDeeplineResultError("invalid result"),
      ),
    ).toEqual({ skipRetrying: true });
  });

  it("rejects identity links outside their canonical HTTPS domains", async () => {
    const wrongDomain = structuredClone(executions.identity);
    wrongDomain.toolResponse.raw.data.github_url =
      "https://profiles.example.test/ada";
    await expect(
      createDeeplineProvider({
        apiKey: "test-secret-key",
        fetch: apiFetch(
          contracts.identity,
          wrongDomain,
        ) as typeof globalThis.fetch,
      }).resolveIdentity({ fullName: "Ada Lovelace" }),
    ).rejects.toBeInstanceOf(InvalidDeeplineResultError);

    const insecure = structuredClone(executions.identity);
    insecure.toolResponse.raw.data.linkedin_url =
      "http://www.linkedin.com/in/ada-lovelace";
    await expect(
      createDeeplineProvider({
        apiKey: "test-secret-key",
        fetch: apiFetch(
          contracts.identity,
          insecure,
        ) as typeof globalThis.fetch,
      }).resolveIdentity({ fullName: "Ada Lovelace" }),
    ).rejects.toBeInstanceOf(InvalidDeeplineResultError);
  });

  it("classifies billing, throttling, and temporary availability safely", async () => {
    const fixedNow = new Date("2026-09-01T00:00:00.000Z");
    const unavailableFetch = vi.fn(async () =>
      jsonResponse(
        { error: { message: "raw provider details must stay private" } },
        { status: 503, headers: { "Retry-After": "120" } },
      ),
    );
    const provider = createDeeplineProvider({
      apiKey: "never-log-this-key",
      fetch: unavailableFetch as typeof globalThis.fetch,
      now: () => fixedNow,
    });

    const error = await provider
      .resolveIdentity({ fullName: "Ada Lovelace" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeeplineProviderError);
    expect(error).toMatchObject({
      status: 503,
      retryAfter: new Date("2026-09-01T00:02:00.000Z"),
    });
    expect(String(error)).not.toContain("never-log-this-key");
    expect(String(error)).not.toContain("raw provider details");
    expect(classifyDeeplineError(error)).toBe("rate-limit");
    expect(retryOptionsForDeeplineError(error)).toEqual({
      retryAt: new Date("2026-09-01T00:02:00.000Z"),
    });
    expect(
      classifyDeeplineError(new DeeplineProviderError("billing", 402)),
    ).toBe("billing");
    expect(
      retryOptionsForDeeplineError(new DeeplineProviderError("billing", 402)),
    ).toEqual({ skipRetrying: true });
    expect(
      classifyDeeplineError(new DeeplineProviderError("limited", 429)),
    ).toBe("retry");
    const throttledUntil = new Date("2026-09-01T00:03:00.000Z");
    expect(
      retryOptionsForDeeplineError(
        new DeeplineProviderError("limited", 429, throttledUntil),
      ),
    ).toEqual({ retryAt: throttledUntil });
    expect(
      classifyDeeplineError(new DeeplineProviderError("unavailable", 503)),
    ).toBe("retry");
  });
});
