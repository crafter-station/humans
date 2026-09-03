import {
  DEEPLINE_CAREER_FIELDS,
  type DEEPLINE_CAREER_TOOL_ID,
  DEEPLINE_FALLBACK_CONFIDENCE,
  DEEPLINE_FIELDS,
  DEEPLINE_IDENTITY_FIELDS,
  type DEEPLINE_IDENTITY_TOOL_ID,
  DEEPLINE_PIPELINE_VERSION,
  DEEPLINE_SNAPSHOT_RETENTION_DAYS,
  DeeplineCheckpointError,
  DeeplineProviderError,
  DeeplineTransportError,
  InvalidDeeplineContractError,
  InvalidDeeplineInputError,
  InvalidDeeplineResultError,
  PermanentDeeplineError,
  type Collected,
  type DeeplineCareerField,
  type DeeplineCareerResult,
  type DeeplineEnrichmentInput,
  type DeeplineField,
  type DeeplineIdentityField,
  type DeeplineIdentityResult,
  type DeeplineObservation,
  type DeeplineProvider,
  type DeeplineProviderResult,
  type DeeplineRun,
  type DeeplineStage,
  type DeeplineStore,
} from "./types.js";

const knownFields = new Set<string>([
  ...DEEPLINE_IDENTITY_FIELDS,
  ...DEEPLINE_CAREER_FIELDS,
]);

const requestedFields = (input: DeeplineEnrichmentInput) => {
  if (
    !Array.isArray(input.missingFields) ||
    input.missingFields.some(
      (field) => typeof field !== "string" || !knownFields.has(field),
    )
  )
    throw new InvalidDeeplineInputError(
      "missingFields contains an unknown field",
    );
  return [...new Set(input.missingFields)];
};

const validStageFields = <TField extends DeeplineField>(
  input: DeeplineEnrichmentInput,
  fields: readonly TField[],
) => {
  if (!Array.isArray(input.missingFields)) return [];
  const supported = new Set<string>(fields);
  return input.missingFields.filter(
    (field): field is TField =>
      typeof field === "string" && supported.has(field),
  );
};

const stageFields = <TField extends DeeplineField>(
  input: DeeplineEnrichmentInput,
  fields: readonly TField[],
) => {
  const supported = new Set<DeeplineField>(fields);
  return requestedFields(input).filter((field): field is TField =>
    supported.has(field),
  );
};

const fallbackFields = async <TField extends DeeplineField>(
  store: DeeplineStore,
  input: DeeplineEnrichmentInput,
  fields: readonly TField[],
) => {
  const requested = stageFields(input, fields);
  if (requested.length === 0) return requested;
  const protectedFields = await store.listProtectedFields(
    input.profileId,
    requested,
  );
  const protectedNames = new Set(protectedFields.map(({ field }) => field));
  return requested.filter((field) => !protectedNames.has(field));
};

export const classifyDeeplineError = (error: unknown) => {
  if (error instanceof PermanentDeeplineError) return "fatal" as const;
  if (!(error instanceof DeeplineProviderError)) return "retry" as const;
  if (error.status === 402) return "billing" as const;
  if (
    (error.status === 429 || error.status === 503) &&
    error.retryAfter !== undefined
  )
    return "rate-limit" as const;
  if (error.status === 429 || error.status === 503 || error.status >= 500)
    return "retry" as const;
  return "fatal" as const;
};

const complete = (run: DeeplineRun, stage: DeeplineStage): DeeplineRun => ({
  ...run,
  completedStages: run.completedStages.includes(stage)
    ? run.completedStages
    : [...run.completedStages, stage],
  currentStage: null,
});

const saveProviderCheckpoint = async <T>(
  store: DeeplineStore,
  runId: string,
  stage: DeeplineStage,
  value: T,
  options: { expiresAt: string },
) => {
  try {
    await store.saveCheckpoint(runId, stage, value, options);
  } catch {
    try {
      await store.saveCheckpoint(runId, stage, value, options);
    } catch {
      throw new DeeplineCheckpointError();
    }
  }
};

const snapshotExpiresAt = (collectedAt: string) =>
  new Date(
    new Date(collectedAt).getTime() +
      DEEPLINE_SNAPSHOT_RETENTION_DAYS * 86_400_000,
  ).toISOString();

type IdentitySnapshot = Collected<
  DeeplineProviderResult<
    DeeplineIdentityResult,
    typeof DEEPLINE_IDENTITY_TOOL_ID
  >
>;
type CareerSnapshot = Collected<
  DeeplineProviderResult<DeeplineCareerResult, typeof DEEPLINE_CAREER_TOOL_ID>
>;

