import {
  createDeeplineEnrichmentTasks,
  type DeeplineEnrichmentStageHandlers,
} from "@humans/deepline-enrichment";

import { withDeeplineRuntime } from "../runtime.js";

const stages: DeeplineEnrichmentStageHandlers = {
  identity: (input) =>
    withDeeplineRuntime((runtime) => runtime.identity(input)),
  career: (input) => withDeeplineRuntime((runtime) => runtime.career(input)),
  persistence: (input) =>
    withDeeplineRuntime((runtime) => runtime.persistence(input)),
  retryExhausted: (input, error) =>
    withDeeplineRuntime((runtime) => runtime.retryExhausted(input, error)),
};

export const {
  identityTask: deeplineIdentityFallbackTask,
  careerTask: deeplineCareerFallbackTask,
  persistenceTask: deeplineFallbackPersistenceTask,
  orchestrationTask: deeplineFallbackEnrichmentTask,
} = createDeeplineEnrichmentTasks(stages);
