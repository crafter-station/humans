import {
  GitHubProviderError,
  INACCESSIBLE_GRACE_PERIOD_DAYS,
  PIPELINE_VERSION,
  type EnrichmentRun,
  type EnrichmentStore,
  type EvidenceNormalizer,
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
  if (error.status === 403 && error.retryAfter) return "rate-limit" as const;
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

export const createGitHubEnrichmentWorkflow =
  (dependencies: {
    provider: GitHubProvider;
    normalizer: EvidenceNormalizer;
    store: EnrichmentStore;
    now?: () => Date;
  }) =>
  async (input: { profileId: string; githubLogin: string; runId: string }) => {
    const now = dependencies.now ?? (() => new Date());
    let run = await dependencies.store.getOrCreateRun(
      input.profileId,
      input.runId,
      now().toISOString(),
    );
    if (run.status === "succeeded") return run;
    run = { ...run, status: "running", error: undefined };
    await dependencies.store.saveRun(run);

    try {
      let user = await dependencies.store.loadCheckpoint<GitHubUser>(
        run.id,
        "account",
      );
      if (!user) {
        run = { ...run, currentStage: "account" };
        await dependencies.store.saveRun(run);
        user = await dependencies.provider.getUser(input.githubLogin);
        const immutableId = await dependencies.store.getImmutableGitHubUserId(
          input.profileId,
        );
        if (immutableId !== undefined && immutableId !== user.id)
          throw new Error(
            "GitHub login resolves to a different immutable user ID",
          );
        await dependencies.store.saveCheckpoint(run.id, "account", user);
        run = complete(run, "account");
        await dependencies.store.saveRun(run);
      }

      let repositoryEvidence = await dependencies.store.loadCheckpoint<{
        repositories: Repository[];
        contributions: GitHubEvidence["contributions"];
      }>(run.id, "repositories");
      if (!repositoryEvidence) {
        run = { ...run, currentStage: "repositories" };
        await dependencies.store.saveRun(run);
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
        const repositories = [
          ...new Map(
            [
              ...pinned.map((repository) => ({ ...repository, pinned: true })),
              ...recent,
            ].map((repository) => [repository.id, repository]),
          ).values(),
        ];
        repositoryEvidence = { repositories, contributions };
        await dependencies.store.saveCheckpoint(
          run.id,
          "repositories",
          repositoryEvidence,
        );
        run = complete(run, "repositories");
        await dependencies.store.saveRun(run);
      }

      const evidence: GitHubEvidence = { user, ...repositoryEvidence };
      let normalized =
        await dependencies.store.loadCheckpoint<NormalizedEvidence>(
          run.id,
          "normalization",
        );
      if (!normalized) {
        run = { ...run, currentStage: "normalization" };
        await dependencies.store.saveRun(run);
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
        run = complete(run, "normalization");
        await dependencies.store.saveRun(run);
      }

      if (!run.completedStages.includes("persistence")) {
        run = { ...run, currentStage: "persistence" };
        await dependencies.store.saveRun(run);
        await dependencies.store.saveObservations(
          observationsFor(
            input.profileId,
            evidence,
            normalized,
            now().toISOString(),
          ),
        );
        await dependencies.store.clearGitHubInaccessible(input.profileId);
        run = complete(run, "persistence");
      }
      run = { ...run, status: "succeeded", finishedAt: now().toISOString() };
      await dependencies.store.saveRun(run);
      return run;
    } catch (error) {
      const classification = classifyGitHubError(error);
      if (classification === "inaccessible")
        await dependencies.store.markGitHubInaccessible(
          input.profileId,
          now().toISOString(),
        );
      run = {
        ...run,
        status: classification === "inaccessible" ? "stale" : "failed",
        currentStage: null,
        error:
          error instanceof Error ? error.message : "Unknown enrichment failure",
        finishedAt: now().toISOString(),
      };
      await dependencies.store.saveRun(run);
      throw error;
    }
  };

export const isSuppressionEligible = (inaccessibleSince: string, now: Date) =>
  now.getTime() - new Date(inaccessibleSince).getTime() >=
  INACCESSIBLE_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
