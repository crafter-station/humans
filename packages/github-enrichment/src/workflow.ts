import {
  GitHubProviderError,
  INACCESSIBLE_GRACE_PERIOD_DAYS,
  PIPELINE_VERSION,
  PROVIDER_SNAPSHOT_RETENTION_DAYS,
  type EnrichmentRun,
  type EnrichmentStore,
  type EvidenceNormalizer,
  type GitHubEnrichmentInput,
  type GitHubEvidence,
  type GitHubProvider,
  type GitHubUser,
  type NormalizedEvidence,
  type Observation,
  type Repository,
  type Stage,
} from "./types.js";

export const classifyGitHubError = (error: unknown) => {
  if (!(error instanceof GitHubProviderError)) return "fatal" as const;
  if ((error.status === 403 || error.status === 429) && error.retryAfter)
    return "rate-limit" as const;
  if (error.status === 429 || error.status >= 500) return "retry" as const;
  if (error.status === 404 || error.status === 410)
    return "inaccessible" as const;
  return "fatal" as const;
};

const pageAll = async <T>(
  fetchPage: (cursor?: string) => Promise<{ nextCursor?: string; items: T[] }>,
) => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
};

const observationsFor = (
  profileId: string,
  evidence: GitHubEvidence,
  normalized: NormalizedEvidence,
  collectedAt: string,
): Observation[] => {
  const base = {
    profileId,
    collectedAt,
    pipelineVersion: PIPELINE_VERSION,
  } as const;
  return [
    {
      ...base,
      kind: "github-account",
      source: "github",
      confidence: 1,
      value: evidence.user,
    },
    ...evidence.repositories.map((value) => ({
      ...base,
      kind: "github-repository" as const,
      source: "github" as const,
      confidence: 1,
      value,
    })),
    ...evidence.contributions.map((value) => ({
      ...base,
      kind: "github-contribution" as const,
      source: "github" as const,
      confidence: 1,
      value,
    })),
    {
      ...base,
      kind: "github-normalization",
      source: "github-ai-normalization",
      confidence: 0.8,
      value: normalized,
    },
  ];
};

const complete = (run: EnrichmentRun, stage: Stage): EnrichmentRun => ({
  ...run,
  completedStages: run.completedStages.includes(stage)
    ? run.completedStages
    : [...run.completedStages, stage],
  currentStage: null,
});

export type GitHubEnrichmentDependencies = {
  provider: GitHubProvider;
  normalizer: EvidenceNormalizer;
  store: EnrichmentStore;
  now?: () => Date;
};

