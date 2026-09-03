import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { activateOrganizationEntitlement } from "../src/abuse-controls";
import {
  claimCreditUsage,
  listCreditUsageDeadLetters,
  markCreditUsageDelivered,
  type PolarSubscriptionProjection,
  projectPolarSubscriptionEvent,
  reconcileCreditPeriodPage,
  reconcileCreditUsage,
  recordPolarCustomer,
  redriveCreditUsage,
  releaseCreditUsage,
} from "../src/billing";
import {
  applyCreditEntry,
  finalizeCreditReservation,
  getCreditBalance,
  releaseCreditReservation,
  reserveCredit,
  rolloverCreditPeriodInTransaction,
} from "../src/credits";
import { adjustCreditsAsOperator } from "../src/operations";
import * as schema from "../src/schema";

const PERIOD_START = new Date("2026-09-01T00:00:00Z");
const PERIOD_END = new Date("2026-10-01T00:00:00Z");
const NOW = new Date("2026-09-03T00:00:00Z");

const billingEvent = (
  overrides: Partial<PolarSubscriptionProjection> = {},
): PolarSubscriptionProjection => ({
  eventId: "event_active",
  eventType: "subscription.active",
  occurredAt: new Date("2026-09-02T00:00:00Z"),
  organizationId: "organization_one",
  polarCustomerId: "customer_one",
  polarSubscriptionId: "subscription_one",
  status: "active",
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  cancelAtPeriodEnd: false,
  now: NOW,
  ...overrides,
});

