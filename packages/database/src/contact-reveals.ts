import { and, eq, isNull, sql } from "drizzle-orm";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  contactDetails,
  contactReveals,
  creditAccounts,
  creditLedgerEntries,
  members,
  organizationMemberships,
  organizations,
  profiles,
} from "./schema";

type Database =
  | NeonDatabase<typeof import("./schema")>
  | NodePgDatabase<typeof import("./schema")>;

export type VerifiedContactDetailInput = {
  profileId: string;
  kind: "email" | "phone";
  value: string;
  source: string;
  sourceRecordId: string;
  category: "professional";
  verification: "provider-verified";
  direct?: boolean;
  verifiedAt: Date;
};

/** Stores only Contact Details allowed by the product's evidence policy. */
export const recordVerifiedContactDetail = async (
  database: Database,
  input: VerifiedContactDetailInput,
) => {
  if (
    (input.kind !== "email" && input.kind !== "phone") ||
    input.category !== "professional" ||
    input.verification !== "provider-verified" ||
    (input.kind === "phone" && input.direct !== true)
  )
    throw new Error("contact_detail_not_eligible");
  if (input.value.trim() === "" || input.source.trim() === "")
    throw new Error("contact_detail_not_eligible");

  const [detail] = await database
    .insert(contactDetails)
    .values({
      profileId: input.profileId,
      kind: input.kind,
      value: input.value,
      source: input.source,
      sourceRecordId: input.sourceRecordId,
      verifiedAt: input.verifiedAt,
    })
    .onConflictDoUpdate({
      target: [contactDetails.source, contactDetails.sourceRecordId],
      set: {
        profileId: input.profileId,
        kind: input.kind,
        value: input.value,
        verifiedAt: input.verifiedAt,
        updatedAt: new Date(),
      },
    })
    .returning();
  return detail!;
};

export const revealContactDetail = (
  database: Database,
  input: {
    memberId: string;
    organizationId: string;
    contactDetailId: string;
    creditCost?: number;
  },
) =>
  database.transaction(async (tx) => {
    const creditCost = input.creditCost ?? 1;
    if (!Number.isSafeInteger(creditCost) || creditCost <= 0)
      throw new Error("invalid_credit_amount");

    const [detail] = await tx
      .select({
        id: contactDetails.id,
        kind: contactDetails.kind,
        value: contactDetails.value,
      })
      .from(contactDetails)
      .innerJoin(profiles, eq(profiles.profileId, contactDetails.profileId))
      .innerJoin(
        organizationMemberships,
        eq(organizationMemberships.organizationId, input.organizationId),
      )
      .innerJoin(members, eq(members.clerkId, organizationMemberships.memberId))
      .innerJoin(
        organizations,
        eq(organizations.clerkId, organizationMemberships.organizationId),
      )
      .where(
        and(
          eq(contactDetails.id, input.contactDetailId),
          eq(contactDetails.valid, true),
          eq(contactDetails.suppressed, false),
          eq(profiles.searchable, true),
          eq(organizationMemberships.memberId, input.memberId),
          eq(organizationMemberships.active, true),
          eq(members.active, true),
          eq(organizations.active, true),
        ),
      )
      .limit(1);
    if (!detail) throw new Error("contact_detail_unavailable");

    const [inserted] = await tx
      .insert(contactReveals)
      .values({
        organizationId: input.organizationId,
        contactDetailId: detail.id,
        creditCost,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(contactReveals)
        .where(
          and(
            eq(contactReveals.organizationId, input.organizationId),
            eq(contactReveals.contactDetailId, detail.id),
            isNull(contactReveals.revokedAt),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("contact_detail_unavailable");
      return { detail, reveal: existing, charged: false };
    }

    await tx
      .insert(creditAccounts)
      .values({ organizationId: input.organizationId })
      .onConflictDoNothing();
    const [account] = await tx
      .update(creditAccounts)
      .set({
        balance: sql`${creditAccounts.balance} - ${creditCost}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(creditAccounts.organizationId, input.organizationId),
          sql`${creditAccounts.balance} >= ${creditCost}`,
        ),
      )
      .returning();
    if (!account) throw new Error("insufficient_credits");
    await tx.insert(creditLedgerEntries).values({
      organizationId: input.organizationId,
      idempotencyKey: `contact-reveal:${inserted.id}`,
      kind: "charge",
      amount: -creditCost,
      referenceId: inserted.id,
    });
    return { detail, reveal: inserted, charged: true };
  });

/** Revokes every Organization's access and compensates each original charge. */
export const invalidateContactDetail = (
  database: Database,
  contactDetailId: string,
  options: { suppressed?: boolean } = {},
) =>
  database.transaction(async (tx) => {
    const now = new Date();
    const [detail] = await tx
      .update(contactDetails)
      .set({
        valid: false,
        suppressed: options.suppressed ?? false,
        updatedAt: now,
      })
      .where(eq(contactDetails.id, contactDetailId))
      .returning();
    if (!detail) throw new Error("contact_detail_not_found");

    const reveals = await tx
      .update(contactReveals)
      .set({ revokedAt: now, refundedAt: now })
      .where(
        and(
          eq(contactReveals.contactDetailId, contactDetailId),
          isNull(contactReveals.revokedAt),
        ),
      )
      .returning();
    for (const reveal of reveals) {
      const [refund] = await tx
        .insert(creditLedgerEntries)
        .values({
          organizationId: reveal.organizationId,
          idempotencyKey: `contact-refund:${reveal.id}`,
          kind: "refund",
          amount: reveal.creditCost,
          referenceId: reveal.id,
        })
        .onConflictDoNothing()
        .returning();
      if (refund)
        await tx
          .update(creditAccounts)
          .set({
            balance: sql`${creditAccounts.balance} + ${reveal.creditCost}`,
            updatedAt: now,
          })
          .where(eq(creditAccounts.organizationId, reveal.organizationId));
    }
    return { detail, refundedReveals: reveals.length };
  });
