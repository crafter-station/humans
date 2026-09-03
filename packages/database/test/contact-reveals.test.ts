import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  contactRevealLogFields,
  listContactDetails,
  purchaseContactReveal,
  recordVerifiedContactDetail,
  reportInvalidContactDetail,
  setContactDetailSuppression,
  setOrganizationContactRevealPolicy,
} from "../src/contact-reveals";
import { applyCreditEntry, getCreditBalance } from "../src/credits";
import { suppressProviderIdentity } from "../src/import-profiles";
import {
  reviewProfileRequest,
  editControlledProfile,
  submitPublicProfileRequest,
  verifyProfileRequest,
} from "../src/profile-control";
import * as schema from "../src/schema";

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

describe("Contact Reveals", () => {
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
    await database.delete(schema.securityActivity);
    await database.delete(schema.securityAuditEvents);
    await database.delete(schema.principalSuspensions);
    await database.delete(schema.memberFreeCreditClaims);
    await database.delete(schema.organizationEntitlements);
    await database.delete(schema.reenrichmentOutbox);
    await database.delete(schema.contactDetailInvalidations);
    await database.delete(schema.enrichmentDispatches);
    await database.delete(schema.contactRevealRequests);
    await database.delete(schema.contactReveals);
    await database.delete(schema.contactDetailSuppressions);
    await database.delete(schema.creditLedgerEntries);
    await database.delete(schema.creditAccounts);
    await database.delete(schema.profileObservations);
    await database.delete(schema.professionalLinks);
    await database.delete(schema.profileRequests);
    await database.delete(schema.suppressionRecords);
    await database.delete(schema.profiles);
    await database.delete(schema.organizationMemberships);
    await database.delete(schema.organizations);
    await database.delete(schema.members);
    await seed();
  });

  afterAll(async () => {
    await resources.pool?.end();
    await resources.container?.stop();
  });

  const seed = async () => {
    await database.insert(schema.members).values([
      { clerkId: "member_owner", name: "Owner" },
      { clerkId: "member_one", name: "One" },
      { clerkId: "member_two", name: "Two" },
      { clerkId: "member_admin", name: "Admin" },
    ]);
    await database.insert(schema.organizations).values([
      { clerkId: "organization_one", name: "One" },
      { clerkId: "organization_two", name: "Two" },
    ]);
    await database.insert(schema.organizationEntitlements).values([
      { organizationId: "organization_one", tier: "free", status: "active" },
      { organizationId: "organization_two", tier: "free", status: "active" },
    ]);
    await database.insert(schema.memberFreeCreditClaims).values([
      { memberId: "member_one", organizationId: "organization_one" },
      { memberId: "member_two", organizationId: "organization_two" },
    ]);
    await database.insert(schema.organizationMemberships).values([
      {
        clerkId: "membership_one",
        memberId: "member_one",
        organizationId: "organization_one",
        role: "org:member",
      },
      {
        clerkId: "membership_admin",
        memberId: "member_admin",
        organizationId: "organization_one",
        role: "org:admin",
      },
      {
        clerkId: "membership_two",
        memberId: "member_two",
        organizationId: "organization_two",
        role: "org:member",
      },
    ]);
    await database.insert(schema.profiles).values({
      profileId: "profile_one",
      memberId: "member_owner",
      name: "Profile One",
      githubAccountId: "93001",
      githubLogin: "one",
      eligibilityBasis: "owned_repository",
      adultAttested: true,
      searchable: true,
      searchabilityReason: "member_opt_in",
    });
    await database.insert(schema.profileObservations).values([
      {
        id: "email_observation",
        profileId: "profile_one",
        field: "contact-detail",
        value: { type: "professional-email", value: "alex@example.com" },
        source: "tikhub",
        sourceRecordId: "email_source",
        pipelineVersion: "tikhub-v1",
        confidence: 0.98,
        collectedAt: new Date("2026-08-25T12:00:00Z"),
      },
      {
        id: "phone_observation",
        profileId: "profile_one",
        field: "contact-detail",
        value: {
          type: "direct-professional-phone",
          value: "+57 300 555 1212",
        },
        source: "tikhub",
        sourceRecordId: "phone_source",
        pipelineVersion: "tikhub-v1",
        confidence: 0.94,
        collectedAt: new Date("2026-08-24T12:00:00Z"),
      },
    ]);
    await applyCreditEntry(database, {
      organizationId: "organization_one",
      idempotencyKey: "grant:one",
      kind: "grant",
      amount: 20,
    });
    await applyCreditEntry(database, {
      organizationId: "organization_two",
      idempotencyKey: "grant:two",
      kind: "grant",
      amount: 20,
    });
  };

  it("stores only provider-verified professional Contact Detail Observations", async () => {
    await expect(
      recordVerifiedContactDetail(database, {
        profileId: "profile_one",
        kind: "phone",
        value: "+57 300 555 0100",
        source: "provider",
        sourceRecordId: "switchboard",
        category: "professional",
        verification: "provider-verified",
        direct: false,
        verifiedAt: new Date(),
      }),
    ).rejects.toThrow("contact_detail_not_eligible");

    await expect(
      recordVerifiedContactDetail(database, {
        profileId: "profile_one",
        kind: "email",
        value: "verified@example.com",
        source: "provider",
        sourceRecordId: "verified-email",
        category: "professional",
        verification: "provider-verified",
        verifiedAt: new Date("2026-09-01T00:00:00Z"),
      }),
    ).resolves.toMatchObject({
      field: "contact-detail",
      value: {
        type: "professional-email",
        value: "verified@example.com",
      },
      confidence: 1,
    });
  });

  it("previews masked professional details and charges concurrent reveals once", async () => {
    const previews = await listContactDetails(
      database,
      "member_one",
      "organization_one",
      "profile_one",
    );
    expect(previews).toEqual([
      {
        observationId: "email_observation",
        type: "professional-email",
        maskedValue: "a***@e***.com",
        sourceCategory: "professional-network",
        collectedAt: "2026-08-25T12:00:00.000Z",
        confidence: 0.98,
        price: 5,
        previouslyPurchased: false,
      },
      {
        observationId: "phone_observation",
        type: "direct-professional-phone",
        maskedValue: "+**********12",
        sourceCategory: "professional-network",
        collectedAt: "2026-08-24T12:00:00.000Z",
        confidence: 0.94,
        price: 10,
        previouslyPurchased: false,
      },
    ]);

    const results = await Promise.all([
      purchaseContactReveal(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        profileId: "profile_one",
        type: "professional-email",
        idempotencyKey: "reveal:one",
      }),
      purchaseContactReveal(database, {
        memberId: "member_admin",
        organizationId: "organization_one",
        profileId: "profile_one",
        type: "professional-email",
        idempotencyKey: "reveal:concurrent",
      }),
    ]);
    expect(results.map(({ value }) => value)).toEqual([
      "alex@example.com",
      "alex@example.com",
    ]);
    expect(results.reduce((total, result) => total + result.price, 0)).toBe(5);
    expect(await getCreditBalance(database, "organization_one")).toBe(15);
    expect(
      await database
        .select()
        .from(schema.creditLedgerEntries)
        .where(eq(schema.creditLedgerEntries.kind, "reservation")),
    ).toHaveLength(1);

    const reopened = await listContactDetails(
      database,
      "member_one",
      "organization_one",
      "profile_one",
    );
    expect(reopened[0]).toMatchObject({
      value: "alex@example.com",
      previouslyPurchased: true,
    });
    const isolated = await listContactDetails(
      database,
      "member_two",
      "organization_two",
      "profile_one",
    );
    expect(isolated[0]).not.toHaveProperty("value");
  });

  it("refunds a changed provider value and requires a new purchase", async () => {
    await expect(
      purchaseContactReveal(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        profileId: "profile_one",
        type: "professional-email",
        observationId: "email_observation",
        idempotencyKey: "provider-refresh:old",
      }),
    ).resolves.toMatchObject({
      observationId: "email_observation",
      value: "alex@example.com",
      price: 5,
    });

    const refreshed = await recordVerifiedContactDetail(database, {
      profileId: "profile_one",
      kind: "email",
      value: "alex.new@example.com",
      source: "tikhub",
      sourceRecordId: "email_source",
      category: "professional",
      verification: "provider-verified",
      verifiedAt: new Date("2026-09-03T00:00:00Z"),
    });

    expect(refreshed.id).not.toBe("email_observation");
    expect(refreshed.value).toEqual({
      type: "professional-email",
      value: "alex.new@example.com",
    });
    expect(await getCreditBalance(database, "organization_one")).toBe(20);
    await expect(
      database
        .select({
          sourceRecordId: schema.profileObservations.sourceRecordId,
          staleAt: schema.profileObservations.staleAt,
          value: schema.profileObservations.value,
        })
        .from(schema.profileObservations)
        .where(eq(schema.profileObservations.id, "email_observation")),
    ).resolves.toEqual([
      {
        sourceRecordId: "superseded:email_observation",
        staleAt: new Date("2026-09-03T00:00:00Z"),
        value: { type: "professional-email", value: "alex@example.com" },
      },
    ]);
    await expect(
      database
        .select({ status: schema.contactReveals.status })
        .from(schema.contactReveals),
    ).resolves.toEqual([{ status: "refunded" }]);
    await expect(
      listContactDetails(
        database,
        "member_one",
        "organization_one",
        "profile_one",
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        observationId: refreshed.id,
        maskedValue: "a***@example.com",
        previouslyPurchased: false,
      }),
      expect.objectContaining({ observationId: "phone_observation" }),
    ]);

    await expect(
      purchaseContactReveal(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        profileId: "profile_one",
        type: "professional-email",
        observationId: refreshed.id,
        idempotencyKey: "provider-refresh:new",
      }),
    ).resolves.toMatchObject({
      observationId: refreshed.id,
      value: "alex.new@example.com",
      price: 5,
      previouslyPurchased: false,
    });
    expect(await getCreditBalance(database, "organization_one")).toBe(15);
  });

  it("caps free Organizations at ten daily Contact Reveals and redacts every audit event", async () => {
    await applyCreditEntry(database, {
      organizationId: "organization_one",
      idempotencyKey: "grant:daily-cap",
      kind: "grant",
      amount: 100,
    });
    const profileRows = Array.from({ length: 11 }, (_, index) => ({
      profileId: `daily_profile_${index}`,
      name: `Daily Profile ${index}`,
      githubAccountId: String(95_000 + index),
      githubLogin: `daily-${index}`,
      eligibilityBasis: "owned_repository" as const,
      adultAttested: true,
      searchable: true,
      searchabilityReason: "member_opt_in" as const,
    }));
    await database.insert(schema.profiles).values(profileRows);
    await database.insert(schema.profileObservations).values(
      profileRows.map((profile, index) => ({
        id: `daily_observation_${index}`,
        profileId: profile.profileId,
        field: "contact-detail",
        value: {
          type: "professional-email",
          value: `daily-${index}@private.example`,
        },
        source: "tikhub",
        sourceRecordId: `daily_source_${index}`,
        pipelineVersion: "tikhub-v1",
        confidence: 1,
        collectedAt: new Date(),
      })),
    );

    await purchaseContactReveal(database, {
      memberId: "member_one",
      organizationId: "organization_one",
      profileId: "daily_profile_0",
      type: "professional-email",
      idempotencyKey: "daily_reveal_0",
      apiKeyId: "key_one",
      source: "api",
      correlationId: "correlation_0",
    });
    for (let index = 0; index < 10; index += 1) {
      await expect(
        purchaseContactReveal(database, {
          memberId: "member_one",
          organizationId: "organization_one",
          profileId: "daily_profile_0",
          type: "professional-email",
          idempotencyKey: `daily_reopen_${index}`,
          source: "web",
          correlationId: `correlation_reopen_${index}`,
        }),
      ).resolves.toMatchObject({ previouslyPurchased: true, price: 0 });
    }
    for (let index = 1; index < 10; index += 1) {
      await purchaseContactReveal(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        profileId: `daily_profile_${index}`,
        type: "professional-email",
        idempotencyKey: `daily_reveal_${index}`,
        apiKeyId: "key_one",
        source: "api",
        correlationId: `correlation_${index}`,
      });
    }
    await expect(
      purchaseContactReveal(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        profileId: "daily_profile_10",
        type: "professional-email",
        idempotencyKey: "daily_reveal_10",
        source: "api",
        correlationId: "correlation_10",
      }),
    ).rejects.toMatchObject({ code: "daily_limit" });

    const audit = await database.select().from(schema.securityAuditEvents);
    expect(audit).toHaveLength(21);
    expect(
      audit.find(({ correlationId }) => correlationId === "correlation_10"),
    ).toMatchObject({
      actorMemberId: "member_one",
      organizationId: "organization_one",
      profileId: "daily_profile_10",
      source: "api",
      correlationId: "correlation_10",
      result: "daily_limit",
    });
    expect(JSON.stringify(audit)).not.toContain("@private.example");
  });

  it("rejects insufficient Credits without leaving a purchase or reservation", async () => {
    await expect(
      purchaseContactReveal(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        profileId: "profile_one",
        type: "direct-professional-phone",
        idempotencyKey: "reveal:phone:first",
      }),
    ).resolves.toMatchObject({ price: 10 });
    await expect(
      purchaseContactReveal(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        profileId: "profile_one",
        type: "professional-email",
        idempotencyKey: "reveal:email:first",
      }),
    ).resolves.toMatchObject({ price: 5 });
    await expect(
      purchaseContactReveal(database, {
        memberId: "member_two",
        organizationId: "organization_two",
        profileId: "profile_one",
        type: "direct-professional-phone",
        idempotencyKey: "reveal:phone:two",
      }),
    ).resolves.toMatchObject({ price: 10 });
    await applyCreditEntry(database, {
      organizationId: "organization_two",
      idempotencyKey: "charge:remainder",
      kind: "charge",
      amount: 10,
    });
    await expect(
      purchaseContactReveal(database, {
        memberId: "member_two",
        organizationId: "organization_two",
        profileId: "profile_one",
        type: "professional-email",
        idempotencyKey: "reveal:insufficient",
      }),
    ).rejects.toThrow("insufficient_credits");
    expect(
      await database
        .select()
        .from(schema.contactReveals)
        .where(eq(schema.contactReveals.idempotencyKey, "reveal:insufficient")),
    ).toHaveLength(0);
  });

  it("binds idempotent replay to the originally purchased Observation", async () => {
    const input = {
      memberId: "member_one",
      organizationId: "organization_one",
      profileId: "profile_one",
      type: "professional-email" as const,
      idempotencyKey: "replay:original",
    };
    await expect(purchaseContactReveal(database, input)).resolves.toMatchObject(
      {
        observationId: "email_observation",
        value: "alex@example.com",
        price: 5,
      },
    );
    await database.insert(schema.profileObservations).values({
      id: "new_email_observation",
      profileId: "profile_one",
      field: "contact-detail",
      value: { type: "professional-email", value: "new@example.com" },
      source: "tikhub",
      sourceRecordId: "new_email_source",
      pipelineVersion: "tikhub-v2",
      confidence: 0.99,
      collectedAt: new Date("2026-09-01T12:00:00Z"),
    });
    await expect(purchaseContactReveal(database, input)).resolves.toMatchObject(
      {
        observationId: "email_observation",
        value: "alex@example.com",
        price: 0,
      },
    );
    await expect(
      purchaseContactReveal(database, {
        ...input,
        idempotencyKey: "replay:new-detail",
        observationId: "new_email_observation",
      }),
    ).resolves.toMatchObject({
      observationId: "new_email_observation",
      value: "new@example.com",
      price: 5,
    });
  });

  it("reserves Credits again before retrying a released reveal", async () => {
    await purchaseContactReveal(database, {
      memberId: "member_one",
      organizationId: "organization_one",
      profileId: "profile_one",
      type: "professional-email",
      idempotencyKey: "released:first",
    });
    const [reveal] = await database
      .update(schema.contactReveals)
      .set({ status: "released" })
      .where(eq(schema.contactReveals.idempotencyKey, "released:first"))
      .returning();
    await database
      .update(schema.contactRevealRequests)
      .set({ status: "released" })
      .where(eq(schema.contactRevealRequests.idempotencyKey, "released:first"));
    if (!reveal) throw new Error("Expected released Contact Reveal");
    await applyCreditEntry(database, {
      organizationId: "organization_one",
      idempotencyKey: "released:first:simulated-release",
      kind: "refund",
      amount: 5,
      referenceId: reveal.id,
    });
    await expect(
      purchaseContactReveal(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        profileId: "profile_one",
        type: "professional-email",
        idempotencyKey: "released:retry",
      }),
    ).resolves.toMatchObject({ price: 5, value: "alex@example.com" });
    expect(await getCreditBalance(database, "organization_one")).toBe(15);
    await expect(
      purchaseContactReveal(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        profileId: "profile_one",
        type: "professional-email",
        idempotencyKey: "released:first",
      }),
    ).rejects.toThrow("invalid_contact_detail");
  });

  it("lets admins restrict Member purchases while retaining admin access", async () => {
    await setOrganizationContactRevealPolicy(
      database,
      "member_admin",
      "organization_one",
      false,
    );
    await expect(
      purchaseContactReveal(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        profileId: "profile_one",
        type: "professional-email",
        idempotencyKey: "restricted:member",
      }),
    ).rejects.toThrow("forbidden");
    await expect(
      purchaseContactReveal(database, {
        memberId: "member_admin",
        organizationId: "organization_one",
        profileId: "profile_one",
        type: "professional-email",
        idempotencyKey: "restricted:admin",
      }),
    ).resolves.toMatchObject({ value: "alex@example.com" });
  });

  it("removes purchased access immediately when the controlling Member suppresses a type", async () => {
    await purchaseContactReveal(database, {
      memberId: "member_one",
      organizationId: "organization_one",
      profileId: "profile_one",
      type: "professional-email",
      idempotencyKey: "owner:suppression",
    });
    await setContactDetailSuppression(
      database,
      "member_owner",
      "professional-email",
      true,
    );
    const details = await listContactDetails(
      database,
      "member_one",
      "organization_one",
      "profile_one",
    );
    expect(details.map(({ type }) => type)).toEqual([
      "direct-professional-phone",
    ]);
  });

  it("blocks Contact Details when the Profile has a Suppression Record", async () => {
    await database.insert(schema.suppressionRecords).values({
      canonicalProvider: "github",
      canonicalProviderId: "93001",
      reason: "removal_request",
    });

    await expect(
      listContactDetails(
        database,
        "member_one",
        "organization_one",
        "profile_one",
      ),
    ).rejects.toThrow("not_found");
    await expect(
      purchaseContactReveal(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        profileId: "profile_one",
        type: "professional-email",
        idempotencyKey: "suppressed:profile",
      }),
    ).rejects.toThrow("not_found");
    expect(await getCreditBalance(database, "organization_one")).toBe(20);
  });

  it("retains finalized accounting linkage while purging a suppressed value", async () => {
    const purchase = await purchaseContactReveal(database, {
      memberId: "member_one",
      organizationId: "organization_one",
      profileId: "profile_one",
      type: "professional-email",
      idempotencyKey: "suppression:finalized",
    });
    const [revealBefore] = await database
      .select()
      .from(schema.contactReveals)
      .where(eq(schema.contactReveals.observationId, purchase.observationId));
    if (!revealBefore) throw new Error("Expected finalized Contact Reveal");

    await suppressProviderIdentity(database, {
      canonicalProvider: "github",
      canonicalProviderId: "93001",
      reason: "person_requested_removal",
    });

    await expect(
      database
        .select({ status: schema.contactReveals.status })
        .from(schema.contactReveals)
        .where(eq(schema.contactReveals.id, revealBefore.id)),
    ).resolves.toEqual([{ status: "suppressed" }]);
    await expect(
      database
        .select({ status: schema.contactRevealRequests.status })
        .from(schema.contactRevealRequests)
        .where(eq(schema.contactRevealRequests.revealId, revealBefore.id)),
    ).resolves.toEqual([{ status: "suppressed" }]);
    await expect(
      database
        .select({
          kind: schema.creditLedgerEntries.kind,
          referenceId: schema.creditLedgerEntries.referenceId,
        })
        .from(schema.creditLedgerEntries)
        .where(eq(schema.creditLedgerEntries.referenceId, revealBefore.id)),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "reservation", referenceId: revealBefore.id },
        { kind: "consumption", referenceId: revealBefore.id },
      ]),
    );
    await expect(
      database
        .select({ result: schema.securityAuditEvents.result })
        .from(schema.securityAuditEvents)
        .where(eq(schema.securityAuditEvents.profileId, "profile_one")),
    ).resolves.toEqual([{ result: "finalized" }]);
    await expect(
      database
        .select()
        .from(schema.profileObservations)
        .where(eq(schema.profileObservations.id, purchase.observationId)),
    ).resolves.toEqual([]);
    expect(await getCreditBalance(database, "organization_one")).toBe(15);
  });

  it("does not reopen a purchased value when suppression wins the read race", async () => {
    await purchaseContactReveal(database, {
      memberId: "member_one",
      organizationId: "organization_one",
      profileId: "profile_one",
      type: "professional-email",
      idempotencyKey: "suppression:list-race",
    });
    const readStarted = deferred();
    const resumeRead = deferred();
    const transaction = database.transaction.bind(database);
    const interruptedDatabase = new Proxy(database, {
      get(target, property) {
        if (property === "transaction")
          return async (...input: Parameters<typeof database.transaction>) => {
            readStarted.resolve();
            await resumeRead.promise;
            return transaction(...input);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const details = listContactDetails(
      interruptedDatabase,
      "member_one",
      "organization_one",
      "profile_one",
    );
    await readStarted.promise;
    try {
      await suppressProviderIdentity(database, {
        canonicalProvider: "github",
        canonicalProviderId: "93001",
        reason: "person_requested_removal",
      });
    } finally {
      resumeRead.resolve();
    }

    await expect(details).rejects.toMatchObject({ code: "not_found" });
  });

  it("releases a reservation when removal wins before final disclosure", async () => {
    const phaseOneCommitted = deferred();
    const resumePurchase = deferred();
    const transaction = database.transaction.bind(database);
    let transactionCount = 0;
    const interruptedDatabase = new Proxy(database, {
      get(target, property) {
        if (property === "transaction")
          return async (...input: Parameters<typeof database.transaction>) => {
            const result = await transaction(...input);
            transactionCount += 1;
            if (transactionCount === 1) {
              phaseOneCommitted.resolve();
              await resumePurchase.promise;
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const purchase = purchaseContactReveal(interruptedDatabase, {
      memberId: "member_one",
      organizationId: "organization_one",
      profileId: "profile_one",
      type: "professional-email",
      idempotencyKey: "suppression:reserved-race",
    });
    await phaseOneCommitted.promise;
    try {
      await suppressProviderIdentity(database, {
        canonicalProvider: "github",
        canonicalProviderId: "93001",
        reason: "person_requested_removal",
      });
    } finally {
      resumePurchase.resolve();
    }

    await expect(purchase).rejects.toMatchObject({ code: "not_found" });
    const [reveal] = await database.select().from(schema.contactReveals);
    if (!reveal) throw new Error("Expected released Contact Reveal");
    expect(reveal).toMatchObject({ status: "released" });
    await expect(
      database.select().from(schema.contactRevealRequests),
    ).resolves.toEqual([expect.objectContaining({ status: "released" })]);
    await expect(
      database
        .select({
          kind: schema.creditLedgerEntries.kind,
          referenceId: schema.creditLedgerEntries.referenceId,
        })
        .from(schema.creditLedgerEntries)
        .where(eq(schema.creditLedgerEntries.referenceId, reveal.id)),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "reservation", referenceId: reveal.id },
        { kind: "release", referenceId: reveal.id },
      ]),
    );
    expect(await getCreditBalance(database, "organization_one")).toBe(20);
  });

  it("does not disclose a reserved value after a verified public request disputes it", async () => {
    const phaseOneCommitted = deferred();
    const resumePurchase = deferred();
    const transaction = database.transaction.bind(database);
    let transactionCount = 0;
    const interruptedDatabase = new Proxy(database, {
      get(target, property) {
        if (property === "transaction")
          return async (...input: Parameters<typeof database.transaction>) => {
            const result = await transaction(...input);
            transactionCount += 1;
            if (transactionCount === 1) {
              phaseOneCommitted.resolve();
              await resumePurchase.promise;
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const purchase = purchaseContactReveal(interruptedDatabase, {
      memberId: "member_one",
      organizationId: "organization_one",
      profileId: "profile_one",
      type: "professional-email",
      idempotencyKey: "dispute:reserved-race",
    });
    await phaseOneCommitted.promise;
    try {
      const request = await submitPublicProfileRequest(database, {
        profileId: "profile_one",
        kind: "removal",
        requesterEmail: "represented-person@example.com",
        details: "Dispute this Profile immediately",
      });
      await verifyProfileRequest(database, request.id, {
        operatorId: "operator-contact-dispute",
        correlationId: "contact-dispute-verification",
        reason: "Representative control verified",
        verificationMethod: "signed-github-proof",
        evidenceReference: "evidence://profile-request/contact-dispute",
      });
    } finally {
      resumePurchase.resolve();
    }

    await expect(purchase).rejects.toMatchObject({ code: "not_found" });
    const [reveal] = await database.select().from(schema.contactReveals);
    expect(reveal).toMatchObject({ status: "released" });
    await expect(
      database.select().from(schema.contactRevealRequests),
    ).resolves.toEqual([expect.objectContaining({ status: "released" })]);
    expect(await getCreditBalance(database, "organization_one")).toBe(20);
  });

  it("releases a reservation when the Observation becomes stale before disclosure", async () => {
    const phaseOneCommitted = deferred();
    const resumePurchase = deferred();
    const transaction = database.transaction.bind(database);
    let transactionCount = 0;
    const interruptedDatabase = new Proxy(database, {
      get(target, property) {
        if (property === "transaction")
          return async (...input: Parameters<typeof database.transaction>) => {
            const result = await transaction(...input);
            transactionCount += 1;
            if (transactionCount === 1) {
              phaseOneCommitted.resolve();
              await resumePurchase.promise;
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const purchase = purchaseContactReveal(interruptedDatabase, {
      memberId: "member_one",
      organizationId: "organization_one",
      profileId: "profile_one",
      type: "professional-email",
      observationId: "email_observation",
      idempotencyKey: "stale:reserved-race",
    });
    await phaseOneCommitted.promise;
    try {
      await database
        .update(schema.profileObservations)
        .set({ staleAt: new Date("2026-09-03T00:00:00Z") })
        .where(eq(schema.profileObservations.id, "email_observation"));
    } finally {
      resumePurchase.resolve();
    }

    await expect(purchase).rejects.toMatchObject({
      code: "invalid_contact_detail",
    });
    await expect(
      database
        .select({ status: schema.contactReveals.status })
        .from(schema.contactReveals),
    ).resolves.toEqual([{ status: "released" }]);
    await expect(
      database
        .select({ status: schema.contactRevealRequests.status })
        .from(schema.contactRevealRequests),
    ).resolves.toEqual([{ status: "released" }]);
    expect(await getCreditBalance(database, "organization_one")).toBe(20);
  });

  it("suppresses invalid details, refunds every purchaser once, and queues re-enrichment", async () => {
    await purchaseContactReveal(database, {
      memberId: "member_one",
      organizationId: "organization_one",
      profileId: "profile_one",
      type: "professional-email",
      idempotencyKey: "invalid:one",
    });
    await purchaseContactReveal(database, {
      memberId: "member_two",
      organizationId: "organization_two",
      profileId: "profile_one",
      type: "professional-email",
      idempotencyKey: "invalid:two",
    });
    await expect(
      reportInvalidContactDetail(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        observationId: "email_observation",
        reason: "wrong-phone",
      }),
    ).rejects.toThrow("invalid_contact_detail");
    expect(
      await reportInvalidContactDetail(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        observationId: "email_observation",
        reason: "bounced-email",
      }),
    ).toEqual({ refunded: true });
    expect(
      await reportInvalidContactDetail(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        observationId: "email_observation",
        reason: "bounced-email",
      }),
    ).toEqual({ refunded: false });
    expect(await getCreditBalance(database, "organization_one")).toBe(20);
    expect(await getCreditBalance(database, "organization_two")).toBe(20);
    expect(
      await database.select().from(schema.reenrichmentOutbox),
    ).toHaveLength(1);
    expect(
      await database
        .select()
        .from(schema.creditLedgerEntries)
        .where(eq(schema.creditLedgerEntries.kind, "refund")),
    ).toHaveLength(2);
    expect(
      await listContactDetails(
        database,
        "member_one",
        "organization_one",
        "profile_one",
      ),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ observationId: "email_observation" }),
      ]),
    );
  });

  it("never lists or sells stale Contact Detail Observations", async () => {
    await database
      .update(schema.profileObservations)
      .set({ staleAt: new Date("2026-09-03T00:00:00Z") })
      .where(eq(schema.profileObservations.id, "email_observation"));

    await expect(
      listContactDetails(
        database,
        "member_one",
        "organization_one",
        "profile_one",
      ),
    ).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ observationId: "email_observation" }),
      ]),
    );
    await expect(
      purchaseContactReveal(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        profileId: "profile_one",
        type: "professional-email",
        observationId: "email_observation",
        idempotencyKey: "stale-contact-detail",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await getCreditBalance(database, "organization_one")).toBe(20);
  });

  it("refunds stale Contact Details when a verified LinkedIn identity changes", async () => {
    await purchaseContactReveal(database, {
      memberId: "member_one",
      organizationId: "organization_one",
      profileId: "profile_one",
      type: "professional-email",
      idempotencyKey: "linkedin-change:one",
    });
    await purchaseContactReveal(database, {
      memberId: "member_two",
      organizationId: "organization_two",
      profileId: "profile_one",
      type: "professional-email",
      idempotencyKey: "linkedin-change:two",
    });
    await database.insert(schema.professionalLinks).values({
      profileId: "profile_one",
      url: "https://linkedin.com/in/old-person",
      source: "member",
      sourceRecordId: "member_owner",
    });

    await editControlledProfile(database, {
      memberId: "member_owner",
      name: "Profile One",
      currentCompany: null,
      professionalLinks: ["https://linkedin.com/in/new-person"],
      canonicalIdentityVerification: {
        linkedIn: {
          username: "new-person",
          providerUserId: "linkedin-person-1",
        },
      },
    });

    expect(await getCreditBalance(database, "organization_one")).toBe(20);
    expect(await getCreditBalance(database, "organization_two")).toBe(20);
    await expect(
      database
        .select({ status: schema.contactReveals.status })
        .from(schema.contactReveals),
    ).resolves.toEqual([{ status: "refunded" }, { status: "refunded" }]);
    await expect(
      database.select().from(schema.contactDetailInvalidations),
    ).resolves.toEqual([
      expect.objectContaining({
        observationId: "email_observation",
        reason: "linkedin_professional_link_changed",
      }),
      expect.objectContaining({
        observationId: "phone_observation",
        reason: "linkedin_professional_link_changed",
      }),
    ]);
    await expect(
      database.select().from(schema.reenrichmentOutbox),
    ).resolves.toHaveLength(2);
    await expect(
      database.select().from(schema.enrichmentDispatches),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: "tikhub",
        state: "pending",
        payload: expect.objectContaining({
          profileId: "profile_one",
          linkedInUrl: "https://linkedin.com/in/new-person",
        }),
      }),
    ]);
  });

  it("refunds every purchaser when a verified correction invalidates a Contact Detail", async () => {
    await purchaseContactReveal(database, {
      memberId: "member_one",
      organizationId: "organization_one",
      profileId: "profile_one",
      type: "professional-email",
      idempotencyKey: "correction:one",
    });
    await purchaseContactReveal(database, {
      memberId: "member_two",
      organizationId: "organization_two",
      profileId: "profile_one",
      type: "professional-email",
      idempotencyKey: "correction:two",
    });
    const request = await submitPublicProfileRequest(database, {
      profileId: "profile_one",
      kind: "correction",
      requesterEmail: "represented-person@example.com",
      details: "This professional email belongs to someone else",
    });
    await verifyProfileRequest(database, request.id, {
      operatorId: "member_one",
      correlationId: "contact-correction-verification",
      reason: "Representative control verified",
      verificationMethod: "signed-github-proof",
      evidenceReference: "evidence://profile-request/contact-correction",
    });
    await reviewProfileRequest(database, request.id, true, {
      operatorId: "member_one",
      correlationId: "contact-correction-review",
      reason: "Representative confirmed the Contact Detail is invalid",
      correction: {
        invalidContactObservationIds: ["email_observation"],
      },
    });

    expect(await getCreditBalance(database, "organization_one")).toBe(20);
    expect(await getCreditBalance(database, "organization_two")).toBe(20);
    await expect(
      database
        .select({ status: schema.contactReveals.status })
        .from(schema.contactReveals),
    ).resolves.toEqual([{ status: "refunded" }, { status: "refunded" }]);
    await expect(
      database.select().from(schema.contactDetailInvalidations),
    ).resolves.toEqual([
      expect.objectContaining({
        observationId: "email_observation",
        reason: "profile-correction",
      }),
    ]);
    await expect(
      database.select().from(schema.reenrichmentOutbox),
    ).resolves.toEqual([
      expect.objectContaining({ observationId: "email_observation" }),
    ]);
  });

  it("never includes Contact Detail values in structured log fields", () => {
    const serialized = JSON.stringify(
      contactRevealLogFields({
        memberId: "member_one",
        organizationId: "organization_one",
        profileId: "profile_one",
        observationId: "email_observation",
        type: "professional-email",
        result: "finalized",
      }),
    );
    expect(serialized).not.toContain("alex@example.com");
    expect(serialized).not.toContain("a***@e***.com");
    expect(serialized).not.toContain("+57 300 555 1212");
  });
});
