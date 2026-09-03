import { describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  type TaskConfig = {
    id: string;
    queue?: { name: string; concurrencyLimit: number };
    retry?: { maxAttempts: number };
    run: (input: unknown) => Promise<unknown>;
  };
  const configs: TaskConfig[] = [];
  const createIdempotencyKey = vi.fn(async (key: string) => key);
  return { configs, createIdempotencyKey };
});

vi.mock("@trigger.dev/sdk", () => ({
  idempotencyKeys: { create: sdk.createIdempotencyKey },
  task: vi.fn((config: (typeof sdk.configs)[number]) => {
    sdk.configs.push(config);
    return {
      triggerAndWait: (payload: unknown) => ({
        unwrap: () => config.run(payload),
      }),
    };
  }),
}));

import {
  createDeeplineEnrichmentTasks,
  type DeeplineEnrichmentInput,
  type DeeplineRun,
} from "../src/index.js";

const run: DeeplineRun = {
  id: "run-1",
  profileId: "profile-1",
  status: "running",
  completedStages: [],
  currentStage: null,
  startedAt: "2026-09-01T00:00:00.000Z",
};

describe("Deepline Trigger.dev task factory", () => {
  it("registers independently retryable stages and orchestrates them with global idempotency keys", async () => {
    sdk.configs.length = 0;
    sdk.createIdempotencyKey.mockClear();
    const calls: string[] = [];
    const stages = {
      identity: vi.fn(async () => {
        calls.push("identity");
        return run;
      }),
      career: vi.fn(async () => {
        calls.push("career");
        return run;
      }),
      persistence: vi.fn(async () => {
        calls.push("persistence");
        return { ...run, status: "succeeded" as const };
      }),
      retryExhausted: vi.fn(async () => undefined),
    };
    createDeeplineEnrichmentTasks(stages);
    const input: DeeplineEnrichmentInput = {
      profileId: "profile-1",
      runId: "run-1",
      missingFields: [],
    };

    expect(sdk.configs.map(({ id }) => id)).toEqual([
      "deepline-identity-fallback-v1",
      "deepline-career-fallback-v1",
      "deepline-fallback-persistence-v1",
      "deepline-fallback-enrichment-v1",
    ]);
    expect(sdk.configs.slice(0, 2).map(({ queue }) => queue)).toEqual([
      { name: "deepline-provider", concurrencyLimit: 4 },
      { name: "deepline-provider", concurrencyLimit: 4 },
    ]);
    expect(
      sdk.configs.slice(0, 3).map(({ retry }) => retry?.maxAttempts),
    ).toEqual([5, 5, 5]);
    const orchestration = sdk.configs.at(-1);
    await orchestration?.run(input);

    expect(calls).toEqual(["identity", "career", "persistence"]);
    expect(sdk.createIdempotencyKey.mock.calls.map(([key]) => key)).toEqual([
      "run-1:identity",
      "run-1:career",
      "run-1:persistence",
    ]);
  });
});
