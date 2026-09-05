import { describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  type Configuration = {
    id: string;
    cron?: {
      pattern: string;
      timezone?: string;
      environments?: string[];
    };
    run: (...arguments_: never[]) => unknown;
  };
  return {
    tasks: [] as Configuration[],
    schedules: [] as Configuration[],
  };
});

vi.mock("@trigger.dev/sdk", () => {
  const registered = (configuration: (typeof sdk.tasks)[number]) => ({
    id: configuration.id,
    trigger: vi.fn(async () => ({ id: `run:${configuration.id}` })),
    triggerAndWait: vi.fn(() => ({
      unwrap: () => configuration.run(),
    })),
  });
  return {
    idempotencyKeys: { create: vi.fn(async (key: string) => key) },
    runs: { retrieve: vi.fn() },
    task: vi.fn((configuration: (typeof sdk.tasks)[number]) => {
      sdk.tasks.push(configuration);
      return registered(configuration);
    }),
    schedules: {
      task: vi.fn((configuration: (typeof sdk.tasks)[number]) => {
        sdk.schedules.push(configuration);
        return registered(configuration);
      }),
    },
  };
});

describe("Trigger.dev composition root", () => {
  it(
    "registers every concrete task at import without reading runtime credentials",
    async () => {
      await expect(import("../src/trigger/index.js")).resolves.toBeDefined();

      expect(sdk.tasks.map(({ id }) => id).sort()).toEqual(
        [
          "billing-usage-delivery-v1",
          "deepline-career-fallback-v1",
          "deepline-fallback-enrichment-v1",
          "deepline-fallback-persistence-v1",
          "deepline-identity-fallback-v1",
          "enrichment-dispatcher-v1",
          "github-enrichment-account-v1",
          "github-enrichment-normalization-v1",
          "github-enrichment-persistence-v1",
          "github-enrichment-repositories-v1",
          "github-profile-enrichment-v1",
          "tikhub-linkedin-enrichment-v1",
          "tikhub-linkedin-fetch-v1",
          "tikhub-linkedin-normalization-v1",
          "tikhub-linkedin-persistence-v1",
        ].sort(),
      );
      expect(sdk.schedules.map(({ id }) => id).sort()).toEqual(
        [
          "billing-credit-reconciliation-daily-v1",
          "billing-usage-delivery-every-five-minutes-v1",
          "billing-usage-recovery-every-fifteen-minutes-v1",
          "enrichment-checkpoint-cleanup-daily-v1",
          "enrichment-dispatch-recovery-daily-v1",
          "enrichment-refresh-dispatch-producer-daily-v1",
          "github-inaccessible-suppression-daily-v1",
        ].sort(),
      );
      expect(
        Object.fromEntries(
          sdk.schedules.map(({ id, cron }) => [id, cron?.pattern]),
        ),
      ).toEqual({
        "billing-credit-reconciliation-daily-v1": "20 3 * * *",
        "billing-usage-delivery-every-five-minutes-v1": "*/5 * * * *",
        "billing-usage-recovery-every-fifteen-minutes-v1":
          "2,17,32,47 * * * *",
        "enrichment-refresh-dispatch-producer-daily-v1": "5 0 * * *",
        "enrichment-dispatch-recovery-daily-v1": "35 0 * * *",
        "enrichment-checkpoint-cleanup-daily-v1": "5 1 * * *",
        "github-inaccessible-suppression-daily-v1": "5 2 * * *",
      });
      expect(
        sdk.schedules.map(({ cron }) => ({
          timezone: cron?.timezone,
          environments: cron?.environments,
        })),
      ).toEqual(
        Array.from({ length: 7 }, () => ({
          timezone: "UTC",
          environments: ["PRODUCTION"],
        })),
      );
    },
    15_000,
  );
});
