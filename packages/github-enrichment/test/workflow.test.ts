import { beforeEach, describe, expect, it, vi } from "vitest";

import repositoryPages from "./fixtures/repository-pages.json" with {
  type: "json",
};

import {
  GitHubCheckpointError,
  GitHubProviderError,
  OpenAIProviderError,
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
  failPersistenceCheckpointOnce = false;
  normalizationCheckpointFailures = 0;
  persistedRunIds = new Set<string>();
  persistCalls = 0;

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
    if (stage === "normalization" && this.normalizationCheckpointFailures-- > 0)
      throw new Error("checkpoint unavailable");
    if (stage === "persistence" && this.failPersistenceCheckpointOnce) {
      this.failPersistenceCheckpointOnce = false;
      throw new Error("checkpoint unavailable");
    }
    this.checkpoints.set(`${runId}:${stage}`, structuredClone(value));
    if (options?.expiresAt)
      this.checkpointExpirations.set(`${runId}:${stage}`, options.expiresAt);
  }
  async getImmutableGitHubUserId() {
    return this.immutableId;
  }
  async persistObservations(runId: string, observations: Observation[]) {
    this.persistCalls += 1;
    if (this.failPersistenceOnce) {
      this.failPersistenceOnce = false;
      throw new Error("database unavailable");
    }
    if (this.persistedRunIds.has(runId)) return;
    this.persistedRunIds.add(runId);
    this.observations = observations;
    const account = observations.find(({ kind }) => kind === "github-account")
      ?.value as typeof user | undefined;
    if (account === undefined) throw new Error("GitHub account is required");
    this.immutableId = account.id;
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
  getPinnedRepositories: vi.fn(async (_login, cursor) =>
    cursor
      ? { repositories: [{ ...repository(4), pinned: true }] }
      : {
          repositories: [{ ...repository(1), pinned: true }],
          nextCursor: "pinned-page-2",
        },
  ),
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
    expect(provider.getPinnedRepositories).toHaveBeenCalledTimes(2);
    expect(
      store.observations.filter(({ kind }) => kind === "github-repository"),
    ).toHaveLength(4);
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
    let currentTime = fixedNow();
    const workflow = createGitHubEnrichmentWorkflow({
      provider,
      normalizer,
      store,
      now: () => currentTime,
    });
    const input = {
      profileId: "profile-1",
      githubLogin: "ada",
      runId: "run-retry",
    };

    await expect(workflow(input)).rejects.toThrow("database unavailable");
    currentTime = new Date("2026-09-02T00:00:00.000Z");
    await expect(workflow(input)).resolves.toMatchObject({
      status: "succeeded",
      finishedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(provider.getUser).toHaveBeenCalledTimes(1);
    expect(provider.getPinnedRepositories).toHaveBeenCalledTimes(2);
    expect(normalizer.normalize).toHaveBeenCalledTimes(1);
    expect(
      store.observations.every(
        ({ collectedAt }) => collectedAt === "2026-09-01T00:00:00.000Z",
      ),
    ).toBe(true);
  });

  it("does not repeat OpenAI normalization when its first checkpoint write fails", async () => {
    const store = new MemoryStore();
    store.normalizationCheckpointFailures = 1;
    const provider = makeProvider();

    await expect(
      createGitHubEnrichmentWorkflow({
        provider,
        normalizer,
        store,
        now: fixedNow,
      })({
        profileId: "profile-1",
        githubLogin: "ada",
        runId: "normalization-checkpoint-retry",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(normalizer.normalize).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an expensive checkpoint cannot be persisted", async () => {
    const store = new MemoryStore();
    store.normalizationCheckpointFailures = 2;
    const provider = makeProvider();

    const error = await createGitHubEnrichmentWorkflow({
      provider,
      normalizer,
      store,
      now: fixedNow,
    })({
      profileId: "profile-1",
      githubLogin: "ada",
      runId: "normalization-checkpoint-failure",
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(GitHubCheckpointError);
    expect(retryOptionsForGitHubError(error)).toEqual({ skipRetrying: true });
    expect(normalizer.normalize).toHaveBeenCalledTimes(1);
    expect(store.observationsStaleAt).toBe(fixedNow().toISOString());
    expect(store.run).toMatchObject({ status: "failed", currentStage: null });
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
    const inaccessibleSince = store.inaccessibleSince;
    if (inaccessibleSince === undefined)
      throw new Error("Expected an inaccessible timestamp");
    expect(
      isSuppressionEligible(
        inaccessibleSince,
        new Date("2026-09-30T23:59:59.999Z"),
      ),
    ).toBe(false);
    expect(
      isSuppressionEligible(
        inaccessibleSince,
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
      retryOptionsForGitHubError(new Error("socket reset")),
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
    expect(
      retryOptionsForGitHubError(
        new OpenAIProviderError(
          "OpenAI rate limited",
          429,
          new Date("2026-09-01T00:03:00.000Z"),
        ),
      ),
    ).toEqual({ retryAt: new Date("2026-09-01T00:03:00.000Z") });
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

  it("keeps persistence idempotent when checkpointing fails after the write", async () => {
    const store = new MemoryStore();
    store.failPersistenceCheckpointOnce = true;
    const workflow = createGitHubEnrichmentWorkflow({
      provider: makeProvider(),
      normalizer,
      store,
      now: fixedNow,
    });
    const input = {
      profileId: "profile-1",
      githubLogin: "ada",
      runId: "atomic-persistence",
    };

    await expect(workflow(input)).rejects.toThrow("checkpoint unavailable");
    await expect(workflow(input)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(store.persistCalls).toBe(2);
    expect(store.persistedRunIds).toEqual(new Set([input.runId]));
  });

  it("makes retry exhaustion terminal and does not suppress for repository 404s", async () => {
    const store = new MemoryStore();
    store.inaccessibleSince = "2026-08-01T00:00:00.000Z";
    const provider = makeProvider();
    provider.getPinnedRepositories = vi.fn(async () => {
      throw new GitHubProviderError("repository unavailable", 404);
    });
    const stages = createGitHubEnrichmentStages({
      provider,
      normalizer,
      store,
      now: fixedNow,
    });
    const input = {
      profileId: "profile-1",
      githubLogin: "ada",
      runId: "repository-404",
    };

    await stages.account(input);
    expect(store.inaccessibleSince).toBeUndefined();
    await expect(stages.repositories(input)).rejects.toThrow(
      "repository unavailable",
    );
    expect(store.run?.status).toBe("failed");
    expect(store.inaccessibleSince).toBeUndefined();

    if (store.run === undefined) throw new Error("Expected an enrichment run");
    store.run = {
      ...store.run,
      status: "running",
      currentStage: "persistence",
    };
    store.observationsStaleAt = undefined;
    await stages.retryExhausted(input, new Error("retries exhausted"));
    expect(store.observationsStaleAt).toBe(fixedNow().toISOString());
    expect(store.run).toMatchObject({
      status: "failed",
      currentStage: null,
      error: "retries exhausted",
      finishedAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("does not reopen a succeeded run after its snapshots expire", async () => {
    const store = new MemoryStore();
    let currentTime = fixedNow();
    const provider = makeProvider();
    const workflow = createGitHubEnrichmentWorkflow({
      provider,
      normalizer,
      store,
      now: () => currentTime,
    });
    const input = {
      profileId: "profile-1",
      githubLogin: "ada",
      runId: "already-complete",
    };

    const completed = await workflow(input);
    store.checkpoints.clear();
    currentTime = new Date("2026-11-01T00:00:00.000Z");

    await expect(workflow(input)).resolves.toEqual(completed);
    expect(provider.getUser).toHaveBeenCalledTimes(1);
    expect(store.run?.finishedAt).toBe("2026-09-01T00:00:00.000Z");
  });
});
