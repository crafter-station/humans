import {
  createDueEnrichmentDispatches,
  deleteExpiredEnrichmentCheckpoints,
  recoverEnrichmentDispatches,
  suppressGitHubInaccessibleProfiles,
} from "@humans/database/enrichment";
import {
  reconcileCreditPeriodPage,
  recoverCreditUsageLeases,
} from "@humans/database/billing";
import { idempotencyKeys, runs, schedules } from "@trigger.dev/sdk";

import { withDatabaseRuntime, withPolarBillingRuntime } from "../runtime.js";
import { reconcileAllCreditPeriodPages } from "../billing.js";
import { billingUsageDeliveryTask } from "./billing.js";
import { enrichmentDispatcherTask } from "./dispatcher.js";

const dailyCron = (pattern: string) => ({
  pattern,
  timezone: "UTC",
  environments: ["PRODUCTION"] as Array<"PRODUCTION">,
});

const triggerDispatcher = async (
  source: "schedule" | "recovery",
  timestamp: Date,
) => {
  const requestedAt = timestamp.toISOString();
  const idempotencyKey = await idempotencyKeys.create(
    `enrichment-dispatcher:${source}:${requestedAt}`,
    { scope: "global" },
  );
  return enrichmentDispatcherTask.trigger(
    { source, requestedAt },
    { idempotencyKey, idempotencyKeyTTL: "7d" },
  );
};

const triggerBillingUsageDelivery = async (
  source: "schedule" | "recovery",
  timestamp: Date,
) => {
  const requestedAt = timestamp.toISOString();
  const idempotencyKey = await idempotencyKeys.create(
    `billing-usage-delivery:${source}:${requestedAt}`,
    { scope: "global" },
  );
  return billingUsageDeliveryTask.trigger(
    { source, requestedAt },
    { idempotencyKey, idempotencyKeyTTL: "1d" },
  );
};

export const billingUsageDeliverySchedule = schedules.task({
  id: "billing-usage-delivery-every-five-minutes-v1",
  cron: dailyCron("*/5 * * * *"),
  ttl: "15m",
  retry: { maxAttempts: 3 },
  run: ({ timestamp }) => triggerBillingUsageDelivery("schedule", timestamp),
});

export const billingUsageRecoverySchedule = schedules.task({
  id: "billing-usage-recovery-every-fifteen-minutes-v1",
  cron: dailyCron("2,17,32,47 * * * *"),
  ttl: "15m",
  retry: { maxAttempts: 3 },
  run: async ({ timestamp }) => {
    const recovery = await withDatabaseRuntime((database) =>
      recoverCreditUsageLeases(database, timestamp),
    );
    const delivery = await triggerBillingUsageDelivery("recovery", timestamp);
    return { ...recovery, deliveryRunId: delivery.id };
  },
});

export const billingReconciliationSchedule = schedules.task({
  id: "billing-credit-reconciliation-daily-v1",
  cron: dailyCron("20 3 * * *"),
  ttl: "6h",
  retry: { maxAttempts: 3 },
  run: ({ timestamp }) =>
    withPolarBillingRuntime((database, client) =>
      reconcileAllCreditPeriodPages({
        page: (after) =>
          reconcileCreditPeriodPage(
            database,
            ({ organizationId, startAt, endAt }) =>
              client
                .getMeterQuantities({
                  clerkOrganizationId: organizationId,
                  startAt,
                  endAt,
                  interval: "day",
                })
                .then(({ total }) => total),
            { limit: 50, now: timestamp, after },
          ),
      }),
    ),
});

export const enrichmentRefreshDispatchProducerSchedule = schedules.task({
  id: "enrichment-refresh-dispatch-producer-daily-v1",
  cron: dailyCron("5 0 * * *"),
  ttl: "6h",
  retry: { maxAttempts: 3 },
  run: async ({ timestamp }) => {
    const created = await withDatabaseRuntime((database) =>
      createDueEnrichmentDispatches(database, { now: timestamp }),
    );
    const dispatcher = await triggerDispatcher("schedule", timestamp);
    return { created: created.length, dispatcherRunId: dispatcher.id };
  },
});

export const enrichmentDispatchRecoverySchedule = schedules.task({
  id: "enrichment-dispatch-recovery-daily-v1",
  cron: dailyCron("35 0 * * *"),
  ttl: "6h",
  retry: { maxAttempts: 3 },
  run: async ({ timestamp }) => {
    const recovery = await withDatabaseRuntime((database) =>
      recoverEnrichmentDispatches(database, timestamp, async (triggerRunId) => {
        const run = await runs.retrieve(triggerRunId);
        return {
          status: run.status,
          isCompleted: run.isCompleted,
          isCancelled: run.isCancelled,
        };
      }),
    );
    const dispatcher = await triggerDispatcher("recovery", timestamp);
    return { ...recovery, dispatcherRunId: dispatcher.id };
  },
});

export const enrichmentCheckpointCleanupSchedule = schedules.task({
  id: "enrichment-checkpoint-cleanup-daily-v1",
  cron: dailyCron("5 1 * * *"),
  ttl: "6h",
  retry: { maxAttempts: 3 },
  run: ({ timestamp }) =>
    withDatabaseRuntime((database) =>
      deleteExpiredEnrichmentCheckpoints(database, timestamp),
    ),
});

export const githubInaccessibleSuppressionSchedule = schedules.task({
  id: "github-inaccessible-suppression-daily-v1",
  cron: dailyCron("5 2 * * *"),
  ttl: "6h",
  retry: { maxAttempts: 3 },
  run: ({ timestamp }) =>
    withDatabaseRuntime((database) =>
      suppressGitHubInaccessibleProfiles(database, timestamp),
    ),
});
