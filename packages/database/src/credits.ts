import { and, eq, inArray, sql } from "drizzle-orm";

import {
  creditAccounts,
  creditLedgerEntries,
  creditReconciliations,
  creditUsageOutbox,
  memberFreeCreditClaims,
  operatorAuditEvents,
  organizationEntitlements,
  polarCustomers,
  polarWebhookEvents,
} from "./schema";
import type { DrizzleDatabase, Transaction } from "./service/types";

export const FREE_MONTHLY_CREDITS = 100;
export const PRO_MONTHLY_CREDITS = 1_000;

export type CreditEntryKind =
  | "grant"
  | "charge"
  | "refund"
  | "adjustment"
  | "expiration";

export type CreditActor = {
  type: "member" | "api_key" | "operator" | "polar" | "system";
  id: string;
};

export class CreditOperationError extends Error {
  constructor(
    public readonly code:
      | "insufficient_credits"
      | "idempotency_conflict"
      | "credits_unavailable",
  ) {
    super(code);
  }
}

export type CreditEntryInput = {
  organizationId: string;
  idempotencyKey: string;
  kind: CreditEntryKind;
  amount: number;
  referenceId?: string;
  actor?: CreditActor;
  operation?: string;
  periodStart?: Date;
  now?: Date;
  operatorAudit?: {
    operatorId: string;
    correlationId: string;
    reason?: string;
    action: string;
    subjectType: string;
    subjectId: string;
  };
};

export type CreditReservation = {
  organizationId: string;
  amount: number;
  referenceId: string;
  idempotencyKey: string;
  reservationKey: "idempotency-key" | "reservation-suffix";
  actor?: CreditActor;
  operation?: string;
  now?: Date;
};

const validateAmount = (amount: number) => {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error("invalid_credit_amount");
};

const validateSignedAmount = (amount: number) => {
  if (!Number.isSafeInteger(amount) || amount === 0)
    throw new Error("invalid_credit_amount");
};

export const addUtcMonth = (date: Date) => {
  if (Number.isNaN(date.getTime())) throw new Error("invalid_billing_period");
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
};

const validatePeriod = (start: Date, end: Date) => {
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start.getTime() >= end.getTime()
  )
    throw new Error("invalid_billing_period");
};

const proCreditStatus = (
  polarStatus: string | null,
  paid: boolean,
  revoked: boolean,
) => {
  if (revoked) return "blocked" as const;
  if (polarStatus === "active" || polarStatus === "trialing")
    return paid ? ("active" as const) : ("payment_pending" as const);
  if (polarStatus === "past_due" && paid) return "active" as const;
  return "blocked" as const;
};

const endsWithFreePeriod = (polarStatus: string | null) =>
  polarStatus === "past_due" ||
  polarStatus === "canceled" ||
  polarStatus === "unpaid" ||
  polarStatus === "paused" ||
  polarStatus === "incomplete_expired";

const requireActiveEntitlement = async (
  database: Transaction,
  organizationId: string,
  now = new Date(),
) => {
  await rolloverCreditPeriodInTransaction(database, organizationId, now);
  const [entitlement] = await database
    .select({
      periodStart: organizationEntitlements.periodStart,
      status: organizationEntitlements.status,
    })
    .from(organizationEntitlements)
    .where(eq(organizationEntitlements.organizationId, organizationId))
    .limit(1);
  if (entitlement?.status !== "active")
    throw new CreditOperationError("credits_unavailable");
  return entitlement;
};

