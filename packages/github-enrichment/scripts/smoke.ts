import {
  createGitHubProvider,
  createOpenAIEvidenceNormalizer,
  type GitHubEvidence,
} from "../src/index.js";

if (process.env.RUN_LIVE_PROVIDER_SMOKE !== "1")
  throw new Error("Set RUN_LIVE_PROVIDER_SMOKE=1 to run a live provider smoke");

const mode = process.argv[2];
let requestCount = 0;
const boundedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  requestCount += 1;
  if (requestCount > 1) throw new Error("Provider smoke request cap exceeded");
  return fetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
};
const syntheticEvidence: GitHubEvidence = {
  user: {
    id: 1,
    login: "fixture-builder",
    name: null,
    bio: null,
    company: null,
    location: null,
    blog: null,
    type: "User",
  },
  repositories: [
    {
      id: 1,
      ownerId: 1,
      name: "typed-api",
      description: "A TypeScript API with integration tests",
      fork: false,
      stargazersCount: 0,
      forksCount: 0,
      pushedAt: "2026-08-01T00:00:00.000Z",
      languages: { TypeScript: 100 },
      pinned: true,
    },
  ],
  contributions: [],
};

if (mode === "github") {
  const token = required("GITHUB_ENRICHMENT_TOKEN");
  const login = required("GITHUB_SMOKE_LOGIN");
  const user = await createGitHubProvider({ token, fetch: boundedFetch }).getUser(
    login,
  );
  console.log(
    JSON.stringify({
      provider: "github",
      requestCount,
      contractValidated: user.type === "User" && Number.isSafeInteger(user.id),
    }),
  );
} else if (mode === "openai") {
  const normalizer = createOpenAIEvidenceNormalizer({
    apiKey: required("OPENAI_API_KEY"),
    model: required("OPENAI_MODEL"),
    fetch: boundedFetch,
  });
  const normalized = await normalizer.normalize(syntheticEvidence);
  console.log(
    JSON.stringify({
      provider: "openai",
      requestCount,
      contractValidated:
        Array.isArray(normalized.roles) &&
        Array.isArray(normalized.skills) &&
        Array.isArray(normalized.evidenceRepositoryIds),
      roleCount: normalized.roles.length,
      skillCount: normalized.skills.length,
      citationCount: normalized.evidenceRepositoryIds.length,
    }),
  );
} else {
  throw new Error("Choose the github or openai smoke command");
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
