import {
  createGitHubEnrichmentTasks,
  type GitHubEnrichmentStageHandlers,
} from "@humans/github-enrichment";

import { withGitHubRuntime } from "../runtime.js";

const stages: GitHubEnrichmentStageHandlers = {
  account: (input) => withGitHubRuntime((runtime) => runtime.account(input)),
  repositories: (input) =>
    withGitHubRuntime((runtime) => runtime.repositories(input)),
  normalization: (input) =>
    withGitHubRuntime((runtime) => runtime.normalization(input)),
  persistence: (input) =>
    withGitHubRuntime((runtime) => runtime.persistence(input)),
  retryExhausted: (input, error) =>
    withGitHubRuntime((runtime) => runtime.retryExhausted(input, error)),
};

export const {
  accountTask: githubAccountTask,
  repositoriesTask: githubRepositoriesTask,
  normalizationTask: githubNormalizationTask,
  persistenceTask: githubPersistenceTask,
  orchestrationTask: githubProfileEnrichmentTask,
} = createGitHubEnrichmentTasks(stages);