const snapshotExpiresAt = (now: Date) =>
  new Date(
    now.getTime() + PROVIDER_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

export const createGitHubEnrichmentStages = (
  dependencies: GitHubEnrichmentDependencies,
) => {
  const now = dependencies.now ?? (() => new Date());

  const getRun = async (input: GitHubEnrichmentInput, stage: Stage) => {
    let run = await dependencies.store.getOrCreateRun(
      input.profileId,
      input.runId,
      now().toISOString(),
    );
    if (run.status === "succeeded") return run;
    run = {
      ...run,
      status: "running",
      currentStage: stage,
      error: undefined,
      finishedAt: undefined,
    };
    await dependencies.store.saveRun(run);
    return run;
  };

  const fail = async (
    input: GitHubEnrichmentInput,
    run: EnrichmentRun,
    error: unknown,
  ) => {
    const classification = classifyGitHubError(error);
    const failedAt = now().toISOString();
    if (error instanceof GitHubProviderError) {
      await dependencies.store.markGitHubObservationsStale(
        input.profileId,
        failedAt,
      );
    }
    if (classification === "inaccessible") {
      await dependencies.store.markGitHubInaccessibleIfUnset(
        input.profileId,
        failedAt,
      );
    }
    const retrying =
      classification === "retry" || classification === "rate-limit";
    const failedRun: EnrichmentRun = {
      ...run,
      status:
        classification === "inaccessible"
          ? "stale"
          : retrying
            ? "running"
            : "failed",
      currentStage: retrying ? run.currentStage : null,
      error:
        error instanceof Error ? error.message : "Unknown enrichment failure",
      finishedAt: retrying ? undefined : failedAt,
    };
    await dependencies.store.saveRun(failedRun);
    throw error;
  };

  const account = async (input: GitHubEnrichmentInput) => {
    let run = await getRun(input, "account");
    try {
      let user = await dependencies.store.loadCheckpoint<GitHubUser>(
        run.id,
        "account",
      );
      if (!user) {
        user = await dependencies.provider.getUser(input.githubLogin);
        const immutableId = await dependencies.store.getImmutableGitHubUserId(
          input.profileId,
        );
        if (immutableId !== undefined && immutableId !== user.id)
          throw new Error(
            "GitHub login resolves to a different immutable user ID",
          );
        await dependencies.store.saveCheckpoint(run.id, "account", user, {
          expiresAt: snapshotExpiresAt(now()),
        });
      }
      run = complete(run, "account");
      await dependencies.store.saveRun(run);
      return run;
    } catch (error) {
      return fail(input, run, error);
    }
  };

  const repositories = async (input: GitHubEnrichmentInput) => {
    let run = await getRun(input, "repositories");
    try {
      const user = await dependencies.store.loadCheckpoint<GitHubUser>(
        run.id,
        "account",
      );
      if (!user) throw new Error("Account stage must complete first");
      let repositoryEvidence = await dependencies.store.loadCheckpoint<{
        repositories: Repository[];
        contributions: GitHubEvidence["contributions"];
      }>(run.id, "repositories");
      if (!repositoryEvidence) {
        const since = new Date(
          now().getTime() - 365 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const [pinned, recent, contributions] = await Promise.all([
          dependencies.provider.getPinnedRepositories(user.login),
          pageAll(async (cursor) => {
            const page =
              await dependencies.provider.getRecentlyActiveRepositories(
                user.login,
                cursor,
              );
            return { items: page.repositories, nextCursor: page.nextCursor };
          }),
          pageAll(async (cursor) => {
            const page = await dependencies.provider.getContributions(
              user.login,
              since,
              cursor,
            );
            return { items: page.contributions, nextCursor: page.nextCursor };
          }),
        ]);
        const byId = new Map(
          recent.map((repository) => [repository.id, repository]),
        );
        for (const repository of pinned) {
          byId.set(repository.id, {
            ...byId.get(repository.id),
            ...repository,
            pinned: true,
          });
        }
        repositoryEvidence = {
          repositories: [...byId.values()],
          contributions,
        };
        await dependencies.store.saveCheckpoint(
          run.id,
          "repositories",
          repositoryEvidence,
          { expiresAt: snapshotExpiresAt(now()) },
        );
      }
      run = complete(run, "repositories");
      await dependencies.store.saveRun(run);
      return run;
    } catch (error) {
      return fail(input, run, error);
    }
  };

  const normalization = async (input: GitHubEnrichmentInput) => {
    let run = await getRun(input, "normalization");
    try {
      const user = await dependencies.store.loadCheckpoint<GitHubUser>(
        run.id,
        "account",
      );
      const repositoryEvidence = await dependencies.store.loadCheckpoint<{
        repositories: Repository[];
        contributions: GitHubEvidence["contributions"];
      }>(run.id, "repositories");
      if (!user || !repositoryEvidence)
        throw new Error("Repository stage must complete first");
      let normalized =
        await dependencies.store.loadCheckpoint<NormalizedEvidence>(
          run.id,
          "normalization",
        );
      if (!normalized) {
        const evidence: GitHubEvidence = { user, ...repositoryEvidence };
        normalized = await dependencies.normalizer.normalize(evidence);
        const supportedIds = new Set(evidence.repositories.map(({ id }) => id));
        if (
          normalized.evidenceRepositoryIds.some((id) => !supportedIds.has(id))
        )
          throw new Error(
            "AI normalization cited unsupported repository evidence",
          );
        await dependencies.store.saveCheckpoint(
          run.id,
          "normalization",
          normalized,
        );
      }
      run = complete(run, "normalization");
      await dependencies.store.saveRun(run);
      return run;
    } catch (error) {
      return fail(input, run, error);
    }
  };

  const persistence = async (input: GitHubEnrichmentInput) => {
    let run = await getRun(input, "persistence");
    try {
      const persisted = await dependencies.store.loadCheckpoint<boolean>(
        run.id,
        "persistence",
      );
      if (!persisted) {
        const user = await dependencies.store.loadCheckpoint<GitHubUser>(
          run.id,
          "account",
        );
        const repositoryEvidence = await dependencies.store.loadCheckpoint<{
          repositories: Repository[];
          contributions: GitHubEvidence["contributions"];
        }>(run.id, "repositories");
        const normalized =
          await dependencies.store.loadCheckpoint<NormalizedEvidence>(
            run.id,
            "normalization",
          );
        if (!user || !repositoryEvidence || !normalized)
          throw new Error("Normalization stage must complete first");
        await dependencies.store.saveObservations(
          observationsFor(
            input.profileId,
            { user, ...repositoryEvidence },
            normalized,
            now().toISOString(),
          ),
        );
        await dependencies.store.clearGitHubInaccessible(input.profileId);
        await dependencies.store.saveCheckpoint(run.id, "persistence", true);
      }
      run = {
        ...complete(run, "persistence"),
        status: "succeeded",
        finishedAt: now().toISOString(),
      };
      await dependencies.store.saveRun(run);
      return run;
    } catch (error) {
      return fail(input, run, error);
    }
  };

  return { account, repositories, normalization, persistence };
};

export const createGitHubEnrichmentWorkflow = (
  dependencies: GitHubEnrichmentDependencies,
) => {
  const stages = createGitHubEnrichmentStages(dependencies);
  return async (input: GitHubEnrichmentInput) => {
    await stages.account(input);
    await stages.repositories(input);
    await stages.normalization(input);
    return stages.persistence(input);
  };
};

export const isSuppressionEligible = (inaccessibleSince: string, now: Date) =>
  now.getTime() - new Date(inaccessibleSince).getTime() >=
  INACCESSIBLE_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
