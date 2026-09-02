import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importProfiles } from "../src/import-profiles";
import { getOperatorOverview, reviewClaimAsOperator } from "../src/operations";
import {
  editControlledProfile,
  findClaimCandidates,
  requestProfileClaim,
  resolveProfileField,
  reviewProfileClaim,
  reviewProfileRequest,
  setMemberStatement,
  setProfileSearchability,
  submitPublicProfileRequest,
} from "../src/profile-control";
import * as schema from "../src/schema";

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
    return profile!;
  };

  it("suggests a match but only an immutable OAuth account ID verifies control", async () => {
    await createMember("member-auto");
    const profile = await createImportedProfile("501", "renamed-login");
    expect(
      await findClaimCandidates(database, { githubAccountId: "501" }),
    ).toEqual([expect.objectContaining({ profileId: profile.profileId })]);
    expect(
      (
        await database
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.profileId, profile.profileId))
      )[0]?.memberId,
    ).toBeNull();

    const claim = await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-auto",
      oauthGithubAccountId: "501",
    });
    expect(claim.status).toBe("verified");
    expect(
      (
        await database
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.profileId, profile.profileId))
      )[0]?.memberId,
    ).toBe("member-auto");
  });

  it("does not suggest or transfer Profiles that are already controlled", async () => {
    await createMember("member-owner");
    await createMember("member-thief");
    const profile = await createImportedProfile("507");
    await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-owner",
      oauthGithubAccountId: "507",
    });

    await expect(
      findClaimCandidates(database, { githubAccountId: "507" }),
    ).resolves.toEqual([]);
    await expect(
      requestProfileClaim(database, {
        profileId: profile.profileId,
        memberId: "member-thief",
        oauthGithubAccountId: "507",
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
    });
    expect(claim.status).toBe("pending_review");
    await expect(
      requestProfileClaim(database, {
        profileId: profile.profileId,
        memberId: "member-collision",
        oauthGithubAccountId: "502",
      }),
    ).rejects.toThrow("profile_already_claimed");
    expect((await reviewProfileClaim(database, claim.id, true)).status).toBe(
      "verified",
    );
  });

  it("gives current Member Statements precedence and restores Observations when removed", async () => {
    await createMember("member-statement");
    const profile = await createImportedProfile("503");
    await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-statement",
      oauthGithubAccountId: "503",
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

  it("opts out immediately and can opt back in", async () => {
    await createMember("member-search");
    const profile = await createImportedProfile("504");
    await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-search",
      oauthGithubAccountId: "504",
    });
    expect(
      (await setProfileSearchability(database, "member-search", false))
        .searchabilityReason,
    ).toBe("member_opt_out");
    expect(
      (await setProfileSearchability(database, "member-search", true))
        .searchabilityReason,
    ).toBe("member_opt_in");
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
      professionalLinks: ["https://github.com/a-different-person"],
      canonicalIdentityChangeVerified: true,
    });
  });

  it("accepts an unauthenticated removal request, suppresses during review, and prevents re-import", async () => {
    const profile = await createImportedProfile("505", "remove-me");
    const request = await submitPublicProfileRequest(database, {
      profileId: profile.profileId,
      kind: "removal",
      requesterEmail: "person@example.com",
      details: "Please remove me",
    });
    expect(
      (
        await database
          .select()
          .from(schema.profiles)
          .where(eq(schema.profiles.profileId, profile.profileId))
      )[0],
    ).toMatchObject({ searchable: false, searchabilityReason: "disputed" });
    expect(
      await reviewProfileRequest(database, request.id, true),
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
    expect(
      await database
        .select()
        .from(schema.profileRequests)
        .where(eq(schema.profileRequests.profileId, profile.profileId)),
    ).toEqual([expect.objectContaining({ status: "confirmed" })]);
  });

  it("restores the exact Searchability state after rejecting a request", async () => {
    await createMember("member-dispute");
    const profile = await createImportedProfile("508");
    await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-dispute",
      oauthGithubAccountId: "508",
    });
    await setProfileSearchability(database, "member-dispute", true);
    const request = await submitPublicProfileRequest(database, {
      profileId: profile.profileId,
      kind: "correction",
      requesterEmail: "person@example.com",
      details: "The company is wrong",
    });

    await reviewProfileRequest(database, request.id, false);
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

  it("records an auditable Operator claim decision", async () => {
    await createMember("member-operator-review");
    const profile = await createImportedProfile("509");
    const claim = await requestProfileClaim(database, {
      profileId: profile.profileId,
      memberId: "member-operator-review",
      oauthGithubAccountId: "different-account",
    });

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
    const request = await submitPublicProfileRequest(database, {
      profileId: profile.profileId,
      kind: "correction",
      requesterEmail: "correct-me@example.com",
      details: "My GitHub login and company changed",
    });

    await reviewProfileRequest(database, request.id, true, {
      operatorId: "operator-two",
      correlationId: "correlation-two",
      reason: "Verified against the immutable GitHub account",
      correction: {
        githubLogin: "correct-login",
        currentCompany: "Correct Company",
      },
    });

    await expect(
      database
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, profile.profileId)),
    ).resolves.toEqual([
      expect.objectContaining({
        githubLogin: "correct-login",
        currentCompany: "Correct Company",
        searchable: true,
        searchabilityReason: "approved_import",
      }),
    ]);
  });
});
