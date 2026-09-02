import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  contactDetailInvalidations,
  contactDetailSuppressions,
  contactRevealRequests,
  contactReveals,
  creditAccounts,
  creditLedgerEntries,
  members,
  organizationEntitlements,
  organizationMemberships,
  organizations,
  profileObservations,
  principalSuspensions,
  profiles,
  reenrichmentOutbox,
  securityAuditEvents,
  suppressionRecords,
} from "./schema";

type Database =
  | NeonDatabase<typeof import("./schema")>
  | NodePgDatabase<typeof import("./schema")>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type ContactDetailType =
  | "professional-email"
  | "direct-professional-phone";

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

export type ContactDetailPreview = {
  observationId: string;
  type: ContactDetailType;
  maskedValue: string;
  value?: string;
  sourceCategory: string;
  collectedAt: string;
  confidence: number;
  price: 5 | 10;
  previouslyPurchased: boolean;
};

export class ContactRevealError extends Error {
  constructor(
    public readonly code:
      | "forbidden"
      | "not_found"
      | "insufficient_credits"
      | "idempotency_conflict"
      | "invalid_contact_detail"
      | "daily_limit"
      | "credits_unavailable",
  ) {
    super(code);
  }
}

export const contactRevealPrices: Record<ContactDetailType, 5 | 10> = {
  "professional-email": 5,
  "direct-professional-phone": 10,
};

const parseContactDetail = (
  value: unknown,
): { type: ContactDetailType; value: string } | null => {
  if (typeof value !== "object" || value === null) return null;
  const detail = value as { type?: unknown; value?: unknown };
  if (
    (detail.type !== "professional-email" &&
      detail.type !== "direct-professional-phone") ||
    typeof detail.value !== "string" ||
    detail.value.trim() === ""
  )
    return null;
  return { type: detail.type, value: detail.value };
};

