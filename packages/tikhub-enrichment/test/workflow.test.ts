import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/linkedin-profile.json" with { type: "json" };
import {
  InvalidTikHubPayloadError,
  TIKHUB_PIPELINE_VERSION,
  TIKHUB_SNAPSHOT_RETENTION_DAYS,
  TikHubProviderError,
  createTikHubEnrichmentStages,
  createTikHubEnrichmentWorkflow,
  retryOptionsForTikHubError,
  type TikHubObservation,
  type TikHubRun,
  type TikHubStage,
  type TikHubStore,
} from "../src/index.js";

class MemoryStore implements TikHubStore {
  run?: TikHubRun;
  checkpoints = new Map<string, unknown>();
  expirations = new Map<string, string>();
  observations: TikHubObservation[] = [];
  staleAt?: string;
  persistFailures = 0;
  async getRun(runId: string) {
    return this.run?.id === runId ? structuredClone(this.run) : undefined;
  }
  async getOrCreateRun(profileId: string, runId: string, startedAt: string) {
    return (
      this.run ?? {
        id: runId,
        profileId,
        status: "pending",
        completedStages: [],
        currentStage: null,
        startedAt,
      }
    );
  }
  async saveRun(run: TikHubRun) {
    this.run = structuredClone(run);
  }
  async loadCheckpoint<T>(runId: string, stage: TikHubStage) {
    return this.checkpoints.get(`${runId}:${stage}`) as T | undefined;
  }
  async saveCheckpoint<T>(
    runId: string,
    stage: TikHubStage,
    value: T,
    options?: { expiresAt?: string },
  ) {
    this.checkpoints.set(`${runId}:${stage}`, structuredClone(value));
    if (options?.expiresAt)
      this.expirations.set(`${runId}:${stage}`, options.expiresAt);
  }
  async persistObservations(_runId: string, observations: TikHubObservation[]) {
    if (this.persistFailures-- > 0) throw new Error("database unavailable");
    this.observations = observations;
  }
  async markTikHubObservationsStale(_profileId: string, at: string) {
    this.staleAt = at;
  }
}
const fixedNow = () => new Date("2026-09-01T00:00:00.000Z");
const input = {
  profileId: "profile-1",
  linkedInUrl: "https://linkedin.com/in/ada",
  runId: "run-1",
};
const provider = () => ({ getLinkedInProfile: vi.fn(async () => fixture) });

describe("TikHub LinkedIn enrichment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves career evidence and only accepted professional Contact Details", async () => {
    const store = new MemoryStore();
    const run = await createTikHubEnrichmentWorkflow({
      provider: provider(),
      store,
      now: fixedNow,
    })(input);
    expect(run).toMatchObject({
      status: "succeeded",
      completedStages: ["fetch", "normalization", "persistence"],
    });
    expect(store.observations).toHaveLength(3);
    expect(store.observations[0]).toMatchObject({
      sourceRecordId: "linkedin:ada-lovelace",
      sourceIdentity: "tikhub",
      sourceCategory: "professional-network",
      collectedAt: fixedNow().toISOString(),
      confidence: 1,
      pipelineVersion: TIKHUB_PIPELINE_VERSION,
      value: {
        headline: "Staff Software Engineer",
        currentCompany: "Analytical Engines",
        skills: ["TypeScript", "Distributed Systems"],
      },
    });
    expect(
      store.observations
        .filter(({ kind }) => kind === "contact-detail")
        .map(({ value }) => value),
    ).toEqual([
      { type: "professional-email", value: "ada@analytical.example" },
      { type: "direct-professional-phone", value: "+51 999 555 111" },
    ]);
    expect(store.expirations.get("run-1:fetch")).toBe(
      new Date(
        fixedNow().getTime() + TIKHUB_SNAPSHOT_RETENTION_DAYS * 86_400_000,
      ).toISOString(),
    );
    expect(store.expirations.has("run-1:normalization")).toBe(false);
  });

  it("rejects malformed provider payloads at the provider boundary", async () => {
    const store = new MemoryStore();
    const badProvider = {
      getLinkedInProfile: vi.fn(async () => ({
        ...fixture,
        skills: "TypeScript",
      })),
    };
    await expect(
      createTikHubEnrichmentWorkflow({
        provider: badProvider,
        store,
        now: fixedNow,
      })(input),
    ).rejects.toThrow(InvalidTikHubPayloadError);
    expect(store.observations).toEqual([]);
    expect(store.run).toMatchObject({ status: "failed", currentStage: null });
  });

  it("retries late failures without fetching again and marks previous Observations stale on provider failure", async () => {
    const store = new MemoryStore();
    store.persistFailures = 1;
    const api = provider();
    const workflow = createTikHubEnrichmentWorkflow({
      provider: api,
      store,
      now: fixedNow,
    });
    await expect(workflow(input)).rejects.toThrow("database unavailable");
    await expect(workflow(input)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(api.getLinkedInProfile).toHaveBeenCalledTimes(1);

    const failedStore = new MemoryStore();
    const failedProvider = {
      getLinkedInProfile: vi.fn(async () => {
        throw new TikHubProviderError("unavailable", 503);
      }),
    };
    await expect(
      createTikHubEnrichmentWorkflow({
        provider: failedProvider,
        store: failedStore,
        now: fixedNow,
      })(input),
    ).rejects.toThrow("unavailable");
    expect(failedStore.staleAt).toBe(fixedNow().toISOString());
    expect(failedStore.run).toMatchObject({
      status: "running",
      currentStage: "fetch",
    });
  });

  it("supports independent stages, rate limits, and terminal retry exhaustion", async () => {
    const store = new MemoryStore();
    const stages = createTikHubEnrichmentStages({
      provider: provider(),
      store,
      now: fixedNow,
    });
    await stages.fetch(input);
    expect(store.run).toMatchObject({ completedStages: ["fetch"] });
    await stages.normalization(input);
    await stages.persistence(input);
    expect(store.run?.status).toBe("succeeded");
    expect(
      retryOptionsForTikHubError(
        new TikHubProviderError(
          "limited",
          429,
          new Date("2026-09-01T00:01:00Z"),
        ),
      ),
    ).toEqual({ retryAt: new Date("2026-09-01T00:01:00Z") });
    expect(
      retryOptionsForTikHubError(new InvalidTikHubPayloadError("bad")),
    ).toEqual({ skipRetrying: true });

    store.run = { ...store.run!, status: "running", currentStage: "fetch" };
    await stages.retryExhausted(input, new Error("retries exhausted"));
    expect(store.run).toMatchObject({
      status: "failed",
      currentStage: null,
      error: "retries exhausted",
      finishedAt: fixedNow().toISOString(),
    });
  });
});
