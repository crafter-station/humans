import {
  createTikHubEnrichmentTasks,
  type TikHubStageHandlers,
} from "@humans/tikhub-enrichment";

import { withTikHubRuntime } from "../runtime.js";

const stages: TikHubStageHandlers = {
  fetch: (input) => withTikHubRuntime((runtime) => runtime.fetch(input)),
  normalization: (input) =>
    withTikHubRuntime((runtime) => runtime.normalization(input)),
  persistence: (input) =>
    withTikHubRuntime((runtime) => runtime.persistence(input)),
  retryExhausted: (input, error) =>
    withTikHubRuntime((runtime) => runtime.retryExhausted(input, error)),
};

export const {
  fetchTask: tikHubLinkedInFetchTask,
  normalizationTask: tikHubLinkedInNormalizationTask,
  persistenceTask: tikHubLinkedInPersistenceTask,
  orchestrationTask: tikHubLinkedInEnrichmentTask,
} = createTikHubEnrichmentTasks(stages);
