import { beforeEach, describe, expect, it, vi } from "vitest";

import repositoryPages from "./fixtures/repository-pages.json" with { type: "json" };

import {
  GitHubProviderError,
  PIPELINE_VERSION,
  PROVIDER_SNAPSHOT_RETENTION_DAYS,
  createGitHubEnrichmentStages,
  createGitHubEnrichmentWorkflow,
  isSuppressionEligible,
  retryOptionsForGitHubError,
  type EnrichmentRun,
  type EnrichmentStore,
  type GitHubProvider,
  type Observation,
  type Stage,
} from "../src/index.js";

const user = {
  id: 42,
  login: "ada",
  name: "Ada",
  bio: null,
  company: null,
  location: "Lima",
  blog: null,
  type: "User" as const,
};
const repository = (id: number) => ({
  id,
  ownerId: user.id,
  name: `repo-${id}`,
  description: null,
  fork: false,
  stargazersCount: id,
  forksCount: 1,
  pushedAt: "2026-08-01T00:00:00.000Z",
  languages: { TypeScript: 100 },
  pinned: false,
});

class MemoryStore implements EnrichmentStore {
  run?: EnrichmentRun;
  checkpoints = new Map<string, unknown>();
  checkpointExpirations = new Map<string, string>();
  observations: Observation[] = [];
  immutableId?: number;
  inaccessibleSince?: string;
  observationsStaleAt?: string;
  failPersistenceOnce = false;

  async getRun(runId: string) {
    return this.run?.id === runId ? structuredClone(this.run) : undefined;
  }
  async getOrCreateRun(profileId: string, runId: string, startedAt: string) {
    return (
      this.run ?? {
        id: runId,
        profileId,
        status: "pending" as const,
        completedStages: [],
        currentStage: null,
        startedAt,
      }
    );
  }
  async saveRun(run: EnrichmentRun) {
    this.run = structuredClone(run);
  }
  async loadCheckpoint<T>(runId: string, stage: Stage) {
    return this.checkpoints.get(`${runId}:${stage}`) as T | undefined;
  }
  async saveCheckpoint<T>(
    runId: string,
    stage: Stage,
    value: T,
    options?: { expiresAt?: string },
  ) {
    this.checkpoints.set(`${runId}:${stage}`, structuredClone(value));
    if (options?.expiresAt)
      this.checkpointExpirations.set(`${runId}:${stage}`, options.expiresAt);
  }
  async getImmutableGitHubUserId() {
    return this.immutableId;
  }
  async saveObservations(observations: Observation[]) {
    if (this.failPersistenceOnce) {
      this.failPersistenceOnce = false;
      throw new Error("database unavailable");
    }
    this.observations = observations;
    this.immutableId = (
      observations.find(({ kind }) => kind === "github-account")
        ?.value as typeof user
    ).id;
  }
  async markGitHubObservationsStale(_profileId: string, at: string) {
    this.observationsStaleAt = at;
  }
  async markGitHubInaccessibleIfUnset(_profileId: string, at: string) {
    this.inaccessibleSince ??= at;
    return this.inaccessibleSince;
  }
  async clearGitHubInaccessible() {
    this.inaccessibleSince = undefined;
  }
}

const makeProvider = (): GitHubProvider => ({
  getUser: vi.fn(async () => user),
  getPinnedRepositories: vi.fn(async () => [
    { ...repository(1), pinned: true },
  ]),
  getRecentlyActiveRepositories: vi.fn(async (_login, cursor) =>
    cursor
      ? { repositories: [repository(3)] }
      : { repositories: [repository(1), repository(2)], nextCursor: "page-2" },
  ),
  getContributions: vi.fn(async (_login, _since, cursor) =>
    cursor
      ? {
          contributions: [
            {
              repositoryId: 2,
              occurredAt: "2026-08-01T00:00:00.000Z",
              kind: "review" as const,
            },
          ],
        }
      : {
          contributions: [
            {
              repositoryId: 1,
              occurredAt: "2026-07-01T00:00:00.000Z",
              kind: "commit" as const,
            },
          ],
          nextCursor: "page-2",
        },
  ),
});

