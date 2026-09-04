import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  DEEPLINE_CAREER_TOOL_ID,
  DEEPLINE_IDENTITY_TOOL_ID,
  type DeeplineField,
  type DeeplineObservation,
} from "../../deepline-enrichment/src/types.js";
import type { Observation as GitHubObservation } from "../../github-enrichment/src/types.js";
import type {
  TikHubObservation,
  TikHubStore,
} from "../../tikhub-enrichment/src/types.js";
import { createTikHubEnrichmentWorkflow } from "../../tikhub-enrichment/src/workflow.js";

import { listContactDetails } from "../src/contact-reveals";
import {
  claimEnrichmentDispatches,
  createDeeplineEnrichmentStore,
  createDueEnrichmentDispatches,
  createGitHubEnrichmentStore,
  createTikHubEnrichmentStore,
  deleteExpiredEnrichmentCheckpoints,
  enqueueAffectedMemberEditDispatches,
  enqueueEnrichmentDispatch,
  enrichmentRefreshDueAt,
  isEnrichmentRefreshDue,
  markEnrichmentDispatchDelivered,
  recoverEnrichmentDispatches,
  suppressGitHubInaccessibleProfiles,
} from "../src/enrichment";
import { recordEnrichmentRun } from "../src/operations";
import {
  resolveProfileField,
  reviewProfileRequest,
  submitPublicProfileRequest,
  verifyProfileRequest,
} from "../src/profile-control";
import * as schema from "../src/schema";

const startedAt = "2026-09-01T00:00:00.000Z";
const requestVerification = (requestId: string) => ({
  operatorId: "operator-enrichment",
  correlationId: `verify-${requestId}`,
  verificationMethod: "email_challenge",
  evidenceReference: `evidence://profile-request/${requestId}`,
});
const requestDecision = (requestId: string) => ({
  operatorId: "operator-enrichment",
  correlationId: `review-${requestId}`,
});

const githubAccountObservation = (
  profileId = "profile_one",
  accountId = 42,
  collectedAt = startedAt,
  login = "ada",
): GitHubObservation => ({
  profileId,
  sourceRecordId: "github-account:42",
  kind: "github-account",
  value: {
    id: accountId,
    login,
    name: "Ada",
    bio: null,
    company: null,
    location: "Lima",
    blog: null,
    type: "User",
  },
  source: "github",
  collectedAt,
  confidence: 1,
  pipelineVersion: "github-v1",
});

const tikHubObservation = (
  kind: TikHubObservation["kind"],
  sourceRecordId: string,
  value: unknown,
  profileId = "profile_one",
): TikHubObservation => ({
  profileId,
  sourceRecordId,
  kind,
  value,
  sourceIdentity: "tikhub",
  sourceCategory: "professional-network",
  collectedAt: startedAt,
  confidence: 1,
  pipelineVersion: "tikhub-linkedin-v1",
});

const deeplineObservation = (
  field: DeeplineField,
  sourceRecordId: string,
  value: unknown,
  profileId = "profile_one",
): DeeplineObservation => ({
  profileId,
  sourceRecordId,
  field,
  value,
  source: "deepline",
  providerToolId: ["linkedinUrl", "githubUrl", "xUrl"].includes(field)
    ? DEEPLINE_IDENTITY_TOOL_ID
    : DEEPLINE_CAREER_TOOL_ID,
  collectedAt: startedAt,
  confidence: 0.8,
  pipelineVersion: "deepline-fallback-v1",
});