const lockOrganizationCredits = (tx: Transaction, organizationId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${organizationId}))`);

const findLedgerEntry = async (
  tx: Transaction,
  organizationId: string,
  idempotencyKey: string,
) => {
  const [entry] = await tx
    .select()
    .from(creditLedgerEntries)
    .where(
      and(
        eq(creditLedgerEntries.organizationId, organizationId),
        eq(creditLedgerEntries.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return entry;
};

const assertExactEntry = (
  entry: typeof creditLedgerEntries.$inferSelect,
  expected: {
    kind: string;
    amount: number;
    referenceId: string | null;
  },
) => {
  if (
    entry.kind !== expected.kind ||
    entry.amount !== expected.amount ||
    entry.referenceId !== expected.referenceId
  )
    throw new CreditOperationError("idempotency_conflict");
};

const currentPeriodStart = async (tx: Transaction, organizationId: string) => {
  const [entitlement] = await tx
    .select({ periodStart: organizationEntitlements.periodStart })
    .from(organizationEntitlements)
    .where(eq(organizationEntitlements.organizationId, organizationId))
    .limit(1);
  return entitlement?.periodStart ?? null;
};

/** Applies a Credit movement inside the caller's transaction. */
export const applyCreditEntryInTransaction = async (
  tx: Transaction,
  input: CreditEntryInput,
) => {
  if (input.kind === "adjustment") validateSignedAmount(input.amount);
  else validateAmount(input.amount);
  const signedAmount =
    input.kind === "adjustment"
      ? input.amount
      : input.kind === "charge" || input.kind === "expiration"
        ? -input.amount
        : input.amount;
  await lockOrganizationCredits(tx, input.organizationId);
  const entitlement =
    input.kind === "charge"
      ? await requireActiveEntitlement(tx, input.organizationId, input.now)
      : null;

  const expected = {
    kind: input.kind,
    amount: signedAmount,
    referenceId: input.referenceId ?? null,
  };
  const existing = await findLedgerEntry(
    tx,
    input.organizationId,
    input.idempotencyKey,
  );
  if (existing) {
    assertExactEntry(existing, expected);
    const [account] = await tx
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.organizationId, input.organizationId));
    return {
      entry: existing,
      balance: account?.balance ?? 0,
      applied: false,
    };
  }

  const [entry] = await tx
    .insert(creditLedgerEntries)
    .values({
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      actorType: input.actor?.type,
      actorId: input.actor?.id,
      operation: input.operation,
      periodStart:
        input.periodStart ??
        entitlement?.periodStart ??
        (await currentPeriodStart(tx, input.organizationId)),
      ...expected,
    })
    .returning();
  if (!entry) throw new Error("credit_entry_insert_failed");
  await tx
    .insert(creditAccounts)
    .values({ organizationId: input.organizationId })
    .onConflictDoNothing();
  const [account] = await tx
    .update(creditAccounts)
    .set({
      balance: sql`${creditAccounts.balance} + ${signedAmount}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(creditAccounts.organizationId, input.organizationId),
        sql`${creditAccounts.balance} + ${signedAmount} >= 0`,
      ),
    )
    .returning();
  if (!account) throw new CreditOperationError("insufficient_credits");
  if (input.operatorAudit)
    await tx.insert(operatorAuditEvents).values(input.operatorAudit);
  return { entry, balance: account.balance, applied: true };
};

const advanceFreePeriod = (periodEnd: Date, now: Date) => {
  let start = new Date(periodEnd);
  let end = addUtcMonth(start);
  while (end.getTime() <= now.getTime()) {
    start = end;
    end = addUtcMonth(start);
  }
  return { start, end };
};

const hasFreeCreditClaim = async (tx: Transaction, organizationId: string) => {
  const [claim] = await tx
    .select({ memberId: memberFreeCreditClaims.memberId })
    .from(memberFreeCreditClaims)
    .where(eq(memberFreeCreditClaims.organizationId, organizationId))
    .limit(1);
  return claim !== undefined;
};

const queueCreditReconciliationPeriodInTransaction = async (
  tx: Transaction,
  input: { organizationId: string; periodStart: Date; periodEnd: Date },
) => {
  validatePeriod(input.periodStart, input.periodEnd);
  const [customer] = await tx
    .select({ organizationId: polarCustomers.organizationId })
    .from(polarCustomers)
    .where(eq(polarCustomers.organizationId, input.organizationId))
    .limit(1);
  if (!customer) return;
  await tx
    .insert(creditReconciliations)
    .values({
      organizationId: input.organizationId,
      localCredits: 0,
      polarCredits: 0,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      status: "pending",
    })
    .onConflictDoNothing();
};

