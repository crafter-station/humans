import { describe, expect, it, vi } from "vitest";

import {
  createOpenAIEvidenceNormalizer,
  type FetchLike,
  type GitHubEvidence,
  InvalidOpenAIResponseError,
  type NormalizedEvidence,
  OPENAI_MAX_EVIDENCE_CONTRIBUTIONS,
  OPENAI_MAX_EVIDENCE_INPUT_LENGTH,
  OPENAI_MAX_EVIDENCE_REPOSITORIES,
  OPENAI_MAX_NORMALIZED_SKILLS,
  OPENAI_MAX_NORMALIZED_SUMMARY_LENGTH,
  OPENAI_MAX_REPOSITORY_DESCRIPTION_LENGTH,
  OpenAIProviderError,
} from "../src/index.js";

const normalized: NormalizedEvidence = {
  roles: ["Backend Engineer"],
  skills: ["TypeScript", "PostgreSQL"],
  summary: "Builds typed backend services.",
  evidenceRepositoryIds: [1],
};

const evidence = (repositoryCount = 2): GitHubEvidence => ({
  user: {
    id: 42,
    login: "identity-login-must-not-be-sent",
    name: "Identity Name Must Not Be Sent",
    bio: "Identity Bio Must Not Be Sent",
    company: "Identity Company Must Not Be Sent",
    location: "Identity Location Must Not Be Sent",
    blog: "https://identity-must-not-be-sent.example",
    type: "User",
  },
  repositories: Array.from({ length: repositoryCount }, (_, index) => {
    const id = index + 1;
    return {
      id,
      ownerId: id % 2 === 0 ? 900 : 42,
      name: `repository-${id}`,
      description: "x".repeat(OPENAI_MAX_REPOSITORY_DESCRIPTION_LENGTH + 100),
      fork: false,
      stargazersCount: id,
      forksCount: 1,
      pushedAt: new Date(Date.UTC(2026, 7, 31 - index)).toISOString(),
      languages: { TypeScript: 2_000, SQL: 500 },
      pinned: id === repositoryCount,
    };
  }),
  contributions: Array.from(
    { length: OPENAI_MAX_EVIDENCE_CONTRIBUTIONS + 30 },
    (_, index) => ({
      repositoryId: (index % repositoryCount) + 1,
      occurredAt: new Date(Date.UTC(2026, 7, 31 - (index % 28))).toISOString(),
      kind: "commit" as const,
    }),
  ),
});

const responsePayload = (output: unknown = normalized) => ({
  id: "resp_123",
  object: "response",
  status: "completed",
  output: [
    {
      id: "msg_123",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          annotations: [],
          text: typeof output === "string" ? output : JSON.stringify(output),
        },
      ],
    },
  ],
  usage: {
    input_tokens: 500,
    output_tokens: 80,
    total_tokens: 580,
  },
});

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const fetchReturning = (body: unknown) =>
  vi.fn<FetchLike>(async () => jsonResponse(body));

const postedBody = (fetch: ReturnType<typeof fetchReturning>) => {
  const [url, init] = fetch.mock.calls[0] ?? [];
  if (typeof init?.body !== "string") throw new Error("Missing request body");
  return {
    url,
    headers: new Headers(init.headers),
    body: JSON.parse(init.body) as Record<string, unknown>,
  };
};