const mask = (type: ContactDetailType, value: string) => {
  if (type === "professional-email") {
    const [local = "", domain = ""] = value.split("@");
    const domainParts = domain.split(".");
    const suffix = domainParts.length > 1 ? `.${domainParts.at(-1)}` : "";
    return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***${suffix}`;
  }
  const digits = value.replace(/\D/g, "");
  return `+${"*".repeat(Math.max(6, digits.length - 2))}${digits.slice(-2)}`;
};

const sourceCategory = (source: string) =>
  source === "tikhub" ? "professional-network" : "professional-data-provider";

const profileIsNotSuppressed = (database: Database | Transaction) =>
  notExists(
    database
      .select({ id: suppressionRecords.canonicalProviderId })
      .from(suppressionRecords)
      .where(
        and(
          eq(suppressionRecords.canonicalProvider, "github"),
          eq(suppressionRecords.canonicalProviderId, profiles.githubAccountId),
        ),
      ),
  );

/** Enforces the provider boundary before storing a Contact Detail Observation. */
export const recordVerifiedContactDetail = async (
  database: Database,
  input: VerifiedContactDetailInput,
) => {
  if (
    (input.kind !== "email" && input.kind !== "phone") ||
    input.category !== "professional" ||
    input.verification !== "provider-verified" ||
    (input.kind === "phone" && input.direct !== true) ||
    input.value.trim() === "" ||
    input.source.trim() === "" ||
    input.sourceRecordId.trim() === ""
  )
    throw new Error("contact_detail_not_eligible");

  const type: ContactDetailType =
    input.kind === "email" ? "professional-email" : "direct-professional-phone";
  const [observation] = await database
    .insert(profileObservations)
    .values({
      profileId: input.profileId,
      field: "contact-detail",
      value: { type, value: input.value },
      source: input.source,
      sourceRecordId: input.sourceRecordId,
      pipelineVersion: `${input.source}-provider-verified`,
      confidence: 1,
      collectedAt: input.verifiedAt,
    })
    .onConflictDoUpdate({
      target: [
        profileObservations.source,
        profileObservations.sourceRecordId,
        profileObservations.field,
      ],
      set: {
        profileId: input.profileId,
        value: { type, value: input.value },
        pipelineVersion: `${input.source}-provider-verified`,
        confidence: 1,
        collectedAt: input.verifiedAt,
      },
    })
    .returning();
  return observation!;
};

const requireMembership = async (
  database: Database | Transaction,
  memberId: string,
  organizationId: string,
) => {
  const [membership] = await database
    .select({
      role: organizationMemberships.role,
      memberContactRevealsEnabled: organizations.memberContactRevealsEnabled,
    })
    .from(organizationMemberships)
    .innerJoin(
      organizations,
      eq(organizations.clerkId, organizationMemberships.organizationId),
    )
    .innerJoin(members, eq(members.clerkId, organizationMemberships.memberId))
    .where(
      and(
        eq(organizationMemberships.memberId, memberId),
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.active, true),
        eq(members.active, true),
        eq(organizations.active, true),
        notExists(
          database
            .select({ id: principalSuspensions.id })
            .from(principalSuspensions)
            .where(
              and(
                isNull(principalSuspensions.revokedAt),
                or(
                  and(
                    eq(principalSuspensions.principalType, "member"),
                    eq(principalSuspensions.principalId, memberId),
                  ),
                  and(
                    eq(principalSuspensions.principalType, "organization"),
                    eq(principalSuspensions.principalId, organizationId),
                  ),
                ),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  if (!membership) throw new ContactRevealError("forbidden");
  return membership;
};

const requireRevealPermission = async (
  database: Database | Transaction,
  memberId: string,
  organizationId: string,
) => {
  const membership = await requireMembership(
    database,
    memberId,
    organizationId,
  );
  if (
    !membership.memberContactRevealsEnabled &&
    membership.role !== "org:admin" &&
    membership.role !== "admin"
  )
    throw new ContactRevealError("forbidden");
  return membership;
};

export const listContactDetails = async (
  database: Database,
  memberId: string,
  organizationId: string,
  profileId: string,
): Promise<ContactDetailPreview[]> => {
  await requireMembership(database, memberId, organizationId);
  const [profile] = await database
    .select({ id: profiles.profileId })
    .from(profiles)
    .where(
      and(
        eq(profiles.profileId, profileId),
        eq(profiles.searchable, true),
        profileIsNotSuppressed(database),
      ),
    )
    .limit(1);
  if (!profile) throw new ContactRevealError("not_found");

  const rows = await database
    .select({
      observation: profileObservations,
      revealStatus: contactReveals.status,
    })
    .from(profileObservations)
    .leftJoin(
      contactDetailInvalidations,
      eq(contactDetailInvalidations.observationId, profileObservations.id),
    )
    .leftJoin(
      contactReveals,
      and(
        eq(contactReveals.observationId, profileObservations.id),
        eq(contactReveals.organizationId, organizationId),
        eq(contactReveals.status, "finalized"),
      ),
    )
    .where(
      and(
        eq(profileObservations.profileId, profileId),
        eq(profileObservations.field, "contact-detail"),
        isNull(contactDetailInvalidations.observationId),
      ),
    )
    .orderBy(desc(profileObservations.collectedAt));
  const suppressions = new Set(
    (
      await database
        .select({ type: contactDetailSuppressions.type })
        .from(contactDetailSuppressions)
        .where(eq(contactDetailSuppressions.profileId, profileId))
    ).map(({ type }) => type),
  );
  return rows.flatMap(({ observation, revealStatus }) => {
    const detail = parseContactDetail(observation.value);
    if (
      !detail ||
      observation.source !== "tikhub" ||
      suppressions.has(detail.type)
    )
      return [];
    const purchased = revealStatus === "finalized";
    return [
      {
        observationId: observation.id,
        type: detail.type,
        maskedValue: mask(detail.type, detail.value),
        ...(purchased ? { value: detail.value } : {}),
        sourceCategory: sourceCategory(observation.source),
        collectedAt: observation.collectedAt.toISOString(),
        confidence: observation.confidence,
        price: contactRevealPrices[detail.type],
        previouslyPurchased: purchased,
      },
    ];
  });
};

export const purchaseContactReveal = async (
  database: Database,
  input: {
    memberId: string;
    organizationId: string;
    profileId: string;
    type: ContactDetailType;
    idempotencyKey: string;
    observationId?: string;
    apiKeyId?: string;
    source?: "web" | "api" | "mcp";
    correlationId?: string;
  },
) => {
  const [audit] = await database
    .insert(securityAuditEvents)
    .values({
      eventType: "contact_reveal",
      actorMemberId: input.memberId,
      organizationId: input.organizationId,
      apiKeyId: input.apiKeyId,
      profileId: input.profileId,
      source: input.source ?? "web",
      correlationId: input.correlationId ?? input.idempotencyKey,
      result: "attempted",
    })
    .returning({ id: securityAuditEvents.id });
  if (!audit) throw new Error("security_audit_insert_failed");
  try {
    const reserved = await database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${input.profileId}))`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${input.organizationId}))`,
      );
      await requireRevealPermission(tx, input.memberId, input.organizationId);
      const [suppression] = await tx
        .select({ type: contactDetailSuppressions.type })
        .from(contactDetailSuppressions)
        .where(
          and(
            eq(contactDetailSuppressions.profileId, input.profileId),
            eq(contactDetailSuppressions.type, input.type),
          ),
        )
        .limit(1);
      if (suppression) throw new ContactRevealError("not_found");

      const [replay] = await tx
        .select()
        .from(contactRevealRequests)
        .where(
          and(
            eq(contactRevealRequests.organizationId, input.organizationId),
            eq(contactRevealRequests.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (replay) {
        if (replay.profileId !== input.profileId || replay.type !== input.type)
          throw new ContactRevealError("idempotency_conflict");
        if (replay.status === "released" || replay.status === "refunded")
          throw new ContactRevealError("invalid_contact_detail");
        const [original] = await tx
          .select({ observation: profileObservations })
          .from(profileObservations)
          .innerJoin(
            profiles,
            eq(profiles.profileId, profileObservations.profileId),
          )
          .leftJoin(
            contactDetailInvalidations,
            eq(
              contactDetailInvalidations.observationId,
              profileObservations.id,
            ),
          )
          .where(
            and(
              eq(profileObservations.id, replay.observationId),
              eq(profileObservations.profileId, input.profileId),
              eq(profileObservations.source, "tikhub"),
              eq(profiles.searchable, true),
              profileIsNotSuppressed(tx),
              isNull(contactDetailInvalidations.observationId),
            ),
          )
          .limit(1);
        const originalDetail =
          original && parseContactDetail(original.observation.value);
        if (!original || !originalDetail || originalDetail.type !== input.type)
          throw new ContactRevealError("invalid_contact_detail");
        return {
          detail: originalDetail,
          observation: original.observation,
          reveal: (
            await tx
              .select()
              .from(contactReveals)
              .where(eq(contactReveals.id, replay.revealId))
              .limit(1)
          )[0]!,
          newlyReserved: false,
          operationIdempotencyKey: replay.idempotencyKey,
        };
      }

      const observations = await tx
        .select({ observation: profileObservations })
        .from(profileObservations)
        .innerJoin(
          profiles,
          eq(profiles.profileId, profileObservations.profileId),
        )
        .leftJoin(
          contactDetailInvalidations,
          eq(contactDetailInvalidations.observationId, profileObservations.id),
        )
        .where(
          and(
            eq(profileObservations.profileId, input.profileId),
            eq(profileObservations.field, "contact-detail"),
            eq(profileObservations.source, "tikhub"),
            eq(profiles.searchable, true),
            profileIsNotSuppressed(tx),
            isNull(contactDetailInvalidations.observationId),
          ),
        )
        .orderBy(desc(profileObservations.collectedAt));
      const observation = observations.find(
        ({ observation }) =>
          (input.observationId === undefined ||
            observation.id === input.observationId) &&
          parseContactDetail(observation.value)?.type === input.type,
      )?.observation;
      const detail = observation && parseContactDetail(observation.value);
      if (!observation || !detail) throw new ContactRevealError("not_found");

      const [existingPurchase] = await tx
        .select()
        .from(contactReveals)
        .where(
          and(
            eq(contactReveals.organizationId, input.organizationId),
            eq(contactReveals.observationId, observation.id),
            eq(contactReveals.status, "finalized"),
          ),
        )
        .limit(1);
      if (existingPurchase) {
        await tx.insert(contactRevealRequests).values({
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
          profileId: input.profileId,
          observationId: observation.id,
          revealId: existingPurchase.id,
          type: input.type,
          status: "reopened",
        });
        return {
          detail,
          observation,
          reveal: existingPurchase,
          newlyReserved: false,
          operationIdempotencyKey: input.idempotencyKey,
        };
      }

      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const [usage] = await tx
        .select({ total: count() })
        .from(contactRevealRequests)
        .where(
          and(
            eq(contactRevealRequests.organizationId, input.organizationId),
            inArray(contactRevealRequests.status, ["reserved", "finalized"]),
            gte(contactRevealRequests.createdAt, startOfDay),
          ),
        );
      const [entitlement] = await tx
        .select({
          status: organizationEntitlements.status,
          tier: organizationEntitlements.tier,
        })
        .from(organizationEntitlements)
        .where(
          eq(organizationEntitlements.organizationId, input.organizationId),
        )
        .limit(1);
      const dailyLimit =
        entitlement?.status === "active" && entitlement.tier === "pro"
          ? 100
          : 10;
      if (Number(usage?.total ?? 0) >= dailyLimit)
        throw new ContactRevealError("daily_limit");

      const [inserted] = await tx
        .insert(contactReveals)
        .values({
          organizationId: input.organizationId,
          profileId: input.profileId,
          observationId: observation.id,
          type: input.type,
          purchasedBy: input.memberId,
          price: contactRevealPrices[input.type],
          idempotencyKey: input.idempotencyKey,
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
              eq(contactReveals.observationId, observation.id),
            ),
          )
          .limit(1);
        if (!existing) throw new ContactRevealError("not_found");
        if (existing.status === "released") {
          const [renewed] = await tx
            .update(contactReveals)
            .set({
              purchasedBy: input.memberId,
              status: "reserved",
              finalizedAt: null,
            })
            .where(eq(contactReveals.id, existing.id))
            .returning();
          if (!renewed) throw new ContactRevealError("not_found");
          await tx.insert(contactRevealRequests).values({
            organizationId: input.organizationId,
            idempotencyKey: input.idempotencyKey,
            profileId: input.profileId,
            observationId: observation.id,
            revealId: renewed.id,
            type: input.type,
            status: "reserved",
          });
          await reserveCredits(tx, renewed, input.idempotencyKey);
          return {
            detail,
            observation,
            reveal: renewed,
            newlyReserved: true,
            operationIdempotencyKey: input.idempotencyKey,
          };
        }
        await tx.insert(contactRevealRequests).values({
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
          profileId: input.profileId,
          observationId: observation.id,
          revealId: existing.id,
          type: input.type,
          status: "reopened",
        });
        return {
          detail,
          observation,
          reveal: existing,
          newlyReserved: false,
          operationIdempotencyKey: input.idempotencyKey,
        };
      }

      await tx.insert(contactRevealRequests).values({
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        profileId: input.profileId,
        observationId: observation.id,
        revealId: inserted.id,
        type: input.type,
        status: "reserved",
      });
      await reserveCredits(tx, inserted, input.idempotencyKey);
      return {
        detail,
        observation,
        reveal: inserted,
        newlyReserved: true,
        operationIdempotencyKey: input.idempotencyKey,
      };
    });

    if (reserved.reveal.status === "refunded")
      throw new ContactRevealError("invalid_contact_detail");
    if (reserved.reveal.status !== "finalized") {
      try {
        await database.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${input.profileId}))`,
          );
          const [blocked] = await tx
            .select({ id: contactDetailInvalidations.observationId })
            .from(contactDetailInvalidations)
            .where(
              eq(
                contactDetailInvalidations.observationId,
                reserved.observation.id,
              ),
            )
            .limit(1);
          const [suppressed] = await tx
            .select({ type: contactDetailSuppressions.type })
            .from(contactDetailSuppressions)
            .where(
              and(
                eq(contactDetailSuppressions.profileId, input.profileId),
                eq(contactDetailSuppressions.type, input.type),
              ),
            )
            .limit(1);
          if (blocked || suppressed)
            throw new ContactRevealError("invalid_contact_detail");
          await tx
            .update(contactReveals)
            .set({ status: "finalized", finalizedAt: new Date() })
            .where(eq(contactReveals.id, reserved.reveal.id));
          await tx
            .insert(creditLedgerEntries)
            .values({
              organizationId: input.organizationId,
              idempotencyKey: `${reserved.operationIdempotencyKey}:consumption`,
              kind: "consumption",
              amount: 0,
              referenceId: reserved.reveal.id,
            })
            .onConflictDoNothing();
          await tx
            .update(contactRevealRequests)
            .set({ status: "finalized" })
            .where(
              and(
                eq(contactRevealRequests.organizationId, input.organizationId),
                eq(
                  contactRevealRequests.idempotencyKey,
                  reserved.operationIdempotencyKey,
                ),
              ),
            );
        });
      } catch (cause) {
        if (reserved.newlyReserved)
          await releaseReservation(
            database,
            reserved.reveal,
            reserved.operationIdempotencyKey,
          );
        throw cause;
      }
    }
    const result = {
      observationId: reserved.observation.id,
      type: reserved.detail.type,
      value: reserved.detail.value,
      price: reserved.newlyReserved ? reserved.reveal.price : 0,
      previouslyPurchased: !reserved.newlyReserved,
    };
    await database
      .update(securityAuditEvents)
      .set({ result: result.previouslyPurchased ? "reopened" : "finalized" })
      .where(eq(securityAuditEvents.id, audit.id));
    return result;
  } catch (cause) {
    await database
      .update(securityAuditEvents)
      .set({
        result:
          cause instanceof ContactRevealError ? cause.code : "service_error",
      })
      .where(eq(securityAuditEvents.id, audit.id));
    throw cause;
  }
};