const expireCreditPeriodInTransaction = async (
  tx: Transaction,
  entitlement: typeof organizationEntitlements.$inferSelect,
  actor: CreditActor,
  operation: string,
) => {
  if (entitlement.periodStart && entitlement.periodEnd)
    await queueCreditReconciliationPeriodInTransaction(tx, {
      organizationId: entitlement.organizationId,
      periodStart: entitlement.periodStart,
      periodEnd: entitlement.periodEnd,
    });
  const [account] = await tx
    .select({ balance: creditAccounts.balance })
    .from(creditAccounts)
    .where(eq(creditAccounts.organizationId, entitlement.organizationId))
    .limit(1);
  if (!account || account.balance === 0) return false;
  await applyCreditEntryInTransaction(tx, {
    organizationId: entitlement.organizationId,
    idempotencyKey: `billing-period:${entitlement.periodStart?.toISOString() ?? "legacy"}:expiration:${entitlement.periodEnd?.toISOString() ?? "fail-closed"}`,
    kind: "expiration",
    amount: account.balance,
    referenceId: entitlement.periodStart?.toISOString() ?? "legacy",
    actor,
    operation,
    periodStart: entitlement.periodStart ?? undefined,
  });
  return true;
};

const paidPeriodConfirmationKey = (periodStart: Date) =>
  `billing-period:pro:${periodStart.toISOString()}:paid-confirmation`;

const hasPaidPeriodConfirmation = async (
  tx: Transaction,
  organizationId: string,
  periodStart: Date,
  periodEnd: Date,
) => {
  const confirmation = await findLedgerEntry(
    tx,
    organizationId,
    paidPeriodConfirmationKey(periodStart),
  );
  return (
    confirmation?.kind === "payment_confirmation" &&
    confirmation.amount === 0 &&
    confirmation.referenceId === periodEnd.toISOString()
  );
};

