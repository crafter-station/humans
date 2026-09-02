import { task } from "@trigger.dev/sdk";

import { GITHUB_CONCURRENCY_LIMIT, type EnrichmentRun } from "./types.js";

export type GitHubEnrichmentInput = {
  profileId: string;
  githubLogin: string;
  runId: string;
};

/**
 * Registers the durable orchestration with Trigger.dev while keeping provider
 * and persistence adapters explicit at the deployment composition root.
 */
export const createGitHubEnrichmentTask = (
  workflow: (input: GitHubEnrichmentInput) => Promise<EnrichmentRun>,
) =>
  task({
    id: "github-profile-enrichment-v1",
    queue: {
      name: "github-enrichment",
      concurrencyLimit: GITHUB_CONCURRENCY_LIMIT,
    },
    retry: {
      maxAttempts: 5,
      factor: 2,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 60_000,
      randomize: true,
    },
    run: workflow,
  });