const reserveCredits = async (
  tx: Transaction,
  reveal: typeof contactReveals.$inferSelect,
  idempotencyKey: string,
) => {
  const [entitlement] = await tx
    .select({ status: organizationEntitlements.status })
    .from(organizationEntitlements)
    .where(eq(organizationEntitlements.organizationId, reveal.organizationId))
    .limit(1);
  if (entitlement?.status !== "active")
    throw new ContactRevealError("credits_unavailable");
  await tx
    .insert(creditAccounts)
    .values({ organizationId: reveal.organizationId })
    .onConflictDoNothing();
  const [account] = await tx
    .update(creditAccounts)
    .set({
      balance: sql`${creditAccounts.balance} - ${reveal.price}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(creditAccounts.organizationId, reveal.organizationId),
        sql`${creditAccounts.balance} >= ${reveal.price}`,
      ),
    )
    .returning();
  if (!account) throw new ContactRevealError("insufficient_credits");
  await tx.insert(creditLedgerEntries).values({
    organizationId: reveal.organizationId,
    idempotencyKey: `${idempotencyKey}:reservation`,
    kind: "reservation",
    amount: -reveal.price,
    referenceId: reveal.id,
  });
};

const releaseReservation = async (
  database: Database,
  reveal: typeof contactReveals.$inferSelect,
  idempotencyKey: string,
) =>
  database.transaction(async (tx) => {
    await tx
      .update(contactReveals)
      .set({ status: "released" })
      .where(eq(contactReveals.id, reveal.id));
    await tx
      .update(contactRevealRequests)
      .set({ status: "released" })
      .where(
        and(
          eq(contactRevealRequests.organizationId, reveal.organizationId),
          eq(contactRevealRequests.idempotencyKey, idempotencyKey),
        ),
      );
    await tx
      .update(creditAccounts)
      .set({
        balance: sql`${creditAccounts.balance} + ${reveal.price}`,
        updatedAt: new Date(),
      })
      .where(eq(creditAccounts.organizationId, reveal.organizationId));
    await tx.insert(creditLedgerEntries).values({
      organizationId: reveal.organizationId,
      idempotencyKey: `${idempotencyKey}:release`,
      kind: "release",
      amount: reveal.price,
      referenceId: reveal.id,
    });
  });

export const setOrganizationContactRevealPolicy = async (
  database: Database,
  memberId: string,
  organizationId: string,
  membersCanReveal: boolean,
) => {
  const membership = await requireMembership(
    database,
    memberId,
    organizationId,
  );
  if (membership.role !== "org:admin" && membership.role !== "admin")
    throw new ContactRevealError("forbidden");
  await database
    .update(organizations)
    .set({
      memberContactRevealsEnabled: membersCanReveal,
      updatedAt: new Date(),
    })
    .where(eq(organizations.clerkId, organizationId));
  return { membersCanReveal };
};

export const getOrganizationContactRevealPolicy = async (
  database: Database,
  memberId: string,
  organizationId: string,
) => {
  const membership = await requireMembership(
    database,
    memberId,
    organizationId,
  );
  return { membersCanReveal: membership.memberContactRevealsEnabled };
};

export const setContactDetailSuppression = async (
  database: Database,
  memberId: string,
  type: ContactDetailType,
  suppressed: boolean,
) =>
  database.transaction(async (tx) => {
    const [profile] = await tx
      .select({ id: profiles.profileId })
      .from(profiles)
      .where(eq(profiles.memberId, memberId))
      .limit(1);
    if (!profile) throw new ContactRevealError("forbidden");
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${profile.id}))`,
    );
    if (suppressed)
      await tx
        .insert(contactDetailSuppressions)
        .values({ profileId: profile.id, type, suppressedBy: memberId })
        .onConflictDoNothing();
    else
      await tx
        .delete(contactDetailSuppressions)
        .where(
          and(
            eq(contactDetailSuppressions.profileId, profile.id),
            eq(contactDetailSuppressions.type, type),
          ),
        );
    return { type, suppressed };
  });