const normalizer = {
  normalize: vi.fn(async () => ({
    roles: ["Engineer"],
    skills: ["TypeScript"],
    summary: "Builds typed software.",
    evidenceRepositoryIds: [1],
  })),
};
const fixedNow = () => new Date("2026-09-01T00:00:00.000Z");

describe("GitHub enrichment workflow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("paginates evidence, preserves provenance, and exposes progress", async () => {
    const store = new MemoryStore();
    const provider = makeProvider();
    const run = await createGitHubEnrichmentWorkflow({
      provider,
      normalizer,
      store,
      now: fixedNow,
    })({ profileId: "profile-1", githubLogin: "ada", runId: "run-1" });

    expect(run).toMatchObject({
      status: "succeeded",
      completedStages: [
        "account",
        "repositories",
        "normalization",
        "persistence",
      ],
    });
    expect(provider.getRecentlyActiveRepositories).toHaveBeenCalledTimes(2);
    expect(provider.getContributions).toHaveBeenCalledTimes(2);
    expect(
      store.observations.filter(({ kind }) => kind === "github-repository"),
    ).toHaveLength(3);
    expect(
      store.observations.find(
        ({ kind, value }) =>
          kind === "github-repository" &&
          (value as ReturnType<typeof repository>).id === 1,
      )?.value,
    ).toMatchObject({ pinned: true });
    expect(store.checkpointExpirations.get("run-1:account")).toBe(
      new Date(
        fixedNow().getTime() +
          PROVIDER_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString(),
    );
    expect(store.checkpointExpirations.has("run-1:normalization")).toBe(false);
    expect(store.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "github",
          collectedAt: "2026-09-01T00:00:00.000Z",
          confidence: 1,
          pipelineVersion: PIPELINE_VERSION,
        }),
      ]),
    );
  });

  it("reuses expensive checkpoints after a late persistence failure", async () => {
    const store = new MemoryStore();
    store.failPersistenceOnce = true;
    const provider = makeProvider();
    const workflow = createGitHubEnrichmentWorkflow({
      provider,
      normalizer,
      store,
      now: fixedNow,
    });
    const input = {
      profileId: "profile-1",
      githubLogin: "ada",
      runId: "run-retry",
    };

    await expect(workflow(input)).rejects.toThrow("database unavailable");
    await expect(workflow(input)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(provider.getUser).toHaveBeenCalledTimes(1);
    expect(provider.getPinnedRepositories).toHaveBeenCalledTimes(1);
    expect(normalizer.normalize).toHaveBeenCalledTimes(1);
  });

  it("rejects immutable identity changes and unsupported AI evidence", async () => {
    const identityStore = new MemoryStore();
    identityStore.immutableId = 99;
    await expect(
      createGitHubEnrichmentWorkflow({
        provider: makeProvider(),
        normalizer,
        store: identityStore,
        now: fixedNow,
      })({ profileId: "profile-1", githubLogin: "ada", runId: "identity" }),
    ).rejects.toThrow("immutable user ID");

    const unsupportedNormalizer = {
      normalize: vi.fn(async () => ({
        roles: [],
        skills: ["Rust"],
        summary: "Unsupported",
        evidenceRepositoryIds: [999],
      })),
    };
    await expect(
      createGitHubEnrichmentWorkflow({
        provider: makeProvider(),
        normalizer: unsupportedNormalizer,
        store: new MemoryStore(),
        now: fixedNow,
      })({ profileId: "profile-1", githubLogin: "ada", runId: "ai" }),
    ).rejects.toThrow("unsupported repository evidence");
  });

  it("marks inaccessible Profiles stale and applies the 30-day grace period", async () => {
    const store = new MemoryStore();
    const provider = makeProvider();
    provider.getUser = vi.fn(async () => {
      throw new GitHubProviderError("not found", 404);
    });
    await expect(
      createGitHubEnrichmentWorkflow({
        provider,
        normalizer,
        store,
        now: fixedNow,
      })({ profileId: "profile-1", githubLogin: "gone", runId: "stale" }),
    ).rejects.toThrow("not found");
    expect(store.run?.status).toBe("stale");
    expect(store.observationsStaleAt).toBe("2026-09-01T00:00:00.000Z");
    expect(
      isSuppressionEligible(
        store.inaccessibleSince!,
        new Date("2026-09-30T23:59:59.999Z"),
      ),
    ).toBe(false);
    expect(
      isSuppressionEligible(
        store.inaccessibleSince!,
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("classifies rate limits without discarding completed checkpoints", async () => {
    const store = new MemoryStore();
    const provider = makeProvider();
    provider.getPinnedRepositories = vi.fn(async () => {
      throw new GitHubProviderError(
        "rate limited",
        403,
        new Date("2026-09-01T00:01:00.000Z"),
      );
    });
    await expect(
      createGitHubEnrichmentWorkflow({
        provider,
        normalizer,
        store,
        now: fixedNow,
      })({ profileId: "profile-1", githubLogin: "ada", runId: "limited" }),
    ).rejects.toThrow("rate limited");
    expect(store.run).toMatchObject({
      status: "running",
      currentStage: "repositories",
      completedStages: ["account"],
    });
    expect(store.run?.finishedAt).toBeUndefined();
    expect(store.observationsStaleAt).toBe("2026-09-01T00:00:00.000Z");
    expect(store.checkpoints.has("limited:account")).toBe(true);
    expect(
      retryOptionsForGitHubError(
        new GitHubProviderError(
          "rate limited",
          403,
          new Date("2026-09-01T00:01:00.000Z"),
        ),
      ),
    ).toEqual({ retryAt: new Date("2026-09-01T00:01:00.000Z") });
    expect(
      retryOptionsForGitHubError(new GitHubProviderError("gone", 404)),
    ).toEqual({ skipRetrying: true });
    expect(
      retryOptionsForGitHubError(new GitHubProviderError("bad", 422)),
    ).toEqual({ skipRetrying: true });
    expect(
      retryOptionsForGitHubError(new GitHubProviderError("busy", 503)),
    ).toBeUndefined();
    expect(
      retryOptionsForGitHubError(
        new GitHubProviderError(
          "slow down",
          429,
          new Date("2026-09-01T00:02:00.000Z"),
        ),
      ),
    ).toEqual({ retryAt: new Date("2026-09-01T00:02:00.000Z") });
  });

  it("runs stages independently and preserves the first inaccessible time", async () => {
    const store = new MemoryStore();
    const provider = makeProvider();
    const stages = createGitHubEnrichmentStages({
      provider,
      normalizer,
      store,
      now: fixedNow,
    });
    const input = {
      profileId: "profile-1",
      githubLogin: "ada",
      runId: "independent",
    };

    await stages.account(input);
    expect(await store.getRun(input.runId)).toMatchObject({
      status: "running",
      completedStages: ["account"],
    });
    await stages.repositories(input);
    await stages.normalization(input);
    await expect(stages.persistence(input)).resolves.toMatchObject({
      status: "succeeded",
    });

    await store.markGitHubInaccessibleIfUnset(
      input.profileId,
      "2026-08-01T00:00:00.000Z",
    );
    await store.markGitHubInaccessibleIfUnset(
      input.profileId,
      "2026-09-01T00:00:00.000Z",
    );
    expect(store.inaccessibleSince).toBe("2026-08-01T00:00:00.000Z");
  });

  it("retries a partial pagination failure without repeating completed stages", async () => {
    const store = new MemoryStore();
    const provider = makeProvider();
    let secondPageAttempts = 0;
    provider.getRecentlyActiveRepositories = vi.fn(async (_login, cursor) => {
      const page = cursor ? repositoryPages.second : repositoryPages.first;
      if (cursor && secondPageAttempts++ === 0)
        throw new GitHubProviderError("temporary outage", 503);
      return {
        repositories: page.repositories.map(repository),
        ...(cursor ? {} : { nextCursor: repositoryPages.first.nextCursor }),
      };
    });
    const workflow = createGitHubEnrichmentWorkflow({
      provider,
      normalizer,
      store,
      now: fixedNow,
    });
    const input = {
      profileId: "profile-1",
      githubLogin: "ada",
      runId: "partial-page",
    };

    await expect(workflow(input)).rejects.toThrow("temporary outage");
    expect(store.run).toMatchObject({
      status: "running",
      currentStage: "repositories",
      completedStages: ["account"],
    });
    await expect(workflow(input)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(provider.getUser).toHaveBeenCalledTimes(1);
    expect(provider.getRecentlyActiveRepositories).toHaveBeenCalledTimes(4);
  });
});
