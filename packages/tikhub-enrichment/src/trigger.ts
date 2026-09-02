import { idempotencyKeys, task } from "@trigger.dev/sdk";

import {
  InvalidTikHubPayloadError,
  TIKHUB_CONCURRENCY_LIMIT,
  TikHubProviderError,
  type TikHubEnrichmentInput,
  type TikHubRun,
} from "./types.js";
import { classifyTikHubError } from "./workflow.js";

const retry = {
  maxAttempts: 5,
  factor: 2,
  minTimeoutInMs: 1_000,
  maxTimeoutInMs: 60_000,
  randomize: true,
} as const;

export const retryOptionsForTikHubError = (error: unknown) => {
  if (error instanceof InvalidTikHubPayloadError)
    return { skipRetrying: true } as const;
  if (!(error instanceof TikHubProviderError)) return undefined;
  const classification = classifyTikHubError(error);
  if (classification === "rate-limit") return { retryAt: error.retryAfter };
  if (classification === "retry") return undefined;
  return { skipRetrying: true } as const;
};

export type TikHubStageHandlers = {
  fetch(input: TikHubEnrichmentInput): Promise<TikHubRun>;
  normalization(input: TikHubEnrichmentInput): Promise<TikHubRun>;
  persistence(input: TikHubEnrichmentInput): Promise<TikHubRun>;
  retryExhausted(input: TikHubEnrichmentInput, error: unknown): Promise<void>;
};

export const createTikHubEnrichmentTasks = (stages: TikHubStageHandlers) => {
  const catchError = async (
    input: TikHubEnrichmentInput,
    error: unknown,
    attempt: number,
  ) => {
    const options = retryOptionsForTikHubError(error);
    if (options?.skipRetrying || attempt >= retry.maxAttempts)
      await stages.retryExhausted(input, error);
    return options;
  };
  const fetchTask = task({
    id: "tikhub-linkedin-fetch-v1",
    queue: {
      name: "tikhub-provider",
      concurrencyLimit: TIKHUB_CONCURRENCY_LIMIT,
    },
    retry,
    catchError: ({ payload, error, ctx }) =>
      catchError(payload, error, ctx.attempt.number),
    run: stages.fetch,
  });
  const normalizationTask = task({
    id: "tikhub-linkedin-normalization-v1",
    retry,
    catchError: ({ payload, error, ctx }) =>
      catchError(payload, error, ctx.attempt.number),
    run: stages.normalization,
  });
  const persistenceTask = task({
    id: "tikhub-linkedin-persistence-v1",
    retry,
    catchError: ({ payload, error, ctx }) =>
      catchError(payload, error, ctx.attempt.number),
    run: stages.persistence,
  });
  const orchestrationTask = task({
    id: "tikhub-linkedin-enrichment-v1",
    retry: { maxAttempts: 1 },
    run: async (input: TikHubEnrichmentInput) => {
      const key = (stage: string) =>
        idempotencyKeys.create(`${input.runId}:${stage}`, { scope: "global" });
      await fetchTask
        .triggerAndWait(input, { idempotencyKey: await key("fetch") })
        .unwrap();
      await normalizationTask
        .triggerAndWait(input, { idempotencyKey: await key("normalization") })
        .unwrap();
      return persistenceTask
        .triggerAndWait(input, { idempotencyKey: await key("persistence") })
        .unwrap();
    },
  });
  return { fetchTask, normalizationTask, persistenceTask, orchestrationTask };
};
