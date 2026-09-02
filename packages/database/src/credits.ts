import { and, eq, sql } from "drizzle-orm";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { creditAccounts, creditLedgerEntries } from "./schema";

type Database =
  | NeonDatabase<typeof import("./schema")>
  | NodePgDatabase<typeof import("./schema")>;

export type CreditEntryKind = "grant" | "charge" | "refund";

export class CreditOperationError extends Error {
  constructor(
    public readonly code: "insufficient_credits" | "idempotency_conflict",
  ) {
    super(code);
  }
}

/**
 * Applies a credit movement exactly once and returns the resulting balance.
 * Debits lock the Organization account and can never take it below zero.
 */
export const applyCreditEntry = (
  database: Database,
  input: {
    organizationId: string;
    idempotencyKey: string;
    kind: CreditEntryKind;
    amount: number;
    referenceId?: string;
  },
) =>
  database.transaction(async (tx) => {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0)
      throw new Error("invalid_credit_amount");
    const signedAmount = input.kind === "charge" ? -input.amount : input.amount;

    const [inserted] = await tx
      .insert(creditLedgerEntries)
      .values({
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        amount: signedAmount,
        referenceId: input.referenceId,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(creditLedgerEntries)
        .where(
          and(
            eq(creditLedgerEntries.organizationId, input.organizationId),
            eq(creditLedgerEntries.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("credit_entry_not_found");
      if (
        existing.kind !== input.kind ||
        existing.amount !== signedAmount ||
        existing.referenceId !== (input.referenceId ?? null)
      )
        throw new CreditOperationError("idempotency_conflict");
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
    return { entry: inserted, balance: account.balance, applied: true };
  });

export const getCreditBalance = async (
  database: Database,
  organizationId: string,
) => {
  const [account] = await database
    .select({ balance: creditAccounts.balance })
    .from(creditAccounts)
    .where(eq(creditAccounts.organizationId, organizationId));
  return account?.balance ?? 0;
};

/** Charges one Credit after a search page has completed successfully. */
export const chargeSearchPage = (
  database: Database,
  input: {
    organizationId: string;
    idempotencyKey: string;
    requestFingerprint: string;
  },
) =>
  applyCreditEntry(database, {
    organizationId: input.organizationId,
    idempotencyKey: input.idempotencyKey,
    kind: "charge",
    amount: 1,
    referenceId: `profile-search:${input.requestFingerprint}`,
  });

export const reserveSearchPage = (
  database: Database,
  input: {
    organizationId: string;
    idempotencyKey: string;
    requestFingerprint: string;
  },
) =>
  database.transaction(async (tx) => {
    const referenceId = `profile-search:${input.requestFingerprint}`;
    const [reservation] = await tx
      .insert(creditLedgerEntries)
      .values({
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        kind: "reservation",
        amount: -1,
        referenceId,
      })
      .onConflictDoNothing()
      .returning();
    if (!reservation) {
      const [existing] = await tx
        .select()
        .from(creditLedgerEntries)
        .where(
          and(
            eq(creditLedgerEntries.organizationId, input.organizationId),
            eq(creditLedgerEntries.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (
        !existing ||
        existing.kind !== "reservation" ||
        existing.amount !== -1 ||
        existing.referenceId !== referenceId
      ) {
        throw new CreditOperationError("idempotency_conflict");
      }
      const [released] = await tx
        .select({ id: creditLedgerEntries.id })
        .from(creditLedgerEntries)
        .where(
          and(
            eq(creditLedgerEntries.organizationId, input.organizationId),
            eq(
              creditLedgerEntries.idempotencyKey,
              `${input.idempotencyKey}:release`,
            ),
          ),
        )
        .limit(1);
      if (released) throw new CreditOperationError("idempotency_conflict");
      return { applied: false };
    }

    await tx
      .insert(creditAccounts)
      .values({ organizationId: input.organizationId })
      .onConflictDoNothing();
    const [account] = await tx
      .update(creditAccounts)
      .set({
        balance: sql`${creditAccounts.balance} - 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(creditAccounts.organizationId, input.organizationId),
          sql`${creditAccounts.balance} >= 1`,
        ),
      )
      .returning();
    if (!account) throw new CreditOperationError("insufficient_credits");
    return { applied: true };
  });

export const finalizeSearchPage = (
  database: Database,
  input: {
    organizationId: string;
    idempotencyKey: string;
    requestFingerprint: string;
  },
) =>
  database
    .insert(creditLedgerEntries)
    .values({
      organizationId: input.organizationId,
      idempotencyKey: `${input.idempotencyKey}:consumption`,
      kind: "consumption",
      amount: 0,
      referenceId: `profile-search:${input.requestFingerprint}`,
    })
    .onConflictDoNothing();

export const releaseSearchPage = (
  database: Database,
  input: {
    organizationId: string;
    idempotencyKey: string;
    requestFingerprint: string;
  },
) =>
  database.transaction(async (tx) => {
    const [release] = await tx
      .insert(creditLedgerEntries)
      .values({
        organizationId: input.organizationId,
        idempotencyKey: `${input.idempotencyKey}:release`,
        kind: "release",
        amount: 1,
        referenceId: `profile-search:${input.requestFingerprint}`,
      })
      .onConflictDoNothing()
      .returning();
    if (release) {
      await tx
        .update(creditAccounts)
        .set({
          balance: sql`${creditAccounts.balance} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(creditAccounts.organizationId, input.organizationId));
    }
  });
