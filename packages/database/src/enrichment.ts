import { Pool } from "@neondatabase/serverless";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import {
  DEEPLINE_CAREER_FIELDS,
  DEEPLINE_CAREER_TOOL_ID,
  DEEPLINE_FIELDS,
  DEEPLINE_IDENTITY_FIELDS,
  DEEPLINE_IDENTITY_TOOL_ID,
  type DeeplineEnrichmentInput,
  type DeeplineField,
  type DeeplineObservation,
  type DeeplineRun,
  type DeeplineStage,
  type DeeplineStore,
  type ProtectedDeeplineField,
} from "../../deepline-enrichment/src/types.js";
import type {
  GitHubEnrichmentInput,
  EnrichmentRun as GitHubEnrichmentRun,
  EnrichmentStore as GitHubEnrichmentStore,
  Observation as GitHubObservation,
  Stage as GitHubStage,
} from "../../github-enrichment/src/types.js";
import type {
  TikHubEnrichmentInput,
  TikHubObservation,
  TikHubRun,
  TikHubStage,
  TikHubStore,
} from "../../tikhub-enrichment/src/types.js";
import { recordEmployment, staleEmploymentsFromSource } from "./companies";
import {
  invalidateContactDetailObservationsInTransaction,
  persistVerifiedContactObservationInTransaction,
} from "./contact-reveals";
import type { CreditActor } from "./credits";
import { lockGitHubIdentity } from "./github-identity";
import { professionalLinkIdentity } from "./professional-links";
import * as schema from "./schema";
import {
  enrichmentCheckpoints,
  enrichmentDispatches,
  enrichmentRuns,
  memberStatements,
  professionalLinks,
  profileObservations,
  profiles,
  suppressionRecords,
} from "./schema";
import type { DrizzleDatabase, Transaction } from "./service/types";

type EnrichmentStoreErrorCode =
  | "enrichment_run_not_found"
  | "github_account_id_mismatch"
  | "invalid_checkpoint"
  | "invalid_enrichment_run"
  | "invalid_github_account_id"
  | "invalid_observation"
  | "observation_identity_collision"
  | "profile_not_found"
  | "profile_suppressed"
  | "run_id_collision"
  | "dispatch_lease_lost"
  | "invalid_dispatch";

export class EnrichmentStoreError extends Error {
  constructor(
    readonly code: EnrichmentStoreErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "EnrichmentStoreError";
  }
}

type RunShape<Stage extends string> = {
  id: string;
  profileId: string;
  status: string;
  completedStages: Stage[];
  currentStage: Stage | null;
  startedAt: string;
  finishedAt?: string;
  error?: string;
};

type ProviderConfiguration<Stage extends string> = {
  provider: EnrichmentProvider;
  pipelineVersion: string;
  stages: readonly Stage[];
  statuses: readonly string[];
};

type QueryableDatabase = DrizzleDatabase | Transaction;

const githubConfiguration = {
  provider: "github",
  pipelineVersion: "github-v1" satisfies GitHubObservation["pipelineVersion"],
  stages: ["account", "repositories", "normalization", "persistence"],
  statuses: ["pending", "running", "succeeded", "failed", "stale"],
} as const satisfies ProviderConfiguration<GitHubStage>;

const tikHubConfiguration = {
  provider: "tikhub",
  pipelineVersion:
    "tikhub-linkedin-v1" satisfies TikHubObservation["pipelineVersion"],
  stages: ["fetch", "normalization", "persistence"],
  statuses: ["pending", "running", "succeeded", "failed"],
} as const satisfies ProviderConfiguration<TikHubStage>;

const deeplineConfiguration = {
  provider: "deepline",
  pipelineVersion:
    "deepline-fallback-v1" satisfies DeeplineObservation["pipelineVersion"],
  stages: ["identity", "career", "persistence"],
  statuses: ["pending", "running", "succeeded", "failed"],
} as const satisfies ProviderConfiguration<DeeplineStage>;

const parseTimestamp = (
  value: string,
  code: "invalid_checkpoint" | "invalid_enrichment_run" | "invalid_observation",
) => {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new EnrichmentStoreError(code);
  return timestamp;
};

const requireOwnedRun = async <Stage extends string>(
  database: QueryableDatabase,
  configuration: ProviderConfiguration<Stage>,
  runId: string,
  profileId?: string,
) => {
  const [run] = await database
    .select()
    .from(enrichmentRuns)
    .where(eq(enrichmentRuns.id, runId))
    .limit(1);
  if (!run)
    throw new EnrichmentStoreError(
      "enrichment_run_not_found",
      `Enrichment run ${runId} does not exist`,
    );
  if (
    run.provider !== configuration.provider ||
    (profileId !== undefined && run.profileId !== profileId)
  )
    throw new EnrichmentStoreError(
      "run_id_collision",
      `Enrichment run ID ${runId} already belongs to another Profile or provider`,
    );
  return run;
};

const toRun = <Stage extends string, Run extends RunShape<Stage>>(
  row: typeof enrichmentRuns.$inferSelect,
  configuration: ProviderConfiguration<Stage>,
): Run => {
  const completedStages = row.completedStages;
  if (
    !configuration.statuses.includes(row.status) ||
    !Array.isArray(completedStages) ||
    completedStages.some(
      (stage) =>
        typeof stage !== "string" ||
        !configuration.stages.includes(stage as Stage),
    ) ||
    new Set(completedStages).size !== completedStages.length ||
    (row.stage !== null && !configuration.stages.includes(row.stage as Stage))
  )
    throw new EnrichmentStoreError(
      "invalid_enrichment_run",
      `Enrichment run ${row.id} contains invalid persisted state`,
    );

  return {
    id: row.id,
    profileId: row.profileId,
    status: row.status,
    completedStages: completedStages as Stage[],
    currentStage: row.stage as Stage | null,
    startedAt: row.startedAt.toISOString(),
    ...(row.finishedAt === null
      ? {}
      : { finishedAt: row.finishedAt.toISOString() }),
    ...(row.error === null ? {} : { error: row.error }),
  } as Run;
};

const validateRun = <Stage extends string>(
  run: RunShape<Stage>,
  configuration: ProviderConfiguration<Stage>,
) => {
  if (
    !configuration.statuses.includes(run.status) ||
    run.completedStages.some(
      (stage) => !configuration.stages.includes(stage),
    ) ||
    new Set(run.completedStages).size !== run.completedStages.length ||
    (run.currentStage !== null &&
      !configuration.stages.includes(run.currentStage))
  )
    throw new EnrichmentStoreError("invalid_enrichment_run");
  parseTimestamp(run.startedAt, "invalid_enrichment_run");
  if (run.finishedAt !== undefined)
    parseTimestamp(run.finishedAt, "invalid_enrichment_run");
};

const createProviderRunStore = <
  Stage extends string,
  Run extends RunShape<Stage>,