/** Expires one period and grants only the current period's allocation. */
export const replaceCreditPeriodInTransaction = async (
  tx: Transaction,
  input: {
    organizationId: string;
    tier: "free" | "pro";
    periodStart: Date;
    periodEnd: Date;
    actor: CreditActor;
    operation: string;
  },
) => {
  validatePeriod(input.periodStart, input.periodEnd);
  await lockOrganizationCredits(tx, input.organizationId);
  const [entitlement] = await tx
    .select()
    .from(organizationEntitlements)
    .where(eq(organizationEntitlements.organizationId, input.organizationId))
    .limit(1);
  const grantKey = `billing-period:${input.tier}:${input.periodStart.toISOString()}:grant`;
  const samePeriod =
    entitlement?.tier === input.tier &&
    entitlement.periodStart?.getTime() === input.periodStart.getTime() &&
    entitlement.periodEnd?.getTime() === input.periodEnd.getTime();
  if (
    entitlement?.tier === input.tier &&
    entitlement.periodStart?.getTime() === input.periodStart.getTime() &&
    entitlement.periodEnd?.getTime() !== input.periodEnd.getTime()
  )
    throw new CreditOperationError("idempotency_conflict");
  if (entitlement?.periodStart && entitlement.periodEnd && !samePeriod)
    await queueCreditReconciliationPeriodInTransaction(tx, {
      organizationId: input.organizationId,
      periodStart: entitlement.periodStart,
      periodEnd: entitlement.periodEnd,
    });
  if (samePeriod) {
    const existingGrant = await findLedgerEntry(
      tx,
      input.organizationId,
      grantKey,
    );
    if (existingGrant) {
      assertExactEntry(existingGrant, {
        kind: "grant",
        amount:
          input.tier === "pro" ? PRO_MONTHLY_CREDITS : FREE_MONTHLY_CREDITS,
        referenceId: input.periodStart.toISOString(),
      });
      return { applied: false };
    }
  }

  const [account] = await tx
    .select({ balance: creditAccounts.balance })
    .from(creditAccounts)
    .where(eq(creditAccounts.organizationId, input.organizationId))
    .limit(1);
  const balance = account?.balance ?? 0;
  const previousPeriod = entitlement?.periodStart?.toISOString() ?? "legacy";
  if (balance > 0) {
    await applyCreditEntryInTransaction(tx, {
      organizationId: input.organizationId,
      idempotencyKey: `billing-period:${previousPeriod}:expiration:${input.periodStart.toISOString()}`,
      kind: "expiration",
      amount: balance,
      referenceId: previousPeriod,
      actor: input.actor,
      operation: `${input.operation}.expiration`,
      periodStart: entitlement?.periodStart ?? undefined,
    });
  }

  await tx
    .insert(organizationEntitlements)
    .values({
      organizationId: input.organizationId,
      tier: input.tier,
      status: "active",
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    })
    .onConflictDoUpdate({
      target: organizationEntitlements.organizationId,
      set: {
        tier: input.tier,
        status: "active",
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        updatedAt: new Date(),
      },
    });
  await applyCreditEntryInTransaction(tx, {
    organizationId: input.organizationId,
    idempotencyKey: grantKey,
    kind: "grant",
    amount: input.tier === "pro" ? PRO_MONTHLY_CREDITS : FREE_MONTHLY_CREDITS,
    referenceId: input.periodStart.toISOString(),
    actor: input.actor,
    operation: `${input.operation}.grant`,
    periodStart: input.periodStart,
  });
  return { applied: true };
};

/** Confirms payment separately from the idempotent grant for legacy repair. */
export const confirmPaidCreditPeriodInTransaction = async (
  tx: Transaction,
  input: {
    organizationId: string;
    periodStart: Date;
    periodEnd: Date;
    actor: CreditActor;
    operation: string;
  },
) => {
  const result = await replaceCreditPeriodInTransaction(tx, {
    ...input,
    tier: "pro",
  });
  const idempotencyKey = paidPeriodConfirmationKey(input.periodStart);
  const existing = await findLedgerEntry(
    tx,
    input.organizationId,
    idempotencyKey,
  );
  if (existing) {
    assertExactEntry(existing, {
      kind: "payment_confirmation",
      amount: 0,
      referenceId: input.periodEnd.toISOString(),
    });
    return result;
  }
  await tx.insert(creditLedgerEntries).values({
    organizationId: input.organizationId,
    idempotencyKey,
    kind: "payment_confirmation",
    amount: 0,
    referenceId: input.periodEnd.toISOString(),
    actorType: input.actor.type,
    actorId: input.actor.id,
    operation: `${input.operation}.confirmation`,
    periodStart: input.periodStart,
  });
  return result;
};

