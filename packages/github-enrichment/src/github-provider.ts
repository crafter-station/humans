import {
  type Contribution,
  type FetchLike,
  type GitHubProvider,
  GitHubProviderError,
  type GitHubUser,
  InvalidGitHubResponseError,
  PermanentEnrichmentError,
  type Repository,
} from "./types.js";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const REPOSITORY_PAGE_SIZE = 50;
const PINNED_REPOSITORY_PAGE_SIZE = 20;
const LANGUAGE_LIMIT = 20;
const CONTRIBUTION_PAGE_SIZE = 100;
const CONTRIBUTION_REPOSITORY_LIMIT = 100;
const CONTRIBUTION_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;
const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

const repositoryFields = `
  databaseId
  owner {
    ... on User { databaseId }
    ... on Organization { databaseId }
  }
  name
  description
  isFork
  stargazerCount
  forkCount
  pushedAt
  visibility
  languages(first: ${LANGUAGE_LIMIT}, orderBy: { field: SIZE, direction: DESC }) {
    edges {
      size
      node { name }
    }
  }
`;

const pinnedRepositoriesQuery = `
  query PinnedRepositories($login: String!, $cursor: String) {
    user(login: $login) {
      pinnedItems(
        first: ${PINNED_REPOSITORY_PAGE_SIZE}
        after: $cursor
        types: [REPOSITORY]
      ) {
        nodes {
          ... on Repository {
            ${repositoryFields}
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const recentlyActiveRepositoriesQuery = `
  query RecentlyActiveRepositories($login: String!, $cursor: String) {
    user(login: $login) {
      repositories(
        first: ${REPOSITORY_PAGE_SIZE}
        after: $cursor
        ownerAffiliations: [OWNER]
        privacy: PUBLIC
        orderBy: { field: PUSHED_AT, direction: DESC }
      ) {
        nodes {
          ${repositoryFields}
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const contributionsQuery = `
  query Contributions(
    $login: String!
    $from: DateTime!
    $to: DateTime!
    $issueCursor: String
    $pullRequestCursor: String
    $reviewCursor: String
    $includeCommits: Boolean!
    $includeIssues: Boolean!
    $includePullRequests: Boolean!
    $includeReviews: Boolean!
  ) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        commitContributionsByRepository(maxRepositories: ${CONTRIBUTION_REPOSITORY_LIMIT})
          @include(if: $includeCommits) {
          repository { databaseId visibility }
          contributions(
            first: 1
            orderBy: { field: OCCURRED_AT, direction: DESC }
          ) {
            nodes { occurredAt isRestricted commitCount }
          }
        }
        issueContributions(
          first: ${CONTRIBUTION_PAGE_SIZE}
          after: $issueCursor
          orderBy: { direction: DESC }
        ) @include(if: $includeIssues) {
          nodes {
            occurredAt
            isRestricted
            issue { repository { databaseId visibility } }
          }
          pageInfo { hasNextPage endCursor }
        }
        pullRequestContributions(
          first: ${CONTRIBUTION_PAGE_SIZE}
          after: $pullRequestCursor
          orderBy: { direction: DESC }
        ) @include(if: $includePullRequests) {
          nodes {
            occurredAt
            isRestricted
            pullRequest { repository { databaseId visibility } }
          }
          pageInfo { hasNextPage endCursor }
        }
        pullRequestReviewContributions(
          first: ${CONTRIBUTION_PAGE_SIZE}
          after: $reviewCursor
          orderBy: { direction: DESC }
        ) @include(if: $includeReviews) {
          nodes {
            occurredAt
            isRestricted
            repository { databaseId visibility }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

type PageInfo = { hasNextPage: boolean; endCursor: string | null };

type ContributionCursor = {
  version: 1;
  login: string;
  from: string;
  to: string;
  issueCursor: string | null;
  pullRequestCursor: string | null;
  reviewCursor: string | null;
  issuesDone: boolean;
  pullRequestsDone: boolean;
  reviewsDone: boolean;
};

export type GitHubProviderOptions = {
  /** A server-side credential reserved for GitHub enrichment. */
  token: string;
  fetch?: FetchLike;
  now?: () => Date;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (field: string): never => {
  throw new InvalidGitHubResponseError(
    `Invalid GitHub response field: ${field}`,
  );
};

const record = (value: unknown, field: string): Record<string, unknown> =>
  isRecord(value) ? value : invalid(field);

const array = (value: unknown, field: string): unknown[] =>
  Array.isArray(value) ? value : invalid(field);

const string = (value: unknown, field: string): string =>
  typeof value === "string" && value.length > 0 ? value : invalid(field);

const nullableString = (value: unknown, field: string): string | null =>
  value === null || typeof value === "string" ? value : invalid(field);

const integer = (value: unknown, field: string, allowZero = false): number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= (allowZero ? 0 : 1)
    ? value
    : invalid(field);

const dateTime = (value: unknown, field: string): string => {
  const result = string(value, field);
  return Number.isNaN(Date.parse(result)) ? invalid(field) : result;
};

const containsControlCharacter = (value: string) => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
};

const parseJson = async (response: Response) => {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new InvalidGitHubResponseError();
  }
};

const retryAfterFromHeaders = (
  headers: Headers,
  now: Date,
  fallback: boolean,
) => {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) {
      const retryAt = now.getTime() + Number(retryAfter) * 1000;
      if (Number.isSafeInteger(retryAt)) return new Date(retryAt);
    }
    const retryAt = Date.parse(retryAfter);
    if (!Number.isNaN(retryAt))
      return new Date(Math.max(now.getTime(), retryAt));
  }

  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = headers.get("x-ratelimit-reset")?.trim();
    if (reset && /^\d+$/.test(reset)) {
      const retryAt = Number(reset) * 1000;
      if (Number.isSafeInteger(retryAt))
        return new Date(Math.max(now.getTime(), retryAt));
    }
  }

  if (fallback) return new Date(now.getTime() + DEFAULT_RATE_LIMIT_DELAY_MS);
  return undefined;
};

const assertLogin = (login: string) => {
  if (
    login.length === 0 ||
    login.length > 100 ||
    login.trim() !== login ||
    containsControlCharacter(login)
  )
    throw new PermanentEnrichmentError("Invalid GitHub login");
};

const assertCursor = (cursor: string | undefined) => {
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 32_768))
    throw new PermanentEnrichmentError("Invalid GitHub pagination cursor");
};

const parseGitHubUser = (payload: unknown): GitHubUser => {
  const user = record(payload, "user");
  if (typeof user.type !== "string") invalid("user.type");
  if (user.type !== "User")
    throw new PermanentEnrichmentError(
      "GitHub account is not a personal User account",
    );
  return {
    id: integer(user.id, "user.id"),
    login: string(user.login, "user.login"),
    name: nullableString(user.name, "user.name"),
    bio: nullableString(user.bio, "user.bio"),
    company: nullableString(user.company, "user.company"),
    location: nullableString(user.location, "user.location"),
    blog: nullableString(user.blog, "user.blog"),
    type: "User",
  };
};

const parseLanguages = (value: unknown) => {
  const connection = record(value, "repository.languages");
  const edges = array(connection.edges, "repository.languages.edges");
  const entries: Array<[string, number]> = [];
  const seen = new Set<string>();
  for (const value of edges) {
    const edge = record(value, "repository.languages.edge");
    const node = record(edge.node, "repository.languages.edge.node");
    const name = string(node.name, "repository.languages.edge.node.name");
    if (seen.has(name)) invalid("repository.languages.edge.node.name");
    seen.add(name);
    entries.push([
      name,
      integer(edge.size, "repository.languages.edge.size", true),
    ]);
  }
  return Object.fromEntries(entries);
};

const parseRepository = (
  value: unknown,
  pinned: boolean,
): Repository | undefined => {
  const repository = record(value, "repository");
  const visibility = string(repository.visibility, "repository.visibility");
  if (!["PUBLIC", "PRIVATE", "INTERNAL"].includes(visibility))
    invalid("repository.visibility");
  if (visibility !== "PUBLIC") return undefined;

  const owner = record(repository.owner, "repository.owner");
  if (
    repository.databaseId === null ||
    owner.databaseId === null ||
    repository.pushedAt === null
  )
    return undefined;
  const result: Repository = {
    id: integer(repository.databaseId, "repository.databaseId"),
    ownerId: integer(owner.databaseId, "repository.owner.databaseId"),
    name: string(repository.name, "repository.name"),
    description: nullableString(
      repository.description,
      "repository.description",
    ),
    fork:
      typeof repository.isFork === "boolean"
        ? repository.isFork
        : invalid("repository.isFork"),
    stargazersCount: integer(
      repository.stargazerCount,
      "repository.stargazerCount",
      true,
    ),
    forksCount: integer(repository.forkCount, "repository.forkCount", true),
    pushedAt: dateTime(repository.pushedAt, "repository.pushedAt"),
    languages: parseLanguages(repository.languages),
    pinned,
  };
  return result;
};

const parsePageInfo = (value: unknown, field: string): PageInfo => {
  const pageInfo = record(value, field);
  const hasNextPage =
    typeof pageInfo.hasNextPage === "boolean"
      ? pageInfo.hasNextPage
      : invalid(`${field}.hasNextPage`);
  const endCursor =
    pageInfo.endCursor === null || typeof pageInfo.endCursor === "string"
      ? pageInfo.endCursor
      : invalid(`${field}.endCursor`);
  if (hasNextPage && !endCursor) invalid(`${field}.endCursor`);
  return { hasNextPage, endCursor };
};

const parseRepositoryPage = (
  data: unknown,
  connectionName: "pinnedItems" | "repositories",
  pinned: boolean,
) => {
  const root = record(data, "data");
  if (root.user === null)
    throw new GitHubProviderError("GitHub account is inaccessible", 404);
  const user = record(root.user, "data.user");
  const connection = record(
    user[connectionName],
    `data.user.${connectionName}`,
  );
  const nodes = array(connection.nodes, `data.user.${connectionName}.nodes`);
  const repositories = nodes.flatMap((node) => {
    const repository = parseRepository(node, pinned);
    return repository ? [repository] : [];
  });
  const pageInfo = parsePageInfo(
    connection.pageInfo,
    `data.user.${connectionName}.pageInfo`,
  );
  return {
    repositories,
    ...(pageInfo.hasNextPage
      ? { nextCursor: pageInfo.endCursor ?? invalid("pageInfo.endCursor") }
      : {}),
  };
};

const parseGraphQLErrors = (payload: Record<string, unknown>) => {
  if (payload.errors === undefined) return undefined;
  const errors = array(payload.errors, "errors");
  if (errors.length === 0) invalid("errors");
  return errors.map((value) => {
    const error = record(value, "errors.entry");
    string(error.message, "errors.entry.message");
    if (error.type !== undefined && typeof error.type !== "string")
      invalid("errors.entry.type");
    return error.type;
  });
};

const parsePublicRepositoryId = (value: unknown, field: string) => {
  const repository = record(value, field);
  const visibility = string(repository.visibility, `${field}.visibility`);
  if (!["PUBLIC", "PRIVATE", "INTERNAL"].includes(visibility))
    invalid(`${field}.visibility`);
  if (visibility !== "PUBLIC" || repository.databaseId === null)
    return undefined;
  return integer(repository.databaseId, `${field}.databaseId`);
};

const parseContributionNode = (
  value: unknown,
  kind: Contribution["kind"],
  repositoryAt: (node: Record<string, unknown>) => unknown,
  from: number,
  to: number,
) => {
  const node = record(value, `contributions.${kind}.node`);
  if (typeof node.isRestricted !== "boolean")
    invalid(`contributions.${kind}.node.isRestricted`);
  const occurredAt = dateTime(
    node.occurredAt,
    `contributions.${kind}.node.occurredAt`,
  );
  const occurredAtMs = Date.parse(occurredAt);
  if (occurredAtMs < from || occurredAtMs > to)
    invalid(`contributions.${kind}.node.occurredAt`);
  const repositoryId = parsePublicRepositoryId(
    repositoryAt(node),
    `contributions.${kind}.node.repository`,
  );
  if (node.isRestricted || repositoryId === undefined) return undefined;
  return { repositoryId, occurredAt, kind } satisfies Contribution;
};

const parseContributionConnection = (
  value: unknown,
  kind: Exclude<Contribution["kind"], "commit">,
  repositoryAt: (node: Record<string, unknown>) => unknown,
  from: number,
  to: number,
) => {
  const connection = record(value, `contributions.${kind}`);
  const nodes = array(connection.nodes, `contributions.${kind}.nodes`);
  const contributions = nodes.flatMap((node) => {
    const contribution = parseContributionNode(
      node,
      kind,
      repositoryAt,
      from,
      to,
    );
    return contribution ? [contribution] : [];
  });
  return {
    contributions,
    pageInfo: parsePageInfo(
      connection.pageInfo,
      `contributions.${kind}.pageInfo`,
    ),
  };
};

const parseCommitContributions = (value: unknown, from: number, to: number) => {
  const groups = array(value, "contributions.commit");
  return groups.flatMap((item) => {
    const group = record(item, "contributions.commit.group");
    const repositoryId = parsePublicRepositoryId(
      group.repository,
      "contributions.commit.group.repository",
    );
    const connection = record(
      group.contributions,
      "contributions.commit.group.contributions",
    );
    const nodes = array(
      connection.nodes,
      "contributions.commit.group.contributions.nodes",
    );
    return nodes.flatMap((value) => {
      const node = record(value, "contributions.commit.node");
      if (typeof node.isRestricted !== "boolean")
        invalid("contributions.commit.node.isRestricted");
      integer(node.commitCount, "contributions.commit.node.commitCount");
      const occurredAt = dateTime(
        node.occurredAt,
        "contributions.commit.node.occurredAt",
      );
      const occurredAtMs = Date.parse(occurredAt);
      if (occurredAtMs < from || occurredAtMs > to)
        invalid("contributions.commit.node.occurredAt");
      if (node.isRestricted || repositoryId === undefined) return [];
      return [
        { repositoryId, occurredAt, kind: "commit" } satisfies Contribution,
      ];
    });
  });
};

const parseContributionCursor = (
  cursor: string,
  login: string,
  from: string,
): ContributionCursor => {
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    throw new PermanentEnrichmentError("Invalid GitHub pagination cursor");
  }
  if (!isRecord(value))
    throw new PermanentEnrichmentError("Invalid GitHub pagination cursor");
  const keys = [
    "version",
    "login",
    "from",
    "to",
    "issueCursor",
    "pullRequestCursor",
    "reviewCursor",
    "issuesDone",
    "pullRequestsDone",
    "reviewsDone",
  ];
  const cursorValues = [
    value.issueCursor,
    value.pullRequestCursor,
    value.reviewCursor,
  ];
  const to = typeof value.to === "string" ? Date.parse(value.to) : Number.NaN;
  const fromTime = Date.parse(from);
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value)) ||
    value.version !== 1 ||
    value.login !== login ||
    value.from !== from ||
    Number.isNaN(to) ||
    to < fromTime ||
    to - fromTime > CONTRIBUTION_WINDOW_MS ||
    (value.issueCursor !== null && typeof value.issueCursor !== "string") ||
    (value.pullRequestCursor !== null &&
      typeof value.pullRequestCursor !== "string") ||
    (value.reviewCursor !== null && typeof value.reviewCursor !== "string") ||
    typeof value.issuesDone !== "boolean" ||
    typeof value.pullRequestsDone !== "boolean" ||
    typeof value.reviewsDone !== "boolean" ||
    cursorValues.some(
      (item) =>
        typeof item === "string" && (item.length === 0 || item.length > 4_096),
    ) ||
    value.issuesDone !== (value.issueCursor === null) ||
    value.pullRequestsDone !== (value.pullRequestCursor === null) ||
    value.reviewsDone !== (value.reviewCursor === null)
  )
    throw new PermanentEnrichmentError("Invalid GitHub pagination cursor");
  return value as ContributionCursor;
};

/** Creates a GitHub adapter that uses only its explicitly supplied credential. */
export const createGitHubProvider = (
  options: GitHubProviderOptions,
): GitHubProvider => {
  if (!options.token.trim())
    throw new PermanentEnrichmentError("GitHub token is required");
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${options.token}`,
    "User-Agent": "humans-github-enrichment",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };

  const request = async (url: string, init?: RequestInit) => {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GitHubProviderError("GitHub request failed", 0);
    }
    if (!response.ok) {
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.has("retry-after") ||
            response.headers.get("x-ratelimit-remaining") === "0"));
      const retryAfter = retryAfterFromHeaders(
        response.headers,
        now(),
        rateLimited,
      );
      throw new GitHubProviderError(
        `GitHub request failed with status ${response.status}`,
        response.status,
        retryAfter,
      );
    }
    return response;
  };

  const graphQL = async (
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
  ) => {
    const response = await request(`${GITHUB_API_URL}/graphql`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ operationName, query, variables }),
    });
    const payload = record(await parseJson(response), "response");
    const errors = parseGraphQLErrors(payload);
    if (errors) {
      const rateLimited =
        errors.includes("RATE_LIMITED") ||
        response.headers.get("x-ratelimit-remaining") === "0";
      const status = rateLimited
        ? 429
        : errors.includes("NOT_FOUND")
          ? 404
          : errors.includes("FORBIDDEN")
            ? 403
            : 502;
      throw new GitHubProviderError(
        "GitHub GraphQL request failed",
        status,
        retryAfterFromHeaders(response.headers, now(), rateLimited),
      );
    }
    if (!("data" in payload)) invalid("data");
    return payload.data;
  };

  return {
    async getUser(login) {
      assertLogin(login);
      const response = await request(
        `${GITHUB_API_URL}/users/${encodeURIComponent(login)}`,
        { headers },
      );
      return parseGitHubUser(await parseJson(response));
    },

    async getPinnedRepositories(login, cursor) {
      assertLogin(login);
      assertCursor(cursor);
      const data = await graphQL(
        "PinnedRepositories",
        pinnedRepositoriesQuery,
        { login, cursor: cursor ?? null },
      );
      return parseRepositoryPage(data, "pinnedItems", true);
    },

    async getRecentlyActiveRepositories(login, cursor) {
      assertLogin(login);
      assertCursor(cursor);
      const data = await graphQL(
        "RecentlyActiveRepositories",
        recentlyActiveRepositoriesQuery,
        { login, cursor: cursor ?? null },
      );
      return parseRepositoryPage(data, "repositories", false);
    },

    async getContributions(login, since, cursor) {
      assertLogin(login);
      assertCursor(cursor);
      const fromDate = new Date(since);
      const nowDate = now();
      if (
        Number.isNaN(fromDate.getTime()) ||
        Number.isNaN(nowDate.getTime()) ||
        fromDate.getTime() > nowDate.getTime()
      )
        throw new PermanentEnrichmentError(
          "Invalid GitHub contribution window",
        );
      const from = fromDate.toISOString();
      const state = cursor
        ? parseContributionCursor(cursor, login, from)
        : ({
            version: 1,
            login,
            from,
            to: new Date(
              Math.min(
                nowDate.getTime(),
                fromDate.getTime() + CONTRIBUTION_WINDOW_MS,
              ),
            ).toISOString(),
            issueCursor: null,
            pullRequestCursor: null,
            reviewCursor: null,
            issuesDone: false,
            pullRequestsDone: false,
            reviewsDone: false,
          } satisfies ContributionCursor);
      const includeCommits = cursor === undefined;
      const data = record(
        await graphQL("Contributions", contributionsQuery, {
          login,
          from: state.from,
          to: state.to,
          issueCursor: state.issueCursor,
          pullRequestCursor: state.pullRequestCursor,
          reviewCursor: state.reviewCursor,
          includeCommits,
          includeIssues: !state.issuesDone,
          includePullRequests: !state.pullRequestsDone,
          includeReviews: !state.reviewsDone,
        }),
        "data",
      );
      if (data.user === null)
        throw new GitHubProviderError("GitHub account is inaccessible", 404);
      const user = record(data.user, "data.user");
      const collection = record(
        user.contributionsCollection,
        "data.user.contributionsCollection",
      );
      const fromMs = Date.parse(state.from);
      const toMs = Date.parse(state.to);
      const contributions: Contribution[] = includeCommits
        ? parseCommitContributions(
            collection.commitContributionsByRepository,
            fromMs,
            toMs,
          )
        : [];

      const issuePage = state.issuesDone
        ? undefined
        : parseContributionConnection(
            collection.issueContributions,
            "issue",
            (node) =>
              record(node.issue, "contributions.issue.node.issue").repository,
            fromMs,
            toMs,
          );
      if (issuePage) contributions.push(...issuePage.contributions);

      const pullRequestPage = state.pullRequestsDone
        ? undefined
        : parseContributionConnection(
            collection.pullRequestContributions,
            "pull-request",
            (node) =>
              record(
                node.pullRequest,
                "contributions.pull-request.node.pullRequest",
              ).repository,
            fromMs,
            toMs,
          );
      if (pullRequestPage) contributions.push(...pullRequestPage.contributions);

      const reviewPage = state.reviewsDone
        ? undefined
        : parseContributionConnection(
            collection.pullRequestReviewContributions,
            "review",
            (node) => node.repository,
            fromMs,
            toMs,
          );
      if (reviewPage) contributions.push(...reviewPage.contributions);

      const nextState: ContributionCursor = {
        ...state,
        issueCursor: issuePage?.pageInfo.hasNextPage
          ? issuePage.pageInfo.endCursor
          : null,
        pullRequestCursor: pullRequestPage?.pageInfo.hasNextPage
          ? pullRequestPage.pageInfo.endCursor
          : null,
        reviewCursor: reviewPage?.pageInfo.hasNextPage
          ? reviewPage.pageInfo.endCursor
          : null,
        issuesDone: state.issuesDone || !issuePage?.pageInfo.hasNextPage,
        pullRequestsDone:
          state.pullRequestsDone || !pullRequestPage?.pageInfo.hasNextPage,
        reviewsDone: state.reviewsDone || !reviewPage?.pageInfo.hasNextPage,
      };
      const done =
        nextState.issuesDone &&
        nextState.pullRequestsDone &&
        nextState.reviewsDone;
      return {
        contributions,
        ...(done ? {} : { nextCursor: JSON.stringify(nextState) }),
      };
    },
  };
};
