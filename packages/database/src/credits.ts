import { and, eq, sql } from "drizzle-orm";

import {
  creditAccounts,
  creditLedgerEntries,
  organizationEntitlements,
  operatorAuditEvents,
} from "./schema";
import type { DrizzleDatabase, Transaction } from "./service/types";

export type CreditEntryKind = "grant" | "charge" | "refund";

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

type CreditEntryInput = {
  organizationId: string;
  idempotencyKey: string;
  kind: CreditEntryKind;
  amount: number;
  referenceId?: string;
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
};

const validateAmount = (amount: number) => {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error("invalid_credit_amount");
};

const requireActiveEntitlement = async (
  database: Transaction,
  organizationId: string,
) => {
  const [entitlement] = await database
    .select({ status: organizationEntitlements.status })
    .from(organizationEntitlements)
    .where(eq(organizationEntitlements.organizationId, organizationId))
    .limit(1);
  if (entitlement?.status !== "active")
    throw new CreditOperationError("credits_unavailable");
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

/** Applies a Credit movement inside the caller's transaction. */
export const applyCreditEntryInTransaction = async (
  tx: Transaction,
  input: CreditEntryInput,
) => {
  validateAmount(input.amount);
  const signedAmount = input.kind === "charge" ? -input.amount : input.amount;
  await lockOrganizationCredits(tx, input.organizationId);
  if (signedAmount < 0)
    await requireActiveEntitlement(tx, input.organizationId);

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
  const reservation = await findLedgerEntry(
    tx,
    input.organizationId,
    keys.reservation,
  );
  const consumption = await findLedgerEntry(
    tx,
    input.organizationId,
    keys.consumption,
  );
  const release = await findLedgerEntry(tx, input.organizationId, keys.release);
  const alternateReservation = await findLedgerEntry(
    tx,
    input.organizationId,
    input.reservationKey === "reservation-suffix"
      ? input.idempotencyKey
      : `${input.idempotencyKey}:reservation`,
  );
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
    assertExactEntry(release, {
      kind: "release",
      amount: input.amount,
      referenceId: input.referenceId,
    });
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
  await requireActiveEntitlement(tx, input.organizationId);
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
  if (state.consumption) return { applied: false };
  await tx.insert(creditLedgerEntries).values({
    organizationId: input.organizationId,
    idempotencyKey: state.keys.consumption,
    kind: "consumption",
    amount: 0,
    referenceId: input.referenceId,
  });
  return { applied: true };
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
  await tx.insert(creditLedgerEntries).values({
    organizationId: input.organizationId,
    idempotencyKey: state.keys.release,
    kind: "release",
    amount: input.amount,
    referenceId: input.referenceId,
  });
  const [account] = await tx
    .update(creditAccounts)
    .set({
      balance: sql`${creditAccounts.balance} + ${input.amount}`,
      updatedAt: new Date(),
    })
    .where(eq(creditAccounts.organizationId, input.organizationId))
    .returning();
  if (!account) throw new Error("credit_account_not_found");
  return { applied: true };
};
