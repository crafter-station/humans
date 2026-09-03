import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AbuseControlError,
  activateOrganizationEntitlement,
  assertPrincipalActive,
  organizationRevealLimit,
  recordSecurityActivity,
  revokeSuspension,
  setPolarSubscriptionStatus,
  suspendPrincipal,
} from "../src/abuse-controls";
import { getOrganizationBillingOverview } from "../src/billing";
import { applyCreditEntry, reserveCredit } from "../src/credits";
import * as schema from "../src/schema";

describe("abuse controls", () => {
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
    await database.delete(schema.creditLedgerEntries);
    await database.delete(schema.creditAccounts);
    await database.delete(schema.memberFreeCreditClaims);
    await database.delete(schema.polarWebhookEvents);
    await database.delete(schema.polarCustomers);
    await database.delete(schema.organizationEntitlements);
    await database.delete(schema.organizationMemberships);
    await database.delete(schema.organizations);
    await database.delete(schema.members);
    await database
      .insert(schema.members)
      .values([{ clerkId: "member_one" }, { clerkId: "member_two" }]);
    await database.insert(schema.organizations).values([
      { clerkId: "organization_one", name: "One" },
      { clerkId: "organization_two", name: "Two" },
      { clerkId: "organization_three", name: "Three" },
      { clerkId: "organization_four", name: "Four" },
    ]);
    await database.insert(schema.organizationMemberships).values([
      ...["one", "two", "three", "four"].map((suffix) => ({
        clerkId: `membership_${suffix}`,
        memberId: "member_one",
        organizationId: `organization_${suffix}`,
        role: "org:admin",
      })),
      {
        clerkId: "membership_member_two",
        memberId: "member_two",
        organizationId: "organization_one",
        role: "org:member",
      },
    ]);
  });

  afterAll(async () => {
    await resources.pool?.end();
    await resources.container?.stop();
  });

  it("activates one verified free Credit-bearing Organization per Member", async () => {
    await applyCreditEntry(database, {
      organizationId: "organization_one",
      idempotencyKey: "premature-grant",
      kind: "grant",
      amount: 100,
    });
    await expect(
      database.transaction((tx) =>
        reserveCredit(tx, {
          organizationId: "organization_one",
          amount: 1,
          referenceId: "profile-search:fingerprint",
          idempotencyKey: "premature-search",
          reservationKey: "idempotency-key",
        }),
      ),
    ).rejects.toMatchObject({ code: "credits_unavailable" });
    await expect(
      activateOrganizationEntitlement(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        emailVerified: false,
        botProtectionVerified: true,
      }),
    ).rejects.toMatchObject({ code: "verification_required" });

    await expect(
      activateOrganizationEntitlement(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        emailVerified: true,
        botProtectionVerified: true,
      }),
    ).resolves.toEqual({ tier: "free", status: "active" });
    const [freeAccount] = await database
      .select()
      .from(schema.creditAccounts)
      .where(eq(schema.creditAccounts.organizationId, "organization_one"));
    expect(freeAccount?.balance).toBe(100);
    await expect(
      activateOrganizationEntitlement(database, {
        memberId: "member_two",
        organizationId: "organization_one",
        emailVerified: true,
        botProtectionVerified: true,
      }),
    ).resolves.toEqual({ tier: "free", status: "active" });
    const freeClaims = await database
      .select()
      .from(schema.memberFreeCreditClaims);
    expect(freeClaims).toHaveLength(1);

    await expect(
      activateOrganizationEntitlement(database, {
        memberId: "member_one",
        organizationId: "organization_two",
        emailVerified: true,
        botProtectionVerified: true,
      }),
    ).resolves.toEqual({ tier: "free", status: "inactive" });
    await expect(
      getOrganizationBillingOverview(database, "organization_two"),
    ).resolves.toMatchObject({
      plan: "free",
      availableCredits: 0,
      status: "inactive",
      chargeable: false,
    });

    await setPolarSubscriptionStatus(database, {
      organizationId: "organization_two",
      polarSubscriptionId: "polar_subscription_one",
      polarCustomerId: "polar_customer_one",
      status: "active",
      eventType: "order.paid",
      eventId: "polar_event_one",
      occurredAt: new Date("2026-09-02T00:00:00Z"),
      periodStart: new Date("2026-09-01T00:00:00Z"),
      periodEnd: new Date("2026-10-01T00:00:00Z"),
      cancelAtPeriodEnd: false,
      now: new Date("2026-09-02T00:00:00Z"),
    });
    await expect(
      database
        .select({
          tier: schema.organizationEntitlements.tier,
          status: schema.organizationEntitlements.status,
        })
        .from(schema.organizationEntitlements)
        .where(
          eq(
            schema.organizationEntitlements.organizationId,
            "organization_two",
          ),
        ),
    ).resolves.toEqual([{ tier: "pro", status: "active" }]);
    await expect(
      activateOrganizationEntitlement(database, {
        memberId: "member_one",
        organizationId: "organization_two",
        emailVerified: true,
        botProtectionVerified: true,
      }),
    ).resolves.toEqual({ tier: "pro", status: "active" });
    await expect(
      organizationRevealLimit(database, "organization_two"),
    ).resolves.toBe(100);
    await setPolarSubscriptionStatus(database, {
      organizationId: "organization_two",
      polarSubscriptionId: "polar_subscription_one",
      polarCustomerId: "polar_customer_one",
      status: "unpaid",
      eventType: "subscription.revoked",
      eventId: "polar_event_newer",
      occurredAt: new Date("2026-09-03T00:00:00Z"),
      periodStart: new Date("2026-09-01T00:00:00Z"),
      periodEnd: new Date("2026-10-01T00:00:00Z"),
      cancelAtPeriodEnd: false,
      now: new Date("2026-09-03T00:00:00Z"),
    });
    await setPolarSubscriptionStatus(database, {
      organizationId: "organization_two",
      polarSubscriptionId: "polar_subscription_one",
      polarCustomerId: "polar_customer_one",
      status: "active",
      eventType: "subscription.updated",
      eventId: "polar_event_delayed",
      occurredAt: new Date("2026-09-02T12:00:00Z"),
      periodStart: new Date("2026-09-01T00:00:00Z"),
      periodEnd: new Date("2026-10-01T00:00:00Z"),
      cancelAtPeriodEnd: false,
      now: new Date("2026-09-03T00:00:00Z"),
    });
    const [orderedEntitlement] = await database
      .select()
      .from(schema.organizationEntitlements)
      .where(
        eq(schema.organizationEntitlements.organizationId, "organization_two"),
      );
    expect(orderedEntitlement).toMatchObject({
      status: "blocked",
      polarStatus: "unpaid",
      pendingFreeAtPeriodEnd: false,
    });
    await expect(
      organizationRevealLimit(database, "organization_one"),
    ).resolves.toBe(10);
    await expect(
      organizationRevealLimit(database, "organization_two"),
    ).resolves.toBe(10);
  });

  it("suspends shared keys and rapidly churning Members automatically", async () => {
    for (let index = 0; index < 6; index += 1) {
      await recordSecurityActivity(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        apiKeyId: "key_one",
        ipHash: `ip_${index}`,
        source: "api",
        kind: "profile_read",
      });
    }
    await expect(
      assertPrincipalActive(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        apiKeyId: "key_one",
      }),
    ).rejects.toBeInstanceOf(AbuseControlError);

    for (const suffix of ["one", "two", "three", "four"]) {
      await recordSecurityActivity(database, {
        memberId: "member_one",
        organizationId: `organization_${suffix}`,
        ipHash: "member_ip",
        source: "web",
        kind: "organization_access",
      });
    }
    await expect(
      assertPrincipalActive(database, {
        memberId: "member_one",
        organizationId: "organization_one",
      }),
    ).rejects.toMatchObject({ code: "suspended" });
  });

  it("applies and revokes an Operator suspension immediately", async () => {
    const suspension = await suspendPrincipal(database, {
      principalType: "organization",
      principalId: "organization_one",
      reason: "operator_review",
      suspendedBy: "operator_one",
    });
    expect(suspension).not.toBeNull();
    if (!suspension) throw new Error("Expected suspension");
    await expect(
      assertPrincipalActive(database, {
        memberId: "member_one",
        organizationId: "organization_one",
      }),
    ).rejects.toMatchObject({ code: "suspended" });

    await revokeSuspension(database, suspension.id);
    await expect(
      assertPrincipalActive(database, {
        memberId: "member_one",
        organizationId: "organization_one",
      }),
    ).resolves.toBeUndefined();
  });

  it("isolates traversal detection to the Member that changed filters", async () => {
    for (let index = 0; index < 20; index += 1) {
      await recordSecurityActivity(database, {
        memberId: "member_one",
        organizationId: "organization_one",
        ipHash: "member_one_ip",
        source: "web",
        kind: "search",
        fingerprint: `member_one_filter_${index}`,
      });
    }
    await recordSecurityActivity(database, {
      memberId: "member_two",
      organizationId: "organization_one",
      ipHash: "member_two_ip",
      source: "web",
      kind: "search",
      fingerprint: "member_two_filter",
    });
    await expect(
      assertPrincipalActive(database, {
        memberId: "member_two",
        organizationId: "organization_one",
      }),
    ).resolves.toBeUndefined();

    await recordSecurityActivity(database, {
      memberId: "member_one",
      organizationId: "organization_one",
      ipHash: "member_one_ip",
      source: "web",
      kind: "search",
      fingerprint: "member_one_filter_20",
    });
    await expect(
      assertPrincipalActive(database, {
        memberId: "member_one",
        organizationId: "organization_one",
      }),
    ).rejects.toMatchObject({ code: "suspended" });
  });
});