export const reportInvalidContactDetail = async (
  database: Database,
  input: {
    memberId: string;
    organizationId: string;
    observationId: string;
    reason: "bounced-email" | "wrong-phone";
  },
) =>
  database.transaction(async (tx) => {
    await requireMembership(tx, input.memberId, input.organizationId);
    const [purchased] = await tx
      .select()
      .from(contactReveals)
      .where(
        and(
          eq(contactReveals.organizationId, input.organizationId),
          eq(contactReveals.observationId, input.observationId),
          inArray(contactReveals.status, ["finalized", "refunded"]),
        ),
      )
      .limit(1);
    if (!purchased) throw new ContactRevealError("forbidden");
    if (
      (purchased.type === "professional-email" &&
        input.reason !== "bounced-email") ||
      (purchased.type === "direct-professional-phone" &&
        input.reason !== "wrong-phone")
    )
      throw new ContactRevealError("invalid_contact_detail");
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${purchased.profileId}))`,
    );
    const [invalidation] = await tx
      .insert(contactDetailInvalidations)
      .values({
        observationId: input.observationId,
        reportedBy: input.memberId,
        reason: input.reason,
      })
      .onConflictDoNothing()
      .returning();
    if (!invalidation) return { refunded: false };

    const reveals = await tx
      .update(contactReveals)
      .set({
        status: "refunded",
        invalidatedAt: new Date(),
        refundedAt: new Date(),
      })
      .where(
        and(
          eq(contactReveals.observationId, input.observationId),
          eq(contactReveals.status, "finalized"),
        ),
      )
      .returning();
    for (const reveal of reveals) {
      await tx
        .update(creditAccounts)
        .set({
          balance: sql`${creditAccounts.balance} + ${reveal.price}`,
          updatedAt: new Date(),
        })
        .where(eq(creditAccounts.organizationId, reveal.organizationId));
      await tx.insert(creditLedgerEntries).values({
        organizationId: reveal.organizationId,
        idempotencyKey: `${reveal.id}:refund`,
        kind: "refund",
        amount: reveal.price,
        referenceId: reveal.id,
      });
    }
    await tx
      .insert(reenrichmentOutbox)
      .values({
        profileId: purchased.profileId,
        observationId: input.observationId,
        reason: input.reason,
      })
      .onConflictDoNothing();
    return { refunded: true };
  });

export const contactRevealLogFields = (input: {
  memberId: string;
  organizationId: string;
  profileId: string;
  observationId: string;
  type: ContactDetailType;
  result: "finalized" | "reopened" | "refunded" | "released";
}) => ({ ...input, event: "contact_reveal" as const });
