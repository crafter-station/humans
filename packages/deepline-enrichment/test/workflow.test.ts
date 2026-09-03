import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEEPLINE_CAREER_TOOL_ID,
  DEEPLINE_IDENTITY_TOOL_ID,
  DEEPLINE_PIPELINE_VERSION,
  DEEPLINE_SNAPSHOT_RETENTION_DAYS,
  DeeplineCheckpointError,
  DeeplineProviderError,
  InvalidDeeplineInputError,
  createDeeplineEnrichmentStages,
  createDeeplineEnrichmentWorkflow,
  retryOptionsForDeeplineError,
  type DeeplineEnrichmentInput,
  type DeeplineField,
  type DeeplineObservation,
  type DeeplineProvider,
  type DeeplineRun,
  type DeeplineStage,
  type DeeplineStore,
  type ProtectedDeeplineField,
} from "../src/index.js";

class MemoryStore implements DeeplineStore {
  run?: DeeplineRun;
  checkpoints = new Map<string, unknown>();
  expirations = new Map<string, string>();
  protectedFields: ProtectedDeeplineField[] = [];
  observations: DeeplineObservation[] = [];
  stale: Array<{ fields: DeeplineField[]; at: string }> = [];
  persistedRunIds = new Set<string>();
  persistCalls = 0;
  failPersistenceCheckpointOnce = false;
  identityCheckpointFailures = 0;

  async getRun(runId: string) {
    return this.run?.id === runId ? structuredClone(this.run) : undefined;
  }

  async getOrCreateRun(profileId: string, runId: string, startedAt: string) {
    return (
      this.run ?? {
        id: runId,
        profileId,
        status: "pending" as const,
        completedStages: [],
        currentStage: null,
        startedAt,
      }
    );
  }

  async saveRun(run: DeeplineRun) {
    this.run = structuredClone(run);
  }

  async loadCheckpoint<T>(runId: string, stage: DeeplineStage) {
    return this.checkpoints.get(`${runId}:${stage}`) as T | undefined;
  }

  async saveCheckpoint<T>(
    runId: string,
    stage: DeeplineStage,
    value: T,
    options?: { expiresAt?: string },
  ) {
    if (stage === "identity" && this.identityCheckpointFailures-- > 0)
      throw new Error("checkpoint unavailable");
    if (stage === "persistence" && this.failPersistenceCheckpointOnce) {
      this.failPersistenceCheckpointOnce = false;
      throw new Error("checkpoint unavailable");
    }
    this.checkpoints.set(`${runId}:${stage}`, structuredClone(value));
    if (options?.expiresAt)
      this.expirations.set(`${runId}:${stage}`, options.expiresAt);
  }

  async listProtectedFields(_profileId: string, fields: DeeplineField[]) {
    const requested = new Set(fields);
    return this.protectedFields.filter(({ field }) => requested.has(field));
  }

  async persistObservations(
    runId: string,
    observations: DeeplineObservation[],
  ) {
    this.persistCalls += 1;
    if (this.persistedRunIds.has(runId)) return;
    this.persistedRunIds.add(runId);
    this.observations.push(...structuredClone(observations));
  }

  async markDeeplineObservationsStale(
    _profileId: string,
    fields: DeeplineField[],
    at: string,
  ) {
    this.stale.push({ fields: [...fields], at });
  }
}

const fixedNow = () => new Date("2026-09-01T00:00:00.000Z");
const silentLog = () => undefined;
const input: DeeplineEnrichmentInput = {
  profileId: "profile-1",
  runId: "run-1",
  missingFields: [
    "linkedinUrl",
    "githubUrl",
    "headline",
    "currentPosition",
    "experience",
    "education",
    "skills",
  ],
  identity: {
    fullName: "Ada Lovelace",
    companyName: "Analytical Engines",
    companyDomain: "analytical.example",
  },
};

const provider = (): DeeplineProvider => ({
  resolveIdentity: vi.fn(async () => ({
    toolId: DEEPLINE_IDENTITY_TOOL_ID,
    raw: { meta: { requestId: "sanitized-identity-request" } },
    value: {
      linkedinUrl: "https://www.linkedin.com/in/ada-lovelace",
      githubUrl: "https://github.com/ada",
      xUrl: "https://x.com/ada",
    },
  })),
  getLinkedInCareer: vi.fn(async () => ({
    toolId: DEEPLINE_CAREER_TOOL_ID,
    raw: { meta: { requestId: "sanitized-career-request" } },
    value: {
      sourceRecordId: "linkedin:ada-lovelace",
      headline: "Staff Software Engineer",
      currentPosition: [
        {
          companyName: "Analytical Engines",
          position: "Staff Software Engineer",
        },
      ],
      experience: [
        {
          companyName: "Analytical Engines",
          position: "Staff Software Engineer",
        },
      ],
      education: [
        {
          schoolName: "University of London",
          degree: "Mathematics",
        },
      ],
      skills: ["TypeScript", "Distributed Systems"],
    },
  })),
});

