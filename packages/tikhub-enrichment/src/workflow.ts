import {
  InvalidTikHubPayloadError,
  TIKHUB_PIPELINE_VERSION,
  TIKHUB_SNAPSHOT_RETENTION_DAYS,
  TikHubProviderError,
  type CareerEntry,
  type Collected,
  type ProviderContactCandidate,
  type PublicTikHubObservation,
  type TikHubEnrichmentInput,
  type TikHubEvidence,
  type TikHubObservation,
  type TikHubProfile,
  type TikHubRun,
  type TikHubStage,
  type TikHubStore,
  type TikHubProvider,
} from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown, field: string) => {
  if (value === null || typeof value === "string") return value;
  throw new InvalidTikHubPayloadError(`Invalid ${field}`);
};

const careerEntries = (value: unknown, field: string): CareerEntry[] => {
  if (!Array.isArray(value))
    throw new InvalidTikHubPayloadError(`Invalid ${field}`);
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.sourceRecordId !== "string" ||
      typeof item.organization !== "string"
    )
      throw new InvalidTikHubPayloadError(`Invalid ${field} entry`);
    for (const key of ["title", "field", "startedAt", "endedAt"] as const)
      if (item[key] !== undefined && typeof item[key] !== "string")
        throw new InvalidTikHubPayloadError(`Invalid ${field} entry`);
    const { title, startedAt, endedAt } = item as {
      title?: string;
      startedAt?: string;
      endedAt?: string;
    };
    const educationField = item.field as string | undefined;
    return {
      sourceRecordId: item.sourceRecordId,
      organization: item.organization,
      ...(title === undefined ? {} : { title }),
      ...(educationField === undefined ? {} : { field: educationField }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
    };
  });
};

const isSupportedContact = (contact: ProviderContactCandidate) =>
  contact.category === "professional" &&
  contact.verification === "provider-verified" &&
  (contact.type === "email" || contact.direct === true);

const contacts = (value: unknown): ProviderContactCandidate[] => {
  if (!Array.isArray(value))
    throw new InvalidTikHubPayloadError("Invalid contacts");
  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.sourceRecordId !== "string" ||
      (item.type !== "email" && item.type !== "phone") ||
      typeof item.value !== "string" ||
      !["professional", "personal", "unknown"].includes(
        String(item.category),
      ) ||
      !["provider-verified", "inferred", "unverified"].includes(
        String(item.verification),
      ) ||
      (item.direct !== undefined && typeof item.direct !== "boolean")
    )
      throw new InvalidTikHubPayloadError("Invalid contact entry");
    const contact = item as ProviderContactCandidate;
    return isSupportedContact(contact) ? [contact] : [];
  });
};

/** Validates the provider contract before any data can enter the domain. */
export const parseTikHubProfile = (payload: unknown): TikHubProfile => {
  if (!isRecord(payload) || typeof payload.sourceRecordId !== "string")
    throw new InvalidTikHubPayloadError("Invalid profile payload");
  if (
    !Array.isArray(payload.skills) ||
    payload.skills.some((skill) => typeof skill !== "string")
  )
    throw new InvalidTikHubPayloadError("Invalid skills");
  return {
    sourceRecordId: payload.sourceRecordId,
    headline: stringOrNull(payload.headline, "headline"),
    currentCompany: stringOrNull(payload.currentCompany, "currentCompany"),
    experience: careerEntries(payload.experience, "experience"),
    education: careerEntries(payload.education, "education"),
    skills: payload.skills,
    contacts: contacts(payload.contacts),
  };
};

export const normalizeTikHubEvidence = (
  profile: TikHubProfile,
): TikHubEvidence => ({
  sourceRecordId: profile.sourceRecordId,
  headline: profile.headline,
  currentCompany: profile.currentCompany,
  experience: profile.experience,
  education: profile.education,
  skills: profile.skills,
  contactDetails: profile.contacts.flatMap((contact) => {
    if (!isSupportedContact(contact)) return [];
    return [
      {
        sourceRecordId: contact.sourceRecordId,
        type:
          contact.type === "email"
            ? ("professional-email" as const)
            : ("direct-professional-phone" as const),
        value: contact.value,
      },
    ];
  }),
});

export const toPublicTikHubObservation = (
  observation: TikHubObservation,
): PublicTikHubObservation => {
  const { sourceIdentity, ...publicObservation } = observation;
  void sourceIdentity;
  return publicObservation;
};

export const classifyTikHubError = (error: unknown) => {
  if (error instanceof InvalidTikHubPayloadError) return "fatal" as const;
  if (!(error instanceof TikHubProviderError)) return "retry" as const;
  if ((error.status === 429 || error.status === 403) && error.retryAfter)
    return "rate-limit" as const;
  if (error.status === 429 || error.status >= 500) return "retry" as const;
  return "fatal" as const;
};

const complete = (run: TikHubRun, stage: TikHubStage): TikHubRun => ({
  ...run,
  completedStages: run.completedStages.includes(stage)
    ? run.completedStages
    : [...run.completedStages, stage],
  currentStage: null,
});

