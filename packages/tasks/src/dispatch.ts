import type { EnrichmentDispatch } from "@humans/database/enrichment";

export type EnrichmentDispatchBatchDependencies = {
  claim: () => Promise<EnrichmentDispatch[]>;
  trigger: (dispatch: EnrichmentDispatch) => Promise<{ id: string }>;
  markDelivered: (
    dispatch: EnrichmentDispatch,
    triggerRunId: string,
  ) => Promise<void>;
  release: (dispatch: EnrichmentDispatch) => Promise<void>;
};

export const dispatchEnrichmentBatch = async (
  dependencies: EnrichmentDispatchBatchDependencies,
) => {
  const dispatches = await dependencies.claim();
  let delivered = 0;
  let failed = 0;
  for (const dispatch of dispatches) {
    try {
      const handle = await dependencies.trigger(dispatch);
      await dependencies.markDelivered(dispatch, handle.id);
      delivered += 1;
    } catch {
      failed += 1;
      try {
        await dependencies.release(dispatch);
      } catch {
        // The lease remains durable and the recovery schedule will release it.
      }
    }
  }
  return { claimed: dispatches.length, delivered, failed };
};
