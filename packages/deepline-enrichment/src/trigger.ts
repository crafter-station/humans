import { idempotencyKeys, task } from "@trigger.dev/sdk";

import {
  DEEPLINE_CONCURRENCY_LIMIT,
  DeeplineProviderError,
  PermanentDeeplineError,
  type DeeplineEnrichmentInput,
  type DeeplineRun,
} from "./types.js";
import { classifyDeeplineError } from "./workflow.js";

const retry = {
  maxAttempts: 5,
  factor: 2,
  minTimeoutInMs: 1_000,
  maxTimeoutInMs: 60_000,
  randomize: true,
} as const;

export const retryOptionsForDeeplineError = (error: unknown) => {
  if (error instanceof PermanentDeeplineError)
    return { skipRetrying: true } as const;
  if (!(error instanceof DeeplineProviderError)) return undefined;
  const classification = classifyDeeplineError(error);
  if (classification === "rate-limit") return { retryAt: error.retryAfter };
  if (classification === "retry") return undefined;
  return { skipRetrying: true } as const;
};

export type DeeplineEnrichmentStageHandlers = {
  identity(input: DeeplineEnrichmentInput): Promise<DeeplineRun>;
  career(input: DeeplineEnrichmentInput): Promise<DeeplineRun>;
  persistence(input: DeeplineEnrichmentInput): Promise<DeeplineRun>;
  retryExhausted(input: DeeplineEnrichmentInput, error: unknown): Promise<void>;
};

export const createDeeplineEnrichmentTasks = (
  stages: DeeplineEnrichmentStageHandlers,
) => {
  const catchError = async (
    input: DeeplineEnrichmentInput,
    error: unknown,
    attempt: number,
  ) => {
    const options = retryOptionsForDeeplineError(error);
    if (options?.skipRetrying || attempt >= retry.maxAttempts)
      await stages.retryExhausted(input, error);
    return options;
  };

  const identityTask = task({
    id: "deepline-identity-fallback-v1",
    queue: {
      name: "deepline-provider",
      concurrencyLimit: DEEPLINE_CONCURRENCY_LIMIT,
    },
    retry,
    catchError: ({ payload, error, ctx }) =>
      catchError(payload, error, ctx.attempt.number),
    run: stages.identity,
  });

  const careerTask = task({
    id: "deepline-career-fallback-v1",
    queue: {
      name: "deepline-provider",
      concurrencyLimit: DEEPLINE_CONCURRENCY_LIMIT,
    },
    retry,
    catchError: ({ payload, error, ctx }) =>
      catchError(payload, error, ctx.attempt.number),
    run: stages.career,
  });

  const persistenceTask = task({
    id: "deepline-fallback-persistence-v1",
    retry,
    catchError: ({ payload, error, ctx }) =>
      catchError(payload, error, ctx.attempt.number),
    run: stages.persistence,
  });

  const orchestrationTask = task({
    id: "deepline-fallback-enrichment-v1",
    retry: { maxAttempts: 1 },
    run: async (input: DeeplineEnrichmentInput) => {
      const key = (stage: string) =>
        idempotencyKeys.create(`${input.runId}:${stage}`, { scope: "global" });
      await identityTask
        .triggerAndWait(input, { idempotencyKey: await key("identity") })
        .unwrap();
      await careerTask
        .triggerAndWait(input, { idempotencyKey: await key("career") })
        .unwrap();
      return persistenceTask
        .triggerAndWait(input, { idempotencyKey: await key("persistence") })
        .unwrap();
    },
  });

  return { identityTask, careerTask, persistenceTask, orchestrationTask };
};