/** Lazily advances an expired allocation so stale paid Credits cannot be spent. */
export const rolloverCreditPeriodInTransaction = async (
  tx: Transaction,
  organizationId: string,
  now = new Date(),
) => {
  if (Number.isNaN(now.getTime())) throw new Error("invalid_billing_period");
  await lockOrganizationCredits(tx, organizationId);
  const [entitlement] = await tx
    .select()
    .from(organizationEntitlements)
    .where(eq(organizationEntitlements.organizationId, organizationId))
    .limit(1);
  if (!entitlement) return null;
  let revoked = false;
  if (entitlement.polarEventId) {
    const [latestPolarEvent] = await tx
      .select({ eventType: polarWebhookEvents.eventType })
      .from(polarWebhookEvents)
      .where(eq(polarWebhookEvents.id, entitlement.polarEventId))
      .limit(1);
    revoked = latestPolarEvent?.eventType === "subscription.revoked";
  }

  if (!entitlement.periodStart || !entitlement.periodEnd) {
    if (entitlement.tier === "free") {
      const freeClaim = await hasFreeCreditClaim(tx, organizationId);
      if (!freeClaim) {
        await expireCreditPeriodInTransaction(
          tx,
          entitlement,
          { type: "system", id: "billing-period" },
          "billing.free.fail-closed.expiration",
        );
        if (entitlement.status !== "inactive")
          await tx
            .update(organizationEntitlements)
            .set({ status: "inactive", updatedAt: now })
            .where(eq(organizationEntitlements.organizationId, organizationId));
      } else {
        const periodStart = entitlement.updatedAt;
        const periodEnd = addUtcMonth(periodStart);
        if (periodEnd.getTime() > now.getTime()) {
          const [initialized] = await tx
            .update(organizationEntitlements)
            .set({ periodStart, periodEnd, updatedAt: now })
            .where(eq(organizationEntitlements.organizationId, organizationId))
            .returning();
          return initialized ?? entitlement;
        }
        const period = advanceFreePeriod(periodEnd, now);
        await replaceCreditPeriodInTransaction(tx, {
          organizationId,
          tier: "free",
          periodStart: period.start,
          periodEnd: period.end,
          actor: { type: "system", id: "billing-period" },
          operation: "billing.free.period",
        });
      }
    } else {
      await expireCreditPeriodInTransaction(
        tx,
        entitlement,
        { type: "system", id: "billing-period" },
        "billing.pro.legacy.fail-closed.expiration",
      );
      const status = proCreditStatus(entitlement.polarStatus, false, revoked);
      if (entitlement.status !== status)
        await tx
          .update(organizationEntitlements)
          .set({ status, updatedAt: now })
          .where(eq(organizationEntitlements.organizationId, organizationId));
    }
  } else if (entitlement.periodEnd.getTime() <= now.getTime()) {
    const freeClaim = await hasFreeCreditClaim(tx, organizationId);
    const shouldStartFreePeriod =
      entitlement.tier === "free" ||
      (freeClaim &&
        (entitlement.pendingFreeAtPeriodEnd ||
          entitlement.cancelAtPeriodEnd ||
          endsWithFreePeriod(entitlement.polarStatus) ||
          revoked));
    if (shouldStartFreePeriod && freeClaim) {
      const period = advanceFreePeriod(entitlement.periodEnd, now);
      await replaceCreditPeriodInTransaction(tx, {
        organizationId,
        tier: "free",
        periodStart: period.start,
        periodEnd: period.end,
        actor: { type: "system", id: "billing-period" },
        operation: "billing.free.period",
      });
      await tx
        .update(organizationEntitlements)
        .set({
          cancelAtPeriodEnd: false,
          pendingFreeAtPeriodEnd: false,
          status: "active",
          tier: "free",
          updatedAt: now,
        })
        .where(eq(organizationEntitlements.organizationId, organizationId));
    } else {
      await expireCreditPeriodInTransaction(
        tx,
        entitlement,
        { type: "system", id: "billing-period" },
        `${entitlement.tier === "pro" ? "billing.pro" : "billing.free"}.period.expiration`,
      );
      await tx
        .update(organizationEntitlements)
        .set({
          status:
            entitlement.tier === "pro"
              ? proCreditStatus(entitlement.polarStatus, false, revoked)
              : "inactive",
          updatedAt: now,
        })
        .where(eq(organizationEntitlements.organizationId, organizationId));
    }
  } else if (entitlement.tier === "pro") {
    const paid = await hasPaidPeriodConfirmation(
      tx,
      organizationId,
      entitlement.periodStart,
      entitlement.periodEnd,
    );
    const status = proCreditStatus(entitlement.polarStatus, paid, revoked);
    if (entitlement.status !== status)
      await tx
        .update(organizationEntitlements)
        .set({ status, updatedAt: now })
        .where(eq(organizationEntitlements.organizationId, organizationId));
  }
  const [current] = await tx
    .select()
    .from(organizationEntitlements)
    .where(eq(organizationEntitlements.organizationId, organizationId))
    .limit(1);
  return current ?? null;
};