const observationsFor = (
  profileId: string,
  evidence: Collected<TikHubEvidence>,
): TikHubObservation[] => {
  const base = {
    profileId,
    sourceIdentity: "tikhub" as const,
    sourceCategory: "professional-network" as const,
    collectedAt: evidence.collectedAt,
    pipelineVersion: TIKHUB_PIPELINE_VERSION,
  } as const;
  const { contactDetails, ...career } = evidence.value;
  return [
    {
      ...base,
      sourceRecordId: career.sourceRecordId,
      kind: "linkedin-career",
      confidence: 1,
      value: career,
    },
    ...contactDetails.map(({ sourceRecordId, ...value }) => ({
      ...base,
      sourceRecordId,
      kind: "contact-detail" as const,
      confidence: 1,
      value,
    })),
  ];
};

export const createTikHubEnrichmentStages = (dependencies: {
  provider: TikHubProvider;
  store: TikHubStore;
  now?: () => Date;
}) => {
  const now = dependencies.now ?? (() => new Date());
  const getRun = async (input: TikHubEnrichmentInput, stage: TikHubStage) => {
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
    input: TikHubEnrichmentInput,
    run: TikHubRun,
    error: unknown,
  ) => {
    const failedAt = now().toISOString();
    if (run.currentStage === "fetch")
      await dependencies.store.markTikHubObservationsStale(
        input.profileId,
        failedAt,
      );
    const retrying = classifyTikHubError(error) !== "fatal";
    await dependencies.store.saveRun({
      ...run,
      status: retrying ? "running" : "failed",
      currentStage: retrying ? run.currentStage : null,
      error:
        error instanceof Error
          ? error.message
          : "Unknown TikHub enrichment failure",
      finishedAt: retrying ? undefined : failedAt,
    });
    throw error;
  };
  const fetch = async (input: TikHubEnrichmentInput) => {
    let run = await getRun(input, "fetch");
    if (run.status === "succeeded") return run;
    try {
      let snapshot = await dependencies.store.loadCheckpoint<
        Collected<unknown>
      >(run.id, "fetch");
      if (!snapshot) {
        const value = await dependencies.provider.getLinkedInProfile(
          input.linkedInUrl,
        );
        parseTikHubProfile(value);
        const collected = { value, collectedAt: now().toISOString() };
        snapshot = collected;
        await dependencies.store.saveCheckpoint(run.id, "fetch", collected, {
          expiresAt: new Date(
            new Date(collected.collectedAt).getTime() +
              TIKHUB_SNAPSHOT_RETENTION_DAYS * 86_400_000,
          ).toISOString(),
        });
      }
      run = complete(run, "fetch");
      await dependencies.store.saveRun(run);
      return run;
    } catch (error) {
      return fail(input, run, error);
    }
  };
  const normalization = async (input: TikHubEnrichmentInput) => {
    let run = await getRun(input, "normalization");
    if (run.status === "succeeded") return run;
    try {
      const snapshot = await dependencies.store.loadCheckpoint<
        Collected<unknown>
      >(run.id, "fetch");
      if (!snapshot)
        throw new InvalidTikHubPayloadError("Fetch stage must complete first");
      let normalized = await dependencies.store.loadCheckpoint<
        Collected<TikHubEvidence>
      >(run.id, "normalization");
      if (!normalized) {
        normalized = {
          value: normalizeTikHubEvidence(parseTikHubProfile(snapshot.value)),
          collectedAt: snapshot.collectedAt,
        };
        await dependencies.store.saveCheckpoint(
          run.id,
          "normalization",
          normalized,
        );
      }
      run = complete(run, "normalization");
      await dependencies.store.saveRun(run);
      return run;
    } catch (error) {
      return fail(input, run, error);
    }
  };
  const persistence = async (input: TikHubEnrichmentInput) => {
    let run = await getRun(input, "persistence");
    if (run.status === "succeeded") return run;
    try {
      const done = await dependencies.store.loadCheckpoint<boolean>(
        run.id,
        "persistence",
      );
      if (!done) {
        const evidence = await dependencies.store.loadCheckpoint<
          Collected<TikHubEvidence>
        >(run.id, "normalization");
        if (!evidence)
          throw new InvalidTikHubPayloadError(
            "Normalization stage must complete first",
          );
        await dependencies.store.persistObservations(
          run.id,
          observationsFor(input.profileId, evidence),
        );
        await dependencies.store.saveCheckpoint(run.id, "persistence", true);
      }
      run = {
        ...complete(run, "persistence"),
        status: "succeeded",
        finishedAt: now().toISOString(),
      };
      await dependencies.store.saveRun(run);
      return run;
    } catch (error) {
      return fail(input, run, error);
    }
  };
  const retryExhausted = async (
    input: TikHubEnrichmentInput,
    error: unknown,
  ) => {
    const run = await dependencies.store.getRun(input.runId);
    if (!run || run.status !== "running") return;
    await dependencies.store.saveRun({
      ...run,
      status: "failed",
      currentStage: null,
      error:
        error instanceof Error ? error.message : "TikHub retries exhausted",
      finishedAt: now().toISOString(),
    });
  };
  return { fetch, normalization, persistence, retryExhausted };
};

export const createTikHubEnrichmentWorkflow = (
  dependencies: Parameters<typeof createTikHubEnrichmentStages>[0],
) => {
  const stages = createTikHubEnrichmentStages(dependencies);
  return async (input: TikHubEnrichmentInput) => {
    await stages.fetch(input);
    await stages.normalization(input);
    return stages.persistence(input);
  };
};
