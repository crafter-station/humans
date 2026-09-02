import { idempotencyKeys, task } from "@trigger.dev/sdk";

import {
  GITHUB_CONCURRENCY_LIMIT,
  type EnrichmentRun,
  type GitHubEnrichmentInput,
  type GitHubProviderError,
} from "./types.js";
import { classifyGitHubError } from "./workflow.js";

const retry = {
  maxAttempts: 5,
  factor: 2,
  minTimeoutInMs: 1_000,
  maxTimeoutInMs: 60_000,
  randomize: true,
} as const;

export const retryOptionsForGitHubError = (error: unknown) => {
  const classification = classifyGitHubError(error);
  if (classification === "rate-limit")
    return { retryAt: (error as GitHubProviderError).retryAfter };
  if (classification === "retry") return undefined;
  return { skipRetrying: true } as const;
};

export type GitHubEnrichmentStageHandlers = {
  account(input: GitHubEnrichmentInput): Promise<EnrichmentRun>;
  repositories(input: GitHubEnrichmentInput): Promise<EnrichmentRun>;
  normalization(input: GitHubEnrichmentInput): Promise<EnrichmentRun>;
  persistence(input: GitHubEnrichmentInput): Promise<EnrichmentRun>;
};

/** Registers independently retryable stages and their thin durable orchestrator. */
export const createGitHubEnrichmentTasks = (
  stages: GitHubEnrichmentStageHandlers,
) => {
  const accountTask = task({
    id: "github-enrichment-account-v1",
    queue: {
      name: "github-provider",
      concurrencyLimit: GITHUB_CONCURRENCY_LIMIT,
    },
    retry,
    catchError: ({ error }) => retryOptionsForGitHubError(error),
    run: stages.account,
  });

  const repositoriesTask = task({
    id: "github-enrichment-repositories-v1",
    queue: {
      name: "github-provider",
      concurrencyLimit: GITHUB_CONCURRENCY_LIMIT,
    },
    retry,
    catchError: ({ error }) => retryOptionsForGitHubError(error),
    run: stages.repositories,
  });

  const normalizationTask = task({
    id: "github-enrichment-normalization-v1",
    queue: { name: "github-normalization", concurrencyLimit: 2 },
    retry,
    run: stages.normalization,
  });

  const persistenceTask = task({
    id: "github-enrichment-persistence-v1",
    queue: { name: "github-persistence", concurrencyLimit: 4 },
    retry,
    run: stages.persistence,
  });

  const orchestrationTask = task({
    id: "github-profile-enrichment-v1",
    retry: { maxAttempts: 1 },
    run: async (input: GitHubEnrichmentInput) => {
      const key = (stage: string) =>
        idempotencyKeys.create(`${input.runId}:${stage}`, { scope: "global" });
      await accountTask
        .triggerAndWait(input, { idempotencyKey: await key("account") })
        .unwrap();
      await repositoriesTask
        .triggerAndWait(input, { idempotencyKey: await key("repositories") })
        .unwrap();
      await normalizationTask
        .triggerAndWait(input, { idempotencyKey: await key("normalization") })
        .unwrap();
      return persistenceTask
        .triggerAndWait(input, { idempotencyKey: await key("persistence") })
        .unwrap();
    },
  });

  return {
    accountTask,
    repositoriesTask,
    normalizationTask,
    persistenceTask,
    orchestrationTask,
  };
};