describe("OpenAI evidence normalizer", () => {
  it("uses an explicit model and strictly structured, bounded repository evidence", async () => {
    const fetch = fetchReturning(responsePayload());
    const normalizer = createOpenAIEvidenceNormalizer({
      apiKey: "openai-dedicated-key",
      model: "gpt-4o-mini-2024-07-18",
      fetch,
    });

    await expect(
      normalizer.normalize(evidence(OPENAI_MAX_EVIDENCE_REPOSITORIES + 5)),
    ).resolves.toEqual(normalized);

    const request = postedBody(fetch);
    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(request.headers.get("authorization")).toBe(
      "Bearer openai-dedicated-key",
    );
    expect(request.body).toMatchObject({
      model: "gpt-4o-mini-2024-07-18",
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "github_evidence_normalization",
          strict: true,
          schema: { additionalProperties: false },
        },
      },
    });
    expect(JSON.stringify(request.body.text)).not.toContain("uniqueItems");
    if (typeof request.body.input !== "string")
      throw new Error("Expected serialized evidence input");
    expect(request.body.input.length).toBeLessThanOrEqual(
      OPENAI_MAX_EVIDENCE_INPUT_LENGTH,
    );
    const input = JSON.parse(request.body.input) as {
      repositories: Array<{
        id: number;
        description: string;
        ownedByProfile: boolean;
      }>;
      contributions: Array<{ repositoryId: number }>;
    };
    expect(input.repositories).toHaveLength(OPENAI_MAX_EVIDENCE_REPOSITORIES);
    expect(input.contributions.length).toBeLessThanOrEqual(
      OPENAI_MAX_EVIDENCE_CONTRIBUTIONS,
    );
    expect(
      input.repositories.every(
        ({ description }) =>
          description.length <= OPENAI_MAX_REPOSITORY_DESCRIPTION_LENGTH,
      ),
    ).toBe(true);
    const includedIds = new Set(input.repositories.map(({ id }) => id));
    expect(
      input.contributions.every(({ repositoryId }) =>
        includedIds.has(repositoryId),
      ),
    ).toBe(true);
    expect(
      input.repositories.some(({ ownedByProfile }) => ownedByProfile),
    ).toBe(true);
    expect(request.body.input).not.toContain("Identity Name Must Not Be Sent");
    expect(request.body.input).not.toContain("identity-login-must-not-be-sent");
    expect(request.body.input).not.toContain(
      "identity-must-not-be-sent.example",
    );
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    {
      name: "non-JSON output",
      payload: responsePayload("not json"),
    },
    {
      name: "missing a required field",
      payload: responsePayload({
        roles: [],
        skills: [],
        summary: "",
      }),
    },
    {
      name: "an invented identity field",
      payload: responsePayload({ ...normalized, name: "Invented Person" }),
    },
    {
      name: "claims without citations",
      payload: responsePayload({
        ...normalized,
        evidenceRepositoryIds: [],
      }),
    },
    {
      name: "duplicate skills",
      payload: responsePayload({
        ...normalized,
        skills: ["TypeScript", "TypeScript"],
      }),
    },
    {
      name: "too many skills",
      payload: responsePayload({
        ...normalized,
        skills: Array.from(
          { length: OPENAI_MAX_NORMALIZED_SKILLS + 1 },
          (_, index) => `Skill ${index}`,
        ),
      }),
    },
    {
      name: "an overlong summary",
      payload: responsePayload({
        ...normalized,
        summary: "x".repeat(OPENAI_MAX_NORMALIZED_SUMMARY_LENGTH + 1),
      }),
    },
    {
      name: "duplicate citations",
      payload: responsePayload({
        ...normalized,
        evidenceRepositoryIds: [1, 1],
      }),
    },
    {
      name: "a refusal",
      payload: {
        status: "completed",
        output: [
          {
            type: "message",
            status: "completed",
            content: [{ type: "refusal", refusal: "Cannot comply" }],
          },
        ],
      },
    },
  ])("rejects bad model output: $name", async ({ payload }) => {
    const normalizer = createOpenAIEvidenceNormalizer({
      apiKey: "dedicated",
      model: "gpt-4o-mini-2024-07-18",
      fetch: fetchReturning(payload),
    });

    await expect(normalizer.normalize(evidence())).rejects.toBeInstanceOf(
      InvalidOpenAIResponseError,
    );
  });

  it("rejects repository citations that were not supplied to the model", async () => {
    const omittedRepositoryId = OPENAI_MAX_EVIDENCE_REPOSITORIES;
    const normalizer = createOpenAIEvidenceNormalizer({
      apiKey: "dedicated",
      model: "gpt-4o-mini-2024-07-18",
      fetch: fetchReturning(
        responsePayload({
          ...normalized,
          evidenceRepositoryIds: [omittedRepositoryId],
        }),
      ),
    });

    await expect(
      normalizer.normalize(evidence(OPENAI_MAX_EVIDENCE_REPOSITORIES + 1)),
    ).rejects.toThrow("unsupported repository evidence");
  });

  it("requires explicit credentials and model configuration", () => {
    expect(() =>
      createOpenAIEvidenceNormalizer({ apiKey: "", model: "model" }),
    ).toThrow("API key is required");
    expect(() =>
      createOpenAIEvidenceNormalizer({ apiKey: "key", model: "" }),
    ).toThrow("model is required");
  });

  it("sanitizes transient HTTP and network errors", async () => {
    const httpNormalizer = createOpenAIEvidenceNormalizer({
      apiKey: "openai-do-not-leak",
      model: "gpt-4o-mini-2024-07-18",
      fetch: vi.fn<FetchLike>(async () =>
        jsonResponse(
          { error: { message: "openai-do-not-leak and private evidence" } },
          503,
          { "Retry-After": "15" },
        ),
      ),
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    });
    const httpError = await httpNormalizer
      .normalize(evidence())
      .catch((error: unknown) => error);
    expect(httpError).toBeInstanceOf(OpenAIProviderError);
    expect(httpError).toMatchObject({
      status: 503,
      message: "OpenAI request failed with status 503",
      retryAfter: new Date("2026-09-01T00:00:15.000Z"),
    });
    expect(JSON.stringify(httpError)).not.toContain("do-not-leak");
    expect(JSON.stringify(httpError)).not.toContain("private evidence");

    const networkNormalizer = createOpenAIEvidenceNormalizer({
      apiKey: "openai-do-not-leak",
      model: "gpt-4o-mini-2024-07-18",
      fetch: vi.fn<FetchLike>(async () => {
        throw new Error("network failed with openai-do-not-leak");
      }),
    });
    const networkError = await networkNormalizer
      .normalize(evidence())
      .catch((error: unknown) => error);
    expect(networkError).toMatchObject({
      status: 0,
      message: "OpenAI request failed",
    });
    expect(JSON.stringify(networkError)).not.toContain("do-not-leak");
  });
});