>(
  database: DrizzleDatabase,
  configuration: ProviderConfiguration<Stage>,
) => {
  const getRun = async (runId: string): Promise<Run | undefined> => {
    const [row] = await database
      .select()
      .from(enrichmentRuns)
      .where(eq(enrichmentRuns.id, runId))
      .limit(1);
    if (!row) return undefined;
    if (row.provider !== configuration.provider)
      throw new EnrichmentStoreError(
        "run_id_collision",
        `Enrichment run ID ${runId} already belongs to another provider`,
      );
    return toRun<Stage, Run>(row, configuration);
  };

  const getOrCreateRun = async (
    profileId: string,
    runId: string,
    startedAt: string,
  ): Promise<Run> => {
    const started = parseTimestamp(startedAt, "invalid_enrichment_run");
    const row = await database.transaction(async (transaction) => {
      await requireUnsuppressedProfile(transaction, profileId);
      await transaction
        .insert(enrichmentRuns)
        .values({
          id: runId,
          profileId,
          provider: configuration.provider,
          status: "pending",
          pipelineVersion: configuration.pipelineVersion,
          startedAt: started,
        })
        .onConflictDoNothing();
      return requireOwnedRun(transaction, configuration, runId, profileId);
    });
    return toRun<Stage, Run>(row, configuration);
  };

  const saveRun = async (run: Run) => {
    validateRun(run, configuration);
    const [saved] = await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${run.id}))`,
      );
      await requireOwnedRun(transaction, configuration, run.id, run.profileId);
      await requireUnsuppressedProfile(transaction, run.profileId);
      return transaction
        .update(enrichmentRuns)
        .set({
          status: run.status,
          stage: run.currentStage,
          completedStages: run.completedStages,
          error: run.error ?? null,
          finishedAt:
            run.finishedAt === undefined
              ? null
              : parseTimestamp(run.finishedAt, "invalid_enrichment_run"),
        })
        .where(
          and(
            eq(enrichmentRuns.id, run.id),
            eq(enrichmentRuns.profileId, run.profileId),
            eq(enrichmentRuns.provider, configuration.provider),
          ),
        )
        .returning({ id: enrichmentRuns.id });
    });
    if (!saved) throw new EnrichmentStoreError("enrichment_run_not_found");
  };

  const loadCheckpoint = async <Value>(runId: string, stage: Stage) => {
    if (!configuration.stages.includes(stage))
      throw new EnrichmentStoreError("invalid_checkpoint");
    const [row] = await database
      .select({
        provider: enrichmentRuns.provider,
        checkpointRunId: enrichmentCheckpoints.runId,
        value: enrichmentCheckpoints.value,
        expiresAt: enrichmentCheckpoints.expiresAt,
      })
      .from(enrichmentRuns)
      .leftJoin(
        enrichmentCheckpoints,
        and(
          eq(enrichmentCheckpoints.runId, enrichmentRuns.id),
          eq(enrichmentCheckpoints.stage, stage),
        ),
      )
      .where(eq(enrichmentRuns.id, runId))
      .limit(1);
    if (!row) return undefined;
    if (row.provider !== configuration.provider)
      throw new EnrichmentStoreError("run_id_collision");
    if (
      row.checkpointRunId === null ||
      (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now())
    )
      return undefined;
    return row.value as Value;
  };

  const saveCheckpoint = async <Value>(
    runId: string,
    stage: Stage,
    value: Value,
    options?: { expiresAt?: string },
  ) => {
    if (!configuration.stages.includes(stage) || value === undefined)
      throw new EnrichmentStoreError("invalid_checkpoint");
    const expiresAt =
      options?.expiresAt === undefined
        ? null
        : parseTimestamp(options.expiresAt, "invalid_checkpoint");
    await database.transaction(async (transaction) => {
      const run = await requireOwnedRun(transaction, configuration, runId);
      await requireUnsuppressedProfile(transaction, run.profileId);
      await transaction
        .insert(enrichmentCheckpoints)
        .values({ runId, stage, value, expiresAt, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [enrichmentCheckpoints.runId, enrichmentCheckpoints.stage],
          set: { value, expiresAt, updatedAt: new Date() },
        });
    });
  };

  return { getRun, getOrCreateRun, saveRun, loadCheckpoint, saveCheckpoint };
};

type ObservationWrite = {
  profileId: string;
  field: string;
  value: unknown;
  source: string;
  sourceRecordId: string;
  pipelineVersion: string;
  confidence: number;
  collectedAt: Date;
};

const validateObservation = (
  observation: {
    profileId: string;
    sourceRecordId: string;
    value: unknown;
    collectedAt: string;
    confidence: number;
    pipelineVersion: string;
  },
  profileId: string,
  pipelineVersion: string,
) => {
  if (
    observation.profileId !== profileId ||
    observation.sourceRecordId.trim() === "" ||
    observation.value === undefined ||
    observation.pipelineVersion !== pipelineVersion ||
    !Number.isFinite(observation.confidence) ||
    observation.confidence < 0 ||
    observation.confidence > 1
  )
    throw new EnrichmentStoreError("invalid_observation");
  return parseTimestamp(observation.collectedAt, "invalid_observation");
};

const persistObservationWrites = async <Stage extends string>(
  database: DrizzleDatabase,
  configuration: ProviderConfiguration<Stage>,
  runId: string,
  writesFor: (
    profileId: string,
    database: Transaction,
  ) => Promise<ObservationWrite[]>,
  options?: { allowEmpty?: boolean },
) =>
  database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${runId}))`,
    );
    const run = await requireOwnedRun(transaction, configuration, runId);
    if (run.observationsPersistedAt !== null) return;
    await requireUnsuppressedProfile(transaction, run.profileId);

    const writes = await writesFor(run.profileId, transaction);
    if (writes.length === 0 && !options?.allowEmpty)
      throw new EnrichmentStoreError("invalid_observation");
    const identities = new Set<string>();
    for (const write of writes) {
      const identity = `${write.source}\0${write.sourceRecordId}\0${write.field}`;
      if (identities.has(identity))
        throw new EnrichmentStoreError("invalid_observation");
      identities.add(identity);
    }

    const standardWrites = writes.filter(
      (write) => write.field !== "contact-detail",
    );
    const persisted =
      standardWrites.length === 0
        ? []
        : await transaction
            .insert(profileObservations)
            .values(standardWrites)
            .onConflictDoUpdate({
              target: [
                profileObservations.source,
                profileObservations.sourceRecordId,
                profileObservations.field,
              ],
              set: {
                value: sql`excluded.value`,
                pipelineVersion: sql`excluded.pipeline_version`,
                confidence: sql`excluded.confidence`,
                collectedAt: sql`excluded.collected_at`,
                staleAt: null,
              },
              setWhere: sql`${profileObservations.profileId} = excluded.profile_id`,
            })
            .returning({ id: profileObservations.id });
    for (const write of writes) {
      if (write.field !== "contact-detail") continue;
      try {
        const observation =
          await persistVerifiedContactObservationInTransaction(
            transaction,
            write,
          );
        persisted.push({ id: observation.id });
      } catch (cause) {
        if (
          cause instanceof Error &&
          cause.message === "contact_detail_identity_collision"
        )
          throw new EnrichmentStoreError(
            "observation_identity_collision",
            "An Observation identity already belongs to another Profile",
          );
        throw cause;
      }
    }
    if (persisted.length !== writes.length)
      throw new EnrichmentStoreError(
        "observation_identity_collision",
        "An Observation identity already belongs to another Profile",
      );
    await transaction
      .update(enrichmentRuns)
      .set({ observationsPersistedAt: new Date() })
      .where(eq(enrichmentRuns.id, runId));
  });

const parseGitHubAccountId = (value: string) => {
  if (!/^[0-9]+$/.test(value))
    throw new EnrichmentStoreError("invalid_github_account_id");
  const accountId = Number(value);
  if (!Number.isSafeInteger(accountId) || accountId <= 0)
    throw new EnrichmentStoreError("invalid_github_account_id");
  return accountId;
};

const requireUnsuppressedProfile = async (
  transaction: Transaction,
  profileId: string,
) => {
  const [identity] = await transaction
    .select({
      githubAccountId: profiles.githubAccountId,
      searchabilityReason: profiles.searchabilityReason,
    })
    .from(profiles)
    .where(eq(profiles.profileId, profileId))
    .limit(1);
  if (!identity) throw new EnrichmentStoreError("profile_not_found");
  if (identity.searchabilityReason === "operator_suppression")
    throw new EnrichmentStoreError("profile_suppressed");
  await lockGitHubIdentity(transaction, identity.githubAccountId);
  const [current] = await transaction
    .select({
      githubAccountId: profiles.githubAccountId,
      searchabilityReason: profiles.searchabilityReason,
      suppressionId: suppressionRecords.canonicalProviderId,
    })
    .from(profiles)
    .leftJoin(
      suppressionRecords,
      and(
        eq(suppressionRecords.canonicalProvider, "github"),
        eq(suppressionRecords.canonicalProviderId, profiles.githubAccountId),
      ),
    )
    .where(eq(profiles.profileId, profileId))
    .limit(1)
    .for("update", { of: profiles });
  if (!current) throw new EnrichmentStoreError("profile_not_found");
  if (
    current.suppressionId !== null ||
    current.searchabilityReason === "operator_suppression"
  )
    throw new EnrichmentStoreError("profile_suppressed");
  return current;
};

const writeForUnsuppressedProfile = <Value>(
  database: DrizzleDatabase,
  profileId: string,
  write: (transaction: Transaction) => Promise<Value>,
) =>
  database.transaction(async (transaction) => {
    await requireUnsuppressedProfile(transaction, profileId);
    return write(transaction);
  });

