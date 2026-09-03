import {
  claimEnrichmentDispatches,
  markEnrichmentDispatchDelivered,
  releaseEnrichmentDispatch,
} from "@humans/database/enrichment";
import { idempotencyKeys, task } from "@trigger.dev/sdk";

import { dispatchEnrichmentBatch } from "../dispatch.js";
import { withDatabaseRuntime } from "../runtime.js";
import { deeplineFallbackEnrichmentTask } from "./deepline.js";
import { githubProfileEnrichmentTask } from "./github.js";
import { tikHubLinkedInEnrichmentTask } from "./tikhub.js";

export const ENRICHMENT_DISPATCH_BATCH_SIZE = 25;

type DispatcherInput = {
  source: "schedule" | "recovery" | "continuation";
  requestedAt: string;
};

export const enrichmentDispatcherTask = task({
  id: "enrichment-dispatcher-v1",
  queue: { name: "enrichment-dispatch", concurrencyLimit: 2 },
  retry: {
    maxAttempts: 5,
    factor: 2,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 60_000,
    randomize: true,
  },
  run: async (input: DispatcherInput, { ctx }) => {
    const leaseOwner = ctx.run.id;
    const result = await withDatabaseRuntime((database) =>
      dispatchEnrichmentBatch({
        claim: () =>
          claimEnrichmentDispatches(database, {
            leaseOwner,
            limit: ENRICHMENT_DISPATCH_BATCH_SIZE,
          }),
        trigger: async (dispatch) => {
          const idempotencyKey = await idempotencyKeys.create(
            `enrichment-dispatch:${dispatch.runId}`,
            { scope: "global" },
          );
          const options = { idempotencyKey, idempotencyKeyTTL: "365d" };
          if (dispatch.provider === "github")
            return githubProfileEnrichmentTask.trigger(
              dispatch.payload,
              options,
            );
          if (dispatch.provider === "tikhub")
            return tikHubLinkedInEnrichmentTask.trigger(
              dispatch.payload,
              options,
            );
          return deeplineFallbackEnrichmentTask.trigger(
            dispatch.payload,
            options,
          );
        },
        markDelivered: (dispatch, triggerRunId) =>
          markEnrichmentDispatchDelivered(database, {
            dispatchId: dispatch.id,
            leaseOwner,
            triggerRunId,
          }),
        release: (dispatch) =>
          releaseEnrichmentDispatch(database, {
            dispatchId: dispatch.id,
            leaseOwner,
            errorCode: "trigger_delivery_failed",
          }),
      }),
    );
    if (result.failed > 0)
      throw new Error(
        "One or more enrichment dispatches could not be delivered",
      );
    if (result.claimed === ENRICHMENT_DISPATCH_BATCH_SIZE) {
      const idempotencyKey = await idempotencyKeys.create(
        `enrichment-dispatch-continuation:${ctx.run.id}`,
        { scope: "global" },
      );
      await enrichmentDispatcherTask.trigger(
        {
          source: "continuation",
          requestedAt: input.requestedAt,
        },
        { idempotencyKey, idempotencyKeyTTL: "1d" },
      );
    }
    return result;
  },
});