describe("Polar billing and Credit periods", () => {
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
    await database.delete(schema.creditUsageOutbox);
    await database.delete(schema.creditLedgerEntries);
    await database.delete(schema.creditAccounts);
    await database.delete(schema.creditReconciliations);
    await database.delete(schema.polarWebhookEvents);
    await database.delete(schema.polarCustomers);
    await database.delete(schema.organizationEntitlements);
    await database.delete(schema.memberFreeCreditClaims);
    await database.delete(schema.organizationMemberships);
    await database.delete(schema.organizations);
    await database.delete(schema.members);
  });

  afterAll(async () => {
    await resources.pool?.end();
    await resources.container?.stop();
  });

  const seedOrganizations = async (...organizationIds: string[]) => {
    await database.insert(schema.organizations).values(
      organizationIds.map((clerkId) => ({
        clerkId,
        name: clerkId,
      })),
    );
  };

  it("requires order.paid, applies it once under concurrency, and orders delayed events", async () => {
    await seedOrganizations("organization_one");

    await expect(
      projectPolarSubscriptionEvent(database, billingEvent()),
    ).resolves.toEqual({ processed: true, applied: true });
    expect(await getCreditBalance(database, "organization_one")).toBe(0);
    const [pending] = await database
      .select()
      .from(schema.organizationEntitlements);
    expect(pending).toMatchObject({
      tier: "pro",
      status: "payment_pending",
      polarStatus: "active",
      periodStart: null,
      periodEnd: null,
    });

    await expect(
      database.transaction((tx) =>
        reserveCredit(tx, {
          organizationId: "organization_one",
          amount: 1,
          referenceId: "search:before-payment",
          idempotencyKey: "search:before-payment",
          reservationKey: "idempotency-key",
          now: NOW,
        }),
      ),
    ).rejects.toMatchObject({ code: "credits_unavailable" });

    const paid = billingEvent({
      eventId: "event_paid",
      eventType: "order.paid",
      occurredAt: new Date("2026-09-01T12:00:00Z"),
    });
    const concurrent = await Promise.all([
      projectPolarSubscriptionEvent(database, paid),
      projectPolarSubscriptionEvent(database, paid),
    ]);
    expect(concurrent.filter(({ processed }) => processed)).toHaveLength(1);
    expect(concurrent.every(({ applied }) => applied)).toBe(true);
    expect(await getCreditBalance(database, "organization_one")).toBe(1_000);

    await projectPolarSubscriptionEvent(
      database,
      billingEvent({
        eventId: "event_paused",
        eventType: "subscription.paused",
        status: "paused",
        occurredAt: new Date("2026-09-04T00:00:00Z"),
        now: new Date("2026-09-04T00:00:00Z"),
      }),
    );
    await projectPolarSubscriptionEvent(
      database,
      billingEvent({
        eventId: "event_delayed_active",
        eventType: "subscription.updated",
        occurredAt: new Date("2026-09-03T12:00:00Z"),
        now: new Date("2026-09-04T00:00:00Z"),
      }),
    );
    const [blocked] = await database
      .select()
      .from(schema.organizationEntitlements);
    expect(blocked).toMatchObject({
      status: "blocked",
      polarStatus: "paused",
      polarEventId: "event_paused",
    });
    expect(await getCreditBalance(database, "organization_one")).toBe(1_000);
    await expect(
      database.transaction((tx) =>
        reserveCredit(tx, {
          organizationId: "organization_one",
          amount: 1,
          referenceId: "search:paused",
          idempotencyKey: "search:paused",
          reservationKey: "idempotency-key",
          now: new Date("2026-09-04T00:00:00Z"),
        }),
      ),
    ).rejects.toMatchObject({ code: "credits_unavailable" });

    await projectPolarSubscriptionEvent(
      database,
      billingEvent({
        eventId: "event_resumed",
        eventType: "subscription.resumed",
        occurredAt: new Date("2026-09-05T00:00:00Z"),
        now: new Date("2026-09-05T00:00:00Z"),
      }),
    );
    await projectPolarSubscriptionEvent(
      database,
      billingEvent({
        eventId: "event_revoked",
        eventType: "subscription.revoked",
        status: "active",
        occurredAt: new Date("2026-09-06T00:00:00Z"),
        now: new Date("2026-09-06T00:00:00Z"),
      }),
    );
    const [revoked] = await database
      .select()
      .from(schema.organizationEntitlements);
    expect(revoked).toMatchObject({
      status: "blocked",
      polarEventId: "event_revoked",
    });
  });

  it("serializes one free grant when a Member activates two Organizations", async () => {
    await database.insert(schema.members).values({ clerkId: "member_one" });
    await seedOrganizations("organization_one", "organization_two");
    await database.insert(schema.organizationMemberships).values([
      {
        clerkId: "membership_one",
        memberId: "member_one",
        organizationId: "organization_one",
        role: "org:admin",
      },
      {
        clerkId: "membership_two",
        memberId: "member_one",
        organizationId: "organization_two",
        role: "org:admin",
      },
    ]);

    const activations = await Promise.allSettled(
      ["organization_one", "organization_two"].map((organizationId) =>
        activateOrganizationEntitlement(database, {
          memberId: "member_one",
          organizationId,
          emailVerified: true,
          botProtectionVerified: true,
          now: NOW,
        }),
      ),
    );
    expect(activations).toEqual(
      expect.arrayContaining([
        { status: "fulfilled", value: { tier: "free", status: "active" } },
        { status: "fulfilled", value: { tier: "free", status: "inactive" } },
      ]),
    );
    expect(
      await database.select().from(schema.memberFreeCreditClaims),
    ).toHaveLength(1);
    const accounts = await database.select().from(schema.creditAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.balance).toBe(100);
  });

  it("expires the old balance and grants exactly 1,000 Credits on paid renewal", async () => {
    await seedOrganizations("organization_one");
    await projectPolarSubscriptionEvent(
      database,
      billingEvent({ eventId: "paid_first", eventType: "order.paid" }),
    );
    await applyCreditEntry(database, {
      organizationId: "organization_one",
      idempotencyKey: "usage:first-period",
      kind: "charge",
      amount: 125,
      referenceId: "search:first-period",
      now: NOW,
    });
    expect(await getCreditBalance(database, "organization_one")).toBe(875);

    const secondPeriodStart = PERIOD_END;
    const secondPeriodEnd = new Date("2026-11-01T00:00:00Z");
    await projectPolarSubscriptionEvent(
      database,
      billingEvent({
        eventId: "paid_renewal",
        eventType: "order.paid",
        occurredAt: secondPeriodStart,
        periodStart: secondPeriodStart,
        periodEnd: secondPeriodEnd,
        now: secondPeriodStart,
      }),
    );
    expect(await getCreditBalance(database, "organization_one")).toBe(1_000);

    const ledger = await database
      .select()
      .from(schema.creditLedgerEntries)
      .where(eq(schema.creditLedgerEntries.organizationId, "organization_one"));
    expect(ledger.filter(({ kind }) => kind === "grant")).toHaveLength(2);
    expect(ledger.filter(({ kind }) => kind === "expiration")).toEqual([
      expect.objectContaining({ amount: -875 }),
    ]);

    await database.transaction((tx) =>
      rolloverCreditPeriodInTransaction(
        tx,
        "organization_one",
        secondPeriodEnd,
      ),
    );
    const [awaitingRenewal] = await database
      .select()
      .from(schema.organizationEntitlements);
    expect(awaitingRenewal?.status).toBe("payment_pending");
    expect(await getCreditBalance(database, "organization_one")).toBe(0);
  });

  it("blocks payment failures and downgrades only an Organization with a free claim", async () => {
    await database.insert(schema.members).values({ clerkId: "member_one" });
    await seedOrganizations("organization_free", "organization_paid_only");
    await database.insert(schema.organizationMemberships).values([
      {
        clerkId: "membership_free",
        memberId: "member_one",
        organizationId: "organization_free",
        role: "org:admin",
      },
      {
        clerkId: "membership_paid_only",
        memberId: "member_one",
        organizationId: "organization_paid_only",
        role: "org:admin",
      },
    ]);
    await activateOrganizationEntitlement(database, {
      memberId: "member_one",
      organizationId: "organization_free",
      emailVerified: true,
      botProtectionVerified: true,
      now: new Date("2026-08-01T00:00:00Z"),
    });

    for (const [organizationId, suffix] of [
      ["organization_free", "free"],
      ["organization_paid_only", "paid"],
    ] as const) {
      await projectPolarSubscriptionEvent(
        database,
        billingEvent({
          eventId: `paid_${suffix}`,
          eventType: "order.paid",
          organizationId,
          polarCustomerId: `customer_${suffix}`,
          polarSubscriptionId: `subscription_${suffix}`,
        }),
      );
      await projectPolarSubscriptionEvent(
        database,
        billingEvent({
          eventId: `past_due_${suffix}`,
          eventType: "subscription.past_due",
          organizationId,
          polarCustomerId: `customer_${suffix}`,
          polarSubscriptionId: `subscription_${suffix}`,
          status: "past_due",
          occurredAt: new Date("2026-09-10T00:00:00Z"),
          now: new Date("2026-09-10T00:00:00Z"),
        }),
      );
    }

    const graceReservation = {
      organizationId: "organization_paid_only",
      amount: 1,
      referenceId: "search:past-due-grace",
      idempotencyKey: "search:past-due-grace",
      reservationKey: "idempotency-key" as const,
      now: new Date("2026-09-10T00:00:00Z"),
    };
    await database.transaction((tx) => reserveCredit(tx, graceReservation));
    await database.transaction((tx) =>
      releaseCreditReservation(tx, graceReservation),
    );

    for (const organizationId of [
      "organization_free",
      "organization_paid_only",
    ]) {
      await database.transaction((tx) =>
        rolloverCreditPeriodInTransaction(tx, organizationId, PERIOD_END),
      );
    }
    const entitlements = await database
      .select()
      .from(schema.organizationEntitlements);
    expect(
      entitlements.find(
        ({ organizationId }) => organizationId === "organization_free",
      ),
    ).toMatchObject({ tier: "free", status: "active" });
    expect(await getCreditBalance(database, "organization_free")).toBe(100);
    expect(
      entitlements.find(
        ({ organizationId }) => organizationId === "organization_paid_only",
      ),
    ).toMatchObject({ tier: "pro", status: "blocked" });
    expect(await getCreditBalance(database, "organization_paid_only")).toBe(0);
    await expect(
      activateOrganizationEntitlement(database, {
        memberId: "member_one",
        organizationId: "organization_paid_only",
        emailVerified: true,
        botProtectionVerified: true,
        now: PERIOD_END,
      }),
    ).resolves.toEqual({ tier: "pro", status: "blocked" });
  });

  it("rejects duplicate Customer and subscription mappings without poisoning recovery", async () => {
    await seedOrganizations(
      "organization_one",
      "organization_two",
      "organization_three",
    );
    await projectPolarSubscriptionEvent(database, billingEvent());
    await expect(
      projectPolarSubscriptionEvent(
        database,
        billingEvent({ status: "paused" }),
      ),
    ).rejects.toMatchObject({ code: "billing_event_conflict" });

    await expect(
      projectPolarSubscriptionEvent(
        database,
        billingEvent({
          eventId: "customer_conflict",
          organizationId: "organization_two",
          polarSubscriptionId: "subscription_two",
        }),
      ),
    ).rejects.toMatchObject({ code: "billing_customer_conflict" });
    await expect(
      projectPolarSubscriptionEvent(
        database,
        billingEvent({
          eventId: "subscription_conflict",
          organizationId: "organization_two",
          polarCustomerId: "customer_two",
        }),
      ),
    ).rejects.toMatchObject({ code: "billing_subscription_conflict" });

    await expect(
      projectPolarSubscriptionEvent(
        database,
        billingEvent({
          eventId: "mapping_recovered",
          organizationId: "organization_two",
          polarCustomerId: "customer_two",
          polarSubscriptionId: "subscription_two",
        }),
      ),
    ).resolves.toEqual({ processed: true, applied: true });
    await expect(
      recordPolarCustomer(database, {
        organizationId: "organization_three",
        polarCustomerId: "customer_two",
      }),
    ).rejects.toMatchObject({ code: "billing_customer_conflict" });
    await expect(
      recordPolarCustomer(database, {
        organizationId: "organization_three",
        polarCustomerId: "customer_three",
      }),
    ).resolves.toMatchObject({
      organizationId: "organization_three",
      polarCustomerId: "customer_three",
    });

    await expect(
      projectPolarSubscriptionEvent(
        database,
        billingEvent({ organizationId: "organization_two" }),
      ),
    ).rejects.toMatchObject({ code: "billing_customer_conflict" });
  });

  it("fails legacy Pro closed and repairs it only with a paid period", async () => {
    await seedOrganizations("organization_one");
    await database.insert(schema.organizationEntitlements).values({
      organizationId: "organization_one",
      tier: "pro",
      status: "active",
      polarSubscriptionId: "subscription_one",
      polarStatus: "active",
    });
    await applyCreditEntry(database, {
      organizationId: "organization_one",
      idempotencyKey: "legacy-pro-balance",
      kind: "grant",
      amount: 50,
    });

    await database.transaction((tx) =>
      rolloverCreditPeriodInTransaction(tx, "organization_one", NOW),
    );
    const [blocked] = await database
      .select()
      .from(schema.organizationEntitlements);
    expect(blocked).toMatchObject({ status: "payment_pending" });
    expect(await getCreditBalance(database, "organization_one")).toBe(0);

    await projectPolarSubscriptionEvent(
      database,
      billingEvent({ eventId: "legacy_repair", eventType: "order.paid" }),
    );
    const [repaired] = await database
      .select()
      .from(schema.organizationEntitlements);
    expect(repaired).toMatchObject({
      tier: "pro",
      status: "active",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(await getCreditBalance(database, "organization_one")).toBe(1_000);
  });

  it("surfaces exhausted usage delivery and redrives it idempotently", async () => {
    await seedOrganizations("organization_one");
    await database.insert(schema.organizationEntitlements).values({
      organizationId: "organization_one",
      tier: "free",
      status: "active",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    await applyCreditEntry(database, {
      organizationId: "organization_one",
      idempotencyKey: "grant:outbox",
      kind: "grant",
      amount: 1,
    });
    const operation = {
      organizationId: "organization_one",
      amount: 1,
      referenceId: "search:outbox",
      idempotencyKey: "search:outbox",
      reservationKey: "idempotency-key" as const,
      now: NOW,
    };
    await database.transaction((tx) => reserveCredit(tx, operation));
    await database.transaction((tx) =>
      finalizeCreditReservation(tx, operation),
    );

    let outboxId = "";
    const deliveryStart = new Date(Date.now() + 60_000);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const attemptAt = new Date(deliveryStart.getTime() + attempt * 1_000);
      const claimed = await claimCreditUsage(database, {
        leaseOwner: `worker_${attempt}`,
        now: attemptAt,
      });
      expect(claimed).toHaveLength(1);
      outboxId = claimed[0]?.id ?? "";
      await releaseCreditUsage(database, {
        ids: [outboxId],
        leaseOwner: `worker_${attempt}`,
        errorCode: "network_error",
        availableAt: attemptAt,
        now: attemptAt,
      });
    }

    await expect(listCreditUsageDeadLetters(database)).resolves.toEqual([
      expect.objectContaining({
        id: outboxId,
        attempts: 8,
        lastErrorCode: "network_error",
      }),
    ]);
    await expect(
      listCreditUsageDeadLetters(database, { afterId: outboxId }),
    ).resolves.toEqual([]);
    await expect(
      redriveCreditUsage(database, { ids: [outboxId], now: deliveryStart }),
    ).resolves.toEqual([{ id: outboxId }]);
    await expect(
      redriveCreditUsage(database, { ids: [outboxId], now: deliveryStart }),
    ).resolves.toEqual([]);

    const redriven = await claimCreditUsage(database, {
      leaseOwner: "redrive_worker",
      now: deliveryStart,
    });
    expect(redriven).toEqual([
      expect.objectContaining({ id: outboxId, attempts: 1 }),
    ]);
    await expect(
      markCreditUsageDelivered(database, {
        ids: [outboxId, "missing_outbox_item"],
        leaseOwner: "redrive_worker",
        deliveredAt: deliveryStart,
      }),
    ).rejects.toMatchObject({ code: "usage_lease_lost" });
    const [stillLeased] = await database
      .select({ state: schema.creditUsageOutbox.state })
      .from(schema.creditUsageOutbox)
      .where(eq(schema.creditUsageOutbox.id, outboxId));
    expect(stillLeased?.state).toBe("leased");
    await markCreditUsageDelivered(database, {
      ids: [outboxId],
      leaseOwner: "redrive_worker",
      deliveredAt: deliveryStart,
    });
  });

  it("emits distinct usage events for identical keys in different Organizations", async () => {
    await seedOrganizations("organization_one", "organization_two");
    await database.insert(schema.organizationEntitlements).values(
      ["organization_one", "organization_two"].map((organizationId) => ({
        organizationId,
        tier: "free",
        status: "active",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      })),
    );
    for (const organizationId of ["organization_one", "organization_two"]) {
      await applyCreditEntry(database, {
        organizationId,
        idempotencyKey: `grant:${organizationId}`,
        kind: "grant",
        amount: 1,
      });
      const operation = {
        organizationId,
        amount: 1,
        referenceId: "search:shared",
        idempotencyKey: "search:shared",
        reservationKey: "idempotency-key" as const,
        now: NOW,
      };
      await database.transaction((tx) => reserveCredit(tx, operation));
      await database.transaction((tx) =>
        finalizeCreditReservation(tx, operation),
      );
    }

    const usage = await database
      .select({
        organizationId: schema.creditUsageOutbox.organizationId,
        idempotencyKey: schema.creditUsageOutbox.idempotencyKey,
      })
      .from(schema.creditUsageOutbox)
      .orderBy(schema.creditUsageOutbox.organizationId);
    expect(usage).toEqual([
      {
        organizationId: "organization_one",
        idempotencyKey:
          "organization_one:search:shared:consumption:credit:1",
      },
      {
        organizationId: "organization_two",
        idempotencyKey:
          "organization_two:search:shared:consumption:credit:1",
      },
    ]);
  });

  it("replays an Operator adjustment across correlation IDs", async () => {
    await seedOrganizations("organization_one");
    const input = {
      organizationId: "organization_one",
      amount: 25,
      idempotencyKey: "support-case-1",
    };
    await expect(
      adjustCreditsAsOperator(database, input, {
        operatorId: "operator_one",
        correlationId: "request_one",
        reason: "Approved support adjustment",
      }),
    ).resolves.toMatchObject({ applied: true, balance: 25 });
    await expect(
      adjustCreditsAsOperator(database, input, {
        operatorId: "operator_one",
        correlationId: "request_two",
        reason: "Approved support adjustment",
      }),
    ).resolves.toMatchObject({ applied: false, balance: 25 });
  });

  it("reconciles usage in the period when Polar received it", async () => {
    await seedOrganizations("organization_one");
    await database.insert(schema.organizationEntitlements).values({
      organizationId: "organization_one",
      tier: "free",
      status: "active",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    await applyCreditEntry(database, {
      organizationId: "organization_one",
      idempotencyKey: "grant:boundary",
      kind: "grant",
      amount: 1,
    });
    const operation = {
      organizationId: "organization_one",
      amount: 1,
      referenceId: "search:boundary",
      idempotencyKey: "search:boundary",
      reservationKey: "idempotency-key" as const,
      now: new Date("2026-09-30T23:59:00Z"),
    };
    await database.transaction((tx) => reserveCredit(tx, operation));
    await database.transaction((tx) => finalizeCreditReservation(tx, operation));
    await database
      .update(schema.creditUsageOutbox)
      .set({ occurredAt: operation.now, availableAt: operation.now })
      .where(eq(schema.creditUsageOutbox.organizationId, "organization_one"));
    const deliveryAt = new Date("2026-10-01T00:01:00Z");
    const [usage] = await claimCreditUsage(database, {
      leaseOwner: "boundary-delivery",
      now: deliveryAt,
    });
    if (!usage) throw new Error("Expected boundary usage");
    await markCreditUsageDelivered(database, {
      ids: [usage.id],
      leaseOwner: "boundary-delivery",
      deliveredAt: deliveryAt,
    });

    await expect(
      reconcileCreditUsage(
        database,
        {
          organizationId: "organization_one",
          startAt: PERIOD_START,
          endAt: PERIOD_END,
          now: deliveryAt,
        },
        async () => 0,
      ),
    ).resolves.toMatchObject({ localCredits: 0, polarCredits: 0, status: "matched" });
    await expect(
      reconcileCreditUsage(
        database,
        {
          organizationId: "organization_one",
          startAt: PERIOD_END,
          endAt: new Date("2026-11-01T00:00:00Z"),
          now: deliveryAt,
        },
        async () => 1,
      ),
    ).resolves.toMatchObject({ localCredits: 1, polarCredits: 1, status: "matched" });
  });

  it("pins reconciliation periods and pages every Organization with bounded work", async () => {
    const organizationIds = Array.from(
      { length: 5 },
      (_, index) => `organization_0${index + 1}`,
    );
    await seedOrganizations(...organizationIds);
    await database.insert(schema.organizationEntitlements).values(
      organizationIds.map((organizationId) => ({
        organizationId,
        tier: "pro",
        status: "active",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      })),
    );
    await database.insert(schema.polarCustomers).values(
      organizationIds.map((organizationId, index) => ({
        organizationId,
        polarCustomerId: `customer_0${index + 1}`,
      })),
    );

    const visited: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reconcileCreditPeriodPage(
        database,
        async ({ organizationId }) => {
          visited.push(organizationId);
          return 0;
        },
        { limit: 2, afterOrganizationId: cursor, now: NOW },
      );
      expect(page.reconciliations.length).toBeLessThanOrEqual(2);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(visited).toEqual(organizationIds);

    const first = await reconcileCreditUsage(
      database,
      {
        organizationId: "organization_01",
        startAt: PERIOD_START,
        endAt: PERIOD_END,
        now: NOW,
      },
      async () => 1,
    );
    expect(first).toMatchObject({ status: "drift", attempts: 2 });
    await database
      .update(schema.organizationEntitlements)
      .set({
        periodStart: PERIOD_END,
        periodEnd: new Date("2026-11-01T00:00:00Z"),
      })
      .where(
        eq(schema.organizationEntitlements.organizationId, "organization_01"),
      );
    if (!first) throw new Error("Expected reconciliation");
    const retried = await reconcileCreditUsage(
      database,
      { reconciliationId: first.id, now: NOW },
      async (target) => {
        expect(target).toEqual({
          organizationId: "organization_01",
          startAt: PERIOD_START,
          endAt: PERIOD_END,
        });
        return 0;
      },
    );
    expect(retried).toMatchObject({ status: "matched", attempts: 3 });
  });
});