const githubObservationWrites = async (
  transaction: Transaction,
  profileId: string,
  observations: GitHubObservation[],
) => {
  const [profile] = await transaction
    .select({ githubAccountId: profiles.githubAccountId })
    .from(profiles)
    .where(eq(profiles.profileId, profileId))
    .limit(1)
    .for("update");
  if (!profile) throw new EnrichmentStoreError("profile_not_found");

  const accountObservations = observations.filter(
    ({ kind }) => kind === "github-account",
  );
  if (accountObservations.length !== 1)
    throw new EnrichmentStoreError("invalid_observation");
  const accountValue = accountObservations[0]?.value;
  if (
    typeof accountValue !== "object" ||
    accountValue === null ||
    Array.isArray(accountValue) ||
    !Number.isSafeInteger((accountValue as { id?: unknown }).id) ||
    Number((accountValue as { id: number }).id) <= 0
  )
    throw new EnrichmentStoreError("invalid_github_account_id");
  const observedAccountId = (accountValue as { id: number }).id;
  if (parseGitHubAccountId(profile.githubAccountId) !== observedAccountId)
    throw new EnrichmentStoreError(
      "github_account_id_mismatch",
      "GitHub account Observation does not match the Profile's immutable ID",
    );
  const observedLogin = (accountValue as { login?: unknown }).login;
  if (
    typeof observedLogin !== "string" ||
    !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(observedLogin)
  )
    throw new EnrichmentStoreError("invalid_observation");
  await transaction
    .update(profiles)
    .set({ githubLogin: observedLogin, updatedAt: new Date() })
    .where(eq(profiles.profileId, profileId));

  for (const source of [...new Set(observations.map(({ source }) => source))]) {
    const latestCollectedAt = observations
      .filter((observation) => observation.source === source)
      .map((observation) =>
        parseTimestamp(observation.collectedAt, "invalid_observation"),
      )
      .sort((left, right) => right.getTime() - left.getTime())[0];
    if (latestCollectedAt)
      await staleEmploymentsFromSource(
        transaction,
        profileId,
        source,
        latestCollectedAt,
      );
  }
  for (const observation of observations) {
    const companyName = currentCompanyFromObservation({
      field: observation.kind,
      source: observation.source,
      value: observation.value,
    });
    if (!companyName) continue;
    await recordEmployment(transaction, {
      profileId,
      companyName,
      current: true,
      source: observation.source,
      sourceRecordId: observation.sourceRecordId,
      pipelineVersion: observation.pipelineVersion,
      confidence: observation.confidence,
      collectedAt: parseTimestamp(
        observation.collectedAt,
        "invalid_observation",
      ),
    });
  }

  return observations.map((observation): ObservationWrite => {
    const collectedAt = validateObservation(
      observation,
      profileId,
      githubConfiguration.pipelineVersion,
    );
    const validSource =
      (observation.kind === "github-normalization" &&
        observation.source === "github-ai-normalization") ||
      (observation.kind !== "github-normalization" &&
        observation.source === "github");
    if (!validSource) throw new EnrichmentStoreError("invalid_observation");
    return {
      profileId,
      field: observation.kind,
      value: observation.value,
      source: observation.source,
      sourceRecordId: observation.sourceRecordId,
      pipelineVersion: observation.pipelineVersion,
      confidence: observation.confidence,
      collectedAt,
    };
  });
};

const currentCompanyFromObservation = (observation: {
  field: string;
  source: string;
  value: unknown;
}) => {
  const company = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  if (
    observation.field === "current_company" ||
    observation.field === "currentCompany" ||
    observation.field === "company"
  )
    return observation.source === "public-profile-request" &&
      observation.value === null
      ? null
      : company(observation.value);
  if (
    typeof observation.value !== "object" ||
    observation.value === null ||
    Array.isArray(observation.value)
  )
    return undefined;
  const value = observation.value as Record<string, unknown>;
  if (observation.field === "linkedin-career")
    return company(value.currentCompany);
  if (observation.field === "github-account") return company(value.company);
  if (observation.field === "github-normalization")
    return (
      company(value.current_company) ??
      company(value.currentCompany) ??
      company(value.company)
    );
  return undefined;
};

const materializeImportedProfileCompany = async (
  transaction: Transaction,
  profileId: string,
  updatedAt: Date,
  options: {
    excludeStoredTikHub?: boolean;
    replacementTikHubCompany?: string;
  } = {},
) => {
  const [profile] = await transaction
    .select({ memberId: profiles.memberId })
    .from(profiles)
    .where(eq(profiles.profileId, profileId))
    .limit(1);
  if (profile?.memberId !== null) return;
  const observations = await transaction
    .select({
      field: profileObservations.field,
      value: profileObservations.value,
      source: profileObservations.source,
    })
    .from(profileObservations)
    .where(
      and(
        eq(profileObservations.profileId, profileId),
        options.excludeStoredTikHub
          ? ne(profileObservations.source, "tikhub")
          : undefined,
        isNull(profileObservations.staleAt),
      ),
    )
    .orderBy(
      desc(
        sql<number>`case
          when ${profileObservations.source} = 'public-profile-request' then 3
          when ${profileObservations.source} = 'tikhub' then 2
          when ${profileObservations.source} in ('github', 'github-ai-normalization') then 1
          else 0
        end`,
      ),
      desc(profileObservations.confidence),
      desc(profileObservations.collectedAt),
    );
  const fallback = observations
    .flatMap((observation) => {
      const currentCompany = currentCompanyFromObservation(observation);
      return currentCompany === undefined
        ? []
        : [{ currentCompany, source: observation.source }];
    })
    .at(0);
  const currentCompany =
    fallback?.source === "public-profile-request"
      ? fallback.currentCompany
      : (options.replacementTikHubCompany ?? fallback?.currentCompany ?? null);
  await transaction
    .update(profiles)
    .set({ currentCompany, updatedAt })
    .where(and(eq(profiles.profileId, profileId), isNull(profiles.memberId)));
};

const tikHubObservationWrites = async (
  transaction: Transaction,
  profileId: string,
  observations: TikHubObservation[],
) => {
  const writes = observations.map((observation): ObservationWrite => {
    const collectedAt = validateObservation(
      observation,
      profileId,
      tikHubConfiguration.pipelineVersion,
    );
    if (
      observation.sourceIdentity !== "tikhub" ||
      observation.sourceCategory !== "professional-network"
    )
      throw new EnrichmentStoreError("invalid_observation");
    return {
      profileId,
      field: observation.kind,
      value: observation.value,
      source: observation.sourceIdentity,
      sourceRecordId: observation.sourceRecordId,
      pipelineVersion: observation.pipelineVersion,
      confidence: observation.confidence,
      collectedAt,
    };
  });
  const career = observations.find(
    (observation) => observation.kind === "linkedin-career",
  );
  const companyValue =
    career !== undefined &&
    typeof career.value === "object" &&
    career.value !== null &&
    !Array.isArray(career.value)
      ? (career.value as Record<string, unknown>).currentCompany
      : undefined;
  const currentCompany =
    typeof companyValue === "string" ? companyValue.trim() : "";
  if (career !== undefined) {
    const collectedAt = parseTimestamp(
      career.collectedAt,
      "invalid_observation",
    );
    await staleEmploymentsFromSource(
      transaction,
      profileId,
      "tikhub",
      collectedAt,
    );
    if (
      typeof career.value === "object" &&
      career.value !== null &&
      !Array.isArray(career.value)
    ) {
      const value = career.value as Record<string, unknown>;
      const currentCompanyId =
        typeof value.currentCompanyId === "string" &&
        value.currentCompanyId.trim()
          ? value.currentCompanyId
          : undefined;
      const experience = value.experience;
      const hasCurrentExperience =
        Array.isArray(experience) &&
        experience.some((entry) => {
          if (
            typeof entry !== "object" ||
            entry === null ||
            Array.isArray(entry)
          )
            return false;
          const item = entry as Record<string, unknown>;
          return (
            typeof item.organization === "string" &&
            typeof item.endedAt === "string" &&
            item.endedAt.trim().toLocaleLowerCase() === "present" &&
            ((currentCompanyId !== undefined &&
              item.companyId === currentCompanyId) ||
              item.organization.trim().toLocaleLowerCase() ===
                currentCompany.toLocaleLowerCase())
          );
        });
      if (currentCompany && !hasCurrentExperience)
        await recordEmployment(transaction, {
          profileId,
          companyName: currentCompany,
          current: true,
          source: "tikhub",
          sourceRecordId: `${career.sourceRecordId}:current-company`,
          pipelineVersion: career.pipelineVersion,
          confidence: career.confidence,
          collectedAt,
          ...(currentCompanyId === undefined
            ? {}
            : { identity: { kind: "linkedin", value: currentCompanyId } }),
        });
      if (Array.isArray(experience))
        for (const entry of experience) {
          if (
            typeof entry !== "object" ||
            entry === null ||
            Array.isArray(entry) ||
            typeof (entry as Record<string, unknown>).sourceRecordId !==
              "string" ||
            typeof (entry as Record<string, unknown>).organization !== "string"
          )
            continue;
          const item = entry as Record<string, unknown>;
          const companyId =
            typeof item.companyId === "string" && item.companyId.trim()
              ? item.companyId
              : undefined;
          await recordEmployment(transaction, {
            profileId,
            companyName: item.organization as string,
            current:
              typeof item.endedAt === "string" &&
              item.endedAt.trim().toLocaleLowerCase() === "present",
            source: "tikhub",
            sourceRecordId: item.sourceRecordId as string,
            pipelineVersion: career.pipelineVersion,
            confidence: career.confidence,
            collectedAt,
            ...(typeof item.title === "string" ? { title: item.title } : {}),
            ...(typeof item.startedAt === "string"
              ? { startedAt: item.startedAt }
              : {}),
            ...(typeof item.endedAt === "string"
              ? { endedAt: item.endedAt }
              : {}),
            ...(companyId === undefined
              ? {}
              : { identity: { kind: "linkedin", value: companyId } }),
          });
        }
    }
    await materializeImportedProfileCompany(
      transaction,
      profileId,
      new Date(),
      {
        excludeStoredTikHub: true,
        ...(currentCompany ? { replacementTikHubCompany: currentCompany } : {}),
      },
    );
  }
  return writes;
};

