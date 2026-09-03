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

import { organizationRevealLimit } from "./abuse-controls";
import {
  applyCreditEntryInTransaction,
  type CreditActor,
  type CreditReservation,
  CreditOperationError,
  finalizeCreditReservation,
  releaseCreditReservation,
  reserveCredit,
} from "./credits";
import { lockGitHubIdentity } from "./github-identity";
import {
  contactDetailInvalidations,
  contactDetailSuppressions,
  contactRevealRequests,
  contactReveals,
  members,
  organizationMemberships,
  organizations,
  profileObservations,
  principalSuspensions,
  profiles,
  reenrichmentOutbox,
  securityAuditEvents,
  suppressionRecords,
} from "./schema";
import type { DrizzleDatabase, Transaction } from "./service/types";

type Database = DrizzleDatabase;

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

const contactRevealCreditReservation = (
  reveal: typeof contactReveals.$inferSelect,
  idempotencyKey: string,
  evidence: {
    memberId: string;
    apiKeyId?: string;
    source?: "web" | "api" | "mcp";
  },
): CreditReservation => ({
  organizationId: reveal.organizationId,
  amount: reveal.price,
  referenceId: reveal.id,
  idempotencyKey,
  reservationKey: "reservation-suffix",
  actor: evidence.apiKeyId
    ? { type: "api_key", id: evidence.apiKeyId }
    : { type: "member", id: evidence.memberId },
  operation: `contact_reveal.${reveal.type}.${evidence.source ?? "web"}`,
});

const mapContactRevealCreditError = async <Result>(
  operation: () => Promise<Result>,
) => {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof CreditOperationError)
      throw new ContactRevealError(cause.code);
    throw cause;
  }
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

const lockContactProfile = async (
  transaction: Transaction,
  profileId: string,
  requireSearchable: boolean,
) => {
  const [identity] = await transaction
    .select({
      githubAccountId: profiles.githubAccountId,
      searchabilityReason: profiles.searchabilityReason,
    })
    .from(profiles)
    .where(eq(profiles.profileId, profileId))
    .limit(1);
  if (!identity) throw new ContactRevealError("not_found");
  if (identity.searchabilityReason === "operator_suppression")
    throw new ContactRevealError("not_found");
  await lockGitHubIdentity(transaction, identity.githubAccountId);
  const [profile] = await transaction
    .select({
      profileId: profiles.profileId,
      memberId: profiles.memberId,
      searchable: profiles.searchable,
      searchabilityReason: profiles.searchabilityReason,
      suppressionId: suppressionRecords.canonicalProviderId,
    })
    .from(profiles)
    .leftJoin(
      suppressionRecords,
      and(
        eq(suppressionRecords.canonicalProvider, "github"),
        eq(suppressionRecords.canonicalProviderId, profiles.githubAccountId),
      ),
    )
    .where(eq(profiles.profileId, profileId))
    .limit(1)
    .for("update", { of: profiles });
  if (
    !profile ||
    profile.suppressionId !== null ||
    profile.searchabilityReason === "operator_suppression" ||
    (requireSearchable && !profile.searchable)
  )
    throw new ContactRevealError("not_found");
  return profile;
};

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
  return database.transaction(async (transaction) => {
    const profile = await lockContactProfile(
      transaction,
      input.profileId,
      false,
    );
    if (profile.searchabilityReason === "disputed")
      throw new ContactRevealError("not_found");
    return persistVerifiedContactObservationInTransaction(transaction, {
      profileId: input.profileId,
      value: { type, value: input.value },
      source: input.source,
      sourceRecordId: input.sourceRecordId,
      pipelineVersion: `${input.source}-provider-verified`,
      confidence: 1,
      collectedAt: input.verifiedAt,
    });
  });
};