describe("production enrichment stores", () => {
  const resources: {
    container?: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
    pool?: Pool;
  } = {};
  let database: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    resources.container = await new PostgreSqlContainer(
      "pgvector/pgvector:pg17",
    ).start();
    resources.pool = new Pool({
      connectionString: resources.container.getConnectionUri(),
    });
    database = drizzle(resources.pool, { schema });
    await migrate(database, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
  });

  beforeEach(async () => {
    await database.delete(schema.reenrichmentOutbox);
    await database.delete(schema.contactDetailInvalidations);
    await database.delete(schema.enrichmentDispatches);
    await database.delete(schema.enrichmentCheckpoints);
    await database.delete(schema.enrichmentRuns);
    await database.delete(schema.memberStatements);
    await database.delete(schema.profileObservations);
    await database.delete(schema.professionalLinks);
    await database.delete(schema.profileClaims);
    await database.delete(schema.profileRequests);
    await database.delete(schema.profiles);
    await database.delete(schema.companies);
    await database.delete(schema.suppressionRecords);
    await database.delete(schema.organizationMemberships);
    await database.delete(schema.organizations);
    await database.delete(schema.members);

    await database.insert(schema.members).values({
      clerkId: "member_one",
      name: "Member One",
    });
    await database.insert(schema.organizations).values({
      clerkId: "organization_one",
      name: "Organization One",
    });
    await database.insert(schema.organizationMemberships).values({
      clerkId: "membership_one",
      memberId: "member_one",
      organizationId: "organization_one",
      role: "org:member",
    });
    await database.insert(schema.profiles).values([
      {
        profileId: "profile_one",
        name: "Profile One",
        githubAccountId: "42",
        githubLogin: "ada",
        eligibilityBasis: "owned_repository",
        adultAttested: true,
        searchable: true,
        searchabilityReason: "approved_import",
      },
      {
        profileId: "profile_two",
        name: "Profile Two",
        githubAccountId: "84",
        githubLogin: "grace",
        eligibilityBasis: "owned_repository",
        adultAttested: true,
        searchable: true,
        searchabilityReason: "approved_import",
      },
    ]);
  });

  afterAll(async () => {
    await resources.pool?.end();
    await resources.container?.stop();
  });

  it("reconstructs run progress and rejects run ID reuse across Profiles or providers", async () => {
    const github = createGitHubEnrichmentStore(database);
    const tikHub = createTikHubEnrichmentStore(database);
    const pending = await github.getOrCreateRun(
      "profile_one",
      "shared-run",
      startedAt,
    );
    expect(pending).toEqual({
      id: "shared-run",
      profileId: "profile_one",
      status: "pending",
      completedStages: [],
      currentStage: null,
      startedAt,
    });

    await github.saveRun({
      ...pending,
      status: "running",
      completedStages: ["account"],
      currentStage: "repositories",
      error: "temporary provider failure",
    });
    expect(await github.getRun("shared-run")).toEqual({
      ...pending,
      status: "running",
      completedStages: ["account"],
      currentStage: "repositories",
      error: "temporary provider failure",
    });
    await github.saveRun({
      ...pending,
      status: "succeeded",
      completedStages: [
        "account",
        "repositories",
        "normalization",
        "persistence",
      ],
      currentStage: null,
      finishedAt: "2026-09-01T00:05:00.000Z",
    });
    expect(await github.getRun("shared-run")).toMatchObject({
      status: "succeeded",
      currentStage: null,
      finishedAt: "2026-09-01T00:05:00.000Z",
    });
    expect(await github.getRun("shared-run")).not.toHaveProperty("error");

    await expect(
      github.getOrCreateRun("profile_two", "shared-run", startedAt),
    ).rejects.toMatchObject({ code: "run_id_collision" });
    await expect(
      tikHub.getOrCreateRun("profile_one", "shared-run", startedAt),
    ).rejects.toMatchObject({ code: "run_id_collision" });
    await expect(
      recordEnrichmentRun(database, {
        id: "shared-run",
        profileId: "profile_two",
        provider: "github",
        status: "failed",
        pipelineVersion: "github-v1",
      }),
    ).rejects.toMatchObject({ code: "run_id_collision" });
  });

  it("returns only live typed checkpoints and physically deletes expired rows", async () => {
    const store = createGitHubEnrichmentStore(database);
    await store.getOrCreateRun("profile_one", "checkpoint-run", startedAt);
    await store.saveCheckpoint(
      "checkpoint-run",
      "account",
      { value: { id: 42 }, collectedAt: startedAt },
      { expiresAt: "2020-01-01T00:00:00.000Z" },
    );
    await store.saveCheckpoint(
      "checkpoint-run",
      "repositories",
      { repositories: [1, 2] },
      { expiresAt: "2100-01-01T00:00:00.000Z" },
    );
    await store.saveCheckpoint("checkpoint-run", "normalization", {
      skills: ["TypeScript"],
    });

    expect(
      await store.loadCheckpoint<{ value: { id: number } }>(
        "checkpoint-run",
        "account",
      ),
    ).toBeUndefined();
    expect(
      await store.loadCheckpoint<{ repositories: number[] }>(
        "checkpoint-run",
        "repositories",
      ),
    ).toEqual({ repositories: [1, 2] });
    expect(
      await database.select().from(schema.enrichmentCheckpoints),
    ).toHaveLength(3);

    await expect(
      deleteExpiredEnrichmentCheckpoints(
        database,
        new Date("2026-09-01T00:00:00.000Z"),
      ),
    ).resolves.toBe(1);
    expect(
      (await database.select().from(schema.enrichmentCheckpoints)).map(
        ({ stage }) => stage,
      ),
    ).toEqual(expect.arrayContaining(["repositories", "normalization"]));
  });

  it("resumes a TikHub workflow from durable checkpoints after a late retry", async () => {
    const persistentStore = createTikHubEnrichmentStore(database);
    let failPersistence = true;
    const store: TikHubStore = {
      ...persistentStore,
      persistObservations: async (runId, observations) => {
        if (failPersistence) {
          failPersistence = false;
          throw new Error("database unavailable");
        }
        await persistentStore.persistObservations(runId, observations);
      },
    };
    const getLinkedInProfile = vi.fn(async () => ({
      sourceRecordId: "linkedin:ada",
      headline: "Engineer",
      currentCompany: "Analytical Engines",
      experience: [],
      education: [],
      skills: ["TypeScript"],
      contacts: [],
    }));
    const workflow = createTikHubEnrichmentWorkflow({
      provider: { getLinkedInProfile },
      store,
      now: () => new Date(startedAt),
      log: () => undefined,
    });
    const input = {
      profileId: "profile_one",
      linkedInUrl: "https://linkedin.com/in/ada",
      runId: "workflow-retry",
    };

    await expect(workflow(input)).rejects.toThrow("database unavailable");
    expect(await store.getRun(input.runId)).toMatchObject({
      status: "running",
      completedStages: ["fetch", "normalization"],
      currentStage: "persistence",
      error: "database unavailable",
    });
    await expect(workflow(input)).resolves.toMatchObject({
      status: "succeeded",
      completedStages: ["fetch", "normalization", "persistence"],
    });
    await expect(workflow(input)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(getLinkedInProfile).toHaveBeenCalledTimes(1);
    expect(
      await database
        .select()
        .from(schema.profileObservations)
        .where(eq(schema.profileObservations.source, "tikhub")),
    ).toHaveLength(1);
  });

  it("promotes LinkedIn company for imported Profiles without overriding stronger values", async () => {
    const store = createTikHubEnrichmentStore(database);
    await database
      .update(schema.profiles)
      .set({ currentCompany: "Imported Company" })
      .where(eq(schema.profiles.profileId, "profile_one"));
    await database
      .update(schema.profiles)
      .set({
        memberId: "member_one",
        currentCompany: "Member Company",
      })
      .where(eq(schema.profiles.profileId, "profile_two"));
    await database.insert(schema.profileObservations).values({
      profileId: "profile_one",
      field: "current_company",
      value: "Imported Company",
      source: "approved-import",
      sourceRecordId: "imported-company",
      pipelineVersion: "humans-profiles-v1",
      confidence: 1,
      collectedAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    await store.getOrCreateRun("profile_one", "imported-company", startedAt);
    await store.persistObservations("imported-company", [
      tikHubObservation("linkedin-career", "linkedin:imported", {
        currentCompany: "LinkedIn Company",
        currentCompanyId: "linkedin-company-1",
        experience: [
          {
            sourceRecordId: "linkedin:imported:experience:1",
            organization: "LinkedIn Company",
            companyId: "linkedin-company-1",
            title: "Engineer",
            startedAt: "2024",
            endedAt: "Present",
          },
        ],
      }),
    ]);
    await store.getOrCreateRun("profile_two", "member-company", startedAt);
    await store.persistObservations("member-company", [
      tikHubObservation(
        "linkedin-career",
        "linkedin:member",
        { currentCompany: "Other LinkedIn Company" },
        "profile_two",
      ),
    ]);

    await expect(
      database
        .select({
          profileId: schema.profiles.profileId,
          currentCompany: schema.profiles.currentCompany,
        })
        .from(schema.profiles)
        .orderBy(asc(schema.profiles.profileId)),
    ).resolves.toEqual([
      { profileId: "profile_one", currentCompany: "LinkedIn Company" },
      { profileId: "profile_two", currentCompany: "Member Company" },
    ]);
    const structuredEmployments = await database
      .select({
        companyId: schema.employments.companyId,
        current: schema.employments.current,
        sourceRecordId: schema.employments.sourceRecordId,
        staleAt: schema.employments.staleAt,
      })
      .from(schema.employments)
      .where(eq(schema.employments.profileId, "profile_one"))
      .orderBy(asc(schema.employments.sourceRecordId));
    expect(structuredEmployments).toHaveLength(1);
    expect(
      new Set(structuredEmployments.map(({ companyId }) => companyId)).size,
    ).toBe(1);
    expect(structuredEmployments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          current: true,
          sourceRecordId: "linkedin:imported:experience:1",
          staleAt: null,
        }),
      ]),
    );

    await store.getOrCreateRun(
      "profile_one",
      "imported-company-empty-refresh",
      startedAt,
    );
    await store.persistObservations("imported-company-empty-refresh", [
      tikHubObservation("linkedin-career", "linkedin:imported", {
        currentCompany: null,
      }),
    ]);
    await expect(
      database
        .select({ currentCompany: schema.profiles.currentCompany })
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, "profile_one")),
    ).resolves.toEqual([{ currentCompany: "Imported Company" }]);

    await store.getOrCreateRun(
      "profile_one",
      "imported-company-second-refresh",
      startedAt,
    );
    await store.persistObservations("imported-company-second-refresh", [
      tikHubObservation("linkedin-career", "linkedin:imported", {
        currentCompany: "Second LinkedIn Company",
        currentCompanyId: "linkedin-company-2",
      }),
    ]);
    const companyIdentities = await database
      .select({
        companyId: schema.companyIdentities.companyId,
        value: schema.companyIdentities.value,
      })
      .from(schema.companyIdentities)
      .orderBy(asc(schema.companyIdentities.value));
    expect(companyIdentities).toHaveLength(2);
    expect(companyIdentities[0]?.companyId).not.toBe(
      companyIdentities[1]?.companyId,
    );

    await store.markTikHubObservationsStale(
      "profile_one",
      "2026-09-02T00:00:00.000Z",
    );
    await store.markTikHubObservationsStale(
      "profile_two",
      "2026-09-02T00:00:00.000Z",
    );
    await expect(
      database
        .select()
        .from(schema.employments)
        .where(
          and(
            eq(schema.employments.profileId, "profile_one"),
            eq(schema.employments.source, "tikhub"),
            isNull(schema.employments.staleAt),
          ),
        ),
    ).resolves.toEqual([]);
    await expect(
      database
        .select({
          profileId: schema.profiles.profileId,
          currentCompany: schema.profiles.currentCompany,
        })
        .from(schema.profiles)
        .orderBy(asc(schema.profiles.profileId)),
    ).resolves.toEqual([
      { profileId: "profile_one", currentCompany: "Imported Company" },
      { profileId: "profile_two", currentCompany: "Member Company" },
    ]);

    const correctionRequest = await submitPublicProfileRequest(database, {
      profileId: "profile_one",
      kind: "correction",
      requesterEmail: "reviewed-correction@example.com",
      details: "Correct the current company",
    });
    await verifyProfileRequest(
      database,
      correctionRequest.id,
      requestVerification(correctionRequest.id),
    );
    await reviewProfileRequest(database, correctionRequest.id, true, {
      ...requestDecision(correctionRequest.id),
      correction: { currentCompany: "Reviewed Correction" },
    });
    await store.getOrCreateRun(
      "profile_one",
      "imported-company-after-correction",
      startedAt,
    );
    await store.persistObservations("imported-company-after-correction", [
      tikHubObservation("linkedin-career", "linkedin:imported", {
        currentCompany: "Third LinkedIn Company",
      }),
    ]);
    await expect(
      database
        .select({ currentCompany: schema.profiles.currentCompany })
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, "profile_one")),
    ).resolves.toEqual([{ currentCompany: "Reviewed Correction" }]);

    const clearRequest = await submitPublicProfileRequest(database, {
      profileId: "profile_one",
      kind: "correction",
      requesterEmail: "reviewed-clear@example.com",
      details: "Clear the current company",
    });
    await verifyProfileRequest(
      database,
      clearRequest.id,
      requestVerification(clearRequest.id),
    );
    await reviewProfileRequest(database, clearRequest.id, true, {
      ...requestDecision(clearRequest.id),
      correction: { currentCompany: null },
    });
    await database
      .update(schema.profileObservations)
      .set({ collectedAt: new Date("2030-01-01T00:00:00.000Z") })
      .where(eq(schema.profileObservations.sourceRecordId, clearRequest.id));
    await store.getOrCreateRun(
      "profile_one",
      "imported-company-after-cleared-correction",
      startedAt,
    );
    await store.persistObservations(
      "imported-company-after-cleared-correction",
      [
        tikHubObservation("linkedin-career", "linkedin:imported", {
          currentCompany: "Fourth LinkedIn Company",
        }),
      ],
    );
    await expect(
      database
        .select({ currentCompany: schema.profiles.currentCompany })
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, "profile_one")),
    ).resolves.toEqual([{ currentCompany: null }]);
  });

  it("removes a stale GitHub company from imported Profile materialization", async () => {
    await database
      .update(schema.profiles)
      .set({ currentCompany: "Imported Company" })
      .where(eq(schema.profiles.profileId, "profile_one"));
    await database.insert(schema.profileObservations).values({
      profileId: "profile_one",
      field: "current_company",
      value: "Imported Company",
      source: "approved-import",
      sourceRecordId: "stale-github-company-import",
      pipelineVersion: "humans-profiles-v1",
      confidence: 1,
    });
    const github = createGitHubEnrichmentStore(database);
    await github.getOrCreateRun(
      "profile_one",
      "stale-github-company",
      startedAt,
    );
    await github.persistObservations("stale-github-company", [
      {
        ...githubAccountObservation(),
        value: {
          id: 42,
          login: "ada",
          name: "Ada",
          bio: null,
          company: "GitHub Company",
          location: "Lima",
          blog: null,
          type: "User",
        },
      },
    ]);
    const tikHub = createTikHubEnrichmentStore(database);
    await tikHub.getOrCreateRun(
      "profile_one",
      "empty-tikhub-company",
      startedAt,
    );
    await tikHub.persistObservations("empty-tikhub-company", [
      tikHubObservation("linkedin-career", "linkedin:empty-company", {
        currentCompany: null,
      }),
    ]);
    await expect(
      database
        .select({ currentCompany: schema.profiles.currentCompany })
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, "profile_one")),
    ).resolves.toEqual([{ currentCompany: "GitHub Company" }]);

    await github.markGitHubObservationsStale(
      "profile_one",
      "2026-09-02T00:00:00.000Z",
    );

    await expect(
      database
        .select({ currentCompany: schema.profiles.currentCompany })
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, "profile_one")),
    ).resolves.toEqual([{ currentCompany: "Imported Company" }]);
  });

  it("makes retry persistence idempotent, validates immutable identity, and clears only refreshed staleness", async () => {
    const github = createGitHubEnrichmentStore(database);
    const tikHub = createTikHubEnrichmentStore(database);
    await github.getOrCreateRun("profile_one", "github-run-one", startedAt);
    const account = githubAccountObservation();
    await Promise.all([
      github.persistObservations("github-run-one", [account]),
      github.persistObservations("github-run-one", [account]),
    ]);
    expect(await github.getImmutableGitHubUserId("profile_one")).toBe(42);
    expect(
      await database
        .select()
        .from(schema.profileObservations)
        .where(eq(schema.profileObservations.source, "github")),
    ).toHaveLength(1);

    await tikHub.getOrCreateRun("profile_one", "tikhub-run", startedAt);
    await tikHub.persistObservations("tikhub-run", [
      tikHubObservation("linkedin-career", "linkedin:ada", {
        headline: "Engineer",
      }),
    ]);
    await github.markGitHubObservationsStale(
      "profile_one",
      "2026-09-02T00:00:00.000Z",
    );
    const staleRows = await database
      .select({
        source: schema.profileObservations.source,
        staleAt: schema.profileObservations.staleAt,
      })
      .from(schema.profileObservations)
      .orderBy(asc(schema.profileObservations.source));
    expect(staleRows).toEqual([
      { source: "github", staleAt: new Date("2026-09-02T00:00:00.000Z") },
      { source: "tikhub", staleAt: null },
    ]);

    await github.getOrCreateRun(
      "profile_one",
      "github-run-refresh",
      "2026-09-03T00:00:00.000Z",
    );
    await github.persistObservations("github-run-refresh", [
      githubAccountObservation(
        "profile_one",
        42,
        "2026-09-03T00:00:00.000Z",
        "ada-renamed",
      ),
    ]);
    const [refreshed] = await database
      .select()
      .from(schema.profileObservations)
      .where(eq(schema.profileObservations.source, "github"));
    expect(refreshed).toMatchObject({
      collectedAt: new Date("2026-09-03T00:00:00.000Z"),
      staleAt: null,
    });
    await expect(
      database
        .select({ githubLogin: schema.profiles.githubLogin })
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, "profile_one")),
    ).resolves.toEqual([{ githubLogin: "ada-renamed" }]);
    await tikHub.markTikHubObservationsStale(
      "profile_one",
      "2026-09-04T00:00:00.000Z",
    );
    const providerStaleness = await database
      .select({
        source: schema.profileObservations.source,
        staleAt: schema.profileObservations.staleAt,
      })
      .from(schema.profileObservations)
      .orderBy(asc(schema.profileObservations.source));
    expect(providerStaleness).toEqual([
      { source: "github", staleAt: null },
      { source: "tikhub", staleAt: new Date("2026-09-04T00:00:00.000Z") },
    ]);

    await github.getOrCreateRun("profile_one", "mismatch-run", startedAt);
    await expect(
      github.persistObservations("mismatch-run", [
        githubAccountObservation("profile_one", 84),
      ]),
    ).rejects.toMatchObject({ code: "github_account_id_mismatch" });
    await expect(
      github.persistObservations("mismatch-run", [account]),
    ).resolves.toBeUndefined();
  });

  it("purges provider values, retains run history, and blocks recreation", async () => {
    const github = createGitHubEnrichmentStore(database);
    const tikHub = createTikHubEnrichmentStore(database);
    const deepline = createDeeplineEnrichmentStore(database);
    const githubRun = await github.getOrCreateRun(
      "profile_one",
      "removed-github",
      startedAt,
    );
    await tikHub.getOrCreateRun("profile_one", "removed-tikhub", startedAt);
    await deepline.getOrCreateRun("profile_one", "removed-deepline", startedAt);
    await recordEnrichmentRun(database, {
      id: "removed-legacy-writer",
      profileId: "profile_one",
      provider: "github",
      status: "running",
      pipelineVersion: "github-v1",
    });
    await github.saveCheckpoint("removed-github", "account", {
      login: "ada",
      email: "private@example.com",
    });
    await enqueueEnrichmentDispatch(database, {
      provider: "github",
      payload: {
        profileId: "profile_one",
        githubLogin: "ada",
        runId: "removed-dispatch",
      },
      dedupeKey: "removed-dispatch",
    });

    const request = await submitPublicProfileRequest(database, {
      profileId: "profile_one",
      kind: "removal",
      requesterEmail: "ada@example.com",
      details: "Please remove this Profile",
    });
    await verifyProfileRequest(
      database,
      request.id,
      requestVerification(request.id),
    );
    await reviewProfileRequest(
      database,
      request.id,
      true,
      requestDecision(request.id),
    );

    await expect(
      database.select().from(schema.enrichmentRuns),
    ).resolves.toHaveLength(4);
    await expect(
      database.select().from(schema.enrichmentCheckpoints),
    ).resolves.toEqual([]);
    await expect(
      database.select().from(schema.enrichmentDispatches),
    ).resolves.toEqual([]);
    await expect(
      database.select().from(schema.profileObservations),
    ).resolves.toEqual([]);
    await expect(
      github.getOrCreateRun("profile_one", "after-removal", startedAt),
    ).rejects.toMatchObject({ code: "profile_suppressed" });
    await expect(
      github.persistObservations("removed-github", [
        githubAccountObservation(),
      ]),
    ).rejects.toMatchObject({ code: "profile_suppressed" });
    await expect(
      github.saveRun({
        ...githubRun,
        status: "failed",
        error: "late provider result",
        finishedAt: "2026-09-03T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "profile_suppressed" });
    await expect(
      github.markGitHubInaccessibleIfUnset(
        "profile_one",
        "2026-09-03T00:00:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "profile_suppressed" });
    await expect(
      recordEnrichmentRun(database, {
        id: "removed-legacy-writer",
        profileId: "profile_one",
        provider: "github",
        status: "failed",
        pipelineVersion: "github-v1",
        error: "late provider result",
      }),
    ).rejects.toMatchObject({ code: "profile_suppressed" });
    await expect(
      database
        .select({
          status: schema.enrichmentRuns.status,
          error: schema.enrichmentRuns.error,
        })
        .from(schema.enrichmentRuns)
        .where(eq(schema.enrichmentRuns.id, "removed-legacy-writer")),
    ).resolves.toEqual([{ status: "running", error: null }]);
    await expect(
      tikHub.persistObservations("removed-tikhub", [
        tikHubObservation("linkedin-career", "linkedin:removed", {
          headline: "Recreated",
        }),
      ]),
    ).rejects.toMatchObject({ code: "profile_suppressed" });
    await expect(
      deepline.persistObservations("removed-deepline", [
        deeplineObservation("headline", "deepline:removed", "Recreated"),
      ]),
    ).rejects.toMatchObject({ code: "profile_suppressed" });
  });

  it("maps TikHub Contact Details into the existing Contact Reveal read model", async () => {
    const store = createTikHubEnrichmentStore(database);
    await store.getOrCreateRun("profile_one", "contact-run", startedAt);
    const observations = [
      tikHubObservation("linkedin-career", "linkedin:ada", {
        headline: "Staff Engineer",
      }),
      tikHubObservation("contact-detail", "linkedin:ada:email", {
        type: "professional-email",
        value: "ada@analytical.example",
      }),
      tikHubObservation("contact-detail", "linkedin:ada:phone", {
        type: "direct-professional-phone",
        value: "+51 999 555 111",
      }),
    ];
    await store.persistObservations("contact-run", observations);
    await store.persistObservations("contact-run", observations);

    expect(
      await listContactDetails(
        database,
        "member_one",
        "organization_one",
        "profile_one",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "professional-email",
          maskedValue: "a***@a***.example",
          sourceCategory: "professional-network",
        }),
        expect.objectContaining({
          type: "direct-professional-phone",
          sourceCategory: "professional-network",
        }),
      ]),
    );
    expect(
      await database
        .select()
        .from(schema.profileObservations)
        .where(eq(schema.profileObservations.source, "tikhub")),
    ).toHaveLength(3);
  });

  it("invalidates TikHub evidence and refreshes only the replacement LinkedIn Professional Link", async () => {
    const now = new Date("2026-09-02T00:00:00.000Z");
    const oldLinkedInUrl = "https://linkedin.com/in/ada-old";
    const newLinkedInUrl = "https://linkedin.com/in/ada-new";
    await database
      .update(schema.profiles)
      .set({ memberId: "member_one" })
      .where(eq(schema.profiles.profileId, "profile_one"));
    await database.insert(schema.professionalLinks).values({
      profileId: "profile_one",
      url: oldLinkedInUrl,
      source: "member",
      sourceRecordId: "member_one",
    });
    const tikHub = createTikHubEnrichmentStore(database);
    await tikHub.getOrCreateRun("profile_one", "old-linkedin-run", startedAt);
    await tikHub.persistObservations("old-linkedin-run", [
      tikHubObservation("linkedin-career", "linkedin:ada-old", {
        headline: "Old headline",
        currentCompany: "Old company",
        experience: [{ organization: "Old company" }],
        education: [],
        skills: ["Old skill"],
      }),
      tikHubObservation("contact-detail", "linkedin:ada-old:email", {
        type: "professional-email",
        value: "old@example.com",
      }),
    ]);
    await expect(
      resolveProfileField(database, "profile_one", "linkedin-career"),
    ).resolves.toMatchObject({
      value: expect.objectContaining({ headline: "Old headline" }),
    });
    await expect(
      listContactDetails(
        database,
        "member_one",
        "organization_one",
        "profile_one",
      ),
    ).resolves.toHaveLength(1);

    await database
      .delete(schema.professionalLinks)
      .where(eq(schema.professionalLinks.profileId, "profile_one"));
    await database.insert(schema.professionalLinks).values({
      profileId: "profile_one",
      url: newLinkedInUrl,
      source: "member",
      sourceRecordId: "member_one",
    });
    const ids = ["member-edit-one", "new-tikhub-run"];
    const dispatches = await database.transaction((tx) =>
      enqueueAffectedMemberEditDispatches(tx, {
        memberId: "member_one",
        profileId: "profile_one",
        before: {
          name: "Profile One",
          currentCompany: null,
          githubLogin: "ada",
          professionalLinks: [oldLinkedInUrl],
        },
        after: {
          name: "Profile One",
          currentCompany: null,
          githubLogin: "ada",
          professionalLinks: [newLinkedInUrl],
        },
        now,
        createId: () => {
          const id = ids.shift();
          if (id === undefined) throw new Error("Missing dispatch ID fixture");
          return id;
        },
      }),
    );

    expect(dispatches).toEqual([
      expect.objectContaining({
        provider: "tikhub",
        runId: "new-tikhub-run",
        payload: expect.objectContaining({ linkedInUrl: newLinkedInUrl }),
      }),
    ]);
    await expect(
      database
        .select({ staleAt: schema.profileObservations.staleAt })
        .from(schema.profileObservations)
        .where(eq(schema.profileObservations.source, "tikhub")),
    ).resolves.toEqual([{ staleAt: now }, { staleAt: now }]);
    await expect(
      resolveProfileField(database, "profile_one", "linkedin-career"),
    ).resolves.toBeNull();
    await expect(
      listContactDetails(
        database,
        "member_one",
        "organization_one",
        "profile_one",
      ),
    ).resolves.toEqual([]);
    await expect(
      createDeeplineEnrichmentStore(database).listProtectedFields(
        "profile_one",
        ["headline", "currentPosition", "experience", "education", "skills"],
      ),
    ).resolves.toEqual([]);
  });

  it("preserves the first GitHub inaccessible timestamp until access is cleared", async () => {
    const store = createGitHubEnrichmentStore(database);
    await expect(
      store.markGitHubInaccessibleIfUnset(
        "profile_one",
        "2026-08-01T00:00:00.000Z",
      ),
    ).resolves.toBe("2026-08-01T00:00:00.000Z");
    await expect(
      store.markGitHubInaccessibleIfUnset(
        "profile_one",
        "2026-09-01T00:00:00.000Z",
      ),
    ).resolves.toBe("2026-08-01T00:00:00.000Z");

    await store.clearGitHubInaccessible("profile_one");
    await store.clearGitHubInaccessible("profile_one");
    const [profile] = await database
      .select({ since: schema.profiles.githubInaccessibleSince })
      .from(schema.profiles)
      .where(eq(schema.profiles.profileId, "profile_one"));
    expect(profile?.since).toBeNull();
  });

  it("persists Deepline fallback separately and rechecks direct-source precedence", async () => {
    await database.insert(schema.memberStatements).values({
      id: "member-headline",
      profileId: "profile_one",
      field: "headline",
      value: "Member supplied headline",
      source: "member",
      pipelineVersion: "member-v1",
      confidence: 1,
    });
    const tikHub = createTikHubEnrichmentStore(database);
    await tikHub.getOrCreateRun("profile_one", "direct-tikhub", startedAt);
    await tikHub.persistObservations("direct-tikhub", [
      tikHubObservation("linkedin-career", "linkedin:direct", {
        headline: null,
        currentCompany: null,
        experience: [],
        education: [{ organization: "University of London" }],
        skills: ["TypeScript"],
      }),
    ]);

    const deepline = createDeeplineEnrichmentStore(database);
    await expect(
      deepline.listProtectedFields("profile_one", [
        "githubUrl",
        "headline",
        "education",
        "skills",
        "experience",
      ]),
    ).resolves.toEqual([
      { field: "githubUrl", source: "github" },
      { field: "headline", source: "member" },
      { field: "education", source: "tikhub" },
      { field: "skills", source: "tikhub" },
    ]);

    await deepline.getOrCreateRun("profile_one", "deepline-run", startedAt);
    await deepline.persistObservations("deepline-run", [
      deeplineObservation(
        "githubUrl",
        "deepline:github",
        "https://github.com/ada",
      ),
      deeplineObservation("headline", "deepline:headline", "Provider headline"),
      deeplineObservation("education", "deepline:education", [
        "Provider school",
      ]),
      deeplineObservation("skills", "deepline:skills", ["Rust"]),
      deeplineObservation("experience", "deepline:experience", [
        { companyName: "Analytical Engines" },
      ]),
      deeplineObservation("xUrl", "deepline:x", "https://x.com/ada"),
    ]);
    const fallback = await database
      .select()
      .from(schema.profileObservations)
      .where(eq(schema.profileObservations.source, "deepline"));
    expect(fallback.map(({ field }) => field).sort()).toEqual([
      "experience",
      "xUrl",
    ]);
    expect(fallback).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "deepline",
          pipelineVersion: "deepline-fallback-v1",
          staleAt: null,
        }),
      ]),
    );

    await deepline.markDeeplineObservationsStale(
      "profile_one",
      ["experience"],
      "2026-09-02T00:00:00.000Z",
    );
    const staleFallback = await database
      .select({
        field: schema.profileObservations.field,
        staleAt: schema.profileObservations.staleAt,
      })
      .from(schema.profileObservations)
      .where(eq(schema.profileObservations.source, "deepline"))
      .orderBy(schema.profileObservations.field);
    expect(staleFallback).toEqual([
      {
        field: "experience",
        staleAt: new Date("2026-09-02T00:00:00.000Z"),
      },
      { field: "xUrl", staleAt: null },
    ]);

    await deepline.getOrCreateRun(
      "profile_two",
      "deepline-collision",
      startedAt,
    );
    await expect(
      deepline.persistObservations("deepline-collision", [
        deeplineObservation(
          "xUrl",
          "deepline:x",
          "https://x.com/grace",
          "profile_two",
        ),
      ]),
    ).rejects.toMatchObject({ code: "observation_identity_collision" });
  });

  it("does not fall back over reviewed corrections, including cleared fields", async () => {
    await database.insert(schema.profileObservations).values([
      {
        profileId: "profile_one",
        field: "headline",
        value: sql`'null'::jsonb`,
        source: "public-profile-request",
        sourceRecordId: "reviewed-correction",
        pipelineVersion: "public-request-v1",
        confidence: 1,
      },
      {
        profileId: "profile_one",
        field: "current_company",
        value: sql`'null'::jsonb`,
        source: "public-profile-request",
        sourceRecordId: "reviewed-correction",
        pipelineVersion: "public-request-v1",
        confidence: 1,
      },
      {
        profileId: "profile_one",
        field: "skills",
        value: [],
        source: "public-profile-request",
        sourceRecordId: "reviewed-correction",
        pipelineVersion: "public-request-v1",
        confidence: 1,
      },
    ]);
    await database.insert(schema.professionalLinks).values({
      profileId: "profile_one",
      url: "https://www.linkedin.com/in/ada",
      source: "public-profile-request",
      sourceRecordId: "reviewed-correction",
    });

    const deepline = createDeeplineEnrichmentStore(database);
    await expect(
      deepline.listProtectedFields("profile_one", [
        "linkedinUrl",
        "headline",
        "currentPosition",
        "skills",
      ]),
    ).resolves.toEqual([
      { field: "linkedinUrl", source: "reviewed" },
      { field: "headline", source: "reviewed" },
      { field: "currentPosition", source: "reviewed" },
      { field: "skills", source: "reviewed" },
    ]);

    await deepline.getOrCreateRun(
      "profile_one",
      "reviewed-correction-fallback",
      startedAt,
    );
    await deepline.persistObservations("reviewed-correction-fallback", [
      deeplineObservation(
        "linkedinUrl",
        "deepline:reviewed-link",
        "https://www.linkedin.com/in/provider-ada",
      ),
      deeplineObservation(
        "headline",
        "deepline:reviewed-headline",
        "Provider headline",
      ),
      deeplineObservation("currentPosition", "deepline:reviewed-position", [
        { companyName: "Provider Company", position: "Provider Role" },
      ]),
      deeplineObservation("skills", "deepline:reviewed-skills", ["Rust"]),
    ]);

    await expect(
      database
        .select()
        .from(schema.profileObservations)
        .where(eq(schema.profileObservations.source, "deepline")),
    ).resolves.toEqual([]);
  });

  it("does not fall back over populated GitHub normalization", async () => {
    await database.insert(schema.profileObservations).values([
      {
        profileId: "profile_one",
        field: "github-account",
        value: { company: "GitHub Company" },
        source: "github",
        sourceRecordId: "github:direct-account",
        pipelineVersion: "github-v1",
        confidence: 1,
      },
      {
        profileId: "profile_one",
        field: "github-normalization",
        value: {
          roles: ["Maintainer"],
          skills: ["TypeScript"],
          summary: "Direct GitHub summary",
        },
        source: "github-ai-normalization",
        sourceRecordId: "github:direct-normalization",
        pipelineVersion: "github-v1",
        confidence: 1,
      },
    ]);
    const deepline = createDeeplineEnrichmentStore(database);

    await expect(
      deepline.listProtectedFields("profile_one", [
        "headline",
        "currentPosition",
        "skills",
      ]),
    ).resolves.toEqual([
      { field: "headline", source: "github" },
      { field: "currentPosition", source: "github" },
      { field: "skills", source: "github" },
    ]);
  });

  it("uses inclusive 30-day and 90-day refresh boundaries", () => {
    const lastSuccess = new Date("2026-01-01T00:00:00.000Z");
    expect(enrichmentRefreshDueAt("github", lastSuccess)).toEqual(
      new Date("2026-01-31T00:00:00.000Z"),
    );
    expect(enrichmentRefreshDueAt("tikhub", lastSuccess)).toEqual(
      new Date("2026-04-01T00:00:00.000Z"),
    );
    expect(enrichmentRefreshDueAt("deepline", lastSuccess)).toEqual(
      new Date("2026-04-01T00:00:00.000Z"),
    );
    expect(
      isEnrichmentRefreshDue(
        "github",
        lastSuccess,
        new Date("2026-01-30T23:59:59.999Z"),
      ),
    ).toBe(false);
    expect(
      isEnrichmentRefreshDue(
        "github",
        lastSuccess,
        new Date("2026-01-31T00:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isEnrichmentRefreshDue(
        "tikhub",
        lastSuccess,
        new Date("2026-03-31T23:59:59.999Z"),
      ),
    ).toBe(false);
    expect(
      isEnrichmentRefreshDue(
        "deepline",
        lastSuccess,
        new Date("2026-04-01T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("creates Deepline fallback only after direct stages expose unresolved fields", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    await database.insert(schema.professionalLinks).values({
      profileId: "profile_one",
      url: "https://www.linkedin.com/in/ada",
    });

    const direct = await createDueEnrichmentDispatches(database, { now });
    const profileDirect = direct.filter(
      ({ profileId }) => profileId === "profile_one",
    );
    expect(profileDirect.map(({ provider }) => provider).sort()).toEqual([
      "github",
      "tikhub",
    ]);
    for (const dispatch of profileDirect) {
      await database.insert(schema.enrichmentRuns).values({
        id: dispatch.runId,
        profileId: dispatch.profileId,
        provider: dispatch.provider,
        status: "succeeded",
        pipelineVersion:
          dispatch.provider === "github" ? "github-v1" : "tikhub-linkedin-v1",
        startedAt: now,
        finishedAt: now,
      });
    }

    const fallback = await createDueEnrichmentDispatches(database, {
      now: new Date("2026-09-01T00:00:00.001Z"),
    });
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({
      provider: "deepline",
      payload: {
        runId: fallback[0]?.runId,
        missingFields: [
          "xUrl",
          "headline",
          "currentPosition",
          "experience",
          "education",
          "skills",
        ],
        linkedInUrl: "https://www.linkedin.com/in/ada",
      },
    });
  });

  it("defers Member-edit Deepline fallback until direct stages have been inspected", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    const linkedInUrl = "https://www.linkedin.com/in/ada";
    await database
      .update(schema.profiles)
      .set({ memberId: "member_one" })
      .where(eq(schema.profiles.profileId, "profile_one"));
    await database.insert(schema.professionalLinks).values({
      profileId: "profile_one",
      url: linkedInUrl,
      source: "member",
      sourceRecordId: "member_one",
    });
    let nextId = 0;
    const edit = (beforeName: string, afterName: string) =>
      database.transaction((tx) =>
        enqueueAffectedMemberEditDispatches(tx, {
          memberId: "member_one",
          profileId: "profile_one",
          before: {
            name: beforeName,
            currentCompany: null,
            githubLogin: "ada",
            professionalLinks: [linkedInUrl],
          },
          after: {
            name: afterName,
            currentCompany: null,
            githubLogin: "ada",
            professionalLinks: [linkedInUrl],
          },
          now,
          createId: () => `member-edit-direct-${++nextId}`,
        }),
      );

    const created = await edit("Profile One", "Profile One Renamed");
    expect(created.map(({ provider }) => provider)).toEqual([
      "github",
      "tikhub",
      "deepline",
    ]);
    const direct = created.filter(
      (dispatch) => dispatch.provider !== "deepline",
    );
    const fallback = created.find(
      (dispatch) => dispatch.provider === "deepline",
    );
    expect(fallback).toMatchObject({
      provider: "deepline",
      payload: expect.objectContaining({
        linkedInUrl,
        missingFields: ["xUrl"],
        prerequisiteRunIds: direct.map(({ runId }) => runId),
      }),
    });

    const directLeases = await claimEnrichmentDispatches(database, {
      leaseOwner: "member-edit-direct-dispatcher",
      now,
    });
    expect(directLeases.map(({ provider }) => provider).sort()).toEqual([
      "github",
      "tikhub",
    ]);
    expect(directLeases).not.toContainEqual(
      expect.objectContaining({ provider: "deepline" }),
    );
    await database.insert(schema.enrichmentRuns).values(
      directLeases.map((dispatch) => ({
        id: dispatch.runId,
        profileId: dispatch.profileId,
        provider: dispatch.provider,
        status: dispatch.provider === "github" ? "succeeded" : "failed",
        pipelineVersion:
          dispatch.provider === "github" ? "github-v1" : "tikhub-linkedin-v1",
        startedAt: now,
        finishedAt: now,
      })),
    );
    for (const dispatch of directLeases)
      await markEnrichmentDispatchDelivered(database, {
        dispatchId: dispatch.id,
        leaseOwner: "member-edit-direct-dispatcher",
        triggerRunId: `trigger-${dispatch.runId}`,
        deliveredAt: now,
      });

    await expect(
      claimEnrichmentDispatches(database, {
        leaseOwner: "member-edit-fallback-dispatcher",
        now,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: "deepline",
        runId: fallback?.runId,
      }),
    ]);
  });

  it("waits for a newer direct dispatch even when an older run is terminal", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    const linkedInUrl = "https://www.linkedin.com/in/ada";
    await database
      .update(schema.profiles)
      .set({ memberId: "member_one" })
      .where(eq(schema.profiles.profileId, "profile_one"));
    await database.insert(schema.professionalLinks).values({
      profileId: "profile_one",
      url: linkedInUrl,
      source: "member",
      sourceRecordId: "member_one",
    });
    await database.insert(schema.enrichmentRuns).values([
      {
        id: "older-terminal-github",
        profileId: "profile_one",
        provider: "github",
        status: "succeeded",
        pipelineVersion: "github-v1",
        startedAt: new Date("2026-08-01T00:00:00.000Z"),
        finishedAt: new Date("2026-08-01T00:01:00.000Z"),
      },
      {
        id: "older-terminal-tikhub",
        profileId: "profile_one",
        provider: "tikhub",
        status: "succeeded",
        pipelineVersion: "tikhub-linkedin-v1",
        startedAt: new Date("2026-08-01T00:00:00.000Z"),
        finishedAt: new Date("2026-08-01T00:01:00.000Z"),
      },
    ]);
    await enqueueEnrichmentDispatch(database, {
      provider: "github",
      payload: {
        profileId: "profile_one",
        githubLogin: "ada",
        runId: "newer-pending-github",
      },
      dedupeKey: "newer-pending-github",
      now,
    });

    const created = await database.transaction((tx) =>
      enqueueAffectedMemberEditDispatches(tx, {
        memberId: "member_one",
        profileId: "profile_one",
        before: {
          name: "Profile One",
          currentCompany: null,
          githubLogin: "ada",
          professionalLinks: [linkedInUrl],
        },
        after: {
          name: "Renamed Profile One",
          currentCompany: null,
          githubLogin: "ada",
          professionalLinks: [linkedInUrl],
        },
        now,
        createId: () => crypto.randomUUID(),
      }),
    );
    expect(created).toEqual([
      expect.objectContaining({
        provider: "deepline",
        payload: expect.objectContaining({
          prerequisiteRunIds: ["newer-pending-github"],
        }),
      }),
    ]);

    await expect(
      claimEnrichmentDispatches(database, {
        leaseOwner: "newer-direct-dispatcher",
        now,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: "github",
        runId: "newer-pending-github",
      }),
    ]);
  });

  it("does not schedule fallback while a newer direct dispatch has not started", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    await database.insert(schema.enrichmentRuns).values({
      id: "recent-scheduled-github-success",
      profileId: "profile_one",
      provider: "github",
      status: "succeeded",
      pipelineVersion: "github-v1",
      startedAt: new Date("2026-08-31T23:55:00.000Z"),
      finishedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    await enqueueEnrichmentDispatch(database, {
      provider: "github",
      payload: {
        profileId: "profile_one",
        githubLogin: "ada",
        runId: "pending-member-edit-github",
      },
      dedupeKey: "pending-member-edit-github",
      now,
    });

    const created = await createDueEnrichmentDispatches(database, { now });

    expect(
      created.filter(({ profileId }) => profileId === "profile_one"),
    ).toEqual([]);
    await expect(
      database
        .select({ provider: schema.enrichmentDispatches.provider })
        .from(schema.enrichmentDispatches)
        .where(eq(schema.enrichmentDispatches.profileId, "profile_one")),
    ).resolves.toEqual([{ provider: "github" }]);
  });

  it("deduplicates due production while giving each logical refresh a fresh run ID", async () => {
    const dueAt = new Date("2026-09-01T00:00:00.000Z");
    await database.insert(schema.enrichmentRuns).values({
      id: "previous-github-success",
      profileId: "profile_one",
      provider: "github",
      status: "succeeded",
      pipelineVersion: "github-v1",
      startedAt: new Date("2026-08-01T23:55:00.000Z"),
      finishedAt: new Date("2026-08-02T00:00:00.000Z"),
    });

    const first = await createDueEnrichmentDispatches(database, { now: dueAt });
    const firstGitHub = first.find(({ provider }) => provider === "github");
    expect(firstGitHub).toBeDefined();
    if (firstGitHub === undefined) throw new Error("Expected GitHub dispatch");
    await expect(
      createDueEnrichmentDispatches(database, { now: dueAt }),
    ).resolves.toEqual([]);
    const [persisted] = await database
      .select()
      .from(schema.enrichmentDispatches)
      .where(eq(schema.enrichmentDispatches.provider, "github"));
    expect(persisted?.runId).toBe(firstGitHub?.runId);

    await database.insert(schema.enrichmentRuns).values({
      id: firstGitHub.runId,
      profileId: "profile_one",
      provider: "github",
      status: "failed",
      pipelineVersion: "github-v1",
      startedAt: dueAt,
      finishedAt: new Date("2026-09-01T06:00:00.000Z"),
    });
    const beforeRetry = await createDueEnrichmentDispatches(database, {
      now: new Date("2026-09-02T05:59:59.999Z"),
    });
    expect(beforeRetry.find(({ provider }) => provider === "github")).toBe(
      undefined,
    );
    const retry = await createDueEnrichmentDispatches(database, {
      now: new Date("2026-09-02T06:00:00.000Z"),
    });
    const retryGitHub = retry.find(({ provider }) => provider === "github");
    expect(retryGitHub?.runId).not.toBe(firstGitHub?.runId);
    expect(retryGitHub?.dedupeKey).toContain(`retry:${firstGitHub?.runId}`);
  });

  it("leases bounded dispatches, reuses logical runs on retry, and recovers at lease expiry", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    await enqueueEnrichmentDispatch(database, {
      provider: "github",
      dedupeKey: "github:profile_one:lease-test",
      now,
      payload: {
        profileId: "profile_one",
        githubLogin: "ada",
        runId: "lease-logical-run",
      },
    });

    const firstLease = await claimEnrichmentDispatches(database, {
      leaseOwner: "dispatcher-one",
      now,
      limit: 1,
      leaseMilliseconds: 1_000,
    });
    expect(firstLease).toHaveLength(1);
    expect(firstLease[0]).toMatchObject({
      runId: "lease-logical-run",
      attempts: 1,
      state: "leased",
    });
    await expect(
      claimEnrichmentDispatches(database, {
        leaseOwner: "dispatcher-two",
        now,
      }),
    ).resolves.toEqual([]);
    const sameAttempt = await claimEnrichmentDispatches(database, {
      leaseOwner: "dispatcher-one",
      now,
      limit: 1,
      leaseMilliseconds: 1_000,
    });
    expect(sameAttempt[0]).toMatchObject({
      runId: "lease-logical-run",
      dedupeKey: "github:profile_one:lease-test",
      attempts: 2,
    });
    await expect(
      recoverEnrichmentDispatches(
        database,
        new Date("2026-09-01T00:00:00.999Z"),
      ),
    ).resolves.toMatchObject({ recovered: 0 });
    await expect(
      recoverEnrichmentDispatches(
        database,
        new Date("2026-09-01T00:00:01.000Z"),
      ),
    ).resolves.toMatchObject({ recovered: 1 });

    const recovered = await claimEnrichmentDispatches(database, {
      leaseOwner: "dispatcher-two",
      now: new Date("2026-09-01T00:00:01.000Z"),
      limit: 1,
    });
    expect(recovered[0]?.runId).toBe("lease-logical-run");
    const recoveredDispatch = recovered[0];
    if (recoveredDispatch === undefined)
      throw new Error("Expected recovered dispatch");
    await markEnrichmentDispatchDelivered(database, {
      dispatchId: recoveredDispatch.id,
      leaseOwner: "dispatcher-two",
      triggerRunId: "trigger-run-one",
      deliveredAt: new Date("2026-09-01T00:00:02.000Z"),
    });
    await expect(
      claimEnrichmentDispatches(database, {
        leaseOwner: "dispatcher-three",
        now: new Date("2026-09-01T00:00:03.000Z"),
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    {
      outcome: "accepted then canceled before starting",
      triggerRun: {
        status: "CANCELED",
        isCompleted: false,
        isCancelled: true,
      },
      persistedStatus: undefined,
    },
    {
      outcome:
        "interrupted after persisting a pending run (reported as FAILED)",
      triggerRun: {
        status: "FAILED",
        isCompleted: true,
        isCancelled: false,
      },
      persistedStatus: "pending",
    },
    {
      outcome: "accepted but expired before starting",
      triggerRun: {
        status: "EXPIRED",
        isCompleted: true,
        isCancelled: false,
      },
      persistedStatus: undefined,
    },
  ])("reconciles a delivered dispatch $outcome", async (scenario) => {
    const deliveredAt = new Date("2026-09-01T00:00:00.000Z");
    const direct = await enqueueEnrichmentDispatch(database, {
      provider: "github",
      dedupeKey: `github:profile_one:${scenario.triggerRun.status}`,
      now: deliveredAt,
      payload: {
        profileId: "profile_one",
        githubLogin: "ada",
        runId: `direct-${scenario.triggerRun.status.toLowerCase()}`,
      },
    });
    const fallback = await enqueueEnrichmentDispatch(database, {
      provider: "deepline",
      dedupeKey: `deepline:profile_one:${scenario.triggerRun.status}`,
      now: deliveredAt,
      payload: {
        profileId: "profile_one",
        runId: `fallback-${scenario.triggerRun.status.toLowerCase()}`,
        missingFields: ["headline"],
        prerequisiteRunIds: [
          `direct-${scenario.triggerRun.status.toLowerCase()}`,
        ],
        identity: { fullName: "Profile One" },
      },
    });
    expect(direct).toBeDefined();
    expect(fallback).toBeDefined();

    const [lease] = await claimEnrichmentDispatches(database, {
      leaseOwner: "terminal-reconciliation-dispatcher",
      now: deliveredAt,
      limit: 1,
    });
    expect(lease?.id).toBe(direct?.id);
    if (lease === undefined) throw new Error("Expected direct dispatch lease");
    await markEnrichmentDispatchDelivered(database, {
      dispatchId: lease.id,
      leaseOwner: "terminal-reconciliation-dispatcher",
      triggerRunId: `trigger-${scenario.triggerRun.status.toLowerCase()}`,
      deliveredAt,
    });
    if (scenario.persistedStatus !== undefined)
      await database.insert(schema.enrichmentRuns).values({
        id: lease.runId,
        profileId: lease.profileId,
        provider: lease.provider,
        status: scenario.persistedStatus,
        pipelineVersion: "github-v1",
        startedAt: deliveredAt,
      });

    const readTriggerRun = vi.fn(async () => scenario.triggerRun);
    await expect(
      recoverEnrichmentDispatches(
        database,
        new Date("2026-09-01T00:59:59.999Z"),
        readTriggerRun,
      ),
    ).resolves.toMatchObject({ inspected: 0, reconciled: 0 });
    expect(readTriggerRun).not.toHaveBeenCalled();

    await expect(
      recoverEnrichmentDispatches(
        database,
        new Date("2026-09-01T01:00:00.000Z"),
        readTriggerRun,
      ),
    ).resolves.toEqual({
      recovered: 0,
      cancelled: 0,
      inspected: 1,
      inspectionFailures: 0,
      reconciled: 1,
    });
    expect(readTriggerRun).toHaveBeenCalledWith(
      `trigger-${scenario.triggerRun.status.toLowerCase()}`,
    );
    await expect(
      database
        .select({
          status: schema.enrichmentRuns.status,
          stage: schema.enrichmentRuns.stage,
          error: schema.enrichmentRuns.error,
          finishedAt: schema.enrichmentRuns.finishedAt,
        })
        .from(schema.enrichmentRuns)
        .where(eq(schema.enrichmentRuns.id, lease.runId)),
    ).resolves.toEqual([
      {
        status: "failed",
        stage: null,
        error: `Trigger run ended with ${scenario.triggerRun.status} before enrichment completed`,
        finishedAt: new Date("2026-09-01T01:00:00.000Z"),
      },
    ]);
    await expect(
      claimEnrichmentDispatches(database, {
        leaseOwner: "fallback-after-terminal-trigger-run",
        now: new Date("2026-09-01T01:00:00.000Z"),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: fallback?.id,
        provider: "deepline",
      }),
    ]);
    let nextRetryId = 0;
    const retries = await createDueEnrichmentDispatches(database, {
      now: new Date("2026-09-02T01:00:00.000Z"),
      createId: () =>
        `retry-${scenario.triggerRun.status.toLowerCase()}-${++nextRetryId}`,
    });
    expect(retries).toContainEqual(
      expect.objectContaining({
        provider: "github",
        profileId: "profile_one",
        runId: `retry-${scenario.triggerRun.status.toLowerCase()}-1`,
        dedupeKey: expect.stringContaining(`retry:${lease.runId}`),
      }),
    );
  });

  it.each([
    {
      status: "QUEUED",
      isCompleted: false,
      isCancelled: false,
    },
    {
      status: "EXECUTING",
      isCompleted: false,
      isCancelled: false,
    },
  ])(
    "does not reconcile an actively progressing $status Trigger run",
    async (triggerRun) => {
      const deliveredAt = new Date("2026-09-01T00:00:00.000Z");
      const dispatch = await enqueueEnrichmentDispatch(database, {
        provider: "github",
        dedupeKey: `github:profile_one:active-${triggerRun.status}`,
        now: deliveredAt,
        payload: {
          profileId: "profile_one",
          githubLogin: "ada",
          runId: `active-${triggerRun.status.toLowerCase()}`,
        },
      });
      const [lease] = await claimEnrichmentDispatches(database, {
        leaseOwner: "active-run-dispatcher",
        now: deliveredAt,
      });
      expect(lease?.id).toBe(dispatch?.id);
      if (lease === undefined)
        throw new Error("Expected active dispatch lease");
      await markEnrichmentDispatchDelivered(database, {
        dispatchId: lease.id,
        leaseOwner: "active-run-dispatcher",
        triggerRunId: `trigger-${triggerRun.status.toLowerCase()}`,
        deliveredAt,
      });
      if (triggerRun.status === "EXECUTING")
        await database.insert(schema.enrichmentRuns).values({
          id: lease.runId,
          profileId: lease.profileId,
          provider: lease.provider,
          status: "running",
          pipelineVersion: "github-v1",
          startedAt: deliveredAt,
        });

      await expect(
        recoverEnrichmentDispatches(
          database,
          new Date("2026-09-02T00:00:00.000Z"),
          async () => triggerRun,
        ),
      ).resolves.toMatchObject({ inspected: 1, reconciled: 0 });
      await expect(
        database
          .select({ status: schema.enrichmentRuns.status })
          .from(schema.enrichmentRuns)
          .where(eq(schema.enrichmentRuns.id, lease.runId)),
      ).resolves.toEqual(
        triggerRun.status === "EXECUTING" ? [{ status: "running" }] : [],
      );
    },
  );

  it("suppresses unresolved inaccessible GitHub Profiles at the exact grace boundary", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    await database
      .update(schema.profiles)
      .set({
        githubInaccessibleSince: new Date("2026-08-02T00:00:00.000Z"),
      })
      .where(eq(schema.profiles.profileId, "profile_one"));
    await database
      .update(schema.profiles)
      .set({
        githubInaccessibleSince: new Date("2026-08-02T00:00:00.001Z"),
      })
      .where(eq(schema.profiles.profileId, "profile_two"));
    for (const profile of ["one", "two"] as const) {
      await enqueueEnrichmentDispatch(database, {
        provider: "github",
        dedupeKey: `github:profile_${profile}:suppression-test`,
        now,
        payload: {
          profileId: `profile_${profile}`,
          githubLogin: profile === "one" ? "ada" : "grace",
          runId: `suppression-${profile}`,
        },
      });
    }

    await expect(
      suppressGitHubInaccessibleProfiles(database, now),
    ).resolves.toBe(1);
    const profileRows = await database
      .select({
        profileId: schema.profiles.profileId,
        searchable: schema.profiles.searchable,
      })
      .from(schema.profiles)
      .orderBy(schema.profiles.profileId);
    expect(profileRows).toEqual([
      { profileId: "profile_one", searchable: false },
      { profileId: "profile_two", searchable: true },
    ]);
    const dispatchRows = await database
      .select({
        profileId: schema.enrichmentDispatches.profileId,
        state: schema.enrichmentDispatches.state,
      })
      .from(schema.enrichmentDispatches)
      .orderBy(schema.enrichmentDispatches.profileId);
    expect(dispatchRows).toEqual([
      { profileId: "profile_one", state: "cancelled" },
      { profileId: "profile_two", state: "pending" },
    ]);
    await expect(
      suppressGitHubInaccessibleProfiles(
        database,
        new Date("2026-09-01T00:00:00.001Z"),
      ),
    ).resolves.toBe(1);
  });

  it("retains affected-stage dispatches while a Member-controlled Profile is not searchable", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    await database
      .update(schema.profiles)
      .set({
        memberId: "member_one",
        searchable: false,
        searchabilityReason: "member_opt_out",
      })
      .where(eq(schema.profiles.profileId, "profile_one"));
    await expect(
      enqueueEnrichmentDispatch(database, {
        provider: "github",
        dedupeKey: "member-edit:profile_one:searchability-test:github",
        now,
        payload: {
          profileId: "profile_one",
          githubLogin: "ada",
          runId: "searchability-run",
        },
      }),
    ).resolves.toMatchObject({
      provider: "github",
      runId: "searchability-run",
      state: "pending",
    });

    await expect(recoverEnrichmentDispatches(database, now)).resolves.toEqual({
      recovered: 0,
      cancelled: 0,
      inspected: 0,
      inspectionFailures: 0,
      reconciled: 0,
    });
    await expect(
      claimEnrichmentDispatches(database, {
        leaseOwner: "dispatcher-after-opt-out",
        now,
      }),
    ).resolves.toEqual([]);

    await database
      .update(schema.profiles)
      .set({ searchable: true, searchabilityReason: "member_opt_in" })
      .where(eq(schema.profiles.profileId, "profile_one"));
    await expect(
      claimEnrichmentDispatches(database, {
        leaseOwner: "dispatcher-after-opt-in",
        now: new Date("2026-09-01T00:00:00.001Z"),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        runId: "searchability-run",
        state: "leased",
      }),
    ]);
  });
});