describe("Deepline fallback workflow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not call Deepline without an explicit missing field or when direct data covers every request", async () => {
    const noMissingProvider = provider();
    const noMissingStore = new MemoryStore();
    await createDeeplineEnrichmentWorkflow({
      provider: noMissingProvider,
      store: noMissingStore,
      now: fixedNow,
      log: silentLog,
    })({ ...input, runId: "none", missingFields: [] });
    expect(noMissingProvider.resolveIdentity).not.toHaveBeenCalled();
    expect(noMissingProvider.getLinkedInCareer).not.toHaveBeenCalled();
    expect(noMissingStore.observations).toEqual([]);

    const coveredProvider = provider();
    const coveredStore = new MemoryStore();
    coveredStore.protectedFields = input.missingFields.map((field, index) => ({
      field,
      source:
        index % 3 === 0 ? "member" : index % 3 === 1 ? "github" : "tikhub",
    }));
    await createDeeplineEnrichmentWorkflow({
      provider: coveredProvider,
      store: coveredStore,
      now: fixedNow,
      log: silentLog,
    })({ ...input, runId: "covered" });
    expect(coveredProvider.resolveIdentity).not.toHaveBeenCalled();
    expect(coveredProvider.getLinkedInCareer).not.toHaveBeenCalled();
    expect(coveredStore.observations).toEqual([]);
  });

  it("persists only missing fallback Observations with Deepline provenance", async () => {
    const store = new MemoryStore();
    store.protectedFields = [
      { field: "githubUrl", source: "github" },
      { field: "headline", source: "member" },
      { field: "education", source: "tikhub" },
    ];
    const api = provider();

    const run = await createDeeplineEnrichmentWorkflow({
      provider: api,
      store,
      now: fixedNow,
      log: silentLog,
    })(input);

    expect(run).toMatchObject({
      status: "succeeded",
      completedStages: ["identity", "career", "persistence"],
    });
    expect(api.resolveIdentity).toHaveBeenCalledTimes(1);
    expect(api.getLinkedInCareer).toHaveBeenCalledTimes(1);
    expect(api.getLinkedInCareer).toHaveBeenCalledWith(
      "https://www.linkedin.com/in/ada-lovelace",
    );
    expect(store.observations.map(({ field }) => field)).toEqual([
      "linkedinUrl",
      "currentPosition",
      "experience",
      "skills",
    ]);
    expect(store.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "deepline",
          providerToolId: DEEPLINE_IDENTITY_TOOL_ID,
          collectedAt: fixedNow().toISOString(),
          pipelineVersion: DEEPLINE_PIPELINE_VERSION,
          confidence: 0.8,
        }),
        expect.objectContaining({
          source: "deepline",
          providerToolId: DEEPLINE_CAREER_TOOL_ID,
          collectedAt: fixedNow().toISOString(),
          pipelineVersion: DEEPLINE_PIPELINE_VERSION,
          confidence: 0.8,
        }),
      ]),
    );
    const expiresAt = new Date(
      fixedNow().getTime() + DEEPLINE_SNAPSHOT_RETENTION_DAYS * 86_400_000,
    ).toISOString();
    expect(store.expirations.get("run-1:identity")).toBe(expiresAt);
    expect(store.expirations.get("run-1:career")).toBe(expiresAt);
    expect(store.expirations.has("run-1:persistence")).toBe(false);
    expect(store.checkpoints.get("run-1:identity")).toMatchObject({
      value: { raw: { meta: { requestId: "sanitized-identity-request" } } },
    });
  });

  it("rechecks precedence before persistence when stronger data arrives mid-run", async () => {
    const store = new MemoryStore();
    const stages = createDeeplineEnrichmentStages({
      provider: provider(),
      store,
      now: fixedNow,
      log: silentLog,
    });
    const careerOnly = {
      ...input,
      runId: "precedence-race",
      missingFields: ["skills"] as DeeplineField[],
      linkedInUrl: "https://www.linkedin.com/in/ada-lovelace",
    };

    await stages.identity(careerOnly);
    await stages.career(careerOnly);
    store.protectedFields = [{ field: "skills", source: "tikhub" }];
    await stages.persistence(careerOnly);

    expect(store.observations).toEqual([]);
  });

  it("reuses provider checkpoints and keeps persistence idempotent across retries", async () => {
    const store = new MemoryStore();
    store.failPersistenceCheckpointOnce = true;
    const api = provider();
    const workflow = createDeeplineEnrichmentWorkflow({
      provider: api,
      store,
      now: fixedNow,
      log: silentLog,
    });
    const retryInput = { ...input, runId: "retry" };

    await expect(workflow(retryInput)).rejects.toThrow(
      "checkpoint unavailable",
    );
    await expect(workflow(retryInput)).resolves.toMatchObject({
      status: "succeeded",
    });

    expect(api.resolveIdentity).toHaveBeenCalledTimes(1);
    expect(api.getLinkedInCareer).toHaveBeenCalledTimes(1);
    expect(store.persistCalls).toBe(2);
    expect(store.persistedRunIds).toEqual(new Set(["retry"]));
    expect(new Set(store.observations.map(({ field }) => field))).toHaveLength(
      store.observations.length,
    );
  });

  it("does not repeat a paid provider operation when its first checkpoint write fails", async () => {
    const store = new MemoryStore();
    store.identityCheckpointFailures = 1;
    const api = provider();

    await expect(
      createDeeplineEnrichmentWorkflow({
        provider: api,
        store,
        now: fixedNow,
        log: silentLog,
      })({ ...input, runId: "provider-checkpoint-retry" }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(api.resolveIdentity).toHaveBeenCalledTimes(1);
    expect(api.getLinkedInCareer).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a paid provider checkpoint cannot be persisted", async () => {
    const store = new MemoryStore();
    store.identityCheckpointFailures = 2;
    const api = provider();

    const error = await createDeeplineEnrichmentWorkflow({
      provider: api,
      store,
      now: fixedNow,
      log: silentLog,
    })({ ...input, runId: "provider-checkpoint-failure" }).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(DeeplineCheckpointError);
    expect(retryOptionsForDeeplineError(error)).toEqual({
      skipRetrying: true,
    });
    expect(api.resolveIdentity).toHaveBeenCalledTimes(1);
    expect(api.getLinkedInCareer).not.toHaveBeenCalled();
    expect(store.stale).toEqual([
      {
        fields: ["linkedinUrl", "githubUrl"],
        at: fixedNow().toISOString(),
      },
    ]);
    expect(store.run).toMatchObject({ status: "failed", currentStage: null });
  });

  it("keeps retryable provider failures non-terminal, marks only Deepline fields stale, and emits safe logs", async () => {
    const store = new MemoryStore();
    const api = provider();
    api.resolveIdentity = vi.fn(async () => {
      throw new DeeplineProviderError(
        "Deepline request failed with status 503",
        503,
      );
    });
    const log = vi.fn();

    await expect(
      createDeeplineEnrichmentWorkflow({
        provider: api,
        store,
        now: fixedNow,
        log,
      })({
        ...input,
        runId: "unavailable",
        missingFields: ["githubUrl"],
      }),
    ).rejects.toThrow("status 503");

    expect(store.run).toMatchObject({
      status: "running",
      currentStage: "identity",
    });
    expect(store.stale).toEqual([
      { fields: ["githubUrl"], at: fixedNow().toISOString() },
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepline",
        terminalClassification: "retry",
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("Ada Lovelace");
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "sanitized-identity-request",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "sanitized-career-request",
    );
  });

  it("makes malformed fallback requests terminal without staling prior provider evidence", async () => {
    const store = new MemoryStore();
    const malformedInput = {
      ...input,
      runId: "malformed-input",
      missingFields: ["unknown-field"],
    } as unknown as DeeplineEnrichmentInput;

    await expect(
      createDeeplineEnrichmentWorkflow({
        provider: provider(),
        store,
        now: fixedNow,
        log: () => undefined,
      })(malformedInput),
    ).rejects.toBeInstanceOf(InvalidDeeplineInputError);
    expect(store.run).toMatchObject({ status: "failed", currentStage: null });
    expect(store.stale).toEqual([]);
  });

  it("marks prior fallback Observations stale when persistence retries are exhausted", async () => {
    const store = new MemoryStore();
    store.run = {
      id: "terminal-persistence",
      profileId: input.profileId,
      status: "running",
      completedStages: ["identity", "career"],
      currentStage: "persistence",
      startedAt: fixedNow().toISOString(),
    };
    const stages = createDeeplineEnrichmentStages({
      provider: provider(),
      store,
      now: fixedNow,
      log: silentLog,
    });

    await stages.retryExhausted(
      { ...input, runId: "terminal-persistence" },
      new Error("retries exhausted"),
    );

    expect(store.stale).toEqual([
      { fields: input.missingFields, at: fixedNow().toISOString() },
    ]);
    expect(store.run).toMatchObject({
      status: "failed",
      currentStage: null,
      error: "retries exhausted",
    });
  });
});