const identityObservations = (
  input: DeeplineEnrichmentInput,
  snapshot: IdentitySnapshot,
  fields: DeeplineIdentityField[],
): DeeplineObservation[] =>
  fields.flatMap((field) => {
    const value = snapshot.value.value[field];
    if (value === null) return [];
    return [
      {
        profileId: input.profileId,
        sourceRecordId: `${input.runId}:${snapshot.value.toolId}:${field}`,
        field,
        value,
        source: "deepline",
        providerToolId: snapshot.value.toolId,
        collectedAt: snapshot.collectedAt,
        confidence: DEEPLINE_FALLBACK_CONFIDENCE,
        pipelineVersion: DEEPLINE_PIPELINE_VERSION,
      },
    ];
  });

const careerObservations = (
  input: DeeplineEnrichmentInput,
  snapshot: CareerSnapshot,
  fields: DeeplineCareerField[],
): DeeplineObservation[] =>
  fields.map((field) => ({
    profileId: input.profileId,
    sourceRecordId: `${snapshot.value.toolId}:${snapshot.value.value.sourceRecordId}:${field}`,
    field,
    value: snapshot.value.value[field],
    source: "deepline",
    providerToolId: snapshot.value.toolId,
    collectedAt: snapshot.collectedAt,
    confidence: DEEPLINE_FALLBACK_CONFIDENCE,
    pipelineVersion: DEEPLINE_PIPELINE_VERSION,
  }));

export type DeeplineEnrichmentDependencies = {
  provider: DeeplineProvider;
  store: DeeplineStore;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
};

