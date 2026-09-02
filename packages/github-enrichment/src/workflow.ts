import {
  GitHubProviderError,
  INACCESSIBLE_GRACE_PERIOD_DAYS,
  PIPELINE_VERSION,
  PROVIDER_SNAPSHOT_RETENTION_DAYS,
  PermanentEnrichmentError,
  type Collected,
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
  runId: string,
  profileId: string,
  account: Collected<GitHubUser>,
  repositories: Collected<{
    repositories: Repository[];
    contributions: GitHubEvidence["contributions"];
  }>,
  normalization: Collected<NormalizedEvidence>,
): Observation[] => {
  const base = (collectedAt: string) =>
    ({
      profileId,
      collectedAt,
      pipelineVersion: PIPELINE_VERSION,
    }) as const;
  return [
    {
      ...base(account.collectedAt),
      sourceRecordId: `${runId}:account:${account.value.id}`,
      kind: "github-account",
      source: "github",
      confidence: 1,
      value: account.value,
    },
    ...repositories.value.repositories.map((value) => ({
      ...base(repositories.collectedAt),
      sourceRecordId: `${runId}:repository:${value.id}`,
      kind: "github-repository" as const,
      source: "github" as const,
      confidence: 1,
      value,
    })),
    ...repositories.value.contributions.map((value) => ({
      ...base(repositories.collectedAt),
      sourceRecordId: `${runId}:contribution:${value.repositoryId}:${value.kind}:${value.occurredAt}`,
      kind: "github-contribution" as const,
      source: "github" as const,
      confidence: 1,
      value,
    })),
    {
      ...base(normalization.collectedAt),
      sourceRecordId: `${runId}:normalization`,
      kind: "github-normalization",
      source: "github-ai-normalization",
      confidence: 0.8,
      value: normalization.value,
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
    const accountInaccessible =
      classification === "inaccessible" && run.currentStage === "account";
    if (accountInaccessible) {
      await dependencies.store.markGitHubInaccessibleIfUnset(
        input.profileId,
        failedAt,
      );
    }
    const retrying =
      classification === "retry" ||
      classification === "rate-limit" ||
      (!(error instanceof GitHubProviderError) &&
        !(error instanceof PermanentEnrichmentError));
    const failedRun: EnrichmentRun = {
      ...run,
      status: accountInaccessible ? "stale" : retrying ? "running" : "failed",
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
      let accountEvidence = await dependencies.store.loadCheckpoint<
        Collected<GitHubUser>
      >(run.id, "account");
      let fetched = false;
      if (!accountEvidence) {
        fetched = true;
        const user = await dependencies.provider.getUser(input.githubLogin);
        const immutableId = await dependencies.store.getImmutableGitHubUserId(
          input.profileId,
        );
        if (immutableId !== undefined && immutableId !== user.id)
          throw new PermanentEnrichmentError(
            "GitHub login resolves to a different immutable user ID",
          );
        accountEvidence = { value: user, collectedAt: now().toISOString() };
      }
      await dependencies.store.clearGitHubInaccessible(input.profileId);
      if (fetched)
        await dependencies.store.saveCheckpoint(
          run.id,
          "account",
          accountEvidence,
          {
            expiresAt: snapshotExpiresAt(new Date(accountEvidence.collectedAt)),
          },
        );
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
      const accountEvidence = await dependencies.store.loadCheckpoint<
        Collected<GitHubUser>
      >(run.id, "account");
      if (!accountEvidence)
        throw new PermanentEnrichmentError("Account stage must complete first");
      const user = accountEvidence.value;
      let repositoryEvidence = await dependencies.store.loadCheckpoint<
        Collected<{
          repositories: Repository[];
          contributions: GitHubEvidence["contributions"];
        }>
      >(run.id, "repositories");
      if (!repositoryEvidence) {
        const since = new Date(
          now().getTime() - 365 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const [pinned, recent, contributions] = await Promise.all([
          pageAll(async (cursor) => {
            const page = await dependencies.provider.getPinnedRepositories(
              user.login,
              cursor,
            );
            return { items: page.repositories, nextCursor: page.nextCursor };
          }),
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
          value: {
            repositories: [...byId.values()],
            contributions,
          },
          collectedAt: now().toISOString(),
        };
        await dependencies.store.saveCheckpoint(
          run.id,
          "repositories",
          repositoryEvidence,
          {
            expiresAt: snapshotExpiresAt(
              new Date(repositoryEvidence.collectedAt),
            ),
          },
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
      const accountEvidence = await dependencies.store.loadCheckpoint<
        Collected<GitHubUser>
      >(run.id, "account");
      const repositoryEvidence = await dependencies.store.loadCheckpoint<
        Collected<{
          repositories: Repository[];
          contributions: GitHubEvidence["contributions"];
        }>
      >(run.id, "repositories");
      if (!accountEvidence || !repositoryEvidence)
        throw new PermanentEnrichmentError(
          "Repository stage must complete first",
        );
      let normalized = await dependencies.store.loadCheckpoint<
        Collected<NormalizedEvidence>
      >(run.id, "normalization");
      if (!normalized) {
        const evidence: GitHubEvidence = {
          user: accountEvidence.value,
          ...repositoryEvidence.value,
        };
        const value = await dependencies.normalizer.normalize(evidence);
        const supportedIds = new Set(evidence.repositories.map(({ id }) => id));
        if (value.evidenceRepositoryIds.some((id) => !supportedIds.has(id)))
          throw new PermanentEnrichmentError(
            "AI normalization cited unsupported repository evidence",
          );
        normalized = { value, collectedAt: now().toISOString() };
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
        const accountEvidence = await dependencies.store.loadCheckpoint<
          Collected<GitHubUser>
        >(run.id, "account");
        const repositoryEvidence = await dependencies.store.loadCheckpoint<
          Collected<{
            repositories: Repository[];
            contributions: GitHubEvidence["contributions"];
          }>
        >(run.id, "repositories");
        const normalized = await dependencies.store.loadCheckpoint<
          Collected<NormalizedEvidence>
        >(run.id, "normalization");
        if (!accountEvidence || !repositoryEvidence || !normalized)
          throw new PermanentEnrichmentError(
            "Normalization stage must complete first",
          );
        await dependencies.store.persistObservations(
          run.id,
          observationsFor(
            run.id,
            input.profileId,
            accountEvidence,
            repositoryEvidence,
            normalized,
          ),
        );
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

  const retryExhausted = async (
    input: GitHubEnrichmentInput,
    error: unknown,
  ) => {
    const run = await dependencies.store.getRun(input.runId);
    if (!run || run.status !== "running") return;
    await dependencies.store.saveRun({
      ...run,
      status: "failed",
      currentStage: null,
      error:
        error instanceof Error ? error.message : "GitHub retries exhausted",
      finishedAt: now().toISOString(),
    });
  };

  return {
    account,
    repositories,
    normalization,
    persistence,
    retryExhausted,
  };
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