export const initializeFreeCreditPeriod = async (
  tx: Transaction,
  input: { organizationId: string; memberId: string; now?: Date },
) => {
  const now = input.now ?? new Date();
  return replaceCreditPeriodInTransaction(tx, {
    organizationId: input.organizationId,
    tier: "free",
    periodStart: now,
    periodEnd: addUtcMonth(now),
    actor: { type: "member", id: input.memberId },
    operation: "billing.free.activation",
  });
};

/**
 * Applies a Credit movement exactly once and returns the resulting balance.
 * Debits lock the Organization operation and can never take the balance below zero.
 */
export const applyCreditEntry = (
  database: DrizzleDatabase,
  input: CreditEntryInput,
) => database.transaction((tx) => applyCreditEntryInTransaction(tx, input));

export const getCreditBalance = async (
  database: DrizzleDatabase,
  organizationId: string,
) => {
  const [account] = await database
    .select({ balance: creditAccounts.balance })
    .from(creditAccounts)
    .where(eq(creditAccounts.organizationId, organizationId));
  return account?.balance ?? 0;
};

const inspectReservation = async (
  tx: Transaction,
  input: CreditReservation,
) => {
  validateAmount(input.amount);
  if (input.referenceId.trim() === "" || input.idempotencyKey.trim() === "")
    throw new CreditOperationError("idempotency_conflict");

  const keys = {
    reservation:
      input.reservationKey === "reservation-suffix"
        ? `${input.idempotencyKey}:reservation`
        : input.idempotencyKey,
    consumption: `${input.idempotencyKey}:consumption`,
    release: `${input.idempotencyKey}:release`,
  };
  if (new Set(Object.values(keys)).size !== Object.keys(keys).length)
    throw new CreditOperationError("idempotency_conflict");

  await lockOrganizationCredits(tx, input.organizationId);
  const alternateReservationKey =
    input.reservationKey === "reservation-suffix"
      ? input.idempotencyKey
      : `${input.idempotencyKey}:reservation`;
  const entries = await tx
    .select()
    .from(creditLedgerEntries)
    .where(
      and(
        eq(creditLedgerEntries.organizationId, input.organizationId),
        inArray(creditLedgerEntries.idempotencyKey, [
          keys.reservation,
          keys.consumption,
          keys.release,
          alternateReservationKey,
        ]),
      ),
    );
  const entriesByKey = new Map(
    entries.map((entry) => [entry.idempotencyKey, entry]),
  );
  const reservation = entriesByKey.get(keys.reservation);
  const consumption = entriesByKey.get(keys.consumption);
  const release = entriesByKey.get(keys.release);
  const alternateReservation = entriesByKey.get(alternateReservationKey);
  if (alternateReservation)
    throw new CreditOperationError("idempotency_conflict");
  if (reservation)
    assertExactEntry(reservation, {
      kind: "reservation",
      amount: -input.amount,
      referenceId: input.referenceId,
    });
  if (consumption)
    assertExactEntry(consumption, {
      kind: "consumption",
      amount: 0,
      referenceId: input.referenceId,
    });
  if (release)
    if (
      release.kind !== "release" ||
      (release.amount !== input.amount && release.amount !== 0) ||
      release.referenceId !== input.referenceId
    )
      throw new CreditOperationError("idempotency_conflict");
  if (!reservation && (consumption || release))
    throw new CreditOperationError("idempotency_conflict");
  return { reservation, consumption, release, keys };
};