const deeplineFieldAliases = new Map<string, DeeplineField>([
  ["linkedinUrl", "linkedinUrl"],
  ["linkedin_url", "linkedinUrl"],
  ["githubUrl", "githubUrl"],
  ["github_url", "githubUrl"],
  ["xUrl", "xUrl"],
  ["x_url", "xUrl"],
  ["twitterUrl", "xUrl"],
  ["twitter_url", "xUrl"],
  ["headline", "headline"],
  ["currentPosition", "currentPosition"],
  ["current_position", "currentPosition"],
  ["currentCompany", "currentPosition"],
  ["current_company", "currentPosition"],
  ["role", "currentPosition"],
  ["experience", "experience"],
  ["education", "education"],
  ["skills", "skills"],
]);

const hasProviderValue = (value: unknown) =>
  value !== null &&
  value !== undefined &&
  (typeof value !== "string" || value.trim().length > 0) &&
  (!Array.isArray(value) || value.length > 0);

const urlKind = (value: string) => {
  const identity = professionalLinkIdentity(value);
  if (identity?.kind === "github") return "githubUrl" as const;
  if (identity?.kind === "linkedin") return "linkedinUrl" as const;
  if (identity?.kind === "x") return "xUrl" as const;
  return undefined;
};

const listProtectedDeeplineFields = async (
  database: QueryableDatabase,
  profileId: string,
  requestedFields: DeeplineField[],
): Promise<ProtectedDeeplineField[]> => {
  const requested = new Set(requestedFields);
  if (requested.size === 0) return [];
  if (
    requested.size !== requestedFields.length ||
    requestedFields.some((field) => !DEEPLINE_FIELDS.includes(field))
  )
    throw new EnrichmentStoreError("invalid_observation");

  const [profile] = await database
    .select({
      memberId: profiles.memberId,
      currentCompany: profiles.currentCompany,
      githubLogin: profiles.githubLogin,
    })
    .from(profiles)
    .where(eq(profiles.profileId, profileId))
    .limit(1);
  if (!profile) throw new EnrichmentStoreError("profile_not_found");

  const statements = await database
    .select({ field: memberStatements.field })
    .from(memberStatements)
    .where(eq(memberStatements.profileId, profileId));
  const observations = await database
    .select({
      field: profileObservations.field,
      source: profileObservations.source,
      value: profileObservations.value,
    })
    .from(profileObservations)
    .where(
      and(
        eq(profileObservations.profileId, profileId),
        inArray(profileObservations.source, [
          "public-profile-request",
          "github",
          "github-ai-normalization",
          "tikhub",
        ]),
        isNull(profileObservations.staleAt),
      ),
    );
  const links = await database
    .select({ source: professionalLinks.source, url: professionalLinks.url })
    .from(professionalLinks)
    .where(eq(professionalLinks.profileId, profileId));

  const protectedBy = new Map<
    DeeplineField,
    ProtectedDeeplineField["source"]
  >();
  const protect = (
    field: DeeplineField,
    source: ProtectedDeeplineField["source"],
  ) => {
    if (!requested.has(field)) return;
    const rank = { member: 4, reviewed: 3, github: 2, tikhub: 1 } as const;
    const current = protectedBy.get(field);
    if (current === undefined || rank[source] > rank[current])
      protectedBy.set(field, source);
  };

  if (hasProviderValue(profile.githubLogin)) protect("githubUrl", "github");
  if (profile.memberId !== null && hasProviderValue(profile.currentCompany))
    protect("currentPosition", "member");
  for (const statement of statements) {
    const field = deeplineFieldAliases.get(statement.field);
    if (field !== undefined) protect(field, "member");
  }
  for (const { source, url } of links) {
    const field = urlKind(url);
    if (field !== undefined && source === "public-profile-request") {
      protect(field, "reviewed");
      continue;
    }
    if (field === "githubUrl") protect(field, "github");
    if (field === "linkedinUrl")
      protect(field, profile.memberId === null ? "tikhub" : "member");
    if (field === "xUrl" && profile.memberId !== null) protect(field, "member");
  }

  for (const observation of observations) {
    if (observation.source === "public-profile-request") {
      const field = deeplineFieldAliases.get(observation.field);
      if (field !== undefined) protect(field, "reviewed");
      continue;
    }
    const source = observation.source === "tikhub" ? "tikhub" : "github";
    if (
      observation.field === "github-account" &&
      typeof observation.value === "object" &&
      observation.value !== null &&
      !Array.isArray(observation.value)
    ) {
      const company = (observation.value as Record<string, unknown>).company;
      if (hasProviderValue(company)) protect("currentPosition", "github");
      continue;
    }
    if (
      observation.field === "github-normalization" &&
      typeof observation.value === "object" &&
      observation.value !== null &&
      !Array.isArray(observation.value)
    ) {
      const value = observation.value as Record<string, unknown>;
      if (hasProviderValue(value.summary)) protect("headline", "github");
      if (hasProviderValue(value.roles)) protect("currentPosition", "github");
      const skills = value.skills;
      if (hasProviderValue(skills)) protect("skills", "github");
      continue;
    }
    if (
      observation.field === "linkedin-career" &&
      typeof observation.value === "object" &&
      observation.value !== null &&
      !Array.isArray(observation.value)
    ) {
      const value = observation.value as Record<string, unknown>;
      if (hasProviderValue(value.headline)) protect("headline", "tikhub");
      if (hasProviderValue(value.currentCompany))
        protect("currentPosition", "tikhub");
      if (hasProviderValue(value.experience)) protect("experience", "tikhub");
      if (hasProviderValue(value.education)) protect("education", "tikhub");
      if (hasProviderValue(value.skills)) protect("skills", "tikhub");
      continue;
    }
    const field = deeplineFieldAliases.get(observation.field);
    if (field !== undefined && hasProviderValue(observation.value))
      protect(field, source);
  }

  return requestedFields.flatMap((field) => {
    const source = protectedBy.get(field);
    return source === undefined ? [] : [{ field, source }];
  });
};

const deeplineObservationWrites = async (
  transaction: Transaction,
  profileId: string,
  observations: DeeplineObservation[],
) => {
  const protectedFields = await listProtectedDeeplineFields(
    transaction,
    profileId,
    [...new Set(observations.map(({ field }) => field))],
  );
  const protectedNames = new Set(protectedFields.map(({ field }) => field));
  return observations.flatMap((observation): ObservationWrite[] => {
    const collectedAt = validateObservation(
      observation,
      profileId,
      deeplineConfiguration.pipelineVersion,
    );
    const identityField = DEEPLINE_IDENTITY_FIELDS.includes(
      observation.field as (typeof DEEPLINE_IDENTITY_FIELDS)[number],
    );
    const validTool = identityField
      ? observation.providerToolId === DEEPLINE_IDENTITY_TOOL_ID
      : DEEPLINE_CAREER_FIELDS.includes(
          observation.field as (typeof DEEPLINE_CAREER_FIELDS)[number],
        ) && observation.providerToolId === DEEPLINE_CAREER_TOOL_ID;
    if (observation.source !== "deepline" || !validTool)
      throw new EnrichmentStoreError("invalid_observation");
    if (protectedNames.has(observation.field)) return [];
    return [
      {
        profileId,
        field: observation.field,
        value: observation.value,
        source: observation.source,
        sourceRecordId: observation.sourceRecordId,
        pipelineVersion: observation.pipelineVersion,
        confidence: observation.confidence,
        collectedAt,
      },
    ];
  });
};

export const createGitHubEnrichmentStore = (
  database: DrizzleDatabase,
): GitHubEnrichmentStore => ({
  ...createProviderRunStore<GitHubStage, GitHubEnrichmentRun>(
    database,
    githubConfiguration,
  ),
  getImmutableGitHubUserId: async (profileId) => {
    const [profile] = await database
      .select({ githubAccountId: profiles.githubAccountId })
      .from(profiles)
      .where(eq(profiles.profileId, profileId))
      .limit(1);
    if (!profile) throw new EnrichmentStoreError("profile_not_found");
    return parseGitHubAccountId(profile.githubAccountId);
  },
  persistObservations: (runId, observations) =>
    persistObservationWrites(
      database,
      githubConfiguration,
      runId,
      (profileId, transaction) =>
        githubObservationWrites(transaction, profileId, observations),
    ),
  markGitHubObservationsStale: async (profileId, at) => {
    const staleAt = parseTimestamp(at, "invalid_observation");
    await writeForUnsuppressedProfile(
      database,
      profileId,
      async (transaction) => {
        await transaction
          .update(profileObservations)
          .set({ staleAt })
          .where(
            and(
              eq(profileObservations.profileId, profileId),
              inArray(profileObservations.source, [
                "github",
                "github-ai-normalization",
              ]),
            ),
          );
        await staleEmploymentsFromSource(
          transaction,
          profileId,
          "github",
          staleAt,
        );
        await staleEmploymentsFromSource(
          transaction,
          profileId,
          "github-ai-normalization",
          staleAt,
        );
        await materializeImportedProfileCompany(
          transaction,
          profileId,
          staleAt,
        );
      },
    );
  },
  markGitHubInaccessibleIfUnset: async (profileId, at) => {
    const inaccessibleAt = parseTimestamp(at, "invalid_observation");
    const [profile] = await writeForUnsuppressedProfile(
      database,
      profileId,
      (transaction) =>
        transaction
          .update(profiles)
          .set({
            githubInaccessibleSince: sql`coalesce(${profiles.githubInaccessibleSince}, ${inaccessibleAt})`,
          })
          .where(eq(profiles.profileId, profileId))
          .returning({
            githubInaccessibleSince: profiles.githubInaccessibleSince,
          }),
    );
    if (!profile?.githubInaccessibleSince)
      throw new EnrichmentStoreError("profile_not_found");
    return profile.githubInaccessibleSince.toISOString();
  },
  clearGitHubInaccessible: async (profileId) => {
    const [profile] = await writeForUnsuppressedProfile(
      database,
      profileId,
      (transaction) =>
        transaction
          .update(profiles)
          .set({ githubInaccessibleSince: null })
          .where(eq(profiles.profileId, profileId))
          .returning({ profileId: profiles.profileId }),
    );
    if (!profile) throw new EnrichmentStoreError("profile_not_found");
  },
});