export const persistVerifiedContactObservationInTransaction = async (
  transaction: Transaction,
  input: {
    profileId: string;
    value: unknown;
    source: string;
    sourceRecordId: string;
    pipelineVersion: string;
    confidence: number;
    collectedAt: Date;
  },
) => {
  const detail = parseContactDetail(input.value);
  if (!detail) throw new Error("contact_detail_not_eligible");
  const [current] = await transaction
    .select({
      observation: profileObservations,
      invalidationId: contactDetailInvalidations.observationId,
    })
    .from(profileObservations)
    .leftJoin(
      contactDetailInvalidations,
      eq(contactDetailInvalidations.observationId, profileObservations.id),
    )
    .where(
      and(
        eq(profileObservations.source, input.source),
        eq(profileObservations.sourceRecordId, input.sourceRecordId),
        eq(profileObservations.field, "contact-detail"),
      ),
    )
    .limit(1)
    .for("update", { of: profileObservations });
  if (current && current.observation.profileId !== input.profileId)
    throw new Error("contact_detail_identity_collision");

  if (current) {
    const previous = parseContactDetail(current.observation.value);
    const unchanged =
      previous?.type === detail.type && previous.value === detail.value;
    if (
      unchanged &&
      current.observation.staleAt === null &&
      current.invalidationId === null
    ) {
      const [updated] = await transaction
        .update(profileObservations)
        .set({
          value: input.value,
          pipelineVersion: input.pipelineVersion,
          confidence: input.confidence,
          collectedAt: input.collectedAt,
        })
        .where(eq(profileObservations.id, current.observation.id))
        .returning();
      if (!updated) throw new Error("contact_detail_identity_collision");
      return updated;
    }

    if (current.observation.source === "tikhub")
      await invalidateContactDetailObservationsInTransaction(transaction, {
        profileId: input.profileId,
        observationIds: [current.observation.id],
        reportedBy: null,
        reason: "provider_contact_detail_changed",
        actor: { type: "system", id: input.source },
        operation: "contact_reveal.provider_refresh.refund",
        now: input.collectedAt,
        enqueueReenrichment: false,
      });
    else
      await transaction
        .update(profileObservations)
        .set({ staleAt: input.collectedAt })
        .where(eq(profileObservations.id, current.observation.id));
    await transaction
      .update(profileObservations)
      .set({ sourceRecordId: `superseded:${current.observation.id}` })
      .where(eq(profileObservations.id, current.observation.id));
  }

  const [observation] = await transaction
    .insert(profileObservations)
    .values({
      ...input,
      field: "contact-detail",
    })
    .returning();
  if (!observation) throw new Error("contact_detail_identity_collision");
  return observation;
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
): Promise<ContactDetailPreview[]> =>
  database.transaction(async (transaction) => {
    await requireMembership(transaction, memberId, organizationId);
    await lockContactProfile(transaction, profileId, true);

    const rows = await transaction
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
           isNull(profileObservations.staleAt),
           isNull(contactDetailInvalidations.observationId),
        ),
      )
      .orderBy(desc(profileObservations.collectedAt));
    const suppressions = new Set(
      (
        await transaction
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
  });

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
      await lockContactProfile(tx, input.profileId, true);
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
              isNull(profileObservations.staleAt),
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
        const [reveal] = await tx
          .select()
          .from(contactReveals)
          .where(eq(contactReveals.id, replay.revealId))
          .limit(1);
        if (!reveal) throw new ContactRevealError("invalid_contact_detail");
        return {
          detail: originalDetail,
          observation: original.observation,
          reveal,
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
            isNull(profileObservations.staleAt),
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
      const dailyLimit = await organizationRevealLimit(
        tx,
        input.organizationId,
      );
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
          await reserveCredits(tx, renewed, input.idempotencyKey, input);
          return {
            detail,
            observation,
            reveal: renewed,
            newlyReserved: true,
            operationIdempotencyKey: input.idempotencyKey,
          };
        }
        const [reservationRequest] =
          existing.status === "reserved"
            ? await tx
                .select({
                  idempotencyKey: contactRevealRequests.idempotencyKey,
                })
                .from(contactRevealRequests)
                .where(
                  and(
                    eq(contactRevealRequests.revealId, existing.id),
                    eq(contactRevealRequests.status, "reserved"),
                  ),
                )
                .orderBy(desc(contactRevealRequests.createdAt))
                .limit(1)
            : [];
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
          operationIdempotencyKey:
            reservationRequest?.idempotencyKey ?? input.idempotencyKey,
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
      await reserveCredits(tx, inserted, input.idempotencyKey, input);
      return {
        detail,
        observation,
        reveal: inserted,
        newlyReserved: true,
        operationIdempotencyKey: input.idempotencyKey,
      };
    });

    let finalized: {
      detail: { type: ContactDetailType; value: string };
      observationId: string;
      reveal: typeof contactReveals.$inferSelect;
    };
    try {
      finalized = await database.transaction(async (tx) => {
        await lockContactProfile(tx, input.profileId, true);
        const [current] = await tx
          .select({ observation: profileObservations })
          .from(profileObservations)
          .leftJoin(
            contactDetailInvalidations,
            eq(
              contactDetailInvalidations.observationId,
              profileObservations.id,
            ),
          )
          .where(
            and(
              eq(profileObservations.id, reserved.observation.id),
              eq(profileObservations.profileId, input.profileId),
              eq(profileObservations.field, "contact-detail"),
              eq(profileObservations.source, "tikhub"),
              isNull(profileObservations.staleAt),
              isNull(contactDetailInvalidations.observationId),
            ),
          )
          .limit(1);
        const [detailSuppression] = await tx
          .select({ type: contactDetailSuppressions.type })
          .from(contactDetailSuppressions)
          .where(
            and(
              eq(contactDetailSuppressions.profileId, input.profileId),
              eq(contactDetailSuppressions.type, input.type),
            ),
          )
          .limit(1);
        const [reveal] = await tx
          .select()
          .from(contactReveals)
          .where(eq(contactReveals.id, reserved.reveal.id))
          .limit(1)
          .for("update");
        const detail = current && parseContactDetail(current.observation.value);
        if (
          !current ||
          !detail ||
          detail.type !== input.type ||
          detailSuppression ||
          !reveal ||
          (reveal.status !== "reserved" && reveal.status !== "finalized")
        )
          throw new ContactRevealError("invalid_contact_detail");

        if (reveal.status === "reserved") {
          await mapContactRevealCreditError(() =>
            finalizeCreditReservation(
              tx,
              contactRevealCreditReservation(
                reveal,
                reserved.operationIdempotencyKey,
                input,
              ),
            ),
          );
          const [updated] = await tx
            .update(contactReveals)
            .set({ status: "finalized", finalizedAt: new Date() })
            .where(
              and(
                eq(contactReveals.id, reveal.id),
                eq(contactReveals.status, "reserved"),
              ),
            )
            .returning();
          if (!updated) throw new ContactRevealError("invalid_contact_detail");
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
          return {
            detail,
            observationId: current.observation.id,
            reveal: updated,
          };
        }
        return { detail, observationId: current.observation.id, reveal };
      });
    } catch (cause) {
      if (reserved.newlyReserved)
        await releaseReservation(
          database,
          reserved.reveal,
          reserved.operationIdempotencyKey,
          input,
        );
      throw cause;
    }
    const result = {
      observationId: finalized.observationId,
      type: finalized.detail.type,
      value: finalized.detail.value,
      price: reserved.newlyReserved ? finalized.reveal.price : 0,
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
  evidence: {
    memberId: string;
    apiKeyId?: string;
    source?: "web" | "api" | "mcp";
  },
) =>
  mapContactRevealCreditError(() =>
    reserveCredit(
      tx,
      contactRevealCreditReservation(reveal, idempotencyKey, evidence),
    ),
  );