export const createDeeplineEnrichmentStages = (
  dependencies: DeeplineEnrichmentDependencies,
) => {
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? console.info;
  const logRun = (
    input: DeeplineEnrichmentInput,
    run: DeeplineRun,
    terminalClassification: string,
    finishedAt: string,
  ) =>
    log({
      event: "enrichment_run",
      profileId: input.profileId,
      runId: input.runId,
      provider: "deepline",
      stage: run.currentStage,
      durationMs: Math.max(
        0,
        new Date(finishedAt).getTime() - new Date(run.startedAt).getTime(),
      ),
      attempts: run.completedStages.length + 1,
      costMetadata: null,
      pipelineVersion: DEEPLINE_PIPELINE_VERSION,
      terminalClassification,
    });

  const getRun = async (
    input: DeeplineEnrichmentInput,
    stage: DeeplineStage,
  ) => {
    let run = await dependencies.store.getOrCreateRun(
      input.profileId,
      input.runId,
      now().toISOString(),
    );
    if (run.status === "succeeded") return run;
    run = {
      ...run,
      status: "running",
      currentStage: stage,
      error: undefined,
      finishedAt: undefined,
    };
    await dependencies.store.saveRun(run);
    return run;
  };

  const fail = async (
    input: DeeplineEnrichmentInput,
    run: DeeplineRun,
    error: unknown,
  ) => {
    const failedAt = now().toISOString();
    const affectedFields =
      run.currentStage === "identity"
        ? validStageFields(input, DEEPLINE_IDENTITY_FIELDS)
        : run.currentStage === "career"
          ? validStageFields(input, DEEPLINE_CAREER_FIELDS)
          : [];
    const providerRefreshFailed =
      error instanceof DeeplineCheckpointError ||
      error instanceof DeeplineProviderError ||
      error instanceof DeeplineTransportError ||
      error instanceof InvalidDeeplineContractError ||
      error instanceof InvalidDeeplineResultError;
    if (providerRefreshFailed && affectedFields.length > 0)
      await dependencies.store.markDeeplineObservationsStale(
        input.profileId,
        affectedFields,
        failedAt,
      );
    const classification = classifyDeeplineError(error);
    const retrying =
      classification === "retry" || classification === "rate-limit";
    await dependencies.store.saveRun({
      ...run,
      status: retrying ? "running" : "failed",
      currentStage: retrying ? run.currentStage : null,
      error:
        error instanceof Error
          ? error.message
          : "Unknown Deepline enrichment failure",
      finishedAt: retrying ? undefined : failedAt,
    });
    logRun(input, run, classification, failedAt);
    throw error;
  };

  const identity = async (input: DeeplineEnrichmentInput) => {
    let run = await getRun(input, "identity");
    if (run.status === "succeeded") return run;
    try {
      const fields = await fallbackFields(
        dependencies.store,
        input,
        DEEPLINE_IDENTITY_FIELDS,
      );
      if (fields.length > 0) {
        let snapshot =
          await dependencies.store.loadCheckpoint<IdentitySnapshot>(
            run.id,
            "identity",
          );
        if (!snapshot) {
          if (input.identity === undefined)
            throw new InvalidDeeplineInputError(
              "identity is required for identity fallback",
            );
          snapshot = {
            value: await dependencies.provider.resolveIdentity(input.identity),
            collectedAt: now().toISOString(),
          };
          await saveProviderCheckpoint(
            dependencies.store,
            run.id,
            "identity",
            snapshot,
            {
              expiresAt: snapshotExpiresAt(snapshot.collectedAt),
            },
          );
        }
      }
      run = complete(run, "identity");
      await dependencies.store.saveRun(run);
      return run;
    } catch (error) {
      return fail(input, run, error);
    }
  };

  const career = async (input: DeeplineEnrichmentInput) => {
    let run = await getRun(input, "career");
    if (run.status === "succeeded") return run;
    try {
      const fields = await fallbackFields(
        dependencies.store,
        input,
        DEEPLINE_CAREER_FIELDS,
      );
      if (fields.length > 0) {
        let snapshot = await dependencies.store.loadCheckpoint<CareerSnapshot>(
          run.id,
          "career",
        );
        if (!snapshot) {
          const identitySnapshot =
            await dependencies.store.loadCheckpoint<IdentitySnapshot>(
              run.id,
              "identity",
            );
          const linkedInUrl =
            input.linkedInUrl ?? identitySnapshot?.value.value.linkedinUrl;
          if (linkedInUrl === undefined || linkedInUrl === null)
            throw new InvalidDeeplineInputError(
              "linkedInUrl is required for career fallback",
            );
          snapshot = {
            value: await dependencies.provider.getLinkedInCareer(linkedInUrl),
            collectedAt: now().toISOString(),
          };
          await saveProviderCheckpoint(
            dependencies.store,
            run.id,
            "career",
            snapshot,
            {
              expiresAt: snapshotExpiresAt(snapshot.collectedAt),
            },
          );
        }
      }
      run = complete(run, "career");
      await dependencies.store.saveRun(run);
      return run;
    } catch (error) {
      return fail(input, run, error);
    }
  };

  const persistence = async (input: DeeplineEnrichmentInput) => {
    let run = await getRun(input, "persistence");
    if (run.status === "succeeded") return run;
    try {
      const done = await dependencies.store.loadCheckpoint<boolean>(
        run.id,
        "persistence",
      );
      if (!done) {
        const [identityFields, careerFields, identitySnapshot, careerSnapshot] =
          await Promise.all([
            fallbackFields(dependencies.store, input, DEEPLINE_IDENTITY_FIELDS),
            fallbackFields(dependencies.store, input, DEEPLINE_CAREER_FIELDS),
            dependencies.store.loadCheckpoint<IdentitySnapshot>(
              run.id,
              "identity",
            ),
            dependencies.store.loadCheckpoint<CareerSnapshot>(run.id, "career"),
          ]);
        const observations = [
          ...(identitySnapshot
            ? identityObservations(input, identitySnapshot, identityFields)
            : []),
          ...(careerSnapshot
            ? careerObservations(input, careerSnapshot, careerFields)
            : []),
        ];
        if (observations.length > 0)
          await dependencies.store.persistObservations(run.id, observations);
        await dependencies.store.saveCheckpoint(run.id, "persistence", true);
      }
      const finishedAt = now().toISOString();
      run = {
        ...complete(run, "persistence"),
        status: "succeeded",
        finishedAt,
      };
      await dependencies.store.saveRun(run);
      logRun(input, run, "succeeded", finishedAt);
      return run;
    } catch (error) {
      return fail(input, run, error);
    }
  };

  const retryExhausted = async (
    input: DeeplineEnrichmentInput,
    error: unknown,
  ) => {
    const run = await dependencies.store.getRun(input.runId);
    if (run?.status !== "running") return;
    const finishedAt = now().toISOString();
    const affectedFields =
      run.currentStage === "identity"
        ? validStageFields(input, DEEPLINE_IDENTITY_FIELDS)
        : run.currentStage === "career"
          ? validStageFields(input, DEEPLINE_CAREER_FIELDS)
          : validStageFields(input, DEEPLINE_FIELDS);
    if (affectedFields.length > 0)
      await dependencies.store.markDeeplineObservationsStale(
        input.profileId,
        affectedFields,
        finishedAt,
      );
    await dependencies.store.saveRun({
      ...run,
      status: "failed",
      currentStage: null,
      error:
        error instanceof Error ? error.message : "Deepline retries exhausted",
      finishedAt,
    });
    logRun(input, run, "retries_exhausted", finishedAt);
  };

  return { identity, career, persistence, retryExhausted };
};

export const createDeeplineEnrichmentWorkflow = (
  dependencies: DeeplineEnrichmentDependencies,
) => {
  const stages = createDeeplineEnrichmentStages(dependencies);
  return async (input: DeeplineEnrichmentInput) => {
    await stages.identity(input);
    await stages.career(input);
    return stages.persistence(input);
  };
};