/** Reserves Credits atomically inside a caller-owned transaction. */
export const reserveCredit = async (
  tx: Transaction,
  input: CreditReservation,
) => {
  const state = await inspectReservation(tx, input);
  const entitlement = await requireActiveEntitlement(
    tx,
    input.organizationId,
    input.now,
  );
  if (state.release) throw new CreditOperationError("idempotency_conflict");
  if (state.reservation) return { applied: false };

  await tx
    .insert(creditAccounts)
    .values({ organizationId: input.organizationId })
    .onConflictDoNothing();
  await tx.insert(creditLedgerEntries).values({
    organizationId: input.organizationId,
    idempotencyKey: state.keys.reservation,
    kind: "reservation",
    amount: -input.amount,
    referenceId: input.referenceId,
    actorType: input.actor?.type,
    actorId: input.actor?.id,
    operation: input.operation,
    periodStart: entitlement.periodStart,
  });
  const [account] = await tx
    .update(creditAccounts)
    .set({
      balance: sql`${creditAccounts.balance} - ${input.amount}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(creditAccounts.organizationId, input.organizationId),
        sql`${creditAccounts.balance} >= ${input.amount}`,
      ),
    )
    .returning();
  if (!account) throw new CreditOperationError("insufficient_credits");
  return { applied: true };
};

/** Records successful consumption of an existing Credit reservation. */
export const finalizeCreditReservation = async (
  tx: Transaction,
  input: CreditReservation,
) => {
  const state = await inspectReservation(tx, input);
  if (!state.reservation || state.release)
    throw new CreditOperationError("idempotency_conflict");
  let consumption = state.consumption;
  if (!consumption) {
    [consumption] = await tx
      .insert(creditLedgerEntries)
      .values({
        organizationId: input.organizationId,
        idempotencyKey: state.keys.consumption,
        kind: "consumption",
        amount: 0,
        referenceId: input.referenceId,
        actorType: input.actor?.type,
        actorId: input.actor?.id,
        operation: input.operation,
        periodStart: state.reservation.periodStart,
      })
      .returning();
  }
  if (!consumption) throw new Error("credit_consumption_insert_failed");
  await tx
    .insert(creditUsageOutbox)
    .values(
      Array.from({ length: input.amount }, (_, index) => ({
        consumptionEntryId: consumption.id,
        ordinal: index + 1,
        idempotencyKey: `${input.organizationId}:${consumption.idempotencyKey}:credit:${index + 1}`,
        organizationId: input.organizationId,
        occurredAt: consumption.createdAt,
      })),
    )
    .onConflictDoNothing({
      target: [creditUsageOutbox.consumptionEntryId, creditUsageOutbox.ordinal],
    });
  return { applied: !state.consumption };
};

/** Releases an unconsumed reservation exactly once. */
export const releaseCreditReservation = async (
  tx: Transaction,
  input: CreditReservation,
) => {
  const state = await inspectReservation(tx, input);
  if (!state.reservation || state.consumption)
    throw new CreditOperationError("idempotency_conflict");
  if (state.release) return { applied: false };
  const periodStart = await currentPeriodStart(tx, input.organizationId);
  const restoresBalance =
    state.reservation.periodStart === null ||
    (periodStart !== null &&
      state.reservation.periodStart.getTime() === periodStart.getTime());
  const releasedAmount = restoresBalance ? input.amount : 0;
  await tx.insert(creditLedgerEntries).values({
    organizationId: input.organizationId,
    idempotencyKey: state.keys.release,
    kind: "release",
    amount: releasedAmount,
    referenceId: input.referenceId,
    actorType: input.actor?.type,
    actorId: input.actor?.id,
    operation: input.operation,
    periodStart: state.reservation.periodStart,
  });
  if (restoresBalance) {
    const [account] = await tx
      .update(creditAccounts)
      .set({
        balance: sql`${creditAccounts.balance} + ${input.amount}`,
        updatedAt: new Date(),
      })
      .where(eq(creditAccounts.organizationId, input.organizationId))
      .returning();
    if (!account) throw new Error("credit_account_not_found");
  }
  return { applied: true };
};