export const createTikHubEnrichmentStore = (
  database: DrizzleDatabase,
): TikHubStore => ({
  ...createProviderRunStore<TikHubStage, TikHubRun>(
    database,
    tikHubConfiguration,
  ),
  persistObservations: (runId, observations) =>
    persistObservationWrites(
      database,
      tikHubConfiguration,
      runId,
      (profileId, transaction) =>
        tikHubObservationWrites(transaction, profileId, observations),
    ),
  markTikHubObservationsStale: async (profileId, at) => {
    const staleAt = parseTimestamp(at, "invalid_observation");
    await writeForUnsuppressedProfile(
      database,
      profileId,
      async (transaction) => {
        await transaction
          .update(profileObservations)
          .set({ staleAt })
          .where(
            and(
              eq(profileObservations.profileId, profileId),
              eq(profileObservations.source, "tikhub"),
            ),
          );
        await staleEmploymentsFromSource(
          transaction,
          profileId,
          "tikhub",
          staleAt,
        );
        await materializeImportedProfileCompany(
          transaction,
          profileId,
          staleAt,
        );
      },
    );
  },
});

export const createDeeplineEnrichmentStore = (
  database: DrizzleDatabase,
): DeeplineStore => ({
  ...createProviderRunStore<DeeplineStage, DeeplineRun>(
    database,
    deeplineConfiguration,
  ),
  listProtectedFields: (profileId, fields) =>
    listProtectedDeeplineFields(database, profileId, fields),
  persistObservations: (runId, observations) =>
    persistObservationWrites(
      database,
      deeplineConfiguration,
      runId,
      (profileId, transaction) =>
        deeplineObservationWrites(transaction, profileId, observations),
      { allowEmpty: true },
    ),
  markDeeplineObservationsStale: async (profileId, fields, at) => {
    if (fields.length === 0) return;
    if (
      new Set(fields).size !== fields.length ||
      fields.some((field) => !DEEPLINE_FIELDS.includes(field))
    )
      throw new EnrichmentStoreError("invalid_observation");
    await writeForUnsuppressedProfile(database, profileId, (transaction) =>
      transaction
        .update(profileObservations)
        .set({ staleAt: parseTimestamp(at, "invalid_observation") })
        .where(
          and(
            eq(profileObservations.profileId, profileId),
            eq(profileObservations.source, "deepline"),
            inArray(profileObservations.field, fields),
          ),
        ),
    );
  },
});

export const deleteExpiredEnrichmentCheckpoints = async (
  database: DrizzleDatabase,
  expiredAt = new Date(),
) => {
  if (Number.isNaN(expiredAt.getTime()))
    throw new EnrichmentStoreError("invalid_checkpoint");
  const deleted = await database
    .delete(enrichmentCheckpoints)
    .where(lte(enrichmentCheckpoints.expiresAt, expiredAt))
    .returning({ runId: enrichmentCheckpoints.runId });
  return deleted.length;
};

export type EnrichmentProvider = "github" | "tikhub" | "deepline";
export type EnrichmentDispatchState =
  | "pending"
  | "leased"
  | "delivered"
  | "cancelled";

export const ENRICHMENT_REFRESH_DAYS = {
  github: 30,
  tikhub: 90,
  deepline: 90,
} as const satisfies Record<EnrichmentProvider, number>;

const DAY_IN_MILLISECONDS = 86_400_000;
const FAILED_REFRESH_RETRY_DAYS = 1;
const enrichmentProviders = ["github", "tikhub", "deepline"] as const;

export const enrichmentRefreshDueAt = (
  provider: EnrichmentProvider,
  lastSucceededAt: Date,
) => {
  if (Number.isNaN(lastSucceededAt.getTime()))
    throw new EnrichmentStoreError("invalid_dispatch");
  return new Date(
    lastSucceededAt.getTime() +
      ENRICHMENT_REFRESH_DAYS[provider] * DAY_IN_MILLISECONDS,
  );
};

export const isEnrichmentRefreshDue = (
  provider: EnrichmentProvider,
  lastSucceededAt: Date | null,
  now = new Date(),
) => {
  if (Number.isNaN(now.getTime()))
    throw new EnrichmentStoreError("invalid_dispatch");
  return (
    lastSucceededAt === null ||
    enrichmentRefreshDueAt(provider, lastSucceededAt).getTime() <= now.getTime()
  );
};

type ProviderPayload =
  | { provider: "github"; payload: GitHubEnrichmentInput }
  | { provider: "tikhub"; payload: TikHubEnrichmentInput }
  | { provider: "deepline"; payload: DeeplineEnrichmentInput };