const releaseReservation = async (
  database: Database,
  reveal: typeof contactReveals.$inferSelect,
  idempotencyKey: string,
  evidence: {
    memberId: string;
    apiKeyId?: string;
    source?: "web" | "api" | "mcp";
  },
) =>
  database.transaction(async (tx) => {
    await mapContactRevealCreditError(() =>
      releaseCreditReservation(
        tx,
        contactRevealCreditReservation(reveal, idempotencyKey, evidence),
      ),
    );
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
    const [identity] = await tx
      .select({ id: profiles.profileId })
      .from(profiles)
      .where(eq(profiles.memberId, memberId))
      .limit(1);
    if (!identity) throw new ContactRevealError("forbidden");
    const profile = await lockContactProfile(tx, identity.id, false);
    if (profile.memberId !== memberId)
      throw new ContactRevealError("forbidden");
    if (suppressed)
      await tx
        .insert(contactDetailSuppressions)
        .values({
          profileId: profile.profileId,
          type,
          suppressedBy: memberId,
        })
        .onConflictDoNothing();
    else
      await tx
        .delete(contactDetailSuppressions)
        .where(
          and(
            eq(contactDetailSuppressions.profileId, profile.profileId),
            eq(contactDetailSuppressions.type, type),
          ),
        );
    return { type, suppressed };
  });

