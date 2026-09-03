import { describe, expect, it, vi } from "vitest";

import {
  classifyGitHubError,
  createGitHubProvider,
  type FetchLike,
  GitHubProviderError,
  InvalidGitHubResponseError,
  PermanentEnrichmentError,
  retryOptionsForGitHubError,
} from "../src/index.js";

const fixedNow = new Date("2026-09-01T00:00:00.000Z");

const userPayload = (type = "User") => ({
  login: "canonical-ada",
  id: 42,
  node_id: "MDQ6VXNlcjQy",
  avatar_url: "https://avatars.githubusercontent.com/u/42?v=4",
  url: "https://api.github.com/users/canonical-ada",
  html_url: "https://github.com/canonical-ada",
  type,
  site_admin: false,
  name: "Ada",
  company: null,
  blog: "https://ada.example",
  location: "Lima",
  bio: "Builds compilers",
  public_repos: 12,
});

const repositoryPayload = (
  id: number,
  overrides: Record<string, unknown> = {},
) => ({
  databaseId: id,
  owner: { databaseId: 42 },
  name: `repository-${id}`,
  description: "A typed service",
  isFork: false,
  stargazerCount: 17,
  forkCount: 3,
  pushedAt: "2026-08-20T10:00:00Z",
  visibility: "PUBLIC",
  languages: {
    edges: [
      { size: 2_048, node: { name: "TypeScript" } },
      { size: 512, node: { name: "SQL" } },
    ],
  },
  ...overrides,
});

const pageInfo = (hasNextPage = false, endCursor: string | null = null) => ({
  hasNextPage,
  endCursor,
});

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const queuedFetch = (responses: Response[]) =>
  vi.fn<FetchLike>(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  });

const requestBody = (fetch: ReturnType<typeof queuedFetch>, call: number) => {
  const init = fetch.mock.calls[call]?.[1];
  if (typeof init?.body !== "string") throw new Error("Missing request body");
  return JSON.parse(init.body) as {
    operationName: string;
    query: string;
    variables: Record<string, unknown>;
  };
};