export type EnrichmentDispatch = ProviderPayload & {
  id: string;
  profileId: string;
  runId: string;
  dedupeKey: string;
  state: EnrichmentDispatchState;
  attempts: number;
  availableAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  triggerRunId: string | null;
  deliveredAt: Date | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dispatchFromRow = (
  row: typeof enrichmentDispatches.$inferSelect,
): EnrichmentDispatch => {
  if (
    !enrichmentProviders.includes(row.provider as EnrichmentProvider) ||
    !["pending", "leased", "delivered", "cancelled"].includes(row.state) ||
    !isRecord(row.payload) ||
    row.payload.profileId !== row.profileId ||
    row.payload.runId !== row.runId
  )
    throw new EnrichmentStoreError("invalid_dispatch");

  const common = {
    id: row.id,
    profileId: row.profileId,
    runId: row.runId,
    dedupeKey: row.dedupeKey,
    state: row.state as EnrichmentDispatchState,
    attempts: row.attempts,
    availableAt: row.availableAt,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    triggerRunId: row.triggerRunId,
    deliveredAt: row.deliveredAt,
  };
  if (row.provider === "github") {
    if (typeof row.payload.githubLogin !== "string")
      throw new EnrichmentStoreError("invalid_dispatch");
    return {
      ...common,
      provider: "github",
      payload: row.payload as GitHubEnrichmentInput,
    };
  }
  if (row.provider === "tikhub") {
    if (typeof row.payload.linkedInUrl !== "string")
      throw new EnrichmentStoreError("invalid_dispatch");
    return {
      ...common,
      provider: "tikhub",
      payload: row.payload as TikHubEnrichmentInput,
    };
  }
  if (
    !Array.isArray(row.payload.missingFields) ||
    row.payload.missingFields.some(
      (field) =>
        typeof field !== "string" ||
        !DEEPLINE_FIELDS.includes(field as DeeplineField),
    ) ||
    (row.payload.prerequisiteRunIds !== undefined &&
      (!Array.isArray(row.payload.prerequisiteRunIds) ||
        row.payload.prerequisiteRunIds.some(
          (runId) => typeof runId !== "string" || runId.trim() === "",
        ) ||
        new Set(row.payload.prerequisiteRunIds).size !==
          row.payload.prerequisiteRunIds.length))
  )
    throw new EnrichmentStoreError("invalid_dispatch");
  return {
    ...common,
    provider: "deepline",
    payload: row.payload as DeeplineEnrichmentInput,
  };
};

const unsuppressedDispatchPredicate = sql<boolean>`exists (
  select 1
  from ${profiles}
  where ${profiles.profileId} = ${enrichmentDispatches.profileId}
    and ${profiles.searchabilityReason} <> 'operator_suppression'
    and not exists (
      select 1
      from ${suppressionRecords}
      where ${suppressionRecords.canonicalProvider} = 'github'
        and ${suppressionRecords.canonicalProviderId} = ${profiles.githubAccountId}
  )
)`;

const claimableDispatchPredicate = sql<boolean>`
  ${unsuppressedDispatchPredicate}
  and exists (
    select 1
    from ${profiles}
    where ${profiles.profileId} = ${enrichmentDispatches.profileId}
      and ${profiles.searchable} = true
  )
`;

const directPrerequisitesSatisfiedPredicate = sql<boolean>`
  (
    ${enrichmentDispatches.provider} <> 'deepline'
    or not exists (
      select 1
      from jsonb_array_elements_text(
        coalesce(
          ${enrichmentDispatches.payload}->'prerequisiteRunIds',
          '[]'::jsonb
        )
      ) as prerequisite(run_id)
      where not exists (
        select 1
        from ${enrichmentRuns}
        where ${enrichmentRuns.id} = prerequisite.run_id
          and ${enrichmentRuns.status} not in ('pending', 'running')
      )
    )
  )
`;

export const enqueueEnrichmentDispatch = async (
  database: QueryableDatabase,
  input: ProviderPayload & { dedupeKey: string; now?: Date },
) => {
  const now = input.now ?? new Date();
  if (
    !input.dedupeKey.trim() ||
    Number.isNaN(now.getTime()) ||
    input.payload.profileId.trim() === "" ||
    input.payload.runId.trim() === ""
  )
    throw new EnrichmentStoreError("invalid_dispatch");
  const [eligible] = await database
    .select({ profileId: profiles.profileId })
    .from(profiles)
    .leftJoin(
      suppressionRecords,
      and(
        eq(suppressionRecords.canonicalProvider, "github"),
        eq(suppressionRecords.canonicalProviderId, profiles.githubAccountId),
      ),
    )
    .where(
      and(
        eq(profiles.profileId, input.payload.profileId),
        sql`${profiles.searchabilityReason} <> 'operator_suppression'`,
        isNull(suppressionRecords.canonicalProviderId),
      ),
    )
    .limit(1);
  if (!eligible) return undefined;

  const [created] = await database
    .insert(enrichmentDispatches)
    .values({
      profileId: input.payload.profileId,
      provider: input.provider,
      runId: input.payload.runId,
      dedupeKey: input.dedupeKey,
      payload: input.payload,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: enrichmentDispatches.dedupeKey,
      set: {
        runId: input.payload.runId,
        payload: input.payload,
        state: "pending",
        attempts: 0,
        availableAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        triggerRunId: null,
        lastErrorCode: null,
        createdAt: now,
        updatedAt: now,
        deliveredAt: null,
      },
      setWhere: and(
        eq(enrichmentDispatches.state, "cancelled"),
        eq(enrichmentDispatches.profileId, input.payload.profileId),
        eq(enrichmentDispatches.provider, input.provider),
      ),
    })
    .returning();
  return created === undefined ? undefined : dispatchFromRow(created);
};

export const enqueueAffectedMemberEditDispatches = async (
  database: Transaction,
  input: {
    memberId: string;
    profileId: string;
    before: {
      name: string;
      currentCompany: string | null;
      githubLogin: string;
      professionalLinks: string[];
    };
    after: {
      name: string;
      currentCompany: string | null;
      githubLogin: string;
      professionalLinks: string[];
    };
    now?: Date;
    createId?: () => string;
    actor?: CreditActor;
  },
) => {
  const now = input.now ?? new Date();
  const createId = input.createId ?? (() => crypto.randomUUID());
  const editId = createId();
  const created: EnrichmentDispatch[] = [];
  const links = (values: string[], kind: ReturnType<typeof urlKind>) => {
    if (kind === undefined) return [];
    return values
      .flatMap((value) => {
        const identity = professionalLinkIdentity(value);
        if (!identity || urlKind(value) !== kind) return [];
        if (identity.kind === "github") return [identity.login];
        if (identity.kind === "linkedin") return [identity.username];
        return [new URL(value).toString()];
      })
      .sort();
  };
  const changed = (kind: ReturnType<typeof urlKind>) =>
    JSON.stringify(links(input.before.professionalLinks, kind)) !==
    JSON.stringify(links(input.after.professionalLinks, kind));
  const githubLinkChanged = changed("githubUrl");
  const linkedInLinkChanged = changed("linkedinUrl");
  const directPrerequisiteRunIds = new Map<"github" | "tikhub", string>();
  const enqueue = async (payload: ProviderPayload) => {
    const dispatch = await enqueueEnrichmentDispatch(database, {
      ...payload,
      dedupeKey: `member-edit:${input.profileId}:${editId}:${payload.provider}`,
      now,
    });
    if (dispatch) created.push(dispatch);
    return dispatch;
  };

  if (linkedInLinkChanged) {
    const invalidated = await database
      .update(profileObservations)
      .set({ staleAt: now })
      .where(
        and(
          eq(profileObservations.profileId, input.profileId),
          or(
            eq(profileObservations.source, "tikhub"),
            and(
              eq(profileObservations.source, "deepline"),
              inArray(profileObservations.field, [
                "linkedinUrl",
                ...DEEPLINE_CAREER_FIELDS,
              ]),
            ),
          ),
        ),
      )
      .returning({
        id: profileObservations.id,
        field: profileObservations.field,
        source: profileObservations.source,
      });
    const contactObservationIds = invalidated.flatMap((observation) =>
      observation.source === "tikhub" && observation.field === "contact-detail"
        ? [observation.id]
        : [],
    );
    if (contactObservationIds.length > 0)
      await invalidateContactDetailObservationsInTransaction(database, {
        profileId: input.profileId,
        observationIds: contactObservationIds,
        reportedBy: input.actor?.id ?? input.memberId,
        reason: "linkedin_professional_link_changed",
        actor: input.actor ?? { type: "member", id: input.memberId },
        operation: "contact_reveal.linkedin_identity_change.refund",
        now,
      });
  }

  if (githubLinkChanged) {
    const runId = createId();
    const dispatch = await enqueue({
      provider: "github",
      payload: {
        profileId: input.profileId,
        githubLogin: input.after.githubLogin,
        runId,
      },
    });
    if (dispatch) directPrerequisiteRunIds.set("github", dispatch.runId);
  }

  if (linkedInLinkChanged) {
    const linkedInUrl = linkedInLink(input.after.professionalLinks);
    if (linkedInUrl !== undefined) {
      const runId = createId();
      const dispatch = await enqueue({
        provider: "tikhub",
        payload: { profileId: input.profileId, linkedInUrl, runId },
      });
      if (dispatch) directPrerequisiteRunIds.set("tikhub", dispatch.runId);
    }
  }

  if (
    input.before.name !== input.after.name ||
    input.before.currentCompany !== input.after.currentCompany
  ) {
    const linkedInUrl = linkedInLink(input.after.professionalLinks);
    const directProviders = [
      "github",
      ...(linkedInUrl === undefined ? [] : (["tikhub"] as const)),
    ] as const;
    const directRuns = await database
      .select({
        id: enrichmentRuns.id,
        profileId: enrichmentRuns.profileId,
        provider: enrichmentRuns.provider,
        status: enrichmentRuns.status,
        startedAt: enrichmentRuns.startedAt,
        finishedAt: enrichmentRuns.finishedAt,
      })
      .from(enrichmentRuns)
      .where(
        and(
          eq(enrichmentRuns.profileId, input.profileId),
          inArray(enrichmentRuns.provider, directProviders),
        ),
      );
    const latestDirectRuns = latestRuns(directRuns).attempts;
    const directRunsById = new Map(directRuns.map((run) => [run.id, run]));
    const activeDirectDispatches = await database
      .select({
        provider: enrichmentDispatches.provider,
        runId: enrichmentDispatches.runId,
      })
      .from(enrichmentDispatches)
      .where(
        and(
          eq(enrichmentDispatches.profileId, input.profileId),
          inArray(enrichmentDispatches.provider, directProviders),
          inArray(enrichmentDispatches.state, [
            "pending",
            "leased",
            "delivered",
          ]),
        ),
      )
      .orderBy(desc(enrichmentDispatches.createdAt));
    for (const provider of directProviders) {
      if (directPrerequisiteRunIds.has(provider)) continue;
      const latestRun = latestDirectRuns.get(`${input.profileId}\0${provider}`);
      if (
        latestRun !== undefined &&
        (latestRun.status === "pending" || latestRun.status === "running")
      ) {
        directPrerequisiteRunIds.set(provider, latestRun.id);
        continue;
      }
      const activeDispatch = activeDirectDispatches.find((dispatch) => {
        if (dispatch.provider !== provider) return false;
        const run = directRunsById.get(dispatch.runId);
        return (
          run === undefined ||
          run.status === "pending" ||
          run.status === "running"
        );
      });
      if (activeDispatch !== undefined) {
        directPrerequisiteRunIds.set(provider, activeDispatch.runId);
        continue;
      }
      if (latestRun !== undefined) continue;
      const runId = createId();
      const dispatch =
        provider === "github"
          ? await enqueue({
              provider,
              payload: {
                profileId: input.profileId,
                githubLogin: input.after.githubLogin,
                runId,
              },
            })
          : linkedInUrl === undefined
            ? undefined
            : await enqueue({
                provider,
                payload: {
                  profileId: input.profileId,
                  linkedInUrl,
                  runId,
                },
              });
      if (dispatch) directPrerequisiteRunIds.set(provider, dispatch.runId);
    }
    const protectedFields = await listProtectedDeeplineFields(
      database,
      input.profileId,
      [...DEEPLINE_IDENTITY_FIELDS],
    );
    const protectedNames = new Set(protectedFields.map(({ field }) => field));
    const missingFields = DEEPLINE_IDENTITY_FIELDS.filter(
      (field) => !protectedNames.has(field),
    );
    if (missingFields.length > 0) {
      const runId = createId();
      await enqueue({
        provider: "deepline",
        payload: {
          profileId: input.profileId,
          runId,
          missingFields: [...missingFields],
          ...(directPrerequisiteRunIds.size === 0
            ? {}
            : {
                prerequisiteRunIds: [...directPrerequisiteRunIds.values()],
              }),
          identity: {
            fullName: input.after.name,
            ...(input.after.currentCompany === null
              ? {}
              : { companyName: input.after.currentCompany }),
          },
          ...(linkedInUrl === undefined ? {} : { linkedInUrl }),
        },
      });
    }
  }

  return created;
};

type RunRow = Pick<
  typeof enrichmentRuns.$inferSelect,
  "id" | "profileId" | "provider" | "status" | "startedAt" | "finishedAt"
>;

const latestRuns = (runs: RunRow[]) => {
  const attempts = new Map<string, RunRow>();
  const successes = new Map<string, RunRow>();
  for (const run of [...runs].sort(
    (left, right) => right.startedAt.getTime() - left.startedAt.getTime(),
  )) {
    const key = `${run.profileId}\0${run.provider}`;
    if (!attempts.has(key)) attempts.set(key, run);
    if (run.status === "succeeded" && !successes.has(key))
      successes.set(key, run);
  }
  return { attempts, successes };
};

const logicalDispatchAnchor = (
  provider: EnrichmentProvider,
  latestAttempt: RunRow | undefined,
  latestSuccess: RunRow | undefined,
  now: Date,
) => {
  if (
    latestAttempt?.status === "pending" ||
    latestAttempt?.status === "running"
  )
    return undefined;
  if (
    latestAttempt !== undefined &&
    latestAttempt.status !== "succeeded" &&
    (latestSuccess === undefined ||
      latestAttempt.startedAt.getTime() > latestSuccess.startedAt.getTime())
  ) {
    const failedAt = latestAttempt.finishedAt ?? latestAttempt.startedAt;
    return failedAt.getTime() +
      FAILED_REFRESH_RETRY_DAYS * DAY_IN_MILLISECONDS <=
      now.getTime()
      ? `retry:${latestAttempt.id}`
      : undefined;
  }
  if (latestSuccess === undefined) return "initial";
  const completedAt = latestSuccess.finishedAt ?? latestSuccess.startedAt;
  return isEnrichmentRefreshDue(provider, completedAt, now)
    ? `refresh:${latestSuccess.id}`
    : undefined;
};

const directStageInspected = (
  provider: "github" | "tikhub",
  latestAttempt: RunRow | undefined,
  latestSuccess: RunRow | undefined,
  now: Date,
) => {
  if (latestAttempt === undefined) return false;
  if (latestAttempt.status === "pending" || latestAttempt.status === "running")
    return false;
  if (latestAttempt.status !== "succeeded") return true;
  return (
    logicalDispatchAnchor(provider, latestAttempt, latestSuccess, now) ===
    undefined
  );
};

const linkedInLink = (urls: string[]) =>
  [...urls].sort().find((url) => urlKind(url) === "linkedinUrl");

export const createDueEnrichmentDispatches = async (
  database: DrizzleDatabase,
  options: {
    now?: Date;
    maxDispatches?: number;
    createId?: () => string;
  } = {},
) => {
  const now = options.now ?? new Date();
  const maxDispatches = options.maxDispatches ?? 500;
  const createId = options.createId ?? (() => crypto.randomUUID());
  if (
    Number.isNaN(now.getTime()) ||
    !Number.isSafeInteger(maxDispatches) ||
    maxDispatches < 1 ||
    maxDispatches > 1_000
  )
    throw new EnrichmentStoreError("invalid_dispatch");

  const eligibleProfiles = await database
    .select({
      profileId: profiles.profileId,
      name: profiles.name,
      currentCompany: profiles.currentCompany,
      githubLogin: profiles.githubLogin,
    })
    .from(profiles)
    .leftJoin(
      suppressionRecords,
      and(
        eq(suppressionRecords.canonicalProvider, "github"),
        eq(suppressionRecords.canonicalProviderId, profiles.githubAccountId),
      ),
    )
    .where(
      and(
        eq(profiles.searchable, true),
        eq(profiles.adultAttested, true),
        isNull(suppressionRecords.canonicalProviderId),
      ),
    )
    .orderBy(asc(profiles.profileId));
  if (eligibleProfiles.length === 0) return [];
  const profileIds = eligibleProfiles.map(({ profileId }) => profileId);
  const [links, runs, directDispatches] = await Promise.all([
    database
      .select()
      .from(professionalLinks)
      .where(inArray(professionalLinks.profileId, profileIds)),
    database
      .select({
        id: enrichmentRuns.id,
        profileId: enrichmentRuns.profileId,
        provider: enrichmentRuns.provider,
        status: enrichmentRuns.status,
        startedAt: enrichmentRuns.startedAt,
        finishedAt: enrichmentRuns.finishedAt,
      })
      .from(enrichmentRuns)
      .where(
        and(
          inArray(enrichmentRuns.profileId, profileIds),
          inArray(enrichmentRuns.provider, enrichmentProviders),
        ),
      )
      .orderBy(desc(enrichmentRuns.startedAt)),
    database
      .select({
        profileId: enrichmentDispatches.profileId,
        provider: enrichmentDispatches.provider,
        runId: enrichmentDispatches.runId,
      })
      .from(enrichmentDispatches)
      .where(
        and(
          inArray(enrichmentDispatches.profileId, profileIds),
          inArray(enrichmentDispatches.provider, ["github", "tikhub"]),
          inArray(enrichmentDispatches.state, [
            "pending",
            "leased",
            "delivered",
          ]),
        ),
      )
      .orderBy(desc(enrichmentDispatches.createdAt)),
  ]);
  const urlsByProfile = new Map<string, string[]>();
  for (const link of links) {
    const own = urlsByProfile.get(link.profileId) ?? [];
    own.push(link.url);
    urlsByProfile.set(link.profileId, own);
  }
  const latest = latestRuns(runs);
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const activeDirectDispatches = new Set<string>();
  for (const dispatch of directDispatches) {
    if (dispatch.provider !== "github" && dispatch.provider !== "tikhub")
      continue;
    const run = runsById.get(dispatch.runId);
    if (
      run !== undefined &&
      run.status !== "pending" &&
      run.status !== "running"
    )
      continue;
    activeDirectDispatches.add(`${dispatch.profileId}\0${dispatch.provider}`);
  }
  const created: EnrichmentDispatch[] = [];

  const enqueue = async (input: ProviderPayload, anchor: string) => {
    if (created.length >= maxDispatches) return;
    const dispatch = await enqueueEnrichmentDispatch(database, {
      ...input,
      dedupeKey: `${input.provider}:${input.payload.profileId}:${anchor}`,
      now,
    });
    if (dispatch !== undefined) created.push(dispatch);
  };

  for (const profile of eligibleProfiles) {
    if (created.length >= maxDispatches) break;
    const key = (provider: EnrichmentProvider) =>
      `${profile.profileId}\0${provider}`;
    const latestAttempt = (provider: EnrichmentProvider) =>
      latest.attempts.get(key(provider));
    const latestSuccess = (provider: EnrichmentProvider) =>
      latest.successes.get(key(provider));
    const githubAnchor = logicalDispatchAnchor(
      "github",
      latestAttempt("github"),
      latestSuccess("github"),
      now,
    );
    if (githubAnchor !== undefined) {
      const runId = createId();
      await enqueue(
        {
          provider: "github",
          payload: {
            profileId: profile.profileId,
            githubLogin: profile.githubLogin,
            runId,
          },
        },
        githubAnchor,
      );
    }

    const linkedInUrl = linkedInLink(
      urlsByProfile.get(profile.profileId) ?? [],
    );
    const tikHubAnchor =
      linkedInUrl === undefined
        ? undefined
        : logicalDispatchAnchor(
            "tikhub",
            latestAttempt("tikhub"),
            latestSuccess("tikhub"),
            now,
          );
    if (linkedInUrl !== undefined && tikHubAnchor !== undefined) {
      const runId = createId();
      await enqueue(
        {
          provider: "tikhub",
          payload: { profileId: profile.profileId, linkedInUrl, runId },
        },
        tikHubAnchor,
      );
    }

    const directSourcesInspected =
      githubAnchor === undefined &&
      !activeDirectDispatches.has(key("github")) &&
      directStageInspected(
        "github",
        latestAttempt("github"),
        latestSuccess("github"),
        now,
      ) &&
      (linkedInUrl === undefined ||
        (tikHubAnchor === undefined &&
          !activeDirectDispatches.has(key("tikhub")) &&
          directStageInspected(
            "tikhub",
            latestAttempt("tikhub"),
            latestSuccess("tikhub"),
            now,
          )));
    if (!directSourcesInspected) continue;
    const deeplineAnchor = logicalDispatchAnchor(
      "deepline",
      latestAttempt("deepline"),
      latestSuccess("deepline"),
      now,
    );
    if (deeplineAnchor === undefined) continue;
    const protectedFields = await listProtectedDeeplineFields(
      database,
      profile.profileId,
      [...DEEPLINE_FIELDS],
    );
    const protectedNames = new Set(protectedFields.map(({ field }) => field));
    const missingFields = DEEPLINE_FIELDS.filter(
      (field) => !protectedNames.has(field),
    );
    if (missingFields.length === 0) continue;
    const runId = createId();
    await enqueue(
      {
        provider: "deepline",
        payload: {
          profileId: profile.profileId,
          runId,
          missingFields: [...missingFields],
          identity: {
            fullName: profile.name,
            ...(profile.currentCompany === null
              ? {}
              : { companyName: profile.currentCompany }),
          },
          ...(linkedInUrl === undefined ? {} : { linkedInUrl }),
        },
      },
      deeplineAnchor,
    );
  }
  return created;
};

export const claimEnrichmentDispatches = async (
  database: DrizzleDatabase,
  options: {
    leaseOwner: string;
    now?: Date;
    limit?: number;
    leaseMilliseconds?: number;
  },
) => {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 25;
  const leaseMilliseconds = options.leaseMilliseconds ?? 10 * 60_000;
  if (
    !options.leaseOwner.trim() ||
    Number.isNaN(now.getTime()) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(leaseMilliseconds) ||
    leaseMilliseconds < 1
  )
    throw new EnrichmentStoreError("invalid_dispatch");
  const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);

  return database.transaction(async (transaction) => {
    const candidates = await transaction
      .select({ id: enrichmentDispatches.id })
      .from(enrichmentDispatches)
      .where(
        and(
          claimableDispatchPredicate,
          directPrerequisitesSatisfiedPredicate,
          or(
            and(
              eq(enrichmentDispatches.state, "pending"),
              lte(enrichmentDispatches.availableAt, now),
            ),
            and(
              eq(enrichmentDispatches.state, "leased"),
              eq(enrichmentDispatches.leaseOwner, options.leaseOwner),
            ),
          ),
        ),
      )
      .orderBy(
        asc(enrichmentDispatches.availableAt),
        asc(enrichmentDispatches.createdAt),
      )
      .limit(limit)
      .for("update", { of: enrichmentDispatches, skipLocked: true });
    if (candidates.length === 0) return [];
    const claimed = await transaction
      .update(enrichmentDispatches)
      .set({
        state: "leased",
        leaseOwner: options.leaseOwner,
        leaseExpiresAt,
        attempts: sql`${enrichmentDispatches.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          inArray(
            enrichmentDispatches.id,
            candidates.map(({ id }) => id),
          ),
          or(
            eq(enrichmentDispatches.state, "pending"),
            and(
              eq(enrichmentDispatches.state, "leased"),
              eq(enrichmentDispatches.leaseOwner, options.leaseOwner),
            ),
          ),
        ),
      )
      .returning();
    return claimed
      .map(dispatchFromRow)
      .sort((left, right) =>
        left.availableAt.getTime() === right.availableAt.getTime()
          ? left.id.localeCompare(right.id)
          : left.availableAt.getTime() - right.availableAt.getTime(),
      );
  });
};

export const markEnrichmentDispatchDelivered = async (
  database: DrizzleDatabase,
  input: {
    dispatchId: string;
    leaseOwner: string;
    triggerRunId: string;
    deliveredAt?: Date;
  },
) => {
  const deliveredAt = input.deliveredAt ?? new Date();
  if (!input.triggerRunId.trim() || Number.isNaN(deliveredAt.getTime()))
    throw new EnrichmentStoreError("invalid_dispatch");
  const [delivered] = await database
    .update(enrichmentDispatches)
    .set({
      state: "delivered",
      triggerRunId: input.triggerRunId,
      deliveredAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      updatedAt: deliveredAt,
    })
    .where(
      and(
        eq(enrichmentDispatches.id, input.dispatchId),
        eq(enrichmentDispatches.state, "leased"),
        eq(enrichmentDispatches.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: enrichmentDispatches.id });
  if (!delivered) throw new EnrichmentStoreError("dispatch_lease_lost");
};

export const releaseEnrichmentDispatch = async (
  database: DrizzleDatabase,
  input: {
    dispatchId: string;
    leaseOwner: string;
    errorCode: string;
    availableAt?: Date;
  },
) => {
  const availableAt = input.availableAt ?? new Date();
  if (
    !/^[a-z0-9:_-]{1,100}$/i.test(input.errorCode) ||
    Number.isNaN(availableAt.getTime())
  )
    throw new EnrichmentStoreError("invalid_dispatch");
  const [released] = await database
    .update(enrichmentDispatches)
    .set({
      state: "pending",
      availableAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: input.errorCode,
      updatedAt: availableAt,
    })
    .where(
      and(
        eq(enrichmentDispatches.id, input.dispatchId),
        eq(enrichmentDispatches.state, "leased"),
        eq(enrichmentDispatches.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: enrichmentDispatches.id });
  if (!released) throw new EnrichmentStoreError("dispatch_lease_lost");
};

export const recoverEnrichmentDispatches = async (
  database: DrizzleDatabase,
  now = new Date(),
) => {
  if (Number.isNaN(now.getTime()))
    throw new EnrichmentStoreError("invalid_dispatch");
  return database.transaction(async (transaction) => {
    const recovered = await transaction
      .update(enrichmentDispatches)
      .set({
        state: "pending",
        availableAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: "lease_expired",
        updatedAt: now,
      })
      .where(
        and(
          eq(enrichmentDispatches.state, "leased"),
          lte(enrichmentDispatches.leaseExpiresAt, now),
        ),
      )
      .returning({ id: enrichmentDispatches.id });
    const cancelled = await transaction
      .update(enrichmentDispatches)
      .set({
        state: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: "profile_suppressed",
        updatedAt: now,
      })
      .where(
        and(
          eq(enrichmentDispatches.state, "pending"),
          sql`not (${unsuppressedDispatchPredicate})`,
        ),
      )
      .returning({ id: enrichmentDispatches.id });
    return { recovered: recovered.length, cancelled: cancelled.length };
  });
};

export const suppressGitHubInaccessibleProfiles = async (
  database: DrizzleDatabase,
  now = new Date(),
) => {
  if (Number.isNaN(now.getTime()))
    throw new EnrichmentStoreError("invalid_dispatch");
  const cutoff = new Date(now.getTime() - 30 * DAY_IN_MILLISECONDS);
  return database.transaction(async (transaction) => {
    const candidates = await transaction
      .select({
        profileId: profiles.profileId,
        githubAccountId: profiles.githubAccountId,
      })
      .from(profiles)
      .leftJoin(
        suppressionRecords,
        and(
          eq(suppressionRecords.canonicalProvider, "github"),
          eq(suppressionRecords.canonicalProviderId, profiles.githubAccountId),
        ),
      )
      .where(
        and(
          eq(profiles.searchable, true),
          lte(profiles.githubInaccessibleSince, cutoff),
          isNull(suppressionRecords.canonicalProviderId),
        ),
      )
      .for("update", { of: profiles });
    if (candidates.length === 0) return 0;
    await transaction.insert(suppressionRecords).values(
      candidates.map(({ githubAccountId }) => ({
        canonicalProvider: "github",
        canonicalProviderId: githubAccountId,
        reason: "github_inaccessible_30_days",
        createdAt: now,
      })),
    );
    const profileIds = candidates.map(({ profileId }) => profileId);
    await transaction
      .update(profiles)
      .set({
        searchable: false,
        searchabilityReason: "operator_suppression",
        updatedAt: now,
      })
      .where(inArray(profiles.profileId, profileIds));
    await transaction
      .update(enrichmentDispatches)
      .set({
        state: "cancelled",
        lastErrorCode: "profile_suppressed",
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          inArray(enrichmentDispatches.profileId, profileIds),
          eq(enrichmentDispatches.state, "pending"),
        ),
      );
    return candidates.length;
  });
};

/** Opens and closes one raw Neon pool around a single Trigger.dev invocation. */
export const withNeonEnrichmentDatabase = async <Value>(
  databaseUrl: string,
  operation: (database: DrizzleDatabase) => Promise<Value>,
) => {
  if (!databaseUrl.trim())
    throw new EnrichmentStoreError(
      "invalid_dispatch",
      "DATABASE_URL is required",
    );
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    return await operation(drizzle(pool, { schema }));
  } finally {
    await pool.end();
  }
};
