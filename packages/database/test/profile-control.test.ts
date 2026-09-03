import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Effect } from "effect";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importProfiles } from "../src/import-profiles";
import { getOperatorOverview, reviewClaimAsOperator } from "../src/operations";
import { recordVerifiedContactDetail } from "../src/contact-reveals";
import {
  editControlledProfile,
  findClaimCandidates,
  requestProfileClaim,
  resolveProfileField,
  reviewProfileClaim,
  reviewProfileRequest,
  setMemberStatement,
  setProfileSearchability,
  suppressKnownMinorProfile,
  submitPublicProfileRequest,
  verifyProfileRequest,
} from "../src/profile-control";
import * as schema from "../src/schema";
import { getSearchableProfile } from "../src/search-profiles";
import { makeDatabaseService } from "../src/service";

describe("Profile control", () => {
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
  afterAll(async () => {
    await resources.pool?.end();
    await resources.container?.stop();
  });

  const createMember = async (id: string) => {
    await database.insert(schema.members).values({ clerkId: id });
  };
  const createImportedProfile = async (
    accountId: string,
    login = `person-${accountId}`,
  ) => {
    const [profile] = await database
      .insert(schema.profiles)
      .values({
        name: `Person ${accountId}`,
        githubAccountId: accountId,
        githubLogin: login,
        eligibilityBasis: "owned_repository",
        adultAttested: true,
        searchable: true,
        searchabilityReason: "approved_import",
      })
      .returning();
    if (!profile) throw new Error("Imported Profile fixture was not created");
    return profile;
  };

  const eligibleGitHub = (accountId: string, login = `login-${accountId}`) => ({
    accountId,
    login,
    accountType: "User" as const,
    ownsNonForkRepository: true,
    contributedPubliclySince: null,
    ownershipVerified: true,
    knownMinor: false,
  });
  const requestVerification = (id: string) => ({
    operatorId: "operator-verifier",
    correlationId: `verify-${id}`,
    reason: "Verified control of the reported identity",
    verificationMethod: "email_challenge",
    evidenceReference: `evidence://profile-request/${id}`,
  });
  const requestDecision = (id: string) => ({
    operatorId: "operator-reviewer",
    correlationId: `review-${id}`,
    reason: "Reviewed the supplied evidence",
  });

  it("suggests a match but only an immutable OAuth account ID verifies control", async () => {
    await createMember("member-auto");
    const profile = await createImportedProfile("501", "renamed-login");
    const service = makeDatabaseService(database);
    expect(
      await Effect.runPromise(
        service.findClaimCandidates({ githubAccountId: "501" }),
      ),
    ).toEqual([expect.objectContaining({ profileId: profile.profileId })]);
    expect(
      (
        await database
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.profileId, profile.profileId))
      )[0]?.memberId,
    ).toBeNull();

    const claim = await Effect.runPromise(
      service.requestProfileClaim({
        profileId: profile.profileId,
        memberId: "member-auto",
        oauthGithubAccountId: "501",
        oauthGithubLogin: "current-login",
      }),
    );
    expect(claim.status).toBe("verified");
    expect(
      (
        await database
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.profileId, profile.profileId))
      )[0],
    ).toMatchObject({
      memberId: "member-auto",
      githubLogin: "current-login",
    });
  });

  it("does not suggest or transfer Profiles that are already controlled", async () => {
    await createMember("member-owner");
    await createMember("member-thief");
    const profile = await createImportedProfile("507");
    await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-owner",
      oauthGithubAccountId: "507",
      oauthGithubLogin: "owner",
    });

    await expect(
      findClaimCandidates(database, { githubAccountId: "507" }),
    ).resolves.toEqual([]);
    await expect(
      requestProfileClaim(database, {
        profileId: profile.profileId,
        memberId: "member-thief",
        oauthGithubAccountId: "507",
        oauthGithubLogin: "thief",
      }),
    ).rejects.toThrow("profile_already_claimed");
  });

  it("queues unverifiable claims for review and prevents claim collisions", async () => {
    await createMember("member-review");
    await createMember("member-collision");
    const profile = await createImportedProfile("502");
    const claim = await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-review",
      oauthGithubAccountId: "999",
      oauthGithubLogin: "reviewer",
    });
    expect(claim.status).toBe("pending_review");
    const rightfulClaim = await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-collision",
      oauthGithubAccountId: "502",
      oauthGithubLogin: "rightful-owner",
    });
    expect(rightfulClaim.status).toBe("verified");
    await expect(reviewProfileClaim(database, claim.id, true)).rejects.toThrow(
      "claim_not_pending",
    );
    await expect(
      database
        .select({
          id: schema.profileClaims.id,
          status: schema.profileClaims.status,
        })
        .from(schema.profileClaims)
        .where(eq(schema.profileClaims.profileId, profile.profileId)),
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: claim.id, status: "superseded" },
        { id: rightfulClaim.id, status: "verified" },
      ]),
    );
  });

  it("requires durable Operator evidence before approving a reviewed claim", async () => {
    await createMember("member-evidence-review");
    const profile = await createImportedProfile("516");
    const claim = await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-evidence-review",
      oauthGithubAccountId: "9516",
      oauthGithubLogin: "alternate-proof",
    });

    await expect(
      reviewProfileClaim(database, claim.id, true, {
        operatorId: "operator-evidence",
        correlationId: "missing-evidence",
        reason: "No durable evidence supplied",
      }),
    ).rejects.toThrow("claim_evidence_required");
    const reviewed = await reviewProfileClaim(database, claim.id, true, {
      operatorId: "operator-evidence",
      correlationId: "verified-evidence",
      reason: "Manual identity challenge completed",
      evidenceReference: "evidence://claim/516",
    });

    expect(reviewed).toMatchObject({
      status: "verified",
      evidenceReference: "evidence://claim/516",
    });
    await expect(
      database
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, profile.profileId)),
    ).resolves.toEqual([
      expect.objectContaining({
        memberId: "member-evidence-review",
        githubAccountId: "516",
        githubLogin: "person-516",
        searchable: false,
      }),
    ]);
    await expect(
      database
        .select({ metadata: schema.operatorAuditEvents.metadata })
        .from(schema.operatorAuditEvents)
        .where(eq(schema.operatorAuditEvents.subjectId, claim.id)),
    ).resolves.toEqual([
      {
        metadata: expect.objectContaining({
          evidenceReference: "evidence://claim/516",
          targetGithubAccountId: "516",
          claimantGithubAccountId: "9516",
        }),
      },
    ]);
  });

  it("does not discover or approve claims while Profile data is disputed", async () => {
    await createMember("member-disputed-review");
    await createMember("member-disputed-auto");
    const reviewProfile = await createImportedProfile("511");
    const disputedProfile = await createImportedProfile("512");
    const claim = await requestProfileClaim(database, {
      profileId: reviewProfile.profileId,
      memberId: "member-disputed-review",
      oauthGithubAccountId: "9511",
      oauthGithubLogin: "reviewer",
    });

    await expect(
      findClaimCandidates(database, { githubAccountId: "511" }),
    ).resolves.toEqual([
      expect.objectContaining({ profileId: reviewProfile.profileId }),
    ]);
    const reviewRequest = await submitPublicProfileRequest(database, {
      profileId: reviewProfile.profileId,
      kind: "correction",
      requesterEmail: "person@example.com",
      details: "This Profile is disputed",
    });
    await verifyProfileRequest(
      database,
      reviewRequest.id,
      requestVerification(reviewRequest.id),
    );
    await expect(
      reviewProfileClaim(database, claim.id, true),
    ).rejects.toThrow();

    const disputedRequest = await submitPublicProfileRequest(database, {
      profileId: disputedProfile.profileId,
      kind: "removal",
      requesterEmail: "person@example.com",
      details: "Please review this removal",
    });
    await verifyProfileRequest(
      database,
      disputedRequest.id,
      requestVerification(disputedRequest.id),
    );
    await expect(
      findClaimCandidates(database, { githubAccountId: "512" }),
    ).resolves.toEqual([]);
    await expect(
      requestProfileClaim(database, {
        profileId: disputedProfile.profileId,
        memberId: "member-disputed-auto",
        oauthGithubAccountId: "512",
        oauthGithubLogin: "disputed-owner",
      }),
    ).rejects.toThrow("profile_suppressed");
  });

  it("gives current Member Statements precedence and restores Observations when removed", async () => {
    await createMember("member-statement");
    const profile = await createImportedProfile("503");
    await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-statement",
      oauthGithubAccountId: "503",
      oauthGithubLogin: "statement-owner",
    });
    await database.insert(schema.profileObservations).values({
      profileId: profile.profileId,
      field: "bio",
      value: "external",
      source: "fixture",
      sourceRecordId: "503",
      pipelineVersion: "v1",
      confidence: 1,
    });
    await setMemberStatement(database, {
      memberId: "member-statement",
      field: "bio",
      value: "mine",
    });
    expect(
      await resolveProfileField(database, profile.profileId, "bio"),
    ).toEqual({ value: "mine", source: "member" });
    await setMemberStatement(database, {
      memberId: "member-statement",
      field: "bio",
      value: null,
    });
    expect(
      await resolveProfileField(database, profile.profileId, "bio"),
    ).toMatchObject({ value: "external", source: "observation" });
  });

  it("keeps direct provider Observations ahead of newer Deepline fallback", async () => {
    const profile = await createImportedProfile("522", "source-precedence");
    await database.insert(schema.profileObservations).values([
      {
        profileId: profile.profileId,
        field: "headline",
        value: "Direct headline",
        source: "tikhub",
        sourceRecordId: "linkedin:source-precedence",
        pipelineVersion: "tikhub-linkedin-v1",
        confidence: 1,
        collectedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
      {
        profileId: profile.profileId,
        field: "headline",
        value: "Fallback headline",
        source: "deepline",
        sourceRecordId: "deepline:source-precedence",
        pipelineVersion: "deepline-fallback-v1",
        confidence: 0.8,
        collectedAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    ]);

    await expect(
      resolveProfileField(database, profile.profileId, "headline"),
    ).resolves.toMatchObject({
      value: "Direct headline",
      observationSource: "tikhub",
    });
  });

  it("opts out immediately and can opt back in", async () => {
    await createMember("member-search");
    const profile = await createImportedProfile("504");
    await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-search",
      oauthGithubAccountId: "504",
      oauthGithubLogin: "search-owner",
    });
    expect(
      (await setProfileSearchability(database, "member-search", false))
        .searchabilityReason,
    ).toBe("member_opt_out");
    expect(
      (
        await setProfileSearchability(
          database,
          "member-search",
          true,
          eligibleGitHub("504", "renamed-search-owner"),
        )
      ).searchabilityReason,
    ).toBe("member_opt_in");
  });

  it("requires current GitHub eligibility before opting back in", async () => {
    await createMember("member-current-eligibility");
    const profile = await createImportedProfile("513");
    await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-current-eligibility",
      oauthGithubAccountId: "513",
      oauthGithubLogin: "eligible-owner",
    });

    await expect(
      setProfileSearchability(database, "member-current-eligibility", true),
    ).rejects.toThrow("profile_eligibility_verification_required");
    await expect(
      setProfileSearchability(database, "member-current-eligibility", true, {
        ...eligibleGitHub("999"),
        accountType: "Bot",
      }),
    ).rejects.toThrow("profile_ineligible");
    await expect(
      setProfileSearchability(
        database,
        "member-current-eligibility",
        true,
        {
          ...eligibleGitHub("513"),
          ownsNonForkRepository: false,
          contributedPubliclySince: new Date("2024-01-01T00:00:00Z"),
        },
        new Date("2026-09-03T00:00:00Z"),
      ),
    ).rejects.toThrow("profile_ineligible");
    await expect(
      database
        .select({ searchable: schema.profiles.searchable })
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, profile.profileId)),
    ).resolves.toEqual([{ searchable: false }]);
    await expect(
      setProfileSearchability(database, "member-current-eligibility", true, {
        ...eligibleGitHub("513"),
        knownMinor: true,
      }),
    ).rejects.toThrow("profile_suppressed");
    await expect(
      database
        .select()
        .from(schema.suppressionRecords)
        .where(eq(schema.suppressionRecords.canonicalProviderId, "513")),
    ).resolves.toEqual([expect.objectContaining({ reason: "known_minor" })]);
    await expect(
      editControlledProfile(database, {
        memberId: "member-current-eligibility",
        name: "Recreated name",
        currentCompany: "Recreated company",
        professionalLinks: ["https://example.com/recreated"],
      }),
    ).rejects.toThrow("profile_suppressed");
    await expect(
      setMemberStatement(database, {
        memberId: "member-current-eligibility",
        field: "bio",
        value: "Recreated statement",
      }),
    ).rejects.toThrow("profile_suppressed");
    await expect(
      recordVerifiedContactDetail(database, {
        profileId: profile.profileId,
        kind: "email",
        value: "recreated@example.com",
        source: "provider",
        sourceRecordId: "suppressed-contact",
        category: "professional",
        verification: "provider-verified",
        verifiedAt: new Date(),
      }),
    ).rejects.toThrow("not_found");
    await expect(
      database
        .select()
        .from(schema.profileObservations)
        .where(eq(schema.profileObservations.profileId, profile.profileId)),
    ).resolves.toEqual([]);
    await expect(
      database
        .select({ status: schema.profileClaims.status })
        .from(schema.profileClaims)
        .where(eq(schema.profileClaims.profileId, profile.profileId)),
    ).resolves.toEqual([{ status: "superseded" }]);
  });

  it("keeps stale public activity classified as private attestation", async () => {
    await createMember("member-private-attestation");
    const service = makeDatabaseService(database);
    const verification = {
      ...eligibleGitHub("519", "private-attestation"),
      ownsNonForkRepository: false,
      contributedPubliclySince: new Date("2020-01-01T00:00:00Z"),
    };
    const saved = await Effect.runPromise(
      service.saveProfile(
        "member-private-attestation",
        {
          name: "Private Attestation",
          currentCompany: null,
          professionalLinks: ["https://github.com/private-attestation"],
          statements: {},
          adultAttestation: true,
          privateCodeAttestation: true,
          searchable: true,
        },
        verification,
      ),
    );
    expect(saved.eligibilityBasis).toBe("private_attestation");

    await setProfileSearchability(
      database,
      "member-private-attestation",
      false,
    );
    await expect(
      setProfileSearchability(
        database,
        "member-private-attestation",
        true,
        verification,
        new Date("2026-09-03T00:00:00Z"),
      ),
    ).resolves.toMatchObject({
      eligibilityBasis: "private_attestation",
      searchable: true,
    });
  });

  it("durably suppresses an Imported Profile when trusted identity marks a minor", async () => {
    const profile = await createImportedProfile("514", "known-minor");

    await suppressKnownMinorProfile(database, "000514");

    await expect(
      database
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, profile.profileId)),
    ).resolves.toEqual([
      expect.objectContaining({
        memberId: null,
        name: "Suppressed Profile",
        searchable: false,
        searchabilityReason: "operator_suppression",
      }),
    ]);
    await expect(
      database
        .select()
        .from(schema.suppressionRecords)
        .where(eq(schema.suppressionRecords.canonicalProviderId, "514")),
    ).resolves.toEqual([expect.objectContaining({ reason: "known_minor" })]);
    await expect(
      findClaimCandidates(database, { githubAccountId: "514" }),
    ).resolves.toEqual([]);
  });

  it("suppresses a controlled Profile when a changed identity reports a minor", async () => {
    await createMember("member-changed-minor");
    const profile = await createImportedProfile("520", "adult-identity");
    await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-changed-minor",
      oauthGithubAccountId: "520",
      oauthGithubLogin: "adult-identity",
    });
    const service = makeDatabaseService(database);

    await expect(
      Effect.runPromise(
        service.saveProfile(
          "member-changed-minor",
          {
            name: "Changed Identity",
            currentCompany: null,
            professionalLinks: ["https://github.com/changed-minor"],
            statements: {},
            adultAttestation: true,
            privateCodeAttestation: false,
            searchable: true,
          },
          {
            ...eligibleGitHub("521", "changed-minor"),
            knownMinor: true,
          },
        ),
      ),
    ).rejects.toMatchObject({ reason: "adult_required" });
    await expect(
      database
        .select({
          memberId: schema.profiles.memberId,
          searchable: schema.profiles.searchable,
          searchabilityReason: schema.profiles.searchabilityReason,
        })
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, profile.profileId)),
    ).resolves.toEqual([
      {
        memberId: "member-changed-minor",
        searchable: false,
        searchabilityReason: "operator_suppression",
      },
    ]);
    await expect(
      database
        .select({ id: schema.suppressionRecords.canonicalProviderId })
        .from(schema.suppressionRecords)
        .where(eq(schema.suppressionRecords.reason, "known_minor")),
    ).resolves.toEqual(expect.arrayContaining([{ id: "520" }, { id: "521" }]));
  });

  it("applies ordinary edits and verifies canonical identity changes", async () => {
    await createMember("member-edit");
    const profile = await createImportedProfile("506", "edit-me");
    await database.insert(schema.professionalLinks).values({
      profileId: profile.profileId,
      url: "https://github.com/edit-me",
    });
    await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-edit",
      oauthGithubAccountId: "506",
      oauthGithubLogin: "edit-me",
    });
    await editControlledProfile(database, {
      memberId: "member-edit",
      name: "Edited Immediately",
      currentCompany: "Humans",
      professionalLinks: [
        "https://github.com/edit-me",
        "https://example.com/portfolio",
      ],
    });
    await expect(
      editControlledProfile(database, {
        memberId: "member-edit",
        name: "Edited Immediately",
        currentCompany: "Humans",
        professionalLinks: ["https://github.com/a-different-person"],
      }),
    ).rejects.toThrow("canonical_identity_change_requires_verification");
    await editControlledProfile(database, {
      memberId: "member-edit",
      name: "Edited Immediately",
      currentCompany: "Humans",
      professionalLinks: ["https://github.com/renamed-edit-me"],
      canonicalIdentityVerification: {
        github: {
          accountId: "506",
          login: "renamed-edit-me",
          accountType: "User",
          ownershipVerified: true,
          knownMinor: false,
        },
      },
    });
    await editControlledProfile(database, {
      memberId: "member-edit",
      name: "Edited Immediately",
      currentCompany: "Humans",
      professionalLinks: [
        "https://github.com/renamed-edit-me",
        "https://mx.linkedin.com/in/member-edit",
      ],
      canonicalIdentityVerification: {
        linkedIn: {
          username: "member-edit",
          providerUserId: "linkedin-provider-member-edit",
        },
      },
    });
    await expect(
      database
        .select()
        .from(schema.professionalLinks)
        .where(eq(schema.professionalLinks.profileId, profile.profileId)),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://github.com/renamed-edit-me",
          source: "member",
          sourceRecordId: "member-edit",
          verifiedProvider: "github",
          verifiedProviderUserId: "506",
          verifiedAt: expect.any(Date),
        }),
        expect.objectContaining({
          url: "https://mx.linkedin.com/in/member-edit",
          source: "member",
          sourceRecordId: "member-edit",
          verifiedProvider: "linkedin",
          verifiedProviderUserId: "linkedin-provider-member-edit",
          verifiedAt: expect.any(Date),
        }),
      ]),
    );
    await expect(
      editControlledProfile(database, {
        memberId: "member-edit",
        name: "Edited Immediately",
        currentCompany: "Humans",
        professionalLinks: ["ftp://linkedin.com/in/member-edit"],
      }),
    ).rejects.toThrow("invalid_professional_link");
    for (const privateLink of [
      "http://localhost/profile",
      "http://127.0.0.1/profile",
      "http://192.168.1.20/profile",
      "http://[::1]/profile",
      "http://internal/profile",
      "http://service.local/profile",
    ]) {
      await expect(
        editControlledProfile(database, {
          memberId: "member-edit",
          name: "Edited Immediately",
          currentCompany: "Humans",
          professionalLinks: [privateLink],
        }),
      ).rejects.toThrow("invalid_professional_link");
    }
  });

  it("retains only affected enrichment stages while a controlled Profile is not searchable", async () => {
    await createMember("member-edit-dispatch");
    const profile = await createImportedProfile("515", "dispatch-me");
    await database.insert(schema.professionalLinks).values({
      profileId: profile.profileId,
      url: "https://github.com/dispatch-me",
    });
    await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-edit-dispatch",
      oauthGithubAccountId: "515",
      oauthGithubLogin: "dispatch-me",
    });
    await expect(
      database
        .select({ searchable: schema.profiles.searchable })
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, profile.profileId)),
    ).resolves.toEqual([{ searchable: false }]);

    await editControlledProfile(database, {
      memberId: "member-edit-dispatch",
      name: "Person 515",
      currentCompany: null,
      professionalLinks: [
        "https://github.com/dispatch-me",
        "https://example.com/portfolio",
      ],
    });
    await expect(
      database
        .select()
        .from(schema.enrichmentDispatches)
        .where(eq(schema.enrichmentDispatches.profileId, profile.profileId)),
    ).resolves.toEqual([]);

    await editControlledProfile(database, {
      memberId: "member-edit-dispatch",
      name: "Person 515",
      currentCompany: null,
      professionalLinks: ["https://github.com/dispatch-renamed"],
      canonicalIdentityVerification: {
        github: {
          accountId: "515",
          login: "dispatch-renamed",
          accountType: "User",
          ownershipVerified: true,
          knownMinor: false,
        },
      },
    });
    await expect(
      database
        .select({ provider: schema.enrichmentDispatches.provider })
        .from(schema.enrichmentDispatches)
        .where(eq(schema.enrichmentDispatches.profileId, profile.profileId)),
    ).resolves.toEqual([{ provider: "github" }]);
    await database
      .delete(schema.enrichmentDispatches)
      .where(eq(schema.enrichmentDispatches.profileId, profile.profileId));

    await editControlledProfile(database, {
      memberId: "member-edit-dispatch",
      name: "Person 515",
      currentCompany: null,
      professionalLinks: [
        "https://github.com/dispatch-renamed",
        "https://linkedin.com/in/dispatch-me",
      ],
      canonicalIdentityVerification: {
        linkedIn: {
          username: "dispatch-me",
          providerUserId: "linkedin-provider-dispatch-me",
        },
      },
    });
    await expect(
      database
        .select({ provider: schema.enrichmentDispatches.provider })
        .from(schema.enrichmentDispatches)
        .where(eq(schema.enrichmentDispatches.profileId, profile.profileId)),
    ).resolves.toEqual([{ provider: "tikhub" }]);
    await database
      .delete(schema.enrichmentDispatches)
      .where(eq(schema.enrichmentDispatches.profileId, profile.profileId));

    const inspectedAt = new Date("2026-09-01T00:00:00.000Z");
    await database.insert(schema.enrichmentRuns).values([
      {
        id: "profile-control-github-inspected",
        profileId: profile.profileId,
        provider: "github",
        status: "succeeded",
        pipelineVersion: "github-v1",
        startedAt: inspectedAt,
        finishedAt: inspectedAt,
      },
      {
        id: "profile-control-tikhub-inspected",
        profileId: profile.profileId,
        provider: "tikhub",
        status: "succeeded",
        pipelineVersion: "tikhub-linkedin-v1",
        startedAt: inspectedAt,
        finishedAt: inspectedAt,
      },
    ]);
    await editControlledProfile(database, {
      memberId: "member-edit-dispatch",
      name: "Renamed Person 515",
      currentCompany: null,
      professionalLinks: [
        "https://github.com/dispatch-renamed",
        "https://linkedin.com/in/dispatch-me",
      ],
    });
    await expect(
      database
        .select({ provider: schema.enrichmentDispatches.provider })
        .from(schema.enrichmentDispatches)
        .where(eq(schema.enrichmentDispatches.profileId, profile.profileId)),
    ).resolves.toEqual([{ provider: "deepline" }]);
  });

  it("accepts an unauthenticated removal request, suppresses after verification, and prevents re-import", async () => {
    const profile = await createImportedProfile("505", "remove-me");
    await createMember("removed-profile-owner");
    await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "removed-profile-owner",
      oauthGithubAccountId: "505",
      oauthGithubLogin: "remove-me",
    });
    await setProfileSearchability(
      database,
      "removed-profile-owner",
      true,
      eligibleGitHub("505", "remove-me"),
    );
    await createMember("removal-list-owner");
    await database.insert(schema.organizations).values({
      clerkId: "removal-organization",
      name: "Removal Organization",
    });
    const [savedList] = await database
      .insert(schema.savedLists)
      .values({
        organizationId: "removal-organization",
        name: "Private notes",
        createdBy: "removal-list-owner",
      })
      .returning();
    if (!savedList) throw new Error("Saved List fixture was not created");
    await database.insert(schema.savedListEntries).values({
      listId: savedList.id,
      profileId: profile.profileId,
      note: "Sensitive team note",
      addedBy: "removal-list-owner",
    });
    await database.insert(schema.legacyContactDetails).values({
      profileId: profile.profileId,
      kind: "professional-email",
      value: "remove-me@example.com",
      source: "fixture",
      sourceRecordId: "remove-contact-505",
      verifiedAt: new Date(),
    });
    const request = await submitPublicProfileRequest(database, {
      profileId: profile.profileId,
      kind: "removal",
      requesterEmail: "person@example.com",
      details: "Please remove me",
    });
    expect(request.status).toBe("awaiting_verification");
    expect(
      (
        await database
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.profileId, profile.profileId))
      )[0],
    ).toMatchObject({ searchable: true, searchabilityReason: "member_opt_in" });
    expect(() =>
      verifyProfileRequest(database, request.id, {
        operatorId: "operator-removal",
        correlationId: "verify-removal-missing-evidence",
        verificationMethod: " ",
        evidenceReference: "",
      }),
    ).toThrow("request_verification_evidence_required");
    await verifyProfileRequest(database, request.id, {
      operatorId: "operator-removal",
      correlationId: "verify-removal",
      reason: "Verified control of the public email address",
      verificationMethod: "email_challenge",
      evidenceReference: "evidence://profile-request/removal-505",
    });
    await expect(
      database
        .select()
        .from(schema.profileRequests)
        .where(eq(schema.profileRequests.id, request.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "pending",
        verificationMethod: "email_challenge",
        verificationEvidenceReference: "evidence://profile-request/removal-505",
        verifiedAt: expect.any(Date),
      }),
    ]);
    expect(
      (
        await database
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.profileId, profile.profileId))
      )[0],
    ).toMatchObject({ searchable: false, searchabilityReason: "disputed" });
    expect(
      await reviewProfileRequest(
        database,
        request.id,
        true,
        requestDecision(request.id),
      ),
    ).toMatchObject({ id: request.id, status: "confirmed" });
    const csv = `contract_version,source,source_record_id,name,current_company,github_account_id,github_login,qualifying_evidence,adult_confirmed,professional_links\nhumans-profiles-v1,reimport,505,Restored Name,,505,remove-me,owned_repository,true,https://github.com/remove-me`;
    const report = await importProfiles(database, csv, { dryRun: false });
    expect(report.appliedChanges.createProfiles).toBe(0);
    expect(
      (
        await database
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.profileId, profile.profileId))
      )[0],
    ).toMatchObject({ name: "Suppressed Profile", searchable: false });
    expect(
      await database
        .select()
        .from(schema.suppressionRecords)
        .where(eq(schema.suppressionRecords.canonicalProviderId, "505")),
    ).toHaveLength(1);
    await expect(
      database
        .select()
        .from(schema.savedListEntries)
        .where(eq(schema.savedListEntries.profileId, profile.profileId)),
    ).resolves.toEqual([]);
    await expect(
      database
        .select()
        .from(schema.legacyContactDetails)
        .where(eq(schema.legacyContactDetails.profileId, profile.profileId)),
    ).resolves.toEqual([
      expect.objectContaining({
        value: "[removed]",
        source: "profile-suppression",
        sourceRecordId: expect.stringMatching(/^suppressed:/),
        valid: false,
        suppressed: true,
      }),
    ]);
    expect(
      await database
        .select()
        .from(schema.profileRequests)
        .where(eq(schema.profileRequests.profileId, profile.profileId)),
    ).toEqual([
      expect.objectContaining({
        status: "confirmed",
        requesterEmail: "removed@example.invalid",
        details: "Removed after confirmed request",
        verificationMethod: null,
        verificationEvidenceReference: null,
        verifiedAt: null,
      }),
    ]);
    await expect(
      database
        .select()
        .from(schema.profileClaims)
        .where(eq(schema.profileClaims.profileId, profile.profileId)),
    ).resolves.toEqual([]);
    const removalAudit = await database
      .select({
        action: schema.operatorAuditEvents.action,
        metadata: schema.operatorAuditEvents.metadata,
        reason: schema.operatorAuditEvents.reason,
      })
      .from(schema.operatorAuditEvents)
      .where(eq(schema.operatorAuditEvents.subjectId, request.id));
    expect(removalAudit.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        "profile_request.verify",
        "profile_request.confirm",
      ]),
    );
    expect(removalAudit).toEqual(
      expect.arrayContaining([expect.objectContaining({ metadata: null })]),
    );
    expect(
      removalAudit.every(
        ({ metadata, reason }) =>
          metadata === null && reason === "Redacted after confirmed removal",
      ),
    ).toBe(true);
  });

  it("restores the exact Searchability state after rejecting a request", async () => {
    await createMember("member-dispute");
    const profile = await createImportedProfile("508");
    await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-dispute",
      oauthGithubAccountId: "508",
      oauthGithubLogin: "dispute-owner",
    });
    await setProfileSearchability(
      database,
      "member-dispute",
      true,
      eligibleGitHub("508", "dispute-owner"),
    );
    const request = await submitPublicProfileRequest(database, {
      profileId: profile.profileId,
      kind: "correction",
      requesterEmail: "person@example.com",
      details: "The company is wrong",
    });

    await verifyProfileRequest(
      database,
      request.id,
      requestVerification(request.id),
    );
    await reviewProfileRequest(
      database,
      request.id,
      false,
      requestDecision(request.id),
    );
    expect(
      (
        await database
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.profileId, profile.profileId))
      )[0],
    ).toMatchObject({
      searchable: true,
      searchabilityReason: "member_opt_in",
    });
  });

  it("audits dismissal before verification and allows a later request", async () => {
    const profile = await createImportedProfile("517");
    const request = await submitPublicProfileRequest(database, {
      profileId: profile.profileId,
      kind: "correction",
      requesterEmail: "unverified@example.com",
      details: "This request cannot be verified",
    });

    const dismissed = await reviewProfileRequest(
      database,
      request.id,
      false,
      requestDecision(request.id),
    );
    expect(dismissed.status).toBe("dismissed");
    await expect(
      database
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, profile.profileId)),
    ).resolves.toEqual([
      expect.objectContaining({
        searchable: true,
        searchabilityReason: "approved_import",
      }),
    ]);
    await expect(
      database
        .select()
        .from(schema.operatorAuditEvents)
        .where(eq(schema.operatorAuditEvents.subjectId, request.id)),
    ).resolves.toEqual([
      expect.objectContaining({ action: "profile_request.dismiss" }),
    ]);
    await expect(
      submitPublicProfileRequest(database, {
        profileId: profile.profileId,
        kind: "removal",
        requesterEmail: "verified@example.com",
        details: "A later request",
      }),
    ).resolves.toMatchObject({ status: "awaiting_verification" });
  });

  it("does not restore stale Searchability when dismissing before verification", async () => {
    await createMember("member-unverified-dismissal");
    const profile = await createImportedProfile("524");
    await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-unverified-dismissal",
      oauthGithubAccountId: "524",
      oauthGithubLogin: "unverified-dismissal",
    });
    await setProfileSearchability(
      database,
      "member-unverified-dismissal",
      true,
      eligibleGitHub("524", "unverified-dismissal"),
    );
    const request = await submitPublicProfileRequest(database, {
      profileId: profile.profileId,
      kind: "correction",
      requesterEmail: "stale@example.com",
      details: "This request will not be verified",
    });
    await setProfileSearchability(
      database,
      "member-unverified-dismissal",
      false,
    );

    await reviewProfileRequest(
      database,
      request.id,
      false,
      requestDecision(request.id),
    );

    await expect(
      database
        .select({
          searchable: schema.profiles.searchable,
          searchabilityReason: schema.profiles.searchabilityReason,
        })
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, profile.profileId)),
    ).resolves.toEqual([
      { searchable: false, searchabilityReason: "member_opt_out" },
    ]);
  });

  it("allows unverified requests alongside one verified dispute review", async () => {
    const profile = await createImportedProfile("525");
    const first = await submitPublicProfileRequest(database, {
      profileId: profile.profileId,
      kind: "correction",
      requesterEmail: "first@example.com",
      details: "The first distinct request",
    });
    const second = await submitPublicProfileRequest(database, {
      profileId: profile.profileId,
      kind: "removal",
      requesterEmail: "second@example.com",
      details: "The second distinct request",
    });

    await verifyProfileRequest(
      database,
      first.id,
      requestVerification(first.id),
    );
    const third = await submitPublicProfileRequest(database, {
      profileId: profile.profileId,
      kind: "correction",
      requesterEmail: "third@example.com",
      details: "Submitted while verified review is active",
    });
    await expect(
      verifyProfileRequest(
        database,
        second.id,
        requestVerification(second.id),
      ),
    ).rejects.toThrow("request_already_active");

    await reviewProfileRequest(
      database,
      first.id,
      false,
      requestDecision(first.id),
    );
    await expect(
      database
        .select({
          searchable: schema.profiles.searchable,
          searchabilityReason: schema.profiles.searchabilityReason,
        })
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, profile.profileId)),
    ).resolves.toEqual([
      { searchable: true, searchabilityReason: "approved_import" },
    ]);

    await verifyProfileRequest(
      database,
      second.id,
      requestVerification(second.id),
    );
    await reviewProfileRequest(
      database,
      second.id,
      false,
      requestDecision(second.id),
    );
    await reviewProfileRequest(
      database,
      third.id,
      false,
      requestDecision(third.id),
    );
    await expect(
      database
        .select({
          id: schema.profileRequests.id,
          status: schema.profileRequests.status,
        })
        .from(schema.profileRequests)
        .where(eq(schema.profileRequests.profileId, profile.profileId)),
    ).resolves.toEqual(
      expect.arrayContaining([
        { id: first.id, status: "rejected" },
        { id: second.id, status: "rejected" },
        { id: third.id, status: "dismissed" },
      ]),
    );
    await expect(
      database
        .select({
          searchable: schema.profiles.searchable,
          searchabilityReason: schema.profiles.searchabilityReason,
        })
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, profile.profileId)),
    ).resolves.toEqual([
      { searchable: true, searchabilityReason: "approved_import" },
    ]);
  });

  it("expires an abandoned unverified request before accepting another", async () => {
    const profile = await createImportedProfile("523");
    const abandoned = await submitPublicProfileRequest(database, {
      profileId: profile.profileId,
      kind: "correction",
      requesterEmail: "abandoned@example.com",
      details: "This request was never verified",
    });
    await database
      .update(schema.profileRequests)
      .set({ createdAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(schema.profileRequests.id, abandoned.id));

    await expect(
      submitPublicProfileRequest(database, {
        profileId: profile.profileId,
        kind: "removal",
        requesterEmail: "current@example.com",
        details: "This request can now be verified",
      }),
    ).resolves.toMatchObject({ status: "awaiting_verification" });
    await expect(
      database
        .select({
          status: schema.profileRequests.status,
          requesterEmail: schema.profileRequests.requesterEmail,
        })
        .from(schema.profileRequests)
        .where(eq(schema.profileRequests.id, abandoned.id)),
    ).resolves.toEqual([
      {
        status: "expired",
        requesterEmail: "expired@example.invalid",
      },
    ]);
  });

  it("records an auditable Operator claim decision", async () => {
    await createMember("member-operator-review");
    const profile = await createImportedProfile("509");
    const claim = await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-operator-review",
      oauthGithubAccountId: "9509",
      oauthGithubLogin: "operator-reviewer",
    });

    expect((await getOperatorOverview(database)).claims).toContainEqual(
      expect.objectContaining({
        id: claim.id,
        githubAccountId: "9509",
        targetGithubAccountId: "509",
        targetGithubLogin: "person-509",
      }),
    );

    await reviewClaimAsOperator(database, claim.id, false, {
      operatorId: "operator-one",
      correlationId: "correlation-one",
      reason: "Identity evidence did not match",
    });

    const overview = await getOperatorOverview(database);
    expect(overview.claims).not.toContainEqual(
      expect.objectContaining({ id: claim.id }),
    );
    expect(overview.auditTrail).toContainEqual(
      expect.objectContaining({
        operatorId: "operator-one",
        action: "claim.reject",
        subjectId: claim.id,
        reason: "Identity evidence did not match",
        correlationId: "correlation-one",
      }),
    );
  });

  it("applies an Operator-reviewed correction and restores Searchability", async () => {
    const profile = await createImportedProfile("510", "old-login");
    await database.insert(schema.professionalLinks).values({
      profileId: profile.profileId,
      url: "https://github.com/old-login",
      source: "import-fixture",
      sourceRecordId: "incorrect-links-510",
    });
    await database.insert(schema.profileObservations).values([
      {
        profileId: profile.profileId,
        field: "name",
        value: "Incorrect Imported Name",
        source: "import-fixture",
        sourceRecordId: "incorrect-name-510",
        pipelineVersion: "import-v1",
        confidence: 1,
      },
      {
        profileId: profile.profileId,
        field: "current_company",
        value: "Incorrect Company",
        source: "import-fixture",
        sourceRecordId: "incorrect-company-510",
        pipelineVersion: "import-v1",
        confidence: 1,
      },
    ]);
    const request = await submitPublicProfileRequest(database, {
      profileId: profile.profileId,
      kind: "correction",
      requesterEmail: "correct-me@example.com",
      details: "My company changed",
    });

    await verifyProfileRequest(
      database,
      request.id,
      requestVerification(request.id),
    );
    await reviewProfileRequest(database, request.id, true, {
      operatorId: "operator-two",
      correlationId: "correlation-two",
      reason: "Verified against the immutable GitHub account",
      correction: {
        name: "Correct Name",
        currentCompany: "Correct Company",
        headline: "Building safer infrastructure",
        currentResidence: "Medellin, Colombia",
        roles: ["Staff Engineer", "Maintainer"],
        skills: ["TypeScript", "PostgreSQL"],
        seniority: "staff",
        experienceYears: 11,
        opportunityStatus: "open",
        professionalLinks: [
          "https://github.com/old-login",
          "https://correct.example/portfolio",
        ],
      },
    });

    await expect(
      database
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, profile.profileId)),
    ).resolves.toEqual([
      expect.objectContaining({
        name: "Correct Name",
        githubLogin: "old-login",
        currentCompany: "Correct Company",
        searchable: true,
        searchabilityReason: "approved_import",
      }),
    ]);
    await expect(
      getSearchableProfile(database, profile.profileId),
    ).resolves.toMatchObject({
      name: "Correct Name",
      currentCompany: "Correct Company",
      headline: "Building safer infrastructure",
      currentResidence: "Medellin, Colombia",
      primaryRole: "Staff Engineer",
      skills: ["TypeScript", "PostgreSQL"],
      seniority: "staff",
      experienceYears: 11,
      opportunityStatus: "open",
      links: [
        "https://github.com/old-login",
        "https://correct.example/portfolio",
      ],
    });
    await expect(
      database
        .select({
          url: schema.professionalLinks.url,
          source: schema.professionalLinks.source,
          sourceRecordId: schema.professionalLinks.sourceRecordId,
        })
        .from(schema.professionalLinks)
        .where(eq(schema.professionalLinks.profileId, profile.profileId))
        .orderBy(schema.professionalLinks.url),
    ).resolves.toEqual([
      {
        url: "https://correct.example/portfolio",
        source: "public-profile-request",
        sourceRecordId: request.id,
      },
      {
        url: "https://github.com/old-login",
        source: "public-profile-request",
        sourceRecordId: request.id,
      },
    ]);
    await database.insert(schema.profileObservations).values({
      profileId: profile.profileId,
      field: "name",
      value: "Later External Name",
      source: "later-provider",
      sourceRecordId: "later-name-510",
      pipelineVersion: "provider-v2",
      confidence: 1,
      collectedAt: new Date("2030-01-01T00:00:00Z"),
    });
    await expect(
      getSearchableProfile(database, profile.profileId),
    ).resolves.toMatchObject({ name: "Correct Name" });
    await expect(
      database
        .select({
          field: schema.profileObservations.field,
          source: schema.profileObservations.source,
          sourceRecordId: schema.profileObservations.sourceRecordId,
        })
        .from(schema.profileObservations)
        .where(eq(schema.profileObservations.sourceRecordId, request.id)),
    ).resolves.toEqual(
      expect.arrayContaining([
        {
          field: "name",
          source: "public-profile-request",
          sourceRecordId: request.id,
        },
        {
          field: "current_company",
          source: "public-profile-request",
          sourceRecordId: request.id,
        },
      ]),
    );
    const clearRequest = await submitPublicProfileRequest(database, {
      profileId: profile.profileId,
      kind: "correction",
      requesterEmail: "correct-me@example.com",
      details: "Clear outdated public fields",
    });
    await verifyProfileRequest(
      database,
      clearRequest.id,
      requestVerification(clearRequest.id),
    );
    await reviewProfileRequest(database, clearRequest.id, true, {
      operatorId: "operator-two",
      correlationId: "correlation-clear",
      reason: "Verified request to clear stale fields",
      correction: {
        currentCompany: null,
        headline: null,
        currentResidence: null,
        roles: [],
        skills: [],
        seniority: null,
        experienceYears: null,
        opportunityStatus: "unspecified",
      },
    });
    await expect(
      getSearchableProfile(database, profile.profileId),
    ).resolves.toMatchObject({
      currentCompany: null,
      headline: null,
      currentResidence: null,
      primaryRole: null,
      skills: [],
      seniority: null,
      experienceYears: null,
      opportunityStatus: "unspecified",
    });
  });
});