export const invalidateContactDetailObservationsInTransaction = async (
  transaction: Transaction,
  input: {
    profileId: string;
    observationIds: readonly string[];
    reportedBy: string | null;
    reason: string;
    actor: CreditActor;
    operation: string;
    now?: Date;
    enqueueReenrichment?: boolean;
  },
) => {
  if (
    input.observationIds.length === 0 ||
    input.observationIds.length > 100 ||
    new Set(input.observationIds).size !== input.observationIds.length ||
    input.observationIds.some((id) => !id.trim()) ||
    !input.reason.trim()
  )
    throw new ContactRevealError("invalid_contact_detail");
  await lockContactProfile(transaction, input.profileId, false);
  const observations = await transaction
    .select({
      id: profileObservations.id,
      source: profileObservations.source,
      value: profileObservations.value,
    })
    .from(profileObservations)
    .where(
      and(
        eq(profileObservations.profileId, input.profileId),
        eq(profileObservations.field, "contact-detail"),
        inArray(profileObservations.id, [...input.observationIds]),
      ),
    );
  if (
    observations.length !== input.observationIds.length ||
    observations.some(
      (observation) =>
        observation.source !== "tikhub" ||
        parseContactDetail(observation.value) === null,
    )
  )
    throw new ContactRevealError("invalid_contact_detail");
  const invalidations = await transaction
    .insert(contactDetailInvalidations)
    .values(
      observations.map(({ id }) => ({
        observationId: id,
        reportedBy: input.reportedBy,
        reason: input.reason,
      })),
    )
    .onConflictDoNothing()
    .returning({ observationId: contactDetailInvalidations.observationId });
  if (invalidations.length === 0) return { invalidated: 0, refunded: 0 };
  const invalidatedIds = invalidations.map(
    ({ observationId }) => observationId,
  );
  const now = input.now ?? new Date();
  await transaction
    .update(profileObservations)
    .set({ staleAt: now })
    .where(inArray(profileObservations.id, invalidatedIds));
  const reveals = await transaction
    .update(contactReveals)
    .set({
      status: "refunded",
      invalidatedAt: now,
      refundedAt: now,
    })
    .where(
      and(
        inArray(contactReveals.observationId, invalidatedIds),
        eq(contactReveals.status, "finalized"),
      ),
    )
    .returning();
  if (reveals.length > 0)
    await transaction
      .update(contactRevealRequests)
      .set({ status: "refunded" })
      .where(
        and(
          inArray(
            contactRevealRequests.revealId,
            reveals.map(({ id }) => id),
          ),
          inArray(contactRevealRequests.status, ["finalized", "reopened"]),
        ),
      );
  for (const reveal of reveals.sort((left, right) =>
    left.organizationId.localeCompare(right.organizationId),
  )) {
    await mapContactRevealCreditError(() =>
      applyCreditEntryInTransaction(transaction, {
        organizationId: reveal.organizationId,
        idempotencyKey: `${reveal.id}:refund`,
        kind: "refund",
        amount: reveal.price,
        referenceId: reveal.id,
        actor: input.actor,
        operation: input.operation,
      }),
    );
  }
  if (input.enqueueReenrichment !== false)
    await transaction
      .insert(reenrichmentOutbox)
      .values(
        invalidatedIds.map((observationId) => ({
          profileId: input.profileId,
          observationId,
          reason: input.reason,
        })),
      )
      .onConflictDoNothing();
  return { invalidated: invalidations.length, refunded: reveals.length };
};

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
    await lockContactProfile(tx, purchased.profileId, true);
    const result = await invalidateContactDetailObservationsInTransaction(tx, {
      profileId: purchased.profileId,
      observationIds: [input.observationId],
      reportedBy: input.memberId,
      reason: input.reason,
      actor: { type: "member", id: input.memberId },
      operation: "contact_reveal.invalid_detail.refund",
    });
    return { refunded: result.invalidated > 0 };
  });

export const contactRevealLogFields = (input: {
  memberId: string;
  organizationId: string;
  profileId: string;
  observationId: string;
  type: ContactDetailType;
  result: "finalized" | "reopened" | "refunded" | "released";
}) => ({ ...input, event: "contact_reveal" as const });