describe("GitHub production provider", () => {
  it("uses only its dedicated token and returns canonical User identity", async () => {
    const fetch = queuedFetch([jsonResponse(userPayload())]);
    const provider = createGitHubProvider({
      token: "github_pat_dedicated",
      fetch,
      now: () => fixedNow,
    });

    await expect(provider.getUser("Ada-Lovelace")).resolves.toEqual({
      id: 42,
      login: "canonical-ada",
      name: "Ada",
      bio: "Builds compilers",
      company: null,
      location: "Lima",
      blog: "https://ada.example",
      type: "User",
    });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.github.com/users/Ada-Lovelace");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer github_pat_dedicated",
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["Bot", "Organization"])(
    "rejects %s accounts as non-qualifying identities",
    async (type) => {
      const provider = createGitHubProvider({
        token: "dedicated",
        fetch: queuedFetch([jsonResponse(userPayload(type))]),
      });

      const error = await provider
        .getUser("not-a-person")
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(PermanentEnrichmentError);
      expect(error).toMatchObject({
        message: "GitHub account is not a personal User account",
      });
    },
  );

  it("rejects malformed canonical identity payloads", async () => {
    const provider = createGitHubProvider({
      token: "dedicated",
      fetch: queuedFetch([
        jsonResponse({ ...userPayload(), id: "not-a-numeric-id" }),
      ]),
    });

    const error = await provider
      .getUser("ada")
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(InvalidGitHubResponseError);
    expect(error).toMatchObject({ status: 502 });
    expect(classifyGitHubError(error)).toBe("retry");
  });

  it("paginates pinned and recent repositories with required metadata", async () => {
    const fetch = queuedFetch([
      jsonResponse({
        data: {
          user: {
            pinnedItems: {
              nodes: [
                repositoryPayload(101),
                repositoryPayload(900, {
                  databaseId: null,
                  visibility: "PRIVATE",
                }),
                repositoryPayload(901, { pushedAt: null }),
              ],
              pageInfo: pageInfo(true, "pinned-2"),
            },
          },
        },
      }),
      jsonResponse({
        data: {
          user: {
            pinnedItems: {
              nodes: [repositoryPayload(102)],
              pageInfo: pageInfo(),
            },
          },
        },
      }),
      jsonResponse({
        data: {
          user: {
            repositories: {
              nodes: [repositoryPayload(103, { stargazerCount: 31 })],
              pageInfo: pageInfo(true, "recent-2"),
            },
          },
        },
      }),
      jsonResponse({
        data: {
          user: {
            repositories: {
              nodes: [repositoryPayload(104, { isFork: true })],
              pageInfo: pageInfo(),
            },
          },
        },
      }),
    ]);
    const provider = createGitHubProvider({ token: "dedicated", fetch });

    const pinnedFirst = await provider.getPinnedRepositories("ada");
    const pinnedSecond = await provider.getPinnedRepositories(
      "ada",
      pinnedFirst.nextCursor,
    );
    const recentFirst = await provider.getRecentlyActiveRepositories("ada");
    const recentSecond = await provider.getRecentlyActiveRepositories(
      "ada",
      recentFirst.nextCursor,
    );

    expect([...pinnedFirst.repositories, ...pinnedSecond.repositories]).toEqual(
      [
        expect.objectContaining({
          id: 101,
          ownerId: 42,
          pinned: true,
          languages: { TypeScript: 2_048, SQL: 512 },
          stargazersCount: 17,
          forksCount: 3,
        }),
        expect.objectContaining({ id: 102, pinned: true }),
      ],
    );
    expect([...recentFirst.repositories, ...recentSecond.repositories]).toEqual(
      [
        expect.objectContaining({ id: 103, pinned: false }),
        expect.objectContaining({ id: 104, fork: true, pinned: false }),
      ],
    );
    expect(requestBody(fetch, 1).variables.cursor).toBe("pinned-2");
    expect(requestBody(fetch, 3).variables.cursor).toBe("recent-2");
    expect(requestBody(fetch, 2).query).toContain("privacy: PUBLIC");
    expect(requestBody(fetch, 2).query).toContain("field: PUSHED_AT");
  });

  it("collects only public contribution evidence across a stable 12-month window", async () => {
    const fetch = queuedFetch([
      jsonResponse({
        data: {
          user: {
            contributionsCollection: {
              commitContributionsByRepository: [
                {
                  repository: { databaseId: 201, visibility: "PUBLIC" },
                  contributions: {
                    nodes: [
                      {
                        occurredAt: "2026-08-20T00:00:00Z",
                        isRestricted: false,
                        commitCount: 8,
                      },
                    ],
                  },
                },
                {
                  repository: { databaseId: null, visibility: "PRIVATE" },
                  contributions: {
                    nodes: [
                      {
                        occurredAt: "2026-08-19T00:00:00Z",
                        isRestricted: false,
                        commitCount: 2,
                      },
                    ],
                  },
                },
              ],
              issueContributions: {
                nodes: [
                  {
                    occurredAt: "2026-08-18T00:00:00Z",
                    isRestricted: false,
                    issue: {
                      repository: { databaseId: 203, visibility: "PUBLIC" },
                    },
                  },
                ],
                pageInfo: pageInfo(true, "issues-2"),
              },
              pullRequestContributions: {
                nodes: [
                  {
                    occurredAt: "2026-08-17T00:00:00Z",
                    isRestricted: false,
                    pullRequest: {
                      repository: { databaseId: 204, visibility: "PUBLIC" },
                    },
                  },
                ],
                pageInfo: pageInfo(),
              },
              pullRequestReviewContributions: {
                nodes: [
                  {
                    occurredAt: "2026-08-16T00:00:00Z",
                    isRestricted: false,
                    repository: { databaseId: 205, visibility: "PUBLIC" },
                  },
                ],
                pageInfo: pageInfo(),
              },
            },
          },
        },
      }),
      jsonResponse({
        data: {
          user: {
            contributionsCollection: {
              issueContributions: {
                nodes: [
                  {
                    occurredAt: "2025-09-01T00:00:00Z",
                    isRestricted: false,
                    issue: {
                      repository: { databaseId: 206, visibility: "PUBLIC" },
                    },
                  },
                ],
                pageInfo: pageInfo(),
              },
            },
          },
        },
      }),
    ]);
    const provider = createGitHubProvider({
      token: "dedicated",
      fetch,
      now: () => fixedNow,
    });

    const first = await provider.getContributions(
      "ada",
      "2025-09-01T00:00:00.000Z",
    );
    const second = await provider.getContributions(
      "ada",
      "2025-09-01T00:00:00.000Z",
      first.nextCursor,
    );

    expect([...first.contributions, ...second.contributions]).toEqual([
      {
        repositoryId: 201,
        occurredAt: "2026-08-20T00:00:00Z",
        kind: "commit",
      },
      {
        repositoryId: 203,
        occurredAt: "2026-08-18T00:00:00Z",
        kind: "issue",
      },
      {
        repositoryId: 204,
        occurredAt: "2026-08-17T00:00:00Z",
        kind: "pull-request",
      },
      {
        repositoryId: 205,
        occurredAt: "2026-08-16T00:00:00Z",
        kind: "review",
      },
      {
        repositoryId: 206,
        occurredAt: "2025-09-01T00:00:00Z",
        kind: "issue",
      },
    ]);
    expect(second.nextCursor).toBeUndefined();
    expect(requestBody(fetch, 0).variables).toMatchObject({
      from: "2025-09-01T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
      includeCommits: true,
      includeIssues: true,
      includePullRequests: true,
      includeReviews: true,
    });
    expect(requestBody(fetch, 1).variables).toMatchObject({
      issueCursor: "issues-2",
      includeCommits: false,
      includeIssues: true,
      includePullRequests: false,
      includeReviews: false,
    });
  });

  it("rejects malformed success payloads rather than persisting partial data", async () => {
    const malformedRepository = repositoryPayload(101);
    const { languages: _languages, ...withoutLanguages } = malformedRepository;
    const provider = createGitHubProvider({
      token: "dedicated",
      fetch: queuedFetch([
        jsonResponse({
          data: {
            user: {
              repositories: {
                nodes: [withoutLanguages],
                pageInfo: pageInfo(),
              },
            },
          },
        }),
      ]),
    });

    await expect(
      provider.getRecentlyActiveRepositories("ada"),
    ).rejects.toBeInstanceOf(InvalidGitHubResponseError);
  });

  it("handles GraphQL errors returned with HTTP 200, including rate limits", async () => {
    const resetSeconds = Math.floor(
      new Date("2026-09-01T00:05:00.000Z").getTime() / 1000,
    );
    const provider = createGitHubProvider({
      token: "dedicated",
      fetch: queuedFetch([
        jsonResponse(
          {
            data: null,
            errors: [
              {
                type: "RATE_LIMITED",
                message: "API rate limit exceeded for user ID 123.",
              },
            ],
          },
          200,
          {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetSeconds),
          },
        ),
      ]),
      now: () => fixedNow,
    });

    const error = await provider
      .getPinnedRepositories("ada")
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubProviderError);
    expect(error).toMatchObject({
      status: 429,
      retryAfter: new Date("2026-09-01T00:05:00.000Z"),
      message: "GitHub GraphQL request failed",
    });
    expect(classifyGitHubError(error)).toBe("rate-limit");
    expect(retryOptionsForGitHubError(error)).toEqual({
      retryAt: new Date("2026-09-01T00:05:00.000Z"),
    });
  });

  it.each([
    {
      name: "403 Retry-After",
      response: () =>
        jsonResponse({ message: "secret" }, 403, { "Retry-After": "30" }),
      status: 403,
      classification: "rate-limit",
      retryAfter: "2026-09-01T00:00:30.000Z",
    },
    {
      name: "429 fallback",
      response: () => jsonResponse({ message: "secret" }, 429),
      status: 429,
      classification: "rate-limit",
      retryAfter: "2026-09-01T00:01:00.000Z",
    },
    {
      name: "503",
      response: () => jsonResponse({ message: "secret" }, 503),
      status: 503,
      classification: "retry",
      retryAfter: undefined,
    },
    {
      name: "non-rate-limit 403",
      response: () => jsonResponse({ message: "secret" }, 403),
      status: 403,
      classification: "fatal",
      retryAfter: undefined,
    },
  ])("classifies $name without exposing response bodies", async (example) => {
    const provider = createGitHubProvider({
      token: "github_pat_do-not-leak",
      fetch: queuedFetch([example.response()]),
      now: () => fixedNow,
    });

    const error = await provider
      .getUser("ada")
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubProviderError);
    expect(error).toMatchObject({ status: example.status });
    expect(classifyGitHubError(error)).toBe(example.classification);
    expect((error as Error).message).not.toContain("secret");
    expect((error as Error).message).not.toContain("do-not-leak");
    expect((error as GitHubProviderError).retryAfter?.toISOString()).toBe(
      example.retryAfter,
    );
  });

  it("turns network failures into sanitized retryable provider errors", async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      throw new Error("socket failed with github_pat_do-not-leak");
    });
    const provider = createGitHubProvider({
      token: "github_pat_do-not-leak",
      fetch,
    });

    const error = await provider
      .getUser("ada")
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      name: "GitHubProviderError",
      message: "GitHub request failed",
      status: 0,
    });
    expect(classifyGitHubError(error)).toBe("retry");
    expect(JSON.stringify(error)).not.toContain("do-not-leak");
  });
});
