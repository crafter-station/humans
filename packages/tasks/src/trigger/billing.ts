import {
  claimCreditUsage,
  markCreditUsageDelivered,
  releaseCreditUsage,
} from "@humans/database/billing";
import { idempotencyKeys, task } from "@trigger.dev/sdk";

import { deliverCreditUsageBatch } from "../billing.js";
import { withPolarBillingRuntime } from "../runtime.js";

export const BILLING_USAGE_BATCH_SIZE = 100;

type BillingUsageDeliveryInput = {
  source: "schedule" | "recovery" | "continuation";
  requestedAt: string;
};

export const billingUsageDeliveryTask = task({
  id: "billing-usage-delivery-v1",
  queue: { name: "billing-usage-delivery", concurrencyLimit: 1 },
  retry: {
    maxAttempts: 5,
    factor: 2,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 60_000,
    randomize: true,
  },
  run: async (input: BillingUsageDeliveryInput, { ctx }) => {
    const result = await withPolarBillingRuntime(async (database, client) =>
      deliverCreditUsageBatch({
        claim: () =>
          claimCreditUsage(database, {
            leaseOwner: ctx.run.id,
            limit: BILLING_USAGE_BATCH_SIZE,
          }),
        ingest: async (items) => {
          await client.ingestFinalizedCreditUsage(
            items.map((item) => ({
              idempotencyKey: item.idempotencyKey,
              clerkOrganizationId: item.organizationId,
              occurredAt: item.occurredAt,
            })),
          );
        },
        markDelivered: (items) =>
          markCreditUsageDelivered(database, {
            ids: items.map(({ id }) => id),
            leaseOwner: ctx.run.id,
          }),
        release: (items, errorCode) =>
          releaseCreditUsage(database, {
            ids: items.map(({ id }) => id),
            leaseOwner: ctx.run.id,
            errorCode,
          }),
      }),
    );
    if (result.claimed === BILLING_USAGE_BATCH_SIZE) {
      const idempotencyKey = await idempotencyKeys.create(
        `billing-usage-continuation:${ctx.run.id}`,
        { scope: "global" },
      );
      await billingUsageDeliveryTask.trigger(
        { source: "continuation", requestedAt: input.requestedAt },
        { idempotencyKey, idempotencyKeyTTL: "1d" },
      );
    }
    return result;
  },
});
